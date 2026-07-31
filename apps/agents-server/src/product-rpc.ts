import {
	AskChatRuntimeError,
	type HeadlessAuthController,
	ProviderCapacityError,
	ProviderModelNotFoundError,
	ProviderNotFoundError,
	probeAgentRuntime,
} from "@moshu/agent-runtime";
import {
	agentsRuntimeInfoSchema,
	approvalRpcErrorCodes,
	clientProductRequestMethods,
	currentRuntimeBoxProtocolVersion,
	getAgentGlobalProfileOutputSchema,
	getRuntimeProfileOutputSchema,
	type ListRuntimeBoxesOutput,
	listMcpServersOutputSchema,
	listMobileDevicesOutputSchema,
	listRuntimeBoxesOutputSchema,
	listRuntimeBoxInventoryOutputSchema,
	listRuntimeBoxMcpServerSummariesOutputSchema,
	listRuntimeBoxSkillsOutputSchema,
	listSkillsOutputSchema,
	mcpServerMutationResultSchema,
	mobileAccessStatusOutputSchema,
	mobileClientProductEventMethods,
	mobileClientProductRequestMethods,
	mobileProtocolMaxVersion,
	mobileProtocolMinVersion,
	productRpcEvents,
	productRpcInternalHandlerErrorCode,
	productRpcMethods,
	productRpcRequestSchemas,
	type RuntimeDiagnosticsOutput,
	remoteAccessMutationOutputSchema,
	remoteAccessStatusOutputSchema,
	runtimeBoxInventoryChangedHintSchema,
	runtimeBoxProductEventMethods,
	runtimeBoxProductRequestMethods,
	runtimeBoxRegisterOutputSchema,
	runtimeBoxResourceMutationResultSchema,
	runtimeBoxToolProgressEventSchema,
	runtimeDiagnosticsOutputSchema,
	skillMutationResultSchema,
	skillSummarySchema,
	switchRuntimeBoxOutputSchema,
	updateAgentGlobalProfileOutputSchema,
	updateRuntimeProfileOutputSchema,
} from "@moshu/contracts";
import {
	ActiveRuntimeRevisionConflictError,
	type AgentGlobalProfileRepository,
	AgentGlobalProfileRevisionConflictError,
	type AgentServerMcpRepository,
	type AgentServerSkillRepository,
	ApprovalRequestNotFoundError,
	ApprovalRevisionConflictError,
	ChatSessionNotFoundError,
	McpResourceNotFoundError,
	McpResourceVersionConflictError,
	type MobileDeviceRepository,
	PairingFingerprintMismatchError,
	PairingSessionNotFoundError,
	PairingSessionStateError,
	ProjectNotFoundError,
	ProjectPathConflictError,
	RuntimeBoxArchivedError,
	type RuntimeBoxInventoryRepository,
	RuntimeBoxNotFoundError,
	type RuntimeBoxPairingRepository,
	type RuntimeBoxRepository,
	type RuntimeProfileRepository,
	RuntimeProfileRevisionConflictError,
	SessionApprovalPolicyRevisionConflictError,
	SessionCreateCapacityError,
	SessionCreateKeyConflictError,
	SkillOwnerCapabilityError,
	SkillPackageValidationError,
	SkillResourceNotFoundError,
	SkillResourceVersionConflictError,
} from "@moshu/database";
import {
	type JsonValue,
	RpcHandlerError,
	type RpcHandlers,
	type RpcMethodAllowlist,
	type RpcPeer,
	RpcRemoteError,
	type RpcRequestContext,
	rpcJsonValueSchema,
} from "@moshu/process-rpc";
import { ZodError, type ZodType, type z } from "zod";
import { ApprovalRunUnavailableError, type ApprovalService } from "./approval-service";
import type { ChatApplicationService } from "./chat-application-service";
import type { DevTunnelService } from "./dev-tunnel-service";
import type { MobileIngressAuth } from "./mobile-ingress-auth";
import {
	broadcastApprovalActivityChanged,
	ProductEventRouter,
	publishChatEvent,
	publishRetiredChatSessions,
} from "./product-event-hub";
import {
	type ProjectApplicationService,
	ProjectArchivedError,
	ProjectDeletingError,
	ProjectHasActiveRunsError,
	ProjectHasUnacknowledgedActionsError,
	ProjectNameConfirmationMismatchError,
	ProjectPathUnavailableError,
	ProjectPreviewStaleError,
	ProjectRelinkRuntimeMismatchError,
	ProjectRuntimeUnavailableError,
} from "./project-application-service";
import { ProviderCatalogError } from "./provider-catalog";
import {
	RuntimeBoxCapabilityError,
	type RuntimeBoxRegistry,
	RuntimeBoxUnavailableError,
} from "./runtime-box-registry";
import type { RuntimeIngressAuth } from "./runtime-ingress-auth";

