import { describe, expect, test } from "bun:test";

import {
	AskChatCancelledError,
	type AskChatMessage,
	type AskChatRunInput,
	type AskChatRunResult,
	type AskChatRunStream,
	type AskChatRuntime,
	AskChatRuntimeError,
	type AskProviderConfigStore,
	type AskProviderConfiguration,
	InMemoryAskProviderConfigStore,
} from "@moshu/agent-runtime";
import {
	type ChatRunEvent,
	maxAppErrorSafeMessageCharacters,
	maxAssistantMessageContentCharacters,
	maxReplayEventBytesPerPage,
	maxReplayEventsPerPage,
	retiredSessionTombstoneTtlMs,
} from "@moshu/contracts";
import {
	createUuidV7,
	openAppDatabase,
	type RunJournalRepository,
	type SessionRepository,
	SqliteRunJournalRepository,
} from "@moshu/database";
import { ZodError } from "zod";

import { ChatApplicationService } from "./chat-application-service";

describe("ChatApplicationService", () => {
	test("persists every streamed event before publishing it", async () => {
		const database = openAppDatabase(":memory:");
		const scheduler = new ManualScheduler();
		const runtime = new FakeAskChatRuntime({
			deltas: ["Hello", " world"],
		});

		const service = createService(database, runtime, scheduler);
		const publishedEvents: ChatRunEvent[] = [];

		try {
			configureProvider(service);
			const { session } = service.createSession();
			service.subscribe((event) => {
				const persistedIds = database.runs
					.listEvents({ runId: event.runId })
					.map((persistedEvent) => persistedEvent.id);
				expect(persistedIds).toContain(event.id);
				publishedEvents.push(event);
			});

			const accepted = service.sendMessage({
				sessionId: session.id,
				content: "Say hello",
			});

			expect(accepted.run.status).toBe("queued");
			expect(accepted.assistantMessage.status).toBe("streaming");
			scheduler.runAll();
			await service.waitForIdle();

			const restored = await service.getSession({ sessionId: session.id });
			expect(restored.session.title).toBe("Say hello");
			expect(restored.messages.map((message) => message.content)).toEqual([
				"Say hello",
				"Hello world",
			]);
			expect(restored.messages[1]?.status).toBe("complete");
			expect(restored.runs[0]?.status).toBe("completed");
			expect(runtime.inputs[0]?.threadId).toBe(session.id);
			expect(
				runtime.inputs[0]?.messages.map(({ role, content }) => ({
					role,
					content,
				})),
			).toEqual([{ role: "user", content: "Say hello" }]);
			expect(publishedEvents.map((event) => event.type)).toEqual([
				"run.status",
				"message.started",
				"run.status",
				"message.delta",
				"message.completed",
				"run.status",
			]);
			const eventCount = publishedEvents.length;
			expect(
				service.cancel({
					runId: accepted.run.id,
					reason: "Late stop click",
				}).run.status,
			).toBe("completed");
			expect(publishedEvents).toHaveLength(eventCount);
		} finally {
			await service.shutdown();
			database.close();
		}
	});

	test("publishes a complete persisted batch before synchronous reentrant cancellation", async () => {
		const database = openAppDatabase(":memory:");
		const service = createService(
			database,
			new FakeAskChatRuntime({ pending: true }),
			new ManualScheduler(),
		);
		const published: ChatRunEvent[] = [];

		try {
			configureProvider(service);
			const { session } = service.createSession();
			service.subscribe((event) => {
				published.push(event);
				if (
					event.type === "run.status" &&
					event.payload.status === "queued" &&
					published.length === 1
				) {
					service.cancel({ runId: event.runId, reason: "synchronous reentry" });
				}
			});

			const accepted = service.sendMessage({
				sessionId: session.id,
				content: "cancel in listener",
			});
			expect(database.runs.get(accepted.run.id).status).toBe("cancelled");
			expect(published.map((event) => event.seq)).toEqual([1, 2, 3, 4]);
			expect(published.map((event) => event.type)).toEqual([
				"run.status",
				"message.started",
				"message.completed",
				"run.status",
			]);
		} finally {
			await service.shutdown();
			database.close();
		}
	});

	test("keeps asynchronous reentrant cancellation behind the current publication batch", async () => {
		const database = openAppDatabase(":memory:");
		const service = createService(
			database,
			new FakeAskChatRuntime({ pending: true }),
			new ManualScheduler(),
		);
		const published: ChatRunEvent[] = [];
		let cancellation: Promise<void> | undefined;

		try {
			configureProvider(service);
			const { session } = service.createSession();
			service.subscribe((event) => {
				published.push(event);
				if (event.type === "run.status" && event.payload.status === "queued") {
					cancellation = Promise.resolve().then(() => {
						service.cancel({ runId: event.runId, reason: "asynchronous reentry" });
					});
					return cancellation;
				}
			});

			const accepted = service.sendMessage({ sessionId: session.id, content: "cancel soon" });
			await cancellation;
			expect(database.runs.get(accepted.run.id).status).toBe("cancelled");
			expect(published.map((event) => event.seq)).toEqual([1, 2, 3, 4]);
		} finally {
			await service.shutdown();
			database.close();
		}
	});

	test("contains listener failures without blocking ordered publication", async () => {
		const database = openAppDatabase(":memory:");
		const logged: unknown[] = [];
		const scheduler = new ManualScheduler();
		const service = createService(
			database,
			new FakeAskChatRuntime({ deltas: ["done"] }),
			scheduler,
			{
				logger: {
					error(_message, error) {
						logged.push(error);
					},
				},
			},
		);
		const delivered: ChatRunEvent[] = [];

		try {
			configureProvider(service);
			const { session } = service.createSession();
			service.subscribe(() => {
				throw new Error("synchronous listener failure");
			});
			service.subscribe(async () => {
				throw new Error("asynchronous listener failure");
			});
			service.subscribe((event) => {
				delivered.push(event);
			});
			const accepted = service.sendMessage({ sessionId: session.id, content: "still publish" });
			scheduler.runAll();
			await service.waitForIdle();
			await Promise.resolve();
			const persisted = database.runs.listEvents({ runId: accepted.run.id });
			expect(delivered.map((event) => event.seq)).toEqual(persisted.map((event) => event.seq));
			expect(logged.length).toBe(persisted.length * 2);
		} finally {
			await service.shutdown();
			database.close();
		}
	});

	test("preserves strict per-Run sequence order while Runs execute concurrently", async () => {
		const database = openAppDatabase(":memory:");
		const scheduler = new ManualScheduler();
		const service = createService(
			database,
			new FakeAskChatRuntime({ deltas: ["a", "b"] }),
			scheduler,
		);
		const published = new Map<string, number[]>();

		try {
			configureProvider(service);
			const firstSession = service.createSession().session;
			const secondSession = service.createSession().session;
			service.subscribe((event) => {
				const sequences = published.get(event.runId) ?? [];
				sequences.push(event.seq);
				published.set(event.runId, sequences);
			});
			const first = service.sendMessage({ sessionId: firstSession.id, content: "first" });
			const second = service.sendMessage({ sessionId: secondSession.id, content: "second" });

			scheduler.runAll();
			await service.waitForIdle();
			for (const runId of [first.run.id, second.run.id]) {
				const persisted = database.runs.listEvents({ runId }).map((event) => event.seq);
				expect(published.get(runId)).toEqual(persisted);
				expect(persisted).toEqual(persisted.map((_seq, index) => index + 1));
			}
		} finally {
			await service.shutdown();
			database.close();
		}
	});

	test("completes when many legal deltas reach the exact assistant output limit", async () => {
		const database = openAppDatabase(":memory:");
		const scheduler = new ManualScheduler();
		const runtime = new FakeAskChatRuntime({
			deltas: Array.from({ length: 25 }, () => "x".repeat(8_000)),
		});
		const service = createService(database, runtime, scheduler);

		try {
			configureProvider(service);
			const { session } = service.createSession();
			const accepted = service.sendMessage({ sessionId: session.id, content: "fill boundary" });
			scheduler.runAll();
			await service.waitForIdle();

			const snapshot = await service.getSession({ sessionId: session.id });
			expect(snapshot.runs[0]?.status).toBe("completed");
			expect(snapshot.messages.at(-1)?.content).toHaveLength(maxAssistantMessageContentCharacters);
			expect(
				database.runs
					.listEvents({ runId: accepted.run.id })
					.filter((event) => event.type === "message.delta"),
			).toHaveLength(25);
		} finally {
			await service.shutdown();
			database.close();
		}
	});

	test("aggregates 100k token-sized deltas into bounded durable chunks", async () => {
		const database = openAppDatabase(":memory:");
		const scheduler = new ManualScheduler();
		const runtime = new FakeAskChatRuntime({
			deltas: Array.from({ length: 100_000 }, () => "x"),
		});
		const service = createService(database, runtime, scheduler);

		try {
			configureProvider(service);
			const { session } = service.createSession();
			const accepted = service.sendMessage({ sessionId: session.id, content: "many tokens" });
			scheduler.runAll();
			await withDeadline(service.waitForIdle(), 10_000, "100k delta aggregation");

			const deltas = database.runs
				.listEvents({ runId: accepted.run.id })
				.filter((event) => event.type === "message.delta");
			expect(deltas).toHaveLength(13);
			expect(deltas.every((event) => event.payload.delta.length <= 8_000)).toBe(true);
			expect(deltas.map((event) => event.payload.delta).join("")).toHaveLength(100_000);
			expect(database.runs.get(accepted.run.id).status).toBe("completed");
		} finally {
			await service.shutdown();
			database.close();
		}
	});

	test("splits a large provider chunk into contract-bounded delta events", async () => {
		const database = openAppDatabase(":memory:");
		const scheduler = new ManualScheduler();
		const runtime = new FakeAskChatRuntime({ deltas: ["x".repeat(8_001), "y"] });
		const service = createService(database, runtime, scheduler);

		try {
			configureProvider(service);
			const { session } = service.createSession();
			const accepted = service.sendMessage({ sessionId: session.id, content: "large chunk" });
			scheduler.runAll();
			await service.waitForIdle();

			expect(database.runs.get(accepted.run.id).status).toBe("completed");
			expect(
				database.runs
					.listEvents({ runId: accepted.run.id })
					.filter((event) => event.type === "message.delta")
					.map((event) => (event.type === "message.delta" ? event.payload.delta.length : 0)),
			).toEqual([8_000, 2]);
		} finally {
			await service.shutdown();
			database.close();
		}
	});

	test("drops remaining split chunks after a synchronous cancellation listener", async () => {
		const database = openAppDatabase(":memory:");
		const scheduler = new ManualScheduler();
		const runtime = new FakeAskChatRuntime({ deltas: ["x".repeat(9_000), "late"] });
		const service = createService(database, runtime, scheduler);

		try {
			configureProvider(service);
			const { session } = service.createSession();
			const accepted = service.sendMessage({ sessionId: session.id, content: "cancel reentry" });
			let cancelled = false;
			service.subscribe((event) => {
				if (!cancelled && event.type === "message.delta") {
					cancelled = true;
					service.cancel({ runId: accepted.run.id, reason: "listener cancellation" });
				}
			});
			scheduler.runAll();
			await service.waitForIdle();

			const events = database.runs.listEvents({ runId: accepted.run.id });
			const terminalIndex = events.findIndex((event) => event.type === "message.completed");
			expect(events.slice(terminalIndex + 1).some((event) => event.type === "message.delta")).toBe(
				false,
			);
			expect(
				events
					.filter((event) => event.type === "message.delta")
					.map((event) => (event.type === "message.delta" ? event.payload.delta.length : 0)),
			).toEqual([8_000]);
			expect(database.runs.get(accepted.run.id).status).toBe("cancelled");
		} finally {
			await service.shutdown();
			database.close();
		}
	});

	test("flushes a small aggregate promptly and orders reentrant cancellation after it", async () => {
		const database = openAppDatabase(":memory:");
		const scheduler = new ManualScheduler();
		const runtime = new FakeAskChatRuntime({ deltas: ["a", "b"], pending: true });
		const service = createService(database, runtime, scheduler);
		const published: ChatRunEvent[] = [];

		try {
			configureProvider(service);
			const { session } = service.createSession();
			const accepted = service.sendMessage({ sessionId: session.id, content: "stream quickly" });
			const deltaPublished = new Promise<void>((resolve) => {
				service.subscribe((event) => {
					published.push(event);
					if (event.type === "message.delta") {
						service.cancel({ runId: accepted.run.id, reason: "reentrant stop" });
						resolve();
					}
				});
			});
			scheduler.runAll();
			await withDeadline(deltaPublished, 250, "streamed delta flush");
			await service.waitForIdle();

			const events = database.runs.listEvents({ runId: accepted.run.id });
			const deltaIndex = events.findIndex((event) => event.type === "message.delta");
			const terminalIndex = events.findIndex((event) => event.type === "message.completed");
			expect(events[deltaIndex]?.type === "message.delta" && events[deltaIndex].payload.delta).toBe(
				"ab",
			);
			expect(deltaIndex).toBeGreaterThan(-1);
			expect(terminalIndex).toBeGreaterThan(deltaIndex);
			expect(events.slice(terminalIndex + 1).some((event) => event.type === "message.delta")).toBe(
				false,
			);
			expect(published.findIndex((event) => event.type === "message.completed")).toBeGreaterThan(
				published.findIndex((event) => event.type === "message.delta"),
			);
			expect(database.runs.get(accepted.run.id).status).toBe("cancelled");
		} finally {
			await service.shutdown();
			database.close();
		}
	});

	test("forces a pending aggregate durable before an immediate cancellation terminal", async () => {
		const database = openAppDatabase(":memory:");
		const scheduler = new ManualScheduler();
		const runtime = new FakeAskChatRuntime({
			deltas: ["pending-before-cancel"],
			pending: true,
		});
		const service = createService(database, runtime, scheduler);

		try {
			configureProvider(service);
			const { session } = service.createSession();
			const accepted = service.sendMessage({ sessionId: session.id, content: "cancel now" });
			scheduler.runAll();
			await runtime.started;
			service.cancel({ runId: accepted.run.id, reason: "immediate stop" });
			await service.waitForIdle();

			const events = database.runs.listEvents({ runId: accepted.run.id });
			const deltaIndex = events.findIndex((event) => event.type === "message.delta");
			const terminalIndex = events.findIndex((event) => event.type === "message.completed");
			expect(
				events[deltaIndex]?.type === "message.delta" ? events[deltaIndex].payload.delta : undefined,
			).toBe("pending-before-cancel");
			expect(terminalIndex).toBeGreaterThan(deltaIndex);
			expect(events.slice(terminalIndex + 1).some((event) => event.type === "message.delta")).toBe(
				false,
			);
		} finally {
			await service.shutdown();
			database.close();
		}
	});

	test("hydrates snapshots only through their durable cursor boundary", async () => {
		const database = openAppDatabase(":memory:");
		const scheduler = new ManualScheduler();
		const runtime = new FakeAskChatRuntime({ deltas: ["pending-delta"], pending: true });
		const service = createService(database, runtime, scheduler);

		try {
			configureProvider(service);
			const { session } = service.createSession();
			const accepted = service.sendMessage({
				sessionId: session.id,
				content: "snapshot while coalescing",
			});
			scheduler.runAll();
			await runtime.started;

			const beforeFlush = await service.getSessionSnapshot({ sessionId: session.id });
			const cursor = beforeFlush.eventCursors.find(({ runId }) => runId === accepted.run.id);
			expect(beforeFlush.messages.at(-1)?.content).toBe("");
			expect(
				database.runs
					.listEvents({ runId: accepted.run.id })
					.some((event) => event.type === "message.delta"),
			).toBe(false);

			await waitUntil(
				() =>
					database.runs
						.listEvents({ runId: accepted.run.id })
						.some((event) => event.type === "message.delta"),
				250,
				"coalesced delta persistence",
			);
			const replay = service.replayEvents({
				cursors: [
					{
						runId: accepted.run.id,
						sessionId: session.id,
						issuedAtMs: beforeFlush.session.updatedAt === undefined ? 0 : Date.now(),
						lastSeq: cursor?.lastSeq ?? 0,
					},
				],
			});
			const replayedText = replay.events
				.filter((event) => event.type === "message.delta")
				.map((event) => (event.type === "message.delta" ? event.payload.delta : ""))
				.join("");
			expect(`${beforeFlush.messages.at(-1)?.content ?? ""}${replayedText}`).toBe("pending-delta");
			expect(
				(await service.getSessionSnapshot({ sessionId: session.id })).messages.at(-1)?.content,
			).toBe("pending-delta");
			expect(
				database.runs
					.listEvents({ runId: accepted.run.id })
					.filter((event) => event.type === "message.delta"),
			).toHaveLength(1);
			service.cancel({ runId: accepted.run.id });
			await service.waitForIdle();
		} finally {
			await service.shutdown();
			database.close();
		}
	});

	test("fails from the last durable delta without retrying an uncontained append", async () => {
		const database = openAppDatabase(":memory:");
		const scheduler = new ManualScheduler();
		let appendAttempts = 0;
		const runs: RunJournalRepository = new Proxy(database.runs, {
			get(target, property) {
				if (property === "appendEvent") {
					return (input: Parameters<RunJournalRepository["appendEvent"]>[0]) => {
						appendAttempts += 1;
						throw new Error(`unbounded persistence detail ${input.runId}`);
					};
				}
				const value = Reflect.get(target, property, target);
				return typeof value === "function" ? value.bind(target) : value;
			},
		});
		const runtime = new FakeAskChatRuntime({
			deltas: ["x".repeat(8_000), "must-be-fenced"],
			ignoreEventErrors: true,
		});
		const service = createService(database, runtime, scheduler, { runs, logger: { error() {} } });

		try {
			configureProvider(service);
			const { session } = service.createSession();
			const accepted = service.sendMessage({ sessionId: session.id, content: "append fails" });
			scheduler.runAll();
			await service.waitForIdle();

			expect(appendAttempts).toBe(1);
			expect(runtime.cancelAttempts).toContain(accepted.run.id);
			const restored = await service.getSession({ sessionId: session.id });
			expect(restored.runs[0]?.status).toBe("failed");
			expect(restored.messages.at(-1)?.content).toBe("");
			expect(restored.runs[0]?.lastError?.safeMessage).toBe("The chat response failed.");
			expect(JSON.stringify(restored)).not.toContain("unbounded persistence detail");
		} finally {
			await service.shutdown();
			database.close();
		}
	});

	test("recovers on a later Run after one delta append failure", async () => {
		const database = openAppDatabase(":memory:");
		const scheduler = new ManualScheduler();
		let failNextAppend = true;
		const runs: RunJournalRepository = new Proxy(database.runs, {
			get(target, property) {
				if (property === "appendEvent") {
					return (input: Parameters<RunJournalRepository["appendEvent"]>[0]) => {
						if (failNextAppend) {
							failNextAppend = false;
							throw new Error("transient append failure");
						}
						return target.appendEvent(input);
					};
				}
				const value = Reflect.get(target, property, target);
				return typeof value === "function" ? value.bind(target) : value;
			},
		});
		const service = createService(
			database,
			new FakeAskChatRuntime({ deltas: ["x".repeat(8_000)] }),
			scheduler,
			{ runs, logger: { error() {} } },
		);

		try {
			configureProvider(service);
			const { session } = service.createSession();
			service.sendMessage({ sessionId: session.id, content: "first" });
			scheduler.runAll();
			await service.waitForIdle();
			expect(database.runs.listBySession(session.id)[0]?.status).toBe("failed");

			const recovered = service.sendMessage({ sessionId: session.id, content: "second" });
			scheduler.runAll();
			await service.waitForIdle();
			expect(database.runs.get(recovered.run.id).status).toBe("completed");
		} finally {
			await service.shutdown();
			database.close();
		}
	});

	test("marks the data plane fatal and retains the Session fence when terminal persistence fails", async () => {
		const database = openAppDatabase(":memory:");
		const scheduler = new ManualScheduler();
		let failedTerminalAttempts = 0;
		const runs: RunJournalRepository = new Proxy(database.runs, {
			get(target, property) {
				if (property === "appendEvent") {
					return () => {
						throw new Error("append unavailable");
					};
				}
				if (property === "commitTerminal") {
					return (input: Parameters<RunJournalRepository["commitTerminal"]>[0]) => {
						if (input.message.status === "failed") {
							failedTerminalAttempts += 1;
							throw new Error("terminal unavailable");
						}
						return target.commitTerminal(input);
					};
				}
				const value = Reflect.get(target, property, target);
				return typeof value === "function" ? value.bind(target) : value;
			},
		});
		const service = createService(
			database,
			new FakeAskChatRuntime({ deltas: ["x".repeat(8_000)] }),
			scheduler,
			{ runs, logger: { error() {} } },
		);
		let restarted: ChatApplicationService | undefined;

		try {
			configureProvider(service);
			const { session } = service.createSession();
			const accepted = service.sendMessage({ sessionId: session.id, content: "fatal write" });
			scheduler.runAll();
			await service.waitForIdle();
			expect(failedTerminalAttempts).toBe(2);
			expect(database.runs.get(accepted.run.id).status).toBe("running");
			expect(() =>
				service.sendMessage({ sessionId: session.id, content: "must remain fenced" }),
			).toThrow("persistence is unavailable");
			await service.shutdown();

			restarted = createService(database, new FakeAskChatRuntime({}), new ManualScheduler());
			configureProvider(restarted);
			const recovered = await restarted.getSession({ sessionId: session.id });
			expect(recovered.runs[0]?.status).toBe("cancelled");
			expect(
				restarted.sendMessage({
					sessionId: session.id,
					content: "restart recovered",
				}).run.status,
			).toBe("queued");
		} finally {
			await restarted?.shutdown();
			await service.shutdown();
			database.close();
		}
	});

	test("fences every mutation when orphan terminal persistence fails and recovers on restart", async () => {
		const database = openAppDatabase(":memory:");
		const orphaned = createOrphanedRun(database, "running");
		let commitAttempts = 0;
		const runs: RunJournalRepository = new Proxy(database.runs, {
			get(target, property) {
				if (property === "commitTerminal") {
					return (input: Parameters<RunJournalRepository["commitTerminal"]>[0]) => {
						if (input.runId === orphaned.runId) {
							commitAttempts += 1;
							throw new Error("orphan terminal persistence unavailable");
						}
						return target.commitTerminal(input);
					};
				}
				const value = Reflect.get(target, property, target);
				return typeof value === "function" ? value.bind(target) : value;
			},
		});
		const service = createService(database, new FakeAskChatRuntime({}), new ManualScheduler(), {
			runs,
			logger: { error() {} },
		});
		const unhandled: unknown[] = [];
		const onUnhandled = (error: unknown): void => {
			unhandled.push(error);
		};
		process.on("unhandledRejection", onUnhandled);
		let restarted: ChatApplicationService | undefined;

		try {
			configureProvider(service);
			expect(() =>
				service.sendMessage({
					sessionId: orphaned.sessionId,
					content: "must not start after orphan failure",
				}),
			).toThrow("persistence is unavailable");
			expect(commitAttempts).toBe(1);
			expect(database.runs.get(orphaned.runId).status).toBe("running");
			expect(database.runs.listBySession(orphaned.sessionId)).toHaveLength(1);

			expect(() => service.createSession()).toThrow("persistence is unavailable");
			expect(() =>
				service.sendMessage({ sessionId: orphaned.sessionId, content: "still fenced" }),
			).toThrow("persistence is unavailable");
			expect(() =>
				service.configureProvider({
					schemaVersion: 1,
					baseUrl: "https://api.openai.com/v1",
					model: "other-model",
					apiKey: "sk-other",
				}),
			).toThrow("persistence is unavailable");
			expect(() => service.deleteProvider()).toThrow("persistence is unavailable");
			await expect(
				service.testProvider({
					schemaVersion: 1,
					baseUrl: "https://api.openai.com/v1",
					model: "other-model",
					apiKey: "sk-other",
				}),
			).rejects.toThrow("persistence is unavailable");
			expect(commitAttempts).toBe(1);
			await Promise.resolve();
			expect(unhandled).toEqual([]);

			await service.shutdown();
			restarted = createService(database, new FakeAskChatRuntime({}), new ManualScheduler());
			configureProvider(restarted);
			const recovered = await restarted.getSession({ sessionId: orphaned.sessionId });
			expect(recovered.runs[0]?.status).toBe("cancelled");
			await restarted.getSession({ sessionId: orphaned.sessionId });
			const terminalEvents = database.runs
				.listEventPage({ runId: orphaned.runId, afterSeq: 0, limit: 100 })
				.events.filter(
					(event) =>
						event.type === "run.status" &&
						(event.payload.status === "cancelled" || event.payload.status === "failed"),
				);
			expect(terminalEvents).toHaveLength(1);
		} finally {
			process.off("unhandledRejection", onUnhandled);
			await restarted?.shutdown();
			await service.shutdown();
			database.close();
		}
	});

	test("does not start the runtime after cancellation from the running event", async () => {
		const database = openAppDatabase(":memory:");
		const scheduler = new ManualScheduler();
		const runtime = new FakeAskChatRuntime({ deltas: ["must not run"] });
		const service = createService(database, runtime, scheduler);

		try {
			configureProvider(service);
			const { session } = service.createSession();
			const accepted = service.sendMessage({ sessionId: session.id, content: "cancel on running" });
			service.subscribe((event) => {
				if (event.type === "run.status" && event.payload.status === "running") {
					service.cancel({ runId: accepted.run.id, reason: "running listener cancellation" });
				}
			});
			scheduler.runAll();
			await service.waitForIdle();

			expect(runtime.inputs).toEqual([]);
			expect(database.runs.get(accepted.run.id).status).toBe("cancelled");
		} finally {
			await service.shutdown();
			database.close();
		}
	});

	test("fails atomically at output limit and fences a non-cooperative runtime", async () => {
		const database = openAppDatabase(":memory:");
		const scheduler = new ManualScheduler();
		const runtime = new FakeAskChatRuntime({
			deltas: [
				...Array.from({ length: 24 }, () => "x".repeat(8_000)),
				"y".repeat(7_999),
				"yz",
				"late-output",
			],
			ignoreEventErrors: true,
		});
		const service = createService(database, runtime, scheduler);

		try {
			configureProvider(service);
			const { session } = service.createSession();
			const requestId = crypto.randomUUID();
			const accepted = service.sendMessage({
				requestId,
				sessionId: session.id,
				content: "overflow",
			});
			scheduler.runAll();
			await service.waitForIdle();

			const snapshot = await service.getSession({ sessionId: session.id });
			const assistant = snapshot.messages.at(-1);
			expect(snapshot.runs[0]?.status).toBe("failed");
			expect(snapshot.runs[0]?.lastError?.code).toBe("CHAT_OUTPUT_LIMIT_EXCEEDED");
			expect(assistant?.content).toHaveLength(maxAssistantMessageContentCharacters);
			expect(runtime.cancelAttempts).toContain(accepted.run.id);
			const deltas = database.runs
				.listEvents({ runId: accepted.run.id })
				.filter((event) => event.type === "message.delta");
			expect(
				deltas.reduce(
					(length, event) =>
						event.type === "message.delta" ? length + event.payload.delta.length : length,
					0,
				),
			).toBe(maxAssistantMessageContentCharacters);
			expect(
				deltas.some(
					(event) =>
						event.type === "message.delta" &&
						(event.payload.delta === "yz" || event.payload.delta === "late-output"),
				),
			).toBe(false);
			const retry = service.sendMessage({
				requestId,
				sessionId: session.id,
				content: "overflow",
			});
			expect(retry.run.id).toBe(accepted.run.id);
			expect(retry.assistantMessage.status).toBe("failed");
			expect(retry.assistantMessage.content).toHaveLength(maxAssistantMessageContentCharacters);
		} finally {
			await service.shutdown();
			database.close();
		}
	});

	test("fails a bounded projection when final text exceeds the limit without deltas", async () => {
		const database = openAppDatabase(":memory:");
		const scheduler = new ManualScheduler();
		const runtime = new FakeAskChatRuntime({
			resultText: "z".repeat(maxAssistantMessageContentCharacters + 1),
		});
		const service = createService(database, runtime, scheduler);

		try {
			configureProvider(service);
			const { session } = service.createSession();
			service.sendMessage({ sessionId: session.id, content: "oversized final" });
			scheduler.runAll();
			await service.waitForIdle();

			const snapshot = await service.getSession({ sessionId: session.id });
			expect(snapshot.runs[0]?.status).toBe("failed");
			expect(snapshot.runs[0]?.lastError?.code).toBe("CHAT_OUTPUT_LIMIT_EXCEEDED");
			expect(snapshot.messages.at(-1)?.content).toHaveLength(maxAssistantMessageContentCharacters);
		} finally {
			await service.shutdown();
			database.close();
		}
	});

	test("rejects new Runs while the executor is not ready", () => {
		const database = openAppDatabase(":memory:");
		const service = createService(database, new FakeAskChatRuntime({}), new ManualScheduler(), {
			isRuntimeReady: () => false,
		});
		configureProvider(service);
		const { session } = service.createSession();

		expect(() => service.sendMessage({ sessionId: session.id, content: "blocked" })).toThrow(
			"executor is not authenticated and ready",
		);
		expect(database.runs.listBySession(session.id)).toEqual([]);
		database.close();
	});

	test("retains an accepted prompt when readiness is lost before execution", async () => {
		const database = openAppDatabase(":memory:");
		const scheduler = new ManualScheduler();
		const runtime = new FakeAskChatRuntime({});
		let ready = true;
		const service = createService(database, runtime, scheduler, {
			isRuntimeReady: () => ready,
		});

		try {
			configureProvider(service);
			const { session } = service.createSession();
			const accepted = service.sendMessage({
				sessionId: session.id,
				content: "durable before execution",
			});
			ready = false;
			scheduler.runAll();
			await service.waitForIdle();

			const snapshot = await service.getSession({ sessionId: session.id });
			expect(snapshot.messages.map((message) => message.content)).toEqual([
				"durable before execution",
				"",
			]);
			expect(snapshot.messages.at(-1)?.status).toBe("failed");
			expect(snapshot.runs.find((run) => run.id === accepted.run.id)?.status).toBe("failed");
			expect(runtime.inputs).toEqual([]);
		} finally {
			await service.shutdown();
			database.close();
		}
	});

	test("deduplicates an ambiguous Chat send by client request ID", async () => {
		const database = openAppDatabase(":memory:");
		const scheduler = new ManualScheduler();
		const service = createService(
			database,
			new FakeAskChatRuntime({ deltas: ["answer"] }),
			scheduler,
		);

		try {
			configureProvider(service);
			const { session } = service.createSession();
			const requestId = crypto.randomUUID();
			const first = service.sendMessage({
				requestId,
				sessionId: session.id,
				content: "send once",
			});
			const retried = service.sendMessage({
				requestId,
				sessionId: session.id,
				content: "send once",
			});

			expect(retried.run.id).toBe(first.run.id);
			expect(database.runs.listBySession(session.id)).toHaveLength(1);
			expect(() =>
				service.sendMessage({
					requestId,
					sessionId: session.id,
					content: "different content",
				}),
			).toThrow("already used for different content");
			scheduler.runAll();
			await service.waitForIdle();
			const terminalRetry = service.sendMessage({
				requestId,
				sessionId: session.id,
				content: "send once",
			});
			expect(terminalRetry.run.id).toBe(first.run.id);
			expect(terminalRetry.assistantMessage.status).toBe("complete");
			expect(terminalRetry.assistantMessage.content).toBe("answer");
		} finally {
			await service.shutdown();
			database.close();
		}
	});

	test("replays durable sends before applying readiness to new Runs", async () => {
		const database = openAppDatabase(":memory:");
		const scheduler = new ManualScheduler();
		let ready = true;
		const service = createService(
			database,
			new FakeAskChatRuntime({ deltas: ["answer"] }),
			scheduler,
			{ isRuntimeReady: () => ready },
		);

		try {
			configureProvider(service);
			const { session } = service.createSession();
			const requestId = crypto.randomUUID();
			const first = service.sendMessage({
				requestId,
				sessionId: session.id,
				content: "durable replay",
			});
			ready = false;
			const activeRetry = service.sendMessage({
				requestId,
				sessionId: session.id,
				content: "durable replay",
			});
			expect(activeRetry.run.id).toBe(first.run.id);
			expect(activeRetry.assistantMessage.status).toBe("streaming");
			expect(() =>
				service.sendMessage({
					requestId,
					sessionId: session.id,
					content: "conflicting replay",
				}),
			).toThrow("already used for different content");
			const otherSession = service.createSession().session;
			expect(() =>
				service.sendMessage({
					requestId,
					sessionId: otherSession.id,
					content: "durable replay",
				}),
			).toThrow("already used for different content");
			expect(() =>
				service.sendMessage({
					requestId: crypto.randomUUID(),
					sessionId: session.id,
					content: "new while unavailable",
				}),
			).toThrow("executor is not authenticated and ready");

			ready = true;
			scheduler.runAll();
			await service.waitForIdle();
			ready = false;
			const terminalRetry = service.sendMessage({
				requestId,
				sessionId: session.id,
				content: "durable replay",
			});
			expect(terminalRetry.run.id).toBe(first.run.id);
			expect(terminalRetry.assistantMessage.status).toBe("complete");
		} finally {
			await service.shutdown();
			database.close();
		}
	});

	test("pages Session snapshots by bounded Run count", async () => {
		const database = openAppDatabase(":memory:");
		const scheduler = new ManualScheduler();
		const runtime = new FakeAskChatRuntime({ deltas: ["answer"] });
		const service = createService(database, runtime, scheduler);

		try {
			configureProvider(service);
			const { session } = service.createSession();
			const runIds: string[] = [];
			for (const content of Array.from({ length: 9 }, (_, index) => `prompt-${index}`)) {
				runIds.push(service.sendMessage({ sessionId: session.id, content }).run.id);
				scheduler.runAll();
				await service.waitForIdle();
			}

			const pagedRunIds: string[] = [];
			let cursor: string | undefined;
			do {
				const page = await service.getSessionPage({
					sessionId: session.id,
					...(cursor === undefined ? {} : { cursor }),
					limit: 2,
				});
				pagedRunIds.push(...page.runs.map((run) => run.id));
				cursor = page.nextCursor;
			} while (cursor !== undefined);
			expect(pagedRunIds).toEqual(runIds);
			expect(new Set(pagedRunIds).size).toBe(runIds.length);
			expect(runtime.getThreadMessagesCalls).toBe(0);
		} finally {
			await service.shutdown();
			database.close();
		}
	});

	test("replays one SQL-backed event page without loading the remaining journal", async () => {
		const database = openAppDatabase(":memory:");
		const scheduler = new ManualScheduler();
		const orphaned = createOrphanedRun(database, "running");
		for (let index = 0; index < maxReplayEventsPerPage + 10; index += 1) {
			database.runs.appendEvent({
				runId: orphaned.runId,
				type: "message.delta",
				source: { kind: "assistant" },
				payload: { messageId: orphaned.assistantMessageId, delta: "x" },
			});
		}
		database.runs.commitTerminal({
			runId: orphaned.runId,
			message: {
				messageId: orphaned.assistantMessageId,
				status: "complete",
				content: "x".repeat(maxReplayEventsPerPage + 10),
			},
		});
		const pageInputs: Array<{ runId: string; afterSeq?: number; limit: number }> = [];
		const runs: RunJournalRepository = new Proxy(database.runs, {
			get(target, property) {
				if (property === "listEvents") {
					return () => {
						throw new Error("Replay must not load an unbounded event list.");
					};
				}
				if (property === "listEventPage") {
					return (input: Parameters<RunJournalRepository["listEventPage"]>[0]) => {
						pageInputs.push(input);
						return target.listEventPage(input);
					};
				}
				const value = Reflect.get(target, property, target);
				return typeof value === "function" ? value.bind(target) : value;
			},
		});
		const service = createService(database, new FakeAskChatRuntime({}), scheduler, { runs });

		try {
			const first = service.replayEvents({
				cursors: [
					{
						runId: orphaned.runId,
						sessionId: orphaned.sessionId,
						issuedAtMs: Date.now(),
						lastSeq: 0,
					},
				],
			});
			expect(first.events).toHaveLength(maxReplayEventsPerPage);
			expect(first.hasMore).toBe(true);
			expect(pageInputs).toEqual([
				{ runId: orphaned.runId, afterSeq: 0, limit: maxReplayEventsPerPage },
			]);
			const second = service.replayEvents({
				cursors: [
					{
						runId: orphaned.runId,
						sessionId: orphaned.sessionId,
						issuedAtMs: Date.now(),
						lastSeq: first.events.at(-1)?.seq ?? 0,
					},
				],
			});
			expect(second.events[0]?.seq).toBe((first.events.at(-1)?.seq ?? 0) + 1);
		} finally {
			await service.shutdown();
			database.close();
		}
	});

	test("bounds replay pages by encoded bytes while always advancing", async () => {
		const database = openAppDatabase(":memory:");
		const orphaned = createOrphanedRun(database, "running");
		for (let index = 0; index < 100; index += 1) {
			database.runs.appendEvent({
				runId: orphaned.runId,
				type: "message.delta",
				source: { kind: "assistant" },
				payload: { messageId: orphaned.assistantMessageId, delta: "\0".repeat(8_000) },
			});
		}
		database.runs.commitTerminal({
			runId: orphaned.runId,
			message: {
				messageId: orphaned.assistantMessageId,
				status: "complete",
				content: "x",
			},
		});
		const service = createService(database, new FakeAskChatRuntime({}), new ManualScheduler());

		try {
			const first = service.replayEvents({
				cursors: [
					{
						runId: orphaned.runId,
						sessionId: orphaned.sessionId,
						issuedAtMs: Date.now(),
						lastSeq: 0,
					},
				],
			});
			const encodedEventsBytes = new TextEncoder().encode(JSON.stringify(first.events)).byteLength;
			expect(first.events.length).toBeGreaterThan(0);
			expect(encodedEventsBytes).toBeLessThanOrEqual(maxReplayEventBytesPerPage);
			expect(first.hasMore).toBe(true);
			const next = service.replayEvents({
				cursors: [
					{
						runId: orphaned.runId,
						sessionId: orphaned.sessionId,
						issuedAtMs: first.cursorSupport.serverTimeMs,
						lastSeq: first.events.at(-1)?.seq ?? 0,
					},
				],
			});
			expect(next.events[0]?.seq).toBe((first.events.at(-1)?.seq ?? 0) + 1);
		} finally {
			await service.shutdown();
			database.close();
		}
	});

	test("submits only the current turn and lets Deep Agents restore prior messages", async () => {
		const database = openAppDatabase(":memory:");
		const scheduler = new ManualScheduler();
		const runtime = new FakeAskChatRuntime({ deltas: ["Reply"] });
		const service = createService(database, runtime, scheduler);

		try {
			configureProvider(service);
			const { session } = service.createSession();

			service.sendMessage({ sessionId: session.id, content: "First question" });
			scheduler.runAll();
			await service.waitForIdle();
			service.sendMessage({
				sessionId: session.id,
				content: "Second question",
			});
			scheduler.runAll();
			await service.waitForIdle();

			expect(
				runtime.inputs.map((input) =>
					input.messages.map(({ role, content }) => ({ role, content })),
				),
			).toEqual([
				[{ role: "user", content: "First question" }],
				[{ role: "user", content: "Second question" }],
			]);
			expect(runtime.inputs.map((input) => input.threadId)).toEqual([session.id, session.id]);
		} finally {
			await service.shutdown();
			database.close();
		}
	});

	test("cancels the runtime and persists partial assistant content", async () => {
		const database = openAppDatabase(":memory:");
		const scheduler = new ManualScheduler();
		const runtime = new FakeAskChatRuntime({ pending: true });
		const service = createService(database, runtime, scheduler);

		try {
			configureProvider(service);
			const { session } = service.createSession();
			const accepted = service.sendMessage({
				sessionId: session.id,
				content: "Keep talking",
			});

			scheduler.runAll();
			await runtime.started;
			const cancelResult = service.cancel({
				runId: accepted.run.id,
				reason: "User stopped the response.",
			});
			expect(cancelResult.run.status).toBe("cancelled");
			expect(() =>
				service.sendMessage({ sessionId: session.id, content: "must wait for cancellation" }),
			).toThrow("active response");
			await service.waitForIdle();

			const restored = await service.getSession({ sessionId: session.id });
			expect(restored.messages[1]?.status).toBe("cancelled");
			expect(restored.runs[0]?.status).toBe("cancelled");
			expect(runtime.cancelledRunIds).toEqual([accepted.run.id]);
		} finally {
			await service.shutdown();
			database.close();
		}
	});

	test("cancellation aborts the shared runtime signal without consuming queued provider output", async () => {
		const database = openAppDatabase(":memory:");
		const scheduler = new ManualScheduler();
		let consumed = 0;
		let resolveFirst: () => void = () => {};
		const first = new Promise<void>((resolve) => {
			resolveFirst = resolve;
		});
		const runtime: AskChatRuntime = {
			async run(input) {
				for (let index = 0; index < 500; index += 1) {
					if (input.signal?.aborted) {
						throw new AskChatCancelledError(input.runId, "signal aborted");
					}
					consumed += 1;
					await input.onEvent?.({
						type: "message.delta",
						runId: input.runId,
						delta: "x",
					});
					if (index === 0) {
						resolveFirst();
					}
					await Promise.resolve();
				}
				return { runId: input.runId, text: "x".repeat(consumed) };
			},
			stream() {
				throw new Error("unused");
			},
			cancel() {
				return false;
			},
			async getThreadMessages() {
				return [];
			},
			async deleteThread() {},
			async shutdown() {},
		};
		const service = createService(database, runtime, scheduler);

		try {
			configureProvider(service);
			const { session } = service.createSession();
			const accepted = service.sendMessage({ sessionId: session.id, content: "bounded cancel" });
			scheduler.runAll();
			await first;
			service.cancel({ runId: accepted.run.id, reason: "stop after first" });
			await withDeadline(service.waitForIdle(), 250, "shared signal cancellation");
			expect(consumed).toBeLessThanOrEqual(3);
			expect(database.runs.get(accepted.run.id).status).toBe("cancelled");
		} finally {
			await service.shutdown();
			database.close();
		}
	});

	test("persists safe provider errors without exposing credentials", async () => {
		const database = openAppDatabase(":memory:");
		const scheduler = new ManualScheduler();
		const runtime = new FakeAskChatRuntime({
			error: new AskChatRuntimeError({
				kind: "provider_authentication",
				message: "Provider authentication failed.",
				retryable: false,
				statusCode: 401,
			}),
		});
		const service = createService(database, runtime, scheduler);

		try {
			configureProvider(service);
			const status = service.getProviderStatus();
			expect(status).toEqual({
				schemaVersion: 1,
				configured: true,
				baseUrl: "https://api.openai.com/v1",
				model: "gpt-4.1-mini",
				apiKeyMask: "••••••••cret",
			});
			expect("apiKey" in status).toBe(false);

			const { session } = service.createSession();
			service.sendMessage({
				sessionId: session.id,
				content: "Authenticate",
			});
			scheduler.runAll();
			await service.waitForIdle();

			const restored = await service.getSession({ sessionId: session.id });
			const assistant = restored.messages[1];
			expect(assistant?.status).toBe("failed");
			if (assistant?.status !== "failed") {
				throw new Error("Expected a failed assistant message.");
			}
			expect(assistant.error.safeMessage).toBe("Provider authentication failed.");
			expect(JSON.stringify(restored)).not.toContain("sk-test-secret");
		} finally {
			await service.shutdown();
			database.close();
		}
	});

	test.each([
		["empty", ""],
		["whitespace", "   \n\t"],
		["oversized", "x".repeat(4_194_304)],
	])("normalizes %s runtime error messages before terminal persistence", async (_name, message) => {
		const database = openAppDatabase(":memory:");
		const scheduler = new ManualScheduler();
		const service = createService(
			database,
			new FakeAskChatRuntime({
				error: new AskChatRuntimeError({
					kind: "provider_failure",
					message,
					retryable: true,
				}),
			}),
			scheduler,
		);

		try {
			configureProvider(service);
			const { session } = service.createSession();
			const requestId = crypto.randomUUID();
			const accepted = service.sendMessage({
				requestId,
				sessionId: session.id,
				content: "normalize error",
			});
			scheduler.runAll();
			await service.waitForIdle();

			const snapshot = await service.getSession({ sessionId: session.id });
			const failedRun = snapshot.runs.find((run) => run.id === accepted.run.id);
			expect(failedRun?.status).toBe("failed");
			expect(failedRun?.lastError?.safeMessage.trim().length).toBeGreaterThan(0);
			expect(failedRun?.lastError?.safeMessage.length).toBeLessThanOrEqual(
				maxAppErrorSafeMessageCharacters,
			);
			const retry = service.sendMessage({
				requestId,
				sessionId: session.id,
				content: "normalize error",
			});
			expect(retry.assistantMessage.status).toBe("failed");
			expect(JSON.stringify(retry).length).toBeLessThan(1_000_000);
			const replay = service.replayEvents({
				cursors: [
					{ runId: accepted.run.id, sessionId: session.id, issuedAtMs: Date.now(), lastSeq: 0 },
				],
			});
			expect(JSON.stringify(replay).length).toBeLessThan(1_000_000);
		} finally {
			await service.shutdown();
			database.close();
		}
	});

	test.each([
		["ordinary throw", new Error("internal secret detail")],
		[
			"hostile proxy",
			new Proxy(
				new AskChatRuntimeError({
					kind: "provider_failure",
					message: "hidden",
					retryable: false,
				}),
				{
					get(target, property, receiver) {
						if (property === "kind" || property === "message") {
							throw new Error("hostile error getter");
						}
						return Reflect.get(target, property, receiver);
					},
				},
			),
		],
	])("uses a fixed safe fallback for %s", async (_name, runtimeError) => {
		const database = openAppDatabase(":memory:");
		const scheduler = new ManualScheduler();
		const service = createService(
			database,
			new FakeAskChatRuntime({ error: runtimeError }),
			scheduler,
		);

		try {
			configureProvider(service);
			const { session } = service.createSession();
			service.sendMessage({ sessionId: session.id, content: "safe fallback" });
			scheduler.runAll();
			await service.waitForIdle();
			const snapshot = await service.getSession({ sessionId: session.id });
			expect(snapshot.runs[0]?.status).toBe("failed");
			expect(snapshot.runs[0]?.lastError?.safeMessage).toBe("The chat response failed.");
			expect(JSON.stringify(snapshot)).not.toContain("internal secret detail");
			expect(JSON.stringify(snapshot)).not.toContain("hostile error getter");
		} finally {
			await service.shutdown();
			database.close();
		}
	});

	test("retries a bounded fallback when the primary failed terminal commit throws", async () => {
		const database = openAppDatabase(":memory:");
		const scheduler = new ManualScheduler();
		let failedCommitAttempts = 0;
		const runs: RunJournalRepository = new Proxy(database.runs, {
			get(target, property) {
				if (property === "commitTerminal") {
					return (input: Parameters<RunJournalRepository["commitTerminal"]>[0]) => {
						if (input.message.status === "failed" && failedCommitAttempts === 0) {
							failedCommitAttempts += 1;
							throw new Error("primary terminal serialization failed");
						}
						failedCommitAttempts += 1;
						return target.commitTerminal(input);
					};
				}
				const value = Reflect.get(target, property, target);
				return typeof value === "function" ? value.bind(target) : value;
			},
		});
		const service = createService(
			database,
			new FakeAskChatRuntime({ error: new Error("provider internals") }),
			scheduler,
			{ runs, logger: { error() {} } },
		);

		try {
			configureProvider(service);
			const { session } = service.createSession();
			service.sendMessage({ sessionId: session.id, content: "fallback terminal" });
			scheduler.runAll();
			await service.waitForIdle();

			const snapshot = await service.getSession({ sessionId: session.id });
			expect(failedCommitAttempts).toBe(2);
			expect(snapshot.runs[0]?.status).toBe("failed");
			expect(snapshot.runs[0]?.lastError?.code).toBe("CHAT_RUN_FAILED");
			expect(snapshot.runs[0]?.lastError?.safeMessage).toBe("The chat response failed.");
		} finally {
			await service.shutdown();
			database.close();
		}
	});

	test("keeps the saved API key when updating Provider fields on the same origin", async () => {
		const database = openAppDatabase(":memory:");
		const scheduler = new ManualScheduler();
		const store = new InMemoryAskProviderConfigStore();
		const service = createService(database, new FakeAskChatRuntime({}), scheduler, {
			providerConfigStore: store,
		});

		try {
			configureProvider(service);
			service.configureProvider({
				schemaVersion: 1,
				baseUrl: "https://api.openai.com/compatible/v1",
				model: "updated-model",
			});

			expect(store.get()).toEqual({
				provider: "openai-compatible",
				baseUrl: "https://api.openai.com/compatible/v1",
				model: "updated-model",
				apiKey: "sk-test-secret",
			});
		} finally {
			await service.shutdown();
			database.close();
		}
	});

	test("requires a new API key before sending credentials to another origin", async () => {
		const database = openAppDatabase(":memory:");
		const scheduler = new ManualScheduler();
		const testedConfigurations: AskProviderConfiguration[] = [];
		const service = createService(database, new FakeAskChatRuntime({}), scheduler, {
			testProviderConnection: async (configuration) => {
				testedConfigurations.push(configuration);
			},
		});

		try {
			configureProvider(service);
			expect(() =>
				service.configureProvider({
					schemaVersion: 1,
					baseUrl: "https://untrusted.example/v1",
					model: "updated-model",
				}),
			).toThrow("new API key");

			const output = await service.testProvider({
				schemaVersion: 1,
				baseUrl: "https://untrusted.example/v1",
				model: "updated-model",
			});
			expect(output.ok).toBe(false);
			expect(output.error?.safeMessage).toContain("new API key");
			expect(testedConfigurations).toEqual([]);
		} finally {
			await service.shutdown();
			database.close();
		}
	});

	test("tests Provider settings without exposing the API key", async () => {
		const database = openAppDatabase(":memory:");
		const scheduler = new ManualScheduler();
		const testedConfigurations: AskProviderConfiguration[] = [];
		const service = createService(database, new FakeAskChatRuntime({}), scheduler, {
			testProviderConnection: async (configuration) => {
				testedConfigurations.push(configuration);
			},
		});

		try {
			configureProvider(service);
			const output = await service.testProvider({
				schemaVersion: 1,
				baseUrl: "https://api.openai.com/v1",
				model: "gpt-4.1-mini",
			});

			expect(output.ok).toBe(true);
			expect(testedConfigurations[0]?.apiKey).toBe("sk-test-secret");
			expect(JSON.stringify(output)).not.toContain("sk-test-secret");
		} finally {
			await service.shutdown();
			database.close();
		}
	});

	test("maps Provider connection failures to safe errors", async () => {
		const database = openAppDatabase(":memory:");
		const scheduler = new ManualScheduler();
		const service = createService(database, new FakeAskChatRuntime({}), scheduler, {
			testProviderConnection: async () => {
				throw new AskChatRuntimeError({
					kind: "provider_authentication",
					message: "Provider authentication failed.",
					retryable: false,
					statusCode: 401,
				});
			},
		});

		try {
			const output = await service.testProvider({
				schemaVersion: 1,
				baseUrl: "https://api.openai.com/v1",
				model: "gpt-4.1-mini",
				apiKey: "sk-test-secret",
			});

			expect(output.ok).toBe(false);
			expect(output.error?.safeMessage).toBe("Provider authentication failed.");
			expect(JSON.stringify(output)).not.toContain("sk-test-secret");
		} finally {
			await service.shutdown();
			database.close();
		}
	});

	test("deletes the saved Provider configuration", async () => {
		const database = openAppDatabase(":memory:");
		const scheduler = new ManualScheduler();
		const store = new InMemoryAskProviderConfigStore();
		const service = createService(database, new FakeAskChatRuntime({}), scheduler, {
			providerConfigStore: store,
		});

		try {
			configureProvider(service);
			const status = service.deleteProvider();

			expect(status.configured).toBe(false);
			expect(store.get()).toBeNull();
		} finally {
			await service.shutdown();
			database.close();
		}
	});

	test("lists, renames, archives, restores, and deletes Sessions", async () => {
		const database = openAppDatabase(":memory:");
		const scheduler = new ManualScheduler();
		const runtime = new FakeAskChatRuntime({ deltas: ["Done"] });
		const service = createService(database, runtime, scheduler);

		try {
			configureProvider(service);
			const { session } = service.createSession();
			service.sendMessage({ sessionId: session.id, content: "Plan a launch" });
			scheduler.runAll();
			await service.waitForIdle();

			expect(service.listSessions({ query: "launch" }).items[0]?.id).toBe(session.id);
			expect(
				service.updateSession({ sessionId: session.id, title: "Launch plan" }).session.title,
			).toBe("Launch plan");
			expect(
				service.setSessionArchived({ sessionId: session.id, archived: true }).session.archivedAt,
			).toBeDefined();
			expect(service.listSessions({ archived: true }).items[0]?.id).toBe(session.id);
			expect(
				service.setSessionArchived({ sessionId: session.id, archived: false }).session.archivedAt,
			).toBeUndefined();
			expect(await service.deleteSession({ sessionId: session.id })).toEqual({
				sessionId: session.id,
			});
			expect(runtime.deletedThreadIds).toEqual([session.id]);
			expect(service.listSessions().items).toEqual([]);
		} finally {
			await service.shutdown();
			database.close();
		}
	});

	test("locks a Session across asynchronous deletion and retires its Runs", async () => {
		const database = openAppDatabase(":memory:");
		const scheduler = new ManualScheduler();
		const deletionGate = createDeferred();
		const service = createService(
			database,
			new FakeAskChatRuntime({ deltas: ["done"], deleteThreadGate: deletionGate.promise }),
			scheduler,
		);

		try {
			configureProvider(service);
			const { session } = service.createSession();
			const accepted = service.sendMessage({ sessionId: session.id, content: "retire me" });
			scheduler.runAll();
			await service.waitForIdle();
			const deletion = service.deleteSession({ sessionId: session.id });
			expect(() => service.sendMessage({ sessionId: session.id, content: "racing send" })).toThrow(
				"being deleted",
			);
			expect(() =>
				service.updateSession({ sessionId: session.id, title: "racing update" }),
			).toThrow("being deleted");
			expect(() => service.setSessionArchived({ sessionId: session.id, archived: true })).toThrow(
				"being deleted",
			);

			deletionGate.resolve();
			await deletion;
			expect(
				service.replayEvents({
					cursors: [
						{
							runId: accepted.run.id,
							sessionId: session.id,
							issuedAtMs: Date.now(),
							lastSeq: 0,
						},
					],
				}).retiredSessionIds,
			).toEqual([session.id]);
			expect(() =>
				service.replayEvents({
					cursors: [
						{
							runId: createUuidV7(),
							sessionId: createUuidV7(),
							issuedAtMs: Date.now(),
							lastSeq: 0,
						},
					],
				}),
			).toThrow("not found");
		} finally {
			await service.shutdown();
			database.close();
		}
	});

	test("coalesces concurrent Session deletion while preserving its mutation fence", async () => {
		const database = openAppDatabase(":memory:");
		const deletionGate = createDeferred();
		const runtime = new FakeAskChatRuntime({ deleteThreadGate: deletionGate.promise });
		const service = createService(database, runtime, new ManualScheduler());

		try {
			const { session } = service.createSession();
			const first = service.deleteSession({ sessionId: session.id });
			const second = service.deleteSession({ sessionId: session.id });
			expect(second).toBe(first);
			await expect(first).resolves.toEqual({ sessionId: session.id });
			expect(service.deleteSession({ sessionId: session.id })).toBe(first);
			expect(() => service.sendMessage({ sessionId: session.id, content: "too late" })).toThrow(
				"being deleted",
			);
			expect(runtime.deletedThreadIds).toEqual([session.id]);
			expect(database.runs.listPendingCheckpointDeletions(10, true)).toHaveLength(1);

			deletionGate.resolve();
			await waitUntil(
				() => database.runs.listPendingCheckpointDeletions(10, true).length === 0,
				100,
				"coalesced deletion cleanup",
			);
			await expect(service.deleteSession({ sessionId: session.id })).resolves.toEqual({
				sessionId: session.id,
			});
			expect(runtime.deletedThreadIds).toEqual([session.id]);
		} finally {
			deletionGate.resolve();
			await service.shutdown();
			database.close();
		}
	});

	test("returns durable deletion success after response loss and restart without duplicating cleanup", async () => {
		const database = openAppDatabase(":memory:");
		const failedRuntime = new FakeAskChatRuntime({
			deleteThreadError: new Error("checkpoint cleanup failed"),
		});
		const service = createService(database, failedRuntime, new ManualScheduler(), {
			logger: { error() {} },
		});
		let restarted: ChatApplicationService | undefined;

		try {
			const { session } = service.createSession();
			void service.deleteSession({ sessionId: session.id });
			await expect(service.deleteSession({ sessionId: session.id })).resolves.toEqual({
				sessionId: session.id,
			});
			await waitUntil(
				() => database.runs.listPendingCheckpointDeletions(10, true)[0]?.attemptCount === 1,
				100,
				"failed checkpoint cleanup persistence",
			);
			expect(failedRuntime.deletedThreadIds).toEqual([session.id]);
			expect(database.runs.listPendingCheckpointDeletions(10, true)).toHaveLength(1);
			expect(database.runs.isSessionRetired(session.id)).toBe(true);

			await service.shutdown();
			const restartedRuntime = new FakeAskChatRuntime({});
			restarted = createService(database, restartedRuntime, new ManualScheduler());
			await expect(restarted.deleteSession({ sessionId: session.id })).resolves.toEqual({
				sessionId: session.id,
			});
			expect(restartedRuntime.deletedThreadIds).toEqual([]);
			expect(database.runs.listPendingCheckpointDeletions(10, true)).toHaveLength(1);
			expect(() => restarted?.deleteSession({ sessionId: createUuidV7() })).toThrow("not found");
		} finally {
			await restarted?.shutdown();
			await service.shutdown();
			database.close();
		}
	});

	test("keeps product deletion authoritative when checkpoint cleanup fails", async () => {
		const database = openAppDatabase(":memory:");
		const scheduler = new ManualScheduler();
		const failedRuntime = new FakeAskChatRuntime({
			deleteThreadError: new Error("delete failed"),
		});
		const service = createService(database, failedRuntime, scheduler, { logger: { error() {} } });
		let restarted: ChatApplicationService | undefined;

		try {
			configureProvider(service);
			const { session } = service.createSession();
			await expect(service.deleteSession({ sessionId: session.id })).resolves.toEqual({
				sessionId: session.id,
			});
			await waitUntil(
				() => database.runs.listPendingCheckpointDeletions(10, true)[0]?.attemptCount === 1,
				100,
				"authoritative deletion cleanup failure",
			);
			await expect(service.getSession({ sessionId: session.id })).rejects.toThrow("not found");
			const [failedJob] = database.runs.listPendingCheckpointDeletions(10, true);
			expect(failedJob).toEqual(
				expect.objectContaining({
					sessionId: session.id,
					attemptCount: 1,
					lastError: "delete failed",
				}),
			);
			expect(failedJob?.nextAttemptAtMs).toBeGreaterThan(failedJob?.lastAttemptAtMs ?? 0);

			const recoveryRuntime = new FakeAskChatRuntime({});
			restarted = createService(database, recoveryRuntime, new ManualScheduler());
			expect(
				await restarted.retryPendingCheckpointDeletions({
					limit: 10,
					includeDeferred: true,
				}),
			).toEqual({ attempted: 1, succeeded: 1, failed: 0, remaining: 0 });
			expect(recoveryRuntime.deletedThreadIds).toEqual([session.id]);
			expect(await restarted.retryPendingCheckpointDeletions({ limit: 10 })).toEqual({
				attempted: 0,
				succeeded: 0,
				failed: 0,
				remaining: 0,
			});
		} finally {
			await restarted?.shutdown();
			await service.shutdown();
			database.close();
		}
	});

	test("drains checkpoint deletion jobs in bounded retries until they succeed", async () => {
		const database = openAppDatabase(":memory:");
		const session = database.sessions.create({ title: "Retry cleanup" }).session;
		database.runs.deleteSessionAndRetireRuns(session.id);
		const runtime = new FakeAskChatRuntime({
			deleteThreadError: new Error("transient checkpoint failure"),
			deleteThreadFailures: 2,
		});
		const service = createService(database, runtime, new ManualScheduler(), {
			checkpointDeletionRetryBaseMs: 1,
			checkpointDeletionRetryMaxMs: 2,
			logger: { error() {} },
		});

		try {
			await withDeadline(
				service.drainPendingCheckpointDeletions({ batchSize: 1 }),
				250,
				"checkpoint deletion recovery",
			);
			await waitUntil(
				() => database.runs.listPendingCheckpointDeletions(10, true).length === 0,
				250,
				"checkpoint deletion background retry",
			);
			expect(runtime.deletedThreadIds).toEqual([session.id, session.id, session.id]);
			expect(database.runs.listPendingCheckpointDeletions(10, true)).toEqual([]);
		} finally {
			await service.shutdown();
			database.close();
		}
	});

	test("times out one hung checkpoint deletion without blocking later jobs in the batch", async () => {
		const database = openAppDatabase(":memory:");
		const first = database.sessions.create({ title: "Hung cleanup" }).session;
		const second = database.sessions.create({ title: "Later cleanup" }).session;
		database.runs.deleteSessionAndRetireRuns(first.id);
		database.runs.deleteSessionAndRetireRuns(second.id);
		const firstGate = createDeferred();
		const runtime = new FakeAskChatRuntime({
			deleteThreadImplementation: async (threadId) => {
				if (threadId === first.id) {
					await firstGate.promise;
				}
			},
		});
		const service = createService(database, runtime, new ManualScheduler(), {
			checkpointDeletionAttemptTimeoutMs: 10,
			checkpointDeletionRetryBaseMs: 1_000,
			checkpointDeletionRetryMaxMs: 1_000,
			logger: { error() {} },
		});

		try {
			expect(
				await withDeadline(
					service.retryPendingCheckpointDeletions({
						limit: 2,
						includeDeferred: true,
					}),
					100,
					"checkpoint deletion batch",
				),
			).toEqual({ attempted: 2, succeeded: 1, failed: 1, remaining: 1 });
			expect(runtime.deletedThreadIds).toEqual([first.id, second.id]);
			expect(database.runs.listPendingCheckpointDeletions(10, true)).toEqual([
				expect.objectContaining({ sessionId: first.id, attemptCount: 1 }),
			]);
		} finally {
			firstGate.resolve();
			await service.shutdown();
			database.close();
		}
	});

	test("keeps one hung operation per Session while fairly deleting healthy checkpoint jobs", async () => {
		const database = openAppDatabase(":memory:");
		const hung = database.sessions.create({ title: "Permanent hang" }).session;
		const healthyOne = database.sessions.create({ title: "Healthy one" }).session;
		const healthyTwo = database.sessions.create({ title: "Healthy two" }).session;
		for (const session of [hung, healthyOne, healthyTwo]) {
			database.runs.deleteSessionAndRetireRuns(session.id);
		}
		const runtime = new FakeAskChatRuntime({
			deleteThreadImplementation: (threadId) =>
				threadId === hung.id ? new Promise<void>(() => undefined) : Promise.resolve(),
		});
		const service = createService(database, runtime, new ManualScheduler(), {
			checkpointDeletionAttemptTimeoutMs: 5,
			checkpointDeletionMaxInFlightAttempts: 4,
			checkpointDeletionRetryBaseMs: 1,
			checkpointDeletionRetryMaxMs: 1,
			checkpointDeletionStartupTimeoutMs: 25,
			shutdownTimeoutMs: 25,
			logger: { error() {} },
		});

		try {
			await service.drainPendingCheckpointDeletions({ batchSize: 3 });
			await waitUntil(
				() => database.runs.listPendingCheckpointDeletions(10, true).length === 1,
				100,
				"healthy checkpoint deletion fairness",
			);
			await Bun.sleep(25);
			expect(runtime.deletedThreadIds.filter((threadId) => threadId === hung.id)).toEqual([
				hung.id,
			]);
			expect(runtime.deletedThreadIds).toContain(healthyOne.id);
			expect(runtime.deletedThreadIds).toContain(healthyTwo.id);
			expect(database.runs.listPendingCheckpointDeletions(10, true)).toEqual([
				expect.objectContaining({ sessionId: hung.id, attemptCount: 1 }),
			]);
			await withDeadline(service.shutdown(), 100, "bounded hung deletion shutdown");
		} finally {
			await service.shutdown();
			database.close();
		}
	});

	test("retries a timed-out Session only after its underlying checkpoint deletion settles", async () => {
		const database = openAppDatabase(":memory:");
		const session = database.sessions.create({ title: "Eventually released" }).session;
		database.runs.deleteSessionAndRetireRuns(session.id);
		const firstGate = createDeferred();
		let calls = 0;
		const runtime = new FakeAskChatRuntime({
			deleteThreadImplementation: async () => {
				calls += 1;
				if (calls === 1) {
					await firstGate.promise;
				}
			},
		});
		const service = createService(database, runtime, new ManualScheduler(), {
			checkpointDeletionAttemptTimeoutMs: 5,
			checkpointDeletionRetryBaseMs: 1,
			checkpointDeletionRetryMaxMs: 1,
			logger: { error() {} },
		});

		try {
			expect(
				await service.retryPendingCheckpointDeletions({
					limit: 1,
					includeDeferred: true,
				}),
			).toEqual({ attempted: 1, succeeded: 0, failed: 1, remaining: 1 });
			expect(
				await service.retryPendingCheckpointDeletions({
					limit: 1,
					includeDeferred: true,
				}),
			).toEqual({ attempted: 0, succeeded: 0, failed: 0, remaining: 1 });
			expect(calls).toBe(1);

			firstGate.resolve();
			await waitUntil(
				() => database.runs.listPendingCheckpointDeletions(10, true).length === 0,
				100,
				"released checkpoint deletion retry",
			);
			expect(calls).toBe(2);
		} finally {
			firstGate.resolve();
			await service.shutdown();
			database.close();
		}
	});

	test("observes a checkpoint deletion rejection that arrives after its deadline", async () => {
		const database = openAppDatabase(":memory:");
		const session = database.sessions.create({ title: "Late rejection" }).session;
		database.runs.deleteSessionAndRetireRuns(session.id);
		let rejectDeletion: ((error: unknown) => void) | undefined;
		const deletion = new Promise<void>((_resolve, reject) => {
			rejectDeletion = reject;
		});
		const runtime = new FakeAskChatRuntime({ deleteThreadImplementation: () => deletion });
		const service = createService(database, runtime, new ManualScheduler(), {
			checkpointDeletionAttemptTimeoutMs: 5,
			checkpointDeletionRetryBaseMs: 1_000,
			checkpointDeletionRetryMaxMs: 1_000,
			logger: { error() {} },
		});
		const unhandled: unknown[] = [];
		const onUnhandled = (error: unknown): void => {
			unhandled.push(error);
		};
		process.on("unhandledRejection", onUnhandled);

		try {
			expect(
				await service.retryPendingCheckpointDeletions({
					limit: 1,
					includeDeferred: true,
				}),
			).toEqual({ attempted: 1, succeeded: 0, failed: 1, remaining: 1 });
			rejectDeletion?.(new Error("late checkpoint rejection"));
			await Bun.sleep(10);
			expect(unhandled).toEqual([]);
			expect(database.runs.listPendingCheckpointDeletions(10, true)).toHaveLength(1);
		} finally {
			process.off("unhandledRejection", onUnhandled);
			await service.shutdown();
			database.close();
		}
	});

	test("repeats idempotent checkpoint deletion when acknowledgement crashes", async () => {
		const database = openAppDatabase(":memory:");
		const session = database.sessions.create({ title: "Ack crash" }).session;
		database.runs.deleteSessionAndRetireRuns(session.id);
		let acknowledgementCalls = 0;
		const runs: RunJournalRepository = new Proxy(database.runs, {
			get(target, property) {
				if (property === "ackCheckpointDeletion") {
					return (sessionId: string) => {
						acknowledgementCalls += 1;
						if (acknowledgementCalls === 1) {
							throw new Error("simulated acknowledgement crash");
						}
						return target.ackCheckpointDeletion(sessionId);
					};
				}
				const value = Reflect.get(target, property, target);
				return typeof value === "function" ? value.bind(target) : value;
			},
		});
		const runtime = new FakeAskChatRuntime({});
		const service = createService(database, runtime, new ManualScheduler(), {
			runs,
			checkpointDeletionRetryBaseMs: 1,
			checkpointDeletionRetryMaxMs: 1,
			logger: { error() {} },
		});

		try {
			await withDeadline(
				service.drainPendingCheckpointDeletions({ batchSize: 1 }),
				250,
				"checkpoint acknowledgement recovery",
			);
			await waitUntil(
				() => database.runs.listPendingCheckpointDeletions(10, true).length === 0,
				250,
				"checkpoint acknowledgement background retry",
			);
			expect(runtime.deletedThreadIds).toEqual([session.id, session.id]);
			expect(acknowledgementCalls).toBe(2);
			expect(database.runs.listPendingCheckpointDeletions(10, true)).toEqual([]);
		} finally {
			await service.shutdown();
			database.close();
		}
	});

	test("settles startup recovery after one permanent failure without a tight retry loop", async () => {
		const database = openAppDatabase(":memory:");
		const session = database.sessions.create({ title: "Permanent cleanup failure" }).session;
		database.runs.deleteSessionAndRetireRuns(session.id);
		const runtime = new FakeAskChatRuntime({
			deleteThreadError: new Error("permanent checkpoint failure"),
		});
		const service = createService(database, runtime, new ManualScheduler(), {
			checkpointDeletionRetryBaseMs: 1_000,
			checkpointDeletionRetryMaxMs: 1_000,
			checkpointDeletionStartupTimeoutMs: 20,
			checkpointDeletionStartupMaxAttempts: 1,
			logger: { error() {} },
		});

		try {
			await withDeadline(
				service.drainPendingCheckpointDeletions({ batchSize: 1 }),
				100,
				"bounded permanent checkpoint recovery",
			);
			expect(runtime.deletedThreadIds).toEqual([session.id]);
			await Bun.sleep(25);
			expect(runtime.deletedThreadIds).toEqual([session.id]);
			expect(database.runs.listPendingCheckpointDeletions(10, true)).toHaveLength(1);
		} finally {
			await withDeadline(service.shutdown(), 100, "permanent checkpoint worker shutdown");
			const callsAfterShutdown = runtime.deletedThreadIds.length;
			await Bun.sleep(25);
			expect(runtime.deletedThreadIds).toHaveLength(callsAfterShutdown);
			database.close();
		}
	});

	test("backs off when checkpoint retry-state persistence fails and recovers after restart", async () => {
		const database = openAppDatabase(":memory:");
		const session = database.sessions.create({ title: "Retry-state persistence" }).session;
		database.runs.deleteSessionAndRetireRuns(session.id);
		let repositoryWritesAllowed = false;
		let retryStateWriteCalls = 0;
		let acknowledgementCalls = 0;
		let pendingListCalls = 0;
		const runs: RunJournalRepository = new Proxy(database.runs, {
			get(target, property) {
				if (property === "listPendingCheckpointDeletions") {
					return (limit: number, includeDeferred?: boolean) => {
						pendingListCalls += 1;
						return target.listPendingCheckpointDeletions(limit, includeDeferred);
					};
				}
				if (property === "recordCheckpointDeletionFailure") {
					return (sessionId: string, error: string, nextAttemptAtMs: number) => {
						retryStateWriteCalls += 1;
						if (!repositoryWritesAllowed) {
							throw new Error("simulated retry-state write failure");
						}
						return target.recordCheckpointDeletionFailure(sessionId, error, nextAttemptAtMs);
					};
				}
				if (property === "ackCheckpointDeletion") {
					return (sessionId: string) => {
						acknowledgementCalls += 1;
						if (!repositoryWritesAllowed) {
							throw new Error("simulated acknowledgement write failure");
						}
						return target.ackCheckpointDeletion(sessionId);
					};
				}
				const value = Reflect.get(target, property, target);
				return typeof value === "function" ? value.bind(target) : value;
			},
		});
		const runtime = new FakeAskChatRuntime({
			deleteThreadError: new Error("checkpoint deletion failed"),
			deleteThreadFailures: 1,
		});
		const errors: unknown[] = [];
		const unhandled: unknown[] = [];
		const onUnhandled = (error: unknown): void => {
			unhandled.push(error);
		};
		process.on("unhandledRejection", onUnhandled);
		const service = createService(database, runtime, new ManualScheduler(), {
			runs,
			checkpointDeletionRetryBaseMs: 60_000,
			checkpointDeletionRetryMaxMs: 60_000,
			logger: { error: (_message, error) => errors.push(error) },
		});
		let restarted: ChatApplicationService | undefined;

		try {
			await withDeadline(
				service.drainPendingCheckpointDeletions({ batchSize: 1 }),
				100,
				"retry-state persistence readiness",
			);
			await withDeadline(Bun.sleep(100), 250, "event-loop responsiveness");
			expect(runtime.deletedThreadIds).toEqual([session.id]);
			expect(retryStateWriteCalls).toBe(1);
			expect(pendingListCalls).toBe(1);
			expect(errors).toHaveLength(1);
			expect(unhandled).toEqual([]);
			expect(database.runs.listPendingCheckpointDeletions(10, true)).toEqual([
				expect.objectContaining({ sessionId: session.id, attemptCount: 0 }),
			]);
			await withDeadline(service.shutdown(), 100, "retry-state backoff shutdown");

			repositoryWritesAllowed = true;
			restarted = createService(database, runtime, new ManualScheduler(), {
				runs,
				checkpointDeletionRetryBaseMs: 1,
				checkpointDeletionRetryMaxMs: 1,
			});
			await withDeadline(
				restarted.drainPendingCheckpointDeletions({ batchSize: 1 }),
				100,
				"retry-state persistence recovery",
			);
			await waitUntil(
				() => database.runs.listPendingCheckpointDeletions(10, true).length === 0,
				100,
				"checkpoint acknowledgement recovery",
			);
			expect(runtime.deletedThreadIds).toEqual([session.id, session.id]);
			expect(acknowledgementCalls).toBe(1);
			expect(unhandled).toEqual([]);
		} finally {
			process.off("unhandledRejection", onUnhandled);
			await restarted?.shutdown();
			await service.shutdown();
			database.close();
		}
	});

	test("bounds readiness when checkpoint deletion hangs and cleans the worker on shutdown", async () => {
		const database = openAppDatabase(":memory:");
		const session = database.sessions.create({ title: "Hung cleanup" }).session;
		database.runs.deleteSessionAndRetireRuns(session.id);
		const gate = createDeferred();
		const runtime = new FakeAskChatRuntime({ deleteThreadGate: gate.promise });
		const service = createService(database, runtime, new ManualScheduler(), {
			checkpointDeletionStartupTimeoutMs: 10,
			checkpointDeletionStartupMaxAttempts: 1,
			logger: { error() {} },
		});

		try {
			await withDeadline(
				service.drainPendingCheckpointDeletions({ batchSize: 1 }),
				100,
				"hung checkpoint readiness",
			);
			expect(runtime.deletedThreadIds).toEqual([session.id]);
			await withDeadline(service.shutdown(), 100, "hung checkpoint worker shutdown");
			expect(database.runs.listPendingCheckpointDeletions(10, true)).toHaveLength(1);
		} finally {
			gate.resolve();
			await Promise.resolve();
			await service.shutdown();
			database.close();
		}
	});

	test("interrupts checkpoint retry backoff safely during shutdown", async () => {
		const database = openAppDatabase(":memory:");
		const session = database.sessions.create({ title: "Shutdown cleanup" }).session;
		database.runs.deleteSessionAndRetireRuns(session.id);
		const runtime = new FakeAskChatRuntime({
			deleteThreadError: new Error("persistent checkpoint failure"),
		});
		const service = createService(database, runtime, new ManualScheduler(), {
			checkpointDeletionRetryBaseMs: 60_000,
			checkpointDeletionRetryMaxMs: 60_000,
			logger: { error() {} },
		});
		const draining = service.drainPendingCheckpointDeletions({ batchSize: 1 });
		let shutDown = false;

		try {
			while (runtime.deletedThreadIds.length === 0) {
				await Promise.resolve();
			}
			await withDeadline(service.shutdown(), 250, "checkpoint recovery shutdown");
			shutDown = true;
			await draining;
			expect(database.runs.listPendingCheckpointDeletions(10, true)).toHaveLength(1);
		} finally {
			if (!shutDown) {
				await service.shutdown();
			}
			database.close();
		}
	});

	test("resnapshots a deleted Session exactly when its cursor support TTL expires", async () => {
		const database = openAppDatabase(":memory:");
		const scheduler = new ManualScheduler();
		let nowMs = retiredSessionTombstoneTtlMs;
		const runs = new SqliteRunJournalRepository(
			database.client,
			database.orm,
			{ create: createUuidV7 },
			{ now: () => nowMs },
		);
		const service = createService(
			database,
			new FakeAskChatRuntime({ deltas: ["done"] }),
			scheduler,
			{
				runs,
			},
		);

		try {
			configureProvider(service);
			const { session } = service.createSession();
			const accepted = service.sendMessage({ sessionId: session.id, content: "offline" });
			scheduler.runAll();
			await service.waitForIdle();
			await service.deleteSession({ sessionId: session.id });

			nowMs += retiredSessionTombstoneTtlMs - 1;
			expect(
				service.replayEvents({
					cursors: [
						{
							runId: accepted.run.id,
							sessionId: session.id,
							issuedAtMs: retiredSessionTombstoneTtlMs,
							lastSeq: 0,
						},
					],
				}).retiredSessionIds,
			).toEqual([session.id]);
			nowMs += 1;
			const expired = service.replayEvents({
				cursors: [
					{
						runId: accepted.run.id,
						sessionId: session.id,
						issuedAtMs: retiredSessionTombstoneTtlMs,
						lastSeq: 0,
					},
				],
			});
			expect(expired.retiredSessionIds).toEqual([]);
			expect(expired.resnapshotSessionIds).toEqual([session.id]);
		} finally {
			await service.shutdown();
			database.close();
		}
	});

	test("propagates replay Session repository failures instead of requesting a resnapshot", async () => {
		const database = openAppDatabase(":memory:");
		const repositoryFailure = new Error("private database read failure");
		const sessions = new Proxy(database.sessions, {
			get(target, property, receiver) {
				if (property === "get") {
					return () => {
						throw repositoryFailure;
					};
				}
				return Reflect.get(target, property, receiver);
			},
		}) as SessionRepository;
		const service = createService(database, new FakeAskChatRuntime({}), new ManualScheduler(), {
			sessions,
		});

		try {
			expect(() =>
				service.replayEvents({
					cursors: [
						{
							runId: createUuidV7(),
							sessionId: createUuidV7(),
							issuedAtMs: 0,
							lastSeq: 0,
						},
					],
				}),
			).toThrow(repositoryFailure);
		} finally {
			await service.shutdown();
			database.close();
		}
	});

	test("does not mask replay Run repository failures behind a retirement", async () => {
		const database = openAppDatabase(":memory:");
		const repositoryFailure = new Error("private Run database read failure");
		const runs = new Proxy(database.runs, {
			get(target, property, receiver) {
				if (property === "get") {
					return () => {
						throw repositoryFailure;
					};
				}
				if (property === "isSessionRetired") {
					return () => true;
				}
				return Reflect.get(target, property, receiver);
			},
		}) as RunJournalRepository;
		const service = createService(database, new FakeAskChatRuntime({}), new ManualScheduler(), {
			runs,
		});

		try {
			expect(() =>
				service.replayEvents({
					cursors: [
						{
							runId: createUuidV7(),
							sessionId: createUuidV7(),
							issuedAtMs: 0,
							lastSeq: 0,
						},
					],
				}),
			).toThrow(repositoryFailure);
		} finally {
			await service.shutdown();
			database.close();
		}
	});

	test("propagates corrupt replay Session rows instead of requesting a resnapshot", async () => {
		const database = openAppDatabase(":memory:");
		const session = database.sessions.create({ title: "Will be corrupted" }).session;
		database.client.query("UPDATE chat_sessions SET title = '' WHERE id = ?").run(session.id);
		const service = createService(database, new FakeAskChatRuntime({}), new ManualScheduler());

		try {
			expect(() =>
				service.replayEvents({
					cursors: [
						{
							runId: createUuidV7(),
							sessionId: session.id,
							issuedAtMs: 0,
							lastSeq: 0,
						},
					],
				}),
			).toThrow(ZodError);
		} finally {
			await service.shutdown();
			database.close();
		}
	});

	test("settles shutdown without waiting for a hung post-commit checkpoint cleanup", async () => {
		const database = openAppDatabase(":memory:");
		const deletionGate = createDeferred();
		const runtime = new FakeAskChatRuntime({ deleteThreadGate: deletionGate.promise });
		const service = createService(database, runtime, new ManualScheduler(), {
			checkpointDeletionAttemptTimeoutMs: 1_000,
			shutdownTimeoutMs: 20,
			logger: { error() {} },
		});
		try {
			const { session } = service.createSession();
			const deletion = service.deleteSession({ sessionId: session.id });
			expect(runtime.deletedThreadIds).toEqual([session.id]);
			await withDeadline(service.shutdown(), 100, "post-commit checkpoint shutdown");
			await deletion;
			expect(database.runs.listPendingCheckpointDeletions(10, true)).toHaveLength(1);
		} finally {
			deletionGate.resolve();
			await service.shutdown();
			database.close();
		}
	});

	test("blocks archiving and deleting a Session with an active response", async () => {
		const database = openAppDatabase(":memory:");
		const scheduler = new ManualScheduler();
		const service = createService(database, new FakeAskChatRuntime({ pending: true }), scheduler);

		try {
			configureProvider(service);
			const { session } = service.createSession();
			const accepted = service.sendMessage({ sessionId: session.id, content: "Wait" });

			expect(() => service.setSessionArchived({ sessionId: session.id, archived: true })).toThrow(
				"Stop the active response",
			);
			expect(() => service.deleteSession({ sessionId: session.id })).toThrow(
				"Stop the active response",
			);
			expect(() =>
				service.configureProvider({
					schemaVersion: 1,
					baseUrl: "https://example.test/v1",
					model: "another-model",
				}),
			).toThrow("Stop active responses");
			expect(() => service.deleteProvider()).toThrow("Stop active responses");
			service.cancel({ runId: accepted.run.id });
		} finally {
			await service.shutdown();
			database.close();
		}
	});

	test("reserves a Session before synchronously publishing orphan finalization", async () => {
		const database = openAppDatabase(":memory:");
		const scheduler = new ManualScheduler();
		const orphaned = createOrphanedRun(database, "running");
		const runtime = new FakeAskChatRuntime({ deltas: ["new answer"] });
		const service = createService(database, runtime, scheduler);
		let reentrantError: unknown;

		try {
			configureProvider(service);
			service.subscribe((event) => {
				if (event.runId === orphaned.runId && event.type === "message.completed") {
					try {
						service.sendMessage({
							sessionId: orphaned.sessionId,
							content: "synchronous reentry",
						});
					} catch (error) {
						reentrantError = error;
					}
				}
			});

			const accepted = service.sendMessage({
				sessionId: orphaned.sessionId,
				content: "the one scheduled Run",
			});
			expect(reentrantError).toBeInstanceOf(AskChatRuntimeError);
			expect((reentrantError as Error).message).toContain("active response");
			expect(database.runs.listBySession(orphaned.sessionId)).toHaveLength(2);
			scheduler.runAll();
			await service.waitForIdle();
			expect(runtime.inputs.map((input) => input.runId)).toEqual([accepted.run.id]);
		} finally {
			await service.shutdown();
			database.close();
		}
	});

	test("keeps asynchronous orphan reentry behind the converted active Run", async () => {
		const database = openAppDatabase(":memory:");
		const scheduler = new ManualScheduler();
		const orphaned = createOrphanedRun(database, "running");
		const runtime = new FakeAskChatRuntime({ deltas: ["new answer"] });
		const service = createService(database, runtime, scheduler);
		let reentrant: Promise<unknown> | undefined;

		try {
			configureProvider(service);
			service.subscribe((event) => {
				if (event.runId === orphaned.runId && event.type === "message.completed") {
					reentrant = Promise.resolve().then(() => {
						try {
							return service.sendMessage({
								sessionId: orphaned.sessionId,
								content: "asynchronous reentry",
							});
						} catch (error) {
							return error;
						}
					});
				}
			});

			const accepted = service.sendMessage({
				sessionId: orphaned.sessionId,
				content: "outer send",
			});
			expect(await reentrant).toBeInstanceOf(AskChatRuntimeError);
			scheduler.runAll();
			await service.waitForIdle();
			expect(runtime.inputs.map((input) => input.runId)).toEqual([accepted.run.id]);
		} finally {
			await service.shutdown();
			database.close();
		}
	});

	test("cleans a failed start reservation on orphan-free and archived paths", async () => {
		const database = openAppDatabase(":memory:");
		const scheduler = new ManualScheduler();
		const runtime = new FakeAskChatRuntime({ deltas: ["done"] });
		const service = createService(database, runtime, scheduler);

		try {
			configureProvider(service);
			const { session } = service.createSession();
			service.setSessionArchived({ sessionId: session.id, archived: true });
			expect(() =>
				service.sendMessage({ sessionId: session.id, content: "archived failure" }),
			).toThrow("Archived chat Sessions");
			service.setSessionArchived({ sessionId: session.id, archived: false });

			let reentrantError: unknown;
			service.subscribe((event) => {
				if (event.type === "run.status" && event.payload.status === "queued") {
					try {
						service.sendMessage({ sessionId: session.id, content: "queued reentry" });
					} catch (error) {
						reentrantError = error;
					}
				}
			});
			const accepted = service.sendMessage({
				sessionId: session.id,
				content: "works after cleanup",
			});
			expect(reentrantError).toBeInstanceOf(AskChatRuntimeError);
			scheduler.runAll();
			await service.waitForIdle();
			expect(runtime.inputs.map((input) => input.runId)).toEqual([accepted.run.id]);
		} finally {
			await service.shutdown();
			database.close();
		}
	});

	test("finalizes orphaned Runs after an application restart", async () => {
		const database = openAppDatabase(":memory:");
		const scheduler = new ManualScheduler();
		const service = createService(database, new FakeAskChatRuntime({}), scheduler);
		const cancelling = createOrphanedRun(database, "cancelling");
		const running = createOrphanedRun(database, "running");
		const deleting = createOrphanedRun(database, "running");
		const sending = createOrphanedRun(database, "running");

		try {
			configureProvider(service);
			expect(service.cancel({ runId: cancelling.runId }).run.status).toBe("cancelled");
			expect(
				(await service.getSession({ sessionId: cancelling.sessionId })).messages.at(-1)?.status,
			).toBe("cancelled");

			expect(
				service.setSessionArchived({
					sessionId: running.sessionId,
					archived: true,
				}).session.archivedAt,
			).toBeDefined();
			const recovered = await service.getSession({
				sessionId: running.sessionId,
			});
			expect(recovered.runs[0]?.status).toBe("cancelled");
			expect(recovered.messages.at(-1)?.status).toBe("cancelled");

			await service.deleteSession({ sessionId: deleting.sessionId });
			await expect(service.getSession({ sessionId: deleting.sessionId })).rejects.toThrow();

			const accepted = service.sendMessage({
				sessionId: sending.sessionId,
				content: "Recovered question",
			});
			expect(database.runs.get(sending.runId).status).toBe("cancelled");
			expect(accepted.run.status).toBe("queued");
			service.cancel({ runId: accepted.run.id });

			const replaying = createOrphanedRun(database, "running");
			const replay = service.replayEvents({
				cursors: [
					{
						runId: replaying.runId,
						sessionId: replaying.sessionId,
						issuedAtMs: Date.now(),
						lastSeq: 0,
					},
				],
			});
			expect(replay.events.some((event) => event.type === "message.completed")).toBe(true);
			expect(database.runs.get(replaying.runId).status).toBe("cancelled");

			const oversized = createOrphanedRun(database, "running");
			for (let index = 0; index < 26; index += 1) {
				database.runs.appendEvent({
					runId: oversized.runId,
					type: "message.delta",
					source: { kind: "assistant" },
					payload: {
						messageId: oversized.assistantMessageId,
						delta: "x".repeat(8_000),
					},
				});
			}
			const oversizedRecovery = await service.getSession({
				sessionId: oversized.sessionId,
			});
			expect(oversizedRecovery.runs[0]?.status).toBe("failed");
			expect(oversizedRecovery.runs[0]?.lastError?.code).toBe("CHAT_OUTPUT_LIMIT_EXCEEDED");
			expect(oversizedRecovery.messages.at(-1)?.content).toHaveLength(
				maxAssistantMessageContentCharacters,
			);
		} finally {
			await service.shutdown();
			database.close();
		}
	});

	test("recovers a 100k-row legacy delta journal with bounded forward paging", async () => {
		const database = openAppDatabase(":memory:");
		const scheduler = new ManualScheduler();
		const orphaned = createOrphanedRun(database, "running");
		insertSmallDeltaFixture(database, orphaned, 100_000);
		const service = createService(database, new FakeAskChatRuntime({}), scheduler);

		try {
			const startedAt = performance.now();
			const replay = service.replayEvents({
				cursors: [
					{
						runId: orphaned.runId,
						sessionId: orphaned.sessionId,
						issuedAtMs: Date.now(),
						lastSeq: 0,
					},
				],
			});
			expect(performance.now() - startedAt).toBeLessThan(10_000);
			expect(replay.events).toHaveLength(maxReplayEventsPerPage);
			expect(replay.hasMore).toBe(true);
			expect(database.runs.get(orphaned.runId).status).toBe("cancelled");
			const snapshot = await service.getSession({ sessionId: orphaned.sessionId });
			expect(snapshot.messages.at(-1)?.content).toHaveLength(100_000);
		} finally {
			await service.shutdown();
			database.close();
		}
	});
});

