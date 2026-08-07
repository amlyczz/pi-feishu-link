// Conversation manager (spec §6.4): per-conversation-key pi sessions with
// FIFO queues, lazy creation, workspace/model binding, idle disposal and
// resident caps. The pi SDK is abstracted behind SessionBackend so the
// orchestration logic is fully unit-testable; the real backend lazily
// imports the pi SDK (pi-session-backend.ts).

import { existsSync, realpathSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { createHash } from "node:crypto";
import { readJson, writeJson } from "../common/config.js";
import type { TurnSupervisor } from "../sessions/turn-supervisor.js";
import type { ConversationKey } from "../common/types.js";

export interface PiSessionHandle {
	sessionId: string;
	sessionFile: string;
	prompt(
		text: string,
		images?: Array<{ type: "image"; data: string; mimeType: string }>,
	): Promise<void>;
	subscribe(fn: (event: unknown) => void): () => void;
	getLastAssistantText(): string;
	getModelLabel(): string;
	dispose(): Promise<void>;
}

export interface SessionListItem {
	path: string;
	name?: string;
	firstMessage?: string;
	messageCount: number;
	modified: Date | string;
	cwd?: string;
}

export interface SessionBackend {
	createSession(opts: {
		cwd: string;
		modelId?: string;
		sessionFile?: string;
	}): Promise<PiSessionHandle>;
	listSessions(cwd?: string): Promise<SessionListItem[]>;
}

export interface ConversationManagerOptions {
	cwd: string;
	backend: SessionBackend;
	stateFile: string;
	maxResident?: number;
	idleDisposeMs?: number;
	turnSupervisor?: TurnSupervisor;
	now?: () => number;
}

interface ConversationState {
	sessions: Record<string, string>;
	models: Record<string, { provider: string; id: string }>;
	workspaces: Record<string, string>;
}

interface Entry {
	key: string;
	handle?: PiSessionHandle;
	lastUsedAt: number;
	busy: boolean;
}

export class ConversationManager {
	private readonly cwd: string;
	private readonly backend: SessionBackend;
	private readonly stateFile: string;
	private readonly maxResident: number;
	private readonly idleDisposeMs: number;
	private readonly turnSupervisor?: TurnSupervisor;
	private readonly now: () => number;
	private readonly entries = new Map<ConversationKey, Entry>();
	private readonly queues = new Map<ConversationKey, Promise<unknown>>();
	/** Persistent sessionId → key map (survives handle disposal; D-fix). */
	private readonly sessionKeys = new Map<string, ConversationKey>();
	private state: ConversationState;

	constructor(options: ConversationManagerOptions) {
		this.cwd = options.cwd;
		this.backend = options.backend;
		this.stateFile = options.stateFile;
		this.maxResident = options.maxResident ?? 8;
		this.idleDisposeMs = options.idleDisposeMs ?? 1_800_000;
		this.turnSupervisor = options.turnSupervisor;
		this.now = options.now ?? Date.now;
		this.state = readJson<ConversationState>(this.stateFile, {
			sessions: {},
			models: {},
			workspaces: {},
		});
	}

	/** Enqueue a user turn; runs FIFO per key. Returns the final assistant text. */
	async prompt(
		key: ConversationKey,
		userText: string,
		opts: {
			images?: Array<{ type: "image"; data: string; mimeType: string }>;
			turnTimeoutMs: number;
			ackAfterMs: number;
			onDelta?: (delta: string) => void;
		} = { images: undefined, turnTimeoutMs: 1_800_000, ackAfterMs: 15_000 },
	): Promise<string> {
		const previous = this.queueTail(key);
		// I5: a message arriving while a turn is active is queued — surface it to
		// the TurnSupervisor so the queueWarn notification can fire.
		if (this.turnSupervisor?.isTurnActive(key)) {
			this.turnSupervisor.markQueued(key);
		}
		// I1: a rejected tail must never poison the queue — swallow prior
		// failures so every new message gets a fresh chance to run.
		const next = previous
			.catch(() => undefined)
			.then(async () => {
				const entry = this.touch(key);
				this.turnSupervisor?.beginTurn(
					key,
					opts.turnTimeoutMs,
					opts.ackAfterMs,
				);
				this.turnSupervisor?.dequeue(key);
				const handle = await this.ensureSession(entry);
				entry.busy = true;
				try {
					let unsub: (() => void) | undefined;
					if (opts.onDelta) {
						unsub = handle.subscribe((event: unknown) => {
							const delta = extractTextDelta(event);
							if (delta) opts.onDelta?.(delta);
						});
					}
					try {
						await handle.prompt(userText, opts.images);
					} finally {
						unsub?.();
					}
					const finalText = handle.getLastAssistantText() || "No response.";
					this.turnSupervisor?.endTurn(key);
					return finalText;
				} catch (err) {
					// I1: always clear the watchdog and DROP the broken handle so the
					// next turn reopens the session fresh (history is kept on disk).
					this.turnSupervisor?.endTurn(key);
					if (entry.handle === handle) {
						entry.handle = undefined;
						void handle.dispose().catch(() => undefined);
					}
					throw err;
				} finally {
					// M6: only clear busy when this turn still owns the entry handle
					// (a stale completion must not unmark a newer turn).
					if (entry.handle === handle) {
						entry.busy = false;
						entry.lastUsedAt = this.now();
					}
				}
			});
		this.queues.set(key, next);
		return next;
	}

	/** Fresh session for a key; disposes the old one. */
	async newConversation(key: ConversationKey): Promise<void> {
		const entry = this.touch(key);
		if (entry.handle) {
			await entry.handle.dispose();
			entry.handle = undefined;
		}
		delete this.state.sessions[key];
		delete this.state.models[key];
		this.persist();
	}

	async switchWorkspace(
		key: ConversationKey,
		workspaceInput: string | undefined,
	): Promise<string> {
		if (!workspaceInput) return this.getWorkspace(key);
		const workspace = resolveWorkspace(workspaceInput);
		const entry = this.touch(key);
		if (entry.handle) {
			await entry.handle.dispose();
			entry.handle = undefined;
		}
		delete this.state.sessions[key];
		this.state.workspaces[key] = workspace;
		this.persist();
		return workspace;
	}

	getWorkspace(key: ConversationKey): string {
		return this.state.workspaces[key] || this.cwd;
	}

	async selectModel(key: ConversationKey, modelId: string): Promise<void> {
		const entry = this.touch(key);
		if (entry.handle) {
			await entry.handle.dispose();
			entry.handle = undefined;
		}
		this.state.models[key] = { provider: "configured", id: modelId };
		this.persist();
	}

	getModel(key: ConversationKey): string {
		return this.state.models[key]?.id ?? "default";
	}

	async getSessionFile(key: ConversationKey): Promise<string | undefined> {
		const entry = this.touch(key);
		await this.ensureSession(entry);
		return entry.handle?.sessionFile;
	}

	/** Persist sessions to disk (for diagnostics/status). */
	async persistSessions(): Promise<void> {
		for (const [key, entry] of this.entries) {
			if (entry.handle) this.state.sessions[key] = entry.handle.sessionFile;
		}
		this.persist();
	}

	/** Session id for a key without forcing creation (or undefined). */
	peekSessionId(key: ConversationKey): string | undefined {
		return this.entries.get(key)?.handle?.sessionId;
	}

	/**
	 * Reverse lookup: bridge sessionId → conversation key (C3 wiring).
	 * Falls back to a persistent map so the gate still resolves a key for a
	 * session that was disposed mid-turn (D-fix: a late tool call from an
	 * aborted turn must stay behind the permission bridge, not bypass it).
	 */
	keyForSessionId(sessionId: string): string | undefined {
		for (const [key, entry] of this.entries) {
			if (entry.handle && entry.handle.sessionId === sessionId) return key;
		}
		return this.sessionKeys.get(sessionId);
	}

	/** Abort an active turn by disposing the busy session (stop command). */
	async disposeActiveFor(key: ConversationKey): Promise<void> {
		this.turnSupervisor?.endTurn(key);
		const entry = this.entries.get(key);
		if (entry?.handle) {
			const handle = entry.handle;
			entry.handle = undefined;
			entry.busy = false;
			await handle.dispose();
		}
		this.queues.set(key, Promise.resolve());
	}

	/** Evict idle/resident-exceeding sessions. Returns disposed count. */
	async evictIdle(now: number = this.now()): Promise<number> {
		let disposed = 0;
		const idle = [...this.entries.entries()]
			.filter(
				([, e]) =>
					!e.busy && e.handle && now - e.lastUsedAt >= this.idleDisposeMs,
			)
			.sort((a, b) => a[1].lastUsedAt - b[1].lastUsedAt);
		for (const [key, entry] of idle) {
			if (entry.handle) {
				await entry.handle.dispose();
				entry.handle = undefined;
				disposed++;
			}
			this.entries.delete(key);
		}
		// Enforce resident cap.
		const live = [...this.entries.entries()]
			.filter(([, e]) => e.handle && !e.busy)
			.sort((a, b) => a[1].lastUsedAt - b[1].lastUsedAt);
		while (live.length > this.maxResident) {
			const [key, entry] = live.shift()!;
			if (entry.handle) {
				await entry.handle.dispose();
				entry.handle = undefined;
			}
			this.entries.delete(key);
			disposed++;
		}
		return disposed;
	}

	residentCount(): number {
		let n = 0;
		for (const e of this.entries.values()) {
			if (e.handle) n++;
		}
		return n;
	}

	async disposeAll(): Promise<void> {
		for (const [, entry] of this.entries) {
			if (entry.handle) await entry.handle.dispose();
		}
		this.entries.clear();
	}

	async listSessions(scope: "workspace" | "all"): Promise<SessionListItem[]> {
		const cwd = scope === "workspace" ? this.cwd : undefined;
		return this.backend.listSessions(cwd);
	}

	/** Session dir derived from key + workspace (isolation, spec §6.6). */
	sessionDirFor(key: ConversationKey, workspace: string): string {
		return createHash("sha256")
			.update(`pi-feishu-link\0${key}\0${workspace}`)
			.digest("hex")
			.slice(0, 32);
	}

	private touch(key: ConversationKey): Entry {
		let entry = this.entries.get(key);
		if (!entry) {
			entry = { key, lastUsedAt: this.now(), busy: false };
			this.entries.set(key, entry);
		}
		entry.lastUsedAt = this.now();
		return entry;
	}

	private queueTail(key: ConversationKey): Promise<unknown> {
		return this.queues.get(key) || Promise.resolve();
	}

	private async ensureSession(entry: Entry): Promise<PiSessionHandle> {
		if (entry.handle) return entry.handle;
		const key = entry.key;
		const workspace = this.getWorkspace(key);
		const sessionFile = this.state.sessions[key];
		const modelId = this.state.models[key]?.id;
		const handle = await this.backend.createSession({
			cwd: workspace,
			modelId,
			sessionFile:
				sessionFile && existsSync(sessionFile) ? sessionFile : undefined,
		});
		entry.handle = handle;
		this.sessionKeys.set(handle.sessionId, key);
		this.state.sessions[key] = handle.sessionFile;
		this.persist();
		void this.evictIdle().catch(() => undefined); // M5: never leak a rejection
		return handle;
	}

	private persist(): void {
		try {
			writeJson(this.stateFile, this.state);
		} catch {
			// best-effort
		}
	}
}

function extractTextDelta(event: unknown): string | undefined {
	if (typeof event !== "object" || event === null) return undefined;
	const e = event as {
		type?: string;
		assistantMessageEvent?: { type?: string; delta?: string };
		delta?: string;
	};
	if (e.type === "message_update") {
		const ame = e.assistantMessageEvent;
		if (
			ame?.type === "text_delta" &&
			typeof ame.delta === "string" &&
			ame.delta
		)
			return ame.delta;
		if (typeof e.delta === "string" && e.delta) return e.delta;
	}
	if (e.type === "text_delta" && typeof e.delta === "string" && e.delta)
		return e.delta;
	return undefined;
}

function resolveWorkspace(input: string): string {
	const trimmed = input.trim();
	const expanded =
		trimmed === "~" || trimmed.startsWith("~/")
			? join(homedir(), trimmed.slice(2))
			: trimmed;
	if (!resolve(expanded).startsWith("/")) {
		throw new Error("工作区需要绝对路径");
	}
	const resolved = resolve(expanded);
	return realpathSync(resolved);
}
