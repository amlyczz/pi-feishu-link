# Pi QQ Bridge — Pi × QQ 双向通信扩展架构设计 Spec

> 版本：v1.0（草稿）
> 日期：2026-08-06
> 状态：调研完成，待评审
> 作者：pi-agent（AI 调研）

---

## 1. 摘要

本项目构建一个 **pi 官方扩展（extension）**，通过 **QQ 官方机器人 API v2** 实现 QQ（私聊 + 群聊）与本地 pi coding agent 的双向通信：

- **QQ → Pi**：文本、图片、语音、文档等多媒体消息注入 pi 会话
- **Pi → QQ**：最终回复、图片/文件（富媒体）发送回 QQ
- **命令**：QQ 侧 `/` 开头命令（白名单原生转发 + 扩展命令），支持 `/workspace {spaceName}` 指定工作区
- **目标**：高可靠（断线重连、消息去重、幂等回复）、高性能（低延迟流水线）、低资源占用（懒加载会话、空闲回收）

调研来源（详见 §3）：pi 官方 extensions 文档、QQ 官方 Bot API v2 文档、以及三个开源参考实现（全部 clone 到本地 `/tmp/pi-qq-research/` 深度研读）。

---

## 2. 需求分析

### 2.1 功能需求（FR）

| ID | 需求 | 优先级 | 说明 |
| ---- | ------ | -------- | ------ |
| FR-1 | 私聊（C2C）消息收发 | P0 | 用户与机器人私聊，文本/图文/语音/文件 |
| FR-2 | 群聊消息收发 | P0 | 群内 @机器人 触发，支持文本/图文；富媒体 best-effort |
| FR-3 | 多媒体输入 | P0 | 图片→视觉模型；语音→QQ ASR / 可选第三方 STT；TXT/PDF 文本提取；文件暂存供工具使用 |
| FR-4 | 多媒体输出 | P1 | `qq_send_local_file` 工具：本地图片/文件 → QQ 富媒体（file_info 上传） |
| FR-5 | QQ 侧 `/` 命令 | P0 | 白名单命令：`/help /status /model /thinking /new /sessions /resume /name /compact /stop` |
| FR-6 | `/workspace {spaceName}` | P0 | 切换指定工作区（cwd），会话绑定到该工作区 |
| FR-7 | pi 原生命令转发 | P1 | 部分 pi 原生命令经白名单原生转发（见 §7.4 边界） |
| FR-8 | 本地控制命令 | P0 | pi 终端 `/qqbot-start/stop/link/status/...` |
| FR-9 | 会话隔离 | P0 | 每个 QQ 对话独立持久化 QQ 会话，不污染本地 TUI 会话 |
| FR-10 | 权限控制 | P0 | allowUsers / allowGroups 白名单 + 管理员 + 访问申请 |

### 2.2 非功能需求（NFR）

| ID | 需求 | 指标 |
| ---- | ------ | ------ |
| NFR-1 | 可靠性 | 断线自动重连（Resume 补发事件）、消息去重（msg_id）、被动回复预算管理 |
| NFR-2 | 性能 | 消息入队→回复延迟：文本 <5s 常驻、附件下载流式限流、FIFO 串行防错投 |
| NFR-3 | 资源 | 会话懒加载（首次消息才创建 runtime）、空闲自动回收（默认 30min）、常驻内存受控 |
| NFR-4 | 安全 | HTTPS-only 下载、SSRF 防护、realpath/符号链接校验、凭据不入库 |
| NFR-5 | 可观测 | `/qqbot-status`、日志文件（5MB 轮转）、TUI 尾部视图 |
| NFR-6 | 兼容 | Pi >=0.82 <1.0，Node >=22.19，跨平台（Win/macOS/Linux） |

---

## 3. 调研记录（链接逐条分析）

> 调研时间 2026-08-06，三个 GitHub 仓库均已 `git clone --depth 1` 到 `/tmp/pi-qq-research/` 并深度阅读源码与测试。

### 3.1 pi 官方扩展文档 — <https://pi.dev/docs/latest/extensions>

**本地对应文件**：`/opt/homebrew/lib/node_modules/@earendil-works/pi-coding-agent/docs/extensions.md`（2963 行，pi v0.83.0 安装版本，已全文精读并索引）

**核心结论：**

- 扩展是 TypeScript 模块，默认导出 factory：`export default function (pi: ExtensionAPI) {}`，支持 async
- 自动发现位置：`~/.pi/agent/extensions/*.ts`（全局）、`.pi/extensions/*.ts`（项目），支持 `/reload` 热重载；npm/git 包通过 `pi install` 安装
- **关键能力**：
  - `pi.on(event, handler)`：生命周期/会话/agent/工具/输入事件
  - `pi.registerTool()`：自定义工具（含 `promptSnippet`/`promptGuidelines` 进入 system prompt）
  - `pi.registerCommand()`：注册 `/cmd` 命令，可加 `getArgumentCompletions`
  - `pi.sendUserMessage(content, {deliverAs})`：注入真实 user 消息触发回合；`deliverAs: "steer" | "followUp"` 支持流式中插嘴
  - `pi.sendMessage()`：自定义消息（含图片 base64 内容数组）
  - `ctx.ui`：confirm/select/input/notify/setWidget（TUI 交互）
  - `ctx.newSession / ctx.switchSession / ctx.fork / ctx.reload`：会话控制
  - `pi.setModel / setThinkingLevel / getThinkingLevel`：模型控制
  - `ctx.sessionManager`：会话条目访问
  - `ctx.isIdle() / ctx.abort() / ctx.compact() / ctx.waitForIdle()`
  - `pi.exec()`：执行 shell 命令
