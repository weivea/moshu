import type { RpcPeerIdentity } from "./protocol";

export interface RpcGenerationLease {
	release(): void;
}

export type RpcGenerationFenceResult =
	| {
			accepted: true;
			lease: RpcGenerationLease;
	  }
	| {
			accepted: false;
			code: "STALE_GENERATION" | "GENERATION_CONFLICT";
			currentGeneration: number;
	  };

export interface RpcGenerationFence {
	acquire(
		identity: RpcPeerIdentity,
		onFenced: (replacement: RpcPeerIdentity) => void,
	): RpcGenerationFenceResult;
}

interface ActiveGeneration {
	readonly token: object;
	readonly onFenced: (replacement: RpcPeerIdentity) => void;
}

interface GenerationRecord {
	generation: number;
	instanceId: string;
	active: ActiveGeneration | null;
}

/**
 * Process-local generation fence. It retains the highest generation after disconnect so an
 * older process cannot reconnect. Callers can provide another `RpcGenerationFence` when the
 * high-water mark must survive an agents-server restart.
 */
export class InMemoryRpcGenerationFence implements RpcGenerationFence {
	readonly #records = new Map<string, GenerationRecord>();

	acquire(
		identity: RpcPeerIdentity,
		onFenced: (replacement: RpcPeerIdentity) => void,
	): RpcGenerationFenceResult {
		const key = createPeerKey(identity);
		const existing = this.#records.get(key);

		if (existing !== undefined) {
			if (identity.generation < existing.generation) {
				return {
					accepted: false,
					code: "STALE_GENERATION",
					currentGeneration: existing.generation,
				};
			}
			if (
				identity.generation === existing.generation &&
				identity.instanceId !== existing.instanceId
			) {
				return {
					accepted: false,
					code: "GENERATION_CONFLICT",
					currentGeneration: existing.generation,
				};
			}
		}

		const previousActive = existing?.active ?? null;
		const token = {};
		const record: GenerationRecord = {
			generation: identity.generation,
			instanceId: identity.instanceId,
			active: { token, onFenced },
		};
		this.#records.set(key, record);

		if (previousActive !== null) {
			previousActive.onFenced(identity);
		}

		return {
			accepted: true,
			lease: {
				release: () => {
					const current = this.#records.get(key);
					if (current?.active?.token === token) {
						current.active = null;
					}
				},
			},
		};
	}

	getHighWaterMark(role: RpcPeerIdentity["role"], peerId: string): number | undefined {
		return this.#records.get(`${role}\u0000${peerId}`)?.generation;
	}
}

function createPeerKey(identity: RpcPeerIdentity): string {
	return `${identity.role}\u0000${identity.peerId}`;
}
