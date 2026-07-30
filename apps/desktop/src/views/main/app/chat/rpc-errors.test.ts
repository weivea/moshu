import { describe, expect, test } from "vitest";

import {
	AgentsUnavailableError,
	agentsUnavailableCode,
	agentsUnavailableMessagePrefix,
	ChatSessionNotFoundError,
	chatSessionNotFoundCode,
	chatSessionNotFoundMessagePrefix,
	isAgentsUnavailableError,
	isChatSessionNotFoundError,
	isProjectPreviewStaleError,
	normalizeDesktopRpcError,
	ProjectPreviewStaleError,
	projectPreviewStaleCode,
	projectPreviewStaleMessagePrefix,
} from "../../../../shared/rpc-errors";

describe("desktop RPC unavailable errors", () => {
	test("recognizes and restores the stable code after Electrobun keeps only the message", () => {
		const serialized = new Error(
			`${agentsUnavailableMessagePrefix}The local agents service is recovering.`,
		);
		const normalized = normalizeDesktopRpcError(serialized);

		expect(isAgentsUnavailableError(serialized)).toBe(true);
		expect(normalized).toBeInstanceOf(AgentsUnavailableError);
		expect((normalized as AgentsUnavailableError).code).toBe(agentsUnavailableCode);
		expect(normalized.message).toBe(serialized.message);
	});

	test("does not relabel unrelated desktop RPC failures", () => {
		const error = new Error("Provider request failed.");
		expect(normalizeDesktopRpcError(error)).toBe(error);
		expect(isAgentsUnavailableError(error)).toBe(false);
	});

	test("restores a conclusive Session-not-found error after Electrobun serialization", () => {
		const serialized = new Error(
			`${chatSessionNotFoundMessagePrefix}The chat Session was not found.`,
		);
		const normalized = normalizeDesktopRpcError(serialized);

		expect(isChatSessionNotFoundError(serialized)).toBe(true);
		expect(normalized).toBeInstanceOf(ChatSessionNotFoundError);
		expect((normalized as ChatSessionNotFoundError).code).toBe(chatSessionNotFoundCode);
		expect(isAgentsUnavailableError(normalized)).toBe(false);
	});

	test("restores a stale Project preview code after Electrobun strips error properties", () => {
		const serialized = new Error(
			`${projectPreviewStaleMessagePrefix}The Project path preview is stale.`,
		);
		const normalized = normalizeDesktopRpcError(serialized);

		expect(normalized).toBeInstanceOf(ProjectPreviewStaleError);
		expect((normalized as ProjectPreviewStaleError).code).toBe(projectPreviewStaleCode);
		expect(isProjectPreviewStaleError(normalized)).toBe(true);
	});
});
