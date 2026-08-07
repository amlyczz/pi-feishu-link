import test from "node:test";
import assert from "node:assert/strict";
import { classifyCommand, parseCommand } from "../../../src/commands/command-controller.ts";

test("parseCommand parses /name args", () => {
  assert.deepEqual(parseCommand("/model"), { name: "model", rawArgs: "", args: [] });
  assert.deepEqual(parseCommand("/workspace /home/proj"), {
    name: "workspace",
    rawArgs: "/home/proj",
    args: ["/home/proj"],
  });
  assert.deepEqual(parseCommand("  /NEW  a   b "), { name: "new", rawArgs: "a   b", args: ["a", "b"] });
});

test("parseCommand returns null for non-commands", () => {
  assert.equal(parseCommand("hello"), null);
  assert.equal(parseCommand(""), null);
  assert.equal(parseCommand("/"), null);
  assert.equal(parseCommand("not a /command"), null);
});

test("classify: allowed commands for admin and non-admin", () => {
  assert.deepEqual(classifyCommand({ name: "status", rawArgs: "", args: [] }, false), {
    kind: "allowed",
    name: "status",
    adminOnly: false,
  });
  assert.deepEqual(classifyCommand({ name: "help", rawArgs: "", args: [] }, true), {
    kind: "allowed",
    name: "help",
    adminOnly: false,
  });
});

test("classify: admin-only commands blocked for non-admin", () => {
  const v = classifyCommand({ name: "model", rawArgs: "", args: [] }, false);
  assert.equal(v.kind, "blocked");
  const v2 = classifyCommand({ name: "workspace", rawArgs: "/p", args: ["/p"] }, true);
  assert.equal(v2.kind, "allowed");
  assert.ok((v2 as { adminOnly: boolean }).adminOnly);
});

test("classify: blocked commands always blocked", () => {
  for (const name of ["login", "quit", "reload", "settings", "fork", "clone", "tree", "clear"]) {
    const v = classifyCommand({ name, rawArgs: "", args: [] }, true);
    assert.equal(v.kind, "blocked", `${name} should be blocked`);
  }
});

test("classify: scheduler commands routed separately", () => {
  assert.deepEqual(classifyCommand({ name: "loop", rawArgs: "5m x", args: ["5m", "x"] }, false), {
    kind: "scheduler",
    name: "loop",
  });
});

test("classify: unknown commands are unknown", () => {
  assert.deepEqual(classifyCommand({ name: "frobnicate", rawArgs: "", args: [] }, true), {
    kind: "unknown",
    name: "frobnicate",
  });
});
