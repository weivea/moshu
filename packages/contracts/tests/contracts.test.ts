import { describe, expect, test } from "bun:test";

import {
	agentsRuntimeInfoSchema,
	createProviderInputSchema,
	providerAuthAttemptOutputSchema,
	runProviderConfigInputSchema,
	sessionModelSelectionSchema,
} from "../src";

describe("Pi-neutral backend contracts", () => {
	test("accepts Pi runtime and provider state without secret output fields", () => {
		const runtime = agentsRuntimeInfoSchema.parse({
			apiVersion: 3,
			serverVersion: "0.0.1",
			bunVersion: "1.3.14",
			platform: "darwin",
			arch: "arm64",
			agentRuntime: {
				loaded: true,
				foundation: "pi-agent",
				versions: { piAi: "0.82.1", piAgentCore: "0.82.1", piCodingAgent: "0.82.1" },
			},
			activeRuntimeBoxId: "moshu-local-runtime-box",
			runtimeBoxes: [
				{
					runtimeBox: {
						schemaVersion: 1,
						runtimeBoxId: "moshu-local-runtime-box",
						kind: "local",
						displayName: "Local Runtime Box",
						runtimeBoxVersion: "0.0.1",
						platform: "darwin",
						arch: "arm64",
						capabilities: ["tool.read"],
					},
					connected: true,
					registered: true,
					deviceKeyIds: [],
					instanceId: "local-instance",
					generation: 1,
				},
			],
		});
		expect(runtime.agentRuntime.foundation).toBe("pi-agent");
		expect(runtime.runtimeBoxes[0]?.runtimeBox.kind).toBe("local");

		const runProvider = runProviderConfigInputSchema.parse({
			schemaVersion: 1,
			providerId: "anthropic",
			name: "Anthropic",
			source: "builtin",
			api: "anthropic-messages",
			model: "claude-test",
			thinkingLevel: "high",
		});
		expect(runProvider).not.toHaveProperty("apiKey");
	});

	test("restricts custom APIs and models use Pi thinking levels", () => {
		expect(
			createProviderInputSchema.safeParse({
				schemaVersion: 2,
				displayName: "Custom",
				api: "unsupported-api",
				baseUrl: "https://example.invalid",
			}).success,
		).toBe(false);
		expect(
			sessionModelSelectionSchema.parse({
				providerId: "openai",
				modelId: "gpt-test",
				thinkingLevel: "xhigh",
			}).thinkingLevel,
		).toBe("xhigh");
	});

	test("keeps secret auth responses input-only", () => {
		const output = providerAuthAttemptOutputSchema.parse({
			attempt: {
				schemaVersion: 2,
				id: crypto.randomUUID(),
				providerId: "anthropic",
				authType: "api_key",
				status: "waiting_for_interaction",
				createdAt: new Date().toISOString(),
				updatedAt: new Date().toISOString(),
				challenge: { id: crypto.randomUUID(), type: "secret", message: "API key" },
				notifications: [],
			},
		});
		expect(output.attempt.challenge).not.toHaveProperty("value");
	});
});
