import { describe, expect, test } from "bun:test";
import Database from "bun:sqlite";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { AppError } from "@moshu/contracts";

import {
	applyAppMigrations,
	chatRunsTable,
	createUuidV7,
	getDatabaseUserVersion,
	openAppDatabase,
} from "../src";

function withTempDatabase(run: (databasePath: string) => void): void {
	const directoryPath = mkdtempSync(join(tmpdir(), "moshu-app-db-"));
	const databasePath = join(directoryPath, "app.db");
	try {
		run(databasePath);
	} finally {
		rmSync(directoryPath, { force: true, recursive: true });
	}
}

function makeProviderInput(secret = "sk-test-secret") {
	return {
		schemaVersion: 1 as const,
		providerId: createUuidV7(),
		name: "OpenAI",
		baseUrl: "https://api.openai.com/v1",
		model: "gpt-5.4",
		apiKey: secret,
	};
}

function makeProviderState() {
	return {
		schemaVersion: 1 as const,
		providerId: createUuidV7(),
		name: "OpenAI",
		baseUrl: "https://api.openai.com/v1",
		model: "gpt-5.4",
		status: "ready" as const,
	};
}

function makeAppError(code: string): AppError {
	return {
		code,
		category: "provider",
		messageKey: `errors.${code.toLowerCase()}`,
		retryable: false,
		safeMessage: `${code} happened.`,
	};
}

function createRun(database: ReturnType<typeof openAppDatabase>, sessionId: string) {
	return database.runs.create({
		sessionId,
		mode: "ask",
		provider: makeProviderInput(),
		userMessageId: createUuidV7(),
		assistantMessageId: createUuidV7(),
	});
}

function getAssistantMessageId(run: ReturnType<typeof createRun>["run"]): string {
	if (run.assistantMessageId === undefined) {
		throw new Error("Expected the run journal to assign an assistant message ID.");
	}
	return run.assistantMessageId;
}

