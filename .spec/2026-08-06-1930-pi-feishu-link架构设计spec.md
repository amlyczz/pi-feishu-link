# Pi Feishu Link — 高可靠 Pi × 飞书双向桥接扩展架构设计 Spec

> 版本：v1.1（草稿）
> 日期：2026-08-06
> 状态：调研完成，待评审
> 作者：pi-agent（AI 调研）
> 前置文档：`2026-08-06-1812-pi-qq-bridge扩展架构设计spec.md`（QQ 方案，本 spec 取代其接入层选型）

> **v1.2 修订（2026-08-07，0.1.1 实现后回写）**：① 权限桥确认接线（`tool_call` 事件 + 审批卡真实生效）；② 群聊权限语义收敛——非白名单工具一律审批，移除无效的 `permissions.groupPolicy` 配置项；③ 新增 `ownerOpenId`（首个私聊用户自动记为 owner/admin）；④ 断连补收修复（注入走 skipDedupe 旁路，双 admit 缺陷已修）；⑤ 定时任务接线修复（sessionId→key 反查 + 活跃 feishu input 标记）。详见 `CHANGELOG.md` 0.1.1。

> **v1.3 修订（2026-08-07，用户指令）**：权限模型改为**默认全部放行**——除破坏性黑名单外一切工具调用直接放行（私聊/群聊一致）；黑名单从"永远拦截"改为**弹审批卡**（⚠️ 危险横幅，管理员批准才执行，5min 超时自动拒绝）；`permissions.policy=strict` 保留为全面审批模式。此修订覆盖 §6.15 原"群聊永远 strict"语义与 §8 黑名单硬拦截语义。

> **v1.1 修订**（全面架构评审后）：① Outbox 改**分航道并行**（修跨会话队头阻塞）② 流式 patch 移出持久化队列，改**双通道**（易失直播道 + 持久可靠道）③ 对账改**无条件 finalize**（删脆弱的 hash 比对）④ 修僵尸检测漏洞（REST probe 健康但 WS 僵尸的场景，原逻辑永远检测不到——正是用户原始痛点）⑤ 新增 **PermissionBridge**（headless 会话的工具审批真空，两个参考实现都没处理）⑥ 新增 NotificationThrottler（告警合并防刷屏）⑦ 新增 §9 究极懒人 UX 设计。

---

## 0. 为什么从 QQ 转向飞书

| 关键需求 | QQ Bot API v2 | 飞书开放平台 |
| -------- | ------------- | ------------ |
| 群聊免 @ 收消息 | ❌ 协议层不存在 | ✅ "获取群组中所有消息"权限（已实测） |
| 被动回复窗口/次数 | 5min/4 次，绑 msg_id | 无此概念，随时可发 |
| 主动推送（任务提醒） | 频控严苛 | 宽松，权限内直接发 |
| 流式回复 | 只能分块发 | CardKit 流式卡片 |
| 多媒体 | 全类型 + 官方 ASR | 全类型（语音无 ASR，需自接 STT） |
| 一键认证 | 手动申请 AppID | SDK 内置 `registerApp()` 扫码建应用 |

且社区已有两个 pi×飞书扩展可深度参考（已 clone 到 `.research/`，见 §3），QQ spec 的架构骨架（隔离 AgentSession、FIFO+steering、ConversationRegistry）全部复用。

---

## 1. 摘要

构建 **pi-feishu-link**：一个以**可靠性为第一优先级**的 pi × 飞书双向桥接扩展。

核心设计目标（按优先级）：

1. **R1 消息零丢失（100% 一致性）**：pi 侧产生的每一句回复，必然到达飞书；任何网络/进程/平台故障都可恢复、可补偿、可观测。宁慢勿丢。
2. **R2 连接可靠性**：WS 长连接有监督（watchdog）、有活性探针、有僵尸检测、有自动重建、断连期间消息有持久化 outbox 兜底。
3. **R3 认证最简**：扫码 / 点链接一键创建机器人（复用 SDK `registerApp`），零手工填写权限。
4. **R4 配置化**：转发内容（AI 回复 / 工具调用 / 进度 / 推理过程）、群聊策略、命令权限等全部配置驱动。
5. **R5 命令对齐**：pi 终端命令与飞书侧命令能力对齐，飞书侧有命令提示。
6. **R6 定时任务**：不做内置 cron，复用社区最佳插件，本扩展只做**通用出站路由抽象**（任何来源 → 飞书会话的可靠投递）。
7. **R7 究极懒人体验**：扫码即用、零手工配置、零命令记忆（一切有按钮）、故障自愈且主动汇报。用户只需会两件事：扫码、说话。详见 §9。

---

## 2. 需求分析

### 2.1 功能需求（FR）

| ID | 需求 | 优先级 | 说明 |
| -- | ---- | ------ | ---- |
| FR-1 | 私聊（p2p）消息收发 | P0 | 文本/图文/文件 |
| FR-2 | 群聊消息收发 | P0 | 策略：open(免@) / mention / 关键词 / 回复机器人时触发 |
| FR-3 | 群话题（topic）独立会话 | P1 | 每个话题一个 pi 会话（参考实现已验证） |
| FR-4 | 多媒体入站 | P0 | 图片→视觉模型；文件→有界文本提取；语音→可选第三方 STT（飞书无官方 ASR） |
| FR-5 | 多媒体出站 | P1 | `feishu_send_local_file` 工具：本地图片/文件 → 飞书 |
| FR-6 | 命令体系 | P0 | 飞书侧白名单命令与 pi 能力对齐（§8）；危险命令阻塞 |
| FR-7 | 命令提示 | P1 | /help 交互卡片（按钮点选）+ 机器人菜单（若 API 可配置） |
| FR-8 | 流式回复 | P0 | CardKit 流式卡片，结束时以最终文本对账（§6.5） |
| FR-9 | 配置化转发 | P0 | AI 回复（必选）/ 工具调用起止 / 进度状态 / 推理过程，各自可开关、可选形式（卡片/纯文本/关） |
| FR-10 | 一键认证 | P0 | 扫码（终端二维码 + 链接）自动创建应用；手动 AppID/Secret 兜底 |
| FR-11 | 定时任务投递 | P0 | 集成 `@ineersa/my-pi-scheduler`，任务结果经 OutboundRouter 投递到绑定会话 |
| FR-12 | 本地控制命令 | P0 | `/feishu start/stop/restart/status/setup/logs` |
| FR-13 | 会话隔离与工作区 | P0 | 每飞书会话独立持久化 pi 会话；`/workspace` 绑定 cwd |
| FR-14 | 权限控制 | P0 | allowUsers / allowChats 白名单 + 管理员 |
| FR-15 | 后台常驻 | P0 | daemon 模式：pi TUI 关闭后桥接仍在（gateway 文件锁所有权） |
| FR-16 | 断连通知 | P1 | 连接状态变化主动告知绑定的飞书会话（恢复后）+ 本地 TUI 状态栏 |

### 2.2 非功能需求（NFR）

