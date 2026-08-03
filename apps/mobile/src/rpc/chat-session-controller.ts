import type {
	ChatRunEvent,
	ChatRunSnapshot,
	GetChatSessionPageOutput,
	ReplayChatEventsOutput,
	SessionModelSelection,
} from "@moshu/contracts";
import { RpcRemoteError } from "@moshu/process-rpc-core";
import { newUuid } from "../lib/uuid";
import {
	applyChatRunEvent,
	type ChatConversationState,
	type ChatMessageView,
	createChatConversationState,
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
const MAX_REPLAY_PAGES = 1_000;

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
	#liveDrain: Promise<void> | undefined;
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
				if (!this.#state.runs.has(delivery.event.runId)) {
					this.#provisional.push(delivery.event);
					this.#startLiveDrain(epoch);
					return;
				}
				const cursor = this.#cursors.get(delivery.event.runId) ?? 0;
				if (delivery.event.seq <= cursor) {
					return;
				}
				if (this.#liveDrain === undefined && delivery.event.seq === cursor + 1) {
					this.#deliver(delivery.event);
					return;
				}
				this.#provisional.push(delivery.event);
				this.#startLiveDrain(epoch);
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
			this.#replaceWithSnapshot(snapshot);
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
	 * run). A repeated/echoed cursor fails closed rather than looping forever.
	 */
	async #loadFullSnapshot(): Promise<{
		session: GetChatSessionPageOutput["session"];
		runs: ChatRunSnapshot[];
	}> {
		const runs: ChatRunSnapshot[] = [];
		let session: GetChatSessionPageOutput["session"] | undefined;
		let cursor: string | undefined;
		let pages = 0;
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
			runs.push(...page.runs);
			pages += 1;
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
			runs,
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
		if (!this.#state.runs.has(event.runId)) {
			const snapshot = await this.#loadFullSnapshot();
			if (this.#isStale(epoch)) {
				return;
			}
			this.#replaceWithSnapshot(snapshot);
			if (!this.#state.runs.has(event.runId)) {
				throw new Error("A live event referenced a Run that was absent from its Session snapshot.");
			}
		}
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
			const recovery = await this.#replayRun(event.runId, cursor);
			if (this.#isStale(epoch)) {
				return;
			}
			if (recovery.resnapshot) {
				const snapshot = await this.#loadFullSnapshot();
				if (this.#isStale(epoch)) {
					return;
				}
				this.#replaceWithSnapshot(snapshot);
			} else {
				for (const replayed of recovery.events) {
					this.#deliver(replayed);
				}
			}
		} catch (error) {
			if (error instanceof SessionRetiredDuringReplayError) {
				throw error;
			}
			const snapshot = await this.#loadFullSnapshot();
			if (this.#isStale(epoch)) {
				return;
			}
			this.#replaceWithSnapshot(snapshot);
		}
		const recoveredCursor = this.#cursors.get(event.runId) ?? 0;
		if (event.seq <= recoveredCursor) {
			return;
		}
		if (event.seq !== recoveredCursor + 1) {
			throw new Error("Chat timeline could not recover a missing event range.");
		}
		this.#deliver(event);
	}

	#replaceWithSnapshot(snapshot: {
		session: GetChatSessionPageOutput["session"];
		runs: ChatRunSnapshot[];
	}): void {
		this.#title = snapshot.session.title;
		this.#model = snapshot.session.model ?? null;
		this.#state = createChatConversationState(this.#sessionId);
		this.#cursors = new Map();
		ingestSnapshotRuns(this.#state, snapshot.runs);
		for (const run of snapshot.runs) {
			this.#cursors.set(run.id, run.lastEventSeq);
		}
	}

	#startLiveDrain(epoch: number): void {
		if (this.#liveDrain !== undefined) {
			return;
		}
		const execution = this.#drainProvisional(epoch)
			.catch((error: unknown) => {
				if (this.#isStale(epoch)) {
					return;
				}
				this.#ready = false;
				this.#phase = "error";
				this.#errorMessage =
					error instanceof Error ? error.message : "Failed to recover chat events.";
				this.#emit();
			})
			.finally(() => {
				if (this.#liveDrain !== execution) {
					return;
				}
				this.#liveDrain = undefined;
				if (!this.#isStale(epoch) && this.#ready && this.#provisional.length > 0) {
					this.#startLiveDrain(epoch);
				}
			});
		this.#liveDrain = execution;
	}

	async #replayRun(
		runId: string,
		lastSeq: number,
	): Promise<{ events: ChatRunEvent[]; resnapshot: boolean }> {
		const events: ChatRunEvent[] = [];
		let replayCursor = lastSeq;
		for (let page = 0; page < MAX_REPLAY_PAGES; page += 1) {
			const output: ReplayChatEventsOutput = await this.#client.chatReplay({
				cursors: [
					{
						runId,
						lastSeq: replayCursor,
						sessionId: this.#sessionId,
						issuedAtMs: Date.now(),
					},
				],
			});
			this.#validateReplayRecovery(output);
			if (output.retiredSessionIds.includes(this.#sessionId)) {
				throw new SessionRetiredDuringReplayError();
			}
			if (output.resnapshotSessionIds.includes(this.#sessionId)) {
				return { events: [], resnapshot: true };
			}
			const pageEvents = [...output.events].sort((left, right) => left.seq - right.seq);
			for (const replayed of pageEvents) {
				if (replayed.runId !== runId || replayed.sessionId !== this.#sessionId) {
					throw new Error("Chat replay returned an event outside the requested Run.");
				}
				if (replayed.seq > replayCursor) {
					events.push(replayed);
					replayCursor = replayed.seq;
				}
			}
			if (!output.hasMore) {
				return { events, resnapshot: false };
			}
			if (pageEvents.length === 0 || replayCursor === lastSeq) {
				throw new Error("Chat replay pagination did not advance.");
			}
			lastSeq = replayCursor;
		}
		throw new Error("Chat replay exceeds the supported page limit.");
	}

	#validateReplayRecovery(output: ReplayChatEventsOutput): void {
		const recoverySessionIds = [...output.retiredSessionIds, ...output.resnapshotSessionIds];
		if (output.retiredSessionIds.length > 0 && output.resnapshotSessionIds.length > 0) {
			throw new Error("Chat replay returned contradictory recovery instructions.");
		}
		if (recoverySessionIds.some((sessionId) => sessionId !== this.#sessionId)) {
			throw new Error("Chat replay returned a recovery instruction for another Session.");
		}
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
			const current = this.#state.runs.get(accepted.run.id);
			if (current === undefined || current.lastEventSeq < accepted.run.lastEventSeq) {
				ingestSnapshotRuns(this.#state, [accepted.run]);
			}
			this.#cursors.set(
				accepted.run.id,
				Math.max(this.#cursors.get(accepted.run.id) ?? 0, accepted.run.lastEventSeq),
			);
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

class SessionRetiredDuringReplayError extends Error {
	constructor() {
		super("This chat Session was retired during event recovery.");
		this.name = "SessionRetiredDuringReplayError";
	}
}

function fail(message: string): never {
	throw new Error(message);
}
