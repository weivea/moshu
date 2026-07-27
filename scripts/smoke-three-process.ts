import { existsSync, mkdirSync, rmSync } from "node:fs";
import { mkdtemp } from "node:fs/promises";
import { resolve } from "node:path";
import {
	CompanionProcessSupervisor,
	type DesktopAgentsConnectOptions,
} from "../apps/desktop/src/bun/companion-process-supervisor";
import { DesktopAgentsClient } from "../apps/desktop/src/bun/desktop-agents-client";
import { getCompanionExecutableFilename } from "../apps/desktop/src/shared/companion-executable-names";
import { isAgentsUnavailableError } from "../apps/desktop/src/shared/rpc-errors";
import {
	agentsRuntimeInfoSchema,
	type ChatRunEvent,
	cancelChatRunInputSchema,
	cancelChatRunOutputSchema,
	chatRunEventSchema,
	chatSendAcceptedOutputSchema,
	createProviderInputSchema,
	emptyParamsSchema,
	fetchProviderModelsInputSchema,
	fetchProviderModelsOutputSchema,
	getChatSessionPageInputSchema,
	getChatSessionPageOutputSchema,
	maxAppErrorSafeMessageCharacters,
	productRpcMethods,
	providerMutationOutputSchema,
	sendAskChatMessageInputSchema,
	setDefaultModelInputSchema,
	setDefaultModelOutputSchema,
	setProviderModelsEnabledInputSchema,
	setProviderModelsEnabledOutputSchema,
} from "../packages/contracts/src";
import { createUuidV7 } from "../packages/database/src";
import {
	connectRpcClient,
	createRpcBearerHandshakeHeaders,
	RpcHandshakeError,
	RpcRemoteError,
} from "../packages/process-rpc/src";

const repositoryRoot = resolve(import.meta.dir, "..");
const smokeRoot = resolve(repositoryRoot, ".test-artifacts");
mkdirSync(smokeRoot, { recursive: true });
const directory = await mkdtemp(resolve(smokeRoot, "moshu-three-process-"));
const productDatabase = resolve(directory, "moshu.db");
const agentDataDirectory = resolve(directory, "agent-data");
const staleCredential = Buffer.alloc(32, 91).toString("base64url");
const agentsClient = new DesktopAgentsClient();
let connectionOptions: DesktopAgentsConnectOptions | undefined;
let rejectedBeforeExecutor = false;

const agentsFilename = getCompanionExecutableFilename("agents-server");
const smokeAgentsFilename =
	process.platform === "win32"
		? agentsFilename.replace(/\.exe$/, "-smoke.exe")
		: `${agentsFilename}-smoke`;
const supervisor = new CompanionProcessSupervisor({
	executables: {
		"agents-server": resolve(repositoryRoot, "apps", "agents-server", "dist", smokeAgentsFilename),
		executor: resolve(
			repositoryRoot,
			"apps",
			"executor",
			"dist",
			getCompanionExecutableFilename("executor"),
		),
	},
	dataPaths: { productDatabase, agentDataDirectory },
	additionalPeerBindings: [
		{
			credential: staleCredential,
			identity: {
				role: "client",
				peerId: "moshu-desktop-client",
				instanceId: "stale-client-instance",
				generation: 0,
			},
		},
	],
	async connectClient(options) {
		connectionOptions = options;
		const connection = await agentsClient.connect(options);
		const runtime = await agentsClient.request(
			productRpcMethods.runtimeGet,
			{},
			emptyParamsSchema,
			agentsRuntimeInfoSchema,
		);
		if (runtime.ready) {
			throw new Error("Agents runtime became ready before executor registration.");
		}
		try {
			await agentsClient.request(
				productRpcMethods.chatSend,
				{
					requestId: crypto.randomUUID(),
					sessionId: createUuidV7(),
					content: "must fail before executor",
				},
				sendAskChatMessageInputSchema,
				chatSendAcceptedOutputSchema,
			);
		} catch (error) {
			if (
				!isAgentsUnavailableError(error) &&
				!(error instanceof RpcRemoteError && error.code === "AGENTS_NOT_READY")
			) {
				throw error;
			}
			rejectedBeforeExecutor = true;
		}
		return connection;
	},
});

