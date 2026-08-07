// Command controller (spec §8): parse "/cmd args" messages, classify against
// the whitelist/admin matrix. Pure functions.
//
// 2026-08-08 用户指令：全部放开——移除 BLOCKED_COMMANDS 与 admin 门禁。
// 桥自己的命令（ALLOWED_COMMANDS）由桥处理；其余 / 消息一律 unknown →
// 原封不动转发给 pi 原生处理（pi 命令/路径/skill）。

export const ALLOWED_COMMANDS = [
	"help",
	"status",
	"new",
	"resume",
	"model",
	"thinking",
	"stop",
	"workspace",
	"compact",
	"support",
	"feishu-config",
] as const;

export type CommandName = string;

export interface ParsedCommand {
	name: string;
	rawArgs: string;
	args: string[];
}

/** Parse "/name arg1 arg2" → { name, args }. Returns undefined if not a command. */
export function parseCommand(text: string): ParsedCommand | null {
	const trimmed = text.trim();
	if (!trimmed.startsWith("/")) return null;
	const parts = trimmed.slice(1).split(/\s+/);
	const name = parts[0] ?? "";
	if (!name) return null;
	return {
		name: name.toLowerCase(),
		rawArgs: trimmed.slice(1 + name.length).trim(),
		args: parts.slice(1).filter((a) => a.length > 0),
	};
}

export type CommandVerdict =
	| { kind: "allowed"; name: string; adminOnly: boolean }
	| { kind: "unknown"; name: string }
	| { kind: "scheduler"; name: string };

/**
 * 命令执行后是否对触发消息打 DONE 表情（2026-08-08 用户指令）：
 * 执行成功的 allowed 命令打；unknown 转发 pi 由对话流程打；scheduler 同。
 */
export function shouldMarkDoneCommand(
	verdict: CommandVerdict,
): verdict is { kind: "allowed"; name: string; adminOnly: boolean } {
	return verdict.kind === "allowed";
}

/**
 * Classify a parsed command（2026-08-08 全部放开：无 blocked、无 admin 门禁）。
 * - 桥自己的命令 → allowed（桥处理 + DONE）
 * - 定时调度关键字 → scheduler（对话流程）
 * - 其他 → unknown（原封不动转发 pi）
 */
export function classifyCommand(
	cmd: ParsedCommand,
	_isAdmin: boolean,
): CommandVerdict {
	const { name } = cmd;
	if ((ALLOWED_COMMANDS as readonly string[]).includes(name)) {
		return { kind: "allowed", name, adminOnly: false };
	}
	if (["loop", "remind", "schedule", "unschedule"].includes(name)) {
		return { kind: "scheduler", name };
	}
	return { kind: "unknown", name };
}
