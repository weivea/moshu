import {
	AskChatRuntimeError,
	type HeadlessAuthController,
	ProviderCapacityError,
	ProviderModelNotFoundError,
	ProviderNotFoundError,
	probeAgentRuntime,
} from "@moshu/agent-runtime";
import {
	agentsProductEventMethods,
	agentsRuntimeInfoSchema,
	type ChatRunEvent,
	chatEventDeliverySchema,
	chatRunEventSchema,
	clientProductRequestMethods,
	executorProductEventMethods,
	executorProductRequestMethods,
	executorRegisterOutputSchema,
	executorToolProgressEventSchema,
	productRpcInternalHandlerErrorCode,
	productRpcEvents,
	productRpcMethods,
	productRpcRequestSchemas,
} from "@moshu/contracts";
import {
	ChatSessionNotFoundError,
	SessionCreateCapacityError,
	SessionCreateKeyConflictError,
} from "@moshu/database";
import {
	isSameRpcPeerIdentity,
	type JsonValue,
	RpcHandlerError,
	type RpcHandlers,
	type RpcMethodAllowlist,
	type RpcPeer,
	rpcJsonValueSchema,
} from "@moshu/process-rpc";
import { ZodError, type ZodType, type z } from "zod";

import type { ChatApplicationService } from "./chat-application-service";
import type { ExecutorReadiness } from "./executor-readiness";
import { ProviderCatalogError } from "./provider-catalog";

export interface ProductRpcDependencies {
	chatService: ChatApplicationService;
	executorReadiness: ExecutorReadiness;
	eventRouter: ProductEventRouter;
	serverVersion: string;
	authController: HeadlessAuthController;
}

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

