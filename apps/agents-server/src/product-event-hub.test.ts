import { describe, expect, test } from "bun:test";

import { type ChatRunEvent, chatSessionsRetiredEventSchema } from "@moshu/contracts";
import type { RpcPeer } from "@moshu/process-rpc";

import {
	ProductEventRouter,
	publishChatEvent,
	publishRetiredChatSessions,
} from "./product-event-hub";

const sessionA = "01984df0-cf17-7e6e-9a7d-4d98c1f0d5ce";
const sessionB = "01984df0-cf17-7e6e-9a7d-4d98c1f0d5cf";
const runA = "01984df0-cf18-7c89-9d11-3686130434c8";
const eventId = "01984df0-cf1b-7521-a4a5-40eef114ce9f";
const messageId = "01984df0-cf1a-7178-b174-42fc83c3e87d";
const createdAt = "2026-07-25T04:15:28.349Z";

interface RecordingPeer {
	peer: RpcPeer;
	deliveries: number;
	closeCalls: number;
}

function createRecordingPeer(
	peerId: string,
	options: {
		readonly role?: RpcPeer["remoteIdentity"]["role"];
		readonly instanceId?: string;
		readonly generation?: number;
	} = {},
): RecordingPeer {
	const record: RecordingPeer = {
		deliveries: 0,
		closeCalls: 0,
		peer: undefined as unknown as RpcPeer,
	};
	record.peer = {
		remoteIdentity: {
			role: options.role ?? "client",
			peerId,
			instanceId: options.instanceId ?? crypto.randomUUID(),
			generation: options.generation ?? 1,
		},
		emitEvent() {
			record.deliveries += 1;
			return "event-id";
		},
		close() {
			record.closeCalls += 1;
		},
	} as unknown as RpcPeer;
	return record;
}

function createEvent(
	overrides: Partial<Pick<ChatRunEvent, "sessionId" | "runId" | "seq">> = {},
): ChatRunEvent {
	return {
		schemaVersion: 1,
		id: eventId,
		runId: overrides.runId ?? runA,
		sessionId: overrides.sessionId ?? sessionA,
		seq: overrides.seq ?? 1,
		type: "timeline.text.delta",
		source: { kind: "assistant" },
		visibility: "user",
		createdAt,
		payload: { partId: messageId, revision: 2, delta: "chunk" },
	};
}

function createTerminalEvent(
	overrides: Partial<Pick<ChatRunEvent, "sessionId" | "runId" | "seq">> = {},
): ChatRunEvent {
	return {
		schemaVersion: 1,
		id: eventId,
		runId: overrides.runId ?? runA,
		sessionId: overrides.sessionId ?? sessionA,
		seq: overrides.seq ?? 2,
		type: "run.status",
		source: { kind: "system" },
		visibility: "user",
		createdAt,
		payload: { previousStatus: "running", status: "completed" },
	};
}