- **Input 事件处理顺序**（关键）：`扩展命令检查 → input 事件（可拦截/transform/handle）→ skill 展开 → template 展开 → agent 处理`
- **重要边界**（pi-agent-qqbot 文档确认）：pi 0.82 不暴露完整公开 input-dispatch API，**QQ 无法通用执行所有 skill/template/第三方斜杠命令**，只能支持白名单命令
- `pi.getCommands()` 返回可经 `prompt` 调用的命令（扩展命令/模板/skill），**内置交互命令（/model /settings）不包含**，只能交互模式执行
- 工具 `execute(toolCallId, params, signal, onUpdate, ctx)`：抛错=失败；返回 `terminate:true` 可提前结束；`withFileMutationQueue()` 文件互斥
- **SDK 层**（sdk.md）：`createAgentSession` / `createAgentSessionRuntime` / `createAgentSessionServices` / `AgentSession.prompt/steer/followUp/subscribe/abort/compact/setModel/setThinkingLevel` — XiaoSQM 方案的核心 API

### 3.2 GitHub: gtiders/pi-agent-qqbot（v1.0.4，Apache-2.0）

**仓库结构**：src/extension（native-session-runtime.ts 764 行核心）、src/application、src/domain、src/infrastructure（config/media/qq）、src/presentation/qq；测试齐全（unit/integration/characterization）

**核心设计（"原生会话绑定"方案）：**

- **哲学**：QQ 不是独立 agent，而是**同一 pi runtime 的第二个输入端**。终端与 QQ 共享 cwd、模型、上下文、会话历史、扩展 UI
- **绑定方式**：QQ 消息 → 附件安全管线 → `pi.sendUserMessage(content)` 注入**当前原生会话**；通过 `input` 事件（`event.source === "extension"`）识别 QQ 来源，`agent_settled` 后把输出经被动回复发回 QQ
- **能力**：
  - 唯一 C2C owner 绑定（`ownerOpenId`），不支持群聊
  - `ctx.ui.confirm/select/input/custom` 双端竞争（QQ + 终端任一先完成即生效）— `dual-ui-bridge.ts`
  - 图片/语音/文档/文件入站无扩展层配额（QQ 平台限制内）；QQ ASR 文本优先；出站走 QQ 官方 chunked 上传
  - QQ Keyboard 控制模型/思考等级/会话
  - 进程间 Gateway 所有权转移（`gateway-ownership.ts`，Unix socket + pid 存活检测）
- **命令**：本地 `/qqbot-start/stop/link/unlink/status/takeover`；QQ 白名单 `/help /status /model /thinking /new /sessions /resume /name /compact /stop`
- **关键机制**：
  - `ReplyBudget`（domain/reply-budget.ts）：每条入站消息最多 4 条被动回复
  - `NativeSessionLinkState`：link generation 防串话
  - 附件管线：HTTPS-only、SSRF（DNS+重定向校验）、流式大小限制、超时、AbortSignal
- **版本要求**：Pi `>=0.82.0 <1.0.0`，Node `>=22.19.0`
- **局限**：单 owner、无私聊外多用户、无群聊；QQ 命令仅白名单

### 3.3 GitHub: XiaoSQM/pi-coding-agent-qqbot（@xsqm/pi-qqbot v0.4.8，Apache-2.0）

**仓库结构**：约 25 个 TS 文件平铺 + 8 个测试文件，最成熟的隔离会话方案

**核心设计（"隔离 AgentSession"方案）：**

- **哲学**：每个 QQ 对话（私聊/群聊作用域）拥有**独立、持久化的 QQ AgentSessionRuntime**（SDK `createAgentSessionRuntime`），加载宿主 skills/MCP/插件但**排除 pi-qqbot 自身**防递归；绝不污染本地 TUI 会话
- **进程级宿主**（`host-registry.ts` + `index.ts`）：QQ 网关由进程级 `QQBotHost` 持有（`Symbol.for` 全局单例），本地 `/new /resume /fork /reload` 只 detach TUI 观察者，网关不断线；reload 后新扩展实例在 `session_start` 重新 attach
- **入站流水线**（`attachment-pipeline.ts` → `attachment-downloader.ts` + `attachment-extractors.ts` + `stt.ts`）：
  - 图片 → `resizeImage` → `session.prompt(prompt, {images})` 进入视觉模型；非视觉模型显式拒绝
  - 语音 → 优先 QQ `asr_refer_text`；可选 OpenAI-compatible STT
  - TXT/PDF → 有界提取（maxPdfPages=100、maxExtractedChars=150000）；DOC 仅识别
  - 下载：HTTPS-only、DNS/重定向 SSRF 校验、流式大小限制、超时、有限重试、AbortSignal、临时目录 0o700
- **steering 插嘴**（`router.ts` 复杂状态机）：当前对话运行中，同对话新消息 `session.steer()` 注入；不同对话 FIFO 串行
- **命令体系**（`command-controller.ts` + `command-parser.ts`）：QQ 侧 `/help /status /last /model /thinking /new /sessions /resume /name /compact /stop`；阻塞 `/login /logout /reload /quit /tree /fork /clone` 等危险命令；admin 权限校验
- **会话注册表**（`conversation-registry.ts`）：per-conversation-key 懒创建 + `idleDisposeMs` 空闲回收 + `maxResident` 上限
- **回复格式**（`reply-formatter.ts`）：QQ 原生 Markdown（msg_type=2）优先，被拒降级纯文本；语义分块（标题/段落/列表/代码围栏），UTF-8 字节预算 3600/块、最多 4 块、带"回答(1/3)"编号
- **出站媒体**（`outbound-media.ts`）：`qq_send_local_file` 工具，realpath/普通文件/硬链接/rename-race 校验，base64 → `/v2/users/{openid}/files`（file_type 1/4）→ msg_type=7 发送；C2C 可靠、群聊 best-effort
- **被动回复预算**：C2C 60min/4 条保守，群 5min/4 条保守（文档 4/5 冲突，取 4）
- **配置**：`~/.pi/agent/pi-qqbot.json`，schemaVersion 3，约 50 个字段全量可调
- **版本要求**：Pi >=0.82，Node >=22（同前）

