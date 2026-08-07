import test from "node:test";
import assert from "node:assert/strict";
import { ConnectionSupervisor } from "../../../src/inbound/connection-supervisor.ts";
import type { ConnState } from "../../../src/common/types.ts";
import type {
	SupervisorTransport,
	ConnectionSupervisorOptions,
} from "../../../src/inbound/connection-supervisor.ts";

class FakeTransport implements SupervisorTransport {
	startCalls = 0;
	stopCalls = 0;
	probeOk = true;
	probeCalls = 0;
	failStart = false;
	started = false;

	async start(): Promise<void> {
		this.startCalls++;
		if (this.failStart) throw new Error("start failed");
		this.started = true;
	}
	async stop(): Promise<void> {
		this.stopCalls++;
		this.started = false;
	}
	async probe(): Promise<{ ok: boolean; latencyMs: number }> {
		this.probeCalls++;
		return { ok: this.probeOk, latencyMs: 42 };
	}
}

function makeSupervisor(
	transport: FakeTransport,
	overrides: Partial<ConnectionSupervisorOptions> = {},
) {
	let now = 0;
	const states: Array<{ state: ConnState; detail?: string }> = [];
	const events: { onRecovered: number[]; onDownReport: number[] } = {
		onRecovered: [],
		onDownReport: [],
	};
	const sup = new ConnectionSupervisor({
		transport,
		tickIntervalMs: 15_000,
		probeIntervalMs: 1_000,
		silenceSuspectMs: 5_000,
		reconnectBackoffBaseMs: 10,
		reconnectBackoffMaxMs: 50,
		downReportEnabled: true,
		onStateChange: (state: ConnState, detail?: string) =>
			states.push({ state, detail }),
		onRecovered: (ms: number) => {
			events.onRecovered.push(ms);
		},
		onDownReport: (ms: number) => {
			events.onDownReport.push(ms);
		},
		now: () => now,
		...overrides,
	});
	return {
		sup,
		transport,
		states,
		events,
		advance: (ms: number) => {
			now += ms;
		},
	};
}

test("start connects and reaches connected", async () => {
	const t = new FakeTransport();
	const { sup } = makeSupervisor(t);
	await sup.start();
	assert.equal(t.startCalls, 1);
	assert.equal(sup.getState(), "connected");
	await sup.stop();
});

test("connect failure → degraded, then backoff retries until connected", async () => {
	const t = new FakeTransport();
	t.failStart = true;
	const { sup, states } = makeSupervisor(t);
	await sup.start();
	assert.equal(sup.getState(), "degraded");
	// Wait out the backoff retry (base 10ms → retry).
	t.failStart = false;
	await new Promise((r) => setTimeout(r, 60));
	assert.equal(sup.getState(), "connected");
	assert.ok(states.some((s) => s.state === "degraded"));
	await sup.stop();
});

test("event silence beyond threshold triggers unconditional rebuild", async () => {
	const t = new FakeTransport();
	const { sup, advance } = makeSupervisor(t);
	await sup.start();
	const startCalls = t.startCalls;
	assert.equal(sup.getState(), "connected");
	advance(6_000); // beyond silenceSuspectMs (5000)
	await sup.tick();
	assert.ok(
		t.startCalls > startCalls,
		"transport rebuilt despite healthy probe",
	);
	await sup.stop();
});

test("events reset the silence timer (no rebuild while active)", async () => {
	const t = new FakeTransport();
	const { sup, advance } = makeSupervisor(t);
	await sup.start();
	const startCalls = t.startCalls;
	for (let i = 0; i < 5; i++) {
		advance(4_000);
		sup.recordEvent();
		await sup.tick();
	}
	assert.equal(t.startCalls, startCalls);
	await sup.stop();
});

test("probe failures degrade after threshold, probe recovery restores", async () => {
	const t = new FakeTransport();
	const { sup, advance } = makeSupervisor(t);
	await sup.start();
	assert.equal(sup.getState(), "connected");
	t.probeOk = false;
	// probeIntervalMs = 1000; tick at 1s, 2s, 3s → 3 failures → degraded
	advance(1_000);
	await sup.tick();
	advance(1_000);
	await sup.tick();
	advance(1_000);
	await sup.tick();
	assert.equal(sup.getState(), "degraded");
	// recovery
	t.probeOk = true;
	advance(1_000);
	await sup.tick();
	assert.equal(sup.getState(), "connected");
	await sup.stop();
});

test("down report fires after 5+ consecutive connect failures, once", async () => {
	const t = new FakeTransport();
	t.failStart = true;
	const { sup, events } = makeSupervisor(t, { downReportEnabled: true });
	await sup.start();
	assert.equal(sup.getState(), "degraded");
	// Each backoff retry fails; after 5 attempts onDownReport fires.
	await new Promise((r) => setTimeout(r, 300));
	assert.equal(events.onDownReport.length, 1);
	await sup.stop();
});

test("recovery via event after restart emits onRecovered with down duration", async () => {
	const t = new FakeTransport();
	const { sup, advance, events } = makeSupervisor(t);
	await sup.start();
	// Force a silence rebuild → connect success triggers recovery notification.
	advance(6_000);
	await sup.tick();
	assert.ok(t.startCalls >= 2);
	assert.ok(events.onRecovered.length >= 1, "recovery reported after rebuild");
	await sup.stop();
});

test("tick is a no-op when stopped", async () => {
	const t = new FakeTransport();
	const { sup } = makeSupervisor(t);
	await sup.stop();
	const startCalls = t.startCalls;
	await sup.tick();
	assert.equal(t.startCalls, startCalls);
});
