// Command controller (spec §8): parse "/cmd args" messages, classify against
// the whitelist/blocklist/admin matrix. Pure functions.

export const ALLOWED_COMMANDS = [
  "help", "status", "new", "resume", "model", "thinking", "stop",
  "workspace", "compact", "support", "feishu-config",
] as const;

export const BLOCKED_COMMANDS = [
  "login", "logout", "quit", "exit", "reload", "settings", "fork",
  "clone", "tree", "clear", "redo", "undo", "theme",
] as const;

export const ADMIN_MUTATING_COMMANDS = [
  "model", "thinking", "new", "resume", "compact", "stop", "workspace", "feishu-config",
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
  | { kind: "blocked"; name: string }
  | { kind: "unknown"; name: string }
  | { kind: "scheduler"; name: string };

/** Classify a parsed command against the matrix; isAdmin gates admin-only. */
export function classifyCommand(cmd: ParsedCommand, isAdmin: boolean): CommandVerdict {
  const { name } = cmd;
  if ((ALLOWED_COMMANDS as readonly string[]).includes(name)) {
    const adminOnly = (ADMIN_MUTATING_COMMANDS as readonly string[]).includes(name);
    if (adminOnly && !isAdmin) {
      return { kind: "blocked", name };
    }
    return { kind: "allowed", name, adminOnly };
  }
  if ((BLOCKED_COMMANDS as readonly string[]).includes(name)) {
    return { kind: "blocked", name };
  }
  if (["loop", "remind", "schedule", "unschedule"].includes(name)) {
    return { kind: "scheduler", name };
  }
  return { kind: "unknown", name };
}
