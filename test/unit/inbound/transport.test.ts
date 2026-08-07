import test from "node:test";
import assert from "node:assert/strict";
import {
	FatalDeliveryError,
	RetryableError,
} from "../../../src/outbound/outbox.ts";
import {
	classifyError,
	FeishuTransport,
	normalizeInbound,
	wrapSendError,
} from "../../../src/inbound/transport.ts";
import type {
	LarkSdkClient,
	LarkSdkDispatcher,
	LarkSdkLike,
	LarkSdkWsClient,
} from "../../../src/inbound/transport.ts";
import { DEFAULT_CONFIG } from "../../../src/common/config.ts";
import type { FeishuConfig } from "../../../src/common/types.ts";

// ---- error classification ----

test("classifyError: 429 and 5xx are retryable", () => {
	assert.equal(
		classifyError({ status: 429, message: "rate limited" }).kind,
		"retryable",
	);
	assert.equal(classifyError({ status: 500 }).kind, "retryable");
	assert.equal(classifyError({ status: 503 }).kind, "retryable");
	assert.equal(classifyError(new TypeError("fetch failed")).kind, "retryable");
});

test("classifyError: 4xx is fatal", () => {
	assert.equal(classifyError({ status: 400 }).kind, "fatal");
	assert.equal(classifyError({ status: 404 }).kind, "fatal");
	assert.equal(classifyError({ status: 403 }).kind, "fatal");
});

test("wrapSendError maps to typed errors", () => {
	assert.ok(wrapSendError({ status: 429 }) instanceof RetryableError);
	assert.ok(wrapSendError({ status: 404 }) instanceof FatalDeliveryError);
});

// ---- inbound normalization ----

test("normalizeInbound maps raw message", () => {
	const msg = normalizeInbound({
		message_id: "om_1",
		chat_id: "oc_1",
		chat_type: "group",
		message_type: "text",
		content: JSON.stringify({ text: "hi" }),
		sender: { sender_type: "user", sender_id: { open_id: "ou_1" } },
		root_id: "root-1",
		mentions: [{ id: { open_id: "ou_bot" } }],
		create_time: "1700000000000",
	});
	assert.ok(msg);
	assert.equal(msg.messageId, "om_1");
	assert.equal(msg.chatType, "group");
	assert.equal(msg.senderOpenId, "ou_1");
	assert.equal(msg.rootId, "root-1");
	assert.equal(msg.timestamp, 1700000000000);
});

test("normalizeInbound returns undefined without message_id", () => {
	assert.equal(normalizeInbound({ chat_id: "oc" }), undefined);
	assert.equal(normalizeInbound(null), undefined);
});

test("normalizeInbound parses v2.0 nested structure (event.message)", () => {
	// 飞书 v2.0 事件：字段嵌套在 event.message / event.sender 下
	const msg = normalizeInbound({
		sender: {
			sender_type: "user",
			sender_id: { open_id: "ou_v2" },
		},
		message: {
			message_id: "om_v2",
			chat_id: "oc_v2",
			chat_type: "p2p",
			message_type: "text",
			content: JSON.stringify({ text: "你好" }),
			create_time: "1700000000000",
		},
	});
	assert.ok(msg, "v2.0 嵌套结构应能解析");
	assert.equal(msg.messageId, "om_v2");
	assert.equal(msg.chatId, "oc_v2");
	assert.equal(msg.chatType, "p2p");
	assert.equal(msg.senderOpenId, "ou_v2");
	assert.equal(msg.senderType, "user");
	assert.equal(msg.msgType, "text");
	assert.equal(msg.content, JSON.stringify({ text: "你好" }));
});

test("normalizeInbound tolerates data.event wrapper (SDK dispatcher shape)", () => {
	// SDK EventDispatcher 传给 handler 的可能是 { event: {...} } 包装
	const msg = normalizeInbound({
		event: {
			sender: { sender_type: "user", sender_id: { open_id: "ou_w" } },
			message: {
				message_id: "om_w",
				chat_id: "oc_w",
				chat_type: "p2p",
				message_type: "text",
				content: "{}",
			},
		},
	});
	assert.ok(msg, "{ event: {...} } 包装应能解析");
	assert.equal(msg.messageId, "om_w");
});