### 3.4 GitHub: Star-233/pi-qq-integration（v0.5.2，MIT）

**仓库结构**：TS 平铺 16 个文件 + dist + node:test 测试（command/ipc/lock/registry/routing/validation）

**核心设计（"轻量转发"方案）：**

- **哲学**：QQ 消息 → `pi.sendUserMessage("[QQ]/[QQ群] text")` 转发到本地当前会话；回复经 REST 发回
- **能力**：
  - 单 WebSocket 长连接 + 心跳 + 自动重连（Resume）
  - token 自动刷新（7200s，60s 预刷新窗口，3 连败熔断）
  - **多实例**：文件锁（O_EXCL）选举 leader 持 WS 连接，follower 经 IPC（Unix socket/命名管道）委托收发；引用路由（ref_idx + 签名）回投
  - QQ `#` 命令：`#help #sessions #history #target #settings #instances #to #create #close`
  - 桌面消息转发（可选）、工具调用转发（可选）
- **局限**：无会话隔离（直接注入本地会话）、无附件处理管线（纯文本转发）、`#` 前缀命令体系（非 `/`）
- **价值**：轻量 WS 客户端实现（heartbeat/reconnect/resume 状态机）与 token 管理是最佳参考

### 3.5 QQ 官方 Bot API v2 — <https://bot.q.qq.com/wiki/develop/api-v2/>

> 文档站为 VuePress SPA，已用 Playwright 渲染逐页抓取关键页面（access-token / WebSocket / 消息收发概述 / Intents / C2C & GROUP 事件 / 发送与上传 API），源码数据另从 CDN `app.js` 提取。

**关键协议事实：**

| 主题 | 结论 |
| ------ | ------ |
| 接入票据 | AppID + AppSecret（Token 已废弃） |
| Access Token | `POST https://api.bot.qq.com/app/getAppAccessToken`（body `{appId, clientSecret}`）→ `{access_token, expires_in:7200}`；请求头 `Authorization: QQBot {token}`；60s 窗口内刷新换新 |
| WS 网关 | `GET /gateway` → `wss://api.bot.qq.com/websocket/`（沙箱 `sandbox.api.sgroup.qq.com`） |
| WS 握手 | Hello(op10, heartbeat_interval) → Identify(op2, `{token:"QQBot xxx", intents, shard:[0,1], properties}`) → READY → 周期心跳(op1: d=last s) → Heartbeat ACK(op11) |
| Resume | 断线后 op6 Resume(`{token, session_id, seq}`) 补发遗漏事件；错误码 4009 可 resume，其他 identify |
| Intents | `GROUP_AND_C2C_EVENT = 1<<25` 覆盖：C2C_MESSAGE_CREATE / FRIEND_ADD/DEL / C2C_MSG_REJECT/RECEIVE / GROUP_AT_MESSAGE_CREATE / GROUP_ADD_ROBOT / GROUP_MSG_* |
| 事件结构 | `{id, op:0, d:{...}, s:seq, t:event_type}` |
| C2C_MESSAGE_CREATE | d 含 `id`(消息ID)、`author.user_openid`、`content`、`timestamp`、`message_type`(0文本/3卡片/103引用)、`attachments[]`(url/filename/size/content_type/width/height)、`message_scene.ext`(msg_idx/ref_msg_idx/auth_token)；`asr_refer_text` 在附件中 |
| GROUP_AT_MESSAGE_CREATE | 同上 + `group_openid` + `mentions[]`；content 已去除 @机器人 前缀 |
| 附件 MIME | voice / image/jpeg / image/png / image/gif / video/mp4 / file；语音附 `voice_wav_url` |
| 发送单聊 | `POST /v2/users/{user_openid}/messages`，100 QPS |
| 发送群聊 | `POST /v2/groups/{group_openid}/messages`，100 QPS |
| 请求体 | `msg_type`: 0=文本(content) / 2=Markdown(markdown) / 6=输入中 / 7=富媒体(media.file_info)；`msg_id`(被动回复)、`msg_seq`(去重/递增多次回复)、`keyboard`、`message_reference` |
| 被动回复 | 单聊 60min 窗口 / 4 次；群聊 5min / 5 次（文档 4/5 冲突 → 保守取 4）；必须携带 `msg_id` |
| 富媒体上传 | `POST /v2/users/{openid}/files` 或 `/v2/groups/{group_openid}/files`，50 QPS；`file_type`: 1=图片(png/jpg) 2=视频(mp4) 3=语音(silk) 4=文件；URL 上传或分片上传（upload_prepare → PUT 预签名 → upload_part_finish → /files 合并）→ `file_info` |
| 大小限制 | 软限制 图片20MB/视频30MB/语音20MB/文件200MB，硬限制 200MB；超软限降级为文件类型 |
| 主动消息频控 | 单聊：10qps / 20qpm / 1000条天（未认证 5qps&30qpm）；群聊：60qpm / 20qpm / 1000条/群天；未认证 30qpm |
| 消息去重 | 相同 `msg_id` 可能重复推送，需结合 `msg_seq` 去重；相同 msg_id+msg_seq 重复发送会失败 → 递增 msg_seq 多次回复 |
| Keyboard | `keyboard.content.rows[].buttons[]`：`render_data{label}` + `action{type:0跳转/1回调/2指令, data, enter, reply}`；v2 openid 不能作 `specify_user_ids`（通用点击权限） |
| 撤回 | 2 分钟内可撤回自己消息（DELETE messages/{message_id}） |