function createOrphanedRun(
	database: ReturnType<typeof openAppDatabase>,
	status: "running" | "cancelling",
) {
	const { session } = database.sessions.create({ title: "Interrupted chat" });
	const created = database.runs.create({
		clientRequestId: crypto.randomUUID(),
		sessionId: session.id,
		mode: "ask",
		provider: {
			schemaVersion: 1,
			providerId: createUuidV7(),
			name: "OpenAI",
			baseUrl: "https://api.openai.com/v1",
			model: "gpt-4.1-mini",
			apiKey: "sk-test-secret",
		},
		userMessageId: createUuidV7(),
		userContent: "Interrupted prompt",
		assistantMessageId: createUuidV7(),
	});
	database.runs.updateStatus({ runId: created.run.id, status: "running" });
	if (status === "cancelling") {
		database.runs.updateStatus({ runId: created.run.id, status: "cancelling" });
	}
	const assistantMessageId = created.run.assistantMessageId;
	if (assistantMessageId === undefined) {
		throw new Error("Expected orphaned Run assistant message ID.");
	}
	return {
		sessionId: session.id,
		runId: created.run.id,
		assistantMessageId,
	};
}

function insertSmallDeltaFixture(
	database: ReturnType<typeof openAppDatabase>,
	run: ReturnType<typeof createOrphanedRun>,
	count: number,
): void {
	const firstSeq = 4;
	const lastSeq = firstSeq + count - 1;
	const payloadJson = JSON.stringify({
		messageId: run.assistantMessageId,
		delta: "x",
	});
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
			runId: run.runId,
			sessionId: run.sessionId,
			payloadJson,
			createdAtMs: Date.now(),
		});
}