export interface ProductRpcDependencies {
	chatService: ChatApplicationService;
	approvalService: ApprovalService;
	runtimeBoxRegistry: RuntimeBoxRegistry;
	runtimeBoxes: RuntimeBoxRepository;
	runtimeBoxPairings?: RuntimeBoxPairingRepository;
	mobileIngressAuth?: MobileIngressAuth;
	mobileDevices?: MobileDeviceRepository;
	disconnectMobileDevice?: (mobileClientId: string, reason: string) => void;
	projectService?: ProjectApplicationService;
	runtimeBoxInventory?: RuntimeBoxInventoryRepository;
	runtimeProfiles?: RuntimeProfileRepository;
	agentGlobalProfiles?: AgentGlobalProfileRepository;
	agentServerMcps?: AgentServerMcpRepository;
	agentServerSkills?: AgentServerSkillRepository;
	runtimeIngressAuth: RuntimeIngressAuth;
	getDevTunnelService: () => DevTunnelService;
	eventRouter: ProductEventRouter;
	serverVersion: string;
	authController: HeadlessAuthController;
	getRuntimeDiagnostics?: () => RuntimeDiagnosticsOutput;
}

export type { ProductEventRouteLease } from "./product-event-hub";
export {
	broadcastApprovalActivityChanged,
	ProductEventRouter,
	publishChatEvent,
	publishRetiredChatSessions,
};

export const agentsServerClientMethodAllowlist: RpcMethodAllowlist = {
	client: { requests: clientProductRequestMethods },
};

export const agentsServerRuntimeMethodAllowlist: RpcMethodAllowlist = {
	"runtime-box": {
		requests: runtimeBoxProductRequestMethods,
		events: runtimeBoxProductEventMethods,
	},
};

// The Mobile ingress reuses the shared Product handlers but is pinned to its own strict allowlist so
// an authenticated Mobile client can only reach the MVP subset — never Provider auth, Remote Access
// control, Runtime Box pairing/device revoke, MCP/Skills, Project mutations, diagnostics, or any
// Desktop-only surface. Requests/events outside this set are rejected by the RPC layer before a
// handler runs, even though the same handler map backs the Product ingress.
export const agentsServerMobileMethodAllowlist: RpcMethodAllowlist = {
	"mobile-client": {
		requests: mobileClientProductRequestMethods,
		events: mobileClientProductEventMethods,
	},
};

