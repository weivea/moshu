import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
	type HeadlessAuthController,
	ProviderCapacityError,
	ProviderModelNotFoundError,
	ProviderNotFoundError,
} from "@moshu/agent-runtime";
import {
	type ChatRunEvent,
	type CreateProcessChatSessionInput,
	chatSessionsRetiredEventSchema,
	clientProductRequestMethods,
	createChatSessionOutputSchema,
	defaultLocalRuntimeBoxId,
	getAgentGlobalProfileOutputSchema,
	type ListChatSessionsInput,
	mcpServerMutationResultSchema,
	type ProcessPeerIdentity,
	productRpcInternalHandlerErrorCode,
	productRpcMethods,
	runtimeBoxProductRequestMethods,
	skillMutationResultSchema,
} from "@moshu/contracts";
import {
	ChatSessionNotFoundError,
	openAppDatabase,
	type RuntimeBoxRepository,
} from "@moshu/database";
import { RpcHandlerError, type RpcPeer, rpcJsonValueSchema } from "@moshu/process-rpc";
import { FileSkillContentStore } from "@moshu/skill-runtime";
import { z } from "zod";

import type { ChatApplicationService } from "./chat-application-service";
import type { DevTunnelService } from "./dev-tunnel-service";
import {
	createProductRpcHandlers,
	ProductEventRouter,
	publishChatEvent,
	publishRetiredChatSessions,
} from "./product-rpc";
import { ProjectApplicationService } from "./project-application-service";
import { ProviderCatalogError } from "./provider-catalog";
import { type RuntimeBoxGatewayPeer, RuntimeBoxRegistry } from "./runtime-box-registry";
import type { RuntimeIngressAuth } from "./runtime-ingress-auth";

const authController = {} as HeadlessAuthController;
const runtimeBoxes = {} as RuntimeBoxRepository;
const runtimeIngressAuth = {} as RuntimeIngressAuth;
const devTunnelService = {} as DevTunnelService;