describe("ProductEventRouter request-owner routing", () => {
	test("routes live events to the originating client peer only", () => {
		const origin = createRecordingPeer("origin-client");
		const other = createRecordingPeer("other-client");
		const router = new ProductEventRouter();
		const requestId = crypto.randomUUID();
		router.bind(requestId, origin.peer);

		router.publish([origin.peer, other.peer], createEvent(), requestId);

		expect(origin.deliveries).toBe(1);
		expect(other.deliveries).toBe(0);
	});

	test("rejects a request owned by a different client peer", () => {
		const origin = createRecordingPeer("origin-client");
		const other = createRecordingPeer("other-client");
		const router = new ProductEventRouter();
		const requestId = crypto.randomUUID();
		router.bind(requestId, origin.peer);

		expect(() => router.bind(requestId, other.peer)).toThrow("another client peer");
		router.publish([origin.peer, other.peer], createEvent(), requestId);
		expect(origin.deliveries).toBe(1);
	});

	test("keeps gen1 on a failed same-key gen2 retry and transfers only after commit", () => {
		const gen1 = createRecordingPeer("stable-client", { instanceId: "gen1", generation: 1 });
		const gen2 = createRecordingPeer("stable-client", { instanceId: "gen2", generation: 2 });
		const router = new ProductEventRouter();
		const requestId = crypto.randomUUID();
		router.bind(requestId, gen1.peer);
		const failedRetry = router.bind(requestId, gen2.peer);

		expect(failedRetry.created).toBe(false);
		router.rollback(failedRetry);
		router.publish([gen1.peer, gen2.peer], createEvent(), requestId);
		expect(gen1.deliveries).toBe(1);
		expect(gen2.deliveries).toBe(0);

		expect(router.commit(router.bind(requestId, gen2.peer))).toBe(true);
		router.releasePeer(gen1.peer);
		router.publish([gen1.peer, gen2.peer], createEvent(), requestId);
		expect(gen1.deliveries).toBe(1);
		expect(gen2.deliveries).toBe(1);
	});

	test("releases the route on terminal publication and exact peer disconnect", () => {
		const origin = createRecordingPeer("origin-client");
		const other = createRecordingPeer("other-client");
		const router = new ProductEventRouter();
		const terminalRequestId = crypto.randomUUID();
		const disconnectedRequestId = crypto.randomUUID();
		const healthyRequestId = crypto.randomUUID();
		router.bind(terminalRequestId, origin.peer);
		router.bind(disconnectedRequestId, origin.peer);
		router.bind(healthyRequestId, other.peer);

		router.publish([origin.peer, other.peer], createTerminalEvent(), terminalRequestId);
		router.publish([origin.peer, other.peer], createEvent(), terminalRequestId);
		router.releasePeer(origin.peer);
		router.publish([origin.peer, other.peer], createEvent(), disconnectedRequestId);
		router.publish([origin.peer, other.peer], createEvent(), healthyRequestId);

		expect(origin.deliveries).toBe(1);
		expect(other.deliveries).toBe(1);
	});

	test("bounds concurrent request owners and reclaims capacity on disconnect", () => {
		const owner = createRecordingPeer("stable-client");
		const router = new ProductEventRouter();
		for (let index = 0; index < 1_024; index += 1) {
			router.bind(`request-${index}`, owner.peer);
		}
		expect(() => router.bind("request-over-cap", owner.peer)).toThrow(
			"Too many active Chat send request owners",
		);
		router.releasePeer(owner.peer);
		expect(() => router.bind("request-after-cleanup", owner.peer)).not.toThrow();
	});
});

describe("ProductEventRouter Session subscription", () => {
	test("delivers a Session's events to the owner and every explicit subscriber", () => {
		const owner = createRecordingPeer("client-a");
		const observer = createRecordingPeer("client-b");
		const router = new ProductEventRouter();
		const requestId = crypto.randomUUID();
		router.bind(requestId, owner.peer);
		router.subscribe(observer.peer, sessionA);

		router.publish([owner.peer, observer.peer], createEvent({ seq: 1 }), requestId);
		router.publish([owner.peer, observer.peer], createEvent({ seq: 2 }), requestId);

		expect(owner.deliveries).toBe(2);
		expect(observer.deliveries).toBe(2);
	});

	test("scopes delivery to the subscribed Session", () => {
		const observer = createRecordingPeer("client-b");
		const router = new ProductEventRouter();
		router.subscribe(observer.peer, sessionA);

		router.publish([observer.peer], createEvent({ sessionId: sessionB }));
		expect(observer.deliveries).toBe(0);

		router.publish([observer.peer], createEvent({ sessionId: sessionA }));
		expect(observer.deliveries).toBe(1);
	});

	test("does not require the origin request id to reach subscribers", () => {
		const observer = createRecordingPeer("client-b");
		const router = new ProductEventRouter();
		router.subscribe(observer.peer, sessionA);

		router.publish([observer.peer], createEvent({ sessionId: sessionA }));
		expect(observer.deliveries).toBe(1);
	});

	test("stops delivery after an explicit unsubscribe", () => {
		const owner = createRecordingPeer("client-a");
		const observer = createRecordingPeer("client-b");
		const router = new ProductEventRouter();
		const requestId = crypto.randomUUID();
		router.bind(requestId, owner.peer);
		router.subscribe(observer.peer, sessionA);

		router.publish([owner.peer, observer.peer], createEvent({ seq: 1 }), requestId);
		router.unsubscribe(observer.peer, sessionA);
		router.publish([owner.peer, observer.peer], createEvent({ seq: 2 }), requestId);

		expect(owner.deliveries).toBe(2);
		expect(observer.deliveries).toBe(1);
	});

	test("isolates a disconnected subscriber from the still-connected owner", () => {
		const owner = createRecordingPeer("client-a");
		const observer = createRecordingPeer("client-b");
		const router = new ProductEventRouter();
		const requestId = crypto.randomUUID();
		router.bind(requestId, owner.peer);
		router.subscribe(observer.peer, sessionA);

		router.releasePeer(observer.peer);
		router.publish([owner.peer, observer.peer], createEvent({ seq: 1 }), requestId);

		expect(owner.deliveries).toBe(1);
		expect(observer.deliveries).toBe(0);
	});

	test("gives a mid-stream subscriber only events after it joins, with no duplicates", () => {
		const owner = createRecordingPeer("client-a");
		const observer = createRecordingPeer("client-b");
		const router = new ProductEventRouter();
		const requestId = crypto.randomUUID();
		router.bind(requestId, owner.peer);

		// Events observed by the owner before the second client subscribes belong to the
		// subscriber's replay window and must not be double-delivered live.
		router.publish([owner.peer, observer.peer], createEvent({ seq: 1 }), requestId);
		expect(observer.deliveries).toBe(0);

		router.subscribe(observer.peer, sessionA);
		router.publish([owner.peer, observer.peer], createEvent({ seq: 2 }), requestId);
		router.publish([owner.peer, observer.peer], createEvent({ seq: 3 }), requestId);

		expect(owner.deliveries).toBe(3);
		expect(observer.deliveries).toBe(2);
	});

	test("rejects a subscription from a non-client peer", () => {
		const runtimePeer = createRecordingPeer("runtime-box", { role: "runtime-box" });
		const router = new ProductEventRouter();
		expect(() => router.subscribe(runtimePeer.peer, sessionA)).toThrow(
			"authenticated product clients",
		);
	});
});

