import type { ChatRunEvent, SessionModelSelection } from "@moshu/contracts";
import {
	applyChatRunEvent,
	type ChatConversationState,
	type ChatMessageView,
	createChatConversationState,
	ingestSnapshotMessages,
	ingestSnapshotRuns,
	isConversationResponding,
	isConversationStopping,
	latestRunId,
	selectChatMessages,
} from "./chat-reducer";
import type { MobileEventBus } from "./events";
import type { MobileProductClient } from "./product-client";

export type ChatSessionPhase = "loading" | "ready" | "error";

export interface ChatSessionView {
	readonly phase: ChatSessionPhase;
	readonly title: string;
	readonly model: SessionModelSelection | null;
	readonly messages: readonly ChatMessageView[];
	readonly responding: boolean;
	readonly stopping: boolean;
	readonly errorMessage?: string;
}

const SNAPSHOT_LIMIT = 2;

/**
 * Drives one chat Session's live stream with the same ordering discipline the Desktop client uses,
 * adapted for Mobile's no-persistence model:
 *   1. subscribe FIRST so no live event is lost;
 *   2. buffer live events into a provisional queue while loading;
 *   3. fetch a fresh snapshot (there is no durable cursor to resume — Mobile never caches);
 *   4. seed per-run cursors from the snapshot;
 *   5. drain the provisional queue, deduping by (runId, seq) and using chat.replay to fill a gap;
 *   6. flip to ready and apply subsequent live events directly.
 * A single monotonic `#epoch` guards against a stale in-flight drain writing after dispose/reset.
 */
export class ChatSessionController {
	readonly #client: MobileProductClient;
	readonly #bus: MobileEventBus;
	readonly #sessionId: string;
	readonly #onChange: () => void;

	#state: ChatConversationState;
	#phase: ChatSessionPhase = "loading";
	#title = "";
	#model: SessionModelSelection | null = null;
	#errorMessage: string | undefined;
	#ready = false;
	#provisional: ChatRunEvent[] = [];
	#cursors = new Map<string, number>();
	#unsubscribe: (() => void) | null = null;
	#epoch = 0;
	#disposed = false;

	constructor(options: {
		client: MobileProductClient;
		bus: MobileEventBus;
		sessionId: string;
		title?: string;
		onChange: () => void;
	}) {
		this.#client = options.client;
		this.#bus = options.bus;
		this.#sessionId = options.sessionId;
		this.#title = options.title ?? "";
		this.#onChange = options.onChange;
		this.#state = createChatConversationState(options.sessionId);
	}