function createService(
	database: ReturnType<typeof openAppDatabase>,
	runtime: AskChatRuntime,
	scheduler: ManualScheduler,
	options: {
		runs?: RunJournalRepository;
		sessions?: SessionRepository;
		logger?: { error(message: string, error: unknown): void };
		providerConfigStore?: AskProviderConfigStore;
		testProviderConnection?: (configuration: AskProviderConfiguration) => Promise<void>;
		isRuntimeReady?: () => boolean;
		checkpointDeletionRetryBaseMs?: number;
		checkpointDeletionRetryMaxMs?: number;
		checkpointDeletionAttemptTimeoutMs?: number;
		checkpointDeletionMaxInFlightAttempts?: number;
		checkpointDeletionStartupTimeoutMs?: number;
		checkpointDeletionStartupMaxAttempts?: number;
		shutdownTimeoutMs?: number;
	} = {},
) {
	return new ChatApplicationService({
		sessions: options.sessions ?? database.sessions,
		runs: options.runs ?? database.runs,
		providerConfigStore: options.providerConfigStore ?? new InMemoryAskProviderConfigStore(),
		runtime,
		schedule: scheduler.schedule,
		...(options.logger === undefined ? {} : { logger: options.logger }),
		...(options.testProviderConnection === undefined
			? {}
			: { testProviderConnection: options.testProviderConnection }),
		...(options.isRuntimeReady === undefined ? {} : { isRuntimeReady: options.isRuntimeReady }),
		...(options.checkpointDeletionRetryBaseMs === undefined
			? {}
			: { checkpointDeletionRetryBaseMs: options.checkpointDeletionRetryBaseMs }),
		...(options.checkpointDeletionRetryMaxMs === undefined
			? {}
			: { checkpointDeletionRetryMaxMs: options.checkpointDeletionRetryMaxMs }),
		...(options.checkpointDeletionAttemptTimeoutMs === undefined
			? {}
			: { checkpointDeletionAttemptTimeoutMs: options.checkpointDeletionAttemptTimeoutMs }),
		...(options.checkpointDeletionMaxInFlightAttempts === undefined
			? {}
			: {
					checkpointDeletionMaxInFlightAttempts: options.checkpointDeletionMaxInFlightAttempts,
				}),
		...(options.checkpointDeletionStartupTimeoutMs === undefined
			? {}
			: { checkpointDeletionStartupTimeoutMs: options.checkpointDeletionStartupTimeoutMs }),
		...(options.checkpointDeletionStartupMaxAttempts === undefined
			? {}
			: { checkpointDeletionStartupMaxAttempts: options.checkpointDeletionStartupMaxAttempts }),
		...(options.shutdownTimeoutMs === undefined
			? {}
			: { shutdownTimeoutMs: options.shutdownTimeoutMs }),
	});
}

