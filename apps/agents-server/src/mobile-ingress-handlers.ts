import type {
	AckMobileAttentionOutput,
	ListMobileAttentionOutput,
	RevokeMobileDeviceInput,
	RevokeMobileDeviceOutput,
} from "@moshu/contracts";
import type { MobileAttentionRepository } from "@moshu/database";
import { RpcHandlerError, type RpcPeer } from "@moshu/process-rpc";

// Shared, pi-free Mobile ingress handler logic. This is the single source of truth for how an
// authenticated Mobile peer's attention feed is read/advanced and how a device revoke tears down its
// durable read state and live peer. Both the Product RPC wiring (create-agents-server) and the
// ingress smoke import these so the smoke exercises the real production composition rather than a
// bespoke reimplementation. It deliberately imports only contracts / database / process-rpc so it can
// be constructed and tested without the agent-runtime (pi) dependency.

// A Mobile ingress peer's client id is always derived from the authenticated handshake identity,
// never from request input, so a caller can neither forge another device's clientId nor read a
// Desktop feed. Desktop product clients are rejected outright.
export function resolveMobileClientId(peer: RpcPeer): string {
	if (peer.remoteIdentity.role !== "mobile-client") {
		throw new RpcHandlerError(
			"CLIENT_IDENTITY_REQUIRED",
			"The Mobile attention feed is only available to authenticated Mobile clients.",
		);
	}
	return peer.remoteIdentity.peerId;
}

export function listMobileAttentionForPeer(
	mobileAttention: MobileAttentionRepository,
	peer: RpcPeer,
	input: { cursor?: string; limit?: number },
): ListMobileAttentionOutput {
	return mobileAttention.list(resolveMobileClientId(peer), {
		cursor: input.cursor,
		limit: input.limit,
	});
}

export function ackMobileAttentionForPeer(
	mobileAttention: MobileAttentionRepository,
	peer: RpcPeer,
	input: { seq: number },
): AckMobileAttentionOutput {
	return {
		schemaVersion: 1 as const,
		...mobileAttention.ack(resolveMobileClientId(peer), input.seq),
	};
}

export interface RevokeMobileDeviceDeps {
	mobileAttention: MobileAttentionRepository;
	// Durable key revocation (MobileIngressAuth.revokeDevice); returns the revoke acknowledgement.
	revokeDeviceKey: (input: RevokeMobileDeviceInput) => RevokeMobileDeviceOutput;
	// Tears down any live peer for the revoked client id so a stale connection cannot be revived.
	disconnectMobileDevice?: (mobileClientId: string, reason: string) => void;
}

// Revoke a Mobile device: durably revoke its key, drop the device's server-side unread cursor so a
// revoked (and later re-paired) client id can never inherit stale read state, and immediately tear
// down any live peer. Idempotent-safe to call for an already-revoked device.
export function revokeMobileDevice(
	deps: RevokeMobileDeviceDeps,
	input: RevokeMobileDeviceInput,
): RevokeMobileDeviceOutput {
	const output = deps.revokeDeviceKey(input);
	deps.mobileAttention.deleteAckCursor(input.mobileClientId);
	deps.disconnectMobileDevice?.(input.mobileClientId, "Mobile device revoked.");
	return output;
}