**官方 SDK 参考**：Go `tencent-connect/botgo`、Python `botpy`、Node `bot-node-sdk`（仅接入参考）。

---

## 4. 技术选型

### 4.1 三方案对比

| 维度 | pi-agent-qqbot（原生绑定） | @xsqm/pi-qqbot（隔离会话） | pi-qq-integration（轻量转发） |
| ------ | -------------------------- | -------------------------- | ------------------------------ |
| 会话模型 | 共享当前原生会话 | 每对话独立 AgentSessionRuntime | 转发到当前本地会话 |
| 群聊 | ❌（仅单 owner 私聊） | ✅（GROUP_AT + allowGroups） | ✅（@bot） |
| 多用户 | ❌ | ✅ allowUsers | ✅ allowedUsers |
| 多媒体入站 | ✅ 全类型 | ✅ 全类型+STT/PDF | ❌ 纯文本 |
| 出站媒体 | ✅ chunked 上传 | ✅ base64 上传 | ❌ |
| 会话隔离/安全 | 中（共享上下文） | **高**（独立+排除自身） | 低（污染本地） |
| 资源占用 | 最低（复用） | 中（懒加载+回收） | 最低 |
| /workspace 支持 | 难（cwd 进程级共享） | **易**（每会话可绑 cwd） | 难 |
| 成熟度 | 高（多套测试） | 最高（测试+文档+演进） | 中 |

### 4.2 选定架构：**隔离 AgentSession 方案（@xsqm/pi-qqbot 路线）为骨架 + 三仓库精华融合**

**理由：**

1. 需求要求**私聊 + 群聊 + 多用户** → 排除 pi-agent-qqbot 单 owner 模型
2. 需求要求 **`/workspace {spaceName}`** → 隔离会话天然支持 per-conversation cwd 绑定；原生绑定方案 cwd 是进程级的，切换 workspace 会污染终端会话
3. 需求要求多媒体输入输出 → 两个隔离方案均具备
4. 需求要求**低资源** → 继承会话懒加载 + 空闲回收（idleDisposeMs）+ maxResident 上限
5. 可靠性 → 融合 pi-qq-integration 的 token 刷新/重连状态机 + pi-agent-qqbot 的 ReplyBudget/GatewayOwnership + @xsqm 的完整路由状态机

**融合点：**

- 网关/认证/API 层：参考 @xsqm `qq-gateway.ts` + pi-qq-integration `ws-client.ts`/`auth.ts`（重连退避、resume、token 预刷新）
- 会话层：@xsqm `QQAgentSession`（createAgentSessionRuntime 封装）+ 扩展 **workspace 绑定**
- 路由层：@xsqm `router.ts` 状态机（FIFO + steering）
- 出站：@xsqm `outbound-media.ts` + pi-agent-qqbot `ReplyBudget`
- 双端 UI：pi-agent-qqbot `dual-ui-bridge.ts`（可选增强）

---

## 5. 总体架构

```
┌───────────────────────── 本地机器 ─────────────────────────┐
│                                                            │
│  ┌───────────────┐   ┌─────────────────────────────────┐   │
│  │  Pi TUI 终端   │   │   pi-qq-bridge extension        │   │
│  │  (原生会话)     │◄──┤                                  │   │
│  └───────────────┘   │  ┌───────────────────────────┐  │   │
│                      │  │ QQBotHost (进程级宿主)      │  │   │
│                      │  │  ├─ QQAuth (token 管理)     │  │   │
│                      │  │  ├─ QQGateway (WS 长连接)   │  │   │
│                      │  │  ├─ QQApi (REST 发送/上传)   │  │   │
│                      │  │  ├─ AttachmentPipeline      │  │   │
│                      │  │  └─ Router (FIFO + steering)│  │   │
│                      │  └───────────────────────────┘  │   │
│                      │  ┌───────────────────────────┐  │   │
│                      │  │ ConversationRegistry       │  │   │
│                      │  │  per-conversation:         │  │   │
│                      │  │  QQAgentSession(runtime)   │  │   │
│                      │  │  + workspace binding       │  │   │
│                      │  └───────────────────────────┘  │   │
│                      │  ┌───────────────────────────┐  │   │
│                      │  │ WorkspaceRegistry          │  │   │
│                      │  │  name → absolute cwd       │  │   │
│                      │  └───────────────────────────┘  │   │
│                      └─────────────────────────────────┘   │
│                                                            │
└──────────────────────────┬─────────────────────────────────┘
                           │ WSS (Identify/Heartbeat/Resume)
                           │ HTTPS REST (send/upload)
                           ▼
                 ┌───────────────────┐
                 │  QQ 开放平台        │
                 │  (QQBot Server)    │
                 └───────────────────┘
                           ▲
                           │ 用户私聊 / 群@机器人
                           ▼
                      ┌─────────┐
                      │ QQ 用户  │
                      └─────────┘
```

### 5.1 消息主流程（QQ → Pi → QQ）