	getView(): ChatSessionView {
		return {
			phase: this.#phase,
			title: this.#title,
			model: this.#model,
			messages: selectChatMessages(this.#state),
			responding: isConversationResponding(this.#state),
			stopping: isConversationStopping(this.#state),
			...(this.#errorMessage ? { errorMessage: this.#errorMessage } : {}),
		};
	}

	async start(): Promise<void> {
		const epoch = ++this.#epoch;
		this.#ready = false;
		this.#phase = "loading";
		this.#provisional = [];
		this.#cursors = new Map();
		this.#state = createChatConversationState(this.#sessionId);
		this.#errorMessage = undefined;
		this.#emit();

		// 1. Subscribe to the live bus first; queue events until the drain completes.
		this.#unsubscribe?.();
		this.#unsubscribe = this.#bus.on("chatEvent", (delivery) => {
			if (delivery.event.sessionId !== this.#sessionId) {
				return;
			}
			if (this.#ready) {
				this.#deliver(delivery.event);
			} else {
				this.#provisional.push(delivery.event);
			}
		});

		try {
			await this.#client.chatSubscribe(this.#sessionId);
			const snapshot = await this.#client.getSessionPage({
				sessionId: this.#sessionId,
				limit: SNAPSHOT_LIMIT,
			});
			if (this.#isStale(epoch)) {
				return;
			}
			this.#title = snapshot.session.title;
			this.#model = snapshot.session.model ?? null;
			ingestSnapshotMessages(this.#state, snapshot.messages);
			ingestSnapshotRuns(this.#state, snapshot.runs);
			for (const cursor of snapshot.eventCursors) {
				this.#cursors.set(cursor.runId, cursor.lastSeq);
			}
			await this.#drainProvisional(epoch);
			if (this.#isStale(epoch)) {
				return;
			}
			this.#ready = true;
			this.#phase = "ready";
			this.#emit();
		} catch (error) {
			if (this.#isStale(epoch)) {
				return;
			}
			this.#phase = "error";
			this.#errorMessage = error instanceof Error ? error.message : "Failed to load chat.";
			this.#emit();
		}
	}

	async #drainProvisional(epoch: number): Promise<void> {
		// Loop until quiescent: applying replay/flush can surface further buffered events.
		let guard = 0;
		while (this.#provisional.length > 0 && guard < 1_000) {
			guard += 1;
			const queued = this.#provisional.sort((left, right) => left.seq - right.seq);
			this.#provisional = [];
			for (const event of queued) {
				await this.#deliverWithGapFill(event, epoch);
				if (this.#isStale(epoch)) {
					return;
				}
			}
		}
	}

	async #deliverWithGapFill(event: ChatRunEvent, epoch: number): Promise<void> {
		const cursor = this.#cursors.get(event.runId) ?? 0;
		if (event.seq <= cursor) {
			return;
		}
		if (event.seq === cursor + 1) {
			this.#deliver(event);
			return;
		}
		// Gap between the snapshot cursor and this live event — fill it with a durable replay so no
		// intermediate event is skipped, then deliver the triggering event in order.
		try {
			const filled = await this.#replayRun(event.runId, cursor);
			if (this.#isStale(epoch)) {
				return;
			}
			for (const replayed of filled) {
				this.#deliver(replayed);
			}
		} catch {
			// If replay fails, fall back to applying the event; the reducer's upserts are idempotent so
			// content still converges even if an intermediate delta was missed.
		}
		this.#deliver(event);
	}

	async #replayRun(runId: string, lastSeq: number): Promise<ChatRunEvent[]> {
		const output = await this.#client.chatReplay({
			cursors: [
				{ runId, lastSeq, sessionId: this.#sessionId, issuedAtMs: Date.now() },
			],
		});
		return [...output.events]
			.filter((event) => event.runId === runId)
			.sort((left, right) => left.seq - right.seq);
	}

	#deliver(event: ChatRunEvent): void {
		const cursor = this.#cursors.get(event.runId) ?? 0;
		if (event.seq <= cursor) {
			return;
		}
		if (applyChatRunEvent(this.#state, event)) {
			this.#cursors.set(event.runId, event.seq);
			this.#emit();
		}
	}

	async send(content: string, requestId: string): Promise<void> {
		const accepted = await this.#client.chatSend({
			requestId,
			sessionId: this.#sessionId,
			content,
		});
		// Seed the user + assistant messages immediately so the UI reflects the send without waiting
		// for the first event; subsequent events reconcile by id.
		ingestSnapshotMessages(this.#state, [accepted.userMessage, accepted.assistantMessage]);
		ingestSnapshotRuns(this.#state, [accepted.run]);
		this.#cursors.set(accepted.run.id, this.#cursors.get(accepted.run.id) ?? 0);
		this.#emit();
	}

	async cancel(): Promise<void> {
		const runId = latestRunId(this.#state);
		if (!runId) {
			return;
		}
		await this.#client.chatCancel({ runId });
	}

	/** Reflect a model change the screen persisted via `session.setModel`. */
	applyModel(model: SessionModelSelection | null): void {
		this.#model = model;
		this.#emit();
	}

	#emit(): void {
		if (!this.#disposed) {
			this.#onChange();
		}
	}

	#isStale(epoch: number): boolean {
		return this.#disposed || epoch !== this.#epoch;
	}

	async dispose(): Promise<void> {
		this.#disposed = true;
		this.#epoch += 1;
		this.#unsubscribe?.();
		this.#unsubscribe = null;
		try {
			await this.#client.chatUnsubscribe(this.#sessionId);
		} catch {
			// Best-effort; the socket may already be gone.
		}
	}
}