try {
	const snapshot = await supervisor.start();
	const capturedConnection = connectionOptions;
	if (capturedConnection === undefined || !rejectedBeforeExecutor) {
		throw new Error("Desktop client did not observe fail-closed pre-executor readiness.");
	}

	const runtime = await agentsClient.request(
		productRpcMethods.runtimeGet,
		{},
		emptyParamsSchema,
		agentsRuntimeInfoSchema,
	);
	if (!runtime.ready || !runtime.executor.registered) {
		throw new Error("Agents runtime did not report authenticated executor readiness.");
	}

	await expectHandshakeFailure(
		"invalid credential",
		capturedConnection,
		Buffer.alloc(32, 92).toString("base64url"),
		capturedConnection.identity,
	);
	await expectHandshakeFailure("role spoof", capturedConnection, capturedConnection.credential, {
		...capturedConnection.identity,
		role: "executor",
	});
	await expectHandshakeFailure("stale generation", capturedConnection, staleCredential, {
		role: "client",
		peerId: "moshu-desktop-client",
		instanceId: "stale-client-instance",
		generation: 0,
	});

	const created_provider = await agentsClient.request(
		productRpcMethods.providersCreate,
		{
			schemaVersion: 2,
			displayName: "Smoke provider",
			api: "openai-completions",
			baseUrl: "https://smoke.invalid/v1",
			apiKey: "smoke-secret",
		},
		createProviderInputSchema,
		providerMutationOutputSchema,
	);
	if (JSON.stringify(created_provider).includes("smoke-secret")) {
		throw new Error("Provider RPC output leaked the API key.");
	}
	const providerId = created_provider.provider.id;
	const withModels = await agentsClient.request(
		productRpcMethods.providersFetchModels,
		{ schemaVersion: 2, providerId },
		fetchProviderModelsInputSchema,
		fetchProviderModelsOutputSchema,
	);
	const smokeModelId = withModels.provider.models[0]?.id;
	if (smokeModelId === undefined) {
		throw new Error("Smoke Provider returned no models.");
	}
	await agentsClient.request(
		productRpcMethods.providersSetModelsEnabled,
		{ schemaVersion: 2, providerId, enabledModelIds: [smokeModelId] },
		setProviderModelsEnabledInputSchema,
		setProviderModelsEnabledOutputSchema,
	);
	const defaultModel = await agentsClient.request(
		productRpcMethods.defaultModelSet,
		{ schemaVersion: 2, defaultModel: { providerId, modelId: smokeModelId } },
		setDefaultModelInputSchema,
		setDefaultModelOutputSchema,
	);
	if (defaultModel.defaultModel?.modelId !== smokeModelId) {
		throw new Error("Smoke default model was not stored.");
	}

	const events: ChatRunEvent[] = [];
	const unsubscribe = agentsClient.subscribeChatEvents((event) => events.push(event));
	const created = await agentsClient.createSession();
	const sendRequestId = crypto.randomUUID();
	const accepted = await agentsClient.request(
		productRpcMethods.chatSend,
		{ requestId: sendRequestId, sessionId: created.session.id, content: "smoke" },
		sendAskChatMessageInputSchema,
		chatSendAcceptedOutputSchema,
	);
	const retried = await agentsClient.request(
		productRpcMethods.chatSend,
		{ requestId: sendRequestId, sessionId: created.session.id, content: "smoke" },
		sendAskChatMessageInputSchema,
		chatSendAcceptedOutputSchema,
	);
	if (retried.run.id !== accepted.run.id) {
		throw new Error("Ambiguous Chat send retry created a duplicate Run.");
	}
	await waitForEvent(events, accepted.run.id, "message.completed");
	const session = await agentsClient.request(
		productRpcMethods.sessionGet,
		{ sessionId: created.session.id, limit: 2 },
		getChatSessionPageInputSchema,
		getChatSessionPageOutputSchema,
	);
	if (
		session.messages.at(-1)?.content !== "hello world" ||
		(session.eventCursors.find((cursor) => cursor.runId === accepted.run.id)?.lastSeq ?? 0) < 1
	) {
		throw new Error("Chat snapshot did not reconcile streamed events.");
	}

	const errorSession = await agentsClient.createSession();
	const errorRequestId = crypto.randomUUID();
	const errorAccepted = await agentsClient.request(
		productRpcMethods.chatSend,
		{
			requestId: errorRequestId,
			sessionId: errorSession.session.id,
			content: "huge-error",
		},
		sendAskChatMessageInputSchema,
		chatSendAcceptedOutputSchema,
	);
	await waitForEvent(events, errorAccepted.run.id, "message.completed");
	const errorPage = await agentsClient.request(
		productRpcMethods.sessionGet,
		{ sessionId: errorSession.session.id, limit: 2 },
		getChatSessionPageInputSchema,
		getChatSessionPageOutputSchema,
	);
	const safeMessage = errorPage.runs[0]?.lastError?.safeMessage;
	if (
		safeMessage === undefined ||
		safeMessage.length < 1 ||
		safeMessage.length > maxAppErrorSafeMessageCharacters ||
		JSON.stringify(errorPage).length >= 1_000_000
	) {
		throw new Error("Huge runtime error was not normalized before process RPC.");
	}
	const errorRetry = await agentsClient.request(
		productRpcMethods.chatSend,
		{
			requestId: errorRequestId,
			sessionId: errorSession.session.id,
			content: "huge-error",
		},
		sendAskChatMessageInputSchema,
		chatSendAcceptedOutputSchema,
	);
	if (
		errorRetry.assistantMessage.status !== "failed" ||
		JSON.stringify(errorRetry).length >= 1_000_000
	) {
		throw new Error("Huge runtime error retry was not a bounded terminal projection.");
	}

	const interruptedSession = await agentsClient.createSession();
	const interrupted = await agentsClient.request(
		productRpcMethods.chatSend,
		{
			requestId: crypto.randomUUID(),
			sessionId: interruptedSession.session.id,
			content: "cancel-me",
		},
		sendAskChatMessageInputSchema,
		chatSendAcceptedOutputSchema,
	);
	await waitForEvent(events, interrupted.run.id, "message.delta");
	const crashedServerPid = supervisor.getSnapshot().processes["agents-server"]?.identity.pid;
	if (crashedServerPid === undefined) {
		throw new Error("Smoke supervisor has no running agents-server.");
	}
	process.kill(crashedServerPid, "SIGKILL");
	const replayed = await waitForEvent(events, interrupted.run.id, "message.completed");
	if (replayed.type !== "message.completed" || replayed.payload.status !== "cancelled") {
		throw new Error("Restart recovery did not replay the orphaned terminal event.");
	}
	await waitForRuntimeReady();

	const cancellableSession = await agentsClient.createSession();
	const cancellable = await agentsClient.request(
		productRpcMethods.chatSend,
		{
			requestId: crypto.randomUUID(),
			sessionId: cancellableSession.session.id,
			content: "cancel-me",
		},
		sendAskChatMessageInputSchema,
		chatSendAcceptedOutputSchema,
	);
	await waitForEvent(events, cancellable.run.id, "message.delta");
	await agentsClient.request(
		productRpcMethods.chatCancel,
		{ runId: cancellable.run.id, reason: "smoke cancellation" },
		cancelChatRunInputSchema,
		cancelChatRunOutputSchema,
	);
	const cancelled = await waitForEvent(events, cancellable.run.id, "message.completed");
	if (cancelled.type !== "message.completed" || cancelled.payload.status !== "cancelled") {
		throw new Error("Smoke cancellation did not publish a cancelled terminal event.");
	}
	unsubscribe();

	for (const filename of [productDatabase, agentDataDirectory]) {
		if (!existsSync(filename)) {
			throw new Error(`agents-server did not create its owned data file: ${filename}`);
		}
	}

	const finalSnapshot = supervisor.getSnapshot();
	const pids = [
		snapshot.processes["agents-server"]?.identity.pid,
		snapshot.processes.executor?.identity.pid,
		finalSnapshot.processes["agents-server"]?.identity.pid,
		finalSnapshot.processes.executor?.identity.pid,
	].filter((pid): pid is number => pid !== undefined);
	agentsClient.close();
	await supervisor.shutdown();
	await Bun.sleep(50);
	for (const pid of pids) {
		if (isProcessAlive(pid)) {
			throw new Error(`Companion process ${pid} survived shutdown.`);
		}
	}

	console.log(
		JSON.stringify({
			status: "READY",
			chatEvents: events.length,
			cancelled: true,
			authRejected: true,
			staleGenerationRejected: true,
			restartReconciled: true,
			dataFilesOwnedByServer: true,
			noOrphans: true,
		}),
	);
} finally {
	agentsClient.close();
	await supervisor.shutdown();
	rmSync(directory, { recursive: true, force: true });
}

