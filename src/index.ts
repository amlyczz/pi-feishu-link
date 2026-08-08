// pi-feishu-link extension entry. Wires every layer per spec §4:
// L0 daemon/lock, L1 transport + supervisor + inbound pipeline,
// L2 conversation/turn/permission/forwarder/bridge/throttler,
// L3 live channel + outbox + router, L4 cards.
//
// Recursion guard: isolated child sessions set CHILD_SESSION_ENV so this
// extension registers nothing inside them.

import type {
	ExtensionAPI,
	ExtensionCommandContext,
	ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { fileURLToPath } from "node:url";
import { execFileSync } from "node:child_process";
import { basename, join } from "node:path";
import {
	CHILD_SESSION_ENV,
	DEFAULT_CONFIG,
	ensureRoot,
	isConfigured,
	loadConfig,
	loadOverrides,
	mask,
	rootDir,
	saveConfig,
	saveOverrides,
} from "./common/config.js";
import { Logger } from "./common/logger.js";
import { connectionStatusText } from "./common/connection-status.js";
import { pickRandomReaction } from "./common/reactions.js";
import { StatusStore } from "./common/status.js";
import { detectSchedulerInstalled } from "./common/scheduler-detect.js";
import { QuotaGovernor } from "./common/quota-governor.js";
import { DedupeStore } from "./common/dedupe-store.js";
import { OutboundRouter } from "./outbound/outbound-router.js";
import { Outbox, FatalDeliveryError } from "./outbound/outbox.js";
import { LiveChannel } from "./outbound/live-channel.js";
import { EventForwarder } from "./outbound/event-forwarder.js";
import { PermissionBridge } from "./sessions/permission-bridge.js";
import { createToolCallHandler } from "./sessions/tool-call-gate.js";
import { TurnSupervisor } from "./sessions/turn-supervisor.js";
import {
	spawnDaemon,
	stopDaemon,
	startUninstallWatch,
	cleanupStateDirIfUninstalled,
	extensionStillRegistered,
	defaultSettingsFiles,
	killDaemonTail,
	DAEMON_ENV,
} from "./host/daemon-host.js";
import { ConversationManager } from "./sessions/conversation-manager.js";
import { PiSessionBackend } from "./sessions/pi-session-backend.js";
import { BridgeRuntime } from "./sessions/bridge-runtime.js";
import { ConnectionSupervisor } from "./inbound/connection-supervisor.js";
import {
	type FeishuTransport,
	createFeishuTransport,
	wrapSendError,
	normalizeInbound,
} from "./inbound/transport.js";
import { MissedMessageCompensation } from "./inbound/missed-compensation.js";
import { probeGroupMessagePermission } from "./inbound/permission-probe.js";
import {
	acquireGatewayLock,
	readGatewayOwner,
	type GatewayLockHandle,
} from "./host/gateway-lock.js";
import { parseCommand } from "./commands/command-controller.js";
import {
	isPiCommand,
	runPiCommand,
	tryConsumeSelect,
	getPendingSelect,
	type PiCommandDeps,
} from "./commands/pi-command-adapter.js";
import {
	shouldAcceptGroupMessage,
	extractPlainTextForTrigger,
	parseGroupKeywords,
} from "./inbound/group-trigger.js";
import {
	isVoiceMessage,
	processAttachments,
} from "./inbound/attachment-pipeline.js";
import {
	buildHelpCard,
	buildApprovalCard,
	buildStatusCard,
	buildSimpleTextCard,
	buildWelcomeCard,
} from "./presentation/cards.js";
import {
	chooseMessageMode,
	buildMarkdownCard,
	splitText,
} from "./presentation/rich-text.js";
import {
	runSetup,
	buildSetupAddons,
	checkEventSubscription,
} from "./host/auth-setup.js";
import {
	buildDiagnostics,
	runDoctorChecks,
	type DiagnosticsInput,
} from "./common/diagnostics.js";
import type {
	FeishuInboundMessage,
	OutboundEnvelope,
	Route,
	RouteRef,
} from "./common/types.js";

export default function feishuBridgeExtension(pi: ExtensionAPI) {
	if (process.env[CHILD_SESSION_ENV] === "1") {
		return;
	}

	ensureRoot();
	const logger = new Logger(rootDir() + "/logs", {
		level: loadConfig()?.logging.level ?? "info",
	});
	const statusStore = new StatusStore(rootDir() + "/status.json");
	const dedupe = new DedupeStore(rootDir() + "/dedupe.jsonl");
	const router = new OutboundRouter(rootDir() + "/routes.json");
	const stateFile = rootDir() + "/state.json";

	let transport: FeishuTransport | undefined;
	let supervisor: ConnectionSupervisor | undefined;
	const quotaGovernor = new QuotaGovernor({ dir: rootDir() });
	let outbox: Outbox | undefined;
	let liveChannel: LiveChannel | undefined;
	let conversations: ConversationManager | undefined;
	// 2026-08-08：backend 引用（/login API key 通道 + 命令适配）。
	let piBackend: PiSessionBackend | undefined;
	let turnSupervisor: TurnSupervisor | undefined;
	let bridgeRuntime: BridgeRuntime | undefined;
	let permissionBridge: PermissionBridge | undefined;
	let eventForwarder: EventForwarder | undefined;
	let compensation: MissedMessageCompensation | undefined;
	let gatewayLock: GatewayLockHandle | undefined;
	let stopUninstallWatch: (() => void) | undefined;

	// TUI 状态行（2026-08-07）：session_start 只设置一次，setup/start 等命令
	// 成功后须刷新。session_start 把 ui.setStatus 捕获进 sink，命令侧调用
	// refreshConnectionStatus() 重算文本。
	let connectionStatusSink: ((text: string) => void) | undefined;
	const setConnectionStatus = (text: string): void => {
		try {
			connectionStatusSink?.(text);
		} catch {
			/* ignore */
		}
	};
	async function refreshConnectionStatus(): Promise<void> {
		setConnectionStatus(
			connectionStatusText(
				loadConfig(),
				readGatewayOwner(rootDir()),
				process.pid,
			),
		);
	}
	let botOpenId: string | undefined;
	let started = false;

	// Streaming cards: cardId → feishu message id + accumulated text (M4 TTL).
	const streamCards = new Map<
		string,
		{ messageId: string; text: string; touchedAt: number }
	>();
	// 2026-08-08 流式修复（spec §3.1 B1）：cardId → 回复目标（真实 messageId/chatId）。
	const streamTargets = new Map<
		string,
		{ messageId?: string; chatId: string }
	>();
	// C1/I7: toolCallId → conversation key (stashed by the tool_call gate so
	// feishu_send_local_file can target the CURRENT chat, not an arbitrary one).
	const toolCallSessionKeys = new Map<string, { key: string; at: number }>();

	// ---------------- outbox sender (L3 → L1) ----------------

	async function outboxSender(
		env: OutboundEnvelope,
	): Promise<{ messageId?: string }> {
		if (!transport) throw new Error("transport not started");
		const t = transport;
		const route = env.route;
		const targetMessageId = route.threadMessageId ?? route.lastMessageId;
		try {
			const payload = env.payload;
			let messageId: string | undefined;
			if (payload.type === "card") {
				messageId = targetMessageId
					? await t.replyCard(targetMessageId, payload.card)
					: await t.sendCard(route.chatId, payload.card);
			} else if (payload.type === "text") {
				const text = payload.text;
				const mode = chooseMessageMode(text);
				if (mode === "interactive" && payload.cardId) {
					// finalize: patch the existing streaming card with the final text
					const stream = streamCards.get(payload.cardId);
					if (stream) {
						await t.updateCard(stream.messageId, buildMarkdownCard(text));
						messageId = stream.messageId;
					} else {
						messageId = targetMessageId
							? await t.replyCard(targetMessageId, buildMarkdownCard(text))
							: await t.sendCard(route.chatId, buildMarkdownCard(text));
					}
				} else {
					for (const chunk of splitText(text)) {
						messageId = targetMessageId
							? await t.replyText(targetMessageId, chunk)
							: await t.sendText(route.chatId, chunk);
					}
				}
			} else if (payload.type === "media") {
				// M7 outbound media: upload then send by key.
				if (payload.fileType === 1) {
					const key = await t.uploadImage(payload.fileData);
					messageId = await t.sendImage(route.chatId, key);
				} else {
					const key = await t.uploadFile(
						payload.fileName ?? "attachment",
						payload.fileData,
					);
					messageId = await t.sendFile(route.chatId, key);
				}
			}
			statusStore.recordOutbound();
			return { messageId };
		} catch (err) {
			throw wrapSendError(err);
		}
	}

	// ---------------- commands ----------------

	function isAdminUser(userOpenId: string): boolean {
		const cfg = loadConfig();
		if (!cfg) return false;
		// I9: the auto-recorded owner is an admin by default (zero-config UX).
		if (cfg.ownerOpenId && cfg.ownerOpenId === userOpenId) return true;
		return Boolean(cfg.admins.includes(userOpenId));
	}

	/**
	 * I9: first p2p sender becomes the bridge owner (persisted).
	 * B-fix (adversarial): never auto-record an owner when the user has
	 * configured an explicit allowUsers whitelist — in that case ownership is
	 * declared, not discovered, so an early caller cannot claim admin.
	 */
	function recordOwnerIfUnset(userOpenId: string, chatType: string): void {
		if (chatType !== "p2p") return;
		const cfg = loadConfig();
		if (!cfg || cfg.ownerOpenId) return;
		if (cfg.allowUsers.length > 0) return;
		cfg.ownerOpenId = userOpenId;
		try {
			saveConfig(cfg);
			logger.info("feishu.owner.recorded", {});
		} catch {
			/* best-effort */
		}
	}

	async function replyTo(
		msg: FeishuInboundMessage,
		textOrCard: string | unknown,
	): Promise<void> {
		if (!outbox) return;
		const route = router.getRoute(conversationKeyFor(msg));
		const routeRef: RouteRef = route
			? {
					conversationKey: route.sessionKey,
					chatId: route.chatId,
					chatType: route.chatType,
					threadMessageId: route.threadMessageId,
					lastMessageId: route.lastMessageId,
				}
			: {
					conversationKey: conversationKeyFor(msg),
					chatId: msg.chatId,
					chatType: msg.chatType,
					threadMessageId: msg.messageId,
				};
		const payload =
			typeof textOrCard === "string"
				? { type: "text" as const, text: textOrCard }
				: { type: "card" as const, card: textOrCard };
		try {
			await outbox.enqueue({
				dedupeKey: `cmd:${msg.messageId}:${Date.now()}`,
				laneKey: routeRef.conversationKey,
				route: routeRef,
				kind: "command-reply",
				payload,
			});
		} catch {
			// outbox full — drop; user can retry
		}
	}

	function conversationKeyFor(msg: FeishuInboundMessage): string {
		if (msg.chatType === "p2p") return `p2p:${msg.senderOpenId}`;
		if (msg.chatMode === "topic")
			return `topic:${msg.chatId}:${msg.threadId ?? msg.messageId}`;
		return `group:${msg.chatId}`;
	}

	/**
	 * 命令执行完成 → 对触发消息打 DONE 表情（2026-08-08 用户指令：
	 * /workspace /new 等命令完成后与普通文本消息一样有 DONE 回执）。
	 * best-effort：失败静默忽略，不阻塞命令回复。
	 */
	function markDone(msg: FeishuInboundMessage): void {
		const cfg = loadConfig();
		if (!cfg?.forward.reactions.enabled) return;
		void transport?.addReaction(
			msg.messageId,
			cfg.forward.reactions.doneEmoji || "DONE",
		);
	}

	async function handleCommand(
		msg: FeishuInboundMessage,
		cmd: { name: string; rawArgs: string; args: string[] },
		rawText: string,
	): Promise<void> {
		const key = conversationKeyFor(msg);
		const name = cmd.name;
		// 1) 桥特有命令（status/workspace/support/doctor/feishu-config/stop/help）
		if (
			[
				"help",
				"status",
				"stop",
				"workspace",
				"support",
				"doctor",
				"feishu-config",
			].includes(name)
		) {
			switch (name) {
				case "help":
					await replyTo(msg, buildHelpCard());
					break;
				case "status":
					await replyTo(
						msg,
						buildStatusCard(formatStatusLine(), statusDetailLines()),
					);
					break;
				case "stop":
					await conversations?.disposeActiveFor(key);
					await replyTo(msg, "已停止当前任务。");
					break;
				case "workspace":
					try {
						const ws = await conversations?.switchWorkspace(key, cmd.args[0]);
						await replyTo(msg, `当前工作区：${ws ?? "未切换"}`);
					} catch (err) {
						await replyTo(
							msg,
							`工作区切换失败：${err instanceof Error ? err.message : String(err)}`,
						);
					}
					break;
				case "support":
				case "doctor": {
					await exportDiagnostics(msg);
					break;
				}
				case "feishu-config":
					await replyTo(
						msg,
						buildSimpleTextCard(
							"配置：发送 /feishu-config <key>=<value> 热改（如 groupPolicy=mention）。",
						),
					);
					break;
			}
			markDone(msg);
			return;
		}
		// 2) pi 内置命令 → CommandAdapter（spec 2026-08-08-1400 §3.3）
		if (isPiCommand(name)) {
			const piAdapterDeps: PiCommandDeps = {
				getHandle: (k) =>
					conversations?.getHandle(k) ?? Promise.resolve(undefined),
				listModels: () => conversations?.listModels() ?? Promise.resolve([]),
				listSessions: () =>
					conversations?.listSessions("all") ?? Promise.resolve([]),
				newConversation: (k) =>
					conversations?.newConversation(k) ?? Promise.resolve(),
				switchSession: (k, p) =>
					conversations?.switchSession(k, p) ?? Promise.resolve(),
				setProviderApiKey: (provider, apiKey) =>
					piBackend?.setProviderApiKey(provider, apiKey) ??
					Promise.resolve(false),
			};
			const res = await runPiCommand(piAdapterDeps, {
				key,
				command: name,
				args: cmd.args,
				rawText,
			});
			if (res.kind === "handled") {
				await replyTo(msg, buildSimpleTextCard(res.text));
				markDone(msg);
			} else {
				// 适配器不处理（理论不会发生，防御）→ 原样转发
				await handleConversationMessage(msg, rawText);
			}
			return;
		}
		// 3) scheduler（可选依赖，FR-11）
		if (["loop", "remind", "schedule", "unschedule"].includes(name)) {
			if (!detectSchedulerInstalled()) {
				await replyTo(
					msg,
					buildSimpleTextCard(
						"⏰ 定时任务功能需要安装 my-pi-scheduler（可选依赖，不影响其他功能）。\n\n在 pi 终端运行：\n  pi install npm:@ineersa/my-pi-scheduler\n\n重启 pi 后即可使用 /loop、/remind、/schedule 或在聊天里直接说「每天 9 点总结 commit」。",
					),
				);
				return;
			}
			await handleConversationMessage(
				msg,
				`/${cmd.name} ${cmd.rawArgs}`.trim(),
			);
			return;
		}
		// 4) 其他（插件命令/skill/模板/未知）→ 原样交 prompt（pi 原生执行，spec §3.2.1）
		await handleConversationMessage(msg, rawText);
	}

	// ---------------- inbound pipeline ----------------

	async function handleInbound(
		msg: FeishuInboundMessage,
		opts: { skipDedupe?: boolean } = {},
	): Promise<void> {
		supervisor?.recordEvent();
		// C2: compensation re-injects already-admitted messages — it pre-checks
		// the dedupe store itself, so it must bypass this re-check or every
		// backfilled message would be dropped as "already seen".
		if (!opts.skipDedupe && !dedupe.admit(msg.messageId)) return;
		if (msg.senderType === "bot") return;
		// 真实入站计数（2026-08-07）：此前 recordInbound 从未被调用，
		// inboundCount 恒为 0，诊断误导（"零事件"误判）。
		statusStore.recordInbound();
		const cfg = loadConfig();
		if (!cfg) return;
		if (cfg.allowUsers.length > 0 && !cfg.allowUsers.includes(msg.senderOpenId))
			return;
		if (cfg.allowChats.length > 0 && !cfg.allowChats.includes(msg.chatId))
			return;
		// I9: auto-record the first p2p sender as owner (admin by default).
		recordOwnerIfUnset(msg.senderOpenId, msg.chatType);
		const key = conversationKeyFor(msg);
		// M2/§9.1: welcome card on the first message of a brand-new chat.
		const isNewChat = !router.getRoute(key);
		if (isNewChat && msg.chatType === "p2p") {
			const routeRef: RouteRef = {
				conversationKey: key,
				chatId: msg.chatId,
				chatType: msg.chatType,
				threadMessageId: msg.messageId,
			};
			void outbox
				?.enqueue({
					dedupeKey: `welcome:${key}`,
					laneKey: key,
					route: routeRef,
					kind: "notify",
					payload: {
						type: "card",
						card: buildWelcomeCard("飞书桥"),
					},
				})
				.catch(() => undefined);
		}

		if (msg.chatType === "group") {
			const text = extractPlainTextForTrigger(msg.msgType, msg.content);
			const decision = shouldAcceptGroupMessage({
				chatType: "group",
				groupPolicy: cfg.groupPolicy,
				mentioned: isMentioned(msg),
				text,
				keywords: parseGroupKeywords(cfg.groupKeywords),
				alsoOnReply: cfg.groupAlsoOnReply,
				replyToBot: isReplyToBot(msg),
			});
			if (!decision.accept) return;
		}

		if (cfg.forward.reactions.enabled) {
			// 入站随机表情回执（用户指令 2026-08-07）：随机池排除 DONE，
			// DONE 只由回合完成时在 handleConversationMessage 打出。
			void transport?.addReaction(
				msg.messageId,
				pickRandomReaction(cfg.forward.reactions.emojis),
			);
		}

		router.bindConversation(
			conversationKeyFor(msg),
			msg,
			conversations?.peekSessionId(conversationKeyFor(msg)),
		);

		const text = extractPlainTextForTrigger(msg.msgType, msg.content).trim();
		// 2026-08-08（spec §3.2）：交互选择消费——/model /resume 列出选项后，
		// 用户回复编号/名称即完成选择，不当作普通消息。
		if (getPendingSelect(key)) {
			const consumed = tryConsumeSelect(key, text);
			if (consumed.consumed && consumed.text) {
				const marker = consumed.text.split(":")[0];
				const value = consumed.text.slice(consumed.text.indexOf(":") + 1);
				if (marker === "__MODEL_SELECT__") {
					const handle = await conversations?.getHandle(key);
					if (handle) {
						const ok = await handle.setModel(value);
						await replyTo(
							msg,
							ok
								? `✅ 模型已切换：${value}`
								: `❌ 模型 ${value} 不可用（/model 查看列表）`,
						);
					}
				} else if (marker === "__SESSION_SELECT__") {
					await conversations?.switchSession(key, value);
					await replyTo(msg, `✅ 已恢复会话：${value}`);
				} else if (marker === "__API_KEY__") {
					// 格式 __API_KEY__:<provider>:<key>
					const colon = value.indexOf(":");
					if (colon > 0) {
						const provider = value.slice(0, colon);
						const apiKey = value.slice(colon + 1);
						const ok = await piBackend?.setProviderApiKey(provider, apiKey);
						await replyTo(
							msg,
							ok
								? `✅ ${provider} API key 已保存。发送 /model 查看可用模型。`
								: `❌ ${provider} API key 保存失败。`,
						);
					}
				}
				return;
			}
		}
		if (text.startsWith("/")) {
			const cmd = parseCommand(text);
			if (cmd) {
				await handleCommand(msg, cmd, text);
				return;
			}
		}
		// M4 multimedia inbound: voice → unsupported hint; attachments → pipeline.
		if (isVoiceMessage(msg)) {
			await replyTo(msg, "暂不支持语音消息，请发文字或图片。");
			return;
		}
		const attachments = await processAttachments(
			msg,
			{
				download: (mid, key, type) => {
					if (!transport) throw new Error("transport not started");
					return transport.downloadResource(mid, key, type);
				},
			},
			{
				maxAttachments: cfg.media.maxAttachments,
				maxTotalBytes: cfg.media.maxTotalBytes,
				maxImageBytes: Math.min(cfg.media.maxTotalBytes, 10 * 1024 * 1024),
				maxTxtBytes: 2 * 1024 * 1024,
				maxExtractedChars: 150_000,
			},
		);
		for (const reason of attachments.unsupported) {
			await replyTo(msg, `附件处理提示：${reason}`);
		}
		const promptText =
			[text, attachments.text].filter(Boolean).join("\n\n").trim() ||
			"(附件消息)";
		await handleConversationMessage(msg, promptText, attachments.images);
	}

	function isMentioned(msg: FeishuInboundMessage): boolean {
		if (!botOpenId) return true;
		return Boolean(
			msg.mentions?.some(
				(m) => m?.id?.open_id === botOpenId || m?.id?.union_id === botOpenId,
			),
		);
	}

	function isReplyToBot(msg: FeishuInboundMessage): boolean {
		const parent = msg.parentId;
		if (!parent) return false;
		// best-effort: the transport tracks bot outbound ids; approximate by
		// checking the route's last bot message.
		return router.getRoute(conversationKeyFor(msg))?.lastMessageId === parent;
	}

	async function handleConversationMessage(
		msg: FeishuInboundMessage,
		text: string,
		images: Array<{ type: "image"; data: string; mimeType: string }> = [],
	): Promise<void> {
		if (!conversations || !eventForwarder || !outbox || !bridgeRuntime) return;
		const key = conversationKeyFor(msg);
		const cfg = loadConfig();
		const turnsCfg = cfg?.turns ?? DEFAULT_CONFIG.turns;
		const route = router.getRoute(key) ?? {
			sessionKey: key,
			chatId: msg.chatId,
			chatType: msg.chatType,
			threadMessageId: msg.messageId,
		};
		const routeRef: RouteRef = {
			conversationKey: key,
			chatId: route.chatId,
			chatType: route.chatType,
			threadMessageId: route.threadMessageId,
		};
		const runId = `run-${Date.now().toString(36)}`;

		// Streaming card lifecycle: one card per conversation turn.
		const cardId = `${key}:${runId}`;
		let streamCreated = false;

		const onDelta = (delta: string): void => {
			// 2026-08-08 用户指令：回复每次一条（省流量）——streaming.enabled=false
			// 时不流式更新，直接发完整回复；需要流式可 /feishu-config
			// forward.streaming.enabled=true 热改。
			if (!cfg?.forward.streaming.enabled) return;
			if (!streamCreated) {
				// 2026-08-08 流式修复（spec §3.1 B1）：首次 delta 记录回复目标，
				// 供 liveChannel.send 创建流式卡片时使用真实 messageId/chatId。
				streamTargets.set(cardId, {
					messageId:
						route.threadMessageId ??
						(route as { lastMessageId?: string }).lastMessageId,
					chatId: route.chatId,
				});
			}
			liveChannel?.patchDelta(cardId, delta);
			streamCreated = true;
		};

		const ctx = {
			key,
			route: routeRef,
			sessionId: "",
			runId,
			streamCardId: cardId,
		};

		// C3: mark this conversation as an active feishu input so scheduler
		// toolResults (schedule_prompt) bind their jobs to this route.
		bridgeRuntime.beginFeishuInput(key);
		try {
			// On first delta, create the stream card (sender creates it via
			// LiveChannel's send callback — see wiring below).
			const finalText = await conversations.prompt(key, text, {
				turnTimeoutMs: turnsCfg.turnTimeoutMs,
				ackAfterMs: turnsCfg.ackAfterMs,
				onDelta,
				images: images.length ? images : undefined,
			});
			ctx.sessionId = conversations?.peekSessionId(key) ?? ctx.sessionId;
			// 2026-08-08 用户指令：无实际文本输出（如 pi-goal 激活回合——
			// 扩展命令激活目标不算完成）→ 不发 "No response."、不打 DONE；
			// 任务的中间输出由持续订阅（onSessionDelta）流式显示。
			if (!finalText || finalText === "No response.") {
				if (streamCreated) {
					await liveChannel?.finalize(cardId);
				}
				return;
			}
			// 任务完成（用户指令 2026-08-07）：有实际回复才对触发消息打 DONE 表情，
			// best-effort（失败静默忽略，不阻塞回复投递）。
			if (cfg?.forward.reactions.enabled) {
				void transport?.addReaction(
					msg.messageId,
					cfg.forward.reactions.doneEmoji || "DONE",
				);
			}
			// I10: settle the volatile live channel BEFORE the durable final is
			// enqueued — a pending stream patch must not clobber the finalized card.
			if (streamCreated) {
				await liveChannel?.finalize(cardId);
			}
			await eventForwarder.handle(
				{
					type: "turn_end",
					finalText,
					cardId: streamCreated ? cardId : undefined,
					assistantMsgId: `${key}:${Date.now()}`,
				},
				ctx,
			);
		} catch (err) {
			const message = err instanceof Error ? err.message : String(err);
			logger.error("feishu.prompt.error", { key, error: message });
			await outbox
				.enqueue({
					dedupeKey: `error:${key}:${Date.now()}`,
					laneKey: key,
					route: routeRef,
					kind: "notify",
					payload: { type: "text", text: `处理失败：${message.slice(0, 500)}` },
				})
				.catch(() => undefined);
		} finally {
			bridgeRuntime.endFeishuInput(key);
		}
	}

	// ---------------- diagnostics ----------------

	async function exportDiagnostics(
		msg?: FeishuInboundMessage,
		cardKey?: string,
	): Promise<void> {
		const cfg = loadConfig();
		const outDir = rootDir() + "/diag-" + Date.now();
		const input: DiagnosticsInput = {
			config: cfg ?? DEFAULT_CONFIG,
			status: statusStore.get(),
			stateTransitions: statusStore.transitionsLog(),
			recentEvents: logger.recent(500),
			doctor: [],
			outboxPending: outbox?.summary().pending ?? 0,
			outboxFailed: [],
			reproTrace: [],
			versions: {
				extension: "0.2.0",
				pi: process.env.PI_VERSION ?? "unknown",
				node: process.version,
				os: process.platform,
				arch: process.arch,
				sdk: "lark-node-sdk",
				uptimeMs: Date.now() - (statusStore.get().startedAt ?? Date.now()),
				configSchema: cfg?.schemaVersion ?? 1,
			},
			includeContent: false,
		};
		// Permission self-check (spec §12 #1): group open policy needs the
		// "获取群组中所有消息" scope — probe it live when a transport exists.
		if (transport) {
			const perm = await probeGroupMessagePermission({
				listMessages: (chatId: string, opts: { startTimeMs: number }) =>
					transport!.listMessages(chatId, opts),
				groupChatIds: () => Object.keys(router.routesSnapshot()),
			});
			input.doctor.push({
				check: "group-read-permission",
				status:
					perm.status === "ok"
						? "ok"
						: perm.status === "missing"
							? "error"
							: "warn",
				detail: perm.detail,
			});
		}
		input.doctor = runDoctorChecks(input);
		const result = buildDiagnostics(input, outDir);
		logger.info("feishu.diagnostics.built", {
			files: result.files.length,
			bytes: result.bytes,
		});
		const summary = `诊断包已生成（${Math.round(result.bytes / 1024)}KB，${result.files.length} 个文件）：\n\`${outDir}\``;
		// I2: when triggered from Feishu, deliver the bundle as a FILE to the
		// requesting chat (spec §6.17/§9.6) instead of only a local path.
		if (msg) {
			await replyTo(msg, summary);
			await sendDiagnosticsBundle(outDir, {
				conversationKey: conversationKeyFor(msg),
				chatId: msg.chatId,
				chatType: msg.chatType,
				threadMessageId: msg.messageId,
			});
		} else if (cardKey) {
			const route = router.getRoute(cardKey);
			if (route)
				await sendDiagnosticsBundle(outDir, {
					conversationKey: route.sessionKey,
					chatId: route.chatId,
					chatType: route.chatType,
					threadMessageId: route.threadMessageId,
				});
			else logger.info("feishu.diagnostics.local", { outDir });
		} else {
			logger.info("feishu.diagnostics.local", { outDir });
		}
	}

	/** I2: tar the bundle and send it via the outbox media lane (≤20MB). */
	async function sendDiagnosticsBundle(
		outDir: string,
		route: {
			conversationKey: string;
			chatId: string;
			chatType: "p2p" | "group";
			threadMessageId?: string;
		},
	): Promise<void> {
		if (!outbox) return;
		try {
			const tarPath = `${outDir}.tar.gz`;
			execFileSync(
				"tar",
				["-czf", tarPath, "-C", rootDir(), basename(outDir)],
				{ stdio: "ignore" },
			);
			const { readFileSync, statSync } = await import("node:fs");
			const st = statSync(tarPath);
			if (st.size > 20 * 1024 * 1024) {
				await notifyConversation(
					route.conversationKey,
					"诊断包超过 20MB，未发送。可本地 /feishu doctor 查看。",
				);
				return;
			}
			await outbox.enqueue({
				dedupeKey: `diag:${Date.now()}`,
				laneKey: route.conversationKey,
				route: {
					conversationKey: route.conversationKey,
					chatId: route.chatId,
					chatType: route.chatType,
					threadMessageId: route.threadMessageId,
				},
				kind: "media",
				payload: {
					type: "media",
					fileType: 4,
					fileData: readFileSync(tarPath).toString("base64"),
					fileName: basename(tarPath),
				},
			});
		} catch (err) {
			logger.error("feishu.diagnostics.send_failed", {
				error: err instanceof Error ? err.message : String(err),
			});
		}
	}

	// ---------------- status formatting ----------------

	function formatStatusLine(): string {
		const s = statusStore.get();
		const stateLabel: Record<string, string> = {
			connected: "🟢 已连接",
			connecting: "🟡 连接中",
			degraded: "🟠 降级",
			restarting: "🟠 重启中",
			disconnected: "🔴 已断开",
		};
		return `${stateLabel[s.connState] ?? s.connState} · 运行 ${Math.round((Date.now() - s.startedAt) / 60_000)}min`;
	}

	function statusDetailLines(): string[] {
		const s = statusStore.get();
		return [
			`入站 ${s.inboundCount} / 出站 ${s.outboundCount} / outbox 积压 ${s.outboxPending}`,
			`重连 ${s.reconnectCount} 次 · 会话 ${s.residentSessions}/${s.maxResident}`,
			`定时任务路由 ${s.boundJobs} 个`,
		];
	}

	// ---------------- start / stop ----------------

	async function startBridge(
		opts: { takeover?: boolean } = {},
	): Promise<string> {
		const cfg = loadConfig();
		if (!cfg) {
			throw new Error("未配置。运行 /feishu setup 扫码 30 秒搞定。");
		}
		if (started) return "already";
		// 守卫立即生效（2026-08-07 修复）：此前 started=true 设在 startBridge 结尾，
		// rpc 模式下 session_start 并发触发时多个 startBridge 会同时穿过守卫，各自创建
		// transport + WS 连接 → 连接配额打爆 → 后续连接全部 exceed_conn_limit。
		started = true;
		const lock = acquireGatewayLock(rootDir(), { takeover: opts.takeover });
		if (lock.status === "busy") {
			return `连接由其他进程持有（pid ${lock.owner?.pid}）。运行 /feishu takeover 接管。`;
		}
		gatewayLock = lock.handle;
		gatewayLock?.update("connected");

		await dedupe.init();
		await router.pruneSent();

		transport = await createFeishuTransport(cfg, {
			onMessage: (m) => handleInbound(m),
			onCardAction: (action) => handleCardAction(action),
			logger,
		});
		botOpenId = transport.getBotOpenId();

		outbox = new Outbox({
			dir: rootDir() + "/outbox",
			sender: outboxSender,
			maxAttemptsBeforeAlert: cfg.outbox.maxAttemptsBeforeAlert,
			sentRetentionMs: cfg.outbox.sentRetentionMs,
			maxPendingEnvelopes: cfg.outbox.maxPendingEnvelopes,
			maxEnvelopeBytes: cfg.outbox.maxEnvelopeBytes,
			maxOutboxDirBytes: cfg.outbox.maxOutboxDirBytes,
			compactIntervalMs: cfg.outbox.compactIntervalMs,
			onAlert: (env, attempts) => {
				logger.warn("feishu.outbox.alert", { id: env.id, attempts });
			},
			onFatal: (env, err) => {
				logger.error("feishu.outbox.fatal", { id: env.id, error: err.message });
			},
			logger,
		});
		await outbox.init();

		liveChannel = new LiveChannel({
			throttleMs: cfg.forward.streaming.throttleMs,
			send: async (patch) => {
				if (!transport) return;
				const existing = streamCards.get(patch.cardId);
				const text = (existing?.text ?? "") + (patch.delta ?? "");
				const target = streamTargets.get(patch.cardId);
				if (existing) {
					await transport.updateCard(
						existing.messageId,
						buildSimpleTextCard(text),
					);
					existing.text = text;
					existing.touchedAt = Date.now();
				} else {
					// 2026-08-08 修复（spec §3.1 B1/B2）：流式卡片从创建就用
					// interactive 卡片——此前用 replyText/sendText 发 text 消息，
					// 后续 updateCard patch 卡片报 230001 "This message is NOT a
					// card"（400），导致回复停在流式半截 + 最终结果投递失败。
					const messageId = target?.messageId
						? await transport.replyCard(
								target.messageId,
								buildSimpleTextCard(text),
							)
						: await transport.sendCard(
								target?.chatId ?? "",
								buildSimpleTextCard(text),
							);
					if (messageId)
						streamCards.set(patch.cardId, {
							messageId,
							text,
							touchedAt: Date.now(),
						});
				}
			},
		});

		turnSupervisor = new TurnSupervisor({
			onTimeout: async (key) => {
				logger.warn("feishu.turn.timeout", { key });
				await conversations?.disposeActiveFor(key);
				await notifyConversation(key, "任务处理超时已中止，请重试。");
			},
			onAck: async (key) => {
				// I5: surface "still processing" once per long turn.
				await notifyConversation(key, "⏳ 仍在处理中，请稍候…");
			},
			onQueueWarn: async (key) => {
				// I5: surface queue wait instead of silent FIFO.
				await notifyConversation(key, "⏳ 前面任务耗时较长，你的消息正在排队…");
			},
		});
		turnSupervisor.start();

		piBackend = new PiSessionBackend();
		conversations = new ConversationManager({
			cwd: process.cwd(),
			backend: piBackend,
			stateFile,
			maxResident: cfg.sessions.maxResident,
			idleDisposeMs: cfg.sessions.idleDisposeMs,
			turnSupervisor,
			// 2026-08-08：会话持续订阅——pi-goal 等扩展的自动执行回合（无用户
			// 消息触发）中间输出也流式显示到飞书（通用机制，不识别任何命令）。
			onSessionDelta: (key, delta) => {
				// 2026-08-08：streaming.enabled=false 时不转发中间输出（省流量）。
				const liveCfg = loadConfig();
				if (!liveCfg?.forward.streaming.enabled) return;
				const cardId = `sess:${key}`;
				if (!streamTargets.has(cardId)) {
					const route = router.getRoute(key);
					streamTargets.set(cardId, {
						messageId: route?.threadMessageId ?? route?.lastMessageId,
						chatId: route?.chatId ?? "",
					});
				}
				liveChannel?.patchDelta(cardId, delta);
			},
		});

		bridgeRuntime = new BridgeRuntime({
			resolveJobRoute: (jobId) => router.getJob(jobId),
			enqueue: (partial) => outbox!.enqueue(partial),
			hasSent: (k) => router.hasSent(k),
			markSent: (k) => router.markSent(k),
			bindJob: (jobId, key, name) => {
				router.bindJob(jobId, key, name);
			},
		});

		permissionBridge = new PermissionBridge({
			getConfig: () => loadConfig()?.permissions ?? DEFAULT_CONFIG.permissions,
			onAsk: async (p) => {
				// H-fix: the approval card goes to the REQUESTING conversation only —
				// broadcasting it to every chat would let any chat approve another
				// chat's pending tool call (cross-chat approval spoofing).
				await notifyConversationCard(
					p.key,
					buildApprovalCard(p.id, p.toolName, p.paramsText, p.dangerous),
				);
			},
			onDenyTimeout: async () => undefined,
			onAudit: (entry) => {
				logger.info("feishu.permission.audit", {
					tool: entry.toolName,
					decision: entry.decision,
				});
			},
		});

		eventForwarder = new EventForwarder({
			getConfig: () => loadConfig()?.forward ?? DEFAULT_CONFIG.forward,
			enqueue: (partial) => outbox!.enqueue(partial),
			liveDelta: (cardId, delta) => liveChannel?.patchDelta(cardId, delta),
			liveContent: (cardId, content) =>
				liveChannel?.patchContent(cardId, content),
		});

		compensation = new MissedMessageCompensation({
			listChatMessages: (chatId, opts) => transport!.listMessages(chatId, opts),
			knownChatIds: () => [
				// 2026-08-08 修复：必须用真实飞书 chat_id（oc_xxx），不能用
				// conversationKey（p2p:ou_x / group:oc_x）——此前补偿调 list API
				// 传 key 导致 400（feishu.compensation.list_failed）。
				...new Set(
					Object.values(router.routesSnapshot())
						.map((r) => r.chatId)
						.filter((id): id is string => Boolean(id)),
				),
			],
			admitMessage: (id) => dedupe.admit(id),
			// C2: backfilled messages must skip the dedupe re-check (already admitted).
			onMessage: (m, opts) => handleInbound(m, opts),
			normalize: normalizeInbound,
			logger,
		});

		supervisor = new ConnectionSupervisor({
			transport: transport!,
			probeIntervalMs: cfg.connection.probeIntervalMs,
			silenceSuspectMs: cfg.connection.silenceSuspectMs,
			reconnectBackoffMaxMs: cfg.connection.reconnectBackoffMaxMs,
			downReportEnabled: cfg.connection.downReportEnabled,
			// QuotaGovernor 熔断（1905 spec 创新点②）：连接失败计入历史，
			// 60min 窗口超额即停手，不再 60s 重试顶住租户配额。
			governor: quotaGovernor,
			onQuotaBlocked: (retryAfterMs) => {
				const mins = Math.ceil(retryAfterMs / 60_000);
				statusStore.setConnState(
					"degraded",
					`连接配额熔断：${mins} 分钟后再试（持续重试会锁死配额）`,
				);
				void notifyOwner(
					`⚠️ 连接配额熔断：租户连接数超限，${mins} 分钟后自动重试。期间请勿反复 /feishu restart。`,
				);
			},
			onStateChange: (state) => statusStore.setConnState(state),
			onRecovered: async (downMs) => {
				statusStore.recordReconnect(downMs);
				// Missed-message compensation (spec §12 #2/#4): list recent
				// messages per known chat and re-inject anything unseen.
				try {
					const recovered = await compensation!.compensate(downMs);
					const note =
						recovered > 0 ? `，已补收 ${recovered} 条断连期间消息` : "";
					await notifyOwner(
						`连接已恢复（中断 ${Math.max(1, Math.round(downMs / 1000))}s${note}）。`,
					);
				} catch (err) {
					logger.warn("feishu.compensation.error", {
						error: err instanceof Error ? err.message : String(err),
					});
					await notifyOwner(
						`连接已恢复（中断 ${Math.max(1, Math.round(downMs / 1000))}s）。`,
					);
				}
			},
		});

		await supervisor.start();
		statusStore.update({
			residentSessions: 0,
			maxResident: cfg.sessions.maxResident,
			schedulerDetected:
				detectSchedulerInstalled() ||
				Boolean(loadOverrides()?.schedulerEnabled),
		});
		// periodic eviction + status refresh + stream-card TTL sweep (M4/M5)
		setInterval(() => {
			void conversations
				?.evictIdle()
				.then((n) => {
					if (n > 0)
						statusStore.update({
							residentSessions: conversations?.residentCount() ?? 0,
						});
				})
				.catch((err) => {
					logger.warn("feishu.evict.error", {
						error: err instanceof Error ? err.message : String(err),
					});
				});
			// M4: forget stream cards older than 10 minutes (unbounded growth).
			const cutoff = Date.now() - 10 * 60 * 1000;
			for (const [cardId, entry] of [...streamCards.entries()]) {
				if (entry.touchedAt < cutoff) streamCards.delete(cardId);
			}
			// toolCallId → session mappings: drop entries idle for 10 minutes
			// (long-running tools keep their mapping until they finish).
			const tcCutoff = Date.now() - 10 * 60 * 1000;
			for (const [id, entry] of [...toolCallSessionKeys.entries()]) {
				if (entry.at < tcCutoff) toolCallSessionKeys.delete(id);
			}
			statusStore.update({
				outboxPending: outbox?.summary().pending ?? 0,
				outboxFailed: outbox?.summary().failed ?? 0,
			});
		}, 60_000).unref?.();

		logger.info("feishu.bridge.started", {
			appId: mask(cfg.appId),
			domain: cfg.domain,
		});
		return "started";
	}

	function routeToRef(
		route: Route | undefined,
		fallback: {
			chatId: string;
			chatType: "p2p" | "group";
			threadMessageId?: string;
		},
	): RouteRef {
		if (route) {
			return {
				conversationKey: route.sessionKey,
				chatId: route.chatId,
				chatType: route.chatType,
				threadMessageId: route.threadMessageId,
				lastMessageId: route.lastMessageId,
			};
		}
		return {
			conversationKey: fallback.chatId,
			chatId: fallback.chatId,
			chatType: fallback.chatType,
			threadMessageId: fallback.threadMessageId,
		};
	}

	async function notifyOwner(text: string): Promise<void> {
		if (!outbox) return;
		for (const route of Object.values(router.routesSnapshot())) {
			const ref = routeToRef(route, {
				chatId: route.chatId,
				chatType: route.chatType,
				threadMessageId: route.threadMessageId,
			});
			await outbox
				.enqueue({
					dedupeKey: `notify:${ref.conversationKey}:${Date.now()}`,
					laneKey: ref.conversationKey,
					route: ref,
					kind: "notify",
					payload: { type: "text", text },
				})
				.catch(() => undefined);
		}
	}

	/** I5: notify exactly one conversation (ack / queue-warn / timeout). */
	async function notifyConversation(key: string, text: string): Promise<void> {
		if (!outbox) return;
		const route = router.getRoute(key);
		if (!route) return;
		const ref = routeToRef(route, {
			chatId: route.chatId,
			chatType: route.chatType,
			threadMessageId: route.threadMessageId,
		});
		await outbox
			.enqueue({
				dedupeKey: `notify:${key}:${Date.now()}`,
				laneKey: key,
				route: ref,
				kind: "notify",
				payload: { type: "text", text },
			})
			.catch(() => undefined);
	}

	/** Send a card to exactly one conversation (approval cards etc.). */
	async function notifyConversationCard(
		key: string,
		card: unknown,
	): Promise<void> {
		if (!outbox) return;
		const route = router.getRoute(key);
		if (!route) return;
		const ref = routeToRef(route, {
			chatId: route.chatId,
			chatType: route.chatType,
			threadMessageId: route.threadMessageId,
		});
		await outbox
			.enqueue({
				dedupeKey: `notify:${key}:${Date.now()}`,
				laneKey: key,
				route: ref,
				kind: "notify",
				payload: { type: "card", card },
			})
			.catch(() => undefined);
	}

	async function notifyOwnerCard(card: unknown): Promise<void> {
		if (!outbox) return;
		for (const route of Object.values(router.routesSnapshot())) {
			const ref = routeToRef(route, {
				chatId: route.chatId,
				chatType: route.chatType,
				threadMessageId: route.threadMessageId,
			});
			await outbox
				.enqueue({
					dedupeKey: `notify:${ref.conversationKey}:${Date.now()}`,
					laneKey: ref.conversationKey,
					route: ref,
					kind: "notify",
					payload: { type: "card", card },
				})
				.catch(() => undefined);
		}
	}

	async function stopBridge(): Promise<void> {
		started = false;
		await supervisor?.stop();
		await conversations?.disposeAll();
		await outbox?.close();
		await transport?.stop();
		await gatewayLock?.release();
		transport = undefined;
		outbox = undefined;
		supervisor = undefined;
		conversations = undefined;
		logger.info("feishu.bridge.stopped");
	}

	// ---------------- card actions ----------------

	async function handleCardAction(action: {
		messageId: string;
		chatId?: string;
		operatorOpenId: string;
		value?: Record<string, unknown>;
	}): Promise<unknown> {
		const v = action.value ?? {};
		const op = v.op;
		const key = keyForCardAction(action);
		if (op === "help") return buildHelpCard();
		if (op === "model")
			return buildSimpleTextCard("发送 /model <模型ID> 切换模型。");
		if (op === "status")
			return buildStatusCard(formatStatusLine(), statusDetailLines());
		if (op === "new") {
			await conversations?.newConversation(key);
			permissionBridge?.resetSessionMemory(key);
			return buildSimpleTextCard("已创建新会话。旧会话历史已保留。");
		}
		if (op === "stop") {
			// I4: the stop button must actually stop the running turn.
			await conversations?.disposeActiveFor(key);
			permissionBridge?.resetSessionMemory(key);
			return buildSimpleTextCard("已停止当前任务。");
		}
		if (op === "resume") {
			const sessions = await conversations?.listSessions("all");
			const lines = (sessions ?? [])
				.slice(-5)
				.map(
					(s) =>
						`· ${s.name ?? s.path.split("/").pop()}（${s.messageCount} 条）`,
				)
				.join("\n");
			return buildSimpleTextCard(
				`最近会话：\n${lines || "（无历史会话）"}\n\n发送 /resume 选择要恢复的会话。`,
			);
		}
		if (op === "thinking")
			return buildSimpleTextCard(
				"发送 /thinking <low|medium|high> 切换思考等级。",
			);
		if (op === "compact")
			return buildSimpleTextCard("上下文压缩：发送 /compact 触发。");
		if (op === "workspace")
			return buildSimpleTextCard("发送 /workspace /绝对路径 切换工作区。");
		if (op === "support") {
			// I2: deliver the diagnostics bundle back to THIS chat as a file.
			await exportDiagnostics(undefined, key);
			return buildSimpleTextCard("诊断包已生成，正在发送到本会话…");
		}
		if (op === "feishu-config")
			return buildSimpleTextCard(
				"配置热改：发送 /feishu-config <key>=<value>（如 groupPolicy=mention）。",
			);
		if (op === "approve" && typeof v.approvalId === "string") {
			// H2-fix: only the bridge owner/admin may approve — otherwise a group
			// member could self-approve the very tool call that gate is meant to
			// hold (the group anti-abuse gate would be a formality).
			if (!isAdminUser(action.operatorOpenId)) {
				return buildSimpleTextCard("仅管理员可审批该操作。");
			}
			const ok = await permissionBridge?.approve(v.approvalId);
			return buildSimpleTextCard(
				ok ? "✅ 已批准。重新发送上一条消息即可继续。" : "审批已失效。",
			);
		}
		if (op === "deny" && typeof v.approvalId === "string") {
			if (!isAdminUser(action.operatorOpenId)) {
				return buildSimpleTextCard("仅管理员可审批该操作。");
			}
			const ok = await permissionBridge?.deny(v.approvalId);
			return buildSimpleTextCard(ok ? "❌ 已拒绝。" : "审批已失效。");
		}
		return undefined;
	}

	/**
	 * Resolve the conversation key for a card action. The routes table maps
	 * chatId → key (I3/I4 fix: previously a fake "group:<messageId>" key made
	 * card buttons operate on the wrong conversation).
	 */
	function keyForCardAction(action: {
		messageId: string;
		chatId?: string;
		operatorOpenId: string;
	}): string {
		if (action.chatId) {
			for (const route of Object.values(router.routesSnapshot())) {
				if (route.chatId === action.chatId) return route.sessionKey;
			}
			return `group:${action.chatId}`;
		}
		return `p2p:${action.operatorOpenId}`;
	}

	// ---------------- pi hooks ----------------

	pi.on("session_start", async (_event, ctx: ExtensionContext) => {
		// TUI status line
		const ui = (
			ctx as { ui?: { setStatus?: (key: string, text: string) => void } }
		).ui;
		connectionStatusSink = (text: string) => {
			try {
				ui?.setStatus?.("feishu-connection", text);
			} catch {
				/* ignore */
			}
		};
		statusStore.setConnState("disconnected");
		const cfg = loadConfig();
		if (!cfg) {
			setConnectionStatus("飞书桥未配置 → 运行 /feishu setup");
			return;
		}
		// 卸载残留兜底（2026-08-08）：配置仍在但扩展已从 settings 卸载/入口被删时，
		// 立即清理状态目录，避免「卸载了还自动启动」（daemon 自监控只在 15s 内兜底，
		// 这里让 TUI 会话启动即干净）。清理后按未配置处理。
		if (
			cleanupStateDirIfUninstalled({
				entryPath: extensionEntryPath(),
				stateDir: rootDir(),
			})
		) {
			setConnectionStatus(
				"检测到扩展已卸载，飞书配置已清理（需要时重新运行 /feishu setup）",
			);
			return;
		}
		const isDaemon = process.env[DAEMON_ENV] === "1";
		if (isDaemon) {
			// Daemon child: own the gateway and run the bridge headless.
			try {
				const result = await startBridge();
				if (
					typeof result === "string" &&
					result.startsWith("连接由其他进程持有")
				) {
					// 2026-08-08 根治：多个 pi TUI 窗口 autoStart 并发 spawn daemon
					// 时，抢锁失败的 daemon 立即退出——保证同一时刻只有一个 daemon
					// 存活（此前 busy 后继续挂留，导致多 daemon 残留 + 多 WS 连接）。
					// 注意：startBridge 成功返回 "started"（非 busy 字符串），
					// 不能用 "!== already" 判断（曾把成功误判为 busy 导致 daemon 连环退出）。
					logger.info("feishu.daemon.exit_lock_busy", { reason: result });
					killDaemonTail(rootDir()); // 清理自己的 tail 保活管道（防孤儿）
					process.exit(0);
				}
				logger.info("feishu.daemon.ready");
				// 卸载自监控（2026-08-07）：pi 无卸载钩子，detached daemon 不会随
				// `pi remove` 停止；daemon 自行监控注册状态，被卸载即释放锁退出。
				stopUninstallWatch = startUninstallWatch({
					entryPath: extensionEntryPath(),
					onExit: async () => {
						logger.info("feishu.daemon.uninstalled");
						await stopBridge().catch(() => undefined);
						killDaemonTail(rootDir()); // 2026-08-08：卸载退出前清理 tail 保活管道
						// 卸载卫生（2026-08-08）：释放连接后清理整个状态目录
						// （config.json 含 appSecret / outbox / 日志 / 锁文件），否则残留
						// 配置会让下次加载自动拉起 daemon——卸载必须真正干净。
						if (
							cleanupStateDirIfUninstalled({
								entryPath: extensionEntryPath(),
								stateDir: rootDir(),
							})
						) {
							logger.info("feishu.state.cleaned");
						}
					},
				});
			} catch (err) {
				logger.error("feishu.daemon.start_failed", {
					error: err instanceof Error ? err.message : String(err),
				});
				process.exitCode = 1;
			}
			return;
		}
		if (cfg.autoStart) {
			// TUI: attach to an existing daemon-owned gateway, else spawn the daemon.
			const owner = readGatewayOwner(rootDir());
			if (owner && owner.pid !== process.pid) {
				// 2026-08-08 修复：区分「正常 daemon 持有」vs「卸载残留僵尸」——
				// 扩展仍注册（settings 里有本包）时是新 daemon 正常持有连接，
				// 不该提示"旧 daemon"；仅已卸载才是残留需清理。
				const stillRegistered = extensionStillRegistered(
					extensionEntryPath(),
					defaultSettingsFiles(),
				);
				if (stillRegistered) {
					setConnectionStatus(
						`飞书桥已由 daemon（pid ${owner.pid}）持有，无需重复启动。`,
					);
				} else {
					setConnectionStatus(
						`检测到旧 daemon（pid ${owner.pid}）仍持有飞书连接（卸载不会自动停止它）。运行 /feishu takeover 接管，或 /feishu stop 清理`,
					);
				}
				return;
			}
			if (owner && owner.pid === process.pid) {
				setConnectionStatus("飞书桥已连接（本进程持有）");
				return;
			}
			// No owner → spawn a detached daemon process.
			try {
				const result = await spawnDaemon({
					extensionPath: extensionEntryPath(),
					lockDir: rootDir(),
					logPath: join(rootDir(), "daemon.log"),
					cwd: process.cwd(),
					waitForOwnerMs: 15_000,
				});
				setConnectionStatus(
					result.status === "started"
						? `飞书桥已启动（daemon pid ${result.pid}）`
						: `飞书桥启动中…（${result.owner?.pid ?? "?"}）`,
				);
			} catch (err) {
				setConnectionStatus(
					`飞书桥启动失败：${err instanceof Error ? err.message : String(err)}`,
				);
			}
		}
	});

	pi.on("session_shutdown", async () => {
		// Do not stop the daemon-owned gateway; only release if we own it.
		await stopBridge();
	});

	pi.on("message_end", async (event, ctx) => {
		// Scheduler markers flow through child sessions; forward to bridge runtime.
		// C3: resolve the sessionKey from the bridge session id (was hardcoded
		// undefined → job binding never fired). TUI sessions resolve to nothing.
		const sessionId = ctx.sessionManager.getSessionId();
		const message = (event as { message?: unknown }).message;
		if (!message) return;
		const key = conversations?.keyForSessionId(sessionId);
		bridgeRuntime?.handleMessageEnd(sessionId, key, message);
	});

	// ---------------- tool gate (C1) + tool progress (I5) ----------------

	pi.on(
		"tool_call",
		createToolCallHandler({
			getPermissionBridge: () => permissionBridge,
			getConversations: () => conversations,
			approvalTimeoutMs:
				loadConfig()?.permissions.approvalTimeoutMs ??
				DEFAULT_CONFIG.permissions.approvalTimeoutMs,
			notifyDenied: (key, toolName, reason) => {
				void notifyConversation(key, `工具调用被拒绝 ${toolName}：${reason}`);
			},
			recordToolSession: (toolCallId, key) =>
				toolCallSessionKeys.set(toolCallId, { key, at: Date.now() }),
		}),
	);

	/** I5: surface tool executions as progress lines (summary mode). */
	function forwardToolEvent(
		event: { toolCallId: string; toolName: string },
		ctx: ExtensionContext,
		type: "tool_start" | "tool_end",
	): void {
		const key = conversations?.keyForSessionId(
			ctx.sessionManager.getSessionId(),
		);
		if (!key || !eventForwarder) return;
		const route = router.getRoute(key);
		if (!route) return;
		const ctx2 = {
			key,
			route: {
				conversationKey: key,
				chatId: route.chatId,
				chatType: route.chatType,
				threadMessageId: route.threadMessageId,
			},
			sessionId: route.sessionId ?? "",
			runId: event.toolCallId,
		};
		void eventForwarder.handle(
			{
				type,
				toolName: event.toolName,
				runId: event.toolCallId,
			},
			ctx2,
		);
	}

	pi.on("tool_execution_start", (event, ctx) => {
		forwardToolEvent(
			event as { toolCallId: string; toolName: string },
			ctx as ExtensionContext,
			"tool_start",
		);
	});

	pi.on("tool_execution_end", (event, ctx) => {
		forwardToolEvent(
			event as { toolCallId: string; toolName: string },
			ctx as ExtensionContext,
			"tool_end",
		);
	});

	// ---------------- commands (pi terminal) ----------------

	pi.registerCommand("feishu", {
		description:
			"Pi Feishu bridge 控制：setup/start/stop/restart/status/doctor",
		getArgumentCompletions: async () =>
			[
				"setup",
				"start",
				"stop",
				"restart",
				"status",
				"doctor",
				"takeover",
				"config",
			].map((value) => ({ value, label: value })),
		handler: async (rawArgs: string, ctx: ExtensionCommandContext) => {
			const args = rawArgs
				.trim()
				.split(/\s+/)
				.filter((a) => a.length > 0);
			const sub = (args[0] ?? "").toLowerCase();
			const notify = (text: string) => {
				try {
					ctx.ui.notify(text, "info");
				} catch {
					/* ignore */
				}
			};
			switch (sub) {
				case "setup": {
					const qr = (await import("qrcode-terminal")).default;
					// UX（2026-08-07）：阶段进度 + 轮询状态 + 回调到达醒目提示。
					const stage = (text: string) => {
						console.log(`\n[feishu-setup] ${text}`);
					};
					let pollingShown = false;
					await runSetup({
						mode: "auto",
						groupPolicy: "open",
						onStage: (s) => {
							if (s === "creating") stage("🚀 正在创建飞书应用…");
							if (s === "callback") {
								stage("✅ 已收到飞书授权回调！正在写入凭据…");
								notify("📲 飞书授权成功！正在写入凭据…");
							}
							if (s === "saved") stage("💾 凭据已保存");
						},
						registerApp: async ({ onQRCodeReady }) => {
							const lark = await import("@larksuiteoapi/node-sdk");
							return lark.registerApp({
								source: "pi-feishu-link",
								// 实机验证（2026-08-07，spec 开放问题 #1）：launcher 默认只订阅
								// card.action.trigger，必须显式传 addons 订阅消息事件 + 权限。
								addons: buildSetupAddons(),
								onQRCodeReady(info: { url: string; expireIn: number }) {
									stage(
										"📱 请用飞书 App 扫码授权（未收到回调前请勿关闭本窗口）",
									);
									qr.generate(info.url, { small: true }, (qrText: string) => {
										console.log("\n飞书授权二维码 / Feishu authorization QR");
										console.log(qrText);
										console.log(info.url);
									});
									onQRCodeReady(info.url, info.expireIn);
								},
								onStatusChange(info: { status?: string; interval?: number }) {
									// 轮询中：仅首次提示，避免刷屏。
									if (info?.status === "polling" && !pollingShown) {
										pollingShown = true;
										stage("⏳ 等待扫码授权…（自动检测，无需操作）");
									} else if (info?.status === "slow_down") {
										stage(`⚠ 轮询被限速，${info.interval ?? "?"}s 后重试`);
									} else if (info?.status === "domain_switched") {
										stage("🌐 已切换到 Lark 国际版");
									}
								},
							}) as Promise<{
								client_id?: string;
								client_secret?: string;
								user_info?: { tenant_brand?: string };
							}>;
						},
					});
					// 自检事件订阅（2026-08-07 实机验证修复）：确认应用订阅了
					// im.message.receive_v1，否则 WS 连上但收不到任何消息。
					const setupCfg = loadConfig();
					if (setupCfg?.appId) {
						const check = await checkEventSubscription(
							setupCfg.appId,
							setupCfg.appSecret,
							{ domain: setupCfg.domain },
						);
						if (check.ok) {
							stage("✅ 事件订阅自检通过：im.message.receive_v1 已订阅");
						} else {
							stage(
								"⚠️ 事件订阅自检失败：应用未订阅消息事件，连上但收不到消息！",
							);
							stage(
								`   请到开发者后台补充订阅：https://open.feishu.cn/app/${setupCfg.appId}/event`,
							);
							notify(
								`⚠️ 应用未订阅 im.message.receive_v1，收不到消息。请到开发者后台→事件与回调→添加该事件（长连接方式）：open.feishu.cn/app/${setupCfg.appId}/event`,
							);
						}
					}
					notify(
						"✅ 飞书配置已保存！运行 /feishu start 启动，然后打开飞书搜索你的机器人发任意消息。",
					);
					void refreshConnectionStatus();
					return;
				}
				case "start":
					// QuotaGovernor 熔断前置检查（1905 spec 创新点②）：配额封锁期阻止启动，
					// 避免刚 start 又被拒，把冷却窗口继续顶住。
					{
						const verdict = quotaGovernor.canConnect();
						if (!verdict.allowed) {
							const mins = Math.ceil(verdict.retryAfterMs / 60_000);
							notify(
								`🚫 连接配额熔断中：租户连接数超限，约 ${mins} 分钟后自动解除。期间请勿反复 start/restart（每次尝试都会重置冷却）。`,
							);
							return;
						}
					}
					// TUI-side: manage the daemon lifecycle (FR-15).
					try {
						const owner = readGatewayOwner(rootDir());
						if (owner && owner.pid !== process.pid) {
							notify(`飞书连接已由 daemon 持有（pid ${owner.pid}）。`);
						} else if (owner && owner.pid === process.pid) {
							notify("飞书桥已在本进程运行。");
						} else {
							const result = await spawnDaemon({
								extensionPath: extensionEntryPath(),
								lockDir: rootDir(),
								logPath: join(rootDir(), "daemon.log"),
								cwd: process.cwd(),
								waitForOwnerMs: 15_000,
							});
							notify(
								result.status === "started"
									? `飞书桥已启动（daemon pid ${result.pid}）。`
									: result.owner
										? `启动被占用（owner ${result.owner.pid}）。运行 /feishu takeover 接管。日志：${rootDir()}/daemon.log`
										: `启动超时（daemon 未注册）。日志：${rootDir()}/daemon.log`,
							);
						}
					} catch (err) {
						notify(
							`启动失败：${err instanceof Error ? err.message : String(err)}`,
						);
					}
					void refreshConnectionStatus();
					return;
				case "stop":
					{
						const owner = readGatewayOwner(rootDir());
						if (owner && owner.pid !== process.pid) {
							const killed = await stopDaemon(rootDir());
							notify(
								killed
									? `已停止 daemon（pid ${owner.pid}）。`
									: "daemon 已不在运行。",
							);
						} else {
							await stopBridge();
							notify("飞书桥已停止。");
						}
					}
					void refreshConnectionStatus();
					return;
				case "restart":
					{
						const owner = readGatewayOwner(rootDir());
						if (owner && owner.pid !== process.pid) {
							await stopDaemon(rootDir());
							await sleep(500);
						} else {
							await stopBridge();
						}
						try {
							const result = await spawnDaemon(
								{
									extensionPath: extensionEntryPath(),
									lockDir: rootDir(),
									logPath: join(rootDir(), "daemon.log"),
									cwd: process.cwd(),
									waitForOwnerMs: 15_000,
								},
								true,
							);
							notify(
								result.status === "started"
									? "飞书桥已重启。"
									: "重启超时，见 daemon.log。",
							);
						} catch (err) {
							notify(
								`重启失败：${err instanceof Error ? err.message : String(err)}`,
							);
						}
					}
					void refreshConnectionStatus();
					return;
				case "takeover":
					{
						const owner = readGatewayOwner(rootDir());
						if (owner && owner.pid === process.pid) {
							notify("本进程已是连接持有者。");
							return;
						}
						if (owner) {
							await stopDaemon(rootDir());
							await sleep(500);
						}
						try {
							await startBridge({ takeover: true });
							notify("已接管连接（本进程运行）。");
						} catch (err) {
							notify(
								`接管失败：${err instanceof Error ? err.message : String(err)}`,
							);
						}
					}
					void refreshConnectionStatus();
					return;
				case "status":
					notify(`${formatStatusLine()}\n${statusDetailLines().join("\n")}`);
					return;
				case "doctor":
					await exportDiagnostics();
					notify("诊断包已生成，见日志输出。");
					return;
				case "config":
					if (args[1] && args[1].includes("=")) {
						const [k, v] = args.slice(1).join(" ").split("=");
						if (k && v) {
							const overrides = loadOverrides() ?? {};
							setPath(overrides, k.trim(), parseValue(v.trim()));
							saveOverrides(overrides);
							notify(`已热改 ${k.trim()}=${v.trim()}（重启桥接生效）。`);
						}
					} else {
						notify(
							`当前配置：\n${JSON.stringify(loadOverrides() ?? {}, null, 2)}\n用法：/feishu config key=value`,
						);
					}
					return;
				default:
					notify(
						"用法：/feishu setup|start|stop|restart|status|doctor|takeover|config",
					);
			}
		},
	});

	pi.registerTool({
		name: "feishu_send_local_file",
		label: "发送文件到飞书",
		description: "发送本地文件到当前飞书会话（图片/文件）",
		promptSnippet:
			"使用 feishu_send_local_file 将本地文件发送给用户：传 path 和可选 caption。",
		parameters: {
			type: "object",
			properties: {
				path: { type: "string", description: "本地文件绝对路径" },
				caption: { type: "string", description: "可选说明文字" },
			},
			required: ["path"],
		},
		execute: async (
			_toolCallId,
			params: { path?: string; caption?: string },
		): Promise<{
			content: Array<{ type: "text"; text: string }>;
			details: { path: string | undefined; caption: string | undefined };
			isError?: boolean;
		}> => {
			const p = params ?? {};
			if (!p.path) {
				return {
					content: [{ type: "text", text: "错误：path 必填" }],
					details: { path: undefined, caption: undefined },
					isError: true,
				};
			}
			if (!outbox || !conversations) {
				// 2026-08-08：工具依赖 daemon 进程的 bridge（outbox/conversations）。
				// 仅在 daemon 的模型会话（飞书消息触发的回合）里可用；
				// TUI 会话直接调用时当前进程未初始化 bridge → 明确提示。
				return {
					content: [
						{
							type: "text",
							text: "无法发送：当前会话未运行飞书桥（请在飞书对话里说「发送文件 xxx」，由 daemon 处理；或确认 /feishu start 已启动）。",
						},
					],
					details: { path: p.path, caption: p.caption },
					isError: true,
				};
			}
			try {
				const { readFileSync, statSync } = await import("node:fs");
				const st = statSync(p.path);
				if (!st.isFile()) {
					return {
						content: [{ type: "text", text: `错误：${p.path} 不是文件` }],
						details: { path: p.path, caption: p.caption },
						isError: true,
					};
				}
				if (st.size > 20 * 1024 * 1024) {
					return {
						content: [{ type: "text", text: "错误：文件超过 20MB 上限" }],
						details: { path: p.path, caption: p.caption },
						isError: true,
					};
				}
				const base64 = readFileSync(p.path).toString("base64");
				const isImage = /\.(png|jpe?g|gif|webp|bmp)$/i.test(p.path);
				// I7: prefer the CURRENT conversation (stashed by the tool_call gate
				// as toolCallId → key); fall back to the first known route.
				const currentKey = toolCallSessionKeys.get(_toolCallId)?.key;
				const routes = router.routesSnapshot();
				const route =
					(currentKey ? router.getRoute(currentKey) : undefined) ??
					Object.values(routes)[0];
				if (!route) {
					return {
						content: [
							{
								type: "text",
								text: "错误：没有可投递的飞书会话（请先发一条消息建立路由）",
							},
						],
						details: { path: p.path, caption: p.caption },
						isError: true,
					};
				}
				await outbox.enqueue({
					dedupeKey: `media:${Date.now()}:${p.path}`,
					laneKey: route.sessionKey,
					route: {
						conversationKey: route.sessionKey,
						chatId: route.chatId,
						chatType: route.chatType,
						threadMessageId: route.threadMessageId,
					},
					kind: "media",
					payload: {
						type: "media",
						fileType: isImage ? 1 : 4,
						fileData: base64,
						fileName: p.path.split("/").pop(),
					},
				});
				const text = `已排队发送文件 ${p.path}${p.caption ? `（${p.caption}）` : ""}`;
				return {
					content: [{ type: "text", text }],
					details: { path: p.path, caption: p.caption },
				};
			} catch (err) {
				return {
					content: [
						{
							type: "text",
							text: `发送失败：${err instanceof Error ? err.message : String(err)}`,
						},
					],
					details: { path: p.path, caption: p.caption },
					isError: true,
				};
			}
		},
	});

	// Initial banner when unconfigured
	if (!isConfigured(loadConfig())) {
		try {
			console.log("[feishu-link] 未配置 → 运行 /feishu setup 扫码 30 秒搞定");
		} catch {
			/* ignore */
		}
	}
}

function setPath(
	obj: Record<string, unknown>,
	key: string,
	value: unknown,
): void {
	const parts = key.split(".");
	let cur = obj;
	for (let i = 0; i < parts.length - 1; i++) {
		const part = parts[i]!;
		if (typeof cur[part] !== "object" || cur[part] === null) cur[part] = {};
		cur = cur[part] as Record<string, unknown>;
	}
	cur[parts[parts.length - 1]!] = value;
}

function parseValue(v: string): unknown {
	if (v === "true") return true;
	if (v === "false") return false;
	if (/^-?\d+$/.test(v)) return Number(v);
	return v;
}

/** Absolute path to this extension's entry (used to spawn the daemon). */
function extensionEntryPath(): string {
	return fileURLToPath(import.meta.url);
}

function sleep(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}
