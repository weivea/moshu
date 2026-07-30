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
	runtimeBoxProductEventMethods,
	runtimeBoxProductRequestMethods,
	runtimeBoxRegisterOutputSchema,
	listRuntimeBoxesOutputSchema,
	type ListRuntimeBoxesOutput,
	remoteAccessMutationOutputSchema,
	remoteAccessStatusOutputSchema,
	createProjectOutputSchema,
	deleteProjectOutputSchema,
	getProjectOutputSchema,
	listProjectsOutputSchema,
	updateProjectOutputSchema,
	setProjectArchivedOutputSchema,
	switchRuntimeBoxOutputSchema,
	runtimeBoxToolProgressEventSchema,
	runtimeBoxInventoryChangedHintSchema,
	listRuntimeBoxInventoryOutputSchema,
	listRuntimeBoxMcpServerSummariesOutputSchema,
	listMcpServersOutputSchema,
	mcpServerMutationResultSchema,
	listRuntimeBoxSkillsOutputSchema,
	runtimeBoxResourceMutationResultSchema,
	getRuntimeProfileOutputSchema,
	getAgentGlobalProfileOutputSchema,
	updateRuntimeProfileOutputSchema,
	updateAgentGlobalProfileOutputSchema,
	productRpcInternalHandlerErrorCode,
	productRpcEvents,
	productRpcMethods,
	productRpcRequestSchemas,
	currentRuntimeBoxProtocolVersion,
	runtimeDiagnosticsOutputSchema,
	type RuntimeDiagnosticsOutput,
} from "@moshu/contracts";
import {
	ChatSessionNotFoundError,
	ActiveRuntimeRevisionConflictError,
	RuntimeBoxArchivedError,
	RuntimeBoxNotFoundError,
	PairingFingerprintMismatchError,
	PairingSessionNotFoundError,
	PairingSessionStateError,
	type RuntimeBoxRepository,
	type RuntimeBoxPairingRepository,
	type RuntimeBoxInventoryRepository,
	type RuntimeProfileRepository,
	RuntimeProfileRevisionConflictError,
	type AgentGlobalProfileRepository,
	AgentGlobalProfileRevisionConflictError,
	type AgentServerMcpRepository,
	McpResourceNotFoundError,
	McpResourceVersionConflictError,
	type ProjectRepository,
	ProjectNotFoundError,
	ProjectPathConflictError,
	SessionCreateCapacityError,
	SessionCreateKeyConflictError,
} from "@moshu/database";
import {
	isSameRpcPeerIdentity,
	type JsonValue,
	RpcHandlerError,
	RpcRemoteError,
	type RpcHandlers,
	type RpcMethodAllowlist,
	type RpcPeer,
	type RpcRequestContext,
	rpcJsonValueSchema,
} from "@moshu/process-rpc";
import { ZodError, type ZodType, type z } from "zod";

import type { ChatApplicationService } from "./chat-application-service";
import { ProviderCatalogError } from "./provider-catalog";
import { type RuntimeBoxRegistry, RuntimeBoxUnavailableError } from "./runtime-box-registry";
import type { RuntimeIngressAuth } from "./runtime-ingress-auth";
import type { DevTunnelService } from "./dev-tunnel-service";

