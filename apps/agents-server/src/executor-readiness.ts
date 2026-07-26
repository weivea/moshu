import type { RpcPeer, RpcPeerIdentity } from "@moshu/process-rpc";

export class ExecutorReadiness {
	#peer: RpcPeer | null = null;
	#identity: RpcPeerIdentity | null = null;

	register(peer: RpcPeer): void {
		if (peer.remoteIdentity.role !== "executor") {
			throw new Error("Only an authenticated executor can register readiness.");
		}
		this.#peer = peer;
		this.#identity = peer.remoteIdentity;
	}

	clear(peer: RpcPeer): void {
		if (this.#peer === peer) {
			this.#peer = null;
			this.#identity = null;
		}
	}

	isReady(): boolean {
		return this.#peer !== null;
	}

	getInfo(): {
		connected: boolean;
		registered: boolean;
		peerId?: string;
		instanceId?: string;
		generation?: number;
	} {
		if (this.#identity === null) {
			return { connected: false, registered: false };
		}
		return {
			connected: true,
			registered: true,
			peerId: this.#identity.peerId,
			instanceId: this.#identity.instanceId,
			generation: this.#identity.generation,
		};
	}
}
