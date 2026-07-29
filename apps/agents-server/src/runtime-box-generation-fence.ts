import { defaultLocalRuntimeBoxId } from "@moshu/contracts";
import type { RuntimeBoxRepository } from "@moshu/database";
import {
	InMemoryRpcGenerationFence,
	type RpcGenerationFence,
	type RpcGenerationFenceResult,
	type RpcPeerIdentity,
} from "@moshu/process-rpc";

interface ActiveRuntimeBoxGeneration {
	readonly token: object;
	readonly onFenced: (replacement: RpcPeerIdentity) => void;
}

export class RuntimeBoxGenerationFence implements RpcGenerationFence {
	readonly #otherRoles = new InMemoryRpcGenerationFence();
	readonly #active = new Map<string, ActiveRuntimeBoxGeneration>();

	constructor(private readonly runtimeBoxes: RuntimeBoxRepository) {}

	acquire(
		identity: RpcPeerIdentity,
		onFenced: (replacement: RpcPeerIdentity) => void,
	): RpcGenerationFenceResult {
		if (identity.role !== "runtime-box" || identity.peerId === defaultLocalRuntimeBoxId) {
			return this.#otherRoles.acquire(identity, onFenced);
		}
		const accepted = this.runtimeBoxes.acceptGeneration(
			identity.peerId,
			identity.instanceId,
			identity.generation,
		);
		if (!accepted.accepted) {
			return accepted;
		}

		const previous = this.#active.get(identity.peerId);
		const token = {};
		this.#active.set(identity.peerId, { token, onFenced });
		previous?.onFenced(identity);
		return {
			accepted: true,
			lease: {
				release: () => {
					if (this.#active.get(identity.peerId)?.token === token) {
						this.#active.delete(identity.peerId);
					}
				},
			},
		};
	}
}
