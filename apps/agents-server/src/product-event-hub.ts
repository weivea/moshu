import {
	agentsProductEventMethods,
	type ChatRunEvent,
	chatEventDeliverySchema,
	chatRunEventSchema,
	chatSessionsRetiredEventSchema,
	productRpcEvents,
} from "@moshu/contracts";
import {
	isSameRpcPeerIdentity,
	type JsonValue,
	RpcHandlerError,
	type RpcPeer,
	rpcJsonValueSchema,
} from "@moshu/process-rpc";

// The event hub delivers ChatRunEvents to authenticated product clients using two complementary
// mechanisms:
//
//   1. Request-owner routing (unchanged from the original single-owner model): the client that
//      issued a chat.send owns the resulting Run's live stream via its `clientRequestId`. This
//      preserves chat.send idempotency, generation fencing, and reconnect recovery exactly.
//   2. Session subscription (new): any authenticated product client may explicitly subscribe to a
//      Session to observe its Runs without holding the originating `clientRequestId`. This is the
//      forward-looking, multi-client path a future Mobile client uses; `clientRequestId` becomes an
//      optional origin echo rather than a routing key.
//
// Delivery for a given event is the union of the two recipient sets (deduplicated by connection),
// so today's Desktop client keeps receiving its own Runs byte-for-byte while additional subscribers
// observe the same Session. Authorization is structured, not a naked broadcast: only authenticated
// `client` peers are eligible, and subscribers only receive events for Sessions they subscribed to.

const maxActiveRequestOwners = 1_024;

interface ProductEventRouteBinding {
	readonly peerId: string;
	readonly peerIdentity: RpcPeer["remoteIdentity"];
}

export interface ProductEventRouteLease {
	readonly requestId: string;
	readonly binding: ProductEventRouteBinding;
	readonly created: boolean;
	readonly previousBinding: ProductEventRouteBinding | undefined;
}

interface SessionSubscription {
	readonly identity: RpcPeer["remoteIdentity"];
}

export class ProductEventRouter {
	readonly #bindingsByRequestId = new Map<string, ProductEventRouteBinding>();
	// sessionId -> peerId -> subscription. Keyed by the stable client `peerId` so an explicit
	// subscription survives a reconnect (new connection generation, same identity).
	readonly #subscriptionsBySession = new Map<string, Map<string, SessionSubscription>>();

	bind(requestId: string, peer: RpcPeer): ProductEventRouteLease {
		const existing = this.#bindingsByRequestId.get(requestId);
		if (existing !== undefined && existing.peerId !== peer.remoteIdentity.peerId) {
			throw new RpcHandlerError(
				"REQUEST_OWNER_MISMATCH",
				"Chat send request belongs to another client peer.",
			);
		}
		if (existing !== undefined) {
			return {
				requestId,
				binding: createRouteBinding(peer),
				created: false,
				previousBinding: existing,
			};
		}
		if (this.#bindingsByRequestId.size >= maxActiveRequestOwners) {
			throw new RpcHandlerError("REQUEST_OWNER_LIMIT", "Too many active Chat send request owners.");
		}
		const binding = createRouteBinding(peer);
		this.#bindingsByRequestId.set(requestId, binding);
		return { requestId, binding, created: true, previousBinding: undefined };
	}

	commit(lease: ProductEventRouteLease): boolean {
		const current = this.#bindingsByRequestId.get(lease.requestId);
		if (lease.created) {
			return current === lease.binding;
		}
		if (current === lease.previousBinding) {
			this.#bindingsByRequestId.set(lease.requestId, lease.binding);
			return true;
		}
		return current === lease.binding;
	}

	rollback(lease: ProductEventRouteLease): void {
		if (lease.created && this.#bindingsByRequestId.get(lease.requestId) === lease.binding) {
			this.#bindingsByRequestId.delete(lease.requestId);
		}
	}

	release(lease: ProductEventRouteLease): void {
		if (this.#bindingsByRequestId.get(lease.requestId) === lease.binding) {
			this.#bindingsByRequestId.delete(lease.requestId);
		}
	}

	// Registers an authorization-scoped interest in a Session. Only authenticated product clients may
	// subscribe; the caller identity is taken from the peer, never trusted from request input.
	subscribe(peer: RpcPeer, sessionId: string): void {
		if (peer.remoteIdentity.role !== "client") {
			throw new RpcHandlerError(
				"CLIENT_IDENTITY_REQUIRED",
				"Session event subscription is only available to authenticated product clients.",
			);
		}
		let subscriptions = this.#subscriptionsBySession.get(sessionId);
		if (subscriptions === undefined) {
			subscriptions = new Map<string, SessionSubscription>();
			this.#subscriptionsBySession.set(sessionId, subscriptions);
		}
		subscriptions.set(peer.remoteIdentity.peerId, { identity: peer.remoteIdentity });
	}

