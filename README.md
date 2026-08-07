<div align="center">

# pi-feishu-link

**Pi × 飞书/Lark 双向桥接扩展** — 扫码即用 · 消息零丢失 · 连接自愈 · 报障一键导出

[中文](#中文) · [English](#english)

</div>

---

# 中文

> 全网统一昵称：**小斯syzs**
>
> B站 [@小斯syzs](https://space.bilibili.com/390211071) · 抖音 · 小红书 · 快手（全网同名，搜 **小斯syzs**）
>
> 💬 加入飞书交流群：**[点击加入](https://applink.feishu.cn/client/chat/chatter/add_by_link?link_token=45al067b-19ea-4fa0-bba6-d550be5fe2ea)**（反馈问题 / 交流用法）

## 特性

| 能力 | 说明 |
| ---- | ---- |
| 🎯 **一键认证** | `/feishu setup` 终端出二维码，扫码自动创建飞书应用并写入凭据，30 秒上线 |
| 🐇 **零命令记忆** | 欢迎卡 / 命令面板卡 / 审批卡全按钮化；群聊免 @（open 策略） |
| 💪 **消息零丢失** | 出站走持久化 Outbox（JSONL 段文件 + at-least-once + 幂等键 + 分航道并行），进程被 kill 后重启自动续投，**恰好一次** |
| 🛡 **连接自愈** | 事件静默即无条件重建 WS（修复"长时间不回复"的僵尸连接）；断线自动重连、**断连期间消息自动补收**、主动汇报 |
| ⏱ **回合监督** | 模型卡死自动中止 + 解锁队列 + 通知；排队过久主动告知 |
| 😊 **表情回执** | 收到消息随机回一枚表情（"已收到"）；**任务完成**才对触发消息补打 ✅（DONE 不参与随机池），池可热改 |
| 🔓 **默认全部放行** | 除破坏性黑名单外一切工具调用直接放行（私聊/群聊一致，零打扰）；黑名单（`rm -rf /`、`curl\|sh` 等）弹**审批卡**（⚠️ 危险，管理员批准才执行，5min 超时自动拒绝）；`strict` 模式可切回全面审批 |
| 🩺 **一键诊断** | 飞书发 `/support`（或点状态卡 [导出诊断]）→ **脱敏诊断包作为文件直接发回会话**（凭据掩码、id 哈希、内容默认不含），内含预填 ISSUE.md + 复现 trace + 权限自检，贴给 AI 即可定位修复 |
| ⏰ **定时任务** | 说"每天 9 点总结 commit"即可创建，结果自动回投本会话 |
| 📎 **多媒体** | 入站图片→视觉模型、文件→有界文本提取、语音提示不支持；出站图片/文件经 `feishu_send_local_file` 上传发送 |

## 快速开始

```bash
pi install git:github.com/amlyczz/pi-feishu-link   # 或 clone 后: cd pi-feishu-link && pi install .
pi install npm:@ineersa/my-pi-scheduler            # 可选：定时任务（不装不影响其他功能）
pi                                 # 启动 pi
/feishu setup                      # 终端出二维码 → 手机扫码 → 凭据自动写入
/feishu start                      # 启动桥接（daemon 常驻，TUI 关闭不断线）
```

> ⏰ **定时任务 = 可选依赖**（不自动安装，动态检测）：不装 my-pi-scheduler，其他功能完全不受影响；装了就多出定时任务能力。**安装后重启 pi 生效**，然后直接在飞书聊天里说「每天 9 点总结 commit」即可创建，到点结果自动回投会话。未安装时发 `/loop /remind /schedule` 会收到明确的安装指引（含一键复制命令）。

然后打开飞书，搜索你的机器人，发任意消息——收到欢迎卡即端到端连通。

> 群聊免 @ 需机器人在飞书开发者后台开启 **「获取群组中所有消息」** 权限（open 策略依赖）。未开启时群聊自动回退到「@ 触发」（mention）模式；`/support` 诊断包会自检并提示。

## 权限

**默认全部放行，只有破坏性命令弹审批卡**（零打扰）：

- **默认（relaxed）**：除黑名单外，**一切工具调用直接放行**——私聊、群聊都一样，不弹卡、不打扰
- **黑名单 → 审批卡**：`rm -rf /`（含 `rm -r -f`、`--recursive --force`、`/*` 变体）、下载即执行（`curl/wget … | sh/python/node`）、`cat/echo … | sh`、`dd of=/dev/sdX`、`chmod 777 /` 等破坏性命令**不再硬拦**，而是弹飞书审批卡（带 ⚠️ 危险横幅）：管理员点【批准】才执行，5 分钟没人批自动拒绝
- **strict 模式**：`/feishu config permissions.policy=strict` 切回严格管控——非白名单工具也全部弹审批卡
- **白名单**：`read/grep/find/ls` 等安全工具任何时候直接放行
- **审批权限**：仅管理员/owner 可点批准/拒绝（首个私聊你的用户自动记为 owner）；**群聊审批不记忆**（批准一次只放行这一次）
- **配置**：`/feishu config permissions.policy=strict` 热改，或编辑 `~/.pi/agent/feishu-link/config.json`

```text
┌─ tool_call（真实生效，含飞书审批卡）──────────────────────┐
│  白名单（read/grep/find/ls 等）──→ 直接放行               │
│  其他（bash 写删改/网络/文件…）──→ 默认放行 + 审计日志     │
│  黑名单（rm -rf / · curl|sh 等）──→ 飞书审批卡（⚠️ 危险）  │
│      ├─ 管理员批准 ──────────→ 执行（仅此一次；群聊不记忆）│
│      └─ 拒绝 / 5min 超时 ────→ 不执行 + 通知               │
└──────────────────────────────────────────────────────────┘
```

## 命令

### pi 终端

```text
/feishu setup       扫码创建应用（一键认证）
/feishu start       启动 daemon（常驻，TUI 关闭不断线）
/feishu stop        停止
/feishu restart     重启（热换代码/配置）
/feishu takeover    接管连接（本进程运行）
/feishu status      全链路健康视图
/feishu doctor      生成诊断包（含权限自检）
/feishu config key=value   热改配置（如 groupPolicy=mention、permissions.policy=strict）
```

### 飞书侧（白名单）

`/help`（命令面板卡） `/status` `/new` `/resume` `/model` `/thinking` `/stop` `/workspace /路径` `/compact` `/support` `/feishu-config`

阻塞命令：`/login /quit /reload /settings /fork /clone /tree /clear` 等（安全边界）。定时任务命令 `/loop /remind /schedule` 透传给 my-pi-scheduler。

## 项目结构

```
src/
├── index.ts                  # 扩展入口（薄接线层）
├── common/                   # 跨层基础：types · config · logger · status · dedupe-store · diagnostics
├── inbound/                  # L1 接入层：transport · connection-supervisor · attachment-pipeline
│                             #        · missed-compensation（断连补收）· permission-probe · group-trigger
├── outbound/                 # L3 可靠出站：outbox · live-channel · outbound-router · event-forwarder
├── sessions/                 # L2 编排层：conversation-manager · pi-session-backend · turn-supervisor
│                             #        · permission-bridge · notification-throttler · bridge-runtime
├── presentation/             # L4 呈现层：cards · rich-text
├── host/                     # L0 宿主层：gateway-lock · daemon-host · auth-setup
└── commands/                 # command-controller

test/
├── unit/                     # 镜像 src/ 结构（每层一组测试）
└── integration/              # kill-9 一致性 · 分航道隔离 · scheduler 闭环 · pi CLI 加载
```

分层纪律：L1 只懂飞书协议、L2 只懂 pi、L3 是两者间唯一可靠通道、L4 只做渲染；跨层调用只走显式接口（`InboundEvent` / `OutboundEnvelope`）。

## 可靠性设计

- **双通道**：流式 patch 走易失 LiveChannel（正确性永不依赖），final/notify 走持久 Outbox
- **无条件 finalize**：回合结束总以 `session.messages` 定稿卡片
- **分航道并行**：A 群投递受阻不阻塞 B 私聊
- **断连补偿**：WS 恢复后自动拉取断连期间漏收消息并补注入（可配置开关）
- **压缩清理**：7 天终态保留 + pending 永不淘汰 + 容量硬顶 + 磁盘护栏
- **后台常驻**：独立 daemon 进程持有网关（文件锁），TUI 退出桥接不断

## 测试

```bash
npm test        # 170 项单元+集成测试（node:test，零额外 dev 依赖）
npm run check   # tsc --noEmit
```

关键覆盖：`outbox` 崩溃恢复重放/幂等/分航道/压缩、`connection-supervisor` 静默即重建、`permission-bridge` 审批矩阵、`diagnostics` 脱敏管线、`missed-compensation` 断连补收、`daemon-host` 常驻生命周期、集成层 kill-9 恰好一次、真实 pi CLI 加载验证。

## 参考项目与致谢

本项目从零自研，架构与关键机制深度借鉴以下开源项目（MIT/Apache-2.0）：

| 项目 | 借鉴点 | 差异 |
| ---- | ------ | ---- |
| [AX1202/pi-feishu-lark](https://github.com/AX1202/pi-feishu-lark) | 扫码建应用（`lark.registerApp`）、群策略 open/mention、任务状态卡、/workspace、daemon 文件锁 | 无持久 Outbox（仅内存重试即丢）→ 本实现持久化可靠队列 |
| [yangtuooc/pi-feishu-lark](https://github.com/yangtuooc/pi-feishu-lark)（@xjuai fork） | CardKit 流式卡片、重试、配置热更新、引用消息展开、定时任务路由绑定思路 | 无连接活性监督 → 本实现 ConnectionSupervisor（静默即重建）+ 断连补收 |
| [@ineersa/my-pi-scheduler](https://github.com/ineersa/my-pi-scheduler) | 定时任务（`/loop cron`、`/remind`、`schedule_prompt` 工具）——**选定复用，不自造轮子** | 桥接层零侵入，结果经路由回投飞书 |
| [pi-agent-qqbot](https://github.com/gtiders/pi-agent-qqbot) | ReplyBudget、网关所有权、双端 UI 竞争 | QQ 官方 API 无免 @ 群消息 → 转向飞书 |

## 已知限制

1. 群 open（免 @）策略依赖「获取群组中所有消息」权限，扫码建应用后需在开发者后台确认；未开启时自动回退 mention 模式，`/support` 可自检
2. 出站媒体走 SDK `im.v1.image/file.create`，实机参数细节需沙箱验证
3. 语音入站明确不支持（飞书无官方 ASR），收到语音会提示改用文字/图片
4. 断连补收依赖「读取历史消息」权限，超出窗口（默认 5 分钟）的消息不保证
5. 发送超时（10s）不取消底层请求——极慢但最终成功的请求可能重复投递（at-least-once 容忍，恰好一次语义不受影响）
6. 黑名单是静态模式匹配：`rm -rf $ROOT` 这类变量间接命令无法静态识别（可配置 `allowUsers` 白名单作为公网部署的强隔离）
7. 配置了 `allowUsers` 时不会自动记录 owner——owner 需把自己加入白名单并手动设 `ownerOpenId`

## License

MIT

---

# English

> Unified social handle: **小斯syzs**
>
> Bilibili [@小斯syzs](https://space.bilibili.com/390211071) · Douyin · Xiaohongshu · Kuaishou (same handle **小斯syzs** on all platforms)
>
> 💬 Join the Feishu community group: **[Join now](https://applink.feishu.cn/client/chat/chatter/add_by_link?link_token=45al067b-19ea-4fa0-bba6-d550be5fe2ea)** (author's invite — feedback, usage Q&A, sandbox access)

## Features

| Capability | Description |
| ---------- | ----------- |
| 🎯 **One-click auth** | `/feishu setup` prints a QR code; scan it to auto-create the Feishu app and write credentials — live in 30 seconds |
| 🐇 **Zero command memory** | Welcome / command-palette / approval cards are all button-driven; no-mention group replies (open policy) |
| 💪 **Zero message loss** | Persistent Outbox (JSONL segments + at-least-once + idempotency keys + per-conversation lanes); auto-resume after a kill -9 — **exactly once** |
| 🛡 **Self-healing connection** | Event silence triggers an unconditional WS rebuild (fixes "no reply" zombie connections); auto-reconnect, **missed-message backfill**, proactive reporting |
| ⏱ **Turn supervision** | Stuck model runs are aborted with queue unlock + notification; long waits are surfaced |
| 🔓 **Open by default** | Every tool call is allowed by default (private & group, zero friction); destructive blacklist (`rm -rf /`, `curl\|sh` …) shows an **approval card** (⚠️ danger banner; admin approves to run; 5min timeout = auto-deny); `strict` mode opts back into full gating |
| 🩺 **One-click diagnostics** | `/support` (or the status-card button) sends the sanitized diagnostic bundle **as a file back to the chat** (secrets masked, ids hashed, content excluded by default) with a prefilled ISSUE.md + repro trace + permission self-check |
| ⏰ **Scheduled tasks** | Say "summarize commits at 9am daily" — results are delivered back to this chat |
| 📎 **Multimedia** | Inbound images → vision model, files → bounded text extraction, voice → unsupported hint; outbound images/files via `feishu_send_local_file` |

## Quickstart

```bash
pi install git:github.com/amlyczz/pi-feishu-link   # or clone then: cd pi-feishu-link && pi install .
pi                                 # start pi
/feishu setup                      # scan the QR in your terminal
/feishu start                      # start the daemon (survives TUI exit)
```

Then open Feishu, search for your bot, and send any message — a welcome card confirms end-to-end connectivity.

> No-mention group replies need the **"read all group messages"** scope in the Feishu developer console. Without it, group chats fall back to mention-triggered mode; `/support` self-checks and tells you.

## Permissions

**Everything is allowed by default — only destructive commands show an approval card** (zero friction):

- **Default (relaxed)**: every tool call passes through — private AND group chats alike, no cards, no interruptions
- **Blacklist → approval card**: destructive commands (`rm -rf /` incl. `rm -r -f`, `--recursive --force`, `/*` variants; download-and-execute `curl/wget … | sh/python/node`; `cat/echo … | sh`; `dd of=/dev/sdX`; `chmod 777 /`) are **no longer hard-blocked** — they show a Feishu approval card with a ⚠️ danger banner: an admin taps [Approve] to run it; no approval within 5 min → auto-denied
- **Strict mode**: `/feishu config permissions.policy=strict` switches back to strict gating — every non-allowlisted tool shows an approval card
- **Allowlist**: safe tools (`read/grep/find/ls`) never prompt
- **Approval authority**: only the owner/admin can approve/deny (the first user to DM the bot is auto-recorded as owner); **group approvals are NOT session-memorized** (one approved call releases only that call)
- **Config**: `/feishu config permissions.policy=strict` or edit `~/.pi/agent/feishu-link/config.json`

```text
┌─ tool_call (live, incl. Feishu approval cards) ─────────┐
│  allowlist (read/grep/find/ls …) ─→ allow               │
│  everything else (bash/network/… ) → allow + audit      │
│  blacklist (rm -rf / · curl|sh …) ─→ approval card (⚠️) │
│     ├─ admin approves ────────→ run (once; not memorized in groups) │
│     └─ denied / 5min timeout ─→ skip + notify           │
└─────────────────────────────────────────────────────────┘
```

## Commands

### pi terminal

```text
/feishu setup  /feishu start  /feishu stop  /feishu restart
/feishu takeover  /feishu status  /feishu doctor  /feishu config key=value
```

### Feishu side (allowlist)

`/help` `/status` `/new` `/resume` `/model` `/thinking` `/stop` `/workspace /path` `/compact` `/support` `/feishu-config`

Blocked: `/login /quit /reload /settings /fork /clone /tree /clear` (security boundary). `/loop /remind /schedule` pass through to my-pi-scheduler.

## Project Layout

```
src/
├── index.ts                  # thin extension entry
├── common/                   # types · config · logger · status · dedupe-store · diagnostics
├── inbound/                  # L1: transport · connection-supervisor · attachment-pipeline
│                             #     · missed-compensation · permission-probe · group-trigger
├── outbound/                 # L3: outbox · live-channel · outbound-router · event-forwarder
├── sessions/                 # L2: conversation-manager · pi-session-backend · turn-supervisor
│                             #     · permission-bridge · notification-throttler · bridge-runtime
├── presentation/             # L4: cards · rich-text
├── host/                     # L0: gateway-lock · daemon-host · auth-setup
└── commands/                 # command-controller

test/
├── unit/                     # mirrors src/ per layer
└── integration/              # kill-9 consistency · lane isolation · scheduler loop · pi CLI load
```

Layering: L1 speaks Feishu only, L2 speaks pi only, L3 is the sole reliable channel between them, L4 renders. Cross-layer calls go through explicit interfaces (`InboundEvent` / `OutboundEnvelope`).

## Reliability

- **Dual channel**: volatile LiveChannel for streaming patches (correctness never depends on it); durable Outbox for final/notify
- **Unconditional finalize**: every turn ends by settling the card from `session.messages`
- **Per-lane parallelism**: one chat's delivery stall never blocks another
- **Missed-message backfill**: after WS recovery, recent messages are listed and unseen ones re-injected (configurable)
- **Compaction**: 7-day terminal retention, pending never evicted, capacity caps + disk guard
- **Daemon**: a detached process owns the gateway via file lock — bridge survives TUI exit

## Tests

```bash
npm test        # 170 unit+integration tests (node:test, zero extra dev deps)
npm run check   # tsc --noEmit
```

Key coverage: outbox crash-replay/idempotency/lanes/compaction, connection-supervisor silence-rebuild, permission-bridge matrix, diagnostics sanitization, missed-compensation backfill, daemon lifecycle, integration kill-9 exactly-once, real pi CLI load.

## Credits

Built from scratch, deeply informed by these open-source projects (MIT/Apache-2.0):

| Project | Borrowed | Difference |
| ------- | -------- | ---------- |
| [AX1202/pi-feishu-lark](https://github.com/AX1202/pi-feishu-lark) | QR app creation, group policies, task-status card, /workspace, daemon file lock | no persistent outbox (in-memory retry only) → durable reliable queue here |
| [yangtuooc/pi-feishu-lark](https://github.com/yangtuooc/pi-feishu-lark) (@xjuai fork) | CardKit streaming, retries, hot config, quoted-message expansion, scheduler routing | no connection liveness supervision → ConnectionSupervisor + missed-message backfill |
| [@ineersa/my-pi-scheduler](https://github.com/ineersa/my-pi-scheduler) | scheduled tasks (`/loop cron`, `/remind`, `schedule_prompt` tool) — **reused, not reinvented** | zero-touch bridge; results routed back to Feishu |
| [pi-agent-qqbot](https://github.com/gtiders/pi-agent-qqbot) | ReplyBudget, gateway ownership, dual-UI race | QQ official API lacks no-mention group messages → moved to Feishu |

## Known Limitations

1. The no-mention group policy needs the "read all group messages" scope; verify in the developer console after scanning. Without it, group chats fall back to mention mode; `/support` self-checks.
2. Outbound media goes through SDK `im.v1.image/file.create`; real-sandbox parameter details need verification.
3. Voice inbound is intentionally unsupported (Feishu has no official ASR); users are told to use text/images.
4. Backfill depends on the "read chat history" scope and only covers the window (default 5 minutes).
5. A send timeout (10s) does not abort the underlying request — a very slow but eventually-successful request may deliver twice (at-least-once tolerant; exactly-once semantics unaffected).
6. The blacklist is static pattern matching: variable-indirection commands like `rm -rf $ROOT` cannot be detected statically (configure `allowUsers` as strong isolation for public deployments).
7. With `allowUsers` set, the owner is NOT auto-recorded — add yourself to the allowlist and set `ownerOpenId` manually.

## License

MIT