describe("Runtime Box product RPC", () => {
	test("lists and switches the persisted active Runtime Box with CAS", async () => {
		const database = openAppDatabase(":memory:");
		try {
			database.runtimeBoxes.upsertRegistration({
				schemaVersion: 1,
				runtimeBoxId: "remote-linux",
				kind: "remote",
				displayName: "Remote Linux",
				runtimeBoxVersion: "0.0.1",
				platform: "linux",
				arch: "x64",
				capabilities: [],
			});

			const active = database.runtimeBoxes.getActive();
			const registry = new RuntimeBoxRegistry({
				descriptors: database.runtimeBoxes.list(),
				activeRuntimeBoxId: active.runtimeBoxId,
			});

			const handlers = createProductRpcHandlers({
				authController,
				chatService: {} as ChatApplicationService,
				runtimeBoxRegistry: registry,
				runtimeBoxes: database.runtimeBoxes,
				runtimeIngressAuth,
				getDevTunnelService: () => devTunnelService,
				eventRouter: new ProductEventRouter(),
				serverVersion: "test",
			}).requests;
			const peer = createPeer({ emitEvent: () => "event", close() {} });
			const list = handlers?.[productRpcMethods.runtimeBoxesList];
			const switchRuntime = handlers?.[productRpcMethods.runtimeBoxesSwitch];
			if (list === undefined || switchRuntime === undefined) {
				throw new Error("Runtime Box handlers are missing.");
			}

			await expect(
				list({}, createRequestContext(peer, productRpcMethods.runtimeBoxesList)),
			).resolves.toMatchObject({
				active,
				items: [
					{ runtimeBox: { runtimeBoxId: "moshu-local-runtime-box" } },
					{ runtimeBox: { runtimeBoxId: "remote-linux" } },
				],
			});
			await expect(
				switchRuntime(
					{ runtimeBoxId: "remote-linux", expectedRevision: active.revision },
					createRequestContext(peer, productRpcMethods.runtimeBoxesSwitch),
				),
			).resolves.toEqual({
				active: { runtimeBoxId: "remote-linux", revision: active.revision + 1 },
			});
			expect(registry.getActiveRuntimeBoxId()).toBe("remote-linux");
			await expect(
				switchRuntime(
					{ runtimeBoxId: "moshu-local-runtime-box", expectedRevision: active.revision },
					createRequestContext(peer, productRpcMethods.runtimeBoxesSwitch),
				),
			).rejects.toMatchObject({ code: "ACTIVE_RUNTIME_REVISION_CONFLICT" });
		} finally {
			database.close();
		}
	});

	test("returns redacted version, registry, inventory, and integrity diagnostics", async () => {
		const handler = createProductRpcHandlers({
			authController,
			chatService: {} as ChatApplicationService,
			runtimeBoxRegistry: new RuntimeBoxRegistry(),
			runtimeBoxes,
			runtimeIngressAuth,
			getDevTunnelService: () => devTunnelService,
			eventRouter: new ProductEventRouter(),
			serverVersion: "test",
			getRuntimeDiagnostics: () => ({
				generatedAt: new Date().toISOString(),
				server: {
					version: "test",
					identity: {
						role: "agents",
						peerId: "agents",
						instanceId: "agents-instance",
						generation: 1,
					},
					processRpcProtocol: { major: 1, minor: 0 },
					runtimeProtocolMinVersion: 5,
					runtimeProtocolMaxVersion: 5,
					transportSecurity: "relay-tls",
					noiseUpgradeAvailable: false,
				},
				database: { schemaVersion: 18, integrity: "ok" },
				runtimeBoxes: [],
				inventories: [],
				remoteAccess: {
					enabled: false,
					authenticated: false,
					state: "disabled",
					runtimeIngressPort: 41_000,
					trafficEstimate: {
						month: new Date().toISOString().slice(0, 7),
						receivedBytes: 0,
						sentBytes: 0,
						totalBytes: 0,
						monthlyLimitBytes: 5 * 1024 * 1024 * 1024,
						warningLevel: "none",
						source: "runtime-rpc-application-payload-estimate",
					},
					serviceLimits: {
						maxTunnelsPerUser: 10,
						maxPortsPerTunnel: 10,
						maxBytesPerSecond: 20 * 1024 * 1024,
					},
				},
			}),
		}).requests?.[productRpcMethods.runtimeDiagnosticsGet];
		if (handler === undefined) {
			throw new Error("Runtime diagnostics handler is missing.");
		}
		await expect(
			handler(
				{},
				createRequestContext(
					createPeer({ emitEvent: () => "event", close() {} }),
					productRpcMethods.runtimeDiagnosticsGet,
				),
			),
		).resolves.toMatchObject({
			server: {
				processRpcProtocol: { major: 1, minor: 0 },
				transportSecurity: "relay-tls",
				noiseUpgradeAvailable: false,
			},
			database: { schemaVersion: 18, integrity: "ok" },
		});
	});

	test("never projects stored MCP transport configuration to the renderer", async () => {
		const registry = new RuntimeBoxRegistry();
		Object.defineProperty(registry, "listMcpServers", {
			value: async () => ({
				runtimeBoxId: "remote-box",
				items: [
					{
						stableResourceId: "private-mcp",
						configRevision: 1,
						version: crypto.randomUUID(),
						contentHash: "a".repeat(64),
						displayName: "Private MCP",
						enabled: true,
						transport: {
							type: "streamable-http",
							url: "https://mcp.example.test/rpc?token=must-not-project",
							timeoutMs: 30_000,
						},
						credentialConfigured: true,
						health: "ready",
						tools: [],
						createdAt: new Date().toISOString(),
						updatedAt: new Date().toISOString(),
					},
				],
			}),
		});
		const handler = createProductRpcHandlers({
			authController,
			chatService: {} as ChatApplicationService,
			runtimeBoxRegistry: registry,
			runtimeBoxes,
			runtimeIngressAuth,
			getDevTunnelService: () => devTunnelService,
			eventRouter: new ProductEventRouter(),
			serverVersion: "test",
		}).requests?.[productRpcMethods.mcpServersList];
		if (handler === undefined) {
			throw new Error("MCP summary handler is missing.");
		}
		const output = await handler(
			{ runtimeBoxId: "remote-box" },
			createRequestContext(
				createPeer({ emitEvent: () => "event", close() {} }),
				productRpcMethods.mcpServersList,
			),
		);
		expect(output).toMatchObject({
			items: [
				{
					stableResourceId: "private-mcp",
					displayName: "Private MCP",
					credentialConfigured: true,
				},
			],
		});
		expect(JSON.stringify(output)).not.toContain("must-not-project");
		expect(JSON.stringify(output)).not.toContain("transport");
	});

	test("manages Agent Server-owned MCPs and global Agent refs independently of Runtime Box", async () => {
		const database = openAppDatabase(":memory:");
		try {
			const handlers = createProductRpcHandlers({
				authController,
				chatService: {} as ChatApplicationService,
				runtimeBoxRegistry: new RuntimeBoxRegistry(),
				runtimeBoxes: database.runtimeBoxes,
				agentServerMcps: database.agentServerMcps,
				agentGlobalProfiles: database.agentGlobalProfiles,
				runtimeIngressAuth,
				getDevTunnelService: () => devTunnelService,
				eventRouter: new ProductEventRouter(),
				serverVersion: "test",
			}).requests;
			const upsert = handlers?.[productRpcMethods.mcpUpsert];
			const list = handlers?.[productRpcMethods.mcpList];
			const getProfile = handlers?.[productRpcMethods.agentGlobalProfileGet];
			const updateProfile = handlers?.[productRpcMethods.agentGlobalProfileUpdate];
			const remove = handlers?.[productRpcMethods.mcpDelete];
			if (
				upsert === undefined ||
				list === undefined ||
				getProfile === undefined ||
				updateProfile === undefined ||
				remove === undefined
			) {
				throw new Error("Agent Server MCP handlers are missing.");
			}
			const peer = createPeer({ emitEvent: () => "event", close() {} });
			const created = await upsert(
				{
					owner: { kind: "agent-server" },
					commandId: crypto.randomUUID(),
					displayName: "Global MCP",
					enabled: true,
					transport: {
						type: "streamable-http",
						url: "https://mcp.example.test/rpc",
						timeoutMs: 30_000,
					},
				},
				createRequestContext(peer, productRpcMethods.mcpUpsert),
			);
			const parsedCreated = mcpServerMutationResultSchema.parse(created);
			database.agentServerMcps.updateMcpRuntimeState(parsedCreated.stableResourceId, "ready", [
				{
					stableToolId: "tool-global",
					name: "global",
					schemaHash: "a".repeat(64),
					inputSchema: { type: "object", properties: {} },
				},
			]);
			const listed = await list(
				{ owner: { kind: "agent-server" } },
				createRequestContext(peer, productRpcMethods.mcpList),
			);
			expect(listed).toMatchObject({
				owner: { kind: "agent-server" },
				items: [{ displayName: "Global MCP", health: "ready", stale: false }],
			});

			expect(JSON.stringify(listed)).not.toContain("mcp.example.test");
			const currentProfile = await getProfile(
				{ agentId: "moshu.default" },
				createRequestContext(peer, productRpcMethods.agentGlobalProfileGet),
			);
			const parsedProfile = getAgentGlobalProfileOutputSchema.parse(currentProfile);
			const live = database.agentServerMcps.list().items[0];
			if (live === undefined) {
				throw new Error("Expected a live Agent Server MCP.");
			}
			await updateProfile(
				{
					agentId: "moshu.default",
					expectedRevision: parsedProfile.profile.revision,
					serverMcpRefs: [
						{
							owner: { kind: "agent-server" },
							stableResourceId: live.stableResourceId,
							version: live.version,
							contentHash: live.contentHash,
						},
					],
					serverSkillRefs: [],
				},
				createRequestContext(peer, productRpcMethods.agentGlobalProfileUpdate),
			);
			await expect(
				remove(
					{
						owner: { kind: "agent-server" },
						commandId: crypto.randomUUID(),
						stableResourceId: live.stableResourceId,
						expectedConfigRevision: live.configRevision,
						deleteCredentials: true,
					},
					createRequestContext(peer, productRpcMethods.mcpDelete),
				),
			).rejects.toMatchObject({ code: "MCP_RESOURCE_IN_USE" });
		} finally {
			database.close();
		}
	});

	test("manages prompt-only Agent Server Skills and protects global refs", async () => {
		const directory = mkdtempSync(join(tmpdir(), "moshu-product-skill-"));
		const database = openAppDatabase(join(directory, "app.db"), {
			agentServerSkillContent: new FileSkillContentStore(join(directory, "skills")),
		});
		try {
			const handlers = createProductRpcHandlers({
				authController,
				chatService: {} as ChatApplicationService,
				runtimeBoxRegistry: new RuntimeBoxRegistry(),
				runtimeBoxes: database.runtimeBoxes,
				agentServerMcps: database.agentServerMcps,
				agentServerSkills: database.agentServerSkills,
				agentGlobalProfiles: database.agentGlobalProfiles,
				runtimeIngressAuth,
				getDevTunnelService: () => devTunnelService,
				eventRouter: new ProductEventRouter(),
				serverVersion: "test",
			}).requests;
			const upsert = handlers?.[productRpcMethods.skillUpsert];
			const list = handlers?.[productRpcMethods.skillList];
			const getProfile = handlers?.[productRpcMethods.agentGlobalProfileGet];
			const updateProfile = handlers?.[productRpcMethods.agentGlobalProfileUpdate];
			const remove = handlers?.[productRpcMethods.skillDelete];
			if (
				upsert === undefined ||
				list === undefined ||
				getProfile === undefined ||
				updateProfile === undefined ||
				remove === undefined
			) {
				throw new Error("Agent Server Skill handlers are missing.");
			}
			const peer = createPeer({ emitEvent: () => "event", close() {} });
			const owner = { kind: "agent-server" as const };
			const created = skillMutationResultSchema.parse(
				await upsert(
					{
						owner,
						commandId: crypto.randomUUID(),
						source: { kind: "inline-editor" },
						enabled: true,
						files: [
							{
								path: "SKILL.md",
								encoding: "utf8",
								content:
									"---\nname: release-helper\ndescription: Prepare releases\n---\n\nFollow the checklist.",
								executable: false,
							},
						],
					},
					createRequestContext(peer, productRpcMethods.skillUpsert),
				),
			);
			expect(
				await list({ owner }, createRequestContext(peer, productRpcMethods.skillList)),
			).toMatchObject({
				owner,
				items: [{ packageKind: "prompt-only", metadata: { name: "release-helper" } }],
			});
			const profile = getAgentGlobalProfileOutputSchema.parse(
				await getProfile(
					{ agentId: "moshu.default" },
					createRequestContext(peer, productRpcMethods.agentGlobalProfileGet),
				),
			).profile;
			await updateProfile(
				{
					agentId: profile.agentId,
					expectedRevision: profile.revision,
					serverMcpRefs: profile.serverMcpRefs,
					serverSkillRefs: [
						{
							owner,
							stableResourceId: created.stableResourceId,
							version: created.version,
							contentHash: created.contentHash,
						},
					],
				},
				createRequestContext(peer, productRpcMethods.agentGlobalProfileUpdate),
			);
			await expect(
				remove(
					{
						owner,
						commandId: crypto.randomUUID(),
						stableResourceId: created.stableResourceId,
						expectedConfigRevision: created.configRevision,
						expectedVersion: created.version,
					},
					createRequestContext(peer, productRpcMethods.skillDelete),
				),
			).rejects.toMatchObject({ code: "SKILL_RESOURCE_IN_USE" });
			await expect(
				upsert(
					{
						owner,
						commandId: crypto.randomUUID(),
						source: { kind: "local-upload" },
						enabled: true,
						files: [
							{
								path: "SKILL.md",
								encoding: "utf8",
								content: "---\nname: bundle\ndescription: Invalid server bundle\n---\n",
								executable: false,
							},
							{
								path: "scripts/run.sh",
								encoding: "utf8",
								content: "exit 0",
								executable: true,
							},
						],
					},
					createRequestContext(peer, productRpcMethods.skillUpsert),
				),
			).rejects.toMatchObject({ code: "SKILL_OWNER_CAPABILITY_MISMATCH" });
		} finally {
			database.close();
			rmSync(directory, { recursive: true, force: true });
		}
	});

	test("creates Projects only after the owning Runtime Box validates their path", async () => {
		const database = openAppDatabase(":memory:");
		try {
			let projectPathAvailable = true;
			const registry = new RuntimeBoxRegistry({
				descriptors: database.runtimeBoxes.list(),
				activeRuntimeBoxId: database.runtimeBoxes.getActive().runtimeBoxId,
			});
			const runtimePeer: RuntimeBoxGatewayPeer = {
				isClosed: false,
				remoteIdentity: {
					role: "runtime-box",
					peerId: defaultLocalRuntimeBoxId,
					instanceId: crypto.randomUUID(),
					generation: 1,
				},
				close() {},
				request(method, payload) {
					expect(method).toBe(productRpcMethods.runtimeBoxProjectValidatePath);
					expect(payload).toEqual({ path: "/workspace/moshu" });
					if (!projectPathAvailable) {
						return Promise.resolve(
							rpcJsonValueSchema.parse({
								status: "unavailable",
								issueCode: "not_found",
							}),
						);
					}
					return Promise.resolve(
						rpcJsonValueSchema.parse({
							status: "available",
							normalizedPath: "/workspace/moshu",
							displayName: "moshu",
							gitRootPath: "/workspace/moshu",
							gitBranch: "main",
							rootAgents: { status: "missing" },
							confirmationToken: "a".repeat(64),
						}),
					);
				},
			};
			registry.register(runtimePeer, database.runtimeBoxes.get(defaultLocalRuntimeBoxId));
			registry.markReady(runtimePeer);
			const projectService = new ProjectApplicationService({
				projects: database.projects,
				runs: database.runs,
				actions: database.actions,
				runtimeBoxes: database.runtimeBoxes,
				pathInspector: registry,
			});
			const chatService = {
				async createSessionIdempotently(
					input: CreateProcessChatSessionInput,
					origin: ProcessPeerIdentity,
					signal?: AbortSignal,
				) {
					const existing = database.sessions.findIdempotent({ request: input, origin });
					if (existing !== undefined) {
						return existing;
					}
					if (input.projectId !== undefined) {
						return projectService.withSessionCreation(
							input.projectId,
							() => database.sessions.createIdempotently({ request: input, origin }),
							signal,
						);
					}
					return database.sessions.createIdempotently({ request: input, origin });
				},
				listSessions(input: ListChatSessionsInput) {
					return database.sessions.list(input);
				},
			} as unknown as ChatApplicationService;
			const handlers = createProductRpcHandlers({
				authController,
				chatService,
				runtimeBoxRegistry: registry,
				runtimeBoxes: database.runtimeBoxes,
				projectService,
				runtimeIngressAuth,
				getDevTunnelService: () => devTunnelService,
				eventRouter: new ProductEventRouter(),
				serverVersion: "test",
			}).requests;
			const peer = createPeer({ emitEvent: () => "event", close() {} });
			const create = handlers?.[productRpcMethods.projectsCreate];
			const preview = handlers?.[productRpcMethods.projectsPreviewPath];
			const list = handlers?.[productRpcMethods.projectsList];
			const archive = handlers?.[productRpcMethods.projectsArchive];
			const createSession = handlers?.[productRpcMethods.sessionCreate];
			const listSessions = handlers?.[productRpcMethods.sessionList];
			if (
				create === undefined ||
				preview === undefined ||
				list === undefined ||
				archive === undefined ||
				createSession === undefined ||
				listSessions === undefined
			) {
				throw new Error("Project handlers are missing.");
			}
			const previewed = await preview(
				{ path: "/workspace/moshu" },
				createRequestContext(peer, productRpcMethods.projectsPreviewPath),
			);
			const confirmationToken = z
				.object({ preview: z.object({ confirmationToken: z.string() }) })
				.parse(previewed).preview.confirmationToken;
			expect(confirmationToken).not.toBe("a".repeat(64));
			await expect(
				create(
					{ path: "/workspace/moshu", confirmationToken: "b".repeat(64) },
					createRequestContext(peer, productRpcMethods.projectsCreate),
				),
			).rejects.toMatchObject({ code: "PROJECT_PREVIEW_STALE" });
			const created = await create(
				{ path: "/workspace/moshu", confirmationToken },
				createRequestContext(peer, productRpcMethods.projectsCreate),
			);
			expect(created).toMatchObject({
				project: {
					runtimeBoxId: defaultLocalRuntimeBoxId,
					name: "moshu",
					path: "/workspace/moshu",
					gitBranch: "main",
				},
			});
			const projectId = z.object({ project: z.object({ id: z.string() }) }).parse(created)
				.project.id;
			const sessionRequest = {
				schemaVersion: 1,
				createKey: crypto.randomUUID(),
				title: "Project chat",
				defaultMode: "agent",
				projectId,
				runtimeBoxId: "untrusted-runtime-box",
			} as const;
			const projectSession = await createSession(
				sessionRequest,
				createRequestContext(peer, productRpcMethods.sessionCreate),
			);
			expect(projectSession).toMatchObject({
				session: { projectId, runtimeBoxId: defaultLocalRuntimeBoxId },
			});
			await expect(
				listSessions({}, createRequestContext(peer, productRpcMethods.sessionList)),
			).resolves.toEqual({ items: [] });
			await expect(
				listSessions(
					{ scope: { kind: "project", projectId } },
					createRequestContext(peer, productRpcMethods.sessionList),
				),
			).resolves.toMatchObject({ items: [{ projectId }] });
			await expect(
				list({}, createRequestContext(peer, productRpcMethods.projectsList)),
			).resolves.toMatchObject({ items: [{ id: projectId }] });
			registry.clear(runtimePeer);
			await expect(
				preview(
					{ path: "/workspace/other" },
					createRequestContext(peer, productRpcMethods.projectsPreviewPath),
				),
			).rejects.toMatchObject({ code: "PROJECT_RUNTIME_UNAVAILABLE" });
			await archive(
				{ projectId, archived: true },
				createRequestContext(peer, productRpcMethods.projectsArchive),
			);
			await expect(
				createSession(sessionRequest, createRequestContext(peer, productRpcMethods.sessionCreate)),
			).resolves.toEqual(projectSession);
			await expect(
				createSession(
					{ ...sessionRequest, createKey: crypto.randomUUID() },
					createRequestContext(peer, productRpcMethods.sessionCreate),
				),
			).rejects.toMatchObject({ code: "PROJECT_ARCHIVED" });
			await archive(
				{ projectId, archived: false },
				createRequestContext(peer, productRpcMethods.projectsArchive),
			);
			await expect(
				createSession(
					{ ...sessionRequest, createKey: crypto.randomUUID() },
					createRequestContext(peer, productRpcMethods.sessionCreate),
				),
			).rejects.toMatchObject({ code: "PROJECT_RUNTIME_UNAVAILABLE" });
			await archive(
				{ projectId, archived: true },
				createRequestContext(peer, productRpcMethods.projectsArchive),
			);
			registry.register(runtimePeer, database.runtimeBoxes.get(defaultLocalRuntimeBoxId));
			registry.markReady(runtimePeer);
			await archive(
				{ projectId, archived: false },
				createRequestContext(peer, productRpcMethods.projectsArchive),
			);
			projectPathAvailable = false;
			await expect(
				createSession(
					{ ...sessionRequest, createKey: crypto.randomUUID() },
					createRequestContext(peer, productRpcMethods.sessionCreate),
				),
			).rejects.toMatchObject({
				code: "PROJECT_PATH_UNAVAILABLE",
				data: { issueCode: "not_found" },
			});
			projectPathAvailable = true;
			await archive(
				{ projectId, archived: true },
				createRequestContext(peer, productRpcMethods.projectsArchive),
			);
			await expect(
				create(
					{ path: "/workspace/moshu", confirmationToken },
					createRequestContext(peer, productRpcMethods.projectsCreate),
				),
			).rejects.toMatchObject({
				code: "PROJECT_PATH_CONFLICT",
				data: { conflictingProjectId: projectId, conflictingProjectArchived: true },
			});
			await expect(
				list({}, createRequestContext(peer, productRpcMethods.projectsList)),
			).resolves.toEqual({ items: [] });
		} finally {
			database.close();
		}
	});

	test("serves redacted inventory and persists only live-validated Runtime Profile refs", async () => {
		const database = openAppDatabase(":memory:");
		const version = crypto.randomUUID();
		const contentHash = "a".repeat(64);
		const runtimePeer: RuntimeBoxGatewayPeer = {
			isClosed: false,
			remoteIdentity: {
				role: "runtime-box",
				peerId: defaultLocalRuntimeBoxId,
				instanceId: crypto.randomUUID(),
				generation: 1,
			},
			close() {},
			request(method, _payload) {
				expect(method).toBe(productRpcMethods.runtimeBoxResourcesValidate);
				return Promise.resolve(
					rpcJsonValueSchema.parse({
						valid: true,
						resources: [
							{
								resourceKind: "skill",
								stableResourceId: "release-helper",
								configRevision: 1,
								version,
								contentHash,
								health: "ready",
							},
						],
						issues: [],
					}),
				);
			},
		};
		const registry = new RuntimeBoxRegistry({
			descriptors: database.runtimeBoxes.list(),
			activeRuntimeBoxId: defaultLocalRuntimeBoxId,
		});
		try {
			registry.register(runtimePeer, database.runtimeBoxes.get(defaultLocalRuntimeBoxId));
			registry.markReady(runtimePeer);
			database.runtimeBoxInventory.replaceSnapshot({
				runtimeBoxId: defaultLocalRuntimeBoxId,
				runtimeBoxGeneration: 1,
				inventoryEpoch: crypto.randomUUID(),
				inventoryRevision: 1,
				generatedAt: new Date().toISOString(),
				capabilities: ["skills.store.v1"],
				resources: [
					{
						resourceKind: "skill",
						stableResourceId: "release-helper",
						configRevision: 1,
						version,
						contentHash,
						health: "ready",
					},
				],
			});
			const handlers = createProductRpcHandlers({
				authController,
				chatService: {} as ChatApplicationService,
				runtimeBoxRegistry: registry,
				runtimeBoxes: database.runtimeBoxes,
				runtimeBoxInventory: database.runtimeBoxInventory,
				runtimeProfiles: database.runtimeProfiles,
				runtimeIngressAuth,
				getDevTunnelService: () => devTunnelService,
				eventRouter: new ProductEventRouter(),
				serverVersion: "test",
			}).requests;
			const client = createPeer({ emitEvent: () => "event", close() {} });
			const listInventory = handlers?.[productRpcMethods.runtimeInventoryList];
			const getProfile = handlers?.[productRpcMethods.runtimeProfilesGet];
			const updateProfile = handlers?.[productRpcMethods.runtimeProfilesUpdate];
			const deleteSkill = handlers?.[productRpcMethods.skillsDelete];
			if (
				listInventory === undefined ||
				getProfile === undefined ||
				updateProfile === undefined ||
				deleteSkill === undefined
			) {
				throw new Error("Runtime resource handlers are missing.");
			}
			await expect(
				listInventory({}, createRequestContext(client, productRpcMethods.runtimeInventoryList)),
			).resolves.toMatchObject({
				stale: false,
				resources: [{ stableResourceId: "release-helper" }],
			});
			const initial = await getProfile(
				{},
				createRequestContext(client, productRpcMethods.runtimeProfilesGet),
			);
			const initialRevision = z
				.object({ profile: z.object({ revision: z.number() }) })
				.parse(initial).profile.revision;
			await expect(
				updateProfile(
					{
						expectedRevision: initialRevision,
						resources: [
							{
								runtimeBoxId: defaultLocalRuntimeBoxId,
								resourceKind: "skill",
								stableResourceId: "release-helper",
								version,
								contentHash,
							},
						],
					},
					createRequestContext(client, productRpcMethods.runtimeProfilesUpdate),
				),
			).resolves.toMatchObject({
				profile: { resources: [{ stableResourceId: "release-helper" }] },
			});
			await expect(
				deleteSkill(
					{
						commandId: crypto.randomUUID(),
						stableResourceId: "release-helper",
						expectedConfigRevision: 1,
						expectedVersion: version,
					},
					createRequestContext(client, productRpcMethods.skillsDelete),
				),
			).rejects.toMatchObject({ code: "RUNTIME_RESOURCE_IN_USE" });
		} finally {
			await registry.shutdown();
			database.close();
		}
	});
});