function configureProvider(service: ChatApplicationService): void {
	service.configureProvider({
		schemaVersion: 1,
		baseUrl: "https://api.openai.com/v1",
		model: "gpt-4.1-mini",
		apiKey: "sk-test-secret",
	});
}

class ManualScheduler {
	readonly #tasks: Array<() => void> = [];
	readonly schedule = (task: () => void) => {
		this.#tasks.push(task);
	};

	runAll(): void {
		for (const task of this.#tasks.splice(0)) {
			task();
		}
	}
}

function createDeferred(): { promise: Promise<void>; resolve(): void } {
	let resolvePromise: (() => void) | undefined;
	const promise = new Promise<void>((resolve) => {
		resolvePromise = resolve;
	});
	return {
		promise,
		resolve() {
			resolvePromise?.();
		},
	};
}

async function withDeadline<T>(promise: Promise<T>, timeoutMs: number, label: string): Promise<T> {
	let timer: ReturnType<typeof setTimeout> | undefined;
	try {
		return await Promise.race([
			promise,
			new Promise<never>((_resolve, reject) => {
				timer = setTimeout(() => reject(new Error(`${label} exceeded ${timeoutMs}ms.`)), timeoutMs);
			}),
		]);
	} finally {
		if (timer !== undefined) {
			clearTimeout(timer);
		}
	}
}

