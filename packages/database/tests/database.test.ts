import Database from "bun:sqlite";
import { describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { type AppError, retiredSessionTombstoneTtlMs } from "@moshu/contracts";

import {
	applyAppMigrations,
	chatRunsTable,
	coordinatedDatabaseResetReason,
	createUuidV7,
	currentAppDatabaseVersion,
	getDatabaseUserVersion,
	maxAgentSessionCleanupJobs,
	maxRetiredSessionTombstones,
	maxSessionCreateIdempotencyRecords,
	openAppDatabase,
	prepareCoordinatedDatabaseReset,
	SqliteRunJournalRepository,
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
	void secret;
	return {
		schemaVersion: 1 as const,
		providerId: createUuidV7(),
		name: "OpenAI",
		source: "custom" as const,
		api: "openai-responses",
		model: "gpt-5.4",
		thinkingLevel: "medium" as const,
	};
}

function makeProviderState() {
	return {
		schemaVersion: 1 as const,
		providerId: createUuidV7(),
		name: "OpenAI",
		source: "custom" as const,
		api: "openai-responses",
		model: "gpt-5.4",
		status: "ready" as const,
	};
}

function makeSessionCreateRequest(createKey = crypto.randomUUID(), title = "New chat") {
	return {
		schemaVersion: 1 as const,
		createKey,
		title,
		defaultMode: "ask" as const,
	};
}

function makeClientOrigin(instanceId = "desktop-instance-1") {
	return {
		role: "client" as const,
		peerId: "moshu-desktop-client",
		instanceId,
		generation: 1,
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
		clientRequestId: crypto.randomUUID(),
		sessionId,
		mode: "ask",
		provider: makeProviderInput(),
		userMessageId: createUuidV7(),
		userContent: "Test prompt",
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
				expect(tableNames).toEqual([
					"chat_run_events",
					"chat_runs",
					"chat_session_create_requests",
					"chat_sessions",
				]);
				expect(getDatabaseUserVersion(database.client)).toBe(currentAppDatabaseVersion);
				applyAppMigrations(database.client);
				expect(getDatabaseUserVersion(database.client)).toBe(currentAppDatabaseVersion);
			} finally {
				database.close();
			}
		});
	});

	test("resets an obsolete product database and its SQLite sidecars", () => {
		withTempDatabase((databasePath) => {
			const legacy = new Database(databasePath);
			legacy.exec("CREATE TABLE legacy_data (value TEXT); PRAGMA user_version = 6;");
			legacy.close();
			writeFileSync(`${databasePath}-wal`, "");
			writeFileSync(`${databasePath}-shm`, "");

			const result = prepareCoordinatedDatabaseReset({ productDatabase: databasePath });
			expect(result).toEqual({
				reset: true,
				reason: coordinatedDatabaseResetReason,
				previousProductVersion: 6,
			});
			expect(existsSync(databasePath)).toBe(false);
			expect(existsSync(`${databasePath}-wal`)).toBe(false);
			expect(existsSync(`${databasePath}-shm`)).toBe(false);

			const reopened = openAppDatabase(databasePath);
			try {
				expect(getDatabaseUserVersion(reopened.client)).toBe(currentAppDatabaseVersion);
			} finally {
				reopened.close();
			}
		});
	});

	test("does not reset a current product database", () => {
		withTempDatabase((databasePath) => {
			const database = openAppDatabase(databasePath);
			database.sessions.create({ title: "keep me" });
			database.close();

			expect(prepareCoordinatedDatabaseReset({ productDatabase: databasePath })).toEqual({
				reset: false,
			});
			const reopened = openAppDatabase(databasePath);
			try {
				expect(reopened.sessions.list().items).toHaveLength(1);
			} finally {
				reopened.close();
			}
		});
	});

	test("accepts an absent product database and rejects symbolic database paths", () => {
		withTempDatabase((databasePath) => {
			expect(prepareCoordinatedDatabaseReset({ productDatabase: databasePath })).toEqual({
				reset: false,
			});
			const targetPath = `${databasePath}.target`;
			writeFileSync(targetPath, "target");
			symlinkSync(targetPath, databasePath);
			expect(() => prepareCoordinatedDatabaseReset({ productDatabase: databasePath })).toThrow(
				"regular file",
			);
			expect(readFileSync(targetPath, "utf8")).toBe("target");
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
							clientRequestId: crypto.randomUUID(),
							sessionId: createUuidV7(),
							mode: "ask",
							status: "queued",
							providerJson: JSON.stringify(makeProviderState()),
							userMessageId: createUuidV7(),
							userContent: "Foreign key prompt",
							assistantMessageId: createUuidV7(),
							assistantContent: null,
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
				expect(first.defaultMode).toBe("agent");
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

	test("durably returns one Session for the same client and create key across restart", () => {
		withTempDatabase((databasePath) => {
			const request = makeSessionCreateRequest();
			const origin = makeClientOrigin();
			const firstDatabase = openAppDatabase(databasePath);
			const first = firstDatabase.sessions.createIdempotently({ request, origin });
			const concurrentRetry = firstDatabase.sessions.createIdempotently({ request, origin });
			expect(concurrentRetry).toEqual(first);
			expect(firstDatabase.sessions.list().items).toHaveLength(1);
			firstDatabase.close();

			const restartedDatabase = openAppDatabase(databasePath);
			try {
				expect(restartedDatabase.sessions.createIdempotently({ request, origin })).toEqual(first);
				expect(restartedDatabase.sessions.list().items).toHaveLength(1);
			} finally {
				restartedDatabase.close();
			}
		});
	});

	test("rejects create-key origin and parameter conflicts", () => {
		const database = openAppDatabase(":memory:");
		try {
			const request = makeSessionCreateRequest();
			database.sessions.createIdempotently({ request, origin: makeClientOrigin() });

			expect(() =>
				database.sessions.createIdempotently({
					request,
					origin: makeClientOrigin("other-desktop-instance"),
				}),
			).toThrow("different origin or parameters");
			expect(() =>
				database.sessions.createIdempotently({
					request: makeSessionCreateRequest(request.createKey, "Different title"),
					origin: makeClientOrigin(),
				}),
			).toThrow("different origin or parameters");
			expect(database.sessions.list().items).toHaveLength(1);
		} finally {
			database.close();
		}
	});

	test("bounds durable create-key capacity and frees it when its Session is deleted", () => {
		const database = openAppDatabase(":memory:");
		try {
			database.client
				.query(
					`WITH RECURSIVE fixture(value) AS (
						SELECT 1
						UNION ALL
						SELECT value + 1 FROM fixture WHERE value < $count
					)
					INSERT INTO chat_sessions (
						id, pi_session_id, title, default_mode, created_at_ms, updated_at_ms,
						last_message_at_ms, archived_at_ms
					)
					SELECT
						printf('00000000-0000-7000-8000-%012x', value),
						printf('00000000-0000-7000-8000-%012x', value),
						'capacity fixture',
						'ask',
						value,
						value,
						NULL,
						NULL
					FROM fixture`,
				)
				.run({ count: maxSessionCreateIdempotencyRecords });
			database.client
				.query(
					`WITH RECURSIVE fixture(value) AS (
						SELECT 1
						UNION ALL
						SELECT value + 1 FROM fixture WHERE value < $count
					)
					INSERT INTO chat_session_create_requests (
						create_key, origin_role, origin_peer_id, origin_instance_id,
						origin_generation, title, default_mode, session_id, created_at_ms
					)
					SELECT
						printf('capacity-key-%d', value),
						'client',
						'capacity-client',
						'capacity-instance',
						1,
						'capacity fixture',
						'ask',
						printf('00000000-0000-7000-8000-%012x', value),
						value
					FROM fixture`,
				)
				.run({ count: maxSessionCreateIdempotencyRecords });

			expect(() =>
				database.sessions.createIdempotently({
					request: makeSessionCreateRequest(),
					origin: makeClientOrigin(),
				}),
			).toThrow("capacity is full");

			database.sessions.delete({
				sessionId: "00000000-0000-7000-8000-000000000001",
			});
			expect(
				database.sessions.createIdempotently({
					request: makeSessionCreateRequest(),
					origin: makeClientOrigin(),
				}).session.id,
			).toBeDefined();
		} finally {
			database.close();
		}
	});

	test("journals run status and UI delivery events without message rows", () => {
		withTempDatabase((databasePath) => {
			const database = openAppDatabase(databasePath);
			try {
				const session = database.sessions.create({ title: "Run journal" }).session;
				const created = createRun(database, session.id);
				const assistantMessageId = getAssistantMessageId(created.run);
				const running = database.runs.updateStatus({ runId: created.run.id, status: "running" });
				const started = database.runs
					.listEvents({ runId: created.run.id })
					.find((event) => event.type === "message.started");
				const delta = database.runs.appendEvent({
					runId: created.run.id,
					type: "message.delta",
					source: { kind: "assistant" },
					payload: { messageId: assistantMessageId, delta: "Hello" },
				});
				const completed = database.runs.commitTerminal({
					runId: created.run.id,
					message: {
						messageId: assistantMessageId,
						status: "complete",
						content: "Hello",
					},
				});

				const events = database.runs.listEvents({ runId: created.run.id });
				expect(events.map((event) => event.seq)).toEqual([1, 2, 3, 4, 5, 6]);
				expect(events.map((event) => event.type)).toEqual([
					"run.status",
					"message.started",
					"run.status",
					"message.delta",
					"message.completed",
					"run.status",
				]);
				expect(running.run.status).toBe("running");
				expect(started?.seq).toBe(2);
				expect(delta.seq).toBe(4);
				expect(completed.run.status).toBe("completed");
				expect(database.runs.listBySession(session.id)).toHaveLength(1);
				expect(database.runs.cancel({ runId: created.run.id }).run.status).toBe("completed");
				const pageItem = database.runs.listPageBySession({
					sessionId: session.id,
					limit: 1,
				}).items[0];
				expect(pageItem?.events).toEqual([]);
				expect(pageItem?.assistantContent).toBe("Hello");
				expect(pageItem?.lastEventSeq).toBe(6);
			} finally {
				database.close();
			}
		});
	});

	test("pages run journals with a stable cursor and no duplicate event queries", () => {
		withTempDatabase((databasePath) => {
			const database = openAppDatabase(databasePath);
			try {
				const session = database.sessions.create({ title: "Cursor history" }).session;
				for (let index = 0; index < 5; index += 1) {
					database.runs.create({
						clientRequestId: crypto.randomUUID(),
						sessionId: session.id,
						mode: "ask",
						provider: makeProviderInput(),
						userMessageId: createUuidV7(),
						userContent: `prompt-${index}`,
						assistantMessageId: createUuidV7(),
					});
				}
				const ids: string[] = [];
				const prompts: string[] = [];
				let after:
					| {
							createdAtMs: number;
							id: string;
					  }
					| undefined;
				do {
					const page = database.runs.listPageBySession({
						sessionId: session.id,
						...(after === undefined ? {} : { after }),
						limit: 2,
					});
					ids.push(...page.items.map((item) => item.run.id));
					prompts.push(...page.items.map((item) => item.userContent));
					expect(page.items.every((item) => item.events.length === 2)).toBe(true);
					after = page.nextCursor;
				} while (after !== undefined);

				expect(new Set(ids).size).toBe(5);
				expect(ids).toEqual(
					database.runs
						.listBySession(session.id)
						.reverse()
						.map((run) => run.id),
				);
				expect(prompts).toEqual(["prompt-0", "prompt-1", "prompt-2", "prompt-3", "prompt-4"]);
				const plan = database.client
					.query<{ detail: string }, [string, number, string]>(
						`EXPLAIN QUERY PLAN
						 SELECT id
						 FROM chat_runs
						 WHERE session_id = ?
						   AND (created_at_ms, id) > (?, ?)
						 ORDER BY created_at_ms, id
						 LIMIT 2`,
					)
					.all(session.id, 0, "00000000-0000-7000-8000-000000000000")
					.map((row) => row.detail)
					.join("\n");
				expect(plan).toContain("chat_runs_session_cursor_idx");
				expect(plan).toContain("(created_at_ms,id)>(?,?)");
			} finally {
				database.close();
			}
		});
	});

	test("pages a 100k-row event fixture with an indexed bounded query and forward progress", () => {
		withTempDatabase((databasePath) => {
			const database = openAppDatabase(databasePath);
			try {
				const session = database.sessions.create({ title: "Large event journal" }).session;
				const created = createRun(database, session.id);
				const assistantMessageId = getAssistantMessageId(created.run);
				database.runs.updateStatus({ runId: created.run.id, status: "running" });
				const eventCount = 100_000;
				const firstSeq = 4;
				const lastSeq = firstSeq + eventCount - 1;
				database.client
					.query(
						`WITH RECURSIVE fixture(seq) AS (
							SELECT $firstSeq
							UNION ALL
							SELECT seq + 1 FROM fixture WHERE seq < $lastSeq
						)
						INSERT INTO chat_run_events (
							id, run_id, session_id, seq, type, source_kind, source_id, visibility,
							payload_json, created_at_ms
						)
						SELECT
							printf('00000000-0000-7000-8000-%012x', seq),
							$runId,
							$sessionId,
							seq,
							'message.delta',
							'assistant',
							NULL,
							'user',
							$payloadJson,
							$createdAtMs
						FROM fixture`,
					)
					.run({
						firstSeq,
						lastSeq,
						runId: created.run.id,
						sessionId: session.id,
						payloadJson: JSON.stringify({ messageId: assistantMessageId, delta: "x" }),
						createdAtMs: Date.now(),
					});

				const firstPage = database.runs.listEventPage({
					runId: created.run.id,
					afterSeq: 3,
					limit: 6,
				});
				expect(firstPage.events.map((event) => event.seq)).toEqual([4, 5, 6, 7, 8, 9]);
				expect(firstPage.hasMore).toBe(true);

				let afterSeq = 3;
				let materialized = 0;
				const startedAt = performance.now();
				while (true) {
					const page = database.runs.listEventPage({
						runId: created.run.id,
						afterSeq,
						limit: 997,
					});
					expect(page.events.length).toBeLessThanOrEqual(997);
					expect(page.events[0]?.seq).toBe(afterSeq + 1);
					materialized += page.events.length;
					const nextSeq = page.events.at(-1)?.seq;
					expect(nextSeq).toBeGreaterThan(afterSeq);
					afterSeq = nextSeq ?? afterSeq;
					if (!page.hasMore) {
						break;
					}
				}
				expect(materialized).toBe(eventCount);
				expect(afterSeq).toBe(lastSeq);
				expect(performance.now() - startedAt).toBeLessThan(10_000);

				const plan = database.client
					.query<{ detail: string }, [string, number]>(
						`EXPLAIN QUERY PLAN
						 SELECT *
						 FROM chat_run_events
						 WHERE run_id = ? AND seq > ?
						 ORDER BY seq
						 LIMIT 7`,
					)
					.all(created.run.id, 3)
					.map((row) => row.detail)
					.join("\n");
				expect(plan).toContain("chat_run_events_run_seq");
				expect(plan).toContain("(run_id=? AND seq>?)");
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
				const failedPageItem = database.runs
					.listPageBySession({ sessionId: session.id, limit: 1 })
					.items.find((item) => item.run.id === failed.run.id);
				expect(failedPageItem?.assistantContent).toBe("Partial");
				expect(failedPageItem?.events).toEqual([]);

				const cancelled = createRun(database, session.id);
				database.runs.updateStatus({ runId: cancelled.run.id, status: "running" });
				expect(database.runs.cancel({ runId: cancelled.run.id }).run.status).toBe("cancelling");
				expect(
					database.runs.commitTerminal({
						runId: cancelled.run.id,
						message: {
							messageId: getAssistantMessageId(cancelled.run),
							status: "cancelled",
							content: "",
						},
					}).run.status,
				).toBe("cancelled");
			} finally {
				database.close();
			}
		});
	});

	test("atomically aligns and idempotently commits every terminal message status", () => {
		withTempDatabase((databasePath) => {
			const database = openAppDatabase(databasePath);
			try {
				const session = database.sessions.create({ title: "Terminal commit recovery" }).session;
				for (const scenario of [
					{ messageStatus: "complete" as const, runStatus: "completed" as const },
					{ messageStatus: "cancelled" as const, runStatus: "cancelled" as const },
					{ messageStatus: "failed" as const, runStatus: "failed" as const },
				]) {
					const created = createRun(database, session.id);
					const messageId = getAssistantMessageId(created.run);
					database.runs.updateStatus({ runId: created.run.id, status: "running" });
					const error =
						scenario.messageStatus === "failed" ? makeAppError("CRASH_WINDOW") : undefined;
					database.runs.appendEvent({
						runId: created.run.id,
						type: "message.completed",
						source: { kind: "assistant" },
						payload:
							scenario.messageStatus === "failed"
								? {
										messageId,
										status: "failed",
										content: "partial",
										error: error ?? makeAppError("CRASH_WINDOW"),
									}
								: {
										messageId,
										status: scenario.messageStatus,
										content: scenario.messageStatus === "complete" ? "answer" : "partial",
									},
					});

					const committed = database.runs.commitTerminal({
						runId: created.run.id,
						message: { messageId, status: "cancelled", content: "fallback" },
					});
					expect(committed.run.status).toBe(scenario.runStatus);
					expect(
						database.runs
							.listEvents({ runId: created.run.id })
							.filter((event) => event.type === "message.completed"),
					).toHaveLength(1);
					const eventCount = database.runs.listEvents({ runId: created.run.id }).length;
					const repeated = database.runs.commitTerminal({
						runId: created.run.id,
						message: { messageId, status: "cancelled", content: "fallback" },
					});
					expect(repeated.committed).toBe(false);
					expect(repeated.events).toEqual([]);
					expect(database.runs.listEvents({ runId: created.run.id })).toHaveLength(eventCount);
				}
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
					clientRequestId: crypto.randomUUID(),
					sessionId: session.id,
					mode: "ask",
					provider: makeProviderInput(secret),
					userMessageId: createUuidV7(),
					userContent: "Secret safety prompt",
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

	test("never persists provider custom header values", () => {
		withTempDatabase((databasePath) => {
			const headerSecret = "acme-secret-header-value";
			const database = openAppDatabase(databasePath);
			try {
				const session = database.sessions.create({ title: "Header secrecy" }).session;
				const created = database.runs.create({
					clientRequestId: crypto.randomUUID(),
					sessionId: session.id,
					mode: "ask",
					provider: makeProviderInput(),
					userMessageId: createUuidV7(),
					userContent: "Header safety prompt",
					assistantMessageId: createUuidV7(),
				});
				expect("customHeaders" in created.run.provider).toBe(false);
				expect(created.run.provider.source).toBe("custom");
				expect(created.run.provider.api).toBe("openai-responses");
				expect(created.run.provider.thinkingLevel).toBe("medium");
				expect(JSON.stringify(created.run)).not.toContain(headerSecret);
			} finally {
				database.close();
			}

			for (const path of [databasePath, `${databasePath}-wal`, `${databasePath}-shm`]) {
				if (existsSync(path)) {
					expect(readFileSync(path).includes(Buffer.from(headerSecret))).toBe(false);
				}
			}
		});
	});

	test("stores and clears the Session model selection", () => {
		const database = openAppDatabase(":memory:");
		try {
			const providerId = createUuidV7();
			const created = database.sessions.create({ title: "Model selection" }).session;
			expect(created.model).toBeUndefined();

			const withThinking = database.sessions.setModel({
				sessionId: created.id,
				model: { providerId, modelId: "gpt-5.5", thinkingLevel: "high" },
			}).session;
			expect(withThinking.model).toEqual({
				providerId,
				modelId: "gpt-5.5",
				thinkingLevel: "high",
			});

			const withMinimalThinking = database.sessions.setModel({
				sessionId: created.id,
				model: {
					providerId,
					modelId: "claude-opus-4.6",
					thinkingLevel: "minimal",
				},
			}).session;
			expect(withMinimalThinking.model?.thinkingLevel).toBe("minimal");

			const cleared = database.sessions.setModel({ sessionId: created.id, model: null }).session;
			expect(cleared.model).toBeUndefined();
			expect(database.sessions.get({ sessionId: created.id }).model).toBeUndefined();
		} finally {
			database.close();
		}
	});

	test("keeps the model selection supplied at Session creation", () => {
		const database = openAppDatabase(":memory:");
		try {
			const providerId = createUuidV7();
			const created = database.sessions.create({
				title: "Inherited default",
				model: { providerId, modelId: "gpt-5.4" },
			}).session;

			expect(database.sessions.get({ sessionId: created.id }).model).toEqual({
				providerId,
				modelId: "gpt-5.4",
			});
		} finally {
			database.close();
		}
	});

	test("deletes one Session with 10,001 Runs using one retirement tombstone", () => {
		const database = openAppDatabase(":memory:");
		try {
			const session = database.sessions.create({ title: "Large history" }).session;
			database.client
				.query(
					`WITH RECURSIVE fixture(value) AS (
						SELECT 1
						UNION ALL
						SELECT value + 1 FROM fixture WHERE value < 10001
					)
					INSERT INTO chat_runs (
						id, client_request_id, session_id, mode, status, provider_json,
						user_message_id, user_content, assistant_message_id, assistant_content,
						last_error_json, created_at_ms, updated_at_ms, completed_at_ms
					)
					SELECT
						printf('00000000-0000-7000-8000-%012x', value),
						printf('request-%d', value),
						$sessionId,
						'ask',
						'completed',
						'{}',
						printf('10000000-0000-7000-8000-%012x', value),
						'prompt',
						printf('20000000-0000-7000-8000-%012x', value),
						'answer',
						NULL,
						value,
						value,
						value
					FROM fixture`,
				)
				.run({ sessionId: session.id });

			expect(database.runs.deleteSessionAndRetireRuns(session.id)).toEqual({
				sessionId: session.id,
			});
			expect(
				database.client
					.query<{ count: number }, []>("SELECT count(*) AS count FROM retired_chat_sessions")
					.get()?.count,
			).toBe(1);
			expect(database.runs.isSessionRetired(session.id)).toBe(true);
		} finally {
			database.close();
		}
	});

	test("backpressures unexpired retired Sessions and prunes only at the TTL boundary", () => {
		const database = openAppDatabase(":memory:");
		let nowMs = retiredSessionTombstoneTtlMs;
		const runs = new SqliteRunJournalRepository(
			database.client,
			database.orm,
			{ create: createUuidV7 },
			{ now: () => nowMs },
		);
		try {
			database.client
				.query(
					`WITH RECURSIVE fixture(value) AS (
						SELECT 1
						UNION ALL
						SELECT value + 1 FROM fixture WHERE value < $count
					)
					INSERT INTO retired_chat_sessions (session_id, retired_at_ms)
					SELECT printf('00000000-0000-7000-8000-%012x', value), $retiredAtMs FROM fixture`,
				)
				.run({ count: maxRetiredSessionTombstones, retiredAtMs: nowMs });
			const session = database.sessions.create({ title: "Capacity boundary" }).session;

			expect(() => runs.deleteSessionAndRetireRuns(session.id)).toThrow(
				"recovery capacity is full",
			);
			expect(database.sessions.get({ sessionId: session.id }).id).toBe(session.id);
			expect(
				database.client
					.query<{ count: number }, []>("SELECT count(*) AS count FROM retired_chat_sessions")
					.get()?.count,
			).toBe(maxRetiredSessionTombstones);

			nowMs += retiredSessionTombstoneTtlMs - 1;
			expect(() => runs.deleteSessionAndRetireRuns(session.id)).toThrow(
				"recovery capacity is full",
			);
			nowMs += 1;
			expect(runs.deleteSessionAndRetireRuns(session.id)).toEqual({ sessionId: session.id });
			expect(runs.isSessionRetired("00000000-0000-7000-8000-000000000001")).toBe(false);
			expect(runs.isSessionRetired(session.id)).toBe(true);
		} finally {
			database.close();
		}
	});

	test("writes agent-session cleanup jobs atomically and acknowledges them idempotently", () => {
		const database = openAppDatabase(":memory:");
		try {
			const session = database.sessions.create({ title: "Crash durable cleanup" }).session;
			database.runs.deleteSessionAndRetireRuns(session.id);

			expect(database.sessions.list().items).toEqual([]);
			expect(database.runs.listPendingAgentSessionCleanups(10, true)).toEqual([
				expect.objectContaining({ sessionId: session.id, attemptCount: 0 }),
			]);
			database.runs.ackAgentSessionCleanup(session.id);
			database.runs.ackAgentSessionCleanup(session.id);
			expect(database.runs.listPendingAgentSessionCleanups(10, true)).toEqual([]);
		} finally {
			database.close();
		}
	});

	test("keeps Session deletion idempotent across a database restart without duplicating recovery rows", () => {
		withTempDatabase((databasePath) => {
			const first = openAppDatabase(databasePath);
			const session = first.sessions.create({ title: "Restarted delete retry" }).session;
			expect(first.runs.deleteSessionAndRetireRuns(session.id)).toEqual({
				sessionId: session.id,
			});
			first.close();

			const reopened = openAppDatabase(databasePath);
			try {
				expect(reopened.runs.deleteSessionAndRetireRuns(session.id)).toEqual({
					sessionId: session.id,
				});
				expect(reopened.runs.listPendingAgentSessionCleanups(10, true)).toHaveLength(1);
				expect(
					reopened.client
						.query<{ count: number }, [string]>(
							"SELECT count(*) AS count FROM retired_chat_sessions WHERE session_id = ?",
						)
						.get(session.id)?.count,
				).toBe(1);
				expect(() => reopened.runs.deleteSessionAndRetireRuns(createUuidV7())).toThrow("not found");
			} finally {
				reopened.close();
			}
		});
	});

	test("backpressures Session deletion when the durable agent-session outbox is full", () => {
		const database = openAppDatabase(":memory:");
		try {
			database.client
				.query(
					`WITH RECURSIVE fixture(value) AS (
						SELECT 1
						UNION ALL
						SELECT value + 1 FROM fixture WHERE value < $count
					)
					INSERT INTO agent_session_cleanup_outbox (
						session_id, created_at_ms, attempt_count, next_attempt_at_ms
					)
					SELECT
						printf('00000000-0000-7000-8000-%012x', value),
						0,
						0,
						0
					FROM fixture`,
				)
				.run({ count: maxAgentSessionCleanupJobs });
			const session = database.sessions.create({ title: "Outbox capacity" }).session;

			expect(() => database.runs.deleteSessionAndRetireRuns(session.id)).toThrow(
				"Agent session cleanup recovery capacity is full",
			);
			expect(database.sessions.get({ sessionId: session.id }).id).toBe(session.id);
			database.runs.ackAgentSessionCleanup("00000000-0000-7000-8000-000000000001");
			expect(database.runs.deleteSessionAndRetireRuns(session.id).sessionId).toBe(session.id);
			expect(
				database.client
					.query<{ count: number }, []>(
						"SELECT count(*) AS count FROM agent_session_cleanup_outbox",
					)
					.get()?.count,
			).toBe(maxAgentSessionCleanupJobs);
		} finally {
			database.close();
		}
	});
});
