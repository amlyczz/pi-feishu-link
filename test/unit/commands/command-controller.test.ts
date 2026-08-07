import test from "node:test";
import assert from "node:assert/strict";
import {
	classifyCommand,
	parseCommand,
	shouldMarkDoneCommand,
} from "../../../src/commands/command-controller.ts";

test("parseCommand parses /name args", () => {
	assert.deepEqual(parseCommand("/model"), {
		name: "model",
		rawArgs: "",
		args: [],
	});
	assert.deepEqual(parseCommand("/workspace /home/proj"), {
		name: "workspace",
		rawArgs: "/home/proj",
		args: ["/home/proj"],
	});
	assert.deepEqual(parseCommand("  /NEW  a   b "), {
		name: "new",
		rawArgs: "a   b",
		args: ["a", "b"],
	});
});

test("parseCommand returns null for non-commands", () => {
	assert.equal(parseCommand("hello"), null);
	assert.equal(parseCommand(""), null);
	assert.equal(parseCommand("/"), null);
	assert.equal(parseCommand("not a /command"), null);
});

test("shouldMarkDoneCommand: 执行成功的命令打 DONE，unknown/scheduler 不打", () => {
	assert.equal(
		shouldMarkDoneCommand({
			kind: "allowed",
			name: "workspace",
			adminOnly: false,
		}),
		true,
	);
	assert.equal(
		shouldMarkDoneCommand({ kind: "allowed", name: "new", adminOnly: true }),
		true,
	);
	assert.equal(shouldMarkDoneCommand({ kind: "unknown", name: "xyz" }), false);
	assert.equal(
		shouldMarkDoneCommand({ kind: "scheduler", name: "remind" }),
		false,
	);
});

test("classify: allowed commands for admin and non-admin", () => {
	assert.deepEqual(
		classifyCommand({ name: "status", rawArgs: "", args: [] }, false),
		{
			kind: "allowed",
			name: "status",
			adminOnly: false,
		},
	);
	assert.deepEqual(
		classifyCommand({ name: "help", rawArgs: "", args: [] }, true),
		{
			kind: "allowed",
			name: "help",
			adminOnly: false,
		},
	);
});

test("classify: 全部放开（2026-08-08）——admin 命令对非 admin 也 allowed", () => {
	const v = classifyCommand({ name: "model", rawArgs: "", args: [] }, false);
	assert.equal(v.kind, "allowed");
	assert.equal((v as { adminOnly: boolean }).adminOnly, false);
	const v2 = classifyCommand(
		{ name: "workspace", rawArgs: "/p", args: ["/p"] },
		false,
	);
	assert.equal(v2.kind, "allowed");
});

test("classify: 原 blocked 命令（login/quit/fork 等）不再拦截 → unknown 转发 pi", () => {
	for (const name of [
		"login",
		"quit",
		"reload",
		"settings",
		"fork",
		"clone",
		"tree",
		"clear",
	]) {
		const v = classifyCommand({ name, rawArgs: "", args: [] }, true);
		assert.notEqual(v.kind, "blocked", `${name} 不应被拦截`);
		assert.equal(v.kind, "unknown", `${name} 应作为 unknown 转发 pi`);
	}
});

test("classify: scheduler commands routed separately", () => {
	assert.deepEqual(
		classifyCommand(
			{ name: "loop", rawArgs: "5m x", args: ["5m", "x"] },
			false,
		),
		{
			kind: "scheduler",
			name: "loop",
		},
	);
});

test("classify: unknown commands are unknown", () => {
	assert.deepEqual(
		classifyCommand({ name: "frobnicate", rawArgs: "", args: [] }, true),
		{
			kind: "unknown",
			name: "frobnicate",
		},
	);
});
