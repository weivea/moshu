import {
	ackMobileAttentionInputSchema,
	ackMobileAttentionOutputSchema,
	listMobileAttentionInputSchema,
	listMobileAttentionOutputSchema,
	mobileClientProductEventMethods,
	mobileClientProductRequestMethods,
	productRpcMaxBufferedOutboundBytes,
	productRpcMaxFrameBytes,
	productRpcMethods,
	type RevokeMobileDeviceInput,
	type RevokeMobileDeviceOutput,
} from "@moshu/contracts";
import type { MobileAttentionOutboxRepository, MobileAttentionRepository } from "@moshu/database";
import {
	createRpcServer,
	type JsonValue,
	type RpcCloseInfo,
	type RpcGenerationFence,
	RpcHandlerError,
	type RpcHandlers,
	type RpcHandshakeAuthenticator,
	type RpcHttpRequestContext,
	type RpcMethodAllowlist,
	type RpcPeer,
	type RpcPeerIdentity,
	type RpcRequestHandler,
	type RpcServer,
} from "@moshu/process-rpc";
import { MobileAttentionOutboxDrainer } from "./mobile-attention-drainer";
import {
	ackMobileAttentionForPeer,
	listMobileAttentionForPeer,
	revokeMobileDevice,
} from "./mobile-ingress-handlers";

// ---------------------------------------------------------------------------
// createMobileIngressComposition
//
// The single, pi-free source of truth for how the dedicated Mobile ingress is wired: its strict
// method allowlist, the durable attention list/ack handlers merged onto the shared product handler
// map, the transactional-outbox drainer, and the device-revoke closure. Both the production
// `create-agents-server` and the ingress smoke construct their Mobile server through this factory, so
// the smoke exercises the REAL composition instead of a bespoke `createRpcServer` + hand-rebuilt
// handler map. It imports only contracts / database / process-rpc, so it can be constructed and
// tested without the agent-runtime (pi) dependency.
// ---------------------------------------------------------------------------

// The strict Mobile ingress allowlist. An authenticated Mobile client can only reach the MVP subset —
// never Provider auth, Remote Access control, Runtime Box pairing/device revoke, MCP/Skills, Project
// mutations, diagnostics, or any Desktop-only surface. Requests/events outside this set are rejected
// by the RPC layer before a handler runs, even though the same handler map backs the Product ingress.
export const agentsServerMobileMethodAllowlist: RpcMethodAllowlist = {
	"mobile-client": {
		requests: mobileClientProductRequestMethods,
		events: mobileClientProductEventMethods,
	},
};

// The request methods this composition itself wires onto the base handler map (as opposed to the
// methods supplied by the injected product handlers). Anything added here MUST also be on the Mobile
// allowlist and is guaranteed to be exercised by the ingress smoke via the wiring contract test.
export const mobileIngressCompositionRequestMethods = [
	productRpcMethods.mobileAttentionList,
	productRpcMethods.mobileAttentionAck,
] as const;

// The durable attention list/ack handlers, built once and shared by the Product handler map wiring
// (create-agents-server / product-rpc) and this composition. The peer identity is server-derived from
// the authenticated Mobile ingress session, never from request input, so a caller can neither forge
// another device's clientId nor read a Desktop feed. Input is validated against the concrete contract
// schema (mirroring the Product `createRequestHandler`: INVALID_ARGUMENT on a malformed payload).
export function mobileAttentionRequestHandlers(
	resolveAttention: () => MobileAttentionRepository,
): Record<string, RpcRequestHandler> {
	return {
		[productRpcMethods.mobileAttentionList]: (payload, context) => {
			const parsed = listMobileAttentionInputSchema.safeParse(payload);
			if (!parsed.success) {
				throw new RpcHandlerError(
					"INVALID_ARGUMENT",
					"The Mobile ingress request payload is invalid.",
				);
			}
			return listMobileAttentionOutputSchema.parse(
				listMobileAttentionForPeer(resolveAttention(), context.peer, parsed.data),
			) as unknown as JsonValue;
		},
		[productRpcMethods.mobileAttentionAck]: (payload, context) => {
			const parsed = ackMobileAttentionInputSchema.safeParse(payload);
			if (!parsed.success) {
				throw new RpcHandlerError(
					"INVALID_ARGUMENT",
					"The Mobile ingress request payload is invalid.",
				);
			}
			return ackMobileAttentionOutputSchema.parse(
				ackMobileAttentionForPeer(resolveAttention(), context.peer, parsed.data),
			) as unknown as JsonValue;
		},
	};
}

