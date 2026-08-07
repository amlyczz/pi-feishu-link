// Connection supervisor (R2 core).
//
// v1.1 semantics (spec §6.2): event silence beyond `silenceSuspectMs` triggers
// an UNCONDITIONAL transport rebuild — REST probe health does not clear a
// zombie WS (they are independent channels; this was the original "no reply"
// bug). Probe failures are diagnostic only (network down vs platform issue)
// and drive the `degraded` state. Rebuild uses exponential backoff with no
// upper retry limit; after 5+ consecutive failures a down-report is emitted
// (post-recovery). Recovery = first event arrives AND probe ok.

import type { ConnState } from "../common/types.js";

export interface SupervisorTransport {
	start(): Promise<void>;
	stop(): Promise<void>;
	probe(): Promise<{ ok: boolean; latencyMs: number }>;
	/** WS 是否已成功握手（2026-08-07 加固：autoReconnect:false 下由 supervisor 感知） */
	isConnected(): boolean;
}

export interface ConnectionSupervisorOptions {
	transport: SupervisorTransport;
	tickIntervalMs?: number;
	probeIntervalMs?: number;
	silenceSuspectMs?: number;
	/** 等待 WS 握手完成的时长（2026-08-07 加固） */
	wsHandshakeTimeoutMs?: number;
	reconnectBackoffBaseMs?: number;
	reconnectBackoffMaxMs?: number;
	downReportEnabled?: boolean;
	onStateChange?: (state: ConnState, detail?: string) => void;
	onRecovered?: (downMs: number) => void;
	onDownReport?: (downMs: number) => void;
	onProbeFail?: (failCount: number) => void;
	now?: () => number;
}

const DEFAULT_TICK_MS = 15_000;
const DEFAULT_PROBE_INTERVAL_MS = 30_000;
const DEFAULT_WS_HANDSHAKE_TIMEOUT_MS = 10_000;
const DEFAULT_SILENCE_SUSPECT_MS = 1_200_000;
const DEFAULT_BACKOFF_BASE_MS = 1_000;
const DEFAULT_BACKOFF_MAX_MS = 60_000;
const PROBE_FAIL_THRESHOLD = 3;
const DOWN_REPORT_THRESHOLD_ATTEMPTS = 5;

export class ConnectionSupervisor {
	private readonly transport: SupervisorTransport;
	private readonly tickIntervalMs: number;
	private readonly probeIntervalMs: number;
	private readonly wsHandshakeTimeoutMs: number;
	private readonly silenceSuspectMs: number;
	private readonly backoffBaseMs: number;
	private readonly backoffMaxMs: number;
	private readonly downReportEnabled: boolean;
	private readonly onStateChange?: (state: ConnState, detail?: string) => void;
	private readonly onRecovered?: (downMs: number) => void;
	private readonly onDownReport?: (downMs: number) => void;
	private readonly onProbeFail?: (failCount: number) => void;
	private readonly now: () => number;

	private state: ConnState = "disconnected";
	private lastEventAt = 0;
	private lastProbeAt = 0;
	private lastProbeOk = false;
	private lastProbeLatencyMs: number | undefined;
	private probeFailCount = 0;
	private connectAttempts = 0;
	private downSince: number | undefined;
	private downReported = false;
	private timer: NodeJS.Timeout | undefined;
	private stopped = true;

	constructor(options: ConnectionSupervisorOptions) {
		this.transport = options.transport;
		this.tickIntervalMs = options.tickIntervalMs ?? DEFAULT_TICK_MS;
		this.probeIntervalMs = options.probeIntervalMs ?? DEFAULT_PROBE_INTERVAL_MS;
		this.wsHandshakeTimeoutMs =
			options.wsHandshakeTimeoutMs ?? DEFAULT_WS_HANDSHAKE_TIMEOUT_MS;
		this.silenceSuspectMs =
			options.silenceSuspectMs ?? DEFAULT_SILENCE_SUSPECT_MS;
		this.backoffBaseMs =
			options.reconnectBackoffBaseMs ?? DEFAULT_BACKOFF_BASE_MS;
		this.backoffMaxMs = options.reconnectBackoffMaxMs ?? DEFAULT_BACKOFF_MAX_MS;
		this.downReportEnabled = options.downReportEnabled ?? true;
		this.onStateChange = options.onStateChange;
		this.onRecovered = options.onRecovered;
		this.onDownReport = options.onDownReport;
		this.onProbeFail = options.onProbeFail;
		this.now = options.now ?? Date.now;
	}

	getState(): ConnState {
		return this.state;
	}

	/** Any inbound WS event (message, card action) proves liveness. */
	recordEvent(): void {
		this.lastEventAt = this.now();
		this.maybeRecover();
	}

	getDiagnostics() {
		return {
			state: this.state,
			lastEventAt: this.lastEventAt || undefined,
			lastProbeAt: this.lastProbeAt || undefined,
			lastProbeOk: this.lastProbeOk,
			lastProbeLatencyMs: this.lastProbeLatencyMs,
			probeFailCount: this.probeFailCount,
			connectAttempts: this.connectAttempts,
			downSince: this.downSince,
		};
	}