// ---- fake SDK + transport ----

interface FakeRecord {
	url?: string;
	method?: string;
	path?: string;
	data?: unknown;
	headers?: Record<string, string>;
}

class FakeClient implements LarkSdkClient {
	records: FakeRecord[] = [];
	botInfo: Record<string, unknown> = { bot: { open_id: "ou_bot" } };
	chatMode = "group";
	tokenCalls = 0;
	request(opts: {
		url: string;
		method: string;
		headers?: Record<string, string>;
		data?: unknown;
	}): Promise<unknown> {
		this.records.push({
			url: opts.url,
			method: opts.method,
			headers: opts.headers,
			data: opts.data,
		});
		if (opts.url.includes("/auth/v3/tenant_access_token")) {
			this.tokenCalls++;
			return Promise.resolve({
				code: 0,
				tenant_access_token: "test-token",
				expire: 7200,
			});
		}
		if (opts.url.includes("/bot/v3/info")) return Promise.resolve(this.botInfo);
		if (opts.url.includes("/im/v1/chats/")) {
			return Promise.resolve({ data: { chat_mode: this.chatMode } });
		}
		return Promise.resolve({});
	}
	im = {
		message: {
			reply: async (opts: {
				path: { message_id: string };
				data: { msg_type: string };
			}) => {
				this.records.push({
					path: `reply:${opts.path.message_id}:${opts.data.msg_type}`,
				});
				return { data: { message_id: "out-1" } };
			},
			create: async (opts: {
				data: { msg_type: string; receive_id: string };
			}) => {
				this.records.push({
					path: `create:${opts.data.receive_id}:${opts.data.msg_type}`,
				});
				return { data: { message_id: "out-2" } };
			},
			patch: async () => ({ data: {} }),
			get: async () => ({
				data: {
					items: [{ message_type: "text", content: '{"text":"parent"}' }],
				},
			}),
		},
		v1: {
			image: {
				create: async () => ({ data: { image_key: "img_v2_uploaded" } }),
			},
			file: {
				create: async () => ({ data: { file_key: "file_v2_uploaded" } }),
			},
			message: {
				patch: async () => ({}),
				list: async () => ({ data: { items: [] } }),
			},
			messageResource: {
				get: async () => ({
					getReadableStream: () =>
						new ReadableStream({
							start(controller) {
								controller.enqueue(Buffer.from("bytes"));
								controller.close();
							},
						}),
					headers: { "content-type": "image/png" },
				}),
			},
		},
	};
}

class FakeDispatcher implements LarkSdkDispatcher {
	handlers: Record<string, (d: unknown) => Promise<unknown> | unknown> = {};
	register(
		h: Record<string, (d: unknown) => Promise<unknown> | unknown>,
	): FakeDispatcher {
		Object.assign(this.handlers, h);
		return this;
	}
}

class FakeWsClient implements LarkSdkWsClient {
	dispatcher: FakeDispatcher | undefined;
	started = false;
	start(opts: { eventDispatcher: FakeDispatcher }): void {
		this.dispatcher = opts.eventDispatcher;
		this.started = true;
	}
	async stop(): Promise<void> {
		this.started = false;
	}
}

function makeSdk() {
	const client = new FakeClient();
	const ws = new FakeWsClient();
	const sdk = {
		Domain: {
			Feishu: "https://open.feishu.cn",
			Lark: "https://open.larksuite.com",
		},
		// The real SDK exports class constructors; the fake wraps shared
		// instances in constructors so `new sdk.Client(...)` works in both.
		Client: class {
			constructor() {
				return client;
			}
		},
		WSClient: class {
			constructor() {
				return ws;
			}
		},
		EventDispatcher: class {
			constructor() {
				return new FakeDispatcher();
			}
		},
	} as unknown as LarkSdkLike;
	return { sdk, client, ws };
}

function makeConfig(partial: Partial<FeishuConfig> = {}): FeishuConfig {
	return {
		...DEFAULT_CONFIG,
		appId: "cli_test123",
		appSecret: "secret",
		...partial,
	};
}

