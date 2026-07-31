import type {
	ChatMessage,
	ChatRun,
	ChatRunEvent,
	GetChatSessionPageOutput,
} from "@moshu/contracts";
import type { MobileProductClient } from "../src/rpc/product-client";
import type {
	BeginPairingOptions,
	BeginPairingResult,
	ConnectResult,
	MobileTransportBinding,
	MobileTransportListenerHandle,
	MobileTransportPlugin,
	MobileTransportStatus,
	PairingPollResult,
	ScanPairingQrResult,
	TransportFrameEvent,
	TransportStateEvent,
} from "../src/native";

let counter = 0;

/** Deterministic, schema-valid UUIDv7 string generator for fixtures. */
export function v7(seed?: number): string {
	const n = seed ?? ++counter;
	const hex = n.toString(16).padStart(12, "0");
	return `00000000-0000-7000-8000-${hex}`;
}

const ISO = "2025-01-01T00:00:00.000Z";

export function makeUserMessage(id: string, sessionId: string, sequence: number, content = "hi"): ChatMessage {
	return {
		schemaVersion: 1,
		id,
		sessionId,
		sequence,
		role: "user",
		status: "complete",
		content,
		createdAt: ISO,
		updatedAt: ISO,
	};
}

export function makeAssistantMessage(
	id: string,
	sessionId: string,
	sequence: number,
	content: string,
	status: "streaming" | "complete" = "complete",
): ChatMessage {
	return {
		schemaVersion: 1,
		id,
		sessionId,
		sequence,
		role: "assistant",
		status,
		content,
		createdAt: ISO,
		updatedAt: ISO,
	} as ChatMessage;
}

export function makeRun(id: string, sessionId: string, status: ChatRun["status"]): ChatRun {
	return {
		schemaVersion: 1,
		id,
		sessionId,
		runtimeBoxId: "box-1",
		mode: "agent",
		status,
		provider: {
			schemaVersion: 1,
			providerId: "prov-1",
			name: "Test",
			source: "builtin",
			api: "responses",
			model: "m1",
			status: "ready",
		},
		userMessageId: v7(),
		createdAt: ISO,
		updatedAt: ISO,
	} as ChatRun;
}

/** Minimal chat run event — the reducer/controller read only `type`/`runId`/`seq`/`payload`. */
export function runStatusEvent(runId: string, sessionId: string, seq: number, status: ChatRun["status"]): ChatRunEvent {
	return {
		schemaVersion: 1,
		id: v7(),
		runId,
		sessionId,
		seq,
		type: "run.status",
		source: { kind: "system" },
		visibility: "user",
		createdAt: ISO,
		payload: { status },
	} as unknown as ChatRunEvent;
}

export function messageStartedEvent(runId: string, sessionId: string, seq: number, messageId: string): ChatRunEvent {
	return {
		schemaVersion: 1,
		id: v7(),
		runId,
		sessionId,
		seq,
		type: "message.started",
		source: { kind: "assistant" },
		visibility: "user",
		createdAt: ISO,
		payload: { messageId, role: "assistant", status: "streaming" },
	} as unknown as ChatRunEvent;
}

export function messageDeltaEvent(
	runId: string,
	sessionId: string,
	seq: number,
	messageId: string,
	delta: string,
): ChatRunEvent {
	return {
		schemaVersion: 1,
		id: v7(),
		runId,
		sessionId,
		seq,
		type: "message.delta",
		source: { kind: "assistant" },
		visibility: "user",
		createdAt: ISO,
		payload: { messageId, delta },
	} as unknown as ChatRunEvent;
}

export function messageCompletedEvent(
	runId: string,
	sessionId: string,
	seq: number,
	messageId: string,
	content: string,
): ChatRunEvent {
	return {
		schemaVersion: 1,
		id: v7(),
		runId,
		sessionId,
		seq,
		type: "message.completed",
		source: { kind: "assistant" },
		visibility: "user",
		createdAt: ISO,
		payload: { messageId, status: "complete", content },
	} as unknown as ChatRunEvent;
}

export function makeSessionPage(
	sessionId: string,
	overrides: Partial<GetChatSessionPageOutput> = {},
): GetChatSessionPageOutput {
	return {
		session: {
			schemaVersion: 1,
			id: sessionId,
			agentSessionId: v7(),
			runtimeBoxId: "box-1",
			title: "Test session",
			defaultMode: "agent",
			createdAt: ISO,
			updatedAt: ISO,
		},
		messages: [],
		runs: [],
		eventCursors: [],
		...overrides,
	} as GetChatSessionPageOutput;
}

export function makeBinding(overrides: Partial<MobileTransportBinding> = {}): MobileTransportBinding {
	return {
		agentServerId: "22222222-2222-4222-8222-222222222222",
		mobileClientId: "mobile-client-01",
		deviceKeyId: "device-key-01",
		serverPublicKeyFingerprint: "SHA256:server-fp",
		devicePublicKeyFingerprint: "SHA256:device-fp",
		protocolVersion: 1,
		transportSecurity: "relay-tls",
		serverLabel: "Desktop (dev tunnel)",
		...overrides,
	};
}

