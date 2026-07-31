import type {
	ApprovalActivityChangedEvent,
	ApprovalEventDelivery,
	ChatEventDelivery,
	ListRuntimeBoxesOutput,
	SessionApprovalPolicyEvent,
} from "@moshu/contracts";
import { z } from "zod";

export interface ChatSessionsRetiredEvent {
	readonly schemaVersion: 1;
	readonly sessionIds: readonly string[];
}

/** Strongly-typed payload map for the events a Mobile client is allowed to receive. */
export interface MobileEventMap {
	chatEvent: ChatEventDelivery;
	chatSessionsRetired: ChatSessionsRetiredEvent;
	runtimeBoxesChanged: ListRuntimeBoxesOutput;
	approvalEvent: ApprovalEventDelivery;
	sessionApprovalPolicyChanged: SessionApprovalPolicyEvent;
	approvalActivityChanged: ApprovalActivityChangedEvent;
}

export type MobileEventName = keyof MobileEventMap;

type Listener<T> = (payload: T) => void;

/** A tiny synchronous typed emitter. No wildcard listeners, no async — deterministic for tests. */
export class MobileEventBus {
	readonly #listeners = new Map<MobileEventName, Set<Listener<unknown>>>();

	on<K extends MobileEventName>(event: K, listener: Listener<MobileEventMap[K]>): () => void {
		let set = this.#listeners.get(event);
		if (!set) {
			set = new Set();
			this.#listeners.set(event, set);
		}
		set.add(listener as Listener<unknown>);
		return () => {
			set?.delete(listener as Listener<unknown>);
		};
	}

	emit<K extends MobileEventName>(event: K, payload: MobileEventMap[K]): void {
		const set = this.#listeners.get(event);
		if (!set) {
			return;
		}
		for (const listener of [...set]) {
			(listener as Listener<MobileEventMap[K]>)(payload);
		}
	}

	clear(): void {
		this.#listeners.clear();
	}
}

// Guarded parse helper so a malformed server event surfaces as a validation error the caller can
// treat as fatal (per the DoD, strict Zod on every response/event).
export function parseEvent<T>(schema: z.ZodType<T>, payload: unknown): T {
	return schema.parse(payload);
}
