// Daemon host (spec §6.10 / FR-15): spawn a detached headless pi process that
// owns the Feishu gateway, so the bridge survives TUI exit. The TUI process
// manages the daemon lifecycle (start/stop/restart/takeover) and attaches
// read-only via the gateway file lock.

import { spawn } from "node:child_process";
import { openSync, rmSync } from "node:fs";
import { join } from "node:path";
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
    "--mode", "rpc",
    "--no-extensions",
    "--no-skills",
    "--no-prompt-templates",
    "--no-themes",
    "--no-context-files",
    "--no-builtin-tools",
    "-e", opts.extensionPath,
  ];
  return `tail -f /dev/null | exec ${shellQuote(piBin)} ${args.map(shellQuote).join(" ")}`;
}

export interface SpawnResult {
  status: "started" | "busy";
  pid?: number;
  owner?: GatewayOwner;
}

/** Spawn the daemon if no live owner exists (or takeover kills the old one). */
export async function spawnDaemon(opts: DaemonOptions, takeover = false): Promise<SpawnResult> {
  let owner = readGatewayOwner(opts.lockDir);
  // Any live owner blocks, unless takeover and it belongs to another process.
  if (owner && !takeover) {
    return { status: "busy", owner };
  }
  if (owner && owner.pid !== process.pid && takeover) {
    try { process.kill(owner.pid, "SIGTERM"); } catch { /* already dead */ }
    await sleep(500);
    // Remove the now-stale lock file so the daemon can acquire cleanly.
    try { rmSync(join(opts.lockDir, "gateway.json"), { force: true }); } catch { /* ignore */ }
  }
  // Re-check after the takeover kill.
  owner = readGatewayOwner(opts.lockDir);
  if (owner && owner.pid !== process.pid && !takeover) {
    return { status: "busy", owner };
  }
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
    registered = candidate;
    if (registered.pid === child.pid) break;
    if (registered.pid !== child.pid) break; // someone else took over
  }
  return {
    status: registered && registered.pid === child.pid ? "started" : "busy",
    pid: child.pid,
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

/** Signal the current gateway owner to stop (returns true if it was us/killed). */
export async function stopDaemon(lockDir: string): Promise<boolean> {
  const owner = readGatewayOwner(lockDir);
  if (!owner) return false;
  if (owner.pid === process.pid) return false; // we are the owner; handled elsewhere
  try {
    process.kill(owner.pid, "SIGTERM");
    return true;
  } catch {
    return false;
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