```
QQ 用户发消息
  → WS Dispatch (C2C_MESSAGE_CREATE / GROUP_AT_MESSAGE_CREATE)
  → QQGateway 归一化为 QQInboundMessage {id,type,text,userOpenId,groupOpenId?,attachments[]}
  → Router.handleInbound
      ├─ allowlist 校验（allowUsers/allowGroups）→ 未授权走 access-request 流程
      ├─ msg_id 去重（MessageDedupe 2h/2000 条）
      ├─ 空消息忽略；/ 开头 → 命令控制器（白名单）
      └─ 普通消息 → AttachmentPipeline.prepare（下载/提取/STT）
          → ConversationRegistry.get(msg)（懒创建 QQAgentSession + workspace cwd）
          → session.prompt(prompt, {images}) [source:"extension"]
          → 运行中同对话新消息 → session.steer()
  → Router 捕获 agent_end 最终文本
  → ReplyFormatter 分块（≤4 块，UTF-8 3600B/块）
  → QQApi 被动回复（msg_type 2 Markdown → 降级 0 文本），携带原 msg_id + 递增 msg_seq
```

### 5.2 Pi 侧集成点

| pi API | 用途 |
| -------- | ------ |
| `pi.on("session_start")` | 加载配置、attach 进程级宿主、绑定 TUI 视图 |
| `pi.on("session_shutdown")` | detach 观察者、网关保持 |
| `pi.registerCommand("qqbot-*")` | 本地控制命令（start/stop/status/requests/approve/deny/revoke/reconnect） |
| `pi.registerCommand("workspace")` | `/workspace {spaceName}` 命令入口（本地终端可用） |
| `pi.registerTool("qq_send_local_file")` | 出站富媒体工具（注入 agent） |
| `ctx.ui` | notify / setWidget（TUI 尾部视图）、confirm（审批） |
| `createAgentSessionRuntime` (SDK) | 每个 QQ 对话的隔离 runtime（动态加载 SDK） |

---

## 6. 模块设计

### 6.1 `qq-auth.ts` — Access Token 管理

```
接口：QQAuth { getToken(): Promise<string>; forceRefresh(): Promise<string>; }
机制：
  - 启动即获取 token；expires_in 7200s，预刷新窗口 60s
  - 定时器在过期前 60s 刷新；成功重置失败计数
  - 连续 3 次失败 → 触发 fatal 回调 → 网关断开并通知用户
  - API 401 时 forceRefresh 后重试一次
凭据：appId/clientSecret 仅内存，日志脱敏（maskAppId）
```

### 6.2 `qq-gateway.ts` — WebSocket 长连接

```
状态机：disconnected → connecting → connected → error / closed
握手：
  1. GET {base}/gateway → {url}（Authorization: QQBot {token}）
  2. WS 连接 → op10 Hello（heartbeat_interval）
  3. op2 Identify {token:"QQBot {token}", intents: 1<<25, shard:[0,1], properties:{...}}
  4. 收到 READY（记录 session_id）→ 每 heartbeat_interval 发 op1（d=last s）
  5. op11 Heartbeat ACK 校验
重连：
  - 断线 → 指数退避 1s→30s，最多 5 次后停止（/qqbot-reconnect 手动重试）
  - 重连成功后 op6 Resume {token, session_id, seq} → 补发遗漏事件 → RESUMED
  - 错误码处理：4009→resume；4006/4007→identify；4914/4915→停止并提示封禁
消息去重：seenMessages.admit(msg_id, ts)，2h TTL，2000 条上限
依赖：ws（唯一运行时依赖）
```

### 6.3 `qq-api.ts` — REST 发送/上传

```
sendText(target, content, msgSeq)       → POST /v2/users|groups/{openid}/messages, msg_type:0
sendMarkdown(target, md, msgSeq, kb)    → msg_type:2（群聊补 content:" "）
sendMedia(target, fileInfo, msgSeq)     → msg_type:7
uploadMedia(target, fileType, b64)      → POST /files {file_type, file_data, srv_send_msg:false} → file_info
sendInputNotify(target)                 → msg_type:6（可选增强）
超时：send 10s；upload 30s（可配）；AbortSignal.any([signal, timeout])
错误分类：QQApiError{status, code, requestAccepted}
```

### 6.4 `attachment-pipeline.ts` — 入站多媒体安全管线

```
输入：QQInboundMessage.attachments[]
处理（按到达顺序，串行）：
  - 数量上限 maxAttachments(4)、总字节上限 maxTotalBytes(30MiB)
  - 图片(JPEG/PNG/GIF) → 下载 → resizeImage → images[] → prompt(images)（模型需 input 含 image）
  - 语音 → 优先 attachment.asr_refer_text；否则可选 STT(OpenAI-compatible, apiKey 仅环境变量)
  - 文档：.txt → 有界提取(2MiB)；.pdf → 文本层提取(20MiB/100页/150k字符)；.doc → 识别并提示不支持
  - 其他/超限 → rejected（原因写回回复）
下载安全（AttachmentDownloader）：
  - 仅公网 HTTPS；DNS 解析校验 + 每次重定向校验（SSRF）；≤5 重定向、≤2 重试
  - 流式写入临时目录（tmpdir/pi-qqbot/{runtimeId}/{messageId}/，0o700）
  - AbortSignal 取消；消息结束后 cleanup 删除
```

### 6.5 `conversation-registry.ts` — 会话注册表（含 workspace 绑定）

```
key = conversationKey(msg)：私聊 user_openid / 群 group_openid
entry = { key, session: QQAgentSession, lastUsedAt, initializing? }
get(msg)：
  - evictExpired()（idleDisposeMs 默认 30min，非 streaming 且未初始化中才回收）
  - evictIfNeeded()（residentCount ≥ maxResident(8) 时回收最旧空闲）
  - 未命中 → 新建 QQAgentSession 并 init(cwd=workspaceDir||agentCwd, sessionDir=persistent dir)
sessionDirFor(key)：sha256("pi-qq-bridge\0"+key).slice(0,32) 目录，持久化 QQ 历史
dispose()：全部会话优雅释放
```

### 6.6 `workspace-registry.ts` — Workspace 管理（新模块，本 spec 核心新增）