export class ProductEventRouter {
	readonly #bindingsByRequestId = new Map<string, ProductEventRouteBinding>();

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
		if (this.#bindingsByRequestId.size >= 1_024) {
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

	releasePeer(peer: RpcPeer): void {
		for (const [requestId, binding] of this.#bindingsByRequestId) {
			if (isSameRpcPeerIdentity(binding.peerIdentity, peer.remoteIdentity)) {
				this.#bindingsByRequestId.delete(requestId);
			}
		}
	}

	publish(peers: readonly RpcPeer[], event: ChatRunEvent, clientRequestId: string): void {
		const binding = this.#bindingsByRequestId.get(clientRequestId);
		if (binding === undefined) {
			return;
		}
		publishChatEvent(
			peers.filter(
				(peer) =>
					peer.remoteIdentity.role === "client" &&
					isSameRpcPeerIdentity(peer.remoteIdentity, binding.peerIdentity),
			),
			event,
			clientRequestId,
		);
		if (
			event.type === "run.status" &&
			(event.payload.status === "completed" ||
				event.payload.status === "failed" ||
				event.payload.status === "cancelled")
		) {
			if (this.#bindingsByRequestId.get(clientRequestId) === binding) {
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

export const agentsServerMethodAllowlist: RpcMethodAllowlist = {
	client: { requests: clientProductRequestMethods },
	executor: {
		requests: executorProductRequestMethods,
		events: executorProductEventMethods,
	},
};

export function createProductRpcHandlers(dependencies: ProductRpcDependencies): RpcHandlers {
	const { chatService, executorReadiness, eventRouter, authController } = dependencies;
	return {
		requests: {
			[productRpcMethods.runtimeGet]: createRequestHandler(
				productRpcRequestSchemas[productRpcMethods.runtimeGet],
				() =>
					agentsRuntimeInfoSchema.parse({
						apiVersion: 2,
						serverVersion: dependencies.serverVersion,
						bunVersion: Bun.version,
						platform: process.platform,
						arch: process.arch,
						agentRuntime: probeAgentRuntime(),
						ready: executorReadiness.isReady(),
						executor: executorReadiness.getInfo(),
					}),
			),
			[productRpcMethods.providersList]: createRequestHandler(
				productRpcRequestSchemas[productRpcMethods.providersList],
				() => chatService.listProviders(),
			),
			[productRpcMethods.providersCreate]: createRequestHandler(
				productRpcRequestSchemas[productRpcMethods.providersCreate],
				(input) => chatService.createProvider(input),
			),
			[productRpcMethods.providersUpdate]: createRequestHandler(
				productRpcRequestSchemas[productRpcMethods.providersUpdate],
				(input) => chatService.updateProvider(input),
			),
			[productRpcMethods.providersDelete]: createRequestHandler(
				productRpcRequestSchemas[productRpcMethods.providersDelete],
				(input) => chatService.deleteProvider(input),
			),
			[productRpcMethods.providersTest]: createRequestHandler(
				productRpcRequestSchemas[productRpcMethods.providersTest],
				(input) => chatService.testProvider(input),
			),
			[productRpcMethods.providersFetchModels]: createRequestHandler(
				productRpcRequestSchemas[productRpcMethods.providersFetchModels],
				(input) => chatService.fetchProviderModels(input),
			),
			[productRpcMethods.providersSetModelsEnabled]: createRequestHandler(
				productRpcRequestSchemas[productRpcMethods.providersSetModelsEnabled],
				(input) => chatService.setProviderModelsEnabled(input),
			),
			[productRpcMethods.modelsListAvailable]: createRequestHandler(
				productRpcRequestSchemas[productRpcMethods.modelsListAvailable],
				() => chatService.listAvailableModels(),
			),
			[productRpcMethods.defaultModelGet]: createRequestHandler(
				productRpcRequestSchemas[productRpcMethods.defaultModelGet],
				() => chatService.getDefaultModel(),
			),
			[productRpcMethods.defaultModelSet]: createRequestHandler(
				productRpcRequestSchemas[productRpcMethods.defaultModelSet],
				(input) => chatService.setDefaultModel(input),
			),
			[productRpcMethods.providerAuthStart]: createRequestHandler(
				productRpcRequestSchemas[productRpcMethods.providerAuthStart],
				(input) => authController.start(input),
			),
			[productRpcMethods.providerAuthGet]: createRequestHandler(
				productRpcRequestSchemas[productRpcMethods.providerAuthGet],
				(input) => authController.get(input.attemptId),
			),
			[productRpcMethods.providerAuthRespond]: createRequestHandler(
				productRpcRequestSchemas[productRpcMethods.providerAuthRespond],
				(input) => authController.respond(input),
			),
			[productRpcMethods.providerAuthCancel]: createRequestHandler(
				productRpcRequestSchemas[productRpcMethods.providerAuthCancel],
				(input) => authController.cancel(input.attemptId),
			),
			[productRpcMethods.providerLogout]: createRequestHandler(
				productRpcRequestSchemas[productRpcMethods.providerLogout],
				(input) => authController.logout(input.providerId),
			),
			[productRpcMethods.sessionCreate]: createRequestHandler(
				productRpcRequestSchemas[productRpcMethods.sessionCreate],
				(input, peer) => chatService.createSessionIdempotently(input, peer.remoteIdentity),
			),
			[productRpcMethods.sessionGet]: createRequestHandler(
				productRpcRequestSchemas[productRpcMethods.sessionGet],
				(input) => chatService.getSessionPage(input),
			),
			[productRpcMethods.sessionList]: createRequestHandler(
				productRpcRequestSchemas[productRpcMethods.sessionList],
				(input) => chatService.listSessions(input),
			),
			[productRpcMethods.sessionUpdate]: createRequestHandler(
				productRpcRequestSchemas[productRpcMethods.sessionUpdate],
				(input) => chatService.updateSession(input),
			),
			[productRpcMethods.sessionArchive]: createRequestHandler(
				productRpcRequestSchemas[productRpcMethods.sessionArchive],
				(input) => chatService.setSessionArchived(input),
			),
			[productRpcMethods.sessionSetModel]: createRequestHandler(
				productRpcRequestSchemas[productRpcMethods.sessionSetModel],
				(input) => chatService.setSessionModel(input),
			),
			[productRpcMethods.sessionDelete]: createRequestHandler(
				productRpcRequestSchemas[productRpcMethods.sessionDelete],
				(input) => chatService.deleteSession(input),
			),
			[productRpcMethods.chatSend]: createRequestHandler(
				productRpcRequestSchemas[productRpcMethods.chatSend],
				(input, peer) => {
					const routeLease = eventRouter.bind(input.requestId, peer);
					try {
						const output = chatService.sendMessage(input);
						eventRouter.commit(routeLease);
						if (
							output.run.status === "completed" ||
							output.run.status === "failed" ||
							output.run.status === "cancelled"
						) {
							eventRouter.release(routeLease);
						}
						return output;
					} catch (error) {
						eventRouter.rollback(routeLease);
						throw error;
					}
				},
			),
			[productRpcMethods.chatCancel]: createRequestHandler(
				productRpcRequestSchemas[productRpcMethods.chatCancel],
				(input) => chatService.cancel(input),
			),
			[productRpcMethods.chatReplay]: createRequestHandler(
				productRpcRequestSchemas[productRpcMethods.chatReplay],
				(input) => chatService.replayEvents(input),
			),
			[productRpcMethods.executorRegister]: createRequestHandler(
				productRpcRequestSchemas[productRpcMethods.executorRegister],
				(_input, peer) => {
					executorReadiness.register(peer);
					return executorRegisterOutputSchema.parse({ schemaVersion: 1, accepted: true });
				},
			),
		},
		events: {
			[productRpcEvents.executorToolProgress]: (payload, context) => {
				let event: z.infer<typeof executorToolProgressEventSchema>;
				try {
					event = executorToolProgressEventSchema.parse(payload);
				} catch (error) {
					if (error instanceof ZodError) {
						throw new RpcHandlerError(
							"INVALID_EXECUTOR_TOOL_PROGRESS",
							"The executor tool progress payload is invalid.",
						);
					}
					throw error;
				}
				executorReadiness.handleProgress(context.peer, event);
			},
		},
	};
}

export function publishChatEvent(
	peers: readonly RpcPeer[],
	event: ChatRunEvent,
	clientRequestId: string,
): void {
	const payload = encodeJsonValue(
		chatEventDeliverySchema.parse({
			clientRequestId,
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

function createRequestHandler<TInputSchema extends ZodType, TOutputSchema extends ZodType>(
	contract: { input: TInputSchema; output: TOutputSchema },
	execute: (
		input: z.output<TInputSchema>,
		peer: RpcPeer,
	) => z.input<TOutputSchema> | Promise<z.input<TOutputSchema>>,
): (payload: JsonValue, context: { peer: RpcPeer }) => Promise<JsonValue> {
	return async (payload, context) => {
		let input: z.output<TInputSchema>;
		try {
			input = contract.input.parse(payload);
		} catch (error) {
			if (error instanceof ZodError) {
				throw new RpcHandlerError(
					"INVALID_ARGUMENT",
					"The Product RPC request payload is invalid.",
				);
			}
			throw error;
		}
		let output: z.input<TOutputSchema>;
		try {
			output = await execute(input, context.peer);
		} catch (error) {
			rethrowProductHandlerError(error);
		}
		try {
			return encodeJsonValue(contract.output.parse(output));
		} catch {
			throw new RpcHandlerError(
				productRpcInternalHandlerErrorCode,
				"The Product RPC handler returned an invalid response.",
			);
		}
	};
}

function rethrowProductHandlerError(error: unknown): never {
	if (error instanceof RpcHandlerError) {
		throw error;
	}
	if (error instanceof ChatSessionNotFoundError) {
		throw new RpcHandlerError("SESSION_NOT_FOUND", "The chat Session was not found.");
	}
	if (error instanceof ProviderNotFoundError) {
		throw new RpcHandlerError("PROVIDER_NOT_FOUND", "The Provider was not found.");
	}
	if (error instanceof ProviderModelNotFoundError) {
		throw new RpcHandlerError("PROVIDER_MODEL_NOT_FOUND", "The Provider model was not found.");
	}
	if (error instanceof ProviderCapacityError) {
		throw new RpcHandlerError("PROVIDER_CAPACITY", error.message);
	}
	if (error instanceof ProviderCatalogError) {
		throw new RpcHandlerError("PROVIDER_MODEL_LIST_FAILED", error.message);
	}
	if (error instanceof SessionCreateKeyConflictError) {
		throw new RpcHandlerError(
			"SESSION_CREATE_KEY_CONFLICT",
			"The Session create key conflicts with an existing request.",
		);
	}
	if (error instanceof SessionCreateCapacityError) {
		throw new RpcHandlerError(
			"SESSION_CREATE_CAPACITY",
			"Session create recovery capacity is full.",
		);
	}
	if (error instanceof AskChatRuntimeError) {
		throw new RpcHandlerError(
			error.message.includes("executor is not authenticated")
				? "AGENTS_NOT_READY"
				: "CHAT_REQUEST_FAILED",
			error.message,
		);
	}
	if (error instanceof ZodError) {
		throw new RpcHandlerError(
			productRpcInternalHandlerErrorCode,
			"The Product RPC handler failed internal validation.",
		);
	}
	throw error;
}

function encodeJsonValue(value: unknown): JsonValue {
	const encoded = JSON.stringify(value);
	if (encoded === undefined) {
		throw new RpcHandlerError("INTERNAL_ERROR", "Product RPC output is not JSON serializable.");
	}
	return rpcJsonValueSchema.parse(JSON.parse(encoded));
}
