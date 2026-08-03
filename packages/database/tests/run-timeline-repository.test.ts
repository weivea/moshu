import { expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	chatRunToolPayloadBudgetBytes,
	type ChatRunTextPart,
	type ChatRunToolPart,
} from "@moshu/contracts";
import { createUuidV7, openAppDatabase } from "../src";

test("persists interleaved text and parallel tools in stable display order", () => {
	const directory = mkdtempSync(join(tmpdir(), "moshu-run-timeline-"));
	const databasePath = join(directory, "app.db");
	const clientRequestId = crypto.randomUUID();
	let runId = "";
	let sessionId = "";

	try {
		const database = openAppDatabase(databasePath);
		try {
			const session = database.sessions.create({ title: "Timeline" }).session;
			sessionId = session.id;
			const created = database.runs.create({
				clientRequestId,
				sessionId,
				mode: "agent",
				provider: {
					schemaVersion: 1,
					providerId: createUuidV7(),
					name: "Test Provider",
					source: "custom",
					api: "openai-responses",
					model: "deterministic",
				},
				userMessageId: createUuidV7(),
				userContent: "Inspect the project.",
			});

			runId = created.run.id;
			database.runs.updateStatus({ runId, status: "running" });

			const firstTurnId = createUuidV7();
			const textA = createTextPart(runId, firstTurnId, 1, "A");
			appendPart(database, textA);
			completeText(database, { ...textA, status: "completed", revision: 2 });

			const tool1 = createToolPart(runId, firstTurnId, 2, "call-1", "read");
			const tool2 = createToolPart(runId, firstTurnId, 3, "call-2", "grep");
			appendPart(database, tool1);
			appendPart(database, tool2);

			updateTool(database, completeTool(tool2, "second finished first"));
			updateTool(database, completeTool(tool1, "first finished second"));

			const textB = createTextPart(runId, createUuidV7(), 4, "B");
			appendPart(database, textB);
			completeText(database, { ...textB, status: "completed", revision: 2 });

			database.runs.commitTerminal({ runId, status: "completed" });

			const parts = database.runs.listParts(runId);
			expect(parts.map((part) => part.position)).toEqual([1, 2, 3, 4]);
			expect(parts.map((part) => part.kind)).toEqual(["text", "tool", "tool", "text"]);
			expect(
				parts.filter((part) => part.kind === "tool").map((part) => part.output?.value),
			).toEqual(["first finished second", "second finished first"]);
			expect(database.runs.listEvents({ runId }).map((event) => event.seq)).toEqual([
				1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11,
			]);
		} finally {
			database.close();
		}

		const reopened = openAppDatabase(databasePath);
		try {
			const restored = reopened.runs.getByClientRequestId(clientRequestId);
			expect(restored?.run.id).toBe(runId);
			expect(restored?.run.status).toBe("completed");
			expect(restored?.userMessage.content).toBe("Inspect the project.");
			expect(restored?.timeline.map((part) => part.position)).toEqual([1, 2, 3, 4]);
			expect(restored?.timeline.map((part) => part.kind)).toEqual(["text", "tool", "tool", "text"]);
			expect(restored?.lastEventSeq).toBe(11);
			expect(restored?.run.sessionId).toBe(sessionId);
		} finally {
			reopened.close();
		}
	} finally {
		rmSync(directory, { recursive: true, force: true });
	}
});

