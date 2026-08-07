// 表情回执策略（用户指令 2026-08-07）：
// 1. 收到用户消息 → 从随机池取一枚表情（池内排除 DONE，"已收到"即时反馈）
// 2. 任务完成 → 对触发消息打 DONE 表情（DONE 永不参与随机池）

import test from "node:test";
import assert from "node:assert/strict";
import {
	DONE_EMOJI,
	REACTION_POOL,
	pickRandomReaction,
} from "../../../src/common/reactions.ts";

test("默认随机池不包含 DONE", () => {
	assert.ok(REACTION_POOL.length >= 3, "池至少 3 枚");
	assert.ok(!REACTION_POOL.includes(DONE_EMOJI), "DONE 永不进随机池");
});

test("pickRandomReaction 返回池内成员（注入 rng 确定性）", () => {
	assert.equal(pickRandomReaction(REACTION_POOL, () => 0), REACTION_POOL[0]);
	const last = REACTION_POOL[REACTION_POOL.length - 1];
	assert.equal(pickRandomReaction(REACTION_POOL, () => 0.999999), last);
});

test("池内即便包含 DONE 也不会被随机到（用户要求）", () => {
	const pool = ["DONE", "THUMBSUP", "HEART"];
	for (let i = 0; i < 50; i++) {
		assert.notEqual(pickRandomReaction(pool), "DONE");
	}
});

test("空池 / 全 DONE 池回退到默认池", () => {
	assert.ok(REACTION_POOL.includes(pickRandomReaction([], () => 0)));
	assert.ok(REACTION_POOL.includes(pickRandomReaction(["DONE"], () => 0)));
});

test("自定义池生效", () => {
	assert.equal(pickRandomReaction(["FIRE", "CLAP"], () => 0), "FIRE");
	assert.equal(pickRandomReaction(["FIRE", "CLAP"], () => 0.5), "CLAP");
});

test("未传池时使用默认池", () => {
	assert.ok(REACTION_POOL.includes(pickRandomReaction(undefined, () => 0.13)));
});

test("DEFAULT_CONFIG 接线：doneEmoji=DONE 且 emojis 池排除 DONE", async () => {
	const { loadConfig } = await import("../../../src/common/config.ts");
	const cfg = loadConfig();
	// 无配置时 loadConfig 返回 undefined；直接断言 DEFAULT_CONFIG 形状
	const { DEFAULT_CONFIG } = await import("../../../src/common/config.ts");
	const r = DEFAULT_CONFIG.forward.reactions;
	assert.equal(r.doneEmoji, "DONE");
	assert.ok(!r.emojis.includes("DONE"));
	assert.ok(r.emojis.length >= 3);
});