| ID | 需求 | 指标 |
| -- | ---- | ---- |
| NFR-1 | 消息零丢失 | 出站消息持久化 outbox，at-least-once + 幂等键去重 = exactly-once 语义；进程重启后自动续投 |
| NFR-2 | 连接存活 | WS 僵尸检测 ≤60s；自动重建指数退避（1s→60s）无上限重试（告警节流）；状态全程可观测 |
| NFR-3 | 回合可恢复 | 每回合超时监督（默认 30min 可配）；卡死自动中止 + 通知 + 队列解锁 |
| NFR-4 | 性能 | 文本入站→首 token 上卡 <5s（模型时延除外）；卡片更新节流（≥800ms/次） |
| NFR-5 | 资源 | 会话懒加载 + 空闲回收（30min）+ 常驻上限（8） |
| NFR-6 | 安全 | 附件 HTTPS 下载校验；凭据 0600 不入日志；危险命令阻塞 |
| NFR-7 | 可观测 | 结构化事件日志（JSONL 轮转）；`/feishu status` 全链路健康视图；关键路径 debugLog 埋点 |
| NFR-8 | 兼容 | Pi >=0.82 <1.0，Node >=22.19，macOS/Linux（Windows best-effort） |

---

## 3. 调研记录

### 3.1 AX1202/pi-feishu-lark（原版，MIT，已 clone `.research/pi-feishu-lark-ax/`）

源码位于 `.pi/extensions/feishu/`，21 个文件约 4500 行。文件级精读结论：

| 文件 | 行数 | 职责 | 评价 |
| ---- | ---- | ---- | ---- |
| `setup.ts` | 129 | **扫码建应用**：`lark.registerApp({source, onQRCodeReady})` → 终端二维码+链接 → 拿回 client_id/secret；群策略选择；写配置 | ⭐ 直接复用思路，认证最简的关键 |
| `transport.ts` | 502 | SDK `Client` + `WSClient` + `EventDispatcher`（im.message.receive_v1 / card.action.trigger）；群策略过滤；图片/资源下载（resources API + image.get 兜底）；出站 text/post/interactive 分块 | 收发完整；**无 WS 活性监督**（SDK 内部重连不透明） |
| `conversation-manager.ts` | 599 | per-key AgentSession（createAgentSession SDK）；per-key promise 链 FIFO；模型/工作区/会话文件 state.json；prompt 1h 超时 | 骨架可用；**队列头阻塞即"长时间不回复"元凶之一** |
| `message-handler.ts` | 294 | 命令解析（/new /resume /model /stop /workspace）、附件处理、关键词触发 | 参考 |
| `delivery.ts` | 182 | 独立出站通道（daemon 无 transport 时直连 REST） | 参考；**失败仅重试 2 次即丢** |
| `bridge-runtime.ts` + `bridge-store.ts` | 216 | ⭐ 定时任务路由：监听 `schedule_prompt` toolResult 绑定 job→会话路由；`scheduled_prompt` custom 消息触发投递；`deliverOnce` 幂等键 | 正是用户想要的"定时任务抽象"，直接升级此设计 |
| `gateway-lock.ts` | 214 | 文件锁选举 gateway owner，多 pi 实例互斥 | 参考 |
| `index.ts` | 604 | daemon 模式（spawn `PI_FEISHU_DAEMON=1` 子进程）、TUI 状态栏、`/feishu` 命令族 | 参考 |
| `task-status-card.ts` | 315 | 实时任务状态卡片（含 /stop 按钮） | ⭐ 复用思路 |
| `dedupe-store.ts` | 145 | message_id 持久化去重 | 参考 |
| `attachments.ts` | 81 | 图片/文件附件提取 | 参考 |

### 3.2 yangtuooc/pi-feishu-lark（@xjuai fork，v0.4.14，已 clone `.research/pi-feishu-lark-xjuai/`）

在原版基础上加固，增量精读结论：

- `cardkit-stream.ts`（295 行）：**CardKit 流式卡片**——建卡 → 增量 patch → 完成；纯文本兜底
- `reply-card.ts`（235 行）：回复卡生命周期（running → done/failed/stopped），`ensureFinal` 兜底写错误
- `group-trigger.ts`（120 行）：群策略判定纯函数（open/mention/keywords/alsoOnReply），可测性好 ⭐
- `retry.ts`（68 行）：指数退避出站重试
- `runtime-config.ts`（224 行）：runtime-overrides.json 热更新白名单
- `interactive-card.ts`（235 行）：入站告警卡片解析为可读文本（告警场景）
- 引用展开：回复/跟帖机器人消息时拉取 parent/root 消息进上下文
- WS card action 回调格式坑：必须返回 `{card:{type:"raw",data}}`，不能 patch schema 2.0 卡（200830/200671）

### 3.3 两者共同缺陷（= 用户痛点根因分析）

| # | 缺陷 | 导致的症状 | 本 spec 对策 |
| - | ---- | ---------- | ------------ |
| 1 | WSClient 重连在 SDK 内部，无活性探针、无事件心跳监控 | **僵尸连接：进程活着但永远收不到消息，"长时间不回复也不知啥情况"** | Connection Supervisor（§6.2） |
| 2 | per-key promise 链：上一回合 hang（模型超时 1h）→ 后续消息全部静默排队 | 消息"发了没反应" | 回合监督者 + 超时中止 + 队列解锁 + 主动通知（§6.4） |
| 3 | 出站仅内存重试 2 次，失败即丢；无持久化 | pi 回复了但飞书收不到，**一致性破裂** | 持久化 Outbox（§6.5） |
| 4 | 流式卡片内容与最终文本可能对不上（delta 丢失时卡片内容 ≠ session.messages） | 飞书看到的回复与 pi 实际输出不一致 | Final Reconciliation（§6.5） |
| 5 | 无断连期间入站补偿（飞书 WS 不补发历史消息） | 断连窗口内用户消息永久丢失 | 断连检测 + 恢复后主动拉取（§6.2，开放问题 #4） |
| 6 | 连接状态只在本地 TUI 状态栏，飞书侧无感知 | 用户分不清是 pi 死了还是在跑 | 状态主动通知（FR-16） |

### 3.4 @larksuiteoapi/node-sdk（官方 SDK，v1.72）

- `registerApp()`：扫码一键建应用（源码确认，见 ax/setup.ts）——**权限由该流程自动配置**，满足"认证最简"
- `WSClient`：长连接收事件，无需公网回调；内部自动重连（不透明 → 需要外部监督）
- `Client`：全量 REST；`im.message.reply/create/patch/get`；`im.v1.messageResource.get`（附件下载）；`im.v1.image.get`（兜底）；`im.messageReaction.create`（表情回执）
- CardKit：流式卡片（schema 2.0），patch 更新；卡动作经 WS 回调 `card.action.trigger`

### 3.5 定时任务社区方案调研（npm 实查）

| 包 | 版本 | 周下载 | 评估 |
| -- | ---- | ------ | ---- |
| **@ineersa/my-pi-scheduler** | 0.1.13 | 40 | ⭐ **选定**。`/loop 5m <prompt>`、`/loop cron '<expr>'`、`/remind in 45m`、`/schedule` TUI 管理器（list/enable/disable/delete/adopt/release）、LLM 工具 `schedule_prompt`（add/list/delete/enable/adopt）、多实例 ownership、workspace 维度持久化、上限保护（50 任务/最小 1min） |
| pi-scheduler + pi-scheduler-daemon + pi-scheduler-ext（rckflr） | 0.4.0 | 1-2 | 三件套架构（core/daemon/ext），但下载量极低、文档西语、维护性存疑 |
| toad-scheduler / node-schedule | — | 百万级 | 通用库非 pi 扩展，不满足"开箱即用" |