```
数据：workspaces: { name: string; path: string; description?: string }[]
  - 配置文件 ~/.pi/agent/pi-qq-bridge.json 内 "workspaces" 字段
  - 或独立文件 ~/.pi/agent/pi-qq-bridge-workspaces.json
校验：path 必须存在且为目录（realpath 解析）；禁止相对路径；name 安全字符 [a-zA-Z0-9_-]
API：
  - list() → 全部 workspace（含当前绑定）
  - resolve(name) → { name, path } 或报错
  - 当前会话绑定：conversation registry 内每会话存 workspace 引用
命令（QQ 与本地均可用）：
  /workspace                     → 列出所有 workspace + 当前
  /workspace {name}              → 切换当前 QQ 对话的工作区（重建会话 runtime 于新 cwd）
  /workspace add {name} {path}   → 管理员：注册（本地终端建议；QQ admin 可选）
  /workspace remove {name}       → 管理员：删除（QQ 对话已绑定则拒绝）
切换语义：
  - 切换后旧 QQ 会话 dispose，新 runtime 以 {path} 为 cwd 创建
  - 会话历史按 workspace 隔离：sessionDir 加 workspace 维度（key=conversationKey + workspaceName）
  - 同一 QQ 对话在不同 workspace 间切换不互相污染
默认：未配置 workspaces 时仅存在 "default"（= 宿主 agentCwd），/workspace 单参数切换仍有效
```

### 6.7 `router.ts` — 消息路由与状态机

```
PiQQBotRuntime（进程级宿主持有）：
  - queue: MessageQueue（FIFO，maxQueueSize 20，满则丢最新）
  - activeConversation: ActiveConversationRun {key, qq, signal, ready[], submitted, ...}
  - pump 循环：取队首 → 建/取会话 → runActiveConversation
  - 同对话运行中 → admitActiveMessage → flushReadyAsSteers → qq.steer()
  - 不同对话 → FIFO 串行（防上下文/回复错投）
  - 聚合最终回复：所有注入输入完成后一次回复，引用最新进入上下文的 msg_id
  - ReplyBudget：每入站 msg_id 独立预算（默认 4），ack/分块/媒体共用
  - 慢任务 ack：progress.enabled && ackAfterMs>0 → 先发"已收到，正在处理"（占用 1 次配额）
  - /stop：中止当前对话任务 + 清 pending
```

### 6.8 `command-controller.ts` — QQ 侧命令白名单

```
允许：help/status/last/model/thinking/new/sessions/resume/name/compact/stop/workspace
阻塞：login/logout/theme/settings/quit/exit/reload/tree/fork/clone/clear/redo/undo
未知 / 命令：回复"未知命令"（不转发给模型）
admin 权限：commands.admins 显式数组；命令 mutations（model/thinking/new/resume/name/compact/stop/workspace）需 admin
/workspace 授权：QQ 侧切换需要 admin；列出允许所有已授权用户
```

### 6.9 `reply-formatter.ts` — 回复分块与格式

```
- normalizeMarkdown：\r\n 归一、控制字符清理、表格转列表
- chunkMarkdown：语义边界（标题/段落/列表/代码围栏）切分，UTF-8 ≤3600B/块，最多 4 块
- 分块带低干扰编号："回答（1/3）"
- 降级：QQ Markdown 拒绝 → 纯文本（同步切块保证 msg_seq 对齐）
- 排版规范：结论→关键点→注意事项；宽表格转列表；风险用引用块
```

### 6.10 `terminal-view.ts` — TUI 尾部视图

```
- ctx.ui.setWidget（≤10 行）：授权入站文本、队列/运行状态、assistant 文本流、工具调用起止、回复结果
- 只读观察者，不写本地会话 JSONL，不进模型上下文
- 本地会话替换（/new /resume /fork /reload）时旧视图销毁、新扩展实例自动重挂
```

### 6.11 `config.ts` — 配置（schemaVersion 4）

```jsonc
{
  "schemaVersion": 4,
  "enabled": true,
  "startup": { "mode": "auto", "keepAcrossLocalSessions": true, "handoffGraceMs": 10000 },
  "appId": "...", "clientSecret": "...", "sandbox": true,
  "allowUsers": [], "allowGroups": [],
  "workspaces": [ { "name": "default", "path": "" } ],
  "commands": { "enabled": true, "accessRequests": true, "allowInGroups": false, "admins": [], "buttons": true },
  "sessions": { "mode": "persistent", "restore": "recent", "maxResident": 8, "idleDisposeMs": 1800000 },
  "replyFormat": "auto", "showProcess": false,
  "progress": { "enabled": true, "ackAfterMs": 3000 },
  "maxQueueSize": 20,
  "media": { "enabled": true, "maxAttachments": 4, "maxTotalBytes": 31457280, "downloadTimeoutMs": 120000,
    "image": {"maxBytes": 10485760}, "voice": {"enabled": true, "preferQQAsr": true, "maxBytes": 26214400},
    "documents": {"allowExtensions": [".txt",".pdf",".doc"], "maxTxtBytes": 2097152, "maxPdfBytes": 20971520,
                  "maxDocBytes": 10485760, "maxPdfPages": 100, "maxExtractedChars": 150000} },
  "outboundMedia": { "enabled": false, "adminsOnly": true, "allowPrivate": true, "allowGroups": false,
    "allowedRoots": [], "images": true, "files": true, "maxFilesPerTurn": 2,
    "maxImageBytes": 10485760, "maxFileBytes": 20971520, "maxTotalBytes": 31457280, "uploadTimeoutMs": 30000 },
  "logging": { "level": "info" }, "debug": false
}
```

**安全默认**：allowUsers 与 allowGroups 均为空 → 不处理/下载任何真实入站消息。

---

