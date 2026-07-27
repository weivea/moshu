import { describe, expect, test } from "bun:test";
import { mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { Agent } from "@earendil-works/pi-agent-core";
import { contentText, fauxAssistantMessage, fauxProvider } from "@earendil-works/pi-ai";
import {
	createAgentSession,
	DefaultResourceLoader,
	ModelRuntime,
	SessionManager,
	SettingsManager,
} from "@earendil-works/pi-coding-agent";

describe("pi 0.82.1 public API compatibility", () => {
	test("runs and restores a persisted headless AgentSession", async () => {
		await withTempAppData(async ({ agentDir, cwd, sessionDir }) => {
			const faux = fauxProvider({
				provider: "moshu-compatibility-test",
				models: [{ id: "deterministic-test-model" }],
				tokenSize: { min: 100, max: 100 },
			});
			faux.setResponses([fauxAssistantMessage("Compatibility gate reply")]);
			const modelRuntime = await createModelRuntime(agentDir, faux.provider);
			const sessionManager = SessionManager.create(cwd, sessionDir);
			const first = await createHeadlessSession({
				agentDir,
				cwd,
				modelRuntime,
				sessionManager,
				model: faux.getModel(),
			});

			try {
				expect(first.session.agent).toBeInstanceOf(Agent);
				expect(first.extensionsResult.extensions).toHaveLength(0);
				expect(first.session.getActiveToolNames()).toEqual([]);
				expect(first.session.promptTemplates).toEqual([]);

				await first.session.prompt("Reply without using tools", {
					expandPromptTemplates: false,
				});

				const assistantMessage = first.session.messages.findLast(
					(message) => message.role === "assistant",
				);
				expect(assistantMessage?.role).toBe("assistant");
				if (assistantMessage?.role !== "assistant") {
					throw new Error("Expected a persisted assistant reply");
				}
				expect(contentText(assistantMessage.content)).toBe("Compatibility gate reply");

				const sessionFile = first.session.sessionFile;
				expect(sessionFile).toBeDefined();
				if (!sessionFile) {
					throw new Error("Expected SessionManager to persist a session file");
				}

				first.session.dispose();
				const restoredManager = SessionManager.open(sessionFile, sessionDir, cwd);
				const restored = await createHeadlessSession({
					agentDir,
					cwd,
					modelRuntime,
					sessionManager: restoredManager,
					model: faux.getModel(),
				});
				try {
					expect(restored.session.sessionId).toBe(first.session.sessionId);
					expect(restoredManager.buildSessionContext().messages).toEqual(first.session.messages);
					expect(restored.session.messages).toEqual(first.session.messages);
					expect(restored.session.getActiveToolNames()).toEqual([]);
				} finally {
					restored.session.dispose();
				}
			} finally {
				first.session.dispose();
			}
		});
	});

	test("aborts the public faux stream", async () => {
		await withTempAppData(async ({ agentDir, cwd, sessionDir }) => {
			const faux = fauxProvider({
				provider: "moshu-abort-test",
				models: [{ id: "abort-test-model" }],
				tokensPerSecond: 1,
				tokenSize: { min: 1, max: 1 },
			});
			faux.setResponses([fauxAssistantMessage("This reply should be aborted.")]);
			const modelRuntime = await createModelRuntime(agentDir, faux.provider);
			const created = await createHeadlessSession({
				agentDir,
				cwd,
				modelRuntime,
				sessionManager: SessionManager.create(cwd, sessionDir),
				model: faux.getModel(),
			});

			try {
				const started = Promise.withResolvers<void>();
				const unsubscribe = created.session.subscribe((event) => {
					if (event.type === "agent_start") {
						started.resolve();
					}
				});
				const prompt = created.session.prompt("Start a slow reply", {
					expandPromptTemplates: false,
				});
				await started.promise;
				await created.session.abort();
				await prompt;
				unsubscribe();

				const assistantMessage = created.session.messages.findLast(
					(message) => message.role === "assistant",
				);
				expect(assistantMessage).toMatchObject({
					role: "assistant",
					stopReason: "aborted",
				});
				expect(created.session.isIdle).toBe(true);
				expect(faux.state.callCount).toBe(1);
			} finally {
				created.session.dispose();
			}
		});
	});
});

async function createModelRuntime(
	agentDir: string,
	provider: ReturnType<typeof fauxProvider>["provider"],
): Promise<ModelRuntime> {
	const modelRuntime = await ModelRuntime.create({
		authPath: join(agentDir, "auth.json"),
		modelsPath: null,
		allowModelNetwork: false,
	});
	modelRuntime.registerNativeProvider(provider);
	return modelRuntime;
}

async function createHeadlessSession(options: {
	agentDir: string;
	cwd: string;
	modelRuntime: ModelRuntime;
	sessionManager: SessionManager;
	model: NonNullable<ReturnType<ReturnType<typeof fauxProvider>["getModel"]>>;
}) {
	const settingsManager = SettingsManager.inMemory({
		compaction: { enabled: false },
		retry: { enabled: false },
		packages: [],
		extensions: [],
		skills: [],
		prompts: [],
		themes: [],
	});
	const resourceLoader = new DefaultResourceLoader({
		cwd: options.cwd,
		agentDir: options.agentDir,
		settingsManager,
		noExtensions: true,
		noSkills: true,
		noPromptTemplates: true,
		noThemes: true,
		noContextFiles: true,
		systemPrompt: "You are a headless compatibility test.",
	});
	await resourceLoader.reload();

	expect(resourceLoader.getExtensions().extensions).toHaveLength(0);
	expect(resourceLoader.getSkills().skills).toHaveLength(0);
	expect(resourceLoader.getPrompts().prompts).toHaveLength(0);
	expect(resourceLoader.getThemes().themes).toHaveLength(0);
	expect(resourceLoader.getAgentsFiles().agentsFiles).toHaveLength(0);

	return createAgentSession({
		agentDir: options.agentDir,
		cwd: options.cwd,
		modelRuntime: options.modelRuntime,
		model: options.model,
		noTools: "all",
		resourceLoader,
		sessionManager: options.sessionManager,
		settingsManager,
	});
}

async function withTempAppData(
	run: (paths: { agentDir: string; cwd: string; sessionDir: string }) => Promise<void>,
): Promise<void> {
	const root = join(process.cwd(), ".test-artifacts", `pi-compatibility-${crypto.randomUUID()}`);
	const paths = {
		agentDir: join(root, "app-data"),
		cwd: join(root, "workspace"),
		sessionDir: join(root, "app-data", "sessions"),
	};
	mkdirSync(root, { recursive: true });
	mkdirSync(paths.agentDir, { recursive: true });
	mkdirSync(paths.cwd, { recursive: true });
	mkdirSync(paths.sessionDir, { recursive: true });
	try {
		await run(paths);
	} finally {
		rmSync(root, { force: true, recursive: true });
	}
}