**结论**：`@ineersa/my-pi-scheduler` 功能完备度远超"够用"，且 AX 参考实现已验证其与飞书桥的集成路径（toolResult 捕获 → 路由绑定 → custom marker 触发投递）。**不自造轮子**；本扩展只做通用的 OutboundRouter 抽象（§6.6），对 scheduler 零侵入。若后续发现其缺陷再评估 fork。

### 3.6 飞书"命令提示"能力调研

| 方案 | 可行性 | 说明 |
| ---- | ------ | ---- |
| 机器人菜单（p2p 输入框上方菜单） | ⚠️ 开发者后台可配；公开 API 未确认 | 开放问题 #1；registerApp 流程是否自动配置需实测 |
| /help 交互卡片 + 按钮 | ✅ 确定可行 | 参考实现已有 cards.ts 体系；按钮触发 card.action 即执行命令 |
| 消息内关键词自动补全 | ❌ 飞书客户端不支持 | — |

**设计**：以 `/help` 命令卡片（按钮组 = 命令提示 + 一键执行）为主，机器人菜单作为增强（开放问题验证后配置化下发）。

---

## 4. 总体架构

### 4.1 分层视图

```
┌─────────────────────────────── pi 进程 ───────────────────────────────┐
│                                                                       │
│  ┌─────────────────── L4 呈现层（Feishu 侧交互）───────────────────┐  │
│  │ StreamingReplyCard  TaskStatusCard  CommandHelpCard  ModelCard │  │
│  └──────────────────────────────▲─────────────────────────────────┘  │
│                                 │                                     │
│  ┌─────────────────── L3 可靠出站层 ─────────────────────────────┐  │
│  │ LiveChannel（易失直播道：流式 patch，内存合并，best-effort）    │  │
│  │ Outbox（持久可靠道：at-least-once + 幂等键 + 分航道并行）       │  │
│  │ OutboundRouter（会话路由表：conversation/job → chat/thread）   │  │
│  └──────────────────────────────▲─────────────────────────────────┘  │
│                                 │                                     │
│  ┌─────────────────── L2 会话编排层 ─────────────────────────────┐  │
│  │ ConversationManager（per-key AgentSession / FIFO 队列）        │  │
│  │ TurnSupervisor（回合超时/卡死中止/解锁通知）                    │  │
│  │ PermissionBridge（工具审批：白名单放行 / 飞书审批卡）           │  │
│  │ EventForwarder（pi 事件 → 配置化转发项 → Outbox）              │  │
│  │ BridgeRuntime（scheduler marker 捕获 → 路由绑定）              │  │
│  │ NotificationThrottler（同类告警合并，防故障刷屏）               │  │
│  └──────────────────────────────▲─────────────────────────────────┘  │
│                                 │                                     │
│  ┌─────────────────── L1 接入层 ─────────────────────────────────┐  │
│  │ FeishuTransport（SDK Client/WSClient/EventDispatcher 封装）    │  │
│  │ ConnectionSupervisor（活性探针/僵尸检测/自动重建/状态机）       │  │
│  │ InboundPipeline（去重 → 群策略 → 命令 → 附件管线）              │  │
│  └──────────────────────────────▲─────────────────────────────────┘  │
│                                 │                                     │
│  ┌─────────────────── L0 宿主层 ─────────────────────────────────┐  │
│  │ DaemonHost（后台常驻 + gateway 文件锁 + TUI attach/detach）     │  │
│  └───────────────────────────────────────────────────────────────┘  │
└─────────────────────────────────┬─────────────────────────────────────┘
                                  │ WSS（事件）/ HTTPS（REST）
                                  ▼
                        ┌──────────────────┐
                        │  飞书开放平台      │
                        └──────────────────┘
```

**分层纪律**（可维护性的核心）：

- L1 只懂飞书协议，不懂 pi；L2 只懂 pi，不懂飞书协议；L3 是两者间唯一的可靠通道；L4 只做渲染
- 任何跨层调用必须通过显式接口（`InboundEvent` / `OutboundEnvelope`），禁止层间穿透
- 每一层独立可测：L1 用 fake SDK，L2 用 fake session，L3 用临时目录

### 4.2 消息主流程

**入站（飞书 → pi）**：

```
WS 事件 → ConnectionSupervisor（记录活性时间戳）
  → InboundPipeline：dedupe（持久化）→ bot 消息过滤 → 群策略判定（纯函数）
  → "/" 前缀 → CommandController（白名单，§8）
  → 普通消息 → AttachmentPipeline（下载/提取，安全约束同 QQ spec §6.4）
  → OutboundRouter.bindConversation（刷新路由）
  → ConversationManager.prompt(key, ...)
      → per-key FIFO 队列（TurnSupervisor 监督）
      → session.prompt(text, {images})
```

**出站（pi → 飞书）——一致性核心**：

```
session 事件流
  ├─ text_delta ──→ StreamingReplyCard（节流 patch，展示用，非真相）
  ├─ toolcall_* ──→ EventForwarder（按配置 → Outbox）
  └─ agent 回合结束
        → 真相提取：finalText = extract(session.messages)   ← 唯一真相源
        → Outbox.enqueue({ kind:"final", conversationKey, payload: finalText,
                           dedupeKey: `final:${sessionId}:${messageId}` })
        → Outbox worker：发送/更新卡片 → 成功标记 sent
        → Reconciler：已展示的流式卡内容 vs finalText
            不一致 → patch 卡片为最终文本（飞书所见 === pi 所出）
```

**定时任务（scheduler → 飞书）**：

```
my-pi-scheduler 到点 → 注入 scheduled_prompt custom 消息到 pi 会话
  → BridgeRuntime 捕获 marker（jobId）→ 查路由表（jobId → chatId/thread）
  → 该会话下一个 assistant 消息结束 → Outbox.enqueue(kind:"scheduled", ...)
  → 可靠投递到绑定飞书会话
```

---

## 5. 关键设计决策（ADR 摘要）

| # | 决策 | 理由 | 放弃的方案 |
| - | ---- | ---- | ---------- |
| ADR-1 | 接入层用飞书官方 SDK（WSClient + Client），不自研 WS | 协议细节（心跳/重连/卡回调）SDK 已封装；扫码建应用只有 SDK 提供 | 自研 WS（QQ spec 方案） |
| ADR-2 | SDK 重连不可信，外加 ConnectionSupervisor | SDK 内部重连无状态外显，僵尸连接是实测痛点 | 裸用 SDK |
| ADR-3 | 出站一律过持久化 Outbox，真相源 = session.messages | 100% 一致性的唯一可靠途径；流式卡只是"展示优化" | 直接发送 + 内存重试 |
| ADR-4 | 定时任务复用 my-pi-scheduler，本扩展只做路由 | 功能完备、已验证集成路径；避免重复造轮子 | 内置 cron |
| ADR-5 | daemon 常驻 + 文件锁（沿用参考实现） | TUI 关闭不断线；多实例互斥 | 进程级宿主 Symbol 单例（QQ spec 方案，无法跨进程） |
| ADR-6 | 会话隔离（每飞书会话独立 AgentSession） | /workspace、多用户、安全边界 | 共享原生会话 |
| ADR-7 | 配置单文件 `~/.pi/agent/feishu-link/config.json` + runtime-overrides 热更新 | 参考实现已验证 | 多文件 |
| ADR-8 | 出站双通道：流式 patch 走易失道，final/notify 走持久道 | 正确性不依赖实时道；省磁盘 IO | stream-patch 也持久化（v1.0） |
| ADR-9 | Outbox 分航道并行（laneKey=conversationKey） | 修跨会话队头阻塞 | 全局单 worker（v1.0） |
| ADR-10 | 对账 = 无条件 finalize，真相源唯一 | hash 比对脆弱且会误报；幂等 patch 代价可忽略 | hash 比对（v1.0） |
| ADR-11 | 权限桥三级分流 + 飞书审批卡 | headless 会话审批真空必须有主；懒人默认 relaxed+审计 | 依赖 SDK 默认行为（不可预期） |
| ADR-12 | WS 静默即无条件重建，probe 仅用于诊断 | REST 健康但 WS 僵尸无法用 probe 检测；重启健康连接无害 | 静默+probe 双重判定（v1.0，有漏洞） |

