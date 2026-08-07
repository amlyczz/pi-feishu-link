# Changelog

## 0.1.5 (2026-08-07)

### 实机验证修复：应用未订阅 im.message.receive_v1 → 消息事件永远收不到（用户报告）

- **根因**（spec 开放问题 #1 实机验证）：`registerApp` 扫码创建的应用默认只订阅 `card.action.trigger`，**不会订阅 `im.message.receive_v1`**（消息事件）——WS 长连接连得上（websocket 模式开着）、卡片能用，但**任何连接都收不到消息事件**
- 证据：`application/v6/applications/{id}` 返回 `callback_info.subscribed_callbacks = ["card.action.trigger"]`
- **修复**：setup 时给 `registerApp` 传 `addons`（`events.items.tenant: [im.message.receive_v1]` + 权限 scopes + 卡片回调）；新增 `buildSetupAddons()` 纯函数
- **自检兜底**：setup 完成后自动调 `checkEventSubscription()` 确认订阅状态，缺失则打印开发者后台直达链接（`open.feishu.cn/app/{id}/event`）——这类故障从此可自查
- **存量应用**（已用旧流程创建）：需在开发者后台手动补订阅，或重新 `/feishu setup`（新应用自动带订阅）

**测试**：212 → **216 项全绿**（addons 形状 1 + 订阅自检 3）。

## 0.1.4 (2026-08-07)

### 卸载自动停 daemon（用户报告：卸载后旧 daemon 仍占连接）

- **背景**：pi 无卸载钩子（ExtensionAPI 无 package_removed 事件），`pi remove` 不会执行任何扩展清理代码；detached daemon 因此会活过卸载，继续持有网关锁和飞书连接（重装后误报"连接由其他进程持有"）
- **修复**：daemon 启动后**自监控注册状态**（`startUninstallWatch`）——
  - 扩展入口文件被删（npm/git 卸载删文件）→ 退出
  - settings.json（用户级 `~/.pi/agent/settings.json` + 项目级 `.pi/settings.json`）中已无本扩展 → 退出
  - 退出前释放网关锁（`stopBridge`），下次安装/启动即干净状态
  - 无任何设置文件时保守存活（兼容 `pi -e` 直跑）
- 纯函数 `extensionStillRegistered` / `checkUninstallCondition` 可单测

**测试**：207 → **210 项全绿**（卸载自监控 3 项）。

## 0.1.3 (2026-08-07)

### 修复：`/feishu start` 误报"启动超时/被占用"（用户报告）

- **根因**：daemon 以 `tail -f /dev/null | exec pi …` 启动，pi 进程 pid ≠ bash 包装进程 pid，`spawnDaemon` 的 `registered.pid === child.pid` 判断**永远为 false** → daemon 明明连接成功（daemon.log `ws client ready`）却总是返回 busy
- **修复**：等待循环改为「检测到**新的存活 owner** 即视为启动成功」（记录 spawn 前的 owner，排除旧 owner 未让位的情况）；返回的 pid 改为真实 daemon pid
- `/feishu start` 消息区分：被占用（提示 `/feishu takeover`）vs 超时（提示看日志）

### UX：`/feishu setup` 阶段进度 + 回调提示（用户报告）

- 阶段打印：🚀 创建应用 → 📱 扫码提示 → ⏳ 等待授权（自动检测）→ ✅ **收到回调** → 💾 凭据已保存
- 回调到达时**同时弹系统通知**（`ctx.ui.notify`）——不再"扫了码不知道发生什么"
- 轮询被限速（slow_down）、Lark 国际版切换也有提示
- `runSetup` 新增 `onStage` 回调（creating/callback/saved）供 TUI 展示进度

**测试**：201 → **207 项全绿**（新增 spawnDaemon 真实注册验证 + auth-setup 阶段/错误分支 5 项）。

## 0.1.2 (2026-08-07)

### 表情回执策略（用户指令，2026-08-07）

- **入站随机表情**：收到用户消息后从随机池取一枚表情打回执（"已收到"即时反馈）
- **DONE 专属任务完成**：DONE 表情只在回合/任务完成时对触发消息打出；**DONE 永不参与随机池**
- 配置：`forward.reactions = { enabled, emojis: string[], doneEmoji: string }`
  - `emojis` 默认 11 枚飞书 emoji_type（THUMBSUP/OK/HEART/LAUGH/SMILE/WOW/CLAP/FIRE/AMAZE/AWESOME/COOL），可热改
  - `doneEmoji` 默认 `DONE`（✅），旧配置 `emoji` 字段兼容（忽略，行为按新策略）
- 两处均为 best-effort（失败静默，不阻塞回复投递）

### 僵尸 daemon 修复（用户报告，2026-08-07）