test("bounds aggregate Tool payloads without dropping later ToolParts or terminal states", () => {
	const directory = mkdtempSync(join(tmpdir(), "moshu-run-budget-"));
	const databasePath = join(directory, "app.db");
	let runId = "";

	try {
		const database = openAppDatabase(databasePath);
		try {
			const session = database.sessions.create({ title: "Payload budget" }).session;
			const created = database.runs.create({
				clientRequestId: crypto.randomUUID(),
				sessionId: session.id,
				mode: "agent",
				provider: {
					schemaVersion: 1,
					providerId: createUuidV7(),
					name: "Test Provider",
					source: "custom",
					api: "openai-responses",
					model: "deterministic",
				},
				userMessageId: createUuidV7(),
				userContent: "Run many tools.",
			});
			runId = created.run.id;
			database.runs.updateStatus({ runId, status: "running" });
			const turnId = createUuidV7();
			for (let index = 0; index < 10; index += 1) {
				const part = createToolPart(runId, turnId, index + 1, `call-${index}`, "read");
				appendPart(database, part);
				updateTool(database, completeTool(part, `${index}:${"x".repeat(256 * 1024)}`));
			}

			const parts = database.runs
				.listParts(runId)
				.filter((part): part is ChatRunToolPart => part.kind === "tool");
			expect(parts).toHaveLength(10);
			expect(parts.every((part) => part.status === "completed")).toBe(true);
			expect(parts.some((part) => part.payloadsTruncated)).toBe(true);
			expect(
				parts.reduce(
					(total, part) =>
						total +
						serializedBytes(part.input) +
						serializedBytes(part.progress) +
						serializedBytes(part.output),
					0,
				),
			).toBeLessThanOrEqual(chatRunToolPayloadBudgetBytes);
		} finally {
			database.close();
		}

		const reopened = openAppDatabase(databasePath);
		try {
			const restored = reopened.runs
				.listParts(runId)
				.filter((part): part is ChatRunToolPart => part.kind === "tool");
			expect(restored).toHaveLength(10);
			expect(restored.some((part) => part.payloadsTruncated)).toBe(true);
		} finally {
			reopened.close();
		}
	} finally {
		rmSync(directory, { recursive: true, force: true });
	}
});

function createTextPart(
	runId: string,
	assistantTurnId: string,
	position: number,
	content: string,
): ChatRunTextPart {
	const now = new Date().toISOString();
	return {
		schemaVersion: 1,
		id: createUuidV7(),
		runId,
		position,
		assistantTurnId,
		kind: "text",
		status: "streaming",
		content,
		revision: 1,
		createdAt: now,
		updatedAt: now,
	};
}

function createToolPart(
	runId: string,
	assistantTurnId: string,
	position: number,
	toolCallId: string,
	name: "read" | "grep",
): ChatRunToolPart {
	const now = new Date().toISOString();
	return {
		schemaVersion: 1,
		id: createUuidV7(),
		runId,
		position,
		assistantTurnId,
		kind: "tool",
		toolCallId,
		tool: { kind: "builtin", name },
		status: "queued",
		summary: `${name} workspace`,
		input: {
			format: "json",
			value: { path: "." },
			truncated: false,
			redactionCount: 0,
		},
		revision: 1,
		createdAt: now,
		updatedAt: now,
	};
}

function appendPart(
	database: ReturnType<typeof openAppDatabase>,
	part: ChatRunTextPart | ChatRunToolPart,
): void {
	database.runs.appendEvent({
		runId: part.runId,
		type: "timeline.part.created",
		source: { kind: "assistant" },
		payload: { part },
	});
}

function completeText(database: ReturnType<typeof openAppDatabase>, part: ChatRunTextPart): void {
	database.runs.appendEvent({
		runId: part.runId,
		type: "timeline.text.completed",
		source: { kind: "assistant" },
		payload: { part: { ...part, updatedAt: new Date().toISOString() } },
	});
}

function completeTool(part: ChatRunToolPart, output: string): ChatRunToolPart {
	const now = new Date().toISOString();
	return {
		...part,
		status: "completed",
		output: {
			format: "text",
			value: output,
			truncated: false,
			redactionCount: 0,
		},
		startedAt: now,
		completedAt: now,
		durationMs: 0,
		revision: part.revision + 1,
		updatedAt: now,
	};
}

function updateTool(database: ReturnType<typeof openAppDatabase>, part: ChatRunToolPart): void {
	database.runs.appendEvent({
		runId: part.runId,
		type: "timeline.tool.updated",
		source: { kind: "assistant" },
		payload: { part },
	});
}

function serializedBytes(value: unknown): number {
	return value === undefined ? 0 : new TextEncoder().encode(JSON.stringify(value)).byteLength;
}