## 7. `/workspace` 命令详细设计（FR-6 核心）

### 7.1 触发方式

- **QQ 私聊/群聊**：`/workspace`、`/workspace {spaceName}`（管理员可切换；管理员配置见 `commands.admins`）
- **本地 pi 终端**：`/workspace {spaceName}`（pi.registerCommand 注册，终端用户天然是管理员）

### 7.2 交互示例（QQ）

```
用户: /workspace
Bot:  ## 工作区
      当前：**default**（/Users/zqy/Developer/promo-tcn）
      - `default`  /Users/zqy/Developer/promo-tcn
      - `research` /Users/zqy/Developer/pi-research
      发送 /workspace <名称> 切换。

用户: /workspace research
Bot:  ## 已切换工作区
      - 工作区：**research**
      - 路径：`/Users/zqy/Developer/pi-research`
      - 会话已重置到该目录，直接发送任务即可。
```

### 7.3 实现要点

1. **workspace 注册**：配置 `workspaces[]`；`add/remove` 走本地命令（终端管理员）或 QQ admin 命令
2. **path 校验**：`realpath()` 解析、必须存在且为目录、拒绝符号链接逃逸、拒绝非绝对路径（`path.isAbsolute`）
3. **会话切换**：
   - 目标 workspace 与当前相同 → 直接返回
   - 不同 → 旧 `QQAgentSession.dispose()`（若运行中先 `/stop`），注册表以新 cwd 重建
   - sessionDir 带 workspace 维度：`sha256("pi-qq-bridge\0" + key + "\0" + workspaceName)` → 历史隔离
4. **模型保持**：workspace 切换保留当前模型/思考等级（QQAgentSession 重建时传入）
5. **权限**：QQ 侧非管理员执行 `/workspace` 无参数可查看列表（不泄露路径以外的敏感信息）；带参数切换需 admin

### 7.4 pi 原生命令转发边界（FR-7，重要澄清）

根据 pi 文档与 pi-agent-qqbot 实践确认：

| 命令类型 | 能否从 QQ 原生执行 | 实现方式 |
| ---------- | ------------------- | ---------- |
| 扩展注册命令（pi.registerCommand） | ✅ 可经 input 流程原生转发 | `sendUserMessage("/cmd args")` |
| 白名单 QQ 命令（/model /thinking 等） | ✅ | 扩展内直接调 SDK（不经模型猜测） |
| 内置交互命令（/model /settings /tree /fork /clone /login /logout /reload /quit） | ❌ 只在交互模式 | 显式阻塞并提示 |
| skill/模板命令（/skill:x /template:x） | ❌（0.82 无公开 dispatch API） | 白名单化，或经会话内自然语言触发 |
| `/workspace` | ✅ | 扩展注册命令 + QQ 命令控制器双入口 |

**结论**：用户"`/` 开头的命令可以原生转发"的理解**部分正确**——只有扩展注册命令和本扩展白名单命令可可靠执行；pi 内置交互命令和任意 skill 不能。spec 明确此边界，避免过度承诺。

---

## 8. 安全设计

| 风险 | 对策 |
| ------ | ------ |
| 远程 prompt injection | QQ 消息进入隔离会话（非本地 TUI）；附件正文标记为不可信数据；附件不提升为系统指令 |
| 未授权访问 | allowUsers/allowGroups 白名单 + 访问申请（10min 审批码）+ 管理员独立配置 |
| SSRF | 仅 HTTPS、DNS + 每跳重定向校验、≤5 跳、禁内网地址、超时 + Abort |
| 路径越权出站 | realpath、符号链接解析、普通文件校验、硬链接拒绝、rename-race 复检、allowedRoots 白名单 |
| 凭据泄露 | clientSecret 仅内存；config 0600；日志脱敏；.gitignore |
| 本地会话污染 | 隔离 AgentSessionRuntime；TUI 视图只读；扩展排除自身防递归 |
| 命令滥用 | 白名单 + 阻塞危险命令 + admin 校验 |
| 资源耗尽 | 队列上限、附件数/大小上限、会话数上限、回复预算 |
| 文件后门 | 压缩包/DOCX/视频不自动解压/执行；仅白名单扩展名提取文本 |
| 密钥管理 | STT key 仅环境变量读取 |

---

## 9. 性能与资源预算

| 项 | 设计 |
| ---- | ------ |
| 常驻开销 | 1 条 WS 连接 + token 定时器 + 队列（内存恒定） |
| 会话内存 | 懒创建；maxResident 8；idleDisposeMs 30min 回收；持久化历史在磁盘 |
| 附件下载 | 流式 + 总字节上限；多附件串行处理防带宽峰值 |
| 回复延迟 | 文本消息直通；附件下载与 STT 为唯一慢路径，均有超时 |
| 并发模型 | 单对话 steering 并行注入；跨对话全局 FIFO；不并跑多 agent 防上下文错投 |
| 重连风暴 | 指数退避 1s→30s + 5 次上限；Resume 而非 Identify 减少握手成本 |
| token 刷新 | 60s 预刷新窗口，避免请求期卡顿 |
| 日志 | 5MB 轮转截断；debug 级别才写详情 |

---

## 10. 测试计划

### 10.1 单测（node:test，零额外 dev 依赖策略可选）

- `qq-api.test.ts`：请求构造、错误分类、msg_seq 递增
- `reply-formatter.test.ts`：分块字节边界、代码围栏完整性、Markdown 降级、UTF-8 CJK
- `command-parser.test.ts` + `command-controller.test.ts`：命令解析、权限矩阵
- `router-steering.test.ts`：steering 时序、FIFO、聚合回复、预算耗尽
- `config.test.ts`：schema 校验、默认值、workspace 校验
- `workspace-registry.test.ts`：resolve/校验/切换隔离
- `message-dedupe.test.ts`：msg_id 去重 TTL
- `outbound-media.test.ts`：路径校验、硬链接拒绝、大小限制
- `attachment-extractors.test.ts`：TXT/PDF 边界（页数、字符上限、pdf_no_text）