async function waitUntil(
	predicate: () => boolean,
	timeoutMs: number,
	label: string,
): Promise<void> {
	const deadline = Date.now() + timeoutMs;
	while (!predicate()) {
		if (Date.now() > deadline) {
			throw new Error(`${label} exceeded ${timeoutMs}ms.`);
		}
		await Bun.sleep(1);
	}
}

class FakeAskChatRuntime implements AskChatRuntime {
	readonly inputs: AskChatRunInput[] = [];
	readonly cancelledRunIds: string[] = [];
	readonly cancelAttempts: string[] = [];
	readonly deletedThreadIds: string[] = [];
	getThreadMessagesCalls = 0;
	readonly started: Promise<void>;
	readonly #deltas: string[];
	readonly #pending: boolean;
	readonly #ignoreEventErrors: boolean;
	readonly #resultText: string | undefined;
	readonly #deleteThreadGate: Promise<void> | undefined;
	readonly #deleteThreadError: Error | undefined;
	readonly #deleteThreadImplementation:
		| ((threadId: string, signal?: AbortSignal) => Promise<void>)
		| undefined;
	#deleteThreadFailuresRemaining: number | undefined;
	readonly #error: unknown;
	readonly #pendingRuns = new Map<string, { reject(error: AskChatCancelledError): void }>();
	readonly #threadMessages = new Map<string, AskChatMessage[]>();
	#resolveStarted: () => void = () => {};