test("transport start connects WS and probes bot info", async () => {
	const { sdk, client, ws } = makeSdk();
	const received: unknown[] = [];
	const t = new FeishuTransport({
		sdk,
		config: makeConfig(),
		onMessage: async (m) => {
			received.push(m);
		},
		onCardAction: async () => undefined,
	});
	await t.start();
	assert.equal(ws.started, true);
	assert.equal(t.getBotOpenId(), "ou_bot");
	assert.ok(client.records.some((r) => r.url?.includes("/bot/v3/info")));
	const probe = await t.probe();
	assert.equal(probe.ok, true);
	await t.stop();
	assert.equal(t.isRunning(), false);
});

test("degraded-root-cause: raw REST calls carry the tenant token (99991661 fix)", async () => {
	const { sdk, client } = makeSdk();
	const t = new FeishuTransport({
		sdk,
		config: makeConfig(),
		onMessage: async () => {},
		onCardAction: async () => undefined,
	});
	await t.start();
	// Every bot/chats/reactions call must go out with Authorization.
	await t.probe();
	const authed = client.records.filter(
		(r) => r.url && !r.url.includes("/auth/v3/tenant_access_token"),
	);
	assert.ok(authed.length >= 2, "bot info fetched twice (start + probe)");
	for (const rec of authed) {
		assert.equal(
			rec.headers?.Authorization,
			"Bearer test-token",
			`${rec.url} must carry Authorization`,
		);
	}
	// Token is cached: a second probe does not re-fetch it.
	const callsBefore = client.tokenCalls;
	await t.probe();
	assert.equal(client.tokenCalls, callsBefore, "token must be cached");
	await t.stop();
});

test("token fetch failure surfaces as probe failure, not a crash", async () => {
	const { sdk, client } = makeSdk();
	client.request = async (opts: {
		url: string;
		method: string;
		headers?: Record<string, string>;
	}) => {
		if (opts.url.includes("/auth/v3/tenant_access_token")) {
			throw new Error("network down");
		}
		return { bot: { open_id: "ou_bot" } };
	};
	const t = new FeishuTransport({
		sdk,
		config: makeConfig(),
		onMessage: async () => {},
		onCardAction: async () => undefined,
	});
	await assert.rejects(t.start(), /tenant_access_token|network down/);
});

test("transport start throws when bot info missing", async () => {
	const { sdk, client } = makeSdk();
	client.botInfo = {};
	const t = new FeishuTransport({
		sdk,
		config: makeConfig(),
		onMessage: async () => {},
		onCardAction: async () => undefined,
	});
	await assert.rejects(t.start());
});

test("dispatcher routes messages and card actions", async () => {
	const { sdk, ws } = makeSdk();
	const messages: unknown[] = [];
	const actions: unknown[] = [];
	const t = new FeishuTransport({
		sdk,
		config: makeConfig(),
		onMessage: async (m) => {
			messages.push(m);
		},
		onCardAction: async (a) => {
			actions.push(a);
			return { ok: true };
		},
	});
	await t.start();
	const disp = ws.dispatcher!;
	await disp.handlers["im.message.receive_v1"]!({
		event: {
			message_id: "om_1",
			chat_id: "oc_1",
			chat_type: "p2p",
			message_type: "text",
			content: '{"text":"hi"}',
		},
	});
	await new Promise((r) => setTimeout(r, 30));
	assert.equal(messages.length, 1);
	const m = messages[0] as { messageId: string; chatMode: string };
	assert.equal(m.messageId, "om_1");
	assert.equal(m.chatMode, "p2p");

	const actionResult = await disp.handlers["card.action.trigger"]!({
		context: { open_message_id: "om_9", open_chat_id: "oc_9" },
		operator: { open_id: "ou_user" },
		token: "tok",
		action: { value: { op: "approve" } },
	});
	assert.equal(actions.length, 1);
	assert.deepEqual(actionResult, { card: { type: "raw", data: { ok: true } } });
	await t.stop();
});