describe("product RPC event broadcast", () => {
	test("isolates a failed client peer and continues broadcasting", () => {
		let failedCloseCalls = 0;
		let healthyDeliveries = 0;
		const failedPeer = createPeer({
			emitEvent() {
				throw new Error("dropped frame");
			},
			close() {
				failedCloseCalls += 1;
			},
		});

		const healthyPeer = createPeer({
			emitEvent() {
				healthyDeliveries += 1;
				return "event-id";
			},
			close() {},
		});

		publishChatEvent(
			[failedPeer, healthyPeer],
			createEvent(),
			"550e8400-e29b-41d4-a716-446655440000",
		);
		expect(failedCloseCalls).toBe(1);
		expect(healthyDeliveries).toBe(1);
	});

	test("broadcasts bounded retired Session IDs and diagnoses isolated publication failures", () => {
		const sessionIds = ["018f0f2c-7b18-7abc-8def-1234567890ab"];
		const diagnostics: string[] = [];
		const deliveries: unknown[] = [];
		let failedCloseCalls = 0;
		const failedPeer = createPeer({
			emitEvent() {
				throw new Error("dropped frame");
			},
			close() {
				failedCloseCalls += 1;
			},
		});
		const healthyPeer = createPeer({
			emitEvent(method, payload) {
				expect(method).toBe("moshu.v1.chat.sessions.retired");
				deliveries.push(chatSessionsRetiredEventSchema.parse(payload));
				return "retirement-event";
			},
			close() {},
		});

		publishRetiredChatSessions([failedPeer, healthyPeer], sessionIds, (message) =>
			diagnostics.push(message),
		);

		expect(failedCloseCalls).toBe(1);
		expect(deliveries).toEqual([{ schemaVersion: 1, sessionIds }]);
		expect(diagnostics).toHaveLength(1);
		expect(diagnostics[0]).toContain("replay will recover");
	});

	test("routes live events only to the originating client peer", () => {
		let originDeliveries = 0;
		let otherDeliveries = 0;
		const origin = createPeer(
			{
				emitEvent() {
					originDeliveries += 1;
					return "origin-event";
				},
				close() {},
			},
			"origin-client",
		);
		const other = createPeer(
			{
				emitEvent() {
					otherDeliveries += 1;
					return "other-event";
				},
				close() {},
			},
			"other-client",
		);
		const router = new ProductEventRouter();
		const requestId = "550e8400-e29b-41d4-a716-446655440000";
		router.bind(requestId, origin);
		router.publish([origin, other], createEvent(), requestId);

		expect(originDeliveries).toBe(1);
		expect(otherDeliveries).toBe(0);
	});

	test("keeps gen1 on a failed same-key gen2 retry and transfers only after commit", () => {
		let gen1Deliveries = 0;
		let gen2Deliveries = 0;
		const gen1 = createPeer(
			{
				emitEvent() {
					gen1Deliveries += 1;
					return "gen1-event";
				},
				close() {},
			},
			"origin-client",
			{ instanceId: "origin-gen1", generation: 1 },
		);
		const gen2 = createPeer(
			{
				emitEvent() {
					gen2Deliveries += 1;
					return "gen2-event";
				},
				close() {},
			},
			"origin-client",
			{ instanceId: "origin-gen2", generation: 2 },
		);
		const router = new ProductEventRouter();
		const requestId = crypto.randomUUID();
		router.bind(requestId, gen1);
		const failedRetryLease = router.bind(requestId, gen2);

		expect(failedRetryLease.created).toBe(false);
		router.publish([gen1, gen2], createEvent(), requestId);
		router.rollback(failedRetryLease);
		router.publish([gen1, gen2], createEvent(), requestId);
		expect(gen1Deliveries).toBe(2);
		expect(gen2Deliveries).toBe(0);

		const successfulRetryLease = router.bind(requestId, gen2);
		expect(router.commit(successfulRetryLease)).toBe(true);
		router.releasePeer(gen1);
		router.publish([gen1, gen2], createEvent(), requestId);
		expect(gen1Deliveries).toBe(2);
		expect(gen2Deliveries).toBe(1);
	});

	test("rolls back only a newly-created route after a definite handler failure", () => {
		let deliveries = 0;
		const origin = createPeer(
			{
				emitEvent() {
					deliveries += 1;
					return "event";
				},
				close() {},
			},
			"origin-client",
		);
		const replacement = createPeer(
			{ emitEvent: origin.emitEvent, close() {} },
			"replacement-client",
		);
		const router = new ProductEventRouter();
		const requestId = crypto.randomUUID();
		const lease = router.bind(requestId, origin);

		expect(lease.created).toBe(true);
		router.rollback(lease);
		expect(() => router.bind(requestId, replacement)).not.toThrow();
		router.publish([origin, replacement], createEvent(), requestId);
		expect(deliveries).toBe(1);
	});

	test("does not let a different-peer conflict disturb the original route", () => {
		let originDeliveries = 0;
		const origin = createPeer(
			{
				emitEvent() {
					originDeliveries += 1;
					return "origin";
				},
				close() {},
			},
			"origin-client",
		);
		const other = createPeer({ emitEvent: () => "other", close() {} }, "other-client");
		const router = new ProductEventRouter();
		const requestId = crypto.randomUUID();
		router.bind(requestId, origin);

		expect(() => router.bind(requestId, other)).toThrow("another client peer");
		router.publish([origin, other], createEvent(), requestId);
		expect(originDeliveries).toBe(1);
	});

	test("releases routes on terminal publication and exact peer disconnect", () => {
		let originDeliveries = 0;
		let otherDeliveries = 0;
		const origin = createPeer(
			{
				emitEvent() {
					originDeliveries += 1;
					return "origin";
				},
				close() {},
			},
			"origin-client",
		);
		const other = createPeer(
			{
				emitEvent() {
					otherDeliveries += 1;
					return "other";
				},
				close() {},
			},
			"other-client",
		);
		const router = new ProductEventRouter();
		const terminalRequestId = crypto.randomUUID();
		const disconnectedRequestId = crypto.randomUUID();
		const healthyRequestId = crypto.randomUUID();
		router.bind(terminalRequestId, origin);
		router.bind(disconnectedRequestId, origin);
		router.bind(healthyRequestId, other);

		router.publish([origin, other], createTerminalEvent(), terminalRequestId);
		router.publish([origin, other], createEvent(), terminalRequestId);
		router.releasePeer(origin);
		router.publish([origin, other], createEvent(), disconnectedRequestId);
		router.publish([origin, other], createEvent(), healthyRequestId);

		expect(originDeliveries).toBe(1);
		expect(otherDeliveries).toBe(1);
	});

	test("does not let an old connection close remove a route rebound to a newer generation", () => {
		let oldDeliveries = 0;
		let newDeliveries = 0;
		const oldPeer = createPeer(
			{
				emitEvent() {
					oldDeliveries += 1;
					return "old";
				},
				close() {},
			},
			"stable-client",
		);
		const newPeer = createPeer(
			{
				emitEvent() {
					newDeliveries += 1;
					return "new";
				},
				close() {},
			},
			"stable-client",
		);
		const router = new ProductEventRouter();
		const requestId = crypto.randomUUID();
		router.bind(requestId, oldPeer);
		router.commit(router.bind(requestId, newPeer));

		router.releasePeer(oldPeer);
		router.publish([oldPeer, newPeer], createEvent(), requestId);
		expect(oldDeliveries).toBe(0);
		expect(newDeliveries).toBe(1);
	});

	test("does not let stale rollback, release, terminal cleanup, or capacity cleanup steal a route", () => {
		const gen1 = createPeer({ emitEvent: () => "gen1", close() {} }, "stable-client", {
			instanceId: "stable-gen1",
			generation: 1,
		});
		const gen2 = createPeer({ emitEvent: () => "gen2", close() {} }, "stable-client", {
			instanceId: "stable-gen2",
			generation: 2,
		});
		const router = new ProductEventRouter();
		const requestId = crypto.randomUUID();
		router.bind(requestId, gen1);
		const staleLease = router.bind(requestId, gen2);
		const committedLease = router.bind(requestId, gen2);
		expect(router.commit(committedLease)).toBe(true);

		router.rollback(staleLease);
		router.release(staleLease);
		router.releasePeer(gen1);
		expect(() => router.bind(requestId, gen1)).not.toThrow();
		router.rollback(router.bind(requestId, gen2));

		router.publish([gen1, gen2], createTerminalEvent(), requestId);
		const replacementRequestId = crypto.randomUUID();
		expect(() => router.bind(replacementRequestId, gen1)).not.toThrow();

		const capacityRouter = new ProductEventRouter();
		for (let index = 0; index < 1_024; index += 1) {
			capacityRouter.bind(`request-${index}`, gen1);
		}
		expect(() => capacityRouter.bind("request-over-cap", gen1)).toThrow(
			"Too many active Chat send request owners",
		);
		capacityRouter.releasePeer(gen1);
		expect(() => capacityRouter.bind("request-after-cleanup", gen2)).not.toThrow();
	});

	test("separates invalid request payloads from private handler validation failures", async () => {
		const peer = createPeer({ emitEvent: () => "event", close() {} });
		let malformedInputDispatched = false;
		const malformedInputHandler = createProductRpcHandlers({
			authController,
			chatService: {
				getSessionPage() {
					malformedInputDispatched = true;
					throw new Error("must not dispatch");
				},
			} as unknown as ChatApplicationService,
			runtimeBoxRegistry: {} as RuntimeBoxRegistry,
			runtimeBoxes,
			runtimeIngressAuth,
			getDevTunnelService: () => devTunnelService,
			eventRouter: new ProductEventRouter(),
			serverVersion: "test",
		}).requests?.[productRpcMethods.sessionGet];
		const malformedOutputHandler = createProductRpcHandlers({
			authController,
			chatService: {
				getSessionPage() {
					return { privateOutput: "private-output-secret" };
				},
			} as unknown as ChatApplicationService,
			runtimeBoxRegistry: {} as RuntimeBoxRegistry,
			runtimeBoxes,
			runtimeIngressAuth,
			getDevTunnelService: () => devTunnelService,
			eventRouter: new ProductEventRouter(),
			serverVersion: "test",
		}).requests?.[productRpcMethods.sessionGet];
		const internalZodHandler = createProductRpcHandlers({
			authController,
			chatService: {
				getSessionPage() {
					return z.string().parse({ privateValue: "private-zod-secret" });
				},
			} as unknown as ChatApplicationService,
			runtimeBoxRegistry: {} as RuntimeBoxRegistry,
			runtimeBoxes,
			runtimeIngressAuth,
			getDevTunnelService: () => devTunnelService,
			eventRouter: new ProductEventRouter(),
			serverVersion: "test",
		}).requests?.[productRpcMethods.sessionGet];
		if (
			malformedInputHandler === undefined ||
			malformedOutputHandler === undefined ||
			internalZodHandler === undefined
		) {
			throw new Error("Missing Session get Product RPC handler.");
		}

		const malformedInput = await Promise.resolve()
			.then(() =>
				malformedInputHandler(
					{
						sessionId: "private-invalid-session",
						privateInput: "private-input-secret",
					},
					createRequestContext(peer, productRpcMethods.sessionGet),
				),
			)
			.catch((reason: unknown) => reason);
		expect(malformedInputDispatched).toBe(false);
		expect(malformedInput).toBeInstanceOf(RpcHandlerError);
		expect((malformedInput as RpcHandlerError).code).toBe("INVALID_ARGUMENT");
		expect((malformedInput as Error).message).not.toContain("private");

		const validInput = {
			sessionId: "01984df0-cf17-7e6e-9a7d-4d98c1f0d5ce",
			limit: 2,
		};
		for (const [handler, privateDetail] of [
			[malformedOutputHandler, "private-output-secret"],
			[internalZodHandler, "private-zod-secret"],
		] as const) {
			const error = await Promise.resolve()
				.then(() => handler(validInput, createRequestContext(peer, productRpcMethods.sessionGet)))
				.catch((reason: unknown) => reason);
			expect(error).toBeInstanceOf(RpcHandlerError);
			expect((error as RpcHandlerError).code).toBe(productRpcInternalHandlerErrorCode);
			expect((error as Error).message).not.toContain(privateDetail);
			expect((error as Error).message.length).toBeLessThan(128);
			expect((error as RpcHandlerError).data).toBeUndefined();
		}
	});

	test("classifies invalid idempotent outputs only after the operation may have committed", async () => {
		const peer = createPeer({ emitEvent: () => "event", close() {} });
		const completedOperations: string[] = [];
		const handlers = createProductRpcHandlers({
			authController,
			chatService: {
				createSessionIdempotently() {
					completedOperations.push("session-create");
					return { session: { schemaVersion: 1 } };
				},
				sendMessageWithPreflight() {
					completedOperations.push("chat-send");
					return { run: { status: "queued" } };
				},
			} as unknown as ChatApplicationService,
			runtimeBoxRegistry: {} as RuntimeBoxRegistry,
			runtimeBoxes,
			runtimeIngressAuth,
			getDevTunnelService: () => devTunnelService,
			eventRouter: new ProductEventRouter(),
			serverVersion: "test",
		}).requests;
		const cases = [
			{
				method: productRpcMethods.sessionCreate,
				input: {
					schemaVersion: 1,
					createKey: crypto.randomUUID(),
					title: "New chat",
					defaultMode: "ask",
				},
			},
			{
				method: productRpcMethods.chatSend,
				input: {
					requestId: crypto.randomUUID(),
					sessionId: "01984df0-cf17-7e6e-9a7d-4d98c1f0d5ce",
					content: "commit before output validation",
				},
			},
		] as const;

		for (const testCase of cases) {
			const handler = handlers?.[testCase.method];
			if (handler === undefined) {
				throw new Error(`Missing ${testCase.method} Product RPC handler.`);
			}
			const error = await Promise.resolve()
				.then(() => handler(testCase.input, createRequestContext(peer, testCase.method)))
				.catch((reason: unknown) => reason);
			expect(error).toBeInstanceOf(RpcHandlerError);
			expect((error as RpcHandlerError).code).toBe(productRpcInternalHandlerErrorCode);
		}
		expect(completedOperations).toEqual(["session-create", "chat-send"]);
	});

	test("maps a conclusive missing Session to a stable product RPC error", async () => {
		const peer = createPeer({ emitEvent: () => "event", close() {} });
		const handler = createProductRpcHandlers({
			authController,
			chatService: {
				getSessionPage() {
					throw new ChatSessionNotFoundError("01984df0-cf17-7e6e-9a7d-4d98c1f0d5ce");
				},
			} as unknown as ChatApplicationService,
			runtimeBoxRegistry: {} as RuntimeBoxRegistry,
			runtimeBoxes,
			runtimeIngressAuth,
			getDevTunnelService: () => devTunnelService,
			eventRouter: new ProductEventRouter(),
			serverVersion: "test",
		}).requests?.[productRpcMethods.sessionGet];
		if (handler === undefined) {
			throw new Error("Missing Session get product RPC handler.");
		}

		const error = await Promise.resolve()
			.then(() =>
				handler(
					{
						sessionId: "01984df0-cf17-7e6e-9a7d-4d98c1f0d5ce",
						limit: 2,
					},
					{
						peer,
						remoteIdentity: peer.remoteIdentity,
						requestId: crypto.randomUUID(),
						traceId: crypto.randomUUID(),
						method: productRpcMethods.sessionGet,
						deadlineAt: Date.now() + 1_000,
						signal: new AbortController().signal,
					},
				),
			)
			.catch((reason: unknown) => reason);

		expect(error).toBeInstanceOf(RpcHandlerError);
		expect((error as RpcHandlerError).code).toBe("SESSION_NOT_FOUND");
	});

	test("maps an unknown valid Session deletion to SESSION_NOT_FOUND", async () => {
		const database = openAppDatabase(":memory:");
		const peer = createPeer({ emitEvent: () => "event", close() {} });
		const handler = createProductRpcHandlers({
			authController,
			chatService: {
				deleteSession(input) {
					return Promise.resolve(database.runs.deleteSessionAndRetireRuns(input.sessionId));
				},
			} as ChatApplicationService,
			runtimeBoxRegistry: {} as RuntimeBoxRegistry,
			runtimeBoxes,
			runtimeIngressAuth,
			getDevTunnelService: () => devTunnelService,
			eventRouter: new ProductEventRouter(),
			serverVersion: "test",
		}).requests?.[productRpcMethods.sessionDelete];
		if (handler == null) {
			throw new Error("Missing Session delete product RPC handler.");
		}

		try {
			const error = await Promise.resolve()
				.then(() =>
					handler(
						{ sessionId: "01984df0-cf17-7e6e-9a7d-4d98c1f0d5ce" },
						{
							peer,
							remoteIdentity: peer.remoteIdentity,
							requestId: crypto.randomUUID(),
							traceId: crypto.randomUUID(),
							method: productRpcMethods.sessionDelete,
							deadlineAt: Date.now() + 1_000,
							signal: new AbortController().signal,
						},
					),
				)
				.catch((reason: unknown) => reason);

			expect(error).toBeInstanceOf(RpcHandlerError);
			expect((error as RpcHandlerError).code).toBe("SESSION_NOT_FOUND");
		} finally {
			database.close();
		}
	});

	test("returns the same delete output through product RPC for a durable retirement retry", async () => {
		const database = openAppDatabase(":memory:");
		const session = database.sessions.create({ title: "Delete through RPC" }).session;
		const peer = createPeer({ emitEvent: () => "event", close() {} });
		const handler = createProductRpcHandlers({
			authController,
			chatService: {
				deleteSession(input) {
					return Promise.resolve(database.runs.deleteSessionAndRetireRuns(input.sessionId));
				},
			} as ChatApplicationService,
			runtimeBoxRegistry: {} as RuntimeBoxRegistry,
			runtimeBoxes,
			runtimeIngressAuth,
			getDevTunnelService: () => devTunnelService,
			eventRouter: new ProductEventRouter(),
			serverVersion: "test",
		}).requests?.[productRpcMethods.sessionDelete];
		if (handler === undefined) {
			throw new Error("Missing Session delete product RPC handler.");
		}

		try {
			const input = { sessionId: session.id };
			const first = await handler(
				input,
				createRequestContext(peer, productRpcMethods.sessionDelete),
			);
			const retried = await handler(
				input,
				createRequestContext(peer, productRpcMethods.sessionDelete),
			);
			expect(retried).toEqual(first);
			expect(retried).toEqual({ sessionId: session.id });
			expect(database.runs.listPendingAgentSessionCleanups(10, true)).toHaveLength(1);
		} finally {
			database.close();
		}
	});

	test("survives a lost create response, concurrent retry, and different full peer origin", async () => {
		const database = openAppDatabase(":memory:");
		const origin = createPeer({ emitEvent: () => "event", close() {} }, "stable-create-client", {
			instanceId: "stable-create-instance",
			generation: 3,
		});
		const otherGeneration = createPeer(
			{ emitEvent: () => "event", close() {} },
			"stable-create-client",
			{ instanceId: "other-create-instance", generation: 4 },
		);
		const handler = createProductRpcHandlers({
			authController,
			chatService: {
				async createSessionIdempotently(input, peerIdentity) {
					return database.sessions.createIdempotently({
						request: input,
						origin: peerIdentity,
					});
				},
			} as ChatApplicationService,
			runtimeBoxRegistry: {} as RuntimeBoxRegistry,
			runtimeBoxes,
			runtimeIngressAuth,
			getDevTunnelService: () => devTunnelService,
			eventRouter: new ProductEventRouter(),
			serverVersion: "test",
		}).requests?.[productRpcMethods.sessionCreate];
		if (handler === undefined) {
			throw new Error("Missing Session create product RPC handler.");
		}
		const input = {
			schemaVersion: 1,
			createKey: crypto.randomUUID(),
			title: "New chat",
			defaultMode: "ask",
		} as const;
		try {
			const committedButLost = await handler(
				input,
				createRequestContext(origin, productRpcMethods.sessionCreate),
			);
			const retriedAfterLoss = await handler(
				input,
				createRequestContext(origin, productRpcMethods.sessionCreate),
			);
			const [firstConcurrent, secondConcurrent] = await Promise.all([
				handler(input, createRequestContext(origin, productRpcMethods.sessionCreate)),
				handler(input, createRequestContext(origin, productRpcMethods.sessionCreate)),
			]);
			const original = createChatSessionOutputSchema.parse(committedButLost);
			expect(createChatSessionOutputSchema.parse(retriedAfterLoss)).toEqual(original);
			expect(createChatSessionOutputSchema.parse(firstConcurrent)).toEqual(original);
			expect(createChatSessionOutputSchema.parse(secondConcurrent)).toEqual(original);
			expect(database.sessions.list().items).toHaveLength(1);

			const conflict = await Promise.resolve()
				.then(() =>
					handler(input, createRequestContext(otherGeneration, productRpcMethods.sessionCreate)),
				)
				.catch((reason: unknown) => reason);
			expect(conflict).toBeInstanceOf(RpcHandlerError);
			expect((conflict as RpcHandlerError).code).toBe("SESSION_CREATE_KEY_CONFLICT");
			expect(database.sessions.list().items).toHaveLength(1);
		} finally {
			database.close();
		}
	});
});