describe("application database", () => {
	test("applies the current schema without a duplicate message table", () => {
		withTempDatabase((databasePath) => {
			const database = openAppDatabase(databasePath);
			try {
				const tableNames = database.client
					.query<{ name: string }, []>(
						"SELECT name FROM sqlite_master WHERE type = 'table' AND name LIKE 'chat_%' ORDER BY name",
					)
					.all()
					.map((row) => row.name);
				expect(tableNames).toEqual(["chat_run_events", "chat_runs", "chat_sessions"]);
				expect(getDatabaseUserVersion(database.client)).toBe(3);
				applyAppMigrations(database.client);
				expect(getDatabaseUserVersion(database.client)).toBe(3);
			} finally {
				database.close();
			}
		});
	});

	test("resets unsupported legacy application data", () => {
		withTempDatabase((databasePath) => {
			const legacy = new Database(databasePath);
			legacy.exec(`
				CREATE TABLE chat_sessions (id TEXT PRIMARY KEY NOT NULL);
				INSERT INTO chat_sessions (id) VALUES ('legacy-session');
				PRAGMA user_version = 2;
			`);
			legacy.close();

			const database = openAppDatabase(databasePath);
			try {
				expect(database.sessions.list().items).toEqual([]);
				expect(getDatabaseUserVersion(database.client)).toBe(3);
			} finally {
				database.close();
			}
		});
	});

	test("enables SQLite safety settings and run foreign keys", () => {
		withTempDatabase((databasePath) => {
			const database = openAppDatabase(databasePath);
			try {
				expect(
					database.client.query<{ foreign_keys: number }, []>("PRAGMA foreign_keys").get()
						?.foreign_keys,
				).toBe(1);
				expect(
					database.client.query<{ timeout: number }, []>("PRAGMA busy_timeout").get()?.timeout,
				).toBe(5000);
				expect(
					database.client.query<{ journal_mode: string }, []>("PRAGMA journal_mode").get()
						?.journal_mode,
				).toBe("wal");
				expect(() =>
					database.orm
						.insert(chatRunsTable)
						.values({
							id: createUuidV7(),
							sessionId: createUuidV7(),
							mode: "ask",
							status: "queued",
							providerJson: JSON.stringify(makeProviderState()),
							userMessageId: createUuidV7(),
							assistantMessageId: createUuidV7(),
							lastErrorJson: null,
							createdAtMs: Date.now(),
							updatedAtMs: Date.now(),
							completedAtMs: null,
						})
						.run(),
				).toThrow();
			} finally {
				database.close();
			}
		});
	});

	test("manages searchable and archivable session metadata", () => {
		withTempDatabase((databasePath) => {
			const database = openAppDatabase(databasePath);
			try {
				const first = database.sessions.create({ title: "Alpha notes" }).session;
				const second = database.sessions.create({ title: "Beta notes" }).session;
				expect(
					database.sessions.update({ sessionId: first.id, title: "Alpha architecture" }).session
						.title,
				).toBe("Alpha architecture");
				expect(database.sessions.list({ query: "alpha" }).items.map((item) => item.id)).toEqual([
					first.id,
				]);
				expect(database.sessions.list({ query: "%" }).items).toEqual([]);
				expect(
					database.sessions.setArchived({ sessionId: first.id, archived: true }).session.archivedAt,
				).toBeDefined();
				expect(database.sessions.list().items.map((item) => item.id)).toEqual([second.id]);
				expect(database.sessions.list({ archived: true }).items[0]?.id).toBe(first.id);
				database.sessions.delete({ sessionId: second.id });
				expect(() => database.sessions.get({ sessionId: second.id })).toThrow();
			} finally {
				database.close();
			}
		});
	});

	test("journals run status and UI delivery events without message rows", () => {
		withTempDatabase((databasePath) => {
			const database = openAppDatabase(databasePath);
			try {
				const session = database.sessions.create({ title: "Run journal" }).session;
				const created = createRun(database, session.id);
				const assistantMessageId = getAssistantMessageId(created.run);
				const running = database.runs.updateStatus({ runId: created.run.id, status: "running" });
				const started = database.runs.appendEvent({
					runId: created.run.id,
					type: "message.started",
					source: { kind: "assistant" },
					payload: {
						messageId: assistantMessageId,
						role: "assistant",
						status: "streaming",
					},
				});
				const delta = database.runs.appendEvent({
					runId: created.run.id,
					type: "message.delta",
					source: { kind: "assistant" },
					payload: { messageId: assistantMessageId, delta: "Hello" },
				});
				database.runs.appendEvent({
					runId: created.run.id,
					type: "message.completed",
					source: { kind: "assistant" },
					payload: {
						messageId: assistantMessageId,
						status: "complete",
						content: "Hello",
					},
				});
				const completed = database.runs.updateStatus({
					runId: created.run.id,
					status: "completed",
				});

				const events = database.runs.listEvents({ runId: created.run.id });
				expect(events.map((event) => event.seq)).toEqual([1, 2, 3, 4, 5, 6]);
				expect(events.map((event) => event.type)).toEqual([
					"run.status",
					"run.status",
					"message.started",
					"message.delta",
					"message.completed",
					"run.status",
				]);
				expect(running.run.status).toBe("running");
				expect(started.seq).toBe(3);
				expect(delta.seq).toBe(4);
				expect(completed.run.status).toBe("completed");
				expect(database.runs.listBySession(session.id)).toHaveLength(1);
				expect(database.runs.cancel({ runId: created.run.id }).run.status).toBe("completed");
			} finally {
				database.close();
			}
		});
	});

	test("persists failures and cancellation as run journal state", () => {
		withTempDatabase((databasePath) => {
			const database = openAppDatabase(databasePath);
			try {
				const session = database.sessions.create({ title: "Terminal runs" }).session;
				const failed = createRun(database, session.id);
				const failedAssistantMessageId = getAssistantMessageId(failed.run);
				database.runs.updateStatus({ runId: failed.run.id, status: "running" });
				const failure = database.runs.fail({
					runId: failed.run.id,
					error: makeAppError("PROVIDER_DOWN"),
					messageEvent: {
						messageId: failedAssistantMessageId,
						content: "Partial",
					},
				});
				expect(failure.run.status).toBe("failed");
				expect(failure.events.map((event) => event.type)).toEqual([
					"message.completed",
					"run.error",
					"run.status",
				]);

				const cancelled = createRun(database, session.id);
				database.runs.updateStatus({ runId: cancelled.run.id, status: "running" });
				expect(database.runs.cancel({ runId: cancelled.run.id }).run.status).toBe("cancelling");
				expect(
					database.runs.updateStatus({ runId: cancelled.run.id, status: "cancelled" }).run.status,
				).toBe("cancelled");
			} finally {
				database.close();
			}
		});
	});

	test("never persists provider API keys", () => {
		withTempDatabase((databasePath) => {
			const secret = "sk-live-never-store-this";
			const database = openAppDatabase(databasePath);
			try {
				const session = database.sessions.create({ title: "Provider secrecy" }).session;
				const created = database.runs.create({
					sessionId: session.id,
					mode: "ask",
					provider: makeProviderInput(secret),
					userMessageId: createUuidV7(),
					assistantMessageId: createUuidV7(),
				});
				expect("apiKey" in created.run.provider).toBe(false);
			} finally {
				database.close();
			}

			for (const path of [databasePath, `${databasePath}-wal`, `${databasePath}-shm`]) {
				if (existsSync(path)) {
					expect(readFileSync(path).includes(Buffer.from(secret))).toBe(false);
				}
			}
		});
	});
});