test("replyText/sendText/replyCard hit the SDK and return message ids", async () => {
	const { sdk, client } = makeSdk();
	const t = new FeishuTransport({
		sdk,
		config: makeConfig(),
		onMessage: async () => {},
		onCardAction: async () => undefined,
	});
	await t.start();
	const id1 = await t.replyText("om_1", "hello");
	assert.equal(id1, "out-1");
	const id2 = await t.sendText("oc_2", "world");
	assert.equal(id2, "out-2");
	const id3 = await t.replyCard("om_3", { schema: "2.0" });
	assert.equal(id3, "out-1");
	assert.ok(client.records.some((r) => r.path === "reply:om_1:text"));
	await t.stop();
});

test("send before start throws fatal", async () => {
	const { sdk } = makeSdk();
	const t = new FeishuTransport({
		sdk,
		config: makeConfig(),
		onMessage: async () => {},
		onCardAction: async () => undefined,
	});
	await assert.rejects(t.sendText("oc", "x"), FatalDeliveryError);
});

test("downloadResource streams bytes with mime type", async () => {
	const { sdk } = makeSdk();
	const t = new FeishuTransport({
		sdk,
		config: makeConfig(),
		onMessage: async () => {},
		onCardAction: async () => undefined,
	});
	await t.start();
	const res = await t.downloadResource("om_1", "file_key_1", "image");
	assert.equal(res.bytes.toString(), "bytes");
	assert.equal(res.mimeType, "image/png");
	await t.stop();
});

test("getMessage returns parent message body", async () => {
	const { sdk } = makeSdk();
	const t = new FeishuTransport({
		sdk,
		config: makeConfig(),
		onMessage: async () => {},
		onCardAction: async () => undefined,
	});
	await t.start();
	const parent = await t.getMessage("om_parent");
	assert.equal(parent?.content, '{"text":"parent"}');
	await t.stop();
});

test("uploadImage/sendImage and uploadFile/sendFile (M7 media)", async () => {
	const { sdk, client } = makeSdk();
	const t = new FeishuTransport({
		sdk,
		config: makeConfig(),
		onMessage: async () => {},
		onCardAction: async () => undefined,
	});
	await t.start();
	const imgKey = await t.uploadImage(Buffer.from("png").toString("base64"));
	assert.equal(imgKey, "img_v2_uploaded");
	const imgMsgId = await t.sendImage("oc_1", imgKey);
	assert.equal(imgMsgId, "out-2");
	assert.ok(client.records.some((r) => r.path === "create:oc_1:image"));

	const fileKey = await t.uploadFile(
		"report.pdf",
		Buffer.from("pdf").toString("base64"),
	);
	assert.equal(fileKey, "file_v2_uploaded");
	const fileMsgId = await t.sendFile("oc_1", fileKey);
	assert.equal(fileMsgId, "out-2");
	assert.ok(client.records.some((r) => r.path === "create:oc_1:file"));
	await t.stop();
});

test("upload before start throws fatal", async () => {
	const { sdk } = makeSdk();
	const t = new FeishuTransport({
		sdk,
		config: makeConfig(),
		onMessage: async () => {},
		onCardAction: async () => undefined,
	});
	await assert.rejects(t.uploadImage("eA=="), FatalDeliveryError);
});

test("M3: business error codes (HTTP 200 + code) classify deterministically", () => {
	// Known transient codes → retryable.
	assert.equal(
		classifyError({ code: 99991663, msg: "internal" }).kind,
		"retryable",
	);
	assert.equal(
		classifyError({ code: 10002, msg: "rate limit" }).kind,
		"retryable",
	);
	// Other business codes are deterministic request errors → fatal.
	assert.equal(
		classifyError({ code: 230001, msg: "chat not exist" }).kind,
		"fatal",
	);
	assert.equal(
		classifyError({ code: 190001, msg: "permission denied" }).kind,
		"fatal",
	);
	// code 0 / missing code keeps the old behavior.
	assert.equal(classifyError({ code: 0, msg: "ok" }).kind, "retryable");
	assert.equal(classifyError(new Error("boom")).kind, "retryable");
});