---

## 6. 模块设计

### 6.1 `transport.ts` — 飞书协议封装

职责：SDK 生命周期、事件归一化、REST 发送原语。接口：

```ts
interface FeishuTransport {
  start(dispatcher: InboundSink): Promise<void>;   // 建 Client + WSClient，注册事件
  stop(): Promise<void>;
  probe(): Promise<{ ok: boolean; latencyMs: number }>;  // GET /bot/v3/info，供活性探针
  replyText / sendText / replyCard / updateCard / sendImage / sendFile(...): Promise<{ messageId }>
  downloadResource(messageId, fileKey, type): Promise<{ bytes, mimeType }>
  getMessage(messageId): Promise<MessageBody>      // 引用展开
}
```

- 全部出站调用带 AbortSignal + 超时（send 10s / upload 60s / download 120s）
- 出站 HTTP 429/5xx → 抛 `RetryableError` 交 Outbox 处理；4xx → 抛 `FatalDeliveryError`
- 事件回调不阻塞：归一化为 `InboundEvent` 后立即交 pipeline，`void` 派发（参考实现同款）

### 6.2 `connection-supervisor.ts` — 连接监督者（R2 核心）

```ts
type ConnState = "disconnected" | "connecting" | "connected" | "degraded" | "restarting";

class ConnectionSupervisor {
  // 三个独立活性信号，任一异常即介入
  private lastEventAt: number;        // 任何 WS 事件（含卡动作）
  private lastProbeOkAt: number;      // 定时 probe() 成功
  private state: ConnState;
}
```

**监督循环**（每 15s tick）：

| 检测 | 阈值（可配） | 动作 |
| ---- | ------------ | ---- |
| 事件静默 | `silenceSuspectMs`（默认 20min）内无任何 WS 事件 | **无条件重建 WS**（v1.1 修正：见下） |
| probe 连续失败 | 3 次（间隔 30s） | state=degraded；结合静默判定影响面 |
| 重建中 | 指数退避 1s→2s→…→60s 上限，**不限次数** | 每次失败记日志；≥5 次连续失败触发本地 notify + 飞书恢复后补发"断连报告"（经 Throttler 合并） |
| 恢复 | 首事件到达 且 probe 成功 | state=connected → 触发 Outbox 续投 + 断连通知（FR-16） |

**关键细节**：

- **v1.1 重要修正——静默即重建**：v1.0 的"静默 + probe 失败才重建"逻辑有致命漏洞：probe 是 REST 通道，WS 是另一条独立通道，**REST 健康而 WS 僵尸（正是"长时间收不到消息"的实测痛点）在该逻辑下永远检测不到**。修正：事件静默超阈值即无条件重建 WS——重启一条健康连接代价极低（秒级、无消息丢失，断连窗口毫秒级），误杀无害。probe 的作用降级为**诊断**：区分"我方断网 vs 飞书平台故障"，决定告警文案
- 若 SDK 版本暴露 WS 层状态回调/重连事件，直接接入作为第一信号（开放问题 #7）
- 重建 = 新建整个 transport 实例（不复用旧对象，防半开状态）
- 状态全程写入 `status.json`（TUI 状态栏读取）+ 结构化日志
- `card.action.trigger` 也算活性事件（用户点按钮证明管道活着）

### 6.3 `inbound-pipeline.ts` — 入站管线

```
dedupe-store（SQLite/JSONL，message_id，7d TTL）
  → sender_type=bot 过滤
  → 群策略判定（group-trigger 纯函数：open/mention/keywords/alsoOnReply）
  → 随机表情回执（reactions.emojis 随机池取一枚，池内排除 DONE；"已收到"的即时反馈）
  → 回合完成 → 对触发消息打 DONE 表情（任务完成标记，DONE 不参与随机池，见 §6.4）
  → "/" 前缀 → CommandController
  → AttachmentPipeline：
      image → 下载 → prompt images（非视觉模型显式拒绝并提示 /model）
      file（txt/md/code）→ 有界提取（2MiB/150k 字符）
      audio（opus）→ 直接回复"暂不支持语音消息，请发文字或图片"（语音入站明确不做，见评审点 5）
      其他 → 识别并提示
```

### 6.4 `conversation-manager.ts` + `turn-supervisor.ts` — 会话与回合监督

会话层沿用参考实现骨架（per-key AgentSession / state.json / 模型与工作区 per-key / FIFO 队列），**新增 TurnSupervisor 解决队列头阻塞**：

```ts
class TurnSupervisor {
  // 每个回合挂 watchdog
  startTurn(key, run): void;
  // tick（每 10s）：
  //   - turnElapsed > turnTimeoutMs（默认 30min）→ session.abort() + 标记 failed
  //     + Outbox 通知"处理超时已中止，请重试" + 队列解锁
  //   - turnElapsed > ackAfterMs（默认 15s）→ 任务状态卡更新"仍在处理"
  //   - 队列等待 > queueWarnMs（默认 2min）→ Outbox 通知"前面任务耗时较长，你的消息在排队"
}
```

- `/stop` 沿用 runId 防误停旧卡
- 会话懒加载 + idleDispose 30min + maxResident 8
- 会话持久化文件按 `sha256(key + workspace)` 隔离

### 6.5 `outbox.ts` — 可靠出站（R1 核心，本 spec 与参考实现的最大差异）

**双通道架构（v1.1 修正）**：出站流量分两条道，**只有值得持久化的才落盘**——

- **LiveChannel（易失直播道）**：流式 patch、输入中指示。纯内存、同卡合并（coalesce）、节流 ≥800ms、失败即弃。**正确性永不依赖此道**——它只是体验优化
- **Outbox（持久可靠道）**：final / notify / tool 摘要 / scheduled / command-reply / 媒体。at-least-once + 幂等键

v1.0 把 stream-patch 也塞进持久化队列是错配：每 800ms 一次 fsync 的磁盘磨损，换来的是一堆 2 秒后就过期的记录。

**存储**：`~/.pi/agent/feishu-link/outbox/` 下 JSONL 段文件（append-only）+ 启动时重建内存索引。选 JSONL 而非 SQLite：零依赖、崩溃安全（每行 fsync）、可人工 inspect。若规模成问题再升级 SQLite（接口预留）。

**单写者纪律（v1.1 新增）**：只有 gateway owner（daemon）进程可写 outbox；TUI attach 进程的状态查询一律只读，TUI 侧产生的通知经 owner 转发。多进程并发 append 会破坏段文件与内存索引的一致性。

**信封**：