async function expectHandshakeFailure(
	label: string,
	options: NonNullable<typeof connectionOptions>,
	credential: string,
	identity: NonNullable<typeof connectionOptions>["identity"],
): Promise<void> {
	try {
		const peer = await connectRpcClient({
			url: `ws://${options.agentsServer.endpoint.host}:${options.agentsServer.endpoint.port}${options.agentsServer.endpoint.path}`,
			identity,
			expectedServerIdentity: options.agentsServer.serverIdentity,
			getHandshakeHeaders: createRpcBearerHandshakeHeaders(credential),
		});
		peer.close();
		throw new Error(`${label} unexpectedly authenticated.`);
	} catch (error) {
		if (error instanceof Error && error.message === `${label} unexpectedly authenticated.`) {
			throw error;
		}
		if (!(error instanceof RpcHandshakeError)) {
			throw new Error(`${label} did not fail during the authenticated handshake.`, {
				cause: error,
			});
		}
	}
}

async function waitForEvent(
	events: ChatRunEvent[],
	runId: string,
	type: ChatRunEvent["type"],
): Promise<ChatRunEvent> {
	const deadline = Date.now() + 5_000;
	while (Date.now() < deadline) {
		const event = events.find((candidate) => candidate.runId === runId && candidate.type === type);
		if (event !== undefined) {
			return chatRunEventSchema.parse(event);
		}

		await Bun.sleep(10);
	}
	throw new Error(`Timed out waiting for ${type} on run ${runId}.`);
}

async function waitForRuntimeReady(): Promise<void> {
	const deadline = Date.now() + 5_000;
	while (Date.now() < deadline) {
		try {
			const runtime = await agentsClient.request(
				productRpcMethods.runtimeGet,
				{},
				emptyParamsSchema,
				agentsRuntimeInfoSchema,
			);
			if (runtime.ready) {
				return;
			}
		} catch {
			// The desktop client is expected to be unavailable while the pair is reconnecting.
		}
		await Bun.sleep(10);
	}
	throw new Error("Timed out waiting for runtime readiness after restart.");
}

function isProcessAlive(pid: number): boolean {
	try {
		process.kill(pid, 0);
		return true;
	} catch {
		return false;
	}
}