	unsubscribe(peer: RpcPeer, sessionId: string): void {
		const subscriptions = this.#subscriptionsBySession.get(sessionId);
		if (subscriptions === undefined) {
			return;
		}
		if (subscriptions.delete(peer.remoteIdentity.peerId) && subscriptions.size === 0) {
			this.#subscriptionsBySession.delete(sessionId);
		}
	}

	releasePeer(peer: RpcPeer): void {
		for (const [requestId, binding] of this.#bindingsByRequestId) {
			if (isSameRpcPeerIdentity(binding.peerIdentity, peer.remoteIdentity)) {
				this.#bindingsByRequestId.delete(requestId);
			}
		}
		for (const [sessionId, subscriptions] of this.#subscriptionsBySession) {
			const subscription = subscriptions.get(peer.remoteIdentity.peerId);
			if (
				subscription !== undefined &&
				isSameRpcPeerIdentity(subscription.identity, peer.remoteIdentity)
			) {
				subscriptions.delete(peer.remoteIdentity.peerId);
				if (subscriptions.size === 0) {
					this.#subscriptionsBySession.delete(sessionId);
				}
			}
		}
	}

	publish(peers: readonly RpcPeer[], event: ChatRunEvent, clientRequestId?: string): void {
		const originBinding =
			clientRequestId === undefined ? undefined : this.#bindingsByRequestId.get(clientRequestId);
		const subscriptions = this.#subscriptionsBySession.get(event.sessionId);
		if (originBinding !== undefined || subscriptions !== undefined) {
			const recipients = peers.filter((peer) => {
				if (peer.remoteIdentity.role !== "client") {
					return false;
				}
				const matchesOrigin =
					originBinding !== undefined &&
					isSameRpcPeerIdentity(peer.remoteIdentity, originBinding.peerIdentity);
				const matchesSubscription = subscriptions?.has(peer.remoteIdentity.peerId) ?? false;
				return matchesOrigin || matchesSubscription;
			});
			if (recipients.length > 0) {
				publishChatEvent(recipients, event, clientRequestId);
			}
		}
		if (
			originBinding !== undefined &&
			clientRequestId !== undefined &&
			event.type === "run.status" &&
			(event.payload.status === "completed" ||
				event.payload.status === "failed" ||
				event.payload.status === "cancelled")
		) {
			if (this.#bindingsByRequestId.get(clientRequestId) === originBinding) {
				this.#bindingsByRequestId.delete(clientRequestId);
			}
		}
	}
}

function createRouteBinding(peer: RpcPeer): ProductEventRouteBinding {
	return {
		peerId: peer.remoteIdentity.peerId,
		peerIdentity: peer.remoteIdentity,
	};
}

export function publishChatEvent(
	peers: readonly RpcPeer[],
	event: ChatRunEvent,
	clientRequestId?: string,
): void {
	const payload = encodeJsonValue(
		chatEventDeliverySchema.parse({
			...(clientRequestId === undefined ? {} : { clientRequestId }),
			event: chatRunEventSchema.parse(event),
		}),
	);
	for (const peer of peers) {
		if (peer.remoteIdentity.role === "client") {
			try {
				peer.emitEvent(agentsProductEventMethods[0], payload, { eventId: event.id });
			} catch (error) {
				peer.close(1011, "Chat event publication failed.");
				console.error(
					`Failed to publish chat event to client ${peer.remoteIdentity.peerId}.`,
					error,
				);
			}
		}
	}
}

export function publishRetiredChatSessions(
	peers: readonly RpcPeer[],
	sessionIds: readonly string[],
	reportDiagnostic: (message: string) => void = console.error,
): void {
	const payload = encodeJsonValue(
		chatSessionsRetiredEventSchema.parse({
			schemaVersion: 1,
			sessionIds,
		}),
	);
	for (const peer of peers) {
		if (peer.remoteIdentity.role !== "client") {
			continue;
		}
		try {
			peer.emitEvent(productRpcEvents.chatSessionsRetired, payload);
		} catch {
			peer.close(1011, "Session retirement publication failed.");
			reportDiagnostic(
				`Failed to publish Session retirement to client ${peer.remoteIdentity.peerId}; replay will recover it.`,
			);
		}
	}
}

function encodeJsonValue(value: unknown): JsonValue {
	const encoded = JSON.stringify(value);
	if (encoded === undefined) {
		throw new RpcHandlerError(
			"INTERNAL_ERROR",
			"Product RPC event payload is not JSON serializable.",
		);
	}
	return rpcJsonValueSchema.parse(JSON.parse(encoded));
}