export interface ProductRpcDependencies {
	chatService: ChatApplicationService;
	runtimeBoxRegistry: RuntimeBoxRegistry;
	runtimeBoxes: RuntimeBoxRepository;
	runtimeBoxPairings?: RuntimeBoxPairingRepository;
	projects?: ProjectRepository;
	runtimeBoxInventory?: RuntimeBoxInventoryRepository;
	runtimeProfiles?: RuntimeProfileRepository;
	agentGlobalProfiles?: AgentGlobalProfileRepository;
	agentServerMcps?: AgentServerMcpRepository;
	runtimeIngressAuth: RuntimeIngressAuth;
	getDevTunnelService: () => DevTunnelService;
	eventRouter: ProductEventRouter;
	serverVersion: string;
	authController: HeadlessAuthController;
	getRuntimeDiagnostics?: () => RuntimeDiagnosticsOutput;
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

export const agentsServerClientMethodAllowlist: RpcMethodAllowlist = {
	client: { requests: clientProductRequestMethods },
};

export const agentsServerRuntimeMethodAllowlist: RpcMethodAllowlist = {
	"runtime-box": {
		requests: runtimeBoxProductRequestMethods,
		events: runtimeBoxProductEventMethods,
	},
};

export function createProductRpcHandlers(dependencies: ProductRpcDependencies): RpcHandlers {
	const {
		chatService,
		runtimeBoxRegistry,
		runtimeBoxes,
		runtimeBoxPairings,
		projects,
		runtimeBoxInventory,
		runtimeProfiles,
		agentGlobalProfiles,
		agentServerMcps,
		runtimeIngressAuth,
		getDevTunnelService,
		eventRouter,
		authController,
		getRuntimeDiagnostics,
	} = dependencies;
	const getProjects = (): ProjectRepository => {
		if (projects === undefined) {
			throw new Error("Project repository is not initialized.");
		}
		return projects;
	};
	const getRuntimeBoxInventory = (): RuntimeBoxInventoryRepository => {
		if (runtimeBoxInventory === undefined) {
			throw new Error("Runtime Box inventory repository is not initialized.");
		}
		return runtimeBoxInventory;
	};
	const getRuntimeProfiles = (): RuntimeProfileRepository => {
		if (runtimeProfiles === undefined) {
			throw new Error("Runtime Profile repository is not initialized.");
		}
		return runtimeProfiles;
	};
	const getAgentGlobalProfiles = (): AgentGlobalProfileRepository => {
		if (agentGlobalProfiles === undefined) {
			throw new Error("Agent global profile repository is not initialized.");
		}
		return agentGlobalProfiles;
	};
	const getAgentServerMcps = (): AgentServerMcpRepository => {
		if (agentServerMcps === undefined) {
			throw new Error("Agent Server MCP repository is not initialized.");
		}
		return agentServerMcps;
	};
	const resolveRuntimeBoxId = (runtimeBoxId: string | undefined): string =>
		runtimeBoxId ?? runtimeBoxes.getActive().runtimeBoxId;
	const assertResourceNotReferenced = (
		runtimeBoxId: string,
		resourceKind: "mcp" | "skill",
		stableResourceId: string,
	): void => {
		if (getRuntimeProfiles().isResourceReferenced(runtimeBoxId, resourceKind, stableResourceId)) {
			throw new RpcHandlerError(
				"RUNTIME_RESOURCE_IN_USE",
				"Remove the resource from every Runtime Profile before deleting it.",
			);
		}
	};
	const runtimeResourceMutationTails = new Map<string, Promise<void>>();
	const serializeRuntimeResourceMutation = async <T>(
		runtimeBoxId: string,
		operation: () => Promise<T>,
	): Promise<T> => {
		const previous = runtimeResourceMutationTails.get(runtimeBoxId) ?? Promise.resolve();
		const execution = previous.then(operation, operation);
		const tail = execution.then(
			() => undefined,
			() => undefined,
		);
		runtimeResourceMutationTails.set(runtimeBoxId, tail);
		try {
			return await execution;
		} finally {
			if (runtimeResourceMutationTails.get(runtimeBoxId) === tail) {
				runtimeResourceMutationTails.delete(runtimeBoxId);
			}
		}
	};
	const requireProjectRuntimeReady = (projectId: string): void => {
		const project = getProjects().get({ projectId }).project;
		if (!runtimeBoxRegistry.isReady(project.runtimeBoxId)) {
			throw new RuntimeBoxUnavailableError(
				`Runtime Box ${project.runtimeBoxId} is not available for Project mutation.`,
			);
		}
	};
	return {
		requests: {
			[productRpcMethods.runtimeGet]: createRequestHandler(
				productRpcRequestSchemas[productRpcMethods.runtimeGet],
				() =>
					agentsRuntimeInfoSchema.parse({
						apiVersion: 3,
						serverVersion: dependencies.serverVersion,
						bunVersion: Bun.version,
						platform: process.platform,
						arch: process.arch,
						agentRuntime: probeAgentRuntime(),
						activeRuntimeBoxId: runtimeBoxes.getActive().runtimeBoxId,
						runtimeBoxes: runtimeBoxRegistry.listInfo(),
					}),
			),
			[productRpcMethods.runtimeBoxesList]: createRequestHandler(
				productRpcRequestSchemas[productRpcMethods.runtimeBoxesList],
				() => createRuntimeBoxesSnapshot(runtimeBoxes, runtimeBoxRegistry, runtimeBoxPairings),
			),
			[productRpcMethods.runtimeBoxesSwitch]: createRequestHandler(
				productRpcRequestSchemas[productRpcMethods.runtimeBoxesSwitch],
				(input) => {
					const active = runtimeBoxes.switchActive(input);
					runtimeBoxRegistry.setActiveRuntimeBoxId(active.runtimeBoxId);
					return switchRuntimeBoxOutputSchema.parse({ active });
				},
			),
			[productRpcMethods.runtimeBoxesPairingCreate]: createRequestHandler(
				productRpcRequestSchemas[productRpcMethods.runtimeBoxesPairingCreate],
				() => {
					const pairing = runtimeIngressAuth.createPairing();
					const remoteStatus = getDevTunnelService().getStatus();
					const publicUrl = remoteStatus.state === "online" ? remoteStatus.publicUrl : undefined;
					return {
						...pairing,
						...(publicUrl === undefined ? {} : { runtimeBaseUrl: publicUrl }),
					};
				},
			),
			[productRpcMethods.runtimeBoxesPairingListClaims]: createRequestHandler(
				productRpcRequestSchemas[productRpcMethods.runtimeBoxesPairingListClaims],
				() => runtimeIngressAuth.listPendingClaims(),
			),
			[productRpcMethods.runtimeBoxesPairingApprove]: createRequestHandler(
				productRpcRequestSchemas[productRpcMethods.runtimeBoxesPairingApprove],
				(input) => {
					const output = runtimeIngressAuth.approve(input);
					runtimeBoxRegistry.addDescriptor(output.runtimeBox);
					return output;
				},
			),
			[productRpcMethods.runtimeBoxesPairingReject]: createRequestHandler(
				productRpcRequestSchemas[productRpcMethods.runtimeBoxesPairingReject],
				(input) => runtimeIngressAuth.reject(input),
			),
			[productRpcMethods.runtimeBoxesDeviceRevoke]: createRequestHandler(
				productRpcRequestSchemas[productRpcMethods.runtimeBoxesDeviceRevoke],
				(input) => {
					const output = runtimeIngressAuth.revokeDeviceKey(input);
					runtimeBoxRegistry.disconnectRuntimeBox(
						input.runtimeBoxId,
						"Runtime Box device key revoked.",
					);
					return output;
				},
			),
			[productRpcMethods.remoteAccessStatus]: createRequestHandler(
				productRpcRequestSchemas[productRpcMethods.remoteAccessStatus],
				async (_input, _peer, context) =>
					remoteAccessStatusOutputSchema.parse(
						await getDevTunnelService().refreshAuthentication(context.signal),
					),
			),
			[productRpcMethods.remoteAccessAuthStart]: createRequestHandler(
				productRpcRequestSchemas[productRpcMethods.remoteAccessAuthStart],
				() => getDevTunnelService().startAuthentication(),
			),
			[productRpcMethods.remoteAccessAuthGet]: createRequestHandler(
				productRpcRequestSchemas[productRpcMethods.remoteAccessAuthGet],
				(input) => getDevTunnelService().getAuthentication(input.attemptId),
			),
			[productRpcMethods.remoteAccessEnable]: createRequestHandler(
				productRpcRequestSchemas[productRpcMethods.remoteAccessEnable],
				async (_input, _peer, context) =>
					remoteAccessMutationOutputSchema.parse({
						status: await getDevTunnelService().enable(context.signal),
					}),
			),
			[productRpcMethods.remoteAccessDisable]: createRequestHandler(
				productRpcRequestSchemas[productRpcMethods.remoteAccessDisable],
				async () =>
					remoteAccessMutationOutputSchema.parse({
						status: await getDevTunnelService().disable(),
					}),
			),
			[productRpcMethods.remoteAccessRecreate]: createRequestHandler(
				productRpcRequestSchemas[productRpcMethods.remoteAccessRecreate],
				async (_input, _peer, context) =>
					remoteAccessMutationOutputSchema.parse({
						status: await getDevTunnelService().recreate(context.signal),
					}),
			),
			[productRpcMethods.runtimeDiagnosticsGet]: createRequestHandler(
				productRpcRequestSchemas[productRpcMethods.runtimeDiagnosticsGet],
				() => {
					if (getRuntimeDiagnostics === undefined) {
						throw new Error("Runtime diagnostics are not initialized.");
					}
					return runtimeDiagnosticsOutputSchema.parse(getRuntimeDiagnostics());
				},
			),
			[productRpcMethods.projectsCreate]: createRequestHandler(
				productRpcRequestSchemas[productRpcMethods.projectsCreate],
				async (input, _peer, context) => {
					const runtimeBoxId = input.runtimeBoxId ?? runtimeBoxes.getActive().runtimeBoxId;
					runtimeBoxes.get(runtimeBoxId);
					const validated = await runtimeBoxRegistry.validateProjectPath(
						runtimeBoxId,
						{ path: input.path },
						context.signal,
					);
					return createProjectOutputSchema.parse(
						getProjects().create({
							runtimeBoxId,
							name: input.name ?? validated.displayName,
							path: validated.normalizedPath,
							...(validated.gitRootPath === undefined
								? {}
								: { gitRootPath: validated.gitRootPath }),
							...(validated.gitBranch === undefined ? {} : { gitBranch: validated.gitBranch }),
						}),
					);
				},
			),
			[productRpcMethods.projectsList]: createRequestHandler(
				productRpcRequestSchemas[productRpcMethods.projectsList],
				(input) => listProjectsOutputSchema.parse(getProjects().list(input)),
			),
			[productRpcMethods.projectsGet]: createRequestHandler(
				productRpcRequestSchemas[productRpcMethods.projectsGet],
				(input) => getProjectOutputSchema.parse(getProjects().get(input)),
			),
			[productRpcMethods.projectsUpdate]: createRequestHandler(
				productRpcRequestSchemas[productRpcMethods.projectsUpdate],
				(input) => {
					requireProjectRuntimeReady(input.projectId);
					return updateProjectOutputSchema.parse(getProjects().update(input));
				},
			),
			[productRpcMethods.projectsArchive]: createRequestHandler(
				productRpcRequestSchemas[productRpcMethods.projectsArchive],
				(input) => {
					requireProjectRuntimeReady(input.projectId);
					return setProjectArchivedOutputSchema.parse(getProjects().setArchived(input));
				},
			),
			[productRpcMethods.projectsDelete]: createRequestHandler(
				productRpcRequestSchemas[productRpcMethods.projectsDelete],
				(input) => {
					requireProjectRuntimeReady(input.projectId);
					return deleteProjectOutputSchema.parse(getProjects().delete(input));
				},
			),
			[productRpcMethods.runtimeInventoryList]: createRequestHandler(
				productRpcRequestSchemas[productRpcMethods.runtimeInventoryList],
				(input) =>
					listRuntimeBoxInventoryOutputSchema.parse(
						getRuntimeBoxInventory().list(resolveRuntimeBoxId(input.runtimeBoxId)),
					),
			),
			[productRpcMethods.mcpServersList]: createRequestHandler(
				productRpcRequestSchemas[productRpcMethods.mcpServersList],
				async (input, _peer, context) => {
					const output = await runtimeBoxRegistry.listMcpServers(
						resolveRuntimeBoxId(input.runtimeBoxId),
						context.signal,
					);
					return listRuntimeBoxMcpServerSummariesOutputSchema.parse({
						runtimeBoxId: output.runtimeBoxId,
						items: output.items.map((server) => ({
							stableResourceId: server.stableResourceId,
							configRevision: server.configRevision,
							version: server.version,
							contentHash: server.contentHash,
							displayName: server.displayName,
							enabled: server.enabled,
							credentialConfigured: server.credentialConfigured,
							health: server.health,
							tools: server.tools,
						})),
					});
				},
			),
			[productRpcMethods.mcpServersUpsert]: createRequestHandler(
				productRpcRequestSchemas[productRpcMethods.mcpServersUpsert],
				async (input, _peer, context) => {
					const runtimeBoxId = resolveRuntimeBoxId(input.runtimeBoxId);
					return serializeRuntimeResourceMutation(runtimeBoxId, async () =>
						runtimeBoxResourceMutationResultSchema.parse(
							await runtimeBoxRegistry.upsertMcpServer(runtimeBoxId, input, context.signal),
						),
					);
				},
			),
			[productRpcMethods.mcpServersSetEnabled]: createRequestHandler(
				productRpcRequestSchemas[productRpcMethods.mcpServersSetEnabled],
				async (input, _peer, context) => {
					const runtimeBoxId = resolveRuntimeBoxId(input.runtimeBoxId);
					return serializeRuntimeResourceMutation(runtimeBoxId, async () =>
						runtimeBoxResourceMutationResultSchema.parse(
							await runtimeBoxRegistry.setMcpServerEnabled(runtimeBoxId, input, context.signal),
						),
					);
				},
			),
			[productRpcMethods.mcpServersDelete]: createRequestHandler(
				productRpcRequestSchemas[productRpcMethods.mcpServersDelete],
				async (input, _peer, context) => {
					const runtimeBoxId = resolveRuntimeBoxId(input.runtimeBoxId);
					return serializeRuntimeResourceMutation(runtimeBoxId, async () => {
						assertResourceNotReferenced(runtimeBoxId, "mcp", input.stableResourceId);
						return runtimeBoxResourceMutationResultSchema.parse(
							await runtimeBoxRegistry.deleteMcpServer(runtimeBoxId, input, context.signal),
						);
					});
				},
			),
			[productRpcMethods.mcpList]: createRequestHandler(
				productRpcRequestSchemas[productRpcMethods.mcpList],
				async (input, _peer, context) => {
					if (input.owner.kind === "agent-server") {
						return listMcpServersOutputSchema.parse(getAgentServerMcps().list());
					}
					const output = await runtimeBoxRegistry.listMcpServers(
						input.owner.runtimeBoxId,
						context.signal,
					);
					return listMcpServersOutputSchema.parse({
						owner: input.owner,
						items: output.items.map((server) => ({
							owner: input.owner,
							stableResourceId: server.stableResourceId,
							configRevision: server.configRevision,
							version: server.version,
							contentHash: server.contentHash,
							displayName: server.displayName,
							enabled: server.enabled,
							credentialConfigured: server.credentialConfigured,
							health: server.health,
							tools: server.tools,
							stale: false,
						})),
					});
				},
			),
			[productRpcMethods.mcpUpsert]: createRequestHandler(
				productRpcRequestSchemas[productRpcMethods.mcpUpsert],
				async (input, _peer, context) => {
					if (input.owner.kind === "agent-server") {
						return serializeRuntimeResourceMutation("agent-server", async () =>
							mcpServerMutationResultSchema.parse(getAgentServerMcps().upsert(input)),
						);
					}
					const runtimeBoxId = input.owner.runtimeBoxId;
					const { owner: _owner, ...command } = input;
					return serializeRuntimeResourceMutation(runtimeBoxId, async () => {
						const result = await runtimeBoxRegistry.upsertMcpServer(
							runtimeBoxId,
							{ ...command, runtimeBoxId },
							context.signal,
						);
						return mcpServerMutationResultSchema.parse({
							owner: input.owner,
							stableResourceId: result.stableResourceId,
							configRevision: requireMcpConfigRevision(result.configRevision),
							version: result.version,
							contentHash: result.contentHash,
							deleted: result.deleted,
						});
					});
				},
			),
			[productRpcMethods.mcpSetEnabled]: createRequestHandler(
				productRpcRequestSchemas[productRpcMethods.mcpSetEnabled],
				async (input, _peer, context) => {
					if (input.owner.kind === "agent-server") {
						return serializeRuntimeResourceMutation("agent-server", async () =>
							mcpServerMutationResultSchema.parse(getAgentServerMcps().setEnabled(input)),
						);
					}
					const runtimeBoxId = input.owner.runtimeBoxId;
					const { owner: _owner, ...command } = input;
					return serializeRuntimeResourceMutation(runtimeBoxId, async () => {
						const result = await runtimeBoxRegistry.setMcpServerEnabled(
							runtimeBoxId,
							{ ...command, runtimeBoxId },
							context.signal,
						);
						return mcpServerMutationResultSchema.parse({
							owner: input.owner,
							stableResourceId: result.stableResourceId,
							configRevision: requireMcpConfigRevision(result.configRevision),
							version: result.version,
							contentHash: result.contentHash,
							deleted: result.deleted,
						});
					});
				},
			),
			[productRpcMethods.mcpDelete]: createRequestHandler(
				productRpcRequestSchemas[productRpcMethods.mcpDelete],
				async (input, _peer, context) => {
					if (input.owner.kind === "agent-server") {
						return serializeRuntimeResourceMutation("agent-server", async () => {
							if (getAgentGlobalProfiles().isResourceReferenced(input.stableResourceId)) {
								throw new RpcHandlerError(
									"MCP_RESOURCE_IN_USE",
									"Remove the MCP Server from every Agent before deleting it.",
								);
							}
							return mcpServerMutationResultSchema.parse(getAgentServerMcps().delete(input));
						});
					}
					const runtimeBoxId = input.owner.runtimeBoxId;
					const { owner: _owner, ...command } = input;
					return serializeRuntimeResourceMutation(runtimeBoxId, async () => {
						assertResourceNotReferenced(runtimeBoxId, "mcp", input.stableResourceId);
						const result = await runtimeBoxRegistry.deleteMcpServer(
							runtimeBoxId,
							{ ...command, runtimeBoxId },
							context.signal,
						);
						return mcpServerMutationResultSchema.parse({
							owner: input.owner,
							stableResourceId: result.stableResourceId,
							configRevision: requireMcpConfigRevision(result.configRevision),
							version: result.version,
							contentHash: result.contentHash,
							deleted: result.deleted,
						});
					});
				},
			),
			[productRpcMethods.agentGlobalProfileGet]: createRequestHandler(
				productRpcRequestSchemas[productRpcMethods.agentGlobalProfileGet],
				(input) =>
					getAgentGlobalProfileOutputSchema.parse({
						profile: getAgentGlobalProfiles().getOrCreate(input.agentId),
					}),
			),
			[productRpcMethods.agentGlobalProfileUpdate]: createRequestHandler(
				productRpcRequestSchemas[productRpcMethods.agentGlobalProfileUpdate],
				(input) =>
					serializeRuntimeResourceMutation("agent-server", async () => {
						getAgentServerMcps().resolveRefs(input.serverMcpRefs);
						return updateAgentGlobalProfileOutputSchema.parse({
							profile: getAgentGlobalProfiles().update(input),
						});
					}),
			),
			[productRpcMethods.skillsList]: createRequestHandler(
				productRpcRequestSchemas[productRpcMethods.skillsList],
				async (input, _peer, context) =>
					listRuntimeBoxSkillsOutputSchema.parse(
						await runtimeBoxRegistry.listSkills(
							resolveRuntimeBoxId(input.runtimeBoxId),
							context.signal,
						),
					),
			),
			[productRpcMethods.skillsInstall]: createRequestHandler(
				productRpcRequestSchemas[productRpcMethods.skillsInstall],
				async (input, _peer, context) => {
					const runtimeBoxId = resolveRuntimeBoxId(input.runtimeBoxId);
					return serializeRuntimeResourceMutation(runtimeBoxId, async () =>
						runtimeBoxResourceMutationResultSchema.parse(
							await runtimeBoxRegistry.installSkill(runtimeBoxId, input, context.signal),
						),
					);
				},
			),
			[productRpcMethods.skillsDelete]: createRequestHandler(
				productRpcRequestSchemas[productRpcMethods.skillsDelete],
				async (input, _peer, context) => {
					const runtimeBoxId = resolveRuntimeBoxId(input.runtimeBoxId);
					return serializeRuntimeResourceMutation(runtimeBoxId, async () => {
						assertResourceNotReferenced(runtimeBoxId, "skill", input.stableResourceId);
						return runtimeBoxResourceMutationResultSchema.parse(
							await runtimeBoxRegistry.deleteSkill(runtimeBoxId, input, context.signal),
						);
					});
				},
			),
			[productRpcMethods.runtimeProfilesGet]: createRequestHandler(
				productRpcRequestSchemas[productRpcMethods.runtimeProfilesGet],
				(input) =>
					getRuntimeProfileOutputSchema.parse({
						profile: getRuntimeProfiles().getOrCreate(
							input.agentId,
							resolveRuntimeBoxId(input.runtimeBoxId),
						),
					}),
			),
			[productRpcMethods.runtimeProfilesUpdate]: createRequestHandler(
				productRpcRequestSchemas[productRpcMethods.runtimeProfilesUpdate],
				async (input, _peer, context) => {
					const runtimeBoxId = resolveRuntimeBoxId(input.runtimeBoxId);
					return serializeRuntimeResourceMutation(runtimeBoxId, async () => {
						const validation = await runtimeBoxRegistry.validateResources(
							runtimeBoxId,
							{ refs: input.resources },
							context.signal,
						);
						if (!validation.valid) {
							throw new RpcHandlerError(
								"RUNTIME_RESOURCE_VALIDATION_FAILED",
								validation.issues[0]?.message ?? "Runtime Profile resource validation failed.",
							);
						}
						return updateRuntimeProfileOutputSchema.parse({
							profile: getRuntimeProfiles().update({
								agentId: input.agentId,
								runtimeBoxId,
								expectedRevision: input.expectedRevision,
								resources: input.resources,
							}),
						});
					});
				},
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
			[productRpcMethods.runtimeBoxRegister]: createRequestHandler(
				productRpcRequestSchemas[productRpcMethods.runtimeBoxRegister],
				async (input, peer) => {
					runtimeBoxRegistry.register(peer, input.runtimeBox, {
						protocolVersion: input.protocolVersion,
						transportSecurity: input.transportSecurity,
					});
					try {
						await runtimeBoxRegistry.synchronizeInventory(peer);
					} catch (error) {
						runtimeBoxRegistry.clear(peer);
						throw error;
					}
					return runtimeBoxRegisterOutputSchema.parse({
						schemaVersion: 1,
						accepted: true,
						runtimeBoxId: input.runtimeBox.runtimeBoxId,
						negotiatedProtocolVersion: currentRuntimeBoxProtocolVersion,
						transportSecurity: input.transportSecurity,
					});
				},
			),
			[productRpcMethods.runtimeBoxReady]: createRequestHandler(
				productRpcRequestSchemas[productRpcMethods.runtimeBoxReady],
				(_input, peer) => {
					runtimeBoxRegistry.markReady(peer);
					return runtimeBoxRegisterOutputSchema.parse({
						schemaVersion: 1,
						accepted: true,
						runtimeBoxId: peer.remoteIdentity.peerId,
						negotiatedProtocolVersion: currentRuntimeBoxProtocolVersion,
						transportSecurity: "relay-tls",
					});
				},
			),
			[productRpcMethods.runtimeBoxInvocationsReconcile]: createRequestHandler(
				productRpcRequestSchemas[productRpcMethods.runtimeBoxInvocationsReconcile],
				(input, peer) => {
					if (peer.remoteIdentity.role !== "runtime-box") {
						throw new RpcHandlerError(
							"RUNTIME_BOX_IDENTITY_REQUIRED",
							"Action reconciliation requires an authenticated Runtime Box.",
						);
					}
					return runtimeBoxRegistry.reconcileInvocations(
						peer.remoteIdentity.peerId,
						input.items,
						input.acknowledgedInvocationIds,
					);
				},
			),
		},
		events: {
			[productRpcEvents.runtimeBoxToolProgress]: (payload, context) => {
				let event: z.infer<typeof runtimeBoxToolProgressEventSchema>;
				try {
					event = runtimeBoxToolProgressEventSchema.parse(payload);
				} catch (error) {
					if (error instanceof ZodError) {
						throw new RpcHandlerError(
							"INVALID_RUNTIME_BOX_TOOL_PROGRESS",
							"The Runtime Box tool progress payload is invalid.",
						);
					}
					throw error;
				}
				runtimeBoxRegistry.handleProgress(context.peer, event);
			},
			[productRpcEvents.runtimeBoxInventoryChanged]: (payload, context) => {
				const hint = runtimeBoxInventoryChangedHintSchema.parse(payload);
				runtimeBoxRegistry.handleInventoryChanged(context.peer, hint);
			},
		},
	};
}

export function createRuntimeBoxesSnapshot(
	runtimeBoxes: RuntimeBoxRepository,
	registry: RuntimeBoxRegistry,
	pairings?: RuntimeBoxPairingRepository,
): ListRuntimeBoxesOutput {
	return listRuntimeBoxesOutputSchema.parse({
		active: runtimeBoxes.getActive(),
		items: registry.listInfo().map((item) => ({
			...item,
			deviceKeyIds:
				pairings?.listActiveDeviceKeys(item.runtimeBox.runtimeBoxId).map((key) => key.keyId) ?? [],
		})),
	});
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
		context: RpcRequestContext,
	) => z.input<TOutputSchema> | Promise<z.input<TOutputSchema>>,
): (payload: JsonValue, context: RpcRequestContext) => Promise<JsonValue> {
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
			output = await execute(input, context.peer, context);
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
	if (error instanceof ActiveRuntimeRevisionConflictError) {
		throw new RpcHandlerError("ACTIVE_RUNTIME_REVISION_CONFLICT", error.message, {
			actualRevision: error.actualRevision,
		});
	}
	if (error instanceof RuntimeBoxNotFoundError) {
		throw new RpcHandlerError("RUNTIME_BOX_NOT_FOUND", "The Runtime Box was not found.");
	}
	if (error instanceof RuntimeBoxArchivedError) {
		throw new RpcHandlerError("RUNTIME_BOX_ARCHIVED", "The Runtime Box is archived.");
	}
	if (error instanceof RuntimeBoxUnavailableError) {
		throw new RpcHandlerError("RUNTIME_BOX_NOT_READY", error.message);
	}
	if (error instanceof RuntimeProfileRevisionConflictError) {
		throw new RpcHandlerError("RUNTIME_PROFILE_REVISION_CONFLICT", error.message, {
			actualRevision: error.actualRevision,
		});
	}
	if (error instanceof AgentGlobalProfileRevisionConflictError) {
		throw new RpcHandlerError("AGENT_GLOBAL_PROFILE_REVISION_CONFLICT", error.message, {
			actualRevision: error.actualRevision,
		});
	}
	if (error instanceof McpResourceNotFoundError) {
		throw new RpcHandlerError("MCP_NOT_READY", error.message);
	}
	if (error instanceof McpResourceVersionConflictError) {
		throw new RpcHandlerError("MCP_RESOURCE_VERSION_CONFLICT", error.message);
	}
	if (error instanceof RpcRemoteError) {
		if (
			[
				"RUNTIME_RESOURCE_VERSION_CONFLICT",
				"RUNTIME_RESOURCE_NOT_FOUND",
				"RUNTIME_RESOURCE_WRONG_BOX",
				"INVENTORY_RESYNC_REQUIRED",
			].includes(error.code)
		) {
			throw new RpcHandlerError(error.code, error.message);
		}
		throw new RpcHandlerError(
			"RUNTIME_RESOURCE_COMMAND_FAILED",
			"Runtime Box resource command failed.",
		);
	}
	if (error instanceof ProjectNotFoundError) {
		throw new RpcHandlerError("PROJECT_NOT_FOUND", "The Project was not found.");
	}
	if (error instanceof ProjectPathConflictError) {
		throw new RpcHandlerError("PROJECT_PATH_CONFLICT", "The Project path is already registered.");
	}
	if (
		error instanceof PairingSessionNotFoundError ||
		error instanceof PairingSessionStateError ||
		error instanceof PairingFingerprintMismatchError
	) {
		throw new RpcHandlerError("RUNTIME_BOX_PAIRING_REJECTED", "Runtime Box pairing failed.");
	}
	if (error instanceof AskChatRuntimeError) {
		throw new RpcHandlerError(
			error.kind === "runtime_box_unavailable" ? "RUNTIME_BOX_NOT_READY" : "CHAT_REQUEST_FAILED",
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

function requireMcpConfigRevision(value: number | undefined): number {
	if (value === undefined) {
		throw new Error("Runtime Box MCP mutation omitted its config revision.");
	}
	return value;
}
