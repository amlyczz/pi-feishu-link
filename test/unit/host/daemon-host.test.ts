import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildDaemonCommand, shellQuote, spawnDaemon, stopDaemon } from "../../../src/host/daemon-host.ts";
import { acquireGatewayLock } from "../../../src/host/gateway-lock.ts";

function tempDir(): string {
  return mkdtempSync(join(tmpdir(), "fb-daemon-"));
}

test("shellQuote wraps and escapes single quotes", () => {
  assert.equal(shellQuote("pi"), "'pi'");
  assert.equal(shellQuote("/path/with space"), "'/path/with space'");
  assert.equal(shellQuote("it's"), `'it'\\''s'`);
});

test("buildDaemonCommand constructs the headless rpc invocation", () => {
  const cmd = buildDaemonCommand({
    extensionPath: "/abs/ext/index.ts",
    lockDir: "/tmp/x",
    logPath: "/tmp/x.log",
    cwd: "/work",
    piBin: "/usr/local/bin/pi",
  });
  assert.ok(cmd.startsWith("tail -f /dev/null | exec "), cmd);
  assert.ok(cmd.includes("'--mode' 'rpc'"), cmd);
  assert.ok(cmd.includes("'--no-builtin-tools'"), cmd);
  assert.ok(cmd.includes("'-e' '/abs/ext/index.ts'"), cmd);
  assert.ok(cmd.includes("'/usr/local/bin/pi'"), cmd);
});

test("spawnDaemon refuses when another live process owns the gateway", async () => {
  const dir = tempDir();
  try {
    // A real detached child is a provably-live other process.
    const { spawn } = await import("node:child_process");
    const child = spawn("sleep", ["30"], { detached: true, stdio: "ignore" });
    child.unref();
    const lock = acquireGatewayLock(dir, { pid: child.pid! });
    assert.equal(lock.status, "acquired");
    const result = await spawnDaemon({
      extensionPath: "/nope/index.ts",
      lockDir: dir,
      logPath: join(dir, "daemon.log"),
      cwd: "/",
      waitForOwnerMs: 300,
    });
    assert.equal(result.status, "busy");
    void lock.handle?.release();
    try { process.kill(child.pid!, "SIGTERM"); } catch { /* ignore */ }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("spawnDaemon with takeover kills the old owner and spawns", async () => {
  const dir = tempDir();
  try {
    const { spawn } = await import("node:child_process");
    const oldOwner = spawn("sleep", ["30"], { detached: true, stdio: "ignore" });
    oldOwner.unref();
    const lock = acquireGatewayLock(dir, { pid: oldOwner.pid! });
    assert.equal(lock.status, "acquired");

    const result = await spawnDaemon(
      {
        extensionPath: "/nonexistent-extension-path.ts",
        lockDir: dir,
        logPath: join(dir, "daemon.log"),
        cwd: "/",
        waitForOwnerMs: 300,
      },
      true,
    );
    assert.equal(result.status, "busy", "no owner registers with a bad extension path");
    // The old owner was killed by the takeover.
    let alive = true;
    try { process.kill(oldOwner.pid!, 0); } catch { alive = false; }
    assert.equal(alive, false, "old daemon should be terminated");
    try { process.kill(oldOwner.pid!, "SIGTERM"); } catch { /* already dead */ }
    void lock.handle?.release();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("stopDaemon signals the owner pid and returns true", async () => {
  const dir = tempDir();
  try {
    // Spawn a real short-lived child as a fake daemon owner.
    const { spawn } = await import("node:child_process");
    const child = spawn("sleep", ["30"], { detached: true, stdio: "ignore" });
    child.unref();
    const lock = acquireGatewayLock(dir, { pid: child.pid! });
    assert.equal(lock.status, "acquired");
    await new Promise((r) => setTimeout(r, 100));
    const stopped = await stopDaemon(dir);
    assert.equal(stopped, true);
    await new Promise((r) => setTimeout(r, 200));
    // Child should be dead now.
    let alive = true;
    try { process.kill(child.pid!, 0); } catch { alive = false; }
    assert.equal(alive, false, "daemon child should be terminated");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("stopDaemon returns false when nobody owns the gateway", async () => {
  const dir = tempDir();
  try {
    assert.equal(await stopDaemon(dir), false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("stopDaemon escalates to SIGKILL when the owner ignores SIGTERM", async () => {
  const dir = tempDir();
  try {
    const { spawn } = await import("node:child_process");
    // A child that explicitly ignores SIGTERM — proves the SIGKILL fallback.
    const child = spawn(
      process.execPath,
      ["-e", "process.on('SIGTERM', () => {}); setInterval(() => {}, 1000);"],
      { detached: true, stdio: "ignore" },
    );
    child.unref();
    const lock = acquireGatewayLock(dir, { pid: child.pid! });
    assert.equal(lock.status, "acquired");
    const stopped = await stopDaemon(dir);
    assert.equal(stopped, true);
    // Give the escalation window time to elapse, then the child must be gone.
    await new Promise((r) => setTimeout(r, 1600));
    let alive = true;
    try { process.kill(child.pid!, 0); } catch { alive = false; }
    assert.equal(alive, false, "SIGTERM-ignoring daemon must be SIGKILLed");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("spawnDaemon reports started when a new live owner registers (daemon pid != wrapper pid)", async () => {
  const dir = tempDir();
  try {
    const { writeFileSync, chmodSync } = await import("node:fs");
    // A fake "pi" that writes gateway.json with its OWN pid then stays alive.
    // The real daemon runs via `tail -f /dev/null | exec pi …`, so the pi
    // process pid never equals the spawned bash wrapper pid — the fixed
    // spawnDaemon must treat ANY new live owner as success (bug 2026-08-07).
    const shim = join(dir, "pi");
    writeFileSync(
      shim,
      [
        "#!/bin/bash",
        "exec node -e '" +
          "const fs=require(\"fs\");" +
          "fs.writeFileSync(process.env.LOCK,JSON.stringify({pid:process.pid,startedAt:Date.now(),status:\"connected\"}));" +
          "process.on(\"SIGTERM\",()=>process.exit(0));" +
          "setInterval(()=>{},1000)'",
      ].join("\n"),
    );
    chmodSync(shim, 0o755);
    const result = await spawnDaemon(
      {
        extensionPath: "/irrelevant.ts",
        lockDir: dir,
        logPath: join(dir, "daemon.log"),
        cwd: "/",
        piBin: shim,
        env: { LOCK: join(dir, "gateway.json") },
        waitForOwnerMs: 4000,
      },
      false,
    );
    assert.equal(result.status, "started", "new live owner must be reported started");
    assert.ok(result.owner, "owner reported");
    assert.equal(
      result.pid,
      result.owner!.pid,
      "returned pid is the real daemon pid, not the bash wrapper pid",
    );
    let alive = true;
    try { process.kill(result.owner!.pid, 0); } catch { alive = false; }
    assert.equal(alive, true, "registered owner is a live process");
    // Cleanup: kill the fake daemon (node) and the wrapper chain.
    try { process.kill(result.owner!.pid, "SIGTERM"); } catch { /* ignore */ }
    try { process.kill(result.pid!, "SIGTERM"); } catch { /* ignore */ }
    try { process.kill(result.owner!.pid, "SIGKILL"); } catch { /* ignore */ }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