```ts
type OutboundEnvelope = {
  id: string;                    // ulid
  dedupeKey: string;             // 幂等键：`final:${sessionId}:${assistantMsgId}` / `tool:${...}` / `notify:${...}`
  laneKey: string;               // 航道 = conversationKey（同航道严格保序，跨航道并行）
  route: RouteRef;               // conversationKey → chatId/thread（经 OutboundRouter 解析）
  kind: "final" | "tool" | "notify" | "scheduled" | "command-reply" | "media";
  payload: CardPayload | TextPayload | MediaPayload;
  status: "pending" | "sending" | "sent" | "failed";
  attempts: number; nextRetryAt: number; createdAt: number; sentAt?: number;
  lastError?: string;
};
```

**Worker 语义（v1.1 修正：分航道并行）**：

1. **按 laneKey 分航道**：同一航道内严格按 enqueue 顺序串行发送；不同航道各自独立 drain（并发度 = 活跃航道数，上限可配，默认 8）。v1.0 的全局单 worker 有**跨会话队头阻塞**缺陷——A 群一条消息投递受阻，B 私聊的回复全部被无辜卡住
2. 发送成功（拿到 message_id）→ 标记 sent（先 append 状态行再视为完成）
3. RetryableError → 指数退避（5s→10min 上限），attempts+1，**永不放弃**，但只阻塞本航道；`failedNotifyAfterAttempts`（默认 8 次/约 20min）后向该会话发一条"投递受阻"告警（经 Throttler 合并）
4. FatalDeliveryError（4xx，如 chat 不存在）→ failed 终态 + 本地 notify + 日志
5. 进程启动时：扫描 outbox → pending/sending（崩溃残留）全部重置为 pending → 按航道 drain
6. dedupeKey 命中已 sent → 直接跳过（重启重放安全）

**清理与磁盘上限（防膨胀，强制机制非可选）**：

1. **段文件压缩（compaction）**：段文件按 ~1MB 切分；压缩器在启动时 + 每小时运行：重写所有段，仅保留 `pending`/`sending` 存活记录 + `sentRetentionMs`（默认 7 天）内的终态记录（sent/failed，仅供 dedupeKey 重放去重与审计）；全部记录都已消亡的段文件直接删除。7 天后的终态记录可安全丢弃——重放去重只发生在重启瞬间，超出窗口的旧 dedupeKey 无意义
2. **容量硬顶**：`maxPendingEnvelopes`（默认 1000）——超出时优先丢弃 `stream-patch`（可再生成），其次拒绝新的低优先级入队并告警；`maxEnvelopeBytes`（默认 256KB，final 回复分块后远小于此）——超限 payload 落盘为独立 blob 文件，信封只存引用，blob 随信封生命周期回收
3. **目录总量护栏**：`maxOutboxDirBytes`（默认 50MB）——压缩后仍超限 → 依次淘汰最旧 sent、最旧 failed（pending 永不淘汰）→ 仍超限则本地 notify + 飞书告警（极端情况，意味着飞书侧持续不可达）

**Final Reconciliation(一致性对账，v1.1 简化为无条件 finalize)**:

```
agent 回合结束：
  finalText = extract(session.messages)          // 唯一真相源
  outbox.enqueue({ kind:"final", payload: finalizeCard(finalText) })  // 总是以最终文本定稿卡片
```

v1.0 的"hash 比对不一致才 patch"已删除：delta 拼接结果与 session.messages 最终文本在空白/规范化上可能合法不一致（误报），思考块交错也会干扰比对。无条件 finalize 幂等且代价极小（多一次卡片 patch），**简单即可靠**。若回合中流式卡从未建立（fast path），finalize 退化为直接发送最终回复卡。

**验收标准**：kill -9 守护进程于任意时刻 → 重启 → 飞书侧最终收到的内容与 pi session.messages 完全一致（不多不少）。此场景进集成测试。

### 6.6 `outbound-router.ts` — 通用出站路由（定时任务抽象）

```ts
interface OutboundRouter {
  bindConversation(key, msg, sessionId): Route;   // 入站时刷新
  bindJob(jobId, key, name?): void;               // scheduler toolResult 捕获
  resolve(key | jobId): Route | undefined;        // Outbox worker 查询
}
```

- 路由表持久化 `routes.json`（chatId / chatType / threadMessageId / sessionId）
- 任何"需要主动发飞书"的来源（scheduler 结果、断连报告、投递告警、未来 webhook）只依赖本接口 —— **这就是用户说的"通用抽象"**：不绑定某个 scheduler 实现，marker 协议文档化（customType=`scheduled_prompt` + jobId），换插件只需适配 marker 捕获器

### 6.7 `event-forwarder.ts` — 配置化转发

```ts
type ForwardConfig = {
  aiReply: { mode: "card" | "text" };              // 必选，永远开
  streaming: { enabled: boolean; throttleMs: 800 };
  toolCalls: { mode: "off" | "summary" | "detail" };  // summary=任务卡里一行"⚙ Bash: ls"；detail=独立消息
  reasoning: { mode: "off" | "card" };             // thinking delta
  progress: { enabled: boolean };                  // 任务状态卡（运行中/完成/失败 + /stop 按钮）
  reactions: {
    enabled: boolean;
    emojis: string[];     // 入站随机表情池（排除 DONE，用户可覆盖）
    doneEmoji: string;    // 任务完成时对触发消息打的表情，默认 DONE
  };  // 表情回执：入站随机 + 完成时 DONE
};

> 表情策略（用户指令 2026-08-07）：收到用户消息先随机回一枚表情（"已收到"即时反馈），
> **随机池永不包含 DONE**；当该回合任务完成（`conversations.prompt` 成功返回最终回复）时，
> 对触发这条任务的消息补打 `doneEmoji`（默认 ✅/DONE）。两者均为 best-effort，失败静默忽略。
```

- 默认：`aiReply:card + streaming:on + toolCalls:summary + progress:on + reasoning:off`
- 飞书侧 `/feishu-config` 命令可热改（写 runtime-overrides.json）

### 6.8 `auth-setup.ts` — 一键认证

```
/feishu setup
  ├─ 扫码自动创建（默认）：lark.registerApp()
  │     onQRCodeReady → 终端二维码 + 复制链接 + TUI notify
  │     → 自动拿回 client_id/client_secret + 租户区域（feishu/lark 自动识别）
  ├─ 手动模式：粘贴 AppID/Secret（已有应用）
  └─ 群策略选择（open/mention）→ 写 config.json（0600）
```

- 开放问题 #1：registerApp 建的应用是否自动含"获取群组中所有消息"权限与机器人菜单 → 首次实机验证；若不含，setup 末尾打印一键直达链接（开发者后台对应页面）

### 6.9 `command-controller.ts` — 命令体系（详见 §8）

### 6.10 `daemon-host.ts` — 后台常驻

沿用参考实现：TUI `/feishu start` → spawn `PI_FEISHU_DAEMON=1 pi`（headless）→ 文件锁成为 gateway owner → TUI 退出 daemon 存活。新 TUI 启动自动 attach（状态栏只读）。`/feishu restart` 换代码后热重启。

### 6.11 `status.ts` — 可观测

`/feishu status` 输出（本地 + 飞书侧同内容）：

```
连接：connected（uptime 3h12m，最近事件 12s 前，probe 230ms）
今日：入站 47 / 出站 52 / outbox 积压 0 / 重连 1 次（14:03，持续 8s）
会话：活跃 2（key: oc_xxx… / topic…）/ 常驻上限 8
定时任务：3 个绑定路由
```