export function makeConnectResult(overrides: Partial<ConnectResult> = {}): ConnectResult {
	return {
		connectionId: "conn-1",
		localIdentity: { role: "mobile-client", peerId: "mobile-client-01", instanceId: "i-1", generation: 1 },
		serverIdentity: { role: "agents", peerId: "agents-1", instanceId: "ai-1", generation: 3 },
		negotiatedProtocolVersion: 1,
		transportSecurity: "relay-tls",
		...overrides,
	};
}

/**
 * Scriptable fake native transport. Tests set the queued pairing/connect behavior and can push
 * `frame`/`connectionState` events to registered listeners.
 */
export class FakeTransport implements MobileTransportPlugin {
	status: MobileTransportStatus = { state: "unpaired" };
	pollQueue: PairingPollResult[] = [];
	beginResult: BeginPairingResult | Error = {
		pairingId: v7(),
		deviceDisplayName: "iPhone",
		serverPublicKeyFingerprint: "SHA256:server-fp",
	};
	connectResult: ConnectResult | Error = makeConnectResult();
	scanResult: ScanPairingQrResult = { status: "unavailable" };
	unpairCalls = 0;
	sent: string[] = [];
	closed = 0;
	readonly #frameListeners = new Set<(event: TransportFrameEvent) => void>();
	readonly #stateListeners = new Set<(event: TransportStateEvent) => void>();

	async getStatus(): Promise<MobileTransportStatus> {
		return this.status;
	}
	async scanPairingQr(): Promise<ScanPairingQrResult> {
		return this.scanResult;
	}
	async beginPairing(_options: BeginPairingOptions): Promise<BeginPairingResult> {
		if (this.beginResult instanceof Error) {
			throw this.beginResult;
		}
		return this.beginResult;
	}
	async pollPairing(): Promise<PairingPollResult> {
		return this.pollQueue.shift() ?? { status: "pending_approval" };
	}
	async cancelPairing(): Promise<void> {}
	async connect(): Promise<ConnectResult> {
		if (this.connectResult instanceof Error) {
			throw this.connectResult;
		}
		return this.connectResult;
	}
	async send(options: { connectionId: string; text: string }): Promise<void> {
		this.sent.push(options.text);
	}
	async close(): Promise<void> {
		this.closed += 1;
	}
	async unpair(): Promise<void> {
		this.unpairCalls += 1;
		this.status = { state: "unpaired" };
	}
	addListener(eventName: "frame", listener: (event: TransportFrameEvent) => void): MobileTransportListenerHandle;
	addListener(
		eventName: "connectionState",
		listener: (event: TransportStateEvent) => void,
	): MobileTransportListenerHandle;
	addListener(eventName: string, listener: (event: never) => void): MobileTransportListenerHandle {
		if (eventName === "frame") {
			this.#frameListeners.add(listener as (event: TransportFrameEvent) => void);
		} else {
			this.#stateListeners.add(listener as (event: TransportStateEvent) => void);
		}
		return { remove: () => {} };
	}

	pushFrame(event: TransportFrameEvent): void {
		for (const listener of [...this.#frameListeners]) {
			listener(event);
		}
	}
	pushState(event: TransportStateEvent): void {
		for (const listener of [...this.#stateListeners]) {
			listener(event);
		}
	}
}

interface ChatClientScript {
	subscribes: string[];
	unsubscribes: string[];
	replayCalls: { runId: string; lastSeq: number }[];
	sendCalls: { requestId: string; content: string }[];
	cancelCalls: { runId: string }[];
}

/**
 * A duck-typed fake of {@link MobileProductClient} for the chat-session-controller tests. It records
 * calls and lets the test script snapshot/replay/send/cancel results.
 */
export function makeFakeChatClient(config: {
	sessionId: string;
	snapshot: GetChatSessionPageOutput;
	replay?: (runId: string, lastSeq: number) => ChatRunEvent[];
	send?: (content: string, requestId: string) => { run: ChatRun; userMessage: ChatMessage; assistantMessage: ChatMessage };
}): { client: MobileProductClient; script: ChatClientScript } {
	const script: ChatClientScript = {
		subscribes: [],
		unsubscribes: [],
		replayCalls: [],
		sendCalls: [],
		cancelCalls: [],
	};
	const client = {
		async chatSubscribe(sessionId: string) {
			script.subscribes.push(sessionId);
		},
		async chatUnsubscribe(sessionId: string) {
			script.unsubscribes.push(sessionId);
		},
		async getSessionPage() {
			return config.snapshot;
		},
		async chatReplay(input: { cursors: { runId: string; lastSeq: number }[] }) {
			const cursor = input.cursors[0]!;
			script.replayCalls.push({ runId: cursor.runId, lastSeq: cursor.lastSeq });
			const events = config.replay ? config.replay(cursor.runId, cursor.lastSeq) : [];
			return { events };
		},
		async chatSend(input: { requestId: string; content: string }) {
			script.sendCalls.push({ requestId: input.requestId, content: input.content });
			if (config.send) {
				return config.send(input.content, input.requestId);
			}
			const runId = v7();
			return {
				run: makeRun(runId, config.sessionId, "running"),
				userMessage: makeUserMessage(v7(), config.sessionId, 1, input.content),
				assistantMessage: makeAssistantMessage(v7(), config.sessionId, 2, "", "streaming"),
			};
		},
		async chatCancel(input: { runId: string }) {
			script.cancelCalls.push({ runId: input.runId });
			return { run: makeRun(input.runId, config.sessionId, "cancelling") };
		},
	} as unknown as MobileProductClient;
	return { client, script };
}
