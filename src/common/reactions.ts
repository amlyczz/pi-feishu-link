// 表情回执策略（用户指令 2026-08-07）：
//   - 收到用户消息 → 随机池取一枚表情（"已收到"即时反馈）
//   - 回合/任务完成 → 对触发消息打 DONE 表情
// 约束：DONE 永不参与随机池（任务完成标记专用）。

export const DONE_EMOJI = "DONE" as const;

/** 默认随机表情池（飞书 reaction emoji_type，全部排除 DONE）。
 * 2026-08-08 修复：FIRE → Fire（飞书 emoji_type 大小写敏感，FIRE 无效）。 */
export const REACTION_POOL: readonly string[] = [
	"THUMBSUP",
	"OK",
	"HEART",
	"LAUGH",
	"SMILE",
	"WOW",
	"CLAP",
	"Fire",
	"AMAZE",
	"AWESOME",
	"COOL",
] as const;

/**
 * 从池中随机取一枚表情。
 * - 传入池为空 / 全为 DONE → 回退默认池（默认池已排除 DONE）
 * - 无论池内容如何，返回值永不为 DONE
 * - rng 可注入（测试确定性），默认 Math.random
 */
export function pickRandomReaction(
	pool: readonly string[] | undefined = REACTION_POOL,
	rng: () => number = Math.random,
): string {
	const source = pool && pool.length > 0 ? pool : REACTION_POOL;
	const candidates = source.filter((e) => e !== DONE_EMOJI);
	const usable = candidates.length > 0 ? candidates : REACTION_POOL;
	const idx = Math.floor(rng() * usable.length) % usable.length;
	// idx 恒在界内（对 length 取模），非空断言仅为满足 noUncheckedIndexedAccess
	return usable[idx] as string;
}