### 10.2 集成测试（沙箱）

- 沙箱模式（sandbox:true）端到端：私聊文本/图片 → pi 回复；群 @ 消息
- WS 断线重连 + Resume 补发
- token 过期刷新
- `/workspace` 切换隔离

### 10.3 手动验收清单

```
pi 终端：
  /qqbot-start → /qqbot-status → 连接 OK
  /workspace list / /workspace research 切换
QQ：
  发"查看当前目录文件" → pi 回复目录列表
  发图片 → 视觉模型描述
  发语音 → 文字回执
  /model /thinking /new /sessions /resume /name /compact /stop /help
  /workspace 切换后任务在目标目录执行
  未授权用户 → 申请码；管理员 approve 后可用
```

---

## 11. 里程碑

| 阶段 | 内容 | 验收 |
| ------ | ------ | ------ |
| M0（本周） | 仓库脚手架：package.json（pi-package）、tsconfig、config 加载、auth+gateway 连通沙箱 | `/qqbot-status` 显示 connected |
| M1 | 文本私聊闭环：inbound → 隔离会话 → 被动回复；消息去重、回复预算 | 私聊文本往返成功 |
| M2 | 命令体系：QQ 白名单命令 + 本地命令 + admin/access-request | 命令矩阵测试通过 |
| M3 | 多媒体入站：图片/语音/文档管线 + STT/PDF | 各类型端到端通过 |
| M4 | 群聊支持（GROUP_AT）+ allowGroups | 群 @ 往返成功 |
| M5 | `/workspace`：注册表 + 切换 + 会话隔离 | workspace 测试通过 |
| M6 | 出站媒体（qq_send_local_file）+ 回复格式分块 | 文件发送成功 |
| M7 | 加固：重连/steering/性能/安全审查 + 完整测试 | 测试全绿、压力通过 |
| M8 | 发布 pi package（npm）+ README + CHANGELOG | pi install 可用 |

---

## 12. 风险与开放问题

| # | 风险/问题 | 影响 | 对策 |
| --- | ----------- | ------ | ------ |
| 1 | pi SDK 内部 API（createAgentSessionRuntime 等）版本漂移 | 隔离会话方案依赖 SDK 未文档化接口 | 动态 import + 错误降级；紧跟 pi 版本；保留"绑定原生会话"兜底方案 |
| 2 | 群聊富媒体入站无平台保证 | 群图片/文件可能收不到 | best-effort + `/qqbot-status` 暴露阶段状态 |
| 3 | 被动回复次数文档冲突（4/5） | 长回复被截断 | 保守取 4 + 分块编号 |
| 4 | 沙箱与正式环境差异 | 验收误判 | 双环境配置（sandbox 开关） |
| 5 | `/workspace` 与既有会话 restore 冲突 | 切换后恢复错会话 | sessionDir 含 workspace 维度，严格隔离 |
| 6 | Windows 路径/符号链接语义 | 出站校验失败 | 跨平台 realpath 分支 + CI 矩阵 |

---

## 附录 A：调研链接清单（全部记录）

| # | 链接 | 类型 | 调研深度 | 关键产出 |
| --- | ------ | ------ | --------- | --------- |
| 1 | <https://pi.dev/docs/latest/extensions> | pi 官方文档 | 全文精读（2963 行）+ 索引 | ExtensionAPI/事件/命令/SDK 全貌（§3.1） |
| 2 | <https://github.com/gtiders/pi-agent-qqbot> | GitHub 仓库 | clone + 源码阅读 + 测试结构 | 原生会话绑定方案、ReplyBudget、双端 UI、GatewayOwnership（§3.2） |
| 3 | <https://github.com/XiaoSQM/pi-coding-agent-qqbot> | GitHub 仓库 | clone + 源码阅读 + 测试结构 | 隔离 AgentSession 方案、steering、附件管线、workspace 基础（§3.3） |
| 4 | <https://github.com/Star-233/pi-qq-integration> | GitHub 仓库 | clone + 源码阅读 | 轻量 WS/token/多实例 IPC 参考（§3.4） |
| 5 | <https://bot.q.qq.com/wiki/develop/api-v2/> | QQ 官方文档 | Playwright 逐页抓取 + CDN 数据提取 | 协议事实表（WS/Intents/API/频控/媒体）（§3.5） |

## 附录 B：本地调研产物

- 三个仓库 clone：`/tmp/pi-qq-research/{pi-agent-qqbot,pi-coding-agent-qqbot,pi-qq-integration}`
- QQ 文档抓取：`/tmp/pi-qq-research/qq-*.html`、`app.js`（文档全量数据）
- pi 文档索引：context-mode KB（source: `pi-docs-extensions` / `pi-docs-sdk`）
- QQ 文档索引：context-mode KB（source: `qq-bot-*` / `qq-doc-*`）

## 附录 C：待办确认（评审点）

1. ✅ 确认采用隔离 AgentSession 架构（非原生绑定）——涉及"QQ 与终端共享上下文"需求的取舍，若要求共享上下文需改方案
2. ✅ `/workspace` 命令权限：QQ 侧切换是否仅 admin（本 spec 默认 admin）
3. ⏳ 项目目录：`/Users/zqy/Developer/promo-tcn/pi-qq-bridge/` 下开发（含 .spec/）
4. ⏳ 沙箱 AppID/Secret 申请（需用户操作 QQ 开放平台）