- `/feishu takeover` / `stop` / `restart` 现在 **SIGTERM → 1.2s 后 SIGKILL** 逐级升级，确保忽略 SIGTERM 的挂死 daemon 被强制清理，避免双 WS 连接互踢（"发消息没动静"的常见根源）
- 新增 `killGatewayOwner`（升级式终止 + 清锁），`spawnDaemon` takeover 分支复用

**测试**：200 → **201 项全绿**（新增表情策略 7 项 + SIGKILL 升级 1 项；修复 macOS `/var`→`/private/var` 符号链接导致的 switchWorkspace 测试断言）。

## 0.1.1 (2026-08-07)

### 权限模型变更 v1.3（用户指令，2026-08-07）

- **默认全部放行**：除破坏性黑名单外，一切工具调用直接放行（私聊/群聊一致，零打扰）
- **黑名单从硬拦截改为审批卡**：`rm -rf /`、`curl|sh` 等破坏性命令不再永远拦截，而是弹飞书审批卡（⚠️ 危险横幅）——管理员批准才执行，5min 超时自动拒绝
- **strict 模式**：`permissions.policy=strict` 切回严格管控（非白名单工具也弹审批卡）
- 保留：审批仅管理员/owner 有效（A2）、审批卡只发请求者会话（A1）、群聊审批不记忆（A3）、dispose 后 gate 仍生效（A4）

**测试**：193 → **191 项全绿**（按新模型重写权限/审批测试：默认放行、黑名单→ask、strict→ask、dangerous 标记、群聊不记忆）。

### 对抗性审查修复（同轮追加）

对 0.1.1 修复的攻破尝试（33 个黑名单攻击样本 + 权限/接线攻击面）→ 新发现并修复 5 项 + 记录 3 项：

- **审批卡广播（严重）**：审批卡此前发给**所有**会话 → 任何会话都能审批另一会话的挂起工具调用。修复：审批卡只发请求者所在会话
- **群聊自审批（重要）**：任何群成员都可点审批卡自批 → 防滥用门禁形同虚设。修复：**仅管理员/owner 可 approve/deny**
- **群聊 session-memory 放行（重要）**：群聊批准一次即对整个群会话放行该工具 → 恶意成员借 owner 一次批准滥用。修复：**群聊审批不记忆**
- **超时/停止后绕过权限桥（重要）**：会话 dispose 后 `keyForSessionId` 返回 undefined → 被中止回合的迟到工具调用绕过 gate。修复：persistent sessionId→key 映射（探针验证 dispose 后 gate 仍生效）
- **黑名单绕过（重要）**：`curl|python`、`cat|sh`、`echo|sh`、`wget|node` 未拦截 → 双模式管道黑名单（下载即执行 / 内容即执行）。33 样本拦截 24，其余漏网均不可利用或不可静态判定（`rm -rf $ROOT` 变量根等）
- **union_id 脱敏（次要）**：`on_` 前缀 id 此前未哈希 → 已加入
- **记录（文档化）**：owner 自动记录竞态（`allowUsers` 配置时不再自动记录）；发送超时不取消底层请求（极端慢请求可能重复投递，at-least-once 容忍）；`feishu_send_local_file` 加入默认白名单（桥内部工具不打扰）

**测试**：192 → **193 项全绿**（新增群聊 session-memory 不生效、下载即执行/内容即执行黑名单矩阵等）。

### Critical 修复（接线缺陷，README 头条特性此前为死代码）

- **权限桥真实接线（C1）**：注册 `tool_call` 事件 → `createToolCallHandler`（`src/sessions/tool-call-gate.ts`），安全工具放行、黑名单立即拦截、其余挂起等待飞书审批卡（批准/拒绝/超时自动拒绝）；新增单元测试覆盖全部分支
- **断连补收修复（C2）**：`compensate()` 补收消息此前被 dedupe 二次 admit 丢弃（静默失效）→ 注入走 `skipDedupe` 旁路，窗口内消息真正补处理
- **定时任务接线修复（C3）**：`message_end` 此前传 `sessionKey=undefined` + `beginFeishuInput` 零调用 → 改为 ConversationManager 反查 sessionId→key，prompt 前后标记 feishu input；`schedule_prompt` 绑定/结果回投链路打通

### Important 修复

