import type {
	ChatMessage,
	ChatRun,
	ChatRunEvent,
	ChatRunEventCursor,
	GetChatSessionPageOutput,
	SessionModelSelection,
} from "@moshu/contracts";
import { RpcRemoteError } from "@moshu/process-rpc-core";
import { newUuid } from "../lib/uuid";
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
	/**
	 * True when a prior send's outcome is unknown (its response was lost / the socket dropped). The UI
	 * keeps the draft and a Retry reuses the same requestId; the flag lets it warn that the previous
	 * attempt may or may not have landed.
	 */
	readonly pendingSendAmbiguous: boolean;
}

// The Layer 3 server caps a single session page at `maxSessionRunsPerPage` (2) runs and orders runs
// oldest→newest, so the active/latest run is on the LAST page. To show more than 2 runs — and to
// include the active run at all — we must follow `nextCursor` to the end. These bounds keep that
// drain controllable and fail closed instead of looping or growing without limit.
const SNAPSHOT_PAGE_LIMIT = 2;
const MAX_SNAPSHOT_PAGES = 200;
const MAX_SNAPSHOT_BYTES = 4 * 1024 * 1024;

// Chat-send outcomes that definitively prove no run was created, so the reservation can be released
// (a fresh attempt gets a new requestId). Everything else — a dropped socket, a timeout, a lost
// response, an unknown remote code — is ambiguous: the send MIGHT have been accepted, so the
// reservation is retained and a Retry reuses the same requestId for server-side idempotency.
const DEFINITIVE_SEND_REJECTION_CODES = new Set<string>([
	"INVALID_ARGUMENT",
	"RUNTIME_BOX_NOT_READY",
	"SESSION_NOT_FOUND",
]);

function isDefinitiveSendRejection(error: unknown): boolean {
	return error instanceof RpcRemoteError && DEFINITIVE_SEND_REJECTION_CODES.has(error.code);
}

interface SendReservation {
	requestId: string;
	content: string;
	/** Set once a send attempt returned without a definitive outcome. */
	ambiguous: boolean;
}

/**
 * Drives one chat Session's live stream with the same ordering discipline the Desktop client uses,
 * adapted for Mobile's no-persistence model:
 *   1. subscribe FIRST so no live event is lost;
 *   2. buffer live events into a provisional queue while loading;
 *   3. fetch a fresh snapshot (there is no durable cursor to resume — Mobile never caches),
 *      paginating to the end so the active run is always included;
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
	readonly #generateRequestId: () => string;

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
	#pendingSend: SendReservation | null = null;

	constructor(options: {
		client: MobileProductClient;
		bus: MobileEventBus;
		sessionId: string;
		title?: string;
		onChange: () => void;
		/** Overridable for deterministic tests; defaults to a random UUID. */
		generateRequestId?: () => string;
	}) {
		this.#client = options.client;
		this.#bus = options.bus;
		this.#sessionId = options.sessionId;
		this.#title = options.title ?? "";
		this.#onChange = options.onChange;
		this.#generateRequestId = options.generateRequestId ?? newUuid;
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
			pendingSendAmbiguous: this.#pendingSend?.ambiguous ?? false,
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
			const snapshot = await this.#loadFullSnapshot();
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

	/**
	 * Loads the full run history by following `nextCursor` to the last page (which holds the active
	 * run). Bounded by page count and accumulated bytes; a repeated/echoed cursor fails closed rather
	 * than looping forever.
	 */
	async #loadFullSnapshot(): Promise<{
		session: GetChatSessionPageOutput["session"];
		messages: ChatMessage[];
		runs: ChatRun[];
		eventCursors: ChatRunEventCursor[];
	}> {
		const messages: ChatMessage[] = [];
		const runs: ChatRun[] = [];
		const eventCursors: ChatRunEventCursor[] = [];
		let session: GetChatSessionPageOutput["session"] | undefined;
		let cursor: string | undefined;
		let pages = 0;
		let bytes = 0;
		const seen = new Set<string>();

		do {
			if (pages >= MAX_SNAPSHOT_PAGES) {
				throw new Error("Session history exceeds the supported page limit.");
			}
			const page = await this.#client.getSessionPage({
				sessionId: this.#sessionId,
				limit: SNAPSHOT_PAGE_LIMIT,
				...(cursor === undefined ? {} : { cursor }),
			});
			session = page.session;
			messages.push(...page.messages);
			runs.push(...page.runs);
			eventCursors.push(...page.eventCursors);
			pages += 1;
			bytes += JSON.stringify(page.messages).length + JSON.stringify(page.runs).length;
			if (bytes > MAX_SNAPSHOT_BYTES) {
				throw new Error("Session history exceeds the supported size limit.");
			}
			const next = page.nextCursor;
			if (next !== undefined && (next === cursor || seen.has(next))) {
				// The server must always advance the cursor; a repeat means a broken/looping page.
				throw new Error("Session pagination cursor did not advance.");
			}
			if (next !== undefined) {
				seen.add(next);
			}
			cursor = next;
		} while (cursor !== undefined);

		return {
			session: session ?? fail("Session page did not return a session."),
			messages,
			runs,
			eventCursors,
		};
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

	/**
	 * Sends a chat message with an idempotency reservation. The requestId is owned here, not by the
	 * caller: a Retry of the same content reuses the reservation's requestId so the server dedupes it
	 * to the same run (no duplicate). Only a definitive rejection or a content change (edit/discard)
	 * releases the reservation and mints a new requestId.
	 */
	async send(content: string): Promise<void> {
		const reservation = this.#reserveSend(content);
		try {
			const accepted = await this.#client.chatSend({
				requestId: reservation.requestId,
				sessionId: this.#sessionId,
				content,
			});
			// Definitive success: the send is accepted and owns a run. Release the reservation.
			this.#pendingSend = null;
			// Seed the user + assistant messages immediately so the UI reflects the send without waiting
			// for the first event; subsequent events reconcile by id.
			ingestSnapshotMessages(this.#state, [accepted.userMessage, accepted.assistantMessage]);
			ingestSnapshotRuns(this.#state, [accepted.run]);
			this.#cursors.set(accepted.run.id, this.#cursors.get(accepted.run.id) ?? 0);
			this.#emit();
		} catch (error) {
			if (isDefinitiveSendRejection(error)) {
				// The server rejected before creating a run — a new attempt must use a fresh requestId.
				this.#pendingSend = null;
			} else {
				// Ambiguous: keep the reservation so Retry reuses the same requestId. Surface the flag.
				reservation.ambiguous = true;
			}
			this.#emit();
			throw error;
		}
	}

	#reserveSend(content: string): SendReservation {
		if (this.#pendingSend && this.#pendingSend.content === content) {
			// Same content as an outstanding (ambiguous) send — reuse its requestId (idempotent retry).
			return this.#pendingSend;
		}
		// New content (or no reservation): the prior request's result is unknown but the user chose to
		// send different content, so mint a fresh requestId. `start()` re-snapshots to reconcile.
		const reservation: SendReservation = {
			requestId: this.#generateRequestId(),
			content,
			ambiguous: false,
		};
		this.#pendingSend = reservation;
		return reservation;
	}

	/** True while a send's outcome is unknown; the UI keeps the draft so Retry reuses its requestId. */
	hasPendingSend(): boolean {
		return this.#pendingSend !== null;
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

function fail(message: string): never {
	throw new Error(message);
}