	constructor(options: {
		deltas?: string[];
		pending?: boolean;
		ignoreEventErrors?: boolean;
		resultText?: string;
		deleteThreadGate?: Promise<void>;
		deleteThreadError?: Error;
		deleteThreadFailures?: number;
		deleteThreadImplementation?: (threadId: string, signal?: AbortSignal) => Promise<void>;
		error?: unknown;
	}) {
		this.#deltas = options.deltas ?? [];
		this.#pending = options.pending ?? false;
		this.#ignoreEventErrors = options.ignoreEventErrors ?? false;
		this.#resultText = options.resultText;
		this.#deleteThreadGate = options.deleteThreadGate;
		this.#deleteThreadError = options.deleteThreadError;
		this.#deleteThreadFailuresRemaining = options.deleteThreadFailures;
		this.#deleteThreadImplementation = options.deleteThreadImplementation;
		this.#error = options.error;
		this.started = new Promise((resolve) => {
			this.#resolveStarted = resolve;
		});
	}

	async run(input: AskChatRunInput): Promise<AskChatRunResult> {
		this.inputs.push(input);
		this.#resolveStarted();
		const threadId = input.threadId ?? input.runId;
		const messages = this.#threadMessages.get(threadId) ?? [];
		messages.push(...input.messages.map((message) => ({ ...message })));
		this.#threadMessages.set(threadId, messages);

		if (this.#error !== undefined) {
			throw this.#error;
		}

		for (const delta of this.#deltas) {
			try {
				await input.onEvent?.({
					type: "message.delta",
					runId: input.runId,
					delta,
				});
			} catch (error) {
				if (!this.#ignoreEventErrors) {
					throw error;
				}
			}
		}
		if (this.#pending) {
			return new Promise<AskChatRunResult>((_resolve, reject) => {
				this.#pendingRuns.set(input.runId, { reject });
			});
		}
		const text = this.#resultText ?? this.#deltas.join("");
		messages.push({ role: "assistant", content: text });

		return {
			runId: input.runId,
			text,
		};
	}