function createPeer(
	methods: {
		emitEvent: RpcPeer["emitEvent"];
		close: RpcPeer["close"];
	},
	peerId: string = crypto.randomUUID(),
	identity: { readonly instanceId?: string; readonly generation?: number } = {},
): RpcPeer {
	return {
		remoteIdentity: {
			role: "client",
			peerId,
			instanceId: identity.instanceId ?? crypto.randomUUID(),
			generation: identity.generation ?? 1,
		},
		emitEvent: methods.emitEvent,
		close: methods.close,
	} as RpcPeer;
}

function createRequestContext(peer: RpcPeer, method: string) {
	return {
		peer,
		remoteIdentity: peer.remoteIdentity,
		requestId: crypto.randomUUID(),
		traceId: crypto.randomUUID(),
		method,
		deadlineAt: Date.now() + 1_000,
		signal: new AbortController().signal,
	};
}

function createEvent(): ChatRunEvent {
	return {
		schemaVersion: 1,
		id: "01984df0-cf1b-7521-a4a5-40eef114ce9f",
		runId: "01984df0-cf18-7c89-9d11-3686130434c8",
		sessionId: "01984df0-cf17-7e6e-9a7d-4d98c1f0d5ce",
		seq: 1,
		type: "run.status",
		source: { kind: "user" },
		visibility: "user",
		createdAt: "2026-07-25T04:15:28.349Z",
		payload: { status: "queued" },
	};
}