### 6.13 存储生命周期总表（所有落盘状态的防膨胀机制）

| 存储 | 位置 | 增长源 | 清理机制 |
| ---- | ---- | ------ | -------- |
| Outbox 段文件 | `outbox/` | 每条出站消息 | §6.5：压缩器 + 7d 终态保留 + 容量硬顶 + 50MB 护栏 |
| 入站 dedupe | `dedupe.jsonl` | 每条入站 message_id | 7d TTL，启动时 + 每日淘汰 |
| 投递幂等键（bridge sent） | `routes.json` 内 | 每次定时任务投递 | 30d TTL（定时结果重放窗口） |
| 附件临时目录 | `tmpdir/feishu-link/` | 入站附件下载 | 每条消息处理完即删 + 启动时清扫 >24h 残留 |
| 结构化日志 | `logs/` | 事件埋点 | 5MB × 3 轮转，debug 级才写详情 |
| pi 会话历史 | `~/.pi/agent/sessions/` | 用户对话历史 | **默认永久保留**（用户数据不擅自删）；`/feishu status` 显示磁盘占用；可选 `sessionRetentionDays`（默认 0=不清理），开启后仅清理 `idleDispose` 已回收且超期的 QQ 侧会话文件 |
| routes/state/config | `~/.pi/agent/feishu-link/` | 极小（KB 级） | 无需清理 |

`/feishu status` 增加磁盘视图：`outbox 2.1MB (pending 0) / logs 1.3MB / sessions 84MB`。

### 6.14 配置 schema（`config.json`，schemaVersion 1）

```jsonc
{
  "schemaVersion": 1,
  "appId": "...", "appSecret": "...", "domain": "feishu",
  "autoStart": true,
  "groupPolicy": "open",              // open | mention
  "groupKeywords": [],
  "groupAlsoOnReply": true,
  "allowUsers": [], "allowChats": [], "admins": [],
  "forward": { /* §6.7 默认值 */ },
  "connection": {
    "probeIntervalMs": 30000, "silenceSuspectMs": 1200000,
    "reconnectBackoffMaxMs": 60000, "downReportEnabled": true
  },
  "turns": { "turnTimeoutMs": 1800000, "ackAfterMs": 15000, "queueWarnMs": 120000 },
  "sessions": { "maxResident": 8, "idleDisposeMs": 1800000 },
  "outbox": { "dir": "~/.pi/agent/feishu-link/outbox", "maxAttemptsBeforeAlert": 8,
    "sentRetentionMs": 604800000, "maxPendingEnvelopes": 1000, "maxEnvelopeBytes": 262144,
    "maxOutboxDirBytes": 52428800, "compactIntervalMs": 3600000 },
  "media": { "maxAttachments": 4, "maxTotalBytes": 31457280 },
  "storage": { "sessionRetentionDays": 0 },
  "permissions": {                      // §6.15 权限桥
    "policy": "p2p-owner-relaxed",     // relaxed（owner 私聊默认放行+记录） | strict（一切危险操作需审批）
    "groupPolicy": "strict",           // 群聊永远默认 strict
    "autoApprove": ["read", "grep", "find", "ls"],
    "approvalTimeoutMs": 300000,       // 审批卡超时→按默认策略拒绝并通知
    "sessionMemory": true              // "本次会话不再询问"按钮
  },
  "notifications": { "mergeWindowMs": 600000 },   // §6.16 告警合并窗口
  "logging": { "level": "info" }
}
```

### 6.15 `permission-bridge.ts` — 工具权限桥（v1.1 新增，修 headless 审批真空）

**问题**：daemon 里跑的隔离会话没有 TUI，遇到需确认的工具调用（危险 bash、写文件出工作区等）**没人能点确认**——两个参考实现完全没处理这个真空，行为依赖 SDK 默认（不可预期）。

**设计**：扩展注册 `tool_call` 事件 handler，风险三级分流：

```
tool_call 事件
  ├─ 安全工具（read/grep/find/ls + 用户 autoApprove 列表）→ 放行
  ├─ 危险操作（bash 写删改、网络、出工作区写入…）
  │    ├─ policy=relaxed 且 owner 私聊 → 放行 + 记入审计日志（究极懒人默认：不打扰但可追溯）
  │    └─ policy=strict 或群聊 → 挂起，飞书发审批卡：
  │         [✅ 批准] [❌ 拒绝] [🔓 本次会话不再询问]
  │         超时（默认 5min）→ 拒绝 + 通知"操作未获批已跳过"
  └─ 黑名单（rm -rf /、curl|sh 等）→ 直接 block + 通知
```

- 审批卡带命令全文与解释；按钮回调走 card.action → 唤醒挂起的 tool_call
- 群聊场景永远 strict（防群友滥用机器人跑危险命令）
- 与 `@gotgenes/pi-permission-system` 的关系：若用户已装该扩展，本桥退化为纯通知（不重复拦截），开放问题 #8 验证冲突

### 6.16 `notification-throttler.ts` — 告警合并（v1.1 新增）

断连报告、投递受阻、超时中止、审批超时…故障抖动期会刷屏。**同类通知按 `mergeWindowMs`（默认 10min）合并**：窗口内同类事件只发首条 + 窗口结束时补发汇总（"过去 10 分钟共重连 6 次"）。紧急度分级：`info`（恢复通知）可合并，`critical`（投递彻底失败）直达。所有通知也走 Outbox（kind=notify，自身也要可靠）。

### 6.17 `diagnostics.ts` — 一键诊断导出（issue → AI 修复闭环）

**目标**：用户提 issue 时附上一个诊断包，AI 拿到就能定位、修复、TDD 验证，全程无需往返追问。

**触发（究极懒人三入口）**：

1. **飞书侧**：对机器人说 `/support`（或点状态卡的 [导出诊断] 按钮）→ 诊断包**作为文件直接发回当前会话**——用户不用碰终端
2. **本地**：`/feishu-doctor` → 生成到 `~/Downloads/feishu-link-diag-<ts>.tar.gz` 并复制路径
3. **自动附带**：critical 告警（如投递彻底失败）发出时自动打包附诊断包

**诊断包内容**（tar.gz）：

```
manifest.json        # 版本指纹：extension/pi/node/SDK 版本、OS、架构、uptime、config schema 版本
doctor.json          # 自检结果：config 合法 / probe 延迟 / WS 活性 / outbox 积压 / 磁盘 / scheduler 检测，绿黄红
config.json          # 脱敏后配置（见下）
status.json          # 连接状态机快照 + 最近 50 次状态迁移
events.jsonl         # 最近 N 条结构化事件（默认 500，可配），含 error 堆栈
outbox-summary.json  # pending/failed 信封元数据（id/kind/lane/attempts/lastError，**不含 payload**）
repro-trace.jsonl    # 最近一个失败回合的入站/出站事件序列（脱敏），供复现测试直接回放
ISSUE.md             # 预填的 issue 模板：环境表 + 自检红项 + 复现时间线 + 留白描述区
README-IN-BUNDLE.md  # 日志格式说明（事件 schema、错误码表）——让任意 AI 无需先验知识即可解析
```

**脱敏管线（默认强制，单测覆盖）**：

- `appSecret` 全掩码；`appId` 掩中段；open_id/chat_id → `sha256[:12]`；本地路径 `~` 归一
- **消息内容默认不含**（只留长度/hash/类型）；用户本地命令加 `--with-content` 显式 opt-in 才附（且 ISSUE.md 里大字提示含内容）