describe("ProductEventRouter subscription lifecycle and bounds", () => {
	test("bounds per-peer subscriptions and reclaims capacity on unsubscribe", () => {
		const router = new ProductEventRouter();
		const peer = createRecordingPeer("client-a");
		for (let index = 0; index < 256; index += 1) {
			router.subscribe(peer.peer, `session-${index}`);
		}
		expect(() => router.subscribe(peer.peer, "session-over")).toThrow(
			"too many active Session subscriptions",
		);
		router.unsubscribe(peer.peer, "session-0");
		expect(() => router.subscribe(peer.peer, "session-over")).not.toThrow();
	});

	test("bounds total subscriptions across peers and reclaims on retirement", () => {
		const router = new ProductEventRouter();
		let created = 0;
		for (let peerIndex = 0; created < 8_192; peerIndex += 1) {
			const peer = createRecordingPeer(`client-${peerIndex}`);
			for (let slot = 0; slot < 256 && created < 8_192; slot += 1) {
				router.subscribe(peer.peer, `session-${created}`);
				created += 1;
			}
		}
		const overflow = createRecordingPeer("client-overflow");
		expect(() => router.subscribe(overflow.peer, "session-overflow")).toThrow(
			"Too many active Session subscriptions",
		);
		router.retireSessions(["session-0", "session-1"]);
		expect(() => router.subscribe(overflow.peer, "session-overflow")).not.toThrow();
	});

	test("keeps a re-subscribed newer generation when the old connection closes late", () => {
		const gen1 = createRecordingPeer("stable-client", { instanceId: "gen1", generation: 1 });
		const gen2 = createRecordingPeer("stable-client", { instanceId: "gen2", generation: 2 });
		const router = new ProductEventRouter();
		router.subscribe(gen1.peer, sessionA);
		// Reconnect: the new generation re-subscribes before the old socket's close is processed.
		router.subscribe(gen2.peer, sessionA);
		router.releasePeer(gen1.peer);

		router.publish([gen2.peer], createEvent({ sessionId: sessionA }));
		expect(gen2.deliveries).toBe(1);
	});

	test("reclaims a subscription the reconnecting generation did not renew", () => {
		const gen1 = createRecordingPeer("stable-client", { instanceId: "gen1", generation: 1 });
		const gen2 = createRecordingPeer("stable-client", { instanceId: "gen2", generation: 2 });
		const router = new ProductEventRouter();
		router.subscribe(gen1.peer, sessionA);
		router.subscribe(gen1.peer, sessionB);
		// The reconnecting generation renews only Session A.
		router.subscribe(gen2.peer, sessionA);
		router.releasePeer(gen1.peer);

		router.publish([gen2.peer], createEvent({ sessionId: sessionA, seq: 1 }));
		router.publish([gen2.peer], createEvent({ sessionId: sessionB, seq: 1 }));
		expect(gen2.deliveries).toBe(1);
	});

	test("resumes delivery after a reconnect re-subscribe with no stale delivery in between", () => {
		const gen1 = createRecordingPeer("stable-client", { instanceId: "gen1", generation: 1 });
		const gen2 = createRecordingPeer("stable-client", { instanceId: "gen2", generation: 2 });
		const router = new ProductEventRouter();
		router.subscribe(gen1.peer, sessionA);
		router.releasePeer(gen1.peer);

		// After the disconnect the subscription is gone: nothing is delivered until the client
		// re-subscribes on its fresh connection.
		router.publish([gen2.peer], createEvent({ sessionId: sessionA, seq: 1 }));
		expect(gen2.deliveries).toBe(0);

		router.subscribe(gen2.peer, sessionA);
		router.publish([gen2.peer], createEvent({ sessionId: sessionA, seq: 2 }));
		expect(gen2.deliveries).toBe(1);
	});

	test("drops subscriptions when their Session is retired", () => {
		const observer = createRecordingPeer("client-b");
		const router = new ProductEventRouter();
		router.subscribe(observer.peer, sessionA);

		router.retireSessions([sessionA]);
		router.publish([observer.peer], createEvent({ sessionId: sessionA }));
		expect(observer.deliveries).toBe(0);
	});
});