function createTerminalEvent(): ChatRunEvent {
	const event = createEvent();
	if (event.type !== "run.status") {
		throw new Error("Expected a Run status fixture.");
	}
	return {
		...event,
		payload: { previousStatus: "running", status: "completed" },
	};
}

describe("product RPC provider and model handlers", () => {
	const providerId = "01984df0-cf17-7e6e-9a7d-4d98c1f0d5ce";
	const sessionId = "01984df0-cf17-7e6e-9a7d-4d98c1f0d5cf";
	const providerModel = {
		id: "gpt-5.4",
		displayName: "GPT-5.4",
		api: "openai-responses",
		input: ["text"],
		reasoning: true,
		contextWindowTokens: 128_000,
		maxOutputTokens: 8_192,
		thinkingLevels: ["off", "low", "medium", "high"],
		enabled: true,
	};
	const providerSummary = {
		schemaVersion: 2,
		id: providerId,
		displayName: "OpenAI",
		source: "custom",
		api: "openai-responses",
		baseUrl: "https://api.openai.com/v1",
		enabled: true,
		authMethods: ["api_key"],
		credential: { configured: true, type: "api_key" },
		customHeaderNames: [],
		models: [providerModel],
	};
	const chatSession = {
		schemaVersion: 1,
		id: sessionId,
		agentSessionId: sessionId,
		runtimeBoxId: defaultLocalRuntimeBoxId,
		title: "New chat",
		defaultMode: "ask",
		model: { providerId, modelId: "gpt-5.4" },
		createdAt: "2026-07-25T04:15:28.349Z",
		updatedAt: "2026-07-25T04:15:28.349Z",
	};

	test("dispatches every provider, model, and session-model request to the chat service", async () => {
		const peer = createPeer({ emitEvent: () => "event", close() {} });
		const recorded: Array<{ method: string; input: unknown }> = [];
		const record = (method: string, output: unknown) => (input?: unknown) => {
			recorded.push({ method, input });
			return output;
		};

		const listOutput = { schemaVersion: 2, providers: [providerSummary] };
		const mutationOutput = { schemaVersion: 2, provider: providerSummary };
		const deleteOutput = { schemaVersion: 2, providerId };
		const testOutput = { schemaVersion: 2, ok: true, latencyMs: 12 };
		const availableOutput = { schemaVersion: 2, models: [] };
		const defaultGetOutput = { schemaVersion: 2 };
		const defaultSetOutput = { schemaVersion: 2, defaultModel: { providerId, modelId: "gpt-5.4" } };
		const sessionOutput = { session: chatSession };

		const chatService = {
			listProviders: record("listProviders", listOutput),
			createProvider: record("createProvider", mutationOutput),
			updateProvider: record("updateProvider", mutationOutput),
			deleteProvider: record("deleteProvider", deleteOutput),
			testProvider: record("testProvider", testOutput),
			fetchProviderModels: record("fetchProviderModels", mutationOutput),
			setProviderModelsEnabled: record("setProviderModelsEnabled", mutationOutput),
			listAvailableModels: record("listAvailableModels", availableOutput),
			getDefaultModel: record("getDefaultModel", defaultGetOutput),
			setDefaultModel: record("setDefaultModel", defaultSetOutput),
			setSessionModel: record("setSessionModel", sessionOutput),
		} as unknown as ChatApplicationService;
		const handlers = createProductRpcHandlers({
			authController,
			chatService,
			runtimeBoxRegistry: {} as RuntimeBoxRegistry,
			runtimeBoxes,
			runtimeIngressAuth,
			getDevTunnelService: () => devTunnelService,
			eventRouter: new ProductEventRouter(),
			serverVersion: "test",
		}).requests;

		const cases = [
			{
				method: productRpcMethods.providersList,
				serviceMethod: "listProviders",
				input: {},
				output: listOutput,
			},
			{
				method: productRpcMethods.providersCreate,
				serviceMethod: "createProvider",
				input: {
					schemaVersion: 2,
					displayName: "OpenAI",
					api: "openai-responses",
					baseUrl: "https://api.openai.com/v1",
					apiKey: "sk-secret",
				},
				output: mutationOutput,
			},
			{
				method: productRpcMethods.providersUpdate,
				serviceMethod: "updateProvider",
				input: { schemaVersion: 2, providerId, displayName: "Renamed" },
				output: mutationOutput,
			},
			{
				method: productRpcMethods.providersDelete,
				serviceMethod: "deleteProvider",
				input: { schemaVersion: 2, providerId },
				output: deleteOutput,
			},
			{
				method: productRpcMethods.providersTest,
				serviceMethod: "testProvider",
				input: { schemaVersion: 2, providerId },
				output: testOutput,
			},
			{
				method: productRpcMethods.providersFetchModels,
				serviceMethod: "fetchProviderModels",
				input: { schemaVersion: 2, providerId },
				output: mutationOutput,
			},
			{
				method: productRpcMethods.providersSetModelsEnabled,
				serviceMethod: "setProviderModelsEnabled",
				input: { schemaVersion: 2, providerId, enabledModelIds: ["gpt-5.4"] },
				output: mutationOutput,
			},
			{
				method: productRpcMethods.modelsListAvailable,
				serviceMethod: "listAvailableModels",
				input: {},
				output: availableOutput,
			},
			{
				method: productRpcMethods.defaultModelGet,
				serviceMethod: "getDefaultModel",
				input: {},
				output: defaultGetOutput,
			},
			{
				method: productRpcMethods.defaultModelSet,
				serviceMethod: "setDefaultModel",
				input: { schemaVersion: 2, defaultModel: { providerId, modelId: "gpt-5.4" } },
				output: defaultSetOutput,
			},
			{
				method: productRpcMethods.sessionSetModel,
				serviceMethod: "setSessionModel",
				input: { sessionId, model: { providerId, modelId: "gpt-5.4" } },
				output: sessionOutput,
			},
		];

		for (const testCase of cases) {
			const handler = handlers?.[testCase.method];
			if (handler === undefined) {
				throw new Error(`Missing ${testCase.method} product RPC handler.`);
			}
			const result = await handler(testCase.input, createRequestContext(peer, testCase.method));
			expect(result).toEqual(testCase.output);
		}

		expect(recorded.map((entry) => entry.method)).toEqual(
			cases.map((entry) => entry.serviceMethod),
		);
	});

	test("maps provider registry failures to stable product RPC error codes", async () => {
		const peer = createPeer({ emitEvent: () => "event", close() {} });
		const cases = [
			{
				method: productRpcMethods.providersDelete,
				serviceMethod: "deleteProvider",
				input: { schemaVersion: 2, providerId },
				error: new ProviderNotFoundError(providerId),
				code: "PROVIDER_NOT_FOUND",
			},
			{
				method: productRpcMethods.sessionSetModel,
				serviceMethod: "setSessionModel",
				input: { sessionId, model: { providerId, modelId: "gpt-5.4" } },
				error: new ProviderModelNotFoundError(providerId, "gpt-5.4"),
				code: "PROVIDER_MODEL_NOT_FOUND",
			},
			{
				method: productRpcMethods.providersCreate,
				serviceMethod: "createProvider",
				input: {
					schemaVersion: 2,
					displayName: "OpenAI",
					api: "openai-responses",
					baseUrl: "https://api.openai.com/v1",
					apiKey: "sk-secret",
				},
				error: new ProviderCapacityError(64),
				code: "PROVIDER_CAPACITY",
			},
			{
				method: productRpcMethods.providersFetchModels,
				serviceMethod: "fetchProviderModels",
				input: { schemaVersion: 2, providerId },
				error: new ProviderCatalogError("The Provider rejected the model list request.", 502),
				code: "PROVIDER_MODEL_LIST_FAILED",
			},
		];

		for (const testCase of cases) {
			const chatService = {
				[testCase.serviceMethod]: () => {
					throw testCase.error;
				},
			} as unknown as ChatApplicationService;
			const handler = createProductRpcHandlers({
				authController,
				chatService,
				runtimeBoxRegistry: {} as RuntimeBoxRegistry,
				runtimeBoxes,
				runtimeIngressAuth,
				getDevTunnelService: () => devTunnelService,
				eventRouter: new ProductEventRouter(),
				serverVersion: "test",
			}).requests?.[testCase.method];
			if (handler === undefined) {
				throw new Error(`Missing ${testCase.method} product RPC handler.`);
			}
			const error = await Promise.resolve()
				.then(() => handler(testCase.input, createRequestContext(peer, testCase.method)))
				.catch((reason: unknown) => reason);
			expect(error).toBeInstanceOf(RpcHandlerError);
			expect((error as RpcHandlerError).code).toBe(testCase.code);
		}
	});

	test("dispatches auth attempts without projecting secret responses", async () => {
		const peer = createPeer({ emitEvent: () => "event", close() {} });
		const attemptId = crypto.randomUUID();
		const challengeId = crypto.randomUUID();
		const attempt = {
			schemaVersion: 2 as const,
			id: attemptId,
			providerId,
			authType: "api_key" as const,
			status: "created" as const,
			createdAt: "2026-07-25T04:15:28.349Z",
			updatedAt: "2026-07-25T04:15:28.349Z",
			notifications: [],
		};
		const calls: Array<{ method: string; input: unknown }> = [];
		const fakeAuthController = {
			start(input: unknown) {
				calls.push({ method: "start", input });
				return { attempt };
			},
			get(input: unknown) {
				calls.push({ method: "get", input });
				return { attempt };
			},
			respond(input: unknown) {
				calls.push({ method: "respond", input });
				return { attempt };
			},
			cancel(input: unknown) {
				calls.push({ method: "cancel", input });
				return { attempt };
			},
			logout(input: unknown) {
				calls.push({ method: "logout", input });
				return { schemaVersion: 2, providerId, configured: false };
			},
		} as unknown as HeadlessAuthController;
		const handlers = createProductRpcHandlers({
			authController: fakeAuthController,
			chatService: {} as ChatApplicationService,
			runtimeBoxRegistry: {} as RuntimeBoxRegistry,
			runtimeBoxes,
			runtimeIngressAuth,
			getDevTunnelService: () => devTunnelService,
			eventRouter: new ProductEventRouter(),
			serverVersion: "test",
		}).requests;
		const secret = "fake-input-only-secret";
		const cases = [
			{
				method: productRpcMethods.providerAuthStart,
				input: { schemaVersion: 2, providerId, authType: "api_key" },
			},
			{ method: productRpcMethods.providerAuthGet, input: { attemptId } },
			{
				method: productRpcMethods.providerAuthRespond,
				input: { attemptId, challengeId, value: secret },
			},
			{ method: productRpcMethods.providerAuthCancel, input: { attemptId } },
			{ method: productRpcMethods.providerLogout, input: { schemaVersion: 2, providerId } },
		];
		const outputs: unknown[] = [];
		for (const testCase of cases) {
			const handler = handlers?.[testCase.method];
			if (handler === undefined) {
				throw new Error(`Missing ${testCase.method} product RPC handler.`);
			}
			outputs.push(await handler(testCase.input, createRequestContext(peer, testCase.method)));
		}

		expect(calls.map((call) => call.method)).toEqual([
			"start",
			"get",
			"respond",
			"cancel",
			"logout",
		]);
		expect(JSON.stringify(outputs)).not.toContain(secret);
	});

	test("registers a handler for every client and Runtime Box product request method", () => {
		const handlers = createProductRpcHandlers({
			authController,
			chatService: {} as unknown as ChatApplicationService,
			runtimeBoxRegistry: {} as RuntimeBoxRegistry,
			runtimeBoxes,
			runtimeIngressAuth,
			getDevTunnelService: () => devTunnelService,
			eventRouter: new ProductEventRouter(),
			serverVersion: "test",
		}).requests;

		for (const method of clientProductRequestMethods) {
			expect(typeof handlers?.[method]).toBe("function");
		}
		for (const method of runtimeBoxProductRequestMethods) {
			expect(typeof handlers?.[method]).toBe("function");
		}
	});

	test("serves the durable retired Session recovery page without metadata", async () => {
		const peer = createPeer({ emitEvent: () => "event", close() {} });
		const retiredSessionId = "01984df0-cf17-7e6e-9a7d-4d98c1f0d5ce";
		const received: unknown[] = [];
		const handlers = createProductRpcHandlers({
			authController,
			chatService: {
				listRetiredSessions(input: unknown) {
					received.push(input);
					return { schemaVersion: 1, sessionIds: [retiredSessionId] };
				},
			} as unknown as ChatApplicationService,
			runtimeBoxRegistry: {} as RuntimeBoxRegistry,
			runtimeBoxes,
			runtimeIngressAuth,
			getDevTunnelService: () => devTunnelService,
			eventRouter: new ProductEventRouter(),
			serverVersion: "test",
		}).requests;
		const handler = handlers?.[productRpcMethods.chatRetiredSessionsList];
		if (handler === undefined) {
			throw new Error("Retired Session recovery handler is missing.");
		}

		const output = await handler(
			{ schemaVersion: 1, limit: 100 },
			createRequestContext(peer, productRpcMethods.chatRetiredSessionsList),
		);

		expect(output).toEqual({ schemaVersion: 1, sessionIds: [retiredSessionId] });
		expect(received).toEqual([{ schemaVersion: 1, limit: 100 }]);
		expect(JSON.stringify(output)).not.toContain("project");
	});
});