	stream(_input: AskChatRunInput): AskChatRunStream {
		throw new Error("FakeAskChatRuntime.stream is not used by ChatApplicationService.");
	}

	cancel(runId: string, reason?: string): boolean {
		this.cancelAttempts.push(runId);
		const pending = this.#pendingRuns.get(runId);
		if (pending === undefined) {
			return false;
		}

		this.cancelledRunIds.push(runId);
		this.#pendingRuns.delete(runId);
		pending.reject(new AskChatCancelledError(runId, reason));
		return true;
	}

	async deleteThread(threadId: string, signal?: AbortSignal): Promise<void> {
		this.deletedThreadIds.push(threadId);
		if (this.#deleteThreadImplementation !== undefined) {
			await this.#deleteThreadImplementation(threadId, signal);
			return;
		}
		await this.#deleteThreadGate;
		if (
			this.#deleteThreadError !== undefined &&
			(this.#deleteThreadFailuresRemaining === undefined || this.#deleteThreadFailuresRemaining > 0)
		) {
			if (this.#deleteThreadFailuresRemaining !== undefined) {
				this.#deleteThreadFailuresRemaining -= 1;
			}
			throw this.#deleteThreadError;
		}
		this.#threadMessages.delete(threadId);
	}

	async getThreadMessages(threadId: string): Promise<AskChatMessage[]> {
		this.getThreadMessagesCalls += 1;
		return (this.#threadMessages.get(threadId) ?? []).map((message) => ({
			...message,
		}));
	}

	async shutdown(): Promise<void> {
		for (const runId of [...this.#pendingRuns.keys()]) {
			this.cancel(runId, "Shutdown");
		}
	}
}
