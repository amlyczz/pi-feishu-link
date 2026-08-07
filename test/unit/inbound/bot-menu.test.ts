import test from "node:test";
import assert from "node:assert/strict";
import {
	BOT_MENU_EVENT,
	BOT_MENU_RECOMMENDATION,
	menuKeyToCommand,
	parseBotMenuEvent,
	buildMenuGuideText,
} from "../../../src/inbound/bot-menu.ts";

test("BOT_MENU_EVENT 为 application.bot.menu_v6（SDK 注册键）", () => {
	assert.equal(BOT_MENU_EVENT, "application.bot.menu_v6");
});

test("推荐菜单：每个 key 都能映射到 /cmd 命令", () => {
	for (const item of BOT_MENU_RECOMMENDATION) {
		assert.ok(item.key, "key 非空");
		assert.ok(item.label, "label 非空");
		const cmd = menuKeyToCommand(item.key);
		assert.ok(cmd, `${item.key} 应映射到命令`);
		assert.ok(cmd.startsWith("/"), `${item.key} 映射应为命令文案`);
	}
});

test("menuKeyToCommand：已知 key → /cmd；未知 key → null", () => {
	assert.equal(menuKeyToCommand("status"), "/status");
	assert.equal(menuKeyToCommand("help"), "/help");
	assert.equal(menuKeyToCommand("schedule"), "/schedule");
	assert.equal(menuKeyToCommand("unknown_menu"), null);
	assert.equal(menuKeyToCommand(""), null);
});

test("parseBotMenuEvent：schema 2.0 原始结构（data.event 包裹）", () => {
	const parsed = parseBotMenuEvent({
		schema: "2.0",
		header: { event_type: BOT_MENU_EVENT },
		event: {
			event_key: "status",
			operator: {
				operator_id: { open_id: "ou_test123", user_id: "u1", union_id: "x1" },
			},
		},
	});
	assert.deepEqual(parsed, { eventKey: "status", operatorOpenId: "ou_test123" });
});

test("parseBotMenuEvent：SDK 拍平结构（无 data.event 包裹）", () => {
	const parsed = parseBotMenuEvent({
		event_key: "help",
		operator: { operator_id: { open_id: "ou_flat" } },
	});
	assert.deepEqual(parsed, { eventKey: "help", operatorOpenId: "ou_flat" });
});

test("parseBotMenuEvent：缺 event_key / operator → null", () => {
	assert.equal(parseBotMenuEvent(null), null);
	assert.equal(parseBotMenuEvent(undefined), null);
	assert.equal(parseBotMenuEvent("nope"), null);
	assert.equal(parseBotMenuEvent({ event_key: "help" }), null); // 无 operator
	assert.equal(parseBotMenuEvent({ operator: { operator_id: {} } }), null);
	assert.equal(
		parseBotMenuEvent({ event_key: "", operator: { operator_id: { open_id: "ou" } } }),
		null,
	);
});

test("buildMenuGuideText：包含配置路径、直达链接、event_key 清单", () => {
	const text = buildMenuGuideText("cli_test123", "feishu");
	assert.ok(text.includes("开发者后台"));
	assert.ok(text.includes("open.feishu.cn/app/cli_test123"));
	assert.ok(text.includes("悬浮菜单"));
	for (const item of BOT_MENU_RECOMMENDATION) {
		assert.ok(text.includes(item.key), `引导应包含 event_key: ${item.key}`);
	}
	const larkText = buildMenuGuideText("cli_lark", "lark");
	assert.ok(larkText.includes("open.larksuite.com/app/cli_lark"));
});
