// Daemon host (spec §6.10 / FR-15): spawn a detached headless pi process that
// owns the Feishu gateway, so the bridge survives TUI exit. The TUI process
// manages the daemon lifecycle (start/stop/restart/takeover) and attaches
// read-only via the gateway file lock.

import { spawn } from "node:child_process";
import { existsSync, openSync, readFileSync, rmSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve, sep } from "node:path";
import { readGatewayOwner, type GatewayOwner } from "./gateway-lock.js";

export const DAEMON_ENV = "PI_FEISHU_LINK_DAEMON";

export interface DaemonOptions {
	/** Path to this extension's entry file (import.meta.url). */
	extensionPath: string;
	/** Gateway lock directory (rootDir). */
	lockDir: string;
	/** Log file for daemon stdout/stderr. */
	logPath: string;
	cwd: string;
	piBin?: string;
	env?: Record<string, string>;
	/** How long to wait for the daemon to register as gateway owner. */
	waitForOwnerMs?: number;
}

export interface DaemonSpawnResult {
	status: "started" | "busy";
	pid?: number;
	owner?: GatewayOwner;
}

/** POSIX single-quote shell escaping. */
export function shellQuote(s: string): string {
	return `'${s.replace(/'/g, `'\\''`)}'`;
}

/**
 * Build the daemon shell command. `tail -f /dev/null | exec pi ...` keeps the
 * headless RPC-mode process's stdin open so it stays alive; exec replaces the
 * shell with pi so signals reach pi directly.
 */
export function buildDaemonCommand(opts: DaemonOptions): string {
	const piBin = opts.piBin ?? process.env.PI_BIN ?? "pi";
	const args = [
		"--mode",
		"rpc",
		"--no-extensions",
		"--no-skills",
		"--no-prompt-templates",
		"--no-themes",
		"--no-context-files",
		"--no-builtin-tools",
		"-e",
		opts.extensionPath,
	];
	return `tail -f /dev/null | exec ${shellQuote(piBin)} ${args.map(shellQuote).join(" ")}`;
}

export interface SpawnResult {
	status: "started" | "busy";
	pid?: number;
	owner?: GatewayOwner;
}

/** Spawn the daemon if no live owner exists (or takeover kills the old one). */
export async function spawnDaemon(
	opts: DaemonOptions,
	takeover = false,
): Promise<SpawnResult> {
	let owner = readGatewayOwner(opts.lockDir);
	// Any live owner blocks, unless takeover and it belongs to another process.
	if (owner && !takeover) {
		return { status: "busy", owner };
	}
	if (owner && owner.pid !== process.pid && takeover) {
		// Escalating kill (SIGTERM → SIGKILL) so a hung daemon can't keep the
		// gateway WS and fight the new owner; lock removed by killGatewayOwner.
		await killGatewayOwner(opts.lockDir);
	}
	// Re-check after the takeover kill.
	owner = readGatewayOwner(opts.lockDir);
	if (owner && owner.pid !== process.pid && !takeover) {
		return { status: "busy", owner };
	}
	// The owner that existed before WE spawned (normally undefined). Used to
	// distinguish "our daemon registered" from "a pre-existing owner lingers".
	const previousOwnerPid = owner?.pid;
	const logFd = openSync(opts.logPath, "a");
	const child = spawn("bash", ["-lc", buildDaemonCommand(opts)], {
		detached: true,
		cwd: opts.cwd,
		env: { ...process.env, ...opts.env, [DAEMON_ENV]: "1" },
		stdio: ["ignore", logFd, logFd],
	});
	child.unref();
	const waitMs = opts.waitForOwnerMs ?? 15_000;
	const deadline = Date.now() + waitMs;
	let registered: GatewayOwner | undefined;
	while (Date.now() < deadline) {
		await sleep(200);
		const candidate = readGatewayOwner(opts.lockDir);
		if (!candidate) continue;
		if (!isPidAlive(candidate.pid)) continue; // stale lock, daemon not registered yet
		if (previousOwnerPid !== undefined && candidate.pid === previousOwnerPid) {
			continue; // old owner hasn't yielded yet — keep waiting
		}
		// The daemon runs as `tail -f /dev/null | exec pi …`; the pi process pid
		// therefore NEVER equals the spawned bash wrapper pid (bug 2026-08-07 —
		// the old `candidate.pid === child.pid` check always reported "busy" even
		// though the daemon connected fine). Any NEW live owner = success.
		registered = candidate;
		break;
	}
	const started = Boolean(registered && registered.pid !== previousOwnerPid);
	return {
		status: started ? "started" : "busy",
		pid: registered?.pid ?? child.pid,
		owner: registered,
	};
}

function isPidAlive(pid: number): boolean {
	try {
		process.kill(pid, 0);
		return true;
	} catch (err) {
		return (err as NodeJS.ErrnoException).code === "EPERM";
	}
}

// ---------------------------------------------------------------------------
// Uninstall self-monitor (2026-08-07): pi has no uninstall hook, so `pi remove`
// never runs extension code — a detached daemon would survive uninstall and
// keep holding the gateway lock + Feishu connection (user reported confusion).
// The daemon therefore watches its own registration and exits when uninstalled.
// ---------------------------------------------------------------------------

/** pi settings files that list installed extension sources. */
export function defaultSettingsFiles(): string[] {
	return [
		join(homedir(), ".pi", "agent", "settings.json"),
		join(process.cwd(), ".pi", "settings.json"),
	];
}

/**
 * Resolve a pi package source string to a directory that contains the
 * extension. Returns undefined when the source can't be resolved locally
 * (git:/https:/ssh: URLs are installed into pi-managed caches we don't model).
 */
function resolveSourceDir(source: string, settingsDir: string): string | undefined {
	if (source.startsWith("npm:")) {
		return join(homedir(), ".pi", "agent", "npm", "node_modules", source.slice(4));
	}
	if (source.startsWith("git:") || source.startsWith("https:") || source.startsWith("ssh:")) {
		return undefined;
	}
	// Local paths (./ ../ / ~ and bare relative paths) resolve against the
	// settings file's own directory.
	return resolve(settingsDir, source);
}

/**
 * True when at least one existing settings file still lists a package source
 * whose resolved directory contains `entryPath`. Missing settings files are
 * ignored; if NO settings files exist we stay alive (conservative — the
 * extension may be run directly via `pi -e` without ever being installed).
 */
export function extensionStillRegistered(
	entryPath: string,
	settingsFiles: string[],
): boolean {
	const present = settingsFiles.filter((f) => existsSync(f));
	if (present.length === 0) return true;
	for (const file of present) {
		try {
			const raw = JSON.parse(
				readFileSync(file, "utf8"),
			) as { packages?: unknown };
			const pkgs: string[] = Array.isArray(raw?.packages)
				? raw.packages.filter((p): p is string => typeof p === "string")
				: [];
			for (const p of pkgs) {
				const base = resolveSourceDir(p, dirname(file));
				if (
					base &&
					(entryPath === base || entryPath.startsWith(base + sep))
				) {
					return true;
				}
			}
		} catch {
			/* malformed settings — skip */
		}
	}
	return false;
}

/**
 * True when the daemon should keep running: the entry file still exists AND
 * (no settings present OR the extension is still registered).
 */
export function checkUninstallCondition(
	entryPath: string,
	settingsFiles: string[],
): boolean {
	if (!existsSync(entryPath)) return false; // files deleted (npm/git uninstall)
	return extensionStillRegistered(entryPath, settingsFiles);
}

export interface UninstallWatchOptions {
	/** Extension entry file (src/index.ts) the daemon runs with. */
	entryPath: string;
	settingsFiles?: string[];
	intervalMs?: number;
	onExit?: () => void | Promise<void>;
}

/**
 * Periodically check whether the extension is still installed; when not,
 * call onExit (e.g. release the gateway lock) and terminate the process.
 * Returns a stop() handle for tests / teardown.
 */
export function startUninstallWatch(opts: UninstallWatchOptions): () => void {
	const settingsFiles = opts.settingsFiles ?? defaultSettingsFiles();
	const intervalMs = opts.intervalMs ?? 15_000;
	const timer = setInterval(() => {
		if (checkUninstallCondition(opts.entryPath, settingsFiles)) return;
		try {
			void (async () => {
				try {
					await opts.onExit?.();
				} catch {
					/* ignore */
				}
				process.exit(0);
			})();
		} catch {
			/* ignore */
		}
	}, intervalMs);
	timer.unref?.();
	return () => clearInterval(timer);
}

/**
 * Terminate the gateway owner, escalating SIGTERM → SIGKILL for unresponsive
 * (zombie/hung) daemons, then remove the lock file. Returns true when a live
 * owner was signaled. No-op when the caller itself owns the gateway.
 */
export async function killGatewayOwner(
	lockDir: string,
	opts: { sigkillAfterMs?: number } = {},
): Promise<boolean> {
	const owner = readGatewayOwner(lockDir);
	if (!owner) return false;
	if (owner.pid === process.pid) return false; // we are the owner; handled elsewhere
	const escalateAfter = opts.sigkillAfterMs ?? 1200;
	try {
		process.kill(owner.pid, "SIGTERM");
	} catch {
		/* already dead */
	}
	const deadline = Date.now() + escalateAfter;
	let alive = true;
	while (Date.now() < deadline) {
		await sleep(120);
		if (!isPidAlive(owner.pid)) {
			alive = false;
			break;
		}
	}
	if (alive) {
		// SIGTERM ignored — force-kill so the new owner's WS connection is
		// not fought over by a hung daemon (user report 2026-08-07).
		try {
			process.kill(owner.pid, "SIGKILL");
		} catch {
			/* ignore */
		}
		await sleep(150);
	}
	try {
		rmSync(join(lockDir, "gateway.json"), { force: true });
	} catch {
		/* ignore */
	}
	return true;
}

/** Signal the current gateway owner to stop (returns true if it was us/killed). */
export async function stopDaemon(lockDir: string): Promise<boolean> {
	return killGatewayOwner(lockDir);
}

function sleep(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}
