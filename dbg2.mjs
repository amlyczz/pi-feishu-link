import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Outbox } from "./src/outbound/outbox.ts";
const dir = mkdtempSync(join(tmpdir(), "dbg-"));
const order = [];
let failFirst = true;
const outbox = new Outbox({
  dir,
  sender: async (env) => {
    const t = env.payload?.text ?? "?";
    order.push(t);
    if (t.includes("msg-1") && failFirst) { failFirst = false; throw new Error("tmp"); }
    return {};
  },
  maxAttemptsBeforeAlert: 3, sentRetentionMs: 60000, maxPendingEnvelopes: 100,
  maxEnvelopeBytes: 1024, maxOutboxDirBytes: 10000000, compactIntervalMs: 0,
  backoffBaseMs: 100, backoffMaxMs: 200,
});
await outbox.init();
await outbox.enqueue({ dedupeKey: "a1", laneKey: "l", route: { conversationKey: "l", chatId: "oc_l", chatType: "p2p" }, kind: "final", payload: { type: "text", text: "lane-a-msg-1" } });
await outbox.enqueue({ dedupeKey: "a2", laneKey: "l", route: { conversationKey: "l", chatId: "oc_l", chatType: "p2p" }, kind: "final", payload: { type: "text", text: "lane-a-msg-2" } });
await outbox.drainIdle();
console.log("order:", JSON.stringify(order));
await outbox.close();
rmSync(dir, { recursive: true, force: true });
process.exit(0);