**AI 消费闭环**：`ISSUE.md` + `manifest.json` 结构化到"贴给任意 AI 即可开工"的程度；`repro-trace.jsonl` 的设计对齐集成测试的 fake-SDK 回放机制（§10.2），AI 可直接把 trace 转成复现测试 → 修复 → TDD 验证。

**体积控制**：事件环形缓冲（内存最近 500 条 + 落盘轮转 5MB×3 已有）；包上限 5MB，超出截断最旧事件并注明。

---

## 7. 可靠性故障矩阵（设计自检）

| 故障场景 | 检测 | 恢复 | 用户感知 |
| -------- | ---- | ---- | -------- |
| WS 僵尸（收不到事件，REST 正常） | **静默超时即重建**（v1.1 修正，不依赖 probe） | 无条件重建 WS | 无感（秒级重建） |
| 网络断开 | probe 失败 | 退避重建不限次 | 本地 notify；恢复后断连报告 |
| 进程崩溃于回复发送中途 | 启动扫描 outbox sending 残留 | 重置 pending 续投，dedupeKey 防重 | 无感 |
| 模型调用卡死 | TurnSupervisor 超时 | abort + 队列解锁 | 飞书收到"超时已中止，请重试" |
| A 会话投递受阻 | 航道内退避 | **只阻塞本航道，其他会话不受影响**（v1.1 分航道） | 该会话 20min 后收告警 |
| 飞书 API 429/5xx | worker 捕获 RetryableError | 退避重试永不放弃 | 长时间不通时告警消息 |
| 飞书 API 4xx（chat 失效） | FatalDeliveryError | failed 终态 | 本地 notify 管理员 |
| 流式卡丢 delta | 无需检测 | 无条件 finalize 定稿（v1.1 简化） | 无感（最终一致） |
| 危险工具调用无人审批 | PermissionBridge 挂起 | 飞书审批卡 / 超时拒绝 | 审批卡或"未获批已跳过" |
| 故障抖动期告警刷屏 | NotificationThrottler | 同类 10min 合并 + 汇总 | 首条 + 一条汇总 |
| daemon 与 TUI 双开 | gateway 文件锁 | 后者 attach | 状态栏 "In use by another process" |
| scheduler 插件未安装 | marker 捕获为空 | 路由绑定静默跳过 | `/feishu status` 显示 scheduler: not detected |
| 断连窗口内用户发消息 | （开放问题 #4：启动时拉历史补偿） | best-effort | 恢复通知中提示"可能漏收断连期间消息" |

---

## 8. 命令体系（pi ↔ 飞书对齐矩阵）

| 命令 | pi 终端 | 飞书侧 | 说明 |
| ---- | ------- | ------ | ---- |
| `/new` | ✅ | ✅ | 新会话 |
| `/resume` | ✅ | ✅（卡片翻页选择） | 历史会话 |
| `/model` | ✅（交互） | ✅（卡片选择） | 切模型 |
| `/thinking` | ✅（交互） | ✅（卡片） | 思考等级 |
| `/stop` | ✅ | ✅（命令 + 任务卡按钮） | 中止当前回合 |
| `/workspace [path]` | ✅ | ✅（admin） | 绑定工作区 |
| `/status` | ✅ | ✅ | 连接+会话状态 |
| `/compact` | ✅ | ✅（admin） | 压缩上下文 |
| `/help` | ✅ | ✅（**命令卡片：按钮 = 提示 + 一键执行**） | FR-7 主方案 |
| `/support` | — | ✅ | 诊断包一键导出**并发回当前会话**（§6.17） |
| `/feishu-doctor` | ✅ | — | 本地生成诊断包 + 自检报告 |
| `/feishu-config` | ✅ | ✅（admin） | 热改转发配置 |
| `/loop /remind /schedule` | ✅（my-pi-scheduler） | ✅（透传，结果回投飞书） | 定时任务 |
| `/login /quit /reload /settings /fork` 等 | ✅ | ❌ 显式阻塞并提示 | 安全边界 |

**命令提示（FR-7）三层设计**：

1. `/help` 卡片按钮组（确定可行，M2 交付）
2. 机器人菜单（开发者后台/API 验证后下发，开放问题 #1）
3. 群聊中 `@bot /help` 同样出卡片

---

## 9. 究极懒人 UX 设计（R7）

设计原则：**用户只需会两件事——扫码、说话**。其余一切要么自动，要么有按钮。

### 9.1 首次启动 → 用上机器人的完整链路（零文档）

```
pi install → 启动 pi
  → session_start 检测到无配置 → TUI 醒目提示：
    "检测到飞书桥未配置，输入 /feishu setup 扫码 30 秒搞定"
→ /feishu setup → 终端出二维码（同时给可点击链接）
→ 手机扫码 → 应用自动创建、凭据自动写入、连接自动启动
→ 提示下一步："打开飞书 → 搜索你的机器人 → 发任意消息"
→ 首条消息到达 → 机器人回【欢迎卡】（= 端到端自验通）：
    ✅ 连接成功！你可以直接说话，或点下方按钮：
    [📋 命令面板] [📁 切换工作区] [🤖 切换模型] [📊 状态]
```

### 9.2 全程零命令记忆

- **欢迎卡**：首次私聊 / 被拉进群主动发，按钮覆盖高频操作
- **/help 命令面板卡**：按钮 = 命令提示 + 一键执行（§8）
- **任务卡**：运行中显示进度 + [停止] 按钮，不用记 `/stop`
- **审批卡**：危险操作 [批准/拒绝/不再询问]（§6.15），不用回终端
- **配置卡**：`/feishu-config` 出交互卡（转发开关/群策略/模型默认值），点选即热改，**永不碰 JSON**

### 9.3 故障自愈 + 主动汇报（懒人不该盯状态）

- 断线：自动重连，恢复后飞书收到一条"连接已恢复（中断 2m13s）"——不说技术细节，说人话
- 长任务：进度卡自动更新；完成自动通知；卡死自动中止并告知"请重发"
- 投递问题：20min 投递不出去才打扰用户一次（合并告警，§6.16）

### 9.4 自然语言即自动化

- "每天早上 9 点总结这个仓库的 commit" → LLM 调 `schedule_prompt` → 回复确认卡"已创建，结果将发到本会话 [查看任务] [取消]"
- 依赖 my-pi-scheduler 已装；未装时回复"此功能需要 pi-scheduler，运行 `pi install npm:@ineersa/my-pi-scheduler` 即可"（附一键复制）

### 9.5 错误消息可行动化

错误不说"失败"，说"怎么办"：

- "这个模型不支持图片 → [一键切换到支持图片的模型]"
- "工作区不存在 → 回复 /workspace 路径 重新绑定"
- "语音暂不支持 → 请发文字或图片"

### 9.6 报障零门槛（issue → AI 修复闭环）

用户遇到 bug 不用会描述、不用会找日志：对机器人发 `/support` → 诊断包直接发到会话里 → 提 issue 附件上传。包内含预填 ISSUE.md + 结构化日志 + 复现 trace + 格式说明，**贴给 AI 即可定位修复并 TDD 验证**（§6.17）。默认脱敏，用户无需担心泄露。

### 9.7 多端一致性