describe("ProductEventRouter publication helpers", () => {
	test("isolates a failed client peer and continues broadcasting", () => {
		let failedCloseCalls = 0;
		let healthyDeliveries = 0;
		const failedPeer = {
			remoteIdentity: { role: "client", peerId: "failed", instanceId: "a", generation: 1 },
			emitEvent() {
				throw new Error("dropped frame");
			},
			close() {
				failedCloseCalls += 1;
			},
		} as unknown as RpcPeer;
		const healthyPeer = {
			remoteIdentity: { role: "client", peerId: "healthy", instanceId: "b", generation: 1 },
			emitEvent() {
				healthyDeliveries += 1;
				return "event-id";
			},
			close() {},
		} as unknown as RpcPeer;

		publishChatEvent([failedPeer, healthyPeer], createEvent(), crypto.randomUUID());
		expect(failedCloseCalls).toBe(1);
		expect(healthyDeliveries).toBe(1);
	});

	test("delivers chat events without an origin echo when none is provided", () => {
		let payloadHadRequestId = true;
		let deliveries = 0;
		const peer = {
			remoteIdentity: { role: "client", peerId: "client", instanceId: "a", generation: 1 },
			emitEvent(_method: string, payload: { clientRequestId?: string }) {
				deliveries += 1;
				payloadHadRequestId = payload.clientRequestId !== undefined;
				return "event-id";
			},
			close() {},
		} as unknown as RpcPeer;

		publishChatEvent([peer], createEvent());
		expect(deliveries).toBe(1);
		expect(payloadHadRequestId).toBe(false);
	});

	test("broadcasts bounded retired Session IDs and diagnoses isolated failures", () => {
		const sessionIds = ["018f0f2c-7b18-7abc-8def-1234567890ab"];
		const diagnostics: string[] = [];
		const deliveries: unknown[] = [];
		let failedCloseCalls = 0;
		const failedPeer = {
			remoteIdentity: { role: "client", peerId: "failed", instanceId: "a", generation: 1 },
			emitEvent() {
				throw new Error("dropped frame");
			},
			close() {
				failedCloseCalls += 1;
			},
		} as unknown as RpcPeer;
		const healthyPeer = {
			remoteIdentity: { role: "client", peerId: "healthy", instanceId: "b", generation: 1 },
			emitEvent(method: string, payload: unknown) {
				expect(method).toBe("moshu.v1.chat.sessions.retired");
				deliveries.push(chatSessionsRetiredEventSchema.parse(payload));
				return "retirement-event";
			},
			close() {},
		} as unknown as RpcPeer;

		publishRetiredChatSessions([failedPeer, healthyPeer], sessionIds, (message) =>
			diagnostics.push(message),
		);

		expect(failedCloseCalls).toBe(1);
		expect(deliveries).toEqual([{ schemaVersion: 1, sessionIds }]);
		expect(diagnostics).toHaveLength(1);
		expect(diagnostics[0]).toContain("replay will recover");
	});
});