	async start(): Promise<void> {
		if (!this.timer) {
			this.timer = setInterval(() => void this.tick(), this.tickIntervalMs);
			this.timer.unref?.();
		}
		this.stopped = false;
		this.lastEventAt = this.now();
		await this.connect();
	}

	async stop(): Promise<void> {
		this.stopped = true;
		if (this.timer) {
			clearInterval(this.timer);
			this.timer = undefined;
		}
		await this.transport.stop();
		this.setState("disconnected");
	}

	/** Connect (or rebuild) the transport with backoff. */
	async connect(): Promise<void> {
		if (this.stopped) return;
		this.setState("connecting");
		const started = this.now();
		try {
			await this.transport.stop(); // clean any half-open state
			await this.transport.start();
			// WS 握手等待（2026-08-07 加固：autoReconnect:false，SDK 不再内部无限
			// 重试）。连接被拒（如 exceed_conn_limit 配额封锁）时 isConnected 恒为
			// false → 走 catch → 受控退避重试，而不是 SDK 疯狂打点把配额锁得更久。
			// 握手等待是真实挂钟操作（测试里 fake clock 不前进，用 Date.now）
			const wsDeadline = Date.now() + this.wsHandshakeTimeoutMs;
			while (Date.now() < wsDeadline && !this.transport.isConnected()) {
				await new Promise((r) => setTimeout(r, 200));
			}
			if (!this.transport.isConnected()) {
				throw new Error("WS 握手未完成（可能连接配额受限）");
			}
			this.connectAttempts = 0;
			this.downReported = false;
			this.setState("connected");
			// Consider recovered when connected AND we had been down.
			this.maybeRecover();
		} catch {
			this.connectAttempts += 1;
			const delayMs = Math.min(
				this.backoffBaseMs * 2 ** (this.connectAttempts - 1),
				this.backoffMaxMs,
			);
			this.setState(
				"degraded",
				`connect failed (attempt ${this.connectAttempts})`,
			);
			if (
				this.downReportEnabled &&
				!this.downReported &&
				this.connectAttempts >= DOWN_REPORT_THRESHOLD_ATTEMPTS
			) {
				this.downReported = true;
				const downMs = this.now() - (this.downSince ?? started);
				this.onDownReport?.(downMs);
			}
			setTimeout(() => {
				if (!this.stopped) void this.connect();
			}, delayMs).unref?.();
		}
	}

	private maybeRecover(): void {
		if (this.downSince !== undefined) {
			const downMs = this.now() - this.downSince;
			this.downSince = undefined;
			this.onRecovered?.(downMs);
		}
	}

	async tick(now: number = this.now()): Promise<void> {
		if (this.stopped) return;
		if (this.state === "connecting" || this.state === "disconnected") {
			// A connect attempt is already in flight or pending.
			return;
		}
		if (
			this.state === "connected" ||
			this.state === "degraded" ||
			this.state === "restarting"
		) {
			// 1) Zombie WS detection: silence → unconditional rebuild.
			// 2026-08-07 加固：连接掉线（isConnected=false）立即重建，
			// 不等 20 分钟静默；初始连接失败由 connect() 的退避重试处理。
			if (!this.transport.isConnected()) {
				this.setState("restarting", "ws disconnected");
				if (this.downSince === undefined)
					this.downSince = this.lastEventAt || now;
				await this.connect();
				return;
			}
			if (now - this.lastEventAt > this.silenceSuspectMs) {
				// 2026-08-07 诊断：打印触发静默重建时的实际数值
				console.log(
					`[supervisor] silence_restart now=${now} lastEventAt=${this.lastEventAt} silenceSuspectMs=${this.silenceSuspectMs} gap=${now - this.lastEventAt}`,
				);
				this.setState("restarting", "event silence exceeded threshold");
				if (this.downSince === undefined)
					this.downSince = this.lastEventAt || now;
				await this.connect();
				return;
			}
			// 2) Periodic probe (diagnostic channel).
			if (now - this.lastProbeAt >= this.probeIntervalMs) {
				this.lastProbeAt = now;
				try {
					const res = await this.transport.probe();
					this.lastProbeOk = res.ok;
					this.lastProbeLatencyMs = res.latencyMs;
					if (res.ok) {
						if (this.probeFailCount >= PROBE_FAIL_THRESHOLD) {
							this.setState("connected", "probe recovered");
						}
						this.probeFailCount = 0;
						this.maybeRecover();
					} else {
						this.probeFailCount += 1;
						this.onProbeFail?.(this.probeFailCount);
						if (this.probeFailCount >= PROBE_FAIL_THRESHOLD) {
							this.setState(
								"degraded",
								`probe failed ${this.probeFailCount} times`,
							);
						}
					}
				} catch {
					this.probeFailCount += 1;
					this.onProbeFail?.(this.probeFailCount);
					if (this.probeFailCount >= PROBE_FAIL_THRESHOLD) {
						this.setState("degraded", "probe threw");
					}
				}
			}
		}
	}

	private setState(state: ConnState, detail?: string): void {
		if (this.state === state) return;
		this.state = state;
		this.onStateChange?.(state, detail);
	}
}