- **I1 队列毒化**：prompt 失败后队列尾部为 rejected promise → 修复为 `.catch` 兜底 + 丢弃坏 handle（下次重建会话、历史保留）
- **I2 /support 发文件**：诊断包 tar.gz 作为媒体文件直接发回飞书会话（≤20MB 校验）
- **I3/I4 卡片按钮**：补 resume/thinking/compact/feishu-config 处理器；「停止」按钮真实中止回合；卡片 key 经 routes 按 chatId 解析（此前为假 key）
- **I5 进度可见性**：onAck/onQueueWarn 接线 + markQueued 触发 + `tool_execution_start/end` → 工具摘要行
- **I6 附件下载无界**：下载流式计数、超限即中止（此前先整包下载再拒绝）
- **I7 发错会话**：`feishu_send_local_file` 经 toolCallId→会话路由发到当前会话
- **I8 群聊权限语义**：群聊非白名单工具一律审批（与私聊策略无关）；移除无效的 `permissions.groupPolicy` 配置项
- **I9 owner 自动记录**：首个私聊用户自动记为 owner（默认 admin）；`ownerOpenId` 进配置并在诊断包中脱敏
- **I10 流式卡竞态**：finalize 前 `LiveChannel.finalize()` 冲刷并关闭该卡，定稿不被残余 delta 覆盖
- **I11 黑名单绕过**：`dangerousRm` 覆盖 `rm -r -f` / `--recursive --force` / `/*` / JSON 包裹变体；`curl … | sh` 管道模式修正

### Moderate/Minor

- M1 Outbox 目录护栏改为真实淘汰至预算内（此前每轮只淘汰 ~pending 数）；M2 transport 全出站超时（10s/60s/120s）；M3 飞书业务错误码（HTTP 200+code≠0）正确分类 retryable/fatal；M4 streamCards TTL 清理；M5 evictIdle 拒绝泄漏；M6 busy 标记竞态守卫；M7 移除死 QR 钩子；M8 移除死分支；M9 任务路由 90d TTL

**测试**：170 → **192 项全绿**（新增 tool-call-gate、审批 verdict、黑名单矩阵、队列恢复、补收 skipDedupe、dir 护栏、jobs TTL、业务错误码、owner 配置等用例）；`tsc --noEmit` 干净。

> 对抗性审查后：**193 项全绿**（见上方「对抗性审查修复」）。

### 行为变更（破坏性）

- `permissions.groupPolicy` 配置项移除（群聊行为不变：一律审批）
- 新配置项 `ownerOpenId`（可选，首个私聊用户自动写入）

## 0.1.0 (2026-08-06)

首个里程碑版（按 spec v1.1 实现，TDD 驱动）。

- **R1 消息零丢失**：持久化 Outbox（JSONL 段文件、at-least-once + 幂等键、分航道并行、退避重试、崩溃恢复、压缩清理、容量护栏、blob 溢出）
- **R2 连接自愈**：ConnectionSupervisor（事件静默即无条件重建 WS、probe 诊断、指数退避不限次、恢复通知）
- **R3 回合监督**：TurnSupervisor（超时中止 + 队列解锁 + 排队提醒）
- **认证最简**：`/feishu setup` 扫码创建应用（lark.registerApp）+ 手动兜底
- **命令体系**：pi 终端 `/feishu *` + 飞书侧白名单命令 + 命令面板/欢迎/审批/状态卡片
- **群聊策略**：open（免 @）/ mention / 关键词 / 回复触发（纯函数 + 测试矩阵）
- **权限桥**：三级分流（放行/审批卡/黑名单），群聊强制严格，审批超时自动拒绝
- **配置化转发**：AI 回复 / 流式 / 工具调用 / 进度 / 表情回执全可开关热改
- **告警合并**：NotificationThrottler 同类 10min 合并 + critical 直达
- **一键诊断**：`/support` 生成脱敏诊断包（manifest/doctor/events/outbox-summary/repro-trace/ISSUE.md/格式说明）
- **定时任务路由**：BridgeRuntime 捕获 my-pi-scheduler marker → 绑定路由 → Outbox 可靠投递
- **多媒体入站/出站（M4/M7）**：图片→视觉模型、文件→文本提取、语音→不支持提示；`feishu_send_local_file` 上传图片/文件到飞书
- **会话隔离**：per-conversation AgentSession + workspace 绑定 + 懒加载/空闲回收/常驻上限
- **状态可观测**：status.json 单一真相源（TUI + 飞书同源）、结构化 JSONL 日志轮转
- 152 项单元/集成测试全绿（node:test，零额外 dev 依赖）

> 注：后续实测为 **170 项测试全绿**（新增断连补收、权限探测、daemon 生命周期、传输 M7 媒体等用例）。

### 已知限制（见 spec §12 开放问题）

- 群 open 策略依赖"获取群组中所有消息"权限（扫码建应用后需实机验证）
- 出站媒体走 SDK `im.v1.image/file.create`，实机参数细节（FormData 形状）需沙箱验证
- 语音入站明确不支持（飞书无官方 ASR）
- 断连窗口内入站消息无法补偿（恢复通知提示"可能漏收"）
