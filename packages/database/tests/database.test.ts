import { describe, expect, test } from "bun:test";
import Database from "bun:sqlite";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { AppError, ChatMessage } from "@moshu/contracts";

import {
	applyAppMigrations,
	createUuidV7,
	getDatabaseUserVersion,
	chatRunsTable,
	openAppDatabase,
} from "../src";

function withTempDatabase(run: (databasePath: string) => void): void {
	const directoryPath = mkdtempSync(join(tmpdir(), "moshu-chat-db-"));
	const databasePath = join(directoryPath, "app.db");

	try {
		run(databasePath);
	} finally {
		rmSync(directoryPath, { force: true, recursive: true });
	}
}

function makeProviderInput() {
	return {
		schemaVersion: 1 as const,
		providerId: createUuidV7(),
		name: "OpenAI",
		baseUrl: "https://api.openai.com/v1",
		model: "gpt-5.4",
		apiKey: "sk-test-secret",
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

function findAssistantMessage(messages: ChatMessage[]): ChatMessage {
	const assistantMessage = messages.find((message) => message.role === "assistant");

	if (assistantMessage === undefined) {
		throw new Error("Expected an assistant message.");
	}

	return assistantMessage;
}

describe("application database", () => {
	test("enables the SQLite safety baseline and applies idempotent migrations", () => {
		withTempDatabase((databasePath) => {
			const database = openAppDatabase(databasePath);

			try {
				const foreignKeys = database.client
					.query<{ foreign_keys: number }, []>("PRAGMA foreign_keys")
					.get();
				const busyTimeout = database.client
					.query<{ timeout: number }, []>("PRAGMA busy_timeout")
					.get();
				const journalMode = database.client
					.query<{ journal_mode: string }, []>("PRAGMA journal_mode")
					.get();
				const schemaObjectsBefore = database.client
					.query<{ name: string }, []>(
						"SELECT name FROM sqlite_master WHERE name LIKE 'chat_%' ORDER BY name",
					)
					.all()
					.map((row) => row.name);

				expect(foreignKeys?.foreign_keys).toBe(1);
				expect(busyTimeout?.timeout).toBe(5000);
				expect(journalMode?.journal_mode).toBe("wal");
				expect(getDatabaseUserVersion(database.client)).toBe(2);

				applyAppMigrations(database.client);

				const schemaObjectsAfter = database.client
					.query<{ name: string }, []>(
						"SELECT name FROM sqlite_master WHERE name LIKE 'chat_%' ORDER BY name",
					)
					.all()
					.map((row) => row.name);

				expect(schemaObjectsAfter).toEqual(schemaObjectsBefore);
			} finally {
				database.close();
			}
		});
	});

	test("migrates existing v1 Sessions without losing data", () => {
		withTempDatabase((databasePath) => {
			const sessionId = createUuidV7();
			const legacyDatabase = new Database(databasePath);
			legacyDatabase.exec(`
				CREATE TABLE chat_sessions (
					id TEXT PRIMARY KEY NOT NULL,
					title TEXT NOT NULL,
					default_mode TEXT NOT NULL,
					created_at_ms INTEGER NOT NULL,
					updated_at_ms INTEGER NOT NULL,
					last_message_at_ms INTEGER
				);
				INSERT INTO chat_sessions (
					id, title, default_mode, created_at_ms, updated_at_ms, last_message_at_ms
				) VALUES (
					'${sessionId}', 'Legacy Session', 'ask', 1, 1, NULL
				);
				PRAGMA user_version = 1;
			`);
			legacyDatabase.close();

			const database = openAppDatabase(databasePath);
			try {
				expect(getDatabaseUserVersion(database.client)).toBe(2);
				expect(database.chat.getSession({ sessionId }).session).toMatchObject({
					id: sessionId,
					title: "Legacy Session",
					archivedAt: undefined,
				});
				expect(
					database.chat.setSessionArchived({ sessionId, archived: true }).session.archivedAt,
				).toBeDefined();
			} finally {
				database.close();
			}
		});
	});

	test("enforces foreign keys for runs", () => {
		withTempDatabase((databasePath) => {
			const database = openAppDatabase(databasePath);

			try {
				expect(() =>
					database.orm
						.insert(chatRunsTable)
						.values({
							id: createUuidV7(),
							sessionId: createUuidV7(),
							mode: "ask",
							status: "queued",
							providerJson: JSON.stringify(makeProviderState()),
							userMessageId: null,
							assistantMessageId: null,
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

	test("supports searching, renaming, archiving, restoring, and deleting Sessions", () => {
		withTempDatabase((databasePath) => {
			const database = openAppDatabase(databasePath);

			try {
				const first = database.chat.createSession({ title: "Alpha notes" }).session;
				const second = database.chat.createSession({ title: "Beta notes" }).session;

				const renamed = database.chat.updateSession({
					sessionId: first.id,
					title: "Alpha architecture",
				}).session;
				expect(renamed.title).toBe("Alpha architecture");

				expect(
					database.chat
						.listSessions({
							query: "alpha",
						})
						.items.map((session) => session.id),
				).toEqual([first.id]);
				expect(database.chat.listSessions({ query: "%" }).items).toEqual([]);
				expect(database.chat.listSessions({ query: "_" }).items).toEqual([]);

				const archived = database.chat.setSessionArchived({
					sessionId: first.id,
					archived: true,
				}).session;
				expect(archived.archivedAt).toBeDefined();
				expect(database.chat.listSessions().items.map((session) => session.id)).toEqual([
					second.id,
				]);
				expect(
					database.chat.listSessions({ archived: true }).items.map((session) => session.id),
				).toEqual([first.id]);

				const restored = database.chat.setSessionArchived({
					sessionId: first.id,
					archived: false,
				}).session;
				expect(restored.archivedAt).toBeUndefined();

				database.chat.deleteSession({ sessionId: second.id });
				expect(() => database.chat.getSession({ sessionId: second.id })).toThrow(
					`Chat session ${second.id} was not found.`,
				);
			} finally {
				database.close();
			}
		});
	});

	test("assigns strict message and event sequences per session and run", () => {
		withTempDatabase((databasePath) => {
			const database = openAppDatabase(databasePath);

			try {
				const { session } = database.chat.createSession({ title: "POC chat" });
				const firstRun = database.chat.createUserMessageRun({
					sessionId: session.id,
					content: "Hello",
					mode: "ask",
					provider: makeProviderInput(),
				});

				const running = database.chat.updateRunStatus({
					runId: firstRun.run.id,
					status: "running",
				});
				const assistantMessage = database.chat.createAssistantMessage({
					runId: firstRun.run.id,
				});
				const firstDelta = database.chat.appendAssistantMessageDelta({
					runId: firstRun.run.id,
					messageId: assistantMessage.message.id,
					delta: "Hi",
				});
				const completedMessage = database.chat.completeAssistantMessage({
					runId: firstRun.run.id,
					messageId: assistantMessage.message.id,
					content: "Hi there",
				});
				const completedRun = database.chat.updateRunStatus({
					runId: firstRun.run.id,
					status: "completed",
				});
				const eventCountBeforeTerminalCancel = database.chat.replayRunEvents({
					runId: firstRun.run.id,
				}).length;
				const terminalCancel = database.chat.cancelRun({
					runId: firstRun.run.id,
					reason: "Late stop click",
				});
				const secondRun = database.chat.createUserMessageRun({
					sessionId: session.id,
					content: "Second turn",
					mode: "plan",
					provider: makeProviderInput(),
				});

				const messages = database.chat.listMessages({ sessionId: session.id });
				const events = database.chat.replayRunEvents({ runId: firstRun.run.id });
				const snapshot = database.chat.getSessionSnapshot({ sessionId: session.id });

				expect(messages.map((message) => message.sequence)).toEqual([1, 2, 3]);
				expect(firstRun.userMessage.sequence).toBe(1);
				expect(assistantMessage.message.sequence).toBe(2);
				expect(secondRun.userMessage.sequence).toBe(3);

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
				expect(firstDelta.event.seq).toBe(4);
				expect(completedMessage.message.status).toBe("complete");
				expect(completedRun.run.status).toBe("completed");
				expect(terminalCancel.run.status).toBe("completed");
				expect(database.chat.replayRunEvents({ runId: firstRun.run.id })).toHaveLength(
					eventCountBeforeTerminalCancel,
				);
				expect(snapshot.eventCursors).toEqual([
					{ runId: secondRun.run.id, lastSeq: 1 },
					{ runId: firstRun.run.id, lastSeq: 6 },
				]);
			} finally {
				database.close();
			}
		});
	});

	test("restores persisted streaming history after reopening the database", () => {
		withTempDatabase((databasePath) => {
			{
				const database = openAppDatabase(databasePath);

				try {
					const { session } = database.chat.createSession({ title: "Recovery" });
					const sendResult = database.chat.createUserMessageRun({
						sessionId: session.id,
						content: "Tell me something",
						mode: "ask",
						provider: makeProviderInput(),
					});

					database.chat.updateRunStatus({
						runId: sendResult.run.id,
						status: "running",
					});

					const assistantMessage = database.chat.createAssistantMessage({
						runId: sendResult.run.id,
					});

					database.chat.appendAssistantMessageDelta({
						runId: sendResult.run.id,
						messageId: assistantMessage.message.id,
						delta: "Hello",
					});
					database.chat.appendAssistantMessageDelta({
						runId: sendResult.run.id,
						messageId: assistantMessage.message.id,
						delta: " world",
					});
				} finally {
					database.close();
				}
			}

			{
				const database = openAppDatabase(databasePath);

				try {
					const listedSessions = database.chat.listSessions();
					const listedSession = listedSessions.items[0];
					if (listedSession === undefined) {
						throw new Error("Expected a persisted session.");
					}

					const recoveredSession = database.chat.getSession({
						sessionId: listedSession.id,
					});
					const recoveredRun = recoveredSession.runs[0];
					if (recoveredRun === undefined) {
						throw new Error("Expected a persisted run.");
					}

					const recoveredAssistant = findAssistantMessage(recoveredSession.messages);
					const replayedEvents = database.chat.replayRunEvents({ runId: recoveredRun.id });
					const reconstructedContent = replayedEvents.reduce((content, event) => {
						if (event.type === "message.delta") {
							return `${content}${event.payload.delta}`;
						}

						if (event.type === "message.completed") {
							return event.payload.content;
						}

						return content;
					}, "");

					expect(recoveredAssistant.status).toBe("streaming");
					expect(recoveredAssistant.content).toBe("Hello world");
					expect(reconstructedContent).toBe("Hello world");
				} finally {
					database.close();
				}
			}
		});
	});

	test("never persists or returns provider api keys", () => {
		withTempDatabase((databasePath) => {
			const secret = "sk-live-never-store-this";
			const database = openAppDatabase(databasePath);

			try {
				const { session } = database.chat.createSession({ title: "Provider secrecy" });
				const sendResult = database.chat.createUserMessageRun({
					sessionId: session.id,
					content: "Secret safety",
					mode: "ask",
					provider: {
						...makeProviderInput(),
						apiKey: secret,
					},
				});
				const loaded = database.chat.getSession({ sessionId: session.id });
				const loadedRun = loaded.runs[0];
				if (loadedRun === undefined) {
					throw new Error("Expected a persisted run.");
				}

				expect("apiKey" in sendResult.run.provider).toBe(false);
				expect("apiKey" in loadedRun.provider).toBe(false);
			} finally {
				database.close();
			}

			for (const candidatePath of [databasePath, `${databasePath}-wal`, `${databasePath}-shm`]) {
				if (!existsSync(candidatePath)) {
					continue;
				}

				expect(readFileSync(candidatePath).includes(Buffer.from(secret))).toBe(false);
			}
		});
	});

	test("rejects invalid inputs and illegal state transitions", () => {
		withTempDatabase((databasePath) => {
			const database = openAppDatabase(databasePath);

			try {
				expect(() => database.chat.createSession({ title: "", defaultMode: "ask" })).toThrow();

				const { session } = database.chat.createSession({ title: "Validation" });
				const sendResult = database.chat.createUserMessageRun({
					sessionId: session.id,
					content: "Check state",
					mode: "ask",
					provider: makeProviderInput(),
				});

				expect(() =>
					database.chat.createAssistantMessage({
						runId: sendResult.run.id,
						source: { kind: "user" },
					}),
				).toThrow();
				expect(() =>
					database.chat.updateRunStatus({
						runId: sendResult.run.id,
						status: "queued",
					}),
				).toThrow();
			} finally {
				database.close();
			}
		});
	});

	test("fails runs transactionally with assistant completion and error events", () => {
		withTempDatabase((databasePath) => {
			const database = openAppDatabase(databasePath);

			try {
				const { session } = database.chat.createSession({ title: "Failure path" });
				const sendResult = database.chat.createUserMessageRun({
					sessionId: session.id,
					content: "Trigger failure",
					mode: "agent",
					provider: makeProviderInput(),
				});

				database.chat.updateRunStatus({
					runId: sendResult.run.id,
					status: "running",
				});
				const assistantMessage = database.chat.createAssistantMessage({
					runId: sendResult.run.id,
				});
				database.chat.appendAssistantMessageDelta({
					runId: sendResult.run.id,
					messageId: assistantMessage.message.id,
					delta: "Partial",
				});

				const failedRun = database.chat.failRun({
					runId: sendResult.run.id,
					messageId: assistantMessage.message.id,
					content: "Partial answer",
					error: makeAppError("PROVIDER_DOWN"),
				});

				expect(failedRun.run.status).toBe("failed");
				expect(failedRun.message?.status).toBe("failed");
				expect(failedRun.events.map((event) => event.type)).toEqual([
					"message.completed",
					"run.error",
					"run.status",
				]);
			} finally {
				database.close();
			}
		});
	});

	test("persists cancellation for the assistant message and run", () => {
		withTempDatabase((databasePath) => {
			const database = openAppDatabase(databasePath);

			try {
				const { session } = database.chat.createSession({ title: "Cancellation" });
				const sendResult = database.chat.createUserMessageRun({
					sessionId: session.id,
					content: "Stop this response",
					mode: "ask",
					provider: makeProviderInput(),
				});
				database.chat.updateRunStatus({
					runId: sendResult.run.id,
					status: "running",
				});
				const assistant = database.chat.createAssistantMessage({
					runId: sendResult.run.id,
				});
				database.chat.appendAssistantMessageDelta({
					runId: sendResult.run.id,
					messageId: assistant.message.id,
					delta: "Partial",
				});
				database.chat.cancelRun({
					runId: sendResult.run.id,
					reason: "User stopped the response.",
				});
				const cancelledMessage = database.chat.cancelAssistantMessage({
					runId: sendResult.run.id,
					messageId: assistant.message.id,
				});
				const cancelledRun = database.chat.updateRunStatus({
					runId: sendResult.run.id,
					status: "cancelled",
				});

				const restored = database.chat.getSession({ sessionId: session.id });
				expect(cancelledMessage.message.status).toBe("cancelled");
				expect(cancelledMessage.message.content).toBe("Partial");
				expect(cancelledRun.run.status).toBe("cancelled");
				expect(findAssistantMessage(restored.messages).status).toBe("cancelled");
			} finally {
				database.close();
			}
		});
	});
});