export function createProductRpcHandlers(dependencies: ProductRpcDependencies): RpcHandlers {
	const {
		chatService,
		approvalService,
		runtimeBoxRegistry,
		runtimeBoxes,
		runtimeBoxPairings,
		mobileIngressAuth,
		mobileDevices,
		disconnectMobileDevice,
		projectService,
		runtimeBoxInventory,
		runtimeProfiles,
		agentGlobalProfiles,
		agentServerMcps,
		agentServerSkills,
		runtimeIngressAuth,
		getDevTunnelService,
		eventRouter,
		authController,
		getRuntimeDiagnostics,
	} = dependencies;
	const getProjectService = (): ProjectApplicationService => {
		if (projectService === undefined) {
			throw new Error("Project application service is not initialized.");
		}
		return projectService;
	};
	const requireMobileIngressAuth = (): MobileIngressAuth => {
		if (mobileIngressAuth === undefined) {
			throw new Error("Mobile ingress auth is not initialized.");
		}
		return mobileIngressAuth;
	};
	const requireMobileDevices = (): MobileDeviceRepository => {
		if (mobileDevices === undefined) {
			throw new Error("Mobile device repository is not initialized.");
		}
		return mobileDevices;
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
	const getAgentServerSkills = (): AgentServerSkillRepository => {
		if (agentServerSkills === undefined) {
			throw new Error("Agent Server Skill repository is not initialized.");
		}
		return agentServerSkills;
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
	return {
		requests: {
			[productRpcMethods.runtimeGet]: createRequestHandler(
				productRpcRequestSchemas[productRpcMethods.runtimeGet],
				(_input, peer) =>
					agentsRuntimeInfoSchema.parse({
						apiVersion: 3,
						serverVersion: dependencies.serverVersion,
						bunVersion: Bun.version,
						platform: process.platform,
						arch: process.arch,
						agentRuntime: probeAgentRuntime(),
						activeRuntimeBoxId: runtimeBoxes.getActiveForClient(resolveProductClientId(peer))
							.runtimeBoxId,
						runtimeBoxes: runtimeBoxRegistry.listInfo(),
					}),
			),
			[productRpcMethods.runtimeBoxesList]: createRequestHandler(
				productRpcRequestSchemas[productRpcMethods.runtimeBoxesList],
				(_input, peer) =>
					createRuntimeBoxesSnapshot(
						runtimeBoxes,
						runtimeBoxRegistry,
						runtimeBoxPairings,
						resolveProductClientId(peer),
					),
			),
			[productRpcMethods.runtimeBoxesSwitch]: createRequestHandler(
				productRpcRequestSchemas[productRpcMethods.runtimeBoxesSwitch],
				(input, peer) => {
					const active = runtimeBoxes.switchActiveForClient(resolveProductClientId(peer), input);
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
			[productRpcMethods.mobileAccessStatus]: createRequestHandler(
				productRpcRequestSchemas[productRpcMethods.mobileAccessStatus],
				() => {
					const service = getDevTunnelService();
					const status = service.getStatus();
					const ingress = service.getIngressReadiness().find((entry) => entry.kind === "mobile");
					if (ingress === undefined) {
						throw new RpcHandlerError(
							"MOBILE_INGRESS_UNAVAILABLE",
							"The Mobile ingress is not configured.",
						);
					}
					return mobileAccessStatusOutputSchema.parse({
						schemaVersion: 1,
						remoteAccessEnabled: status.enabled,
						remoteAccessState: status.state,
						ingressPort: ingress.port,
						ingressReady: ingress.ready,
						...(ingress.publicUrl === undefined ? {} : { publicUrl: ingress.publicUrl }),
						protocolMinVersion: mobileProtocolMinVersion,
						protocolMaxVersion: mobileProtocolMaxVersion,
						transportSecurity: "relay-tls",
						supportedTransportSecurity: ["relay-tls"],
					});
				},
			),
			[productRpcMethods.mobilePairingCreate]: createRequestHandler(
				productRpcRequestSchemas[productRpcMethods.mobilePairingCreate],
				() => requireMobileIngressAuth().createPairing(),
			),
			[productRpcMethods.mobilePairingListClaims]: createRequestHandler(
				productRpcRequestSchemas[productRpcMethods.mobilePairingListClaims],
				() => requireMobileIngressAuth().listPendingClaims(),
			),
			[productRpcMethods.mobilePairingApprove]: createRequestHandler(
				productRpcRequestSchemas[productRpcMethods.mobilePairingApprove],
				(input) => requireMobileIngressAuth().approve(input),
			),
			[productRpcMethods.mobilePairingReject]: createRequestHandler(
				productRpcRequestSchemas[productRpcMethods.mobilePairingReject],
				(input) => requireMobileIngressAuth().reject(input),
			),
			[productRpcMethods.mobileDeviceList]: createRequestHandler(
				productRpcRequestSchemas[productRpcMethods.mobileDeviceList],
				(input) => listMobileDevicesOutputSchema.parse(requireMobileDevices().list(input)),
			),
			[productRpcMethods.mobileDeviceRevoke]: createRequestHandler(
				productRpcRequestSchemas[productRpcMethods.mobileDeviceRevoke],
				(input) => {
					const output = requireMobileIngressAuth().revokeDevice(input);
					disconnectMobileDevice?.(input.mobileClientId, "Mobile device revoked.");
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
			[productRpcMethods.projectsPreviewPath]: createRequestHandler(
				productRpcRequestSchemas[productRpcMethods.projectsPreviewPath],
				(input, peer, context) =>
					getProjectService().previewPath(input, resolveProductClientId(peer), context.signal),
			),
			[productRpcMethods.projectsCreate]: createRequestHandler(
				productRpcRequestSchemas[productRpcMethods.projectsCreate],
				(input, peer, context) =>
					getProjectService().create(input, resolveProductClientId(peer), context.signal),
			),
			[productRpcMethods.projectsList]: createRequestHandler(
				productRpcRequestSchemas[productRpcMethods.projectsList],
				(input) => getProjectService().list(input),
			),
			[productRpcMethods.projectsGet]: createRequestHandler(
				productRpcRequestSchemas[productRpcMethods.projectsGet],
				(input) => getProjectService().get(input),
			),
			[productRpcMethods.projectsCheckPath]: createRequestHandler(
				productRpcRequestSchemas[productRpcMethods.projectsCheckPath],
				(input, _peer, context) => getProjectService().checkPath(input, context.signal),
			),
			[productRpcMethods.projectsUpdateName]: createRequestHandler(
				productRpcRequestSchemas[productRpcMethods.projectsUpdateName],
				(input) => getProjectService().updateName(input),
			),
			[productRpcMethods.projectsUpdate]: createRequestHandler(
				productRpcRequestSchemas[productRpcMethods.projectsUpdate],
				(input) => getProjectService().updateName(input),
			),
			[productRpcMethods.projectsPreviewRelink]: createRequestHandler(
				productRpcRequestSchemas[productRpcMethods.projectsPreviewRelink],
				(input, _peer, context) => getProjectService().previewRelink(input, context.signal),
			),
			[productRpcMethods.projectsRelink]: createRequestHandler(
				productRpcRequestSchemas[productRpcMethods.projectsRelink],
				(input, _peer, context) => getProjectService().relink(input, context.signal),
			),
			[productRpcMethods.projectsSetArchived]: createRequestHandler(
				productRpcRequestSchemas[productRpcMethods.projectsSetArchived],
				(input) => getProjectService().setArchived(input),
			),
			[productRpcMethods.projectsArchive]: createRequestHandler(
				productRpcRequestSchemas[productRpcMethods.projectsArchive],
				(input) => getProjectService().setArchived(input),
			),
			[productRpcMethods.projectsGetDeleteConfirmation]: createRequestHandler(
				productRpcRequestSchemas[productRpcMethods.projectsGetDeleteConfirmation],
				(input) => getProjectService().getDeleteConfirmation(input),
			),
			[productRpcMethods.projectsDelete]: createRequestHandler(
				productRpcRequestSchemas[productRpcMethods.projectsDelete],
				(input) => getProjectService().requestDeletion(input),
			),
			[productRpcMethods.projectsGetSidebar]: createRequestHandler(
				productRpcRequestSchemas[productRpcMethods.projectsGetSidebar],
				(input) => getProjectService().getSidebar(input),
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
							if (getAgentGlobalProfiles().isResourceReferenced("mcp", input.stableResourceId)) {
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
						if (input.serverSkillRefs.length > 0) {
							const names = new Set<string>();
							for (const resolved of getAgentServerSkills().resolveRefs(input.serverSkillRefs)) {
								const name = resolved.summary.metadata?.name;
								if (name !== undefined && names.has(name)) {
									throw new RpcHandlerError(
										"SKILL_NAME_CONFLICT",
										`Skill name ${name} is assigned more than once.`,
									);
								}
								if (name !== undefined) {
									names.add(name);
								}
							}
						}
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
			[productRpcMethods.skillList]: createRequestHandler(
				productRpcRequestSchemas[productRpcMethods.skillList],
				async (input, _peer, context) => {
					if (input.owner.kind === "agent-server") {
						return listSkillsOutputSchema.parse(getAgentServerSkills().list());
					}
					const output = await runtimeBoxRegistry.listSkills(
						input.owner.runtimeBoxId,
						context.signal,
					);
					return listSkillsOutputSchema.parse({
						owner: input.owner,
						items: output.items.map((skill) =>
							skillSummarySchema.parse({
								owner: input.owner,
								stableResourceId: skill.stableResourceId,
								configRevision: skill.configRevision,
								version: skill.version,
								contentHash: skill.contentHash,
								metadata: skill.metadata,
								enabled: skill.enabled,
								health: skill.enabled ? "ready" : "stopped",
								packageKind: "runtime-package",
								sourceKind: toSkillSourceKind(skill.source),
								stale: false,
								installedAt: skill.installedAt,
								updatedAt: skill.updatedAt,
							}),
						),
					});
				},
			),
			[productRpcMethods.skillUpsert]: createRequestHandler(
				productRpcRequestSchemas[productRpcMethods.skillUpsert],
				async (input, _peer, context) => {
					if (input.owner.kind === "agent-server") {
						return serializeRuntimeResourceMutation("agent-server", async () =>
							skillMutationResultSchema.parse(getAgentServerSkills().upsert(input)),
						);
					}
					const runtimeBoxId = input.owner.runtimeBoxId;
					runtimeBoxRegistry.requireCapability(runtimeBoxId, "skills.config.v2");
					const { owner: _owner, source, ...command } = input;
					return serializeRuntimeResourceMutation(runtimeBoxId, async () => {
						const result = await runtimeBoxRegistry.installSkill(
							runtimeBoxId,
							{
								...command,
								runtimeBoxId,
								source: source.label ?? source.kind,
							},
							context.signal,
						);
						return skillMutationResultSchema.parse({
							owner: input.owner,
							stableResourceId: result.stableResourceId,
							configRevision: result.configRevision,
							version: result.version,
							contentHash: result.contentHash,
							deleted: result.deleted,
						});
					});
				},
			),
			[productRpcMethods.skillSetEnabled]: createRequestHandler(
				productRpcRequestSchemas[productRpcMethods.skillSetEnabled],
				async (input, _peer, context) => {
					if (input.owner.kind === "agent-server") {
						return serializeRuntimeResourceMutation("agent-server", async () =>
							skillMutationResultSchema.parse(getAgentServerSkills().setEnabled(input)),
						);
					}
					const runtimeBoxId = input.owner.runtimeBoxId;
					runtimeBoxRegistry.requireCapability(runtimeBoxId, "skills.config.v2");
					const { owner: _owner, ...command } = input;
					return serializeRuntimeResourceMutation(runtimeBoxId, async () => {
						const result = await runtimeBoxRegistry.setSkillEnabled(
							runtimeBoxId,
							{ ...command, runtimeBoxId },
							context.signal,
						);
						return skillMutationResultSchema.parse({
							owner: input.owner,
							stableResourceId: result.stableResourceId,
							configRevision: result.configRevision,
							version: result.version,
							contentHash: result.contentHash,
							deleted: result.deleted,
						});
					});
				},
			),
			[productRpcMethods.skillDelete]: createRequestHandler(
				productRpcRequestSchemas[productRpcMethods.skillDelete],
				async (input, _peer, context) => {
					if (input.owner.kind === "agent-server") {
						return serializeRuntimeResourceMutation("agent-server", async () => {
							if (getAgentGlobalProfiles().isResourceReferenced("skill", input.stableResourceId)) {
								throw new RpcHandlerError(
									"SKILL_RESOURCE_IN_USE",
									"Remove the Skill from every Agent before deleting it.",
								);
							}
							return skillMutationResultSchema.parse(getAgentServerSkills().delete(input));
						});
					}
					const runtimeBoxId = input.owner.runtimeBoxId;
					runtimeBoxRegistry.requireCapability(runtimeBoxId, "skills.config.v2");
					const { owner: _owner, ...command } = input;
					return serializeRuntimeResourceMutation(runtimeBoxId, async () => {
						assertResourceNotReferenced(runtimeBoxId, "skill", input.stableResourceId);
						const result = await runtimeBoxRegistry.deleteSkill(
							runtimeBoxId,
							{ ...command, runtimeBoxId },
							context.signal,
						);
						return skillMutationResultSchema.parse({
							owner: input.owner,
							stableResourceId: result.stableResourceId,
							configRevision: result.configRevision,
							version: result.version,
							contentHash: result.contentHash,
							deleted: result.deleted,
						});
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
				(input, peer, context) =>
					chatService.createSessionIdempotently(input, peer.remoteIdentity, context.signal),
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
				async (input, peer, context) => {
					const routeLease = eventRouter.bind(input.requestId, peer);
					try {
						const output = await chatService.sendMessageWithPreflight(input, context.signal);
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
			[productRpcMethods.chatSubscribe]: createRequestHandler(
				productRpcRequestSchemas[productRpcMethods.chatSubscribe],
				(input, peer) => {
					chatService.assertSessionVisible(input.sessionId);
					eventRouter.subscribe(peer, input.sessionId);
					return {
						schemaVersion: 1 as const,
						sessionId: input.sessionId,
						subscribed: true as const,
					};
				},
			),
			[productRpcMethods.chatUnsubscribe]: createRequestHandler(
				productRpcRequestSchemas[productRpcMethods.chatUnsubscribe],
				(input, peer) => {
					eventRouter.unsubscribe(peer, input.sessionId);
					return {
						schemaVersion: 1 as const,
						sessionId: input.sessionId,
						subscribed: false as const,
					};
				},
			),
			[productRpcMethods.chatRetiredSessionsList]: createRequestHandler(
				productRpcRequestSchemas[productRpcMethods.chatRetiredSessionsList],
				(input) => chatService.listRetiredSessions(input),
			),
			[productRpcMethods.approvalsList]: createRequestHandler(
				productRpcRequestSchemas[productRpcMethods.approvalsList],
				(input) => {
					if (input.sessionId !== undefined) {
						// Scoped listing is authorization-checked against Session visibility; an
						// unscoped listing is the cross-session Activity snapshot for this client.
						chatService.assertSessionVisible(input.sessionId);
					}
					return approvalService.listApprovals({
						...(input.sessionId === undefined ? {} : { sessionId: input.sessionId }),
						...(input.states === undefined ? {} : { states: input.states }),
						...(input.limit === undefined ? {} : { limit: input.limit }),
					});
				},
			),
			[productRpcMethods.approvalsGet]: createRequestHandler(
				productRpcRequestSchemas[productRpcMethods.approvalsGet],
				(input) => {
					const result = approvalService.getApproval(input.approvalId);
					chatService.assertSessionVisible(result.request.sessionId);
					return { schemaVersion: 1 as const, ...result };
				},
			),
			[productRpcMethods.approvalsDecide]: createRequestHandler(
				productRpcRequestSchemas[productRpcMethods.approvalsDecide],
				(input, peer) => {
					// Resolve + authorize the Session before applying the decision so a client
					// cannot decide an approval for a Session it cannot see.
					const existing = approvalService.getApproval(input.approvalId);
					chatService.assertSessionVisible(existing.request.sessionId);
					return approvalService.decideApproval({
						approvalId: input.approvalId,
						expectedRevision: input.expectedRevision,
						decision: input.decision,
						idempotencyKey: input.idempotencyKey,
						source: approvalDecisionSource(peer),
					});
				},
			),
			[productRpcMethods.sessionApprovalPolicyGet]: createRequestHandler(
				productRpcRequestSchemas[productRpcMethods.sessionApprovalPolicyGet],
				(input) => {
					chatService.assertSessionVisible(input.sessionId);
					return {
						schemaVersion: 1 as const,
						policy: approvalService.getSessionPolicy(input.sessionId),
					};
				},
			),
			[productRpcMethods.sessionApprovalPolicyUpdate]: createRequestHandler(
				productRpcRequestSchemas[productRpcMethods.sessionApprovalPolicyUpdate],
				(input, peer) => {
					chatService.assertSessionVisible(input.sessionId);
					return approvalService.updateSessionPolicy({
						sessionId: input.sessionId,
						allowAll: input.allowAll,
						expectedRevision: input.expectedRevision,
						idempotencyKey: input.idempotencyKey,
						updatedBy: approvalDecisionSource(peer),
					});
				},
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
	clientId?: string,
): ListRuntimeBoxesOutput {
	return listRuntimeBoxesOutputSchema.parse({
		active:
			clientId === undefined ? runtimeBoxes.getActive() : runtimeBoxes.getActiveForClient(clientId),
		items: registry.listInfo().map((item) => ({
			...item,
			deviceKeyIds:
				pairings?.listActiveDeviceKeys(item.runtimeBox.runtimeBoxId).map((key) => key.keyId) ?? [],
		})),
	});
}

// Runtime Box selection is a per-client preference. The client identity is the authenticated peer's
// stable `peerId`; the server never trusts a caller-supplied client id. Only product clients (the
// Desktop app today, a Mobile client in a later layer) hold a selection.
function resolveProductClientId(peer: RpcPeer): string {
	if (peer.remoteIdentity.role !== "client" && peer.remoteIdentity.role !== "mobile-client") {
		throw new RpcHandlerError(
			"CLIENT_IDENTITY_REQUIRED",
			"Runtime Box selection is only available to authenticated product clients.",
		);
	}
	return peer.remoteIdentity.peerId;
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

function toSkillSourceKind(source: string): "inline-editor" | "local-upload" | "import" {
	if (source === "inline-editor" || source === "import") {
		return source;
	}
	return "local-upload";
}

// The decision source is server-derived from the authenticated peer identity, never
// trusted from request input, so a client cannot forge who decided an approval.
function approvalDecisionSource(peer: RpcPeer): {
	kind: "client";
	clientId: string;
	clientRole: string;
} {
	return {
		kind: "client",
		clientId: peer.remoteIdentity.peerId,
		clientRole: peer.remoteIdentity.role,
	};
}

function rethrowProductHandlerError(error: unknown): never {
	if (error instanceof RpcHandlerError) {
		throw error;
	}
	if (error instanceof ChatSessionNotFoundError) {
		throw new RpcHandlerError("SESSION_NOT_FOUND", "The chat Session was not found.");
	}
	if (error instanceof ApprovalRequestNotFoundError) {
		throw new RpcHandlerError(approvalRpcErrorCodes.notFound, "The approval was not found.");
	}
	if (error instanceof ApprovalRevisionConflictError) {
		throw new RpcHandlerError(
			approvalRpcErrorCodes.revisionConflict,
			"The approval was decided by another client.",
			{ currentRevision: error.currentRevision },
		);
	}
	if (error instanceof SessionApprovalPolicyRevisionConflictError) {
		throw new RpcHandlerError(
			approvalRpcErrorCodes.policyRevisionConflict,
			"The Session approval policy changed concurrently.",
			{ currentRevision: error.currentRevision },
		);
	}
	if (error instanceof ApprovalRunUnavailableError) {
		throw new RpcHandlerError(approvalRpcErrorCodes.notFound, "The approval Run is unavailable.");
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
	if (error instanceof RuntimeBoxCapabilityError) {
		throw new RpcHandlerError("RUNTIME_BOX_CAPABILITY_MISSING", error.message, {
			runtimeBoxId: error.runtimeBoxId,
			capability: error.capability,
		});
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
	if (error instanceof SkillResourceNotFoundError) {
		throw new RpcHandlerError("SKILL_NOT_READY", error.message);
	}
	if (error instanceof SkillResourceVersionConflictError) {
		throw new RpcHandlerError("SKILL_VERSION_MISMATCH", error.message);
	}
	if (error instanceof SkillOwnerCapabilityError) {
		throw new RpcHandlerError("SKILL_OWNER_CAPABILITY_MISMATCH", error.message);
	}
	if (error instanceof SkillPackageValidationError) {
		throw new RpcHandlerError("SKILL_PACKAGE_INVALID", error.message);
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
		throw new RpcHandlerError("PROJECT_PATH_CONFLICT", "The Project path is already registered.", {
			conflictingProjectId: error.conflictingProjectId,
			conflictingProjectArchived: error.conflictingProjectArchived,
		});
	}
	if (error instanceof ProjectPreviewStaleError) {
		throw new RpcHandlerError("PROJECT_PREVIEW_STALE", error.message);
	}
	if (error instanceof ProjectRuntimeUnavailableError) {
		throw new RpcHandlerError("PROJECT_RUNTIME_UNAVAILABLE", error.message);
	}
	if (error instanceof ProjectPathUnavailableError) {
		throw new RpcHandlerError("PROJECT_PATH_UNAVAILABLE", error.message, {
			issueCode: error.issueCode,
		});
	}
	if (error instanceof ProjectArchivedError) {
		throw new RpcHandlerError("PROJECT_ARCHIVED", error.message);
	}
	if (error instanceof ProjectDeletingError) {
		throw new RpcHandlerError("PROJECT_DELETING", error.message);
	}
	if (error instanceof ProjectHasActiveRunsError) {
		throw new RpcHandlerError("PROJECT_HAS_ACTIVE_RUNS", error.message);
	}
	if (error instanceof ProjectHasUnacknowledgedActionsError) {
		throw new RpcHandlerError("PROJECT_HAS_UNACKNOWLEDGED_ACTIONS", error.message);
	}
	if (error instanceof ProjectNameConfirmationMismatchError) {
		throw new RpcHandlerError("PROJECT_NAME_CONFIRMATION_MISMATCH", error.message);
	}
	if (error instanceof ProjectRelinkRuntimeMismatchError) {
		throw new RpcHandlerError("PROJECT_RELINK_RUNTIME_MISMATCH", error.message);
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
	if (error instanceof Error && error.name === "SQLiteError") {
		throw new RpcHandlerError(
			productRpcInternalHandlerErrorCode,
			"The Product RPC database operation failed.",
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
