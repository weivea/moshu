import {
	type ApprovalEventDelivery,
	agentsProductEventMethods,
	approvalActivityChangedEventSchema,
	approvalEventDeliverySchema,
	type ChatRunEvent,
	chatEventDeliverySchema,
	chatRunEventSchema,
	chatSessionsRetiredEventSchema,
	productRpcEvents,
	type SessionApprovalPolicyEvent,
	sessionApprovalPolicyEventSchema,
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
//   2. Session subscription: any authenticated product client may explicitly subscribe to a Session
//      to observe its Runs without holding the originating `clientRequestId`. This is the
//      forward-looking, multi-client path a future Mobile client uses; `clientRequestId` becomes an
//      optional origin echo rather than a routing key.
//
// Delivery for a given event is the union of the two recipient sets (deduplicated by connection),
// so today's Desktop client keeps receiving its own Runs byte-for-byte while additional subscribers
// observe the same Session. Authorization is structured, not a naked broadcast: only authenticated
// `client` peers are eligible, and subscribers only receive events for Sessions they subscribed to.
//
// Subscription lifecycle (connection-scoped, client re-subscribes on reconnect):
//   Subscriptions are dropped when a connection closes (`releasePeer`). They are NOT a durable
//   server-side registration that outlives the socket, so the hub never delivers to a stale/closed
//   connection. A client that wants to keep observing a Session across a reconnect owns a gap-free
//   recovery loop, and installs its subscription BEFORE replay so no event is missed:
//   on the fresh connection it (a) re-subscribes (chat.subscribe) so the hub starts routing live
//   events into the client's provisional buffer, then (b) replays from its per-Run cursors
//   (chat.replay), then (c) de-duplicates/merges the overlap by monotonic `(runId, seq)`, then
//   (d) flushes the buffered live events, and only then marks itself "live". Because the subscription
//   is armed at-or-before the replay snapshot boundary, any event committed between the subscribe and
//   the replay response is delivered live into the buffer and merged exactly once — no gap, no
//   duplicate. The transport generation fence guarantees at most one live connection per client
//   identity (peerId); subscriptions are keyed by that stable `peerId` but each records the full
//   identity (including `generation`). This makes cleanup reconnect-safe: a late close of an older
//   generation cannot remove a newer generation's re-subscription (the identity/generation guard in
//   `releasePeer` skips it), and a subscription the newer generation did not renew is still reclaimed
//   when its owning generation finally closes.

const maxActiveRequestOwners = 1_024;
// Structured authorization bounds for session subscriptions. A single client cannot pin an unbounded
// number of Sessions, and the hub as a whole cannot accumulate unbounded subscription state, even
// under a buggy or hostile client. These are generous for the single-user MVP while still capping
// worst-case memory.
const maxSubscriptionsPerPeer = 256;
const maxTotalSubscriptions = 8_192;

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
	// sessionId -> peerId -> subscription. Delivery source of truth. Keyed by the stable client
	// `peerId`; each entry records the full identity so cleanup can be generation-guarded.
	readonly #subscriptionsBySession = new Map<string, Map<string, SessionSubscription>>();
	// peerId -> set of subscribed sessionIds. Reverse index for O(1) per-peer bounds and efficient
	// connection-close cleanup without scanning every Session.
	readonly #sessionsByPeer = new Map<string, Set<string>>();
	#totalSubscriptions = 0;

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
	// subscribe; the caller identity is taken from the peer, never trusted from request input. The
	// handler layer validates that the Session exists/is visible before calling this. Bounds are
	// enforced so a client cannot pin unbounded Sessions and the hub cannot grow without limit.
	subscribe(peer: RpcPeer, sessionId: string): void {
		if (peer.remoteIdentity.role !== "client") {
			throw new RpcHandlerError(
				"CLIENT_IDENTITY_REQUIRED",
				"Session event subscription is only available to authenticated product clients.",
			);
		}
		const peerId = peer.remoteIdentity.peerId;
		let subscriptions = this.#subscriptionsBySession.get(sessionId);
		const alreadySubscribed = subscriptions?.has(peerId) ?? false;
		if (alreadySubscribed) {
			// Idempotent re-subscribe (e.g. after a reconnect): refresh the recorded identity to the
			// current connection generation without changing counts.
			subscriptions?.set(peerId, { identity: peer.remoteIdentity });
			return;
		}
		const peerSessions = this.#sessionsByPeer.get(peerId);
		if ((peerSessions?.size ?? 0) >= maxSubscriptionsPerPeer) {
			throw new RpcHandlerError(
				"SESSION_SUBSCRIPTION_PEER_LIMIT",
				"This client has too many active Session subscriptions.",
			);
		}
		if (this.#totalSubscriptions >= maxTotalSubscriptions) {
			throw new RpcHandlerError(
				"SESSION_SUBSCRIPTION_LIMIT",
				"Too many active Session subscriptions.",
			);
		}
		if (subscriptions === undefined) {
			subscriptions = new Map<string, SessionSubscription>();
			this.#subscriptionsBySession.set(sessionId, subscriptions);
		}
		subscriptions.set(peerId, { identity: peer.remoteIdentity });
		if (peerSessions === undefined) {
			this.#sessionsByPeer.set(peerId, new Set([sessionId]));
		} else {
			peerSessions.add(sessionId);
		}
		this.#totalSubscriptions += 1;
	}

	unsubscribe(peer: RpcPeer, sessionId: string): void {
		this.#removeSubscription(peer.remoteIdentity.peerId, sessionId);
	}

	// Removes every subscription for the given Sessions regardless of subscriber. Used when Sessions
	// are retired/deleted so the hub does not retain interest in Sessions that no longer exist.
	retireSessions(sessionIds: readonly string[]): void {
		for (const sessionId of sessionIds) {
			const subscriptions = this.#subscriptionsBySession.get(sessionId);
			if (subscriptions === undefined) {
				continue;
			}
			for (const peerId of subscriptions.keys()) {
				this.#detachPeerSession(peerId, sessionId);
			}
			this.#totalSubscriptions -= subscriptions.size;
			this.#subscriptionsBySession.delete(sessionId);
		}
	}

	releasePeer(peer: RpcPeer): void {
		for (const [requestId, binding] of this.#bindingsByRequestId) {
			if (isSameRpcPeerIdentity(binding.peerIdentity, peer.remoteIdentity)) {
				this.#bindingsByRequestId.delete(requestId);
			}
		}
		const peerId = peer.remoteIdentity.peerId;
		const peerSessions = this.#sessionsByPeer.get(peerId);
		if (peerSessions === undefined) {
			return;
		}
		for (const sessionId of [...peerSessions]) {
			const subscriptions = this.#subscriptionsBySession.get(sessionId);
			const subscription = subscriptions?.get(peerId);
			// Generation guard: only reclaim subscriptions that still belong to this exact connection.
			// A newer generation that already re-subscribed (same peerId, higher generation) owns the
			// entry now and must not be evicted by this older connection's close.
			if (
				subscription !== undefined &&
				isSameRpcPeerIdentity(subscription.identity, peer.remoteIdentity)
			) {
				this.#removeSubscription(peerId, sessionId);
			}
		}
	}

	#removeSubscription(peerId: string, sessionId: string): void {
		const subscriptions = this.#subscriptionsBySession.get(sessionId);
		if (subscriptions === undefined || !subscriptions.delete(peerId)) {
			return;
		}
		this.#totalSubscriptions -= 1;
		if (subscriptions.size === 0) {
			this.#subscriptionsBySession.delete(sessionId);
		}
		this.#detachPeerSession(peerId, sessionId);
	}

	#detachPeerSession(peerId: string, sessionId: string): void {
		const peerSessions = this.#sessionsByPeer.get(peerId);
		if (peerSessions === undefined) {
			return;
		}
		peerSessions.delete(sessionId);
		if (peerSessions.size === 0) {
			this.#sessionsByPeer.delete(peerId);
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

	// Delivers an approval.created/updated event to the authenticated clients subscribed to the
	// approval's Session. Approval events are Session-scoped: a client only observes approvals for
	// Sessions it explicitly subscribed to, mirroring ChatRunEvent authorization. No secret or raw
	// unredacted command content is carried — the summary is already server-redacted.
	publishApproval(peers: readonly RpcPeer[], delivery: ApprovalEventDelivery): void {
		const recipients = this.#sessionRecipients(peers, delivery.request.sessionId);
		if (recipients.length === 0) {
			return;
		}
		const payload = encodeJsonValue(approvalEventDeliverySchema.parse(delivery));
		emitToClients(recipients, productRpcEvents.approvalEvent, payload, "Approval event");
	}

	// Delivers a Session "Allow all" policy change to that Session's subscribers.
	publishSessionApprovalPolicy(peers: readonly RpcPeer[], event: SessionApprovalPolicyEvent): void {
		const recipients = this.#sessionRecipients(peers, event.policy.sessionId);
		if (recipients.length === 0) {
			return;
		}
		const payload = encodeJsonValue(sessionApprovalPolicyEventSchema.parse(event));
		emitToClients(
			recipients,
			productRpcEvents.sessionApprovalPolicyChanged,
			payload,
			"Session approval policy event",
		);
	}

	#sessionRecipients(peers: readonly RpcPeer[], sessionId: string): RpcPeer[] {
		const subscriptions = this.#subscriptionsBySession.get(sessionId);
		if (subscriptions === undefined) {
			return [];
		}
		return peers.filter(
			(peer) =>
				peer.remoteIdentity.role === "client" && subscriptions.has(peer.remoteIdentity.peerId),
		);
	}
}

// A no-payload hint broadcast to every authenticated client so a cross-session "pending approvals"
// Activity view can refresh its snapshot. It intentionally carries no Session-scoped or secret
// content; the snapshot itself is fetched via the authorization-checked approvals.list request.
export function broadcastApprovalActivityChanged(peers: readonly RpcPeer[]): void {
	const payload = encodeJsonValue(approvalActivityChangedEventSchema.parse({ schemaVersion: 1 }));
	emitToClients(peers, productRpcEvents.approvalActivityChanged, payload, "Approval activity hint");
}

function emitToClients(
	peers: readonly RpcPeer[],
	method: string,
	payload: JsonValue,
	label: string,
): void {
	for (const peer of peers) {
		if (peer.remoteIdentity.role !== "client") {
			continue;
		}
		try {
			peer.emitEvent(method, payload);
		} catch (error) {
			peer.close(1011, `${label} publication failed.`);
			console.error(`Failed to publish ${label} to client ${peer.remoteIdentity.peerId}.`, error);
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