export interface MobileIngressCompositionDeps {
	readonly serverIdentity: RpcPeerIdentity;
	readonly hostname?: string;
	readonly path?: string;
	readonly maxRequestBodyBytes?: number;
	readonly authenticate: RpcHandshakeAuthenticator;
	readonly handleHttpRequest: (
		request: Request,
		context: RpcHttpRequestContext,
	) => Response | undefined | Promise<Response | undefined>;
	readonly generationFence: RpcGenerationFence;
	/**
	 * The base handler map the Mobile ingress shares. In production this is the full Product handler
	 * map; the smoke injects a minimal stub. The composition merges the durable attention handlers on
	 * top, so callers never hand-rebuild them.
	 */
	readonly baseHandlers?: RpcHandlers;
	readonly mobileAttention: MobileAttentionRepository;
	readonly mobileAttentionOutbox: MobileAttentionOutboxRepository;
	/** Pushes the mobile-only `attention.changed` live hint after a drain projected a new feed row. */
	readonly onAttentionAppended?: () => void;
	readonly reportDiagnostic?: (message: string) => void;
	/** Durable key revocation (MobileIngressAuth.revokeDevice), for the shared revoke closure. */
	readonly revokeDeviceKey?: (input: RevokeMobileDeviceInput) => RevokeMobileDeviceOutput;
	/** Tears down any live peer for a revoked client id (closure over the server built here). */
	readonly disconnectMobileDevice?: (mobileClientId: string, reason: string) => void;
	readonly onTraffic?: (direction: "inbound" | "outbound", bytes: number, peer: RpcPeer) => void;
	readonly onClose?: (info: RpcCloseInfo, peer: RpcPeer) => void;
	readonly onError?: (error: unknown, peer: RpcPeer) => void;
}

export interface MobileIngressComposition {
	/** The strict Mobile allowlist enforced on the ingress server. */
	readonly allowlist: RpcMethodAllowlist;
	/** The merged handler map (base handlers + durable attention handlers). */
	readonly handlers: RpcHandlers;
	/** The transactional-outbox drainer that projects committed rows into the durable feed. */
	readonly drainer: MobileAttentionOutboxDrainer;
	/** Build (or rebind) the dedicated Mobile ingress RPC server on an optional fixed port. */
	createServer(port?: number): RpcServer;
	/**
	 * Revoke a Mobile device through the shared revoke helper: durably revoke its key, drop its
	 * server-side unread cursor, and tear down any live peer. Requires `revokeDeviceKey`.
	 */
	revoke(input: RevokeMobileDeviceInput): RevokeMobileDeviceOutput;
}

export function createMobileIngressComposition(
	deps: MobileIngressCompositionDeps,
): MobileIngressComposition {
	const handlers: RpcHandlers = {
		requests: {
			...(deps.baseHandlers?.requests ?? {}),
			...mobileAttentionRequestHandlers(() => deps.mobileAttention),
		},
		...(deps.baseHandlers?.events === undefined ? {} : { events: deps.baseHandlers.events }),
	};

	const drainer = new MobileAttentionOutboxDrainer({
		attention: deps.mobileAttention,
		outbox: deps.mobileAttentionOutbox,
		...(deps.onAttentionAppended === undefined ? {} : { onAppended: deps.onAttentionAppended }),
		...(deps.reportDiagnostic === undefined ? {} : { reportDiagnostic: deps.reportDiagnostic }),
	});

	const createServer = (port?: number): RpcServer =>
		createRpcServer({
			identity: deps.serverIdentity,
			hostname: deps.hostname ?? "127.0.0.1",
			...(port === undefined ? {} : { port }),
			path: deps.path ?? "/mobile",
			maxRequestBodyBytes: deps.maxRequestBodyBytes ?? 32 * 1024,
			authenticate: deps.authenticate,
			handleHttpRequest: deps.handleHttpRequest,
			acceptedPeerRoles: ["mobile-client"],
			generationFence: deps.generationFence,
			handlers,
			methodAllowlist: agentsServerMobileMethodAllowlist,
			limits: {
				maxFrameBytes: productRpcMaxFrameBytes,
				maxBufferedOutboundBytes: productRpcMaxBufferedOutboundBytes,
			},
			...(deps.onTraffic === undefined ? {} : { onTraffic: deps.onTraffic }),
			...(deps.onClose === undefined ? {} : { onClose: deps.onClose }),
			...(deps.onError === undefined ? {} : { onError: deps.onError }),
		});

	const revoke = (input: RevokeMobileDeviceInput): RevokeMobileDeviceOutput => {
		if (deps.revokeDeviceKey === undefined) {
			throw new Error("Mobile ingress composition was constructed without a revokeDeviceKey.");
		}
		return revokeMobileDevice(
			{
				mobileAttention: deps.mobileAttention,
				revokeDeviceKey: deps.revokeDeviceKey,
				...(deps.disconnectMobileDevice === undefined
					? {}
					: { disconnectMobileDevice: deps.disconnectMobileDevice }),
			},
			input,
		);
	};

	return { allowlist: agentsServerMobileMethodAllowlist, handlers, drainer, createServer, revoke };
}
