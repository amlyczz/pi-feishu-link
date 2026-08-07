// runSetup 阶段回调（UX 2026-08-07）：setup 期间把阶段状态透传给调用方，
// 让 TUI 能显示 loading/进度，回调到达时醒目提示。
//
// 安全约定（2026-08-07 事故教训）：withHome 必须 await async 回调，且每个
// 测试断言 rootDir() 位于临时 home 内——绝不触碰真实 ~/.pi/agent/feishu-link。

import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	BRIDGE_HOME_ENV,
	loadConfig,
	rootDir,
} from "../../../src/common/config.ts";
import { runSetup, type RegisterAppFn } from "../../../src/host/auth-setup.ts";

async function withHome<T>(fn: (home: string) => Promise<T>): Promise<T> {
	const dir = mkdtempSync(join(tmpdir(), "feishu-auth-"));
	const prev = process.env[BRIDGE_HOME_ENV];
	process.env[BRIDGE_HOME_ENV] = dir;
	try {
		return await fn(dir);
	} finally {
		if (prev === undefined) delete process.env[BRIDGE_HOME_ENV];
		else process.env[BRIDGE_HOME_ENV] = prev;
		rmSync(dir, { recursive: true, force: true });
	}
}

test("auto 模式：阶段回调按序触发，凭据落盘", async () => {
	await withHome(async (home) => {
		// 守卫：写入路径必须隔离在临时 home 内（防污染真实配置）。
		assert.equal(rootDir(), home);
		const stages: string[] = [];
		const registerApp: RegisterAppFn = async () => ({
			client_id: "cli_test123",
			client_secret: "secret",
			user_info: { tenant_brand: "feishu" },
		});
		const cfg = await runSetup({
			mode: "auto",
			groupPolicy: "open",
			onStage: (s) => stages.push(s),
			registerApp,
		});
		assert.equal(cfg.appId, "cli_test123");
		assert.equal(cfg.appSecret, "secret");
		assert.equal(cfg.domain, "feishu");
		assert.deepEqual(stages, ["creating", "callback", "saved"]);
		// 已持久化，可重新加载
		const loaded = loadConfig();
		assert.equal(loaded?.appId, "cli_test123");
	});
});

test("auto 模式：lark 租户 → domain 判定为 lark", async () => {
	await withHome(async (home) => {
		assert.equal(rootDir(), home);
		const cfg = await runSetup({
			mode: "auto",
			groupPolicy: "open",
			registerApp: async () => ({
				client_id: "cli_lark123",
				client_secret: "s",
				user_info: { tenant_brand: "lark" },
			}),
		});
		assert.equal(cfg.domain, "lark");
	});
});

test("auto 模式：回调未带回凭据 → 报错且不落盘", async () => {
	await assert.rejects(
		() =>
			withHome(async (home) => {
				assert.equal(rootDir(), home);
				await runSetup({
					mode: "auto",
					groupPolicy: "open",
					registerApp: async () => ({}),
				});
			}),
		/未拿到凭据/,
	);
});

test("auto 模式：未提供 registerApp → 报错", async () => {
	await assert.rejects(
		() =>
			withHome(async (home) => {
				assert.equal(rootDir(), home);
				await runSetup({ mode: "auto", groupPolicy: "open" });
			}),
		/registerApp 未提供/,
	);
});

test("manual 模式：缺 AppID/Secret → 报错；齐全则落盘", async () => {
	await withHome(async (home) => {
		assert.equal(rootDir(), home);
		await assert.rejects(
			() => runSetup({ mode: "manual", appId: "", groupPolicy: "open" }),
			/需要 AppID/,
		);
		const cfg = await runSetup({
			mode: "manual",
			appId: "cli_manual1",
			appSecret: "sec",
			domain: "feishu",
			groupPolicy: "mention",
		});
		assert.equal(cfg.appId, "cli_manual1");
		assert.equal(cfg.groupPolicy, "mention");
	});
});