飞书侧 `/status` 与本地 `/feishu status` 同一份数据源（status.json）；卡片上的模型/工作区显示永远与 pi 实际状态一致（从 ConversationManager 读真相，不存副本）。

---

## 10. 测试计划

### 10.1 单测（node:test）

- `group-trigger` 策略矩阵（沿用参考实现测试思路）
- `outbox`：崩溃恢复重放、dedupeKey 幂等、patch 合并、backoff 调度、**压缩器（终态淘汰/段删除/容量硬顶/目录护栏）**
- `finalizer`：无条件以 session.messages 定稿卡片，幂等；fast path（无流式卡）退化为直接发送
- `connection-supervisor`：假 transport 注入 → 静默即重建/退避序列/恢复转移
- `turn-supervisor`：超时 abort、队列解锁
- `permission-bridge`：三级分流矩阵、审批超时默认拒绝、sessionMemory、群聊强制 strict
- `notification-throttler`：合并窗口、critical 直达
- `diagnostics`：脱敏管线（secret/openid/路径/默认不含内容）、包体积上限、doctor 自检项、trace 可回放性
- `command-controller`：权限矩阵、阻塞列表
- `router/store`：路由绑定、job 绑定、持久化
- `rich-text`：分块、CJK 边界、卡片降级

### 10.2 集成测试（fake SDK 层）

- **kill -9 一致性测试**：回合进行中杀进程 → 重启 → outbox 续投 → 飞书侧最终文本 === session.messages（NFR-1 验收）
- WS 断线 5min → 恢复 → 断连报告 + outbox 无积压
- 队列头卡死注入 → 超时中止 → 后续消息正常处理
- scheduler marker → 路由投递闭环（fake scheduled_prompt）

### 10.3 实机验收（飞书沙箱租户）

- setup 扫码全流程（验证开放问题 #1 权限/菜单）
- 私聊/群 open/群 mention/话题 四场景往返
- 图片/文件入站；`feishu_send_local_file` 出站
- 拔网线 3min 恢复验证；daemon 重启验证；`/loop 1m 报告当前时间` 定时闭环

---

## 11. 里程碑

> **实施状态（2026-08-07，v0.1.0）**：M0–M8 代码级完成（**170 项测试全绿**，含 M7 出站媒体单测、断连补收、权限探测、daemon 生命周期、真实 pi CLI 加载）；附录 B 评审点已全部确认；实机验收（飞书沙箱租户）待用户执行，验收清单见 `docs/acceptance-checklist.md`（依赖开放问题 #1 权限验证）。

| 阶段 | 内容 | 验收 | 状态 |
| ---- | ---- | ---- | ---- |
| M0 | 脚手架（pi-package）+ config + setup 扫码 + transport 连通 | `/feishu status` = connected | ✅ src/common（config）+ src/host（auth-setup）+ src/inbound（transport）测试过；pi CLI 加载验证过 |
| M1 | 文本私聊闭环 + **Outbox** + dedupe | 私聊往返 + kill -9 一致性测试过 | ✅ outbox 13 项测试（含 kill -9 恰好一次集成测试） |
| M2 | 命令体系 + /help 卡片 + 群策略 + 欢迎卡/onboarding | 命令矩阵测试过 + 新用户零文档走通 | ✅ command-controller + cards + group-trigger 矩阵测试过；banner/onboarding 冒烟验证过 |
| M3 | ConnectionSupervisor + TurnSupervisor + NotificationThrottler + 断连通知 + **诊断导出** | 故障矩阵逐项演练过 + 诊断包脱敏单测过 | ✅ 全部实现并测试（僵尸检测/退避/审批超时/脱敏管线） |
| M4 | 群聊/话题 + 多媒体入站 | 四场景 + 图片/文件过 | ✅ 群策略（open/mention）✅；话题（chatMode 检测）✅；attachment-pipeline（图片→视觉、文件→提取、语音→提示）✅ |
| M5 | 流式卡 + 无条件 finalize + 任务状态卡 + EventForwarder 配置化 + PermissionBridge | 转发配置矩阵 + 审批卡闭环过 | ✅ live-channel + event-forwarder + permission-bridge 全部测试过 |
| M6 | my-pi-scheduler 集成（路由绑定 + 投递） | `/loop` 闭环 | ✅ bridge-runtime + 集成测试（marker→路由→Outbox 投递） |
| M7 | 出站媒体 + /workspace + daemon 完善 | 端到端过 | ✅ 媒体上传/发送（transport `uploadImage/uploadFile/sendImage/sendFile` + `feishu_send_local_file` 工具 → Outbox 可靠投递，单测覆盖）；✅ /workspace；✅ daemon spawn（gateway-lock + session 钩子 + 子进程守卫，真实 pi CLI 加载验证；完整实机验收待沙箱） |
| M8 | 加固 + 全测试 + README + 发布 npm | pi install 可用 | ✅ **170 测试全绿**；README（双语）/CHANGELOG/LICENSE 齐；`pi install .` 已验证注册 |

---

## 12. 开放问题

| # | 问题 | 验证方式 | 阻塞 |
| - | ---- | -------- | ---- |
| 1 | `registerApp` 扫码建的应用是否自带"获取群组中所有消息"权限？机器人菜单能否 API 配置？ | M0 实机 | 群 open 策略 |
| 2 | 飞书 WS 断连后平台是否补发窗口内消息（类似 QQ Resume）？ | 实测拔网线 | 入站补偿设计 |
| 3 | CardKit 流式卡的 patch 频率上限？ | M5 实测 | 节流参数 |
| 4 | 启动时能否用 `im.v1.chat.get` + 消息列表 API 拉取断连期间漏收消息做补偿？（机器人历史消息权限范围待确认） | M3 实测 | 入站零丢失 |
| 5 | my-pi-scheduler 的 custom marker 协议稳定性（版本升级兼容）？ | 锁定版本 + 适配层 | M6 |
| 6 | ~~语音 STT~~ 已关闭（语音直接提示不支持） | — | — |
| 7 | 所用 SDK 版本是否暴露 WS 层状态/重连事件回调（若有则作为僵尸检测第一信号）？ | M0 查 SDK 源码 | 监督器精度 |
| 8 | 与 `@gotgenes/pi-permission-system` 共存时 tool_call 拦截顺序是否冲突？ | M5 实测 | 权限桥降级策略 |

---

## 附录 A：调研产物索引

- 参考实现 clone：`.research/pi-feishu-lark-ax/`（AX1202 原版）、`.research/pi-feishu-lark-xjuai/`（yangtuooc fork）
- npm 调研：`@ineersa/my-pi-scheduler`（README 已索引至 context-mode KB，source: `npm-my-pi-scheduler-readme`）
- QQ 方案 spec（含 QQ/WS/附件安全管线细节，附件管线与命令设计复用）：`.spec/2026-08-06-1812-pi-qq-bridge扩展架构设计spec.md`

## 附录 B：评审确认点

1. ✅ 转向飞书、放弃 QQ 官方 API 路线
2. ✅ 定时任务复用 my-pi-scheduler（不自造）——已确认（用户指示按设计实施；M6 集成测试通过）
3. ✅ Outbox 用 JSONL 而非 SQLite——已确认（零依赖优先，接口预留升级）
4. ✅ 群策略默认 open（免@）——已确认（未开启权限时自动回退 mention）
5. ✅ 语音入站不做——收到语音直接提示不支持（飞书无官方 ASR，不接第三方 STT）
