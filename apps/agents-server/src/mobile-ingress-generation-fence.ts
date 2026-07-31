import type { MobileDeviceRepository } from "@moshu/database";
import {
	InMemoryRpcGenerationFence,
	type RpcGenerationFence,
	type RpcGenerationFenceResult,
	type RpcPeerIdentity,
} from "@moshu/process-rpc";

interface ActiveMobileGeneration {
	readonly token: object;
	readonly onFenced: (replacement: RpcPeerIdentity) => void;
}

// Durable generation fence for Mobile clients. A late/old instance or generation can never preempt
// or resurrect a newer one, and a reconnect (new instance/generation) fences the previous peer so
// the stale WebSocket is torn down. Non mobile-client roles fall through to the in-memory fence so
// this class never affects Product or Runtime ingress peers.
export class MobileIngressGenerationFence implements RpcGenerationFence {
	readonly #otherRoles = new InMemoryRpcGenerationFence();
	readonly #active = new Map<string, ActiveMobileGeneration>();

	constructor(private readonly devices: MobileDeviceRepository) {}

	acquire(
		identity: RpcPeerIdentity,
		onFenced: (replacement: RpcPeerIdentity) => void,
	): RpcGenerationFenceResult {
		if (identity.role !== "mobile-client") {
			return this.#otherRoles.acquire(identity, onFenced);
		}
		const accepted = this.devices.acceptGeneration(
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
