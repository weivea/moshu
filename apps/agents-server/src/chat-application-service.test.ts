import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";

import {
	AskChatCancelledError,
	type AskChatMessage,
	type AskChatRunInput,
	type AskChatRunResult,
	type AskChatRunStream,
	type AskChatRuntime,
	AskChatRuntimeError,
	ProviderCapacityError,
	ProviderModelNotFoundError,
	ProviderNotFoundError,
	type ProviderRecord,
	type ProviderRegistry,
} from "@moshu/agent-runtime";
import {
	type ChatRunEvent,
	type ChatRunSnapshot,
	type DefaultModelSelection,
	defaultLocalRuntimeBoxId,
	maxAppErrorSafeMessageCharacters,
	maxChatTextPartContentCharacters,
	maxProviderCount,
	maxReplayEventBytesPerPage,
	maxReplayEventsPerPage,
	productRpcMaxFrameBytes,
	type ProviderModel,
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

import {
	ChatApplicationService,
	type ChatApplicationServiceOptions,
} from "./chat-application-service";
import {
	ProjectApplicationService,
	ProjectArchivedError,
	ProjectPathUnavailableError,
	ProjectRuntimeUnavailableError,
} from "./project-application-service";
import { RuntimeBoxUnavailableError } from "./runtime-box-registry";

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
			const { session } = service.createSession();
			expect(session.defaultMode).toBe("agent");
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
			expect(accepted.run.mode).toBe("agent");
			expect(accepted.run.timeline).toEqual([]);
			scheduler.runAll();
			await service.waitForIdle();

			const restored = await service.getSession({ sessionId: session.id });
			expect(restored.session.title).toBe("Say hello");
			expect(snapshotMessages(restored).map((message) => message.content)).toEqual([
				"Say hello",
				"Hello world",
			]);
			expect(lastTextPart(restored.runs[0])?.status).toBe("completed");
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
				"run.status",
				"timeline.part.created",
				"timeline.text.delta",
				"timeline.text.delta",
				"timeline.text.completed",
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
			expect(published.map((event) => event.seq)).toEqual([1, 2]);
			expect(published.map((event) => event.type)).toEqual(["run.status", "run.status"]);
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
			expect(published.map((event) => event.seq)).toEqual([1, 2]);
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
			const { session } = service.createSession();
			const accepted = service.sendMessage({ sessionId: session.id, content: "fill boundary" });
			scheduler.runAll();
			await service.waitForIdle();

			const snapshot = await service.getSession({ sessionId: session.id });
			expect(snapshot.runs[0]?.status).toBe("completed");
			expect(snapshotMessages(snapshot).at(-1)?.content).toHaveLength(
				maxChatTextPartContentCharacters,
			);
			expect(
				database.runs
					.listEvents({ runId: accepted.run.id })
					.filter((event) => event.type === "timeline.text.delta"),
			).toHaveLength(25);
		} finally {
			await service.shutdown();
			database.close();
		}
	});

	test("persists token-sized deltas in exact order", async () => {
		const database = openAppDatabase(":memory:");
		const scheduler = new ManualScheduler();
		const runtime = new FakeAskChatRuntime({
			deltas: Array.from({ length: 100 }, () => "x"),
		});
		const service = createService(database, runtime, scheduler);

		try {
			const { session } = service.createSession();
			const accepted = service.sendMessage({ sessionId: session.id, content: "many tokens" });
			scheduler.runAll();
			await service.waitForIdle();

			const deltas = database.runs
				.listEvents({ runId: accepted.run.id })
				.filter((event) => event.type === "timeline.text.delta");
			expect(deltas).toHaveLength(100);
			expect(deltas.every((event) => event.payload.delta.length <= 8_000)).toBe(true);
			expect(deltas.map((event) => event.payload.delta).join("")).toHaveLength(100);
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
			const { session } = service.createSession();
			const accepted = service.sendMessage({ sessionId: session.id, content: "large chunk" });
			scheduler.runAll();
			await service.waitForIdle();

			expect(database.runs.get(accepted.run.id).status).toBe("completed");
			expect(
				database.runs
					.listEvents({ runId: accepted.run.id })
					.filter((event) => event.type === "timeline.text.delta")
					.map((event) => (event.type === "timeline.text.delta" ? event.payload.delta.length : 0)),
			).toEqual([8_000, 1, 1]);
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
			const { session } = service.createSession();
			const accepted = service.sendMessage({ sessionId: session.id, content: "cancel reentry" });
			let cancelled = false;
			service.subscribe((event) => {
				if (!cancelled && event.type === "timeline.text.delta") {
					cancelled = true;
					service.cancel({ runId: accepted.run.id, reason: "listener cancellation" });
				}
			});
			scheduler.runAll();
			await service.waitForIdle();

			const events = database.runs.listEvents({ runId: accepted.run.id });
			const terminalIndex = events.findIndex((event) => event.type === "timeline.text.completed");
			expect(
				events.slice(terminalIndex + 1).some((event) => event.type === "timeline.text.delta"),
			).toBe(false);
			expect(
				events
					.filter((event) => event.type === "timeline.text.delta")
					.map((event) => (event.type === "timeline.text.delta" ? event.payload.delta.length : 0)),
			).toEqual([8_000]);
			expect(database.runs.get(accepted.run.id).status).toBe("cancelled");
		} finally {
			await service.shutdown();
			database.close();
		}
	});

	test("persists a small delta promptly and orders reentrant cancellation after it", async () => {
		const database = openAppDatabase(":memory:");
		const scheduler = new ManualScheduler();
		const runtime = new FakeAskChatRuntime({ deltas: ["a", "b"], pending: true });
		const service = createService(database, runtime, scheduler);
		const published: ChatRunEvent[] = [];

		try {
			const { session } = service.createSession();
			const accepted = service.sendMessage({ sessionId: session.id, content: "stream quickly" });
			const deltaPublished = new Promise<void>((resolve) => {
				service.subscribe((event) => {
					published.push(event);
					if (event.type === "timeline.text.delta") {
						service.cancel({ runId: accepted.run.id, reason: "reentrant stop" });
						resolve();
					}
				});
			});
			scheduler.runAll();
			await withDeadline(deltaPublished, 250, "streamed delta flush");
			await service.waitForIdle();

			const events = database.runs.listEvents({ runId: accepted.run.id });
			const deltaIndex = events.findIndex((event) => event.type === "timeline.text.delta");
			const terminalIndex = events.findIndex((event) => event.type === "timeline.text.completed");
			expect(
				events[deltaIndex]?.type === "timeline.text.delta" && events[deltaIndex].payload.delta,
			).toBe("a");
			expect(deltaIndex).toBeGreaterThan(-1);
			expect(terminalIndex).toBeGreaterThan(deltaIndex);
			expect(
				events.slice(terminalIndex + 1).some((event) => event.type === "timeline.text.delta"),
			).toBe(false);
			expect(
				published.findIndex((event) => event.type === "timeline.text.completed"),
			).toBeGreaterThan(published.findIndex((event) => event.type === "timeline.text.delta"));
			expect(database.runs.get(accepted.run.id).status).toBe("cancelled");
		} finally {
			await service.shutdown();
			database.close();
		}
	});

	test("persists a pending delta before an immediate cancellation terminal", async () => {
		const database = openAppDatabase(":memory:");
		const scheduler = new ManualScheduler();
		const runtime = new FakeAskChatRuntime({
			deltas: ["pending-before-cancel"],
			pending: true,
		});
		const service = createService(database, runtime, scheduler);

		try {
			const { session } = service.createSession();
			const accepted = service.sendMessage({ sessionId: session.id, content: "cancel now" });
			scheduler.runAll();
			await runtime.started;
			service.cancel({ runId: accepted.run.id, reason: "immediate stop" });
			await service.waitForIdle();

			const events = database.runs.listEvents({ runId: accepted.run.id });
			const deltaIndex = events.findIndex((event) => event.type === "timeline.text.delta");
			const terminalIndex = events.findIndex((event) => event.type === "timeline.text.completed");
			expect(
				events[deltaIndex]?.type === "timeline.text.delta"
					? events[deltaIndex].payload.delta
					: undefined,
			).toBe("pending-before-cancel");
			expect(terminalIndex).toBeGreaterThan(deltaIndex);
			expect(
				events.slice(terminalIndex + 1).some((event) => event.type === "timeline.text.delta"),
			).toBe(false);
		} finally {
			await service.shutdown();
			database.close();
		}
	});

	test("hydrates snapshots through their latest durable revision", async () => {
		const database = openAppDatabase(":memory:");
		const scheduler = new ManualScheduler();
		const runtime = new FakeAskChatRuntime({ deltas: ["pending-delta"], pending: true });
		const service = createService(database, runtime, scheduler);

		try {
			const { session } = service.createSession();
			const accepted = service.sendMessage({
				sessionId: session.id,
				content: "snapshot while coalescing",
			});
			scheduler.runAll();
			await runtime.started;

			const beforeFlush = await service.getSessionSnapshot({ sessionId: session.id });
			const cursor = beforeFlush.runs.find((run) => run.id === accepted.run.id);
			expect(lastTextPart(cursor)?.content).toBe("pending-delta");
			const replay = service.replayEvents({
				cursors: [
					{
						runId: accepted.run.id,
						sessionId: session.id,
						issuedAtMs: beforeFlush.session.updatedAt === undefined ? 0 : Date.now(),
						lastSeq: cursor?.lastEventSeq ?? 0,
					},
				],
			});
			expect(replay.events).toEqual([]);
			expect(
				lastTextPart((await service.getSessionSnapshot({ sessionId: session.id })).runs.at(-1))
					?.content,
			).toBe("pending-delta");
			expect(cursor?.lastEventSeq).toBe(
				database.runs.listEvents({ runId: accepted.run.id }).at(-1)?.seq,
			);
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
			const { session } = service.createSession();
			const accepted = service.sendMessage({ sessionId: session.id, content: "append fails" });
			scheduler.runAll();
			await service.waitForIdle();

			expect(appendAttempts).toBe(1);
			expect(runtime.cancelAttempts).toContain(accepted.run.id);
			const restored = await service.getSession({ sessionId: session.id });
			expect(restored.runs[0]?.status).toBe("failed");
			expect(lastTextPart(restored.runs[0])?.content ?? "").toBe("");
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
						if (input.status === "failed") {
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
			const recovered = await restarted.getSession({ sessionId: session.id });
			expect(recovered.runs[0]?.status).toBe("failed");
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
			await expect(
				service.createProvider({
					schemaVersion: 2,
					displayName: "Other",
					api: "openai-responses",
					baseUrl: "https://api.openai.com/v1",
					apiKey: "sk-other",
				}),
			).rejects.toThrow("persistence is unavailable");
			await expect(
				service.deleteProvider({ schemaVersion: 2, providerId: createUuidV7() }),
			).rejects.toThrow("persistence is unavailable");
			await expect(
				service.testProvider({ schemaVersion: 2, providerId: createUuidV7() }),
			).rejects.toThrow("persistence is unavailable");
			expect(commitAttempts).toBe(1);
			await Promise.resolve();
			expect(unhandled).toEqual([]);

			await service.shutdown();
			restarted = createService(database, new FakeAskChatRuntime({}), new ManualScheduler());
			const recovered = await restarted.getSession({ sessionId: orphaned.sessionId });
			expect(recovered.runs[0]?.status).toBe("failed");
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
			const assistant = lastTextPart(snapshot.runs[0]);
			expect(snapshot.runs[0]?.status).toBe("failed");
			expect(snapshot.runs[0]?.lastError?.code).toBe("CHAT_OUTPUT_LIMIT_EXCEEDED");
			expect(assistant?.content).toHaveLength(maxChatTextPartContentCharacters);
			expect(runtime.cancelAttempts).toContain(accepted.run.id);
			const deltas = database.runs
				.listEvents({ runId: accepted.run.id })
				.filter((event) => event.type === "timeline.text.delta");
			expect(
				deltas.reduce(
					(length, event) =>
						event.type === "timeline.text.delta" ? length + event.payload.delta.length : length,
					0,
				),
			).toBe(maxChatTextPartContentCharacters);
			expect(
				deltas.some(
					(event) =>
						event.type === "timeline.text.delta" &&
						(event.payload.delta === "yz" || event.payload.delta === "late-output"),
				),
			).toBe(false);
			const retry = service.sendMessage({
				requestId,
				sessionId: session.id,
				content: "overflow",
			});
			expect(retry.run.id).toBe(accepted.run.id);
			expect(retry.run.status).toBe("failed");
			expect(lastTextPart(retry.run)?.content).toHaveLength(maxChatTextPartContentCharacters);
		} finally {
			await service.shutdown();
			database.close();
		}
	});

	test("fails a bounded projection when final text exceeds the limit without deltas", async () => {
		const database = openAppDatabase(":memory:");
		const scheduler = new ManualScheduler();
		const runtime = new FakeAskChatRuntime({
			resultText: "z".repeat(maxChatTextPartContentCharacters + 1),
		});
		const service = createService(database, runtime, scheduler);

		try {
			const { session } = service.createSession();
			service.sendMessage({ sessionId: session.id, content: "oversized final" });
			scheduler.runAll();
			await service.waitForIdle();

			const snapshot = await service.getSession({ sessionId: session.id });
			expect(snapshot.runs[0]?.status).toBe("failed");
			expect(snapshot.runs[0]?.lastError?.code).toBe("CHAT_OUTPUT_LIMIT_EXCEEDED");
			expect(lastTextPart(snapshot.runs[0])?.content).toHaveLength(
				maxChatTextPartContentCharacters,
			);
		} finally {
			await service.shutdown();
			database.close();
		}
	});

	test("rejects new Runs while the Runtime Box is not ready", () => {
		const database = openAppDatabase(":memory:");
		let ready = true;
		const service = createService(database, new FakeAskChatRuntime({}), new ManualScheduler(), {
			isRuntimeReady: () => ready,
		});
		const { session } = service.createSession();
		ready = false;

		expect(() => service.sendMessage({ sessionId: session.id, content: "blocked" })).toThrow(
			"Runtime Box is not authenticated and ready",
		);
		expect(() => service.createSession()).toThrow("Runtime Box is not authenticated and ready");
		expect(() => service.updateSession({ sessionId: session.id, title: "Blocked" })).toThrow(
			"Runtime Box is not authenticated and ready",
		);
		expect(() => service.setSessionArchived({ sessionId: session.id, archived: true })).toThrow(
			"Runtime Box is not authenticated and ready",
		);
		expect(() => service.setSessionModel({ sessionId: session.id, model: null })).toThrow(
			"Runtime Box is not authenticated and ready",
		);
		expect(() => service.deleteSession({ sessionId: session.id })).toThrow(
			"Runtime Box is not authenticated and ready",
		);
		expect(database.runs.listBySession(session.id)).toEqual([]);
		database.close();
	});

	test("notifies retirement on a direct session delete so subscriptions are cleaned up centrally", async () => {
		const database = openAppDatabase(":memory:");
		const retiredBatches: string[][] = [];
		const service = createService(database, new FakeAskChatRuntime({}), new ManualScheduler(), {
			onSessionsRetired: (sessionIds) => {
				retiredBatches.push([...sessionIds]);
			},
		});
		try {
			const { session } = service.createSession();
			await expect(service.deleteSession({ sessionId: session.id })).resolves.toEqual({
				sessionId: session.id,
			});
			// The direct delete path must publish retirement exactly like a Project retirement so the
			// event hub tears down any live subscriptions for the deleted Session.
			expect(retiredBatches).toEqual([[session.id]]);
			// Re-deleting an already-retired Session must not re-notify.
			await expect(service.deleteSession({ sessionId: session.id })).resolves.toEqual({
				sessionId: session.id,
			});
			expect(retiredBatches).toEqual([[session.id]]);
		} finally {
			await service.shutdown();
			database.close();
		}
	});

	test("replays a committed Session create key while its Runtime Box is offline", async () => {
		const database = openAppDatabase(":memory:");
		let ready = true;
		const service = createService(database, new FakeAskChatRuntime({}), new ManualScheduler(), {
			isRuntimeReady: () => ready,
		});

		const request = {
			schemaVersion: 1 as const,
			createKey: crypto.randomUUID(),
			title: "Recovered Session",
			defaultMode: "agent" as const,
		};
		const origin = {
			role: "client" as const,
			peerId: "desktop-client",
			instanceId: crypto.randomUUID(),
			generation: 1,
		};
		try {
			const created = await service.createSessionIdempotently(request, origin);
			ready = false;
			await expect(service.createSessionIdempotently(request, origin)).resolves.toEqual(created);
			await expect(
				service.createSessionIdempotently({ ...request, createKey: crypto.randomUUID() }, origin),
			).rejects.toThrow("Runtime Box is not authenticated and ready");
		} finally {
			await service.shutdown();
			database.close();
		}
	});

	test("owns Project Session placement, creation gates, metadata, and history", async () => {
		const database = openAppDatabase(":memory:");
		const project = database.projects.create({
			runtimeBoxId: database.runtimeBoxes.getActive().runtimeBoxId,
			name: "Project",
			path: "/workspace/project",
		}).project;
		let pathState: "available" | "unavailable" | "offline" = "available";
		const projectService = new ProjectApplicationService({
			projects: database.projects,
			runs: database.runs,
			actions: database.actions,
			runtimeBoxes: database.runtimeBoxes,
			pathInspector: {
				async validateProjectPath() {
					if (pathState === "offline") {
						throw new RuntimeBoxUnavailableError();
					}
					if (pathState === "unavailable") {
						return { status: "unavailable", issueCode: "not_found" };
					}
					return {
						status: "available",
						normalizedPath: project.path,
						displayName: project.name,
						rootAgents: { status: "missing" },
						confirmationToken: "a".repeat(64),
					};
				},
			},
		});

		const service = createService(database, new FakeAskChatRuntime({}), new ManualScheduler(), {
			isRuntimeReady: () => false,
			withProjectSessionCreation: (projectId, createSession, signal) =>
				projectService.withSessionCreation(projectId, createSession, signal),
		});
		const origin = {
			role: "client" as const,
			peerId: "desktop-client",
			instanceId: crypto.randomUUID(),
			generation: 1,
		};
		const request = {
			schemaVersion: 1 as const,
			createKey: crypto.randomUUID(),
			title: "Project chat",
			defaultMode: "agent" as const,
			projectId: project.id,
			runtimeBoxId: "untrusted-runtime-box",
		};
		try {
			const created = await service.createSessionIdempotently(request, origin);
			const removable = await service.createSessionIdempotently(
				{ ...request, createKey: crypto.randomUUID(), title: "Delete me" },
				origin,
			);
			expect(created.session).toMatchObject({
				projectId: project.id,
				runtimeBoxId: project.runtimeBoxId,
			});
			expect(service.listSessions().items).toEqual([]);
			expect(
				service.listSessions({ scope: { kind: "project", projectId: project.id } }).items,
			).toHaveLength(2);

			await projectService.setArchived({ projectId: project.id, archived: true });
			pathState = "offline";
			await expect(service.createSessionIdempotently(request, origin)).resolves.toEqual(created);
			expect(
				service.updateSession({ sessionId: created.session.id, title: "Renamed offline" }).session
					.title,
			).toBe("Renamed offline");
			expect(
				service.setSessionArchived({ sessionId: created.session.id, archived: true }).session
					.archivedAt,
			).toBeDefined();
			expect(
				service.setSessionModel({ sessionId: created.session.id, model: null }).session.model,
			).toBe(undefined);
			await expect(service.getSession({ sessionId: created.session.id })).resolves.toMatchObject({
				session: { projectId: project.id, title: "Renamed offline" },
			});
			await expect(service.deleteSession({ sessionId: removable.session.id })).resolves.toEqual({
				sessionId: removable.session.id,
			});
			await expect(
				service.createSessionIdempotently({ ...request, createKey: crypto.randomUUID() }, origin),
			).rejects.toBeInstanceOf(ProjectArchivedError);

			await projectService.setArchived({ projectId: project.id, archived: false });
			await expect(
				service.createSessionIdempotently({ ...request, createKey: crypto.randomUUID() }, origin),
			).rejects.toBeInstanceOf(ProjectRuntimeUnavailableError);
			pathState = "unavailable";
			await expect(
				service.createSessionIdempotently({ ...request, createKey: crypto.randomUUID() }, origin),
			).rejects.toBeInstanceOf(ProjectPathUnavailableError);
		} finally {
			await service.shutdown();
			await projectService.shutdown();
			database.close();
		}
	});

	test("preflights Project sends, persists snapshots and warnings, and isolates ordinary Runs", async () => {
		const database = openAppDatabase(":memory:");
		const scheduler = new ManualScheduler();
		const runtime = new FakeAskChatRuntime({ deltas: ["done"] });
		const project = database.projects.create({
			runtimeBoxId: defaultLocalRuntimeBoxId,
			name: "Project",
			path: "/workspace/project",
		}).project;
		const secretBody = "EPHEMERAL-ROOT-AGENTS-BODY";
		let agentsResult:
			| { status: "loaded"; body: string }
			| { status: "warning"; issueCode: "invalid_utf8" } = {
			status: "loaded",
			body: secretBody,
		};
		const projectService = new ProjectApplicationService({
			projects: database.projects,
			runs: database.runs,
			actions: database.actions,
			runtimeBoxes: database.runtimeBoxes,
			pathInspector: {
				async validateProjectPath() {
					return {
						status: "available",
						normalizedPath: project.path,
						displayName: project.name,
						gitRootPath: project.path,
						gitBranch: "main",
						rootAgents: { status: "missing" },
						confirmationToken: "a".repeat(64),
					};
				},
				async readProjectRootAgents() {
					return agentsResult;
				},
			},
		});
		const service = createService(database, runtime, scheduler, {
			withProjectRunPreflight: (projectId, createRun, signal) =>
				projectService.withRunPreflight(projectId, createRun, signal),
		});
		const projectSession = database.sessions.create({
			projectId: project.id,
			title: "Project chat",
		}).session;
		try {
			const accepted = await service.sendMessageWithPreflight({
				sessionId: projectSession.id,
				content: "Use the Project.",
			});
			expect(runtime.inputs).toEqual([]);
			expect(database.runs.get(accepted.run.id).projectContext).toEqual(
				expect.objectContaining({
					projectId: project.id,
					runtimeBoxId: project.runtimeBoxId,
					projectPath: project.path,
					projectPathRevision: 1,
					gitBranch: "main",
					rootAgentsHash: createHash("sha256").update(secretBody).digest("hex"),
				}),
			);
			expect(JSON.stringify(database.client.query("SELECT * FROM chat_runs").all())).not.toContain(
				secretBody,
			);
			expect(JSON.stringify(database.runs.listEvents({ runId: accepted.run.id }))).not.toContain(
				secretBody,
			);
			scheduler.runAll();
			await service.waitForIdle();
			expect(runtime.inputs[0]?.executionContext).toEqual(
				expect.objectContaining({
					kind: "project",
					projectId: project.id,
					projectPath: project.path,
					projectPathRevision: 1,
					rootAgentsBody: secretBody,
				}),
			);

			agentsResult = { status: "warning", issueCode: "invalid_utf8" };
			const warned = await service.sendMessageWithPreflight({
				sessionId: projectSession.id,
				content: "Continue.",
			});
			expect(database.runs.listEvents({ runId: warned.run.id })).toEqual(
				expect.arrayContaining([
					expect.objectContaining({
						type: "run.warning",
						payload: {
							code: "ROOT_AGENTS_SKIPPED",
							reason: "invalid_utf8",
						},
					}),
				]),
			);
			scheduler.runAll();
			await service.waitForIdle();

			const ordinarySession = database.sessions.create({ title: "Ordinary" }).session;
			const ordinary = await service.sendMessageWithPreflight({
				sessionId: ordinarySession.id,
				content: "Ordinary message.",
			});
			expect(ordinary.run.projectContext).toBeUndefined();
			scheduler.runAll();
			await service.waitForIdle();
			expect(runtime.inputs.at(-1)?.executionContext).toEqual({ kind: "session" });
		} finally {
			await service.shutdown();
			await projectService.shutdown();
			database.close();
		}
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
			const { session } = service.createSession();
			const accepted = service.sendMessage({
				sessionId: session.id,
				content: "durable before execution",
			});
			ready = false;
			scheduler.runAll();
			await service.waitForIdle();

			const snapshot = await service.getSession({ sessionId: session.id });
			expect(snapshotMessages(snapshot).map((message) => message.content)).toEqual([
				"durable before execution",
			]);
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
			expect(lastTextPart(terminalRetry.run)?.status).toBe("completed");
			expect(lastTextPart(terminalRetry.run)?.content).toBe("answer");
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
			const { session } = service.createSession();
			const otherSession = service.createSession().session;
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
			expect(activeRetry.run.status).toBe("queued");
			expect(() =>
				service.sendMessage({
					requestId,
					sessionId: session.id,
					content: "conflicting replay",
				}),
			).toThrow("already used for different content");
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
			).toThrow("already has an active response");

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
			expect(lastTextPart(terminalRetry.run)?.status).toBe("completed");
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

	test("pages Session snapshots by encoded byte size before the Product RPC frame limit", async () => {
		const database = openAppDatabase(":memory:");
		const service = createService(
			database,
			new FakeAskChatRuntime({ deltas: ["unused"] }),
			new ManualScheduler(),
		);

		try {
			const { session } = service.createSession();
			const runIds: string[] = [];
			for (let runIndex = 0; runIndex < 2; runIndex += 1) {
				const run = database.runs.create({
					clientRequestId: crypto.randomUUID(),
					sessionId: session.id,
					mode: "agent",
					provider: {
						schemaVersion: 1,
						providerId: createUuidV7(),
						name: "Provider",
						source: "custom",
						api: "openai-responses",
						model: "model",
					},
					userMessageId: createUuidV7(),
					userContent: `large-${runIndex}`,
				}).run;
				runIds.push(run.id);
				const assistantTurnId = createUuidV7();
				for (let partIndex = 0; partIndex < 11; partIndex += 1) {
					const now = new Date().toISOString();
					database.runs.appendEvent({
						runId: run.id,
						type: "timeline.part.created",
						source: { kind: "assistant" },
						payload: {
							part: {
								schemaVersion: 1,
								id: createUuidV7(),
								runId: run.id,
								position: partIndex + 1,
								assistantTurnId,
								revision: 1,
								createdAt: now,
								updatedAt: now,
								kind: "text",
								status: "completed",
								content: "x".repeat(maxChatTextPartContentCharacters),
							},
						},
					});
				}
			}

			const first = await service.getSessionPage({ sessionId: session.id, limit: 2 });
			expect(first.runs).toHaveLength(1);
			expect(first.nextCursor).toBeDefined();
			expect(new TextEncoder().encode(JSON.stringify(first)).byteLength).toBeLessThan(
				productRpcMaxFrameBytes,
			);
			const second = await service.getSessionPage({
				sessionId: session.id,
				limit: 2,
				cursor: first.nextCursor,
			});
			expect(second.runs).toHaveLength(1);
			expect(second.nextCursor).toBeUndefined();
			expect([...first.runs, ...second.runs].map((run) => run.id)).toEqual(runIds);
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
				type: "timeline.text.delta",
				source: { kind: "assistant" },
				payload: {
					partId: orphaned.textPartId,
					revision: index + 2,
					delta: "x",
				},
			});
		}
		database.runs.commitTerminal({
			runId: orphaned.runId,
			status: "completed",
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
		const toolPartId = createUuidV7();
		const now = new Date().toISOString();
		database.runs.appendEvent({
			runId: orphaned.runId,
			type: "timeline.part.created",
			source: { kind: "assistant" },
			payload: {
				part: {
					schemaVersion: 1,
					id: toolPartId,
					runId: orphaned.runId,
					position: 2,
					assistantTurnId: createUuidV7(),
					revision: 1,
					kind: "tool",
					toolCallId: "replay-size-tool",
					tool: { kind: "builtin", name: "bash" },
					status: "running",
					summary: "Generate replay payload",
					createdAt: now,
					updatedAt: now,
				},
			},
		});
		for (let index = 0; index < 70; index += 1) {
			database.runs.appendEvent({
				runId: orphaned.runId,
				type: "timeline.tool.progress",
				source: { kind: "assistant" },
				payload: {
					partId: toolPartId,
					revision: index + 2,
					progress: {
						format: "text",
						value: "x".repeat(32_000),
						truncated: false,
						redactionCount: 0,
					},
				},
			});
		}
		database.runs.commitTerminal({
			runId: orphaned.runId,
			status: "completed",
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

	test("submits only the current turn and lets Pi restore prior messages", async () => {
		const database = openAppDatabase(":memory:");
		const scheduler = new ManualScheduler();
		const runtime = new FakeAskChatRuntime({ deltas: ["Reply"] });
		const service = createService(database, runtime, scheduler);

		try {
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
			expect(lastTextPart(restored.runs[0])?.status).toBe("interrupted");
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
				await input.onEvent?.({
					type: "assistant.text.started",
					runId: input.runId,
					turnIndex: 0,
					contentIndex: 0,
				});
				for (let index = 0; index < 500; index += 1) {
					if (input.signal?.aborted) {
						throw new AskChatCancelledError(input.runId, "signal aborted");
					}
					consumed += 1;
					await input.onEvent?.({
						type: "assistant.text.delta",
						runId: input.runId,
						turnIndex: 0,
						contentIndex: 0,
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
			const { providers } = service.listProviders();
			const provider = providers[0];
			expect(provider?.baseUrl).toBe("https://api.openai.com/v1");
			expect(provider?.credential).toEqual({ configured: true, type: "api_key" });
			expect(provider?.models.map((model) => model.id)).toEqual(["gpt-5.4"]);
			expect(JSON.stringify(providers)).not.toContain("sk-test-secret");

			const { session } = service.createSession();
			service.sendMessage({
				sessionId: session.id,
				content: "Authenticate",
			});
			scheduler.runAll();
			await service.waitForIdle();

			const restored = await service.getSession({ sessionId: session.id });
			expect(restored.runs[0]?.status).toBe("failed");
			expect(restored.runs[0]?.lastError?.safeMessage).toBe("Provider authentication failed.");
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
			expect(retry.run.status).toBe("failed");
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
						if (input.status === "failed" && failedCommitAttempts === 0) {
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

	test("keeps the saved API key when updating Provider fields without a new key", async () => {
		const database = openAppDatabase(":memory:");
		const scheduler = new ManualScheduler();
		const registry = createTestProviderRegistry({ seed: false });
		const service = createService(database, new FakeAskChatRuntime({}), scheduler, {
			providers: registry,
		});

		try {
			const created = await service.createProvider({
				schemaVersion: 2,
				displayName: "OpenAI",
				api: "openai-responses",
				baseUrl: "https://api.openai.com/v1",
				apiKey: "sk-test-secret",
			});
			const updated = await service.updateProvider({
				schemaVersion: 2,
				providerId: created.provider.id,
				displayName: "OpenAI Compatible",
				baseUrl: "https://api.openai.com/compatible/v1",
			});

			expect(updated.provider.baseUrl).toBe("https://api.openai.com/compatible/v1");
			expect(updated.provider.displayName).toBe("OpenAI Compatible");
			expect(updated.provider.credential.configured).toBe(true);
			expect(JSON.stringify(updated)).not.toContain("sk-test-secret");
		} finally {
			await service.shutdown();
			database.close();
		}
	});

	test("requires a saved Provider before testing a draft", async () => {
		const database = openAppDatabase(":memory:");
		const scheduler = new ManualScheduler();
		const service = createService(database, new FakeAskChatRuntime({}), scheduler);

		try {
			const output = await service.testProvider({
				schemaVersion: 2,
				draft: {
					displayName: "Untrusted",
					api: "openai-responses",
					baseUrl: "https://untrusted.example/v1",
				},
			});
			expect(output.ok).toBe(false);
			expect(output.error?.safeMessage).toContain("Save the custom Provider");
		} finally {
			await service.shutdown();
			database.close();
		}
	});

	test("tests Provider settings without exposing the API key", async () => {
		const database = openAppDatabase(":memory:");
		const scheduler = new ManualScheduler();
		const service = createService(database, new FakeAskChatRuntime({}), scheduler);

		try {
			const providerId = service.listProviders().providers[0]?.id ?? "";
			const output = await service.testProvider({ schemaVersion: 2, providerId });

			expect(output.ok).toBe(true);
			expect(JSON.stringify(output)).not.toContain("sk-test-secret");
		} finally {
			await service.shutdown();
			database.close();
		}
	});

	test("maps missing Provider credentials to a safe error", async () => {
		const database = openAppDatabase(":memory:");
		const scheduler = new ManualScheduler();
		const registry = createTestProviderRegistry({ seed: false });
		const service = createService(database, new FakeAskChatRuntime({}), scheduler, {
			providers: registry,
		});

		try {
			const created = await service.createProvider({
				schemaVersion: 2,
				displayName: "No credential",
				api: "openai-responses",
				baseUrl: "https://example.invalid/v1",
			});
			const output = await service.testProvider({
				schemaVersion: 2,
				providerId: created.provider.id,
			});

			expect(output.ok).toBe(false);
			expect(output.error?.safeMessage).toBe("Provider credentials are not configured.");
		} finally {
			await service.shutdown();
			database.close();
		}
	});

	test("deletes a saved Provider", async () => {
		const database = openAppDatabase(":memory:");
		const scheduler = new ManualScheduler();
		const service = createService(database, new FakeAskChatRuntime({}), scheduler, {
			providers: createTestProviderRegistry({ seed: false }),
		});

		try {
			const created = await service.createProvider({
				schemaVersion: 2,
				displayName: "OpenAI",
				api: "openai-responses",
				baseUrl: "https://api.openai.com/v1",
				apiKey: "sk-test-secret",
			});
			expect(service.listProviders().providers).toHaveLength(1);

			const output = await service.deleteProvider({
				schemaVersion: 2,
				providerId: created.provider.id,
			});

			expect(output.providerId).toBe(created.provider.id);
			expect(service.listProviders().providers).toEqual([]);
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

	test("retires replay instead of exposing history while its Project is deleting", async () => {
		const database = openAppDatabase(":memory:");
		const service = createService(database, new FakeAskChatRuntime({}), new ManualScheduler());
		try {
			const project = database.projects.create({
				runtimeBoxId: database.runtimeBoxes.getActive().runtimeBoxId,
				name: "Deleting Project",
				path: "/workspace/deleting-project",
			}).project;
			const session = database.sessions.create({
				projectId: project.id,
				title: "Private Project history",
			}).session;
			const created = database.runs.create({
				clientRequestId: crypto.randomUUID(),
				sessionId: session.id,
				mode: "ask",
				provider: {
					schemaVersion: 1,
					providerId: createUuidV7(),
					name: "OpenAI",
					source: "custom",
					api: "openai-responses",
					model: "gpt-4.1-mini",
				},
				userMessageId: createUuidV7(),
				userContent: "Do not expose this",
				projectContext: {
					projectId: project.id,
					runtimeBoxId: project.runtimeBoxId,
					projectPath: project.path,
					projectPathRevision: project.pathRevision,
				},
			});
			database.projects.requestDeletion(project.id);

			const replay = service.replayEvents({
				cursors: [
					{
						runId: created.run.id,
						sessionId: session.id,
						issuedAtMs: Date.now(),
						lastSeq: 0,
					},
				],
			});

			expect(replay.events).toEqual([]);
			expect(replay.retiredSessionIds).toEqual([session.id]);
			expect(replay.resnapshotSessionIds).toEqual([]);
			expect(database.runs.get(created.run.id).status).toBe("queued");

			const missingRunReplay = service.replayEvents({
				cursors: [
					{
						runId: createUuidV7(),
						sessionId: session.id,
						issuedAtMs: 0,
						lastSeq: 0,
					},
				],
			});
			expect(missingRunReplay.events).toEqual([]);
			expect(missingRunReplay.retiredSessionIds).toEqual([session.id]);
			expect(missingRunReplay.resnapshotSessionIds).toEqual([]);
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
			expect(database.runs.listPendingAgentSessionCleanups(10, true)).toHaveLength(1);

			deletionGate.resolve();
			await waitUntil(
				() => database.runs.listPendingAgentSessionCleanups(10, true).length === 0,
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
			deleteThreadError: new Error("agent session cleanup failed"),
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
				() => database.runs.listPendingAgentSessionCleanups(10, true)[0]?.attemptCount === 1,
				100,
				"failed agent session cleanup persistence",
			);
			expect(failedRuntime.deletedThreadIds).toEqual([session.id]);
			expect(database.runs.listPendingAgentSessionCleanups(10, true)).toHaveLength(1);
			expect(database.runs.isSessionRetired(session.id)).toBe(true);

			await service.shutdown();
			const restartedRuntime = new FakeAskChatRuntime({});
			restarted = createService(database, restartedRuntime, new ManualScheduler());
			await expect(restarted.deleteSession({ sessionId: session.id })).resolves.toEqual({
				sessionId: session.id,
			});
			expect(restartedRuntime.deletedThreadIds).toEqual([]);
			expect(database.runs.listPendingAgentSessionCleanups(10, true)).toHaveLength(1);
			expect(() => restarted?.deleteSession({ sessionId: createUuidV7() })).toThrow("not found");
		} finally {
			await restarted?.shutdown();
			await service.shutdown();
			database.close();
		}
	});

	test("keeps product deletion authoritative when agent session cleanup fails", async () => {
		const database = openAppDatabase(":memory:");
		const scheduler = new ManualScheduler();
		const failedRuntime = new FakeAskChatRuntime({
			deleteThreadError: new Error("delete failed"),
		});
		const service = createService(database, failedRuntime, scheduler, { logger: { error() {} } });
		let restarted: ChatApplicationService | undefined;

		try {
			const { session } = service.createSession();
			await expect(service.deleteSession({ sessionId: session.id })).resolves.toEqual({
				sessionId: session.id,
			});
			await waitUntil(
				() => database.runs.listPendingAgentSessionCleanups(10, true)[0]?.attemptCount === 1,
				100,
				"authoritative deletion cleanup failure",
			);
			await expect(service.getSession({ sessionId: session.id })).rejects.toThrow("not found");
			const [failedJob] = database.runs.listPendingAgentSessionCleanups(10, true);
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
				await restarted.retryPendingAgentSessionCleanups({
					limit: 10,
					includeDeferred: true,
				}),
			).toEqual({ attempted: 1, succeeded: 1, failed: 0, remaining: 0 });
			expect(recoveryRuntime.deletedThreadIds).toEqual([session.id]);
			expect(await restarted.retryPendingAgentSessionCleanups({ limit: 10 })).toEqual({
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

	test("drains agent session cleanup jobs in bounded retries until they succeed", async () => {
		const database = openAppDatabase(":memory:");
		const session = database.sessions.create({ title: "Retry cleanup" }).session;
		database.runs.deleteSessionAndRetireRuns(session.id);
		const runtime = new FakeAskChatRuntime({
			deleteThreadError: new Error("transient agent-session cleanup failure"),
			deleteThreadFailures: 2,
		});
		const service = createService(database, runtime, new ManualScheduler(), {
			agentSessionCleanupRetryBaseMs: 1,
			agentSessionCleanupRetryMaxMs: 2,
			logger: { error() {} },
		});

		try {
			await withDeadline(
				service.drainPendingAgentSessionCleanups({ batchSize: 1 }),
				250,
				"agent session cleanup recovery",
			);
			await waitUntil(
				() => database.runs.listPendingAgentSessionCleanups(10, true).length === 0,
				250,
				"agent session cleanup background retry",
			);
			expect(runtime.deletedThreadIds).toEqual([session.id, session.id, session.id]);
			expect(database.runs.listPendingAgentSessionCleanups(10, true)).toEqual([]);
		} finally {
			await service.shutdown();
			database.close();
		}
	});

	test("times out one hung agent session cleanup without blocking later jobs in the batch", async () => {
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
			agentSessionCleanupAttemptTimeoutMs: 10,
			agentSessionCleanupRetryBaseMs: 1_000,
			agentSessionCleanupRetryMaxMs: 1_000,
			logger: { error() {} },
		});

		try {
			expect(
				await withDeadline(
					service.retryPendingAgentSessionCleanups({
						limit: 2,
						includeDeferred: true,
					}),
					100,
					"agent session cleanup batch",
				),
			).toEqual({ attempted: 2, succeeded: 1, failed: 1, remaining: 1 });
			expect(runtime.deletedThreadIds).toEqual([first.id, second.id]);
			expect(database.runs.listPendingAgentSessionCleanups(10, true)).toEqual([
				expect.objectContaining({ sessionId: first.id, attemptCount: 1 }),
			]);
		} finally {
			firstGate.resolve();
			await service.shutdown();
			database.close();
		}
	});

	test("keeps one hung operation per Session while fairly deleting healthy agent session jobs", async () => {
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
			agentSessionCleanupAttemptTimeoutMs: 5,
			agentSessionCleanupMaxInFlightAttempts: 4,
			agentSessionCleanupRetryBaseMs: 1,
			agentSessionCleanupRetryMaxMs: 1,
			agentSessionCleanupStartupTimeoutMs: 25,
			shutdownTimeoutMs: 25,
			logger: { error() {} },
		});

		try {
			await service.drainPendingAgentSessionCleanups({ batchSize: 3 });
			await waitUntil(
				() => database.runs.listPendingAgentSessionCleanups(10, true).length === 1,
				100,
				"healthy agent session cleanup fairness",
			);
			await Bun.sleep(25);
			expect(runtime.deletedThreadIds.filter((threadId) => threadId === hung.id)).toEqual([
				hung.id,
			]);
			expect(runtime.deletedThreadIds).toContain(healthyOne.id);
			expect(runtime.deletedThreadIds).toContain(healthyTwo.id);
			expect(database.runs.listPendingAgentSessionCleanups(10, true)).toEqual([
				expect.objectContaining({ sessionId: hung.id, attemptCount: 1 }),
			]);
			await withDeadline(service.shutdown(), 100, "bounded hung deletion shutdown");
		} finally {
			await service.shutdown();
			database.close();
		}
	});

	test("retries a timed-out Session only after its underlying agent session cleanup settles", async () => {
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
			agentSessionCleanupAttemptTimeoutMs: 5,
			agentSessionCleanupRetryBaseMs: 1,
			agentSessionCleanupRetryMaxMs: 1,
			logger: { error() {} },
		});

		try {
			expect(
				await service.retryPendingAgentSessionCleanups({
					limit: 1,
					includeDeferred: true,
				}),
			).toEqual({ attempted: 1, succeeded: 0, failed: 1, remaining: 1 });
			expect(
				await service.retryPendingAgentSessionCleanups({
					limit: 1,
					includeDeferred: true,
				}),
			).toEqual({ attempted: 0, succeeded: 0, failed: 0, remaining: 1 });
			expect(calls).toBe(1);

			firstGate.resolve();
			await waitUntil(
				() => database.runs.listPendingAgentSessionCleanups(10, true).length === 0,
				100,
				"released agent session cleanup retry",
			);
			expect(calls).toBe(2);
		} finally {
			firstGate.resolve();
			await service.shutdown();
			database.close();
		}
	});

	test("observes a agent session cleanup rejection that arrives after its deadline", async () => {
		const database = openAppDatabase(":memory:");
		const session = database.sessions.create({ title: "Late rejection" }).session;
		database.runs.deleteSessionAndRetireRuns(session.id);
		let rejectDeletion: ((error: unknown) => void) | undefined;
		const deletion = new Promise<void>((_resolve, reject) => {
			rejectDeletion = reject;
		});
		const runtime = new FakeAskChatRuntime({ deleteThreadImplementation: () => deletion });
		const service = createService(database, runtime, new ManualScheduler(), {
			agentSessionCleanupAttemptTimeoutMs: 5,
			agentSessionCleanupRetryBaseMs: 1_000,
			agentSessionCleanupRetryMaxMs: 1_000,
			logger: { error() {} },
		});
		const unhandled: unknown[] = [];
		const onUnhandled = (error: unknown): void => {
			unhandled.push(error);
		};
		process.on("unhandledRejection", onUnhandled);

		try {
			expect(
				await service.retryPendingAgentSessionCleanups({
					limit: 1,
					includeDeferred: true,
				}),
			).toEqual({ attempted: 1, succeeded: 0, failed: 1, remaining: 1 });
			rejectDeletion?.(new Error("late agent-session cleanup rejection"));
			await Bun.sleep(10);
			expect(unhandled).toEqual([]);
			expect(database.runs.listPendingAgentSessionCleanups(10, true)).toHaveLength(1);
		} finally {
			process.off("unhandledRejection", onUnhandled);
			await service.shutdown();
			database.close();
		}
	});

	test("repeats idempotent agent session cleanup when acknowledgement crashes", async () => {
		const database = openAppDatabase(":memory:");
		const session = database.sessions.create({ title: "Ack crash" }).session;
		database.runs.deleteSessionAndRetireRuns(session.id);
		let acknowledgementCalls = 0;
		const runs: RunJournalRepository = new Proxy(database.runs, {
			get(target, property) {
				if (property === "ackAgentSessionCleanup") {
					return (sessionId: string) => {
						acknowledgementCalls += 1;
						if (acknowledgementCalls === 1) {
							throw new Error("simulated acknowledgement crash");
						}
						return target.ackAgentSessionCleanup(sessionId);
					};
				}
				const value = Reflect.get(target, property, target);
				return typeof value === "function" ? value.bind(target) : value;
			},
		});
		const runtime = new FakeAskChatRuntime({});
		const service = createService(database, runtime, new ManualScheduler(), {
			runs,
			agentSessionCleanupRetryBaseMs: 1,
			agentSessionCleanupRetryMaxMs: 1,
			logger: { error() {} },
		});

		try {
			await withDeadline(
				service.drainPendingAgentSessionCleanups({ batchSize: 1 }),
				250,
				"agent-session cleanup acknowledgement recovery",
			);
			await waitUntil(
				() => database.runs.listPendingAgentSessionCleanups(10, true).length === 0,
				250,
				"agent-session cleanup acknowledgement background retry",
			);
			expect(runtime.deletedThreadIds).toEqual([session.id, session.id]);
			expect(acknowledgementCalls).toBe(2);
			expect(database.runs.listPendingAgentSessionCleanups(10, true)).toEqual([]);
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
			deleteThreadError: new Error("permanent agent-session cleanup failure"),
		});
		const service = createService(database, runtime, new ManualScheduler(), {
			agentSessionCleanupRetryBaseMs: 1_000,
			agentSessionCleanupRetryMaxMs: 1_000,
			agentSessionCleanupStartupTimeoutMs: 20,
			agentSessionCleanupStartupMaxAttempts: 1,
			logger: { error() {} },
		});

		try {
			await withDeadline(
				service.drainPendingAgentSessionCleanups({ batchSize: 1 }),
				100,
				"bounded permanent agent-session cleanup recovery",
			);
			expect(runtime.deletedThreadIds).toEqual([session.id]);
			await Bun.sleep(25);
			expect(runtime.deletedThreadIds).toEqual([session.id]);
			expect(database.runs.listPendingAgentSessionCleanups(10, true)).toHaveLength(1);
		} finally {
			await withDeadline(service.shutdown(), 100, "permanent agent-session worker shutdown");
			const callsAfterShutdown = runtime.deletedThreadIds.length;
			await Bun.sleep(25);
			expect(runtime.deletedThreadIds).toHaveLength(callsAfterShutdown);
			database.close();
		}
	});

	test("backs off when cleanup retry-state persistence fails and recovers after restart", async () => {
		const database = openAppDatabase(":memory:");
		const session = database.sessions.create({ title: "Retry-state persistence" }).session;
		database.runs.deleteSessionAndRetireRuns(session.id);
		let repositoryWritesAllowed = false;
		let retryStateWriteCalls = 0;
		let acknowledgementCalls = 0;
		let pendingListCalls = 0;
		const runs: RunJournalRepository = new Proxy(database.runs, {
			get(target, property) {
				if (property === "listPendingAgentSessionCleanups") {
					return (limit: number, includeDeferred?: boolean) => {
						pendingListCalls += 1;
						return target.listPendingAgentSessionCleanups(limit, includeDeferred);
					};
				}
				if (property === "recordAgentSessionCleanupFailure") {
					return (sessionId: string, error: string, nextAttemptAtMs: number) => {
						retryStateWriteCalls += 1;
						if (!repositoryWritesAllowed) {
							throw new Error("simulated retry-state write failure");
						}
						return target.recordAgentSessionCleanupFailure(sessionId, error, nextAttemptAtMs);
					};
				}
				if (property === "ackAgentSessionCleanup") {
					return (sessionId: string) => {
						acknowledgementCalls += 1;
						if (!repositoryWritesAllowed) {
							throw new Error("simulated acknowledgement write failure");
						}
						return target.ackAgentSessionCleanup(sessionId);
					};
				}
				const value = Reflect.get(target, property, target);
				return typeof value === "function" ? value.bind(target) : value;
			},
		});
		const runtime = new FakeAskChatRuntime({
			deleteThreadError: new Error("agent session cleanup failed"),
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
			agentSessionCleanupRetryBaseMs: 60_000,
			agentSessionCleanupRetryMaxMs: 60_000,
			logger: { error: (_message, error) => errors.push(error) },
		});
		let restarted: ChatApplicationService | undefined;

		try {
			await withDeadline(
				service.drainPendingAgentSessionCleanups({ batchSize: 1 }),
				100,
				"retry-state persistence readiness",
			);
			await withDeadline(Bun.sleep(100), 250, "event-loop responsiveness");
			expect(runtime.deletedThreadIds).toEqual([session.id]);
			expect(retryStateWriteCalls).toBe(1);
			expect(pendingListCalls).toBe(1);
			expect(errors).toHaveLength(1);
			expect(unhandled).toEqual([]);
			expect(database.runs.listPendingAgentSessionCleanups(10, true)).toEqual([
				expect.objectContaining({ sessionId: session.id, attemptCount: 0 }),
			]);
			await withDeadline(service.shutdown(), 100, "retry-state backoff shutdown");

			repositoryWritesAllowed = true;
			restarted = createService(database, runtime, new ManualScheduler(), {
				runs,
				agentSessionCleanupRetryBaseMs: 1,
				agentSessionCleanupRetryMaxMs: 1,
			});
			await withDeadline(
				restarted.drainPendingAgentSessionCleanups({ batchSize: 1 }),
				100,
				"retry-state persistence recovery",
			);
			await waitUntil(
				() => database.runs.listPendingAgentSessionCleanups(10, true).length === 0,
				100,
				"agent-session cleanup acknowledgement recovery",
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

	test("bounds readiness when agent session cleanup hangs and cleans the worker on shutdown", async () => {
		const database = openAppDatabase(":memory:");
		const session = database.sessions.create({ title: "Hung cleanup" }).session;
		database.runs.deleteSessionAndRetireRuns(session.id);
		const gate = createDeferred();
		const runtime = new FakeAskChatRuntime({ deleteThreadGate: gate.promise });
		const service = createService(database, runtime, new ManualScheduler(), {
			agentSessionCleanupStartupTimeoutMs: 10,
			agentSessionCleanupStartupMaxAttempts: 1,
			logger: { error() {} },
		});

		try {
			await withDeadline(
				service.drainPendingAgentSessionCleanups({ batchSize: 1 }),
				100,
				"hung agent-session cleanup readiness",
			);
			expect(runtime.deletedThreadIds).toEqual([session.id]);
			await withDeadline(service.shutdown(), 100, "hung agent-session worker shutdown");
			expect(database.runs.listPendingAgentSessionCleanups(10, true)).toHaveLength(1);
		} finally {
			gate.resolve();
			await Promise.resolve();
			await service.shutdown();
			database.close();
		}
	});

	test("interrupts agent-session retry backoff safely during shutdown", async () => {
		const database = openAppDatabase(":memory:");
		const session = database.sessions.create({ title: "Shutdown cleanup" }).session;
		database.runs.deleteSessionAndRetireRuns(session.id);
		const runtime = new FakeAskChatRuntime({
			deleteThreadError: new Error("persistent agent-session cleanup failure"),
		});
		const service = createService(database, runtime, new ManualScheduler(), {
			agentSessionCleanupRetryBaseMs: 60_000,
			agentSessionCleanupRetryMaxMs: 60_000,
			logger: { error() {} },
		});
		const draining = service.drainPendingAgentSessionCleanups({ batchSize: 1 });
		let shutDown = false;

		try {
			while (runtime.deletedThreadIds.length === 0) {
				await Promise.resolve();
			}
			await withDeadline(service.shutdown(), 250, "agent-session cleanup shutdown");
			shutDown = true;
			await draining;
			expect(database.runs.listPendingAgentSessionCleanups(10, true)).toHaveLength(1);
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

	test("settles shutdown without waiting for a hung post-commit agent session cleanup", async () => {
		const database = openAppDatabase(":memory:");
		const deletionGate = createDeferred();
		const runtime = new FakeAskChatRuntime({ deleteThreadGate: deletionGate.promise });
		const service = createService(database, runtime, new ManualScheduler(), {
			agentSessionCleanupAttemptTimeoutMs: 1_000,
			shutdownTimeoutMs: 20,
			logger: { error() {} },
		});
		try {
			const { session } = service.createSession();
			const deletion = service.deleteSession({ sessionId: session.id });
			expect(runtime.deletedThreadIds).toEqual([session.id]);
			await withDeadline(service.shutdown(), 100, "post-commit agent-session shutdown");
			await deletion;
			expect(database.runs.listPendingAgentSessionCleanups(10, true)).toHaveLength(1);
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
			const { session } = service.createSession();
			const accepted = service.sendMessage({ sessionId: session.id, content: "Wait" });

			expect(() => service.setSessionArchived({ sessionId: session.id, archived: true })).toThrow(
				"Stop the active response",
			);
			expect(() => service.deleteSession({ sessionId: session.id })).toThrow(
				"Stop the active response",
			);
			await expect(
				service.createProvider({
					schemaVersion: 2,
					displayName: "Another",
					api: "openai-responses",
					baseUrl: "https://example.test/v1",
					apiKey: "sk-another",
				}),
			).rejects.toThrow("Stop active responses");
			await expect(
				service.deleteProvider({ schemaVersion: 2, providerId: createUuidV7() }),
			).rejects.toThrow("Stop active responses");
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
			service.subscribe((event) => {
				if (event.runId === orphaned.runId && event.type === "timeline.text.completed") {
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
			service.subscribe((event) => {
				if (event.runId === orphaned.runId && event.type === "timeline.text.completed") {
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
			expect(service.cancel({ runId: cancelling.runId }).run.status).toBe("cancelled");
			expect(
				lastTextPart((await service.getSession({ sessionId: cancelling.sessionId })).runs[0])
					?.status,
			).toBe("interrupted");

			expect(
				service.setSessionArchived({
					sessionId: running.sessionId,
					archived: true,
				}).session.archivedAt,
			).toBeDefined();
			const recovered = await service.getSession({
				sessionId: running.sessionId,
			});
			expect(recovered.runs[0]?.status).toBe("failed");
			expect(lastTextPart(recovered.runs[0])?.status).toBe("interrupted");

			await service.deleteSession({ sessionId: deleting.sessionId });
			await expect(service.getSession({ sessionId: deleting.sessionId })).rejects.toThrow();

			const accepted = service.sendMessage({
				sessionId: sending.sessionId,
				content: "Recovered question",
			});
			expect(database.runs.get(sending.runId).status).toBe("failed");
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
			expect(replay.events.some((event) => event.type === "timeline.text.completed")).toBe(true);
			expect(database.runs.get(replaying.runId).status).toBe("failed");
		} finally {
			await service.shutdown();
			database.close();
		}
	});

	test("recovers a 100k-row timeline journal with bounded forward paging", async () => {
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
			expect(database.runs.get(orphaned.runId).status).toBe("failed");
			const snapshot = await service.getSession({ sessionId: orphaned.sessionId });
			expect(lastTextPart(snapshot.runs[0])?.content).toHaveLength(100_000);
		} finally {
			await service.shutdown();
			database.close();
		}
	});
});

function snapshotMessages(snapshot: { runs: readonly ChatRunSnapshot[] }): Array<{
	role: "user" | "assistant";
	content: string;
}> {
	return snapshot.runs.flatMap((run) => [
		{ role: "user" as const, content: run.userMessage.content },
		...run.timeline
			.filter((part) => part.kind === "text")
			.map((part) => ({ role: "assistant" as const, content: part.content })),
	]);
}

function lastTextPart(run: ChatRunSnapshot | undefined) {
	return run?.timeline.filter((part) => part.kind === "text").at(-1);
}

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
			source: "custom",
			api: "openai-responses",
			model: "gpt-4.1-mini",
		},
		userMessageId: createUuidV7(),
		userContent: "Interrupted prompt",
	});
	database.runs.updateStatus({ runId: created.run.id, status: "running" });
	const textPartId = createUuidV7();
	const now = new Date().toISOString();
	database.runs.appendEvent({
		runId: created.run.id,
		type: "timeline.part.created",
		source: { kind: "assistant" },
		payload: {
			part: {
				schemaVersion: 1,
				id: textPartId,
				runId: created.run.id,
				position: 1,
				assistantTurnId: createUuidV7(),
				revision: 1,
				kind: "text",
				status: "streaming",
				content: "",
				createdAt: now,
				updatedAt: now,
			},
		},
	});
	if (status === "cancelling") {
		database.runs.updateStatus({ runId: created.run.id, status: "cancelling" });
	}
	return {
		sessionId: session.id,
		runId: created.run.id,
		textPartId,
	};
}

function insertSmallDeltaFixture(
	database: ReturnType<typeof openAppDatabase>,
	run: ReturnType<typeof createOrphanedRun>,
	count: number,
): void {
	const firstSeq = 4;
	const lastSeq = firstSeq + count - 1;
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
				'timeline.text.delta',
				'assistant',
				NULL,
				'user',
				json_object(
					'partId', $partId,
					'revision', seq - 2,
					'delta', 'x'
				),
				$createdAtMs
			FROM fixture`,
		)
		.run({
			firstSeq,
			lastSeq,
			runId: run.runId,
			sessionId: run.sessionId,
			partId: run.textPartId,
			createdAtMs: Date.now(),
		});
	database.client
		.query(
			`UPDATE chat_run_parts
			 SET revision = $revision,
			     text_content = $content,
			     last_event_seq = $lastEventSeq,
			     updated_at_ms = $updatedAtMs
			 WHERE id = $partId`,
		)
		.run({
			revision: count + 1,
			content: "x".repeat(count),
			lastEventSeq: lastSeq,
			updatedAtMs: Date.now(),
			partId: run.textPartId,
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
		providers?: ProviderRegistry;
		fetchProviderModels?: (providerId: string) => Promise<readonly ProviderModel[]>;
		isRuntimeReady?: () => boolean;
		withProjectSessionCreation?: <T>(
			projectId: string,
			createSession: () => T,
			signal?: AbortSignal,
		) => Promise<T>;
		withProjectRunPreflight?: ChatApplicationServiceOptions["withProjectRunPreflight"];
		agentSessionCleanupRetryBaseMs?: number;
		agentSessionCleanupRetryMaxMs?: number;
		agentSessionCleanupAttemptTimeoutMs?: number;
		agentSessionCleanupMaxInFlightAttempts?: number;
		agentSessionCleanupStartupTimeoutMs?: number;
		agentSessionCleanupStartupMaxAttempts?: number;
		shutdownTimeoutMs?: number;
		onSessionsRetired?: (sessionIds: readonly string[]) => void;
	} = {},
) {
	return new ChatApplicationService({
		sessions: options.sessions ?? database.sessions,
		runs: options.runs ?? database.runs,
		actions: database.actions,
		providers: options.providers ?? createTestProviderRegistry(),
		runtime,
		schedule: scheduler.schedule,
		...(options.fetchProviderModels === undefined
			? {}
			: { fetchProviderModels: options.fetchProviderModels }),
		...(options.logger === undefined ? {} : { logger: options.logger }),
		...(options.isRuntimeReady === undefined ? {} : { isRuntimeReady: options.isRuntimeReady }),
		...(options.withProjectSessionCreation === undefined
			? {}
			: { withProjectSessionCreation: options.withProjectSessionCreation }),
		...(options.withProjectRunPreflight === undefined
			? {}
			: { withProjectRunPreflight: options.withProjectRunPreflight }),
		...(options.agentSessionCleanupRetryBaseMs === undefined
			? {}
			: { agentSessionCleanupRetryBaseMs: options.agentSessionCleanupRetryBaseMs }),
		...(options.agentSessionCleanupRetryMaxMs === undefined
			? {}
			: { agentSessionCleanupRetryMaxMs: options.agentSessionCleanupRetryMaxMs }),
		...(options.agentSessionCleanupAttemptTimeoutMs === undefined
			? {}
			: { agentSessionCleanupAttemptTimeoutMs: options.agentSessionCleanupAttemptTimeoutMs }),
		...(options.agentSessionCleanupMaxInFlightAttempts === undefined
			? {}
			: {
					agentSessionCleanupMaxInFlightAttempts: options.agentSessionCleanupMaxInFlightAttempts,
				}),
		...(options.agentSessionCleanupStartupTimeoutMs === undefined
			? {}
			: { agentSessionCleanupStartupTimeoutMs: options.agentSessionCleanupStartupTimeoutMs }),
		...(options.agentSessionCleanupStartupMaxAttempts === undefined
			? {}
			: { agentSessionCleanupStartupMaxAttempts: options.agentSessionCleanupStartupMaxAttempts }),
		...(options.shutdownTimeoutMs === undefined
			? {}
			: { shutdownTimeoutMs: options.shutdownTimeoutMs }),
		...(options.onSessionsRetired === undefined
			? {}
			: { onSessionsRetired: options.onSessionsRetired }),
	});
}

function createTestProviderRegistry(options: { seed?: boolean } = {}): ProviderRegistry {
	const providers: ProviderRecord[] = [];
	let defaultModel: DefaultModelSelection | null = null;

	const find = (providerId: string): ProviderRecord | undefined =>
		providers.find((provider) => provider.id === providerId);
	const requireRecord = (providerId: string): ProviderRecord => {
		const record = find(providerId);
		if (record === undefined) {
			throw new ProviderNotFoundError(providerId);
		}
		return record;
	};
	const pruneDefaultModel = (): void => {
		if (defaultModel === null) {
			return;
		}
		const record = find(defaultModel.providerId);
		const model = record?.models.find((candidate) => candidate.id === defaultModel?.modelId);
		if (record === undefined || model === undefined || !model.enabled) {
			defaultModel = null;
		}
	};

	const registry: ProviderRegistry = {
		list: () => providers.map((record) => structuredClone(record)),
		get: (providerId) => {
			const record = find(providerId);
			return record === undefined ? null : structuredClone(record);
		},
		create: async (input) => {
			if (providers.length >= maxProviderCount) {
				throw new ProviderCapacityError(maxProviderCount);
			}
			const record: ProviderRecord = {
				id: createUuidV7(),
				displayName: input.displayName,
				source: "custom",
				api: input.api,
				baseUrl: input.baseUrl,
				enabled: true,
				authMethods: ["api_key"],
				credential: { configured: input.apiKey !== undefined, type: "api_key" },
				customHeaderNames: Object.keys(input.customHeaders ?? {}).sort(),
				models: [],
			};
			providers.push(record);
			return structuredClone(record);
		},
		update: async (input) => {
			const record = requireRecord(input.providerId);
			if (input.displayName !== undefined) {
				record.displayName = input.displayName;
			}
			if (input.api !== undefined) {
				record.api = input.api;
			}
			if (input.baseUrl !== undefined) {
				record.baseUrl = input.baseUrl;
			}
			if (input.apiKey !== undefined) {
				record.credential = { configured: true, type: "api_key" };
			}
			if (input.customHeaders !== undefined) {
				record.customHeaderNames = Object.keys(input.customHeaders).sort();
			}
			if (input.enabled !== undefined) {
				record.enabled = input.enabled;
			}
			return structuredClone(record);
		},
		delete: async (providerId) => {
			const index = providers.findIndex((provider) => provider.id === providerId);
			if (index < 0) {
				throw new ProviderNotFoundError(providerId);
			}
			providers.splice(index, 1);
			if (defaultModel?.providerId === providerId) {
				defaultModel = null;
			}
		},
		refreshModels: async (providerId) => structuredClone(requireRecord(providerId)),
		setModels: async (providerId, models, fetchedAt) => {
			const record = requireRecord(providerId);
			const previouslyEnabled = new Set(
				record.models.filter((model) => model.enabled).map((model) => model.id),
			);
			record.models = models.map((model) => ({
				...model,
				enabled: previouslyEnabled.has(model.id),
			}));
			record.modelsFetchedAt = fetchedAt;
			pruneDefaultModel();
			return structuredClone(record);
		},
		setModelsEnabled: (providerId, enabledModelIds) => {
			const record = requireRecord(providerId);
			const enabled = new Set(enabledModelIds);
			record.models = record.models.map((model) => ({
				...model,
				enabled: enabled.has(model.id),
			}));
			pruneDefaultModel();
			return structuredClone(record);
		},
		getDefaultModel: () => (defaultModel === null ? null : structuredClone(defaultModel)),
		setDefaultModel: (selection) => {
			if (selection === null) {
				defaultModel = null;
				return null;
			}
			const record = requireRecord(selection.providerId);
			if (!record.models.some((model) => model.id === selection.modelId)) {
				throw new ProviderModelNotFoundError(selection.providerId, selection.modelId);
			}
			defaultModel = structuredClone(selection);
			return structuredClone(selection);
		},
	};

	if (options.seed !== false) {
		const record: ProviderRecord = {
			id: createUuidV7(),
			displayName: "OpenAI",
			source: "custom",
			api: "openai-responses",
			baseUrl: "https://api.openai.com/v1",
			enabled: true,
			authMethods: ["api_key"],
			credential: { configured: true, type: "api_key" },
			customHeaderNames: [],
			models: [createProviderModel("gpt-5.4")],
			modelsFetchedAt: "2026-01-01T00:00:00.000Z",
		};
		providers.push(record);
		registry.setDefaultModel({ providerId: record.id, modelId: "gpt-5.4" });
	}

	return registry;
}

function createProviderModel(id: string, overrides: Partial<ProviderModel> = {}): ProviderModel {
	return {
		id,
		displayName: id,
		api: "openai-responses",
		input: ["text"],
		reasoning: true,
		contextWindowTokens: 128_000,
		maxOutputTokens: 8_192,
		thinkingLevels: ["off", "minimal", "low", "medium", "high"],
		enabled: true,
		...overrides,
	};
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
	readonly #pendingRuns = new Map<string, { resolve(result: AskChatRunResult): void }>();
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
		const threadId = input.threadId ?? input.runId;
		const messages = this.#threadMessages.get(threadId) ?? [];
		messages.push(...input.messages.map((message) => ({ ...message })));
		this.#threadMessages.set(threadId, messages);

		if (this.#error !== undefined) {
			throw this.#error;
		}

		await input.onEvent?.({
			type: "assistant.text.started",
			runId: input.runId,
			turnIndex: 1,
			contentIndex: 0,
		});
		for (const delta of this.#deltas) {
			try {
				await input.onEvent?.({
					type: "assistant.text.delta",
					runId: input.runId,
					turnIndex: 1,
					contentIndex: 0,
					delta,
				});
			} catch (error) {
				if (!this.#ignoreEventErrors) {
					throw error;
				}
			}
		}
		if (this.#pending) {
			return new Promise<AskChatRunResult>((resolve) => {
				this.#pendingRuns.set(input.runId, { resolve });
				this.#resolveStarted();
			});
		}
		this.#resolveStarted();
		const text = this.#resultText ?? this.#deltas.join("");
		await input.onEvent?.({
			type: "assistant.text.completed",
			runId: input.runId,
			turnIndex: 1,
			contentIndex: 0,
			content: text,
		});
		messages.push({ role: "assistant", content: text });

		return {
			runId: input.runId,
			text,
		};
	}

	stream(_input: AskChatRunInput): AskChatRunStream {
		throw new Error("FakeAskChatRuntime.stream is not used by ChatApplicationService.");
	}

	cancel(runId: string, _reason?: string): boolean {
		this.cancelAttempts.push(runId);
		const pending = this.#pendingRuns.get(runId);
		if (pending === undefined) {
			return false;
		}

		this.cancelledRunIds.push(runId);
		this.#pendingRuns.delete(runId);
		pending.resolve({ runId, text: "" });
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

describe("ChatApplicationService provider registry security", () => {
	test("masks the API key and header values while exposing header names", async () => {
		const database = openAppDatabase(":memory:");
		const scheduler = new ManualScheduler();
		const service = createService(database, new FakeAskChatRuntime({}), scheduler, {
			providers: createTestProviderRegistry({ seed: false }),
		});

		try {
			const created = await service.createProvider({
				schemaVersion: 2,
				displayName: "OpenAI",
				api: "openai-responses",
				baseUrl: "https://api.openai.com/v1",
				apiKey: "sk-create-secret",
				customHeaders: { "X-Org-Id": "org-secret-value" },
			});
			const createdJson = JSON.stringify(created);
			expect(createdJson).not.toContain("sk-create-secret");
			expect(createdJson).not.toContain("org-secret-value");
			expect(created.provider.customHeaderNames).toEqual(["X-Org-Id"]);
			expect(createdJson).toContain("X-Org-Id");

			const updated = await service.updateProvider({
				schemaVersion: 2,
				providerId: created.provider.id,
				apiKey: "sk-update-secret",
				customHeaders: { "X-Update-Header": "update-secret-value" },
			});
			const updatedJson = JSON.stringify(updated);
			expect(updatedJson).not.toContain("sk-update-secret");
			expect(updatedJson).not.toContain("update-secret-value");
			expect(updated.provider.customHeaderNames).toEqual(["X-Update-Header"]);
			expect(updatedJson).toContain("X-Update-Header");

			const listJson = JSON.stringify(service.listProviders());
			expect(listJson).not.toContain("sk-update-secret");
			expect(listJson).not.toContain("update-secret-value");
			expect(listJson).toContain("X-Update-Header");
		} finally {
			await service.shutdown();
			database.close();
		}
	});

	test("never leaks provider secrets through the Session page or published events", async () => {
		const database = openAppDatabase(":memory:");
		const scheduler = new ManualScheduler();
		const registry = createTestProviderRegistry({ seed: false });
		const runtime = new FakeAskChatRuntime({ deltas: ["Answer"] });
		const service = createService(database, runtime, scheduler, { providers: registry });
		const publishedEvents: ChatRunEvent[] = [];

		try {
			const provider = await registry.create({
				displayName: "OpenAI",
				api: "openai-responses",
				baseUrl: "https://api.openai.com/v1",
				apiKey: "sk-page-secret",
				customHeaders: { "X-Secret-Header": "super-secret-header-value" },
			});
			await registry.setModels(
				provider.id,
				[createProviderModel("gpt-5.4", { enabled: false })],
				"2026-01-01T00:00:00.000Z",
			);
			registry.setModelsEnabled(provider.id, ["gpt-5.4"]);
			registry.setDefaultModel({ providerId: provider.id, modelId: "gpt-5.4" });

			service.subscribe((event) => {
				publishedEvents.push(event);
			});

			const { session } = service.createSession();
			service.sendMessage({ sessionId: session.id, content: "Question" });
			scheduler.runAll();
			await service.waitForIdle();

			const pageJson = JSON.stringify(
				await service.getSessionPage({ sessionId: session.id, limit: 2 }),
			);
			expect(pageJson).not.toContain("sk-page-secret");
			expect(pageJson).not.toContain("super-secret-header-value");

			expect(publishedEvents.length).toBeGreaterThan(0);
			for (const event of publishedEvents) {
				const eventJson = JSON.stringify(event);
				expect(eventJson).not.toContain("sk-page-secret");
				expect(eventJson).not.toContain("super-secret-header-value");
			}
		} finally {
			await service.shutdown();
			database.close();
		}
	});
});

describe("ChatApplicationService provider and model resolution", () => {
	const modelsFetchedAt = "2026-01-01T00:00:00.000Z";

	async function seedProvider(
		registry: ProviderRegistry,
		options: {
			displayName: string;
			api?: "openai-responses" | "anthropic-messages";
			baseUrl: string;
			apiKey: string;
			models: ProviderModel[];
			enabledModelIds: string[];
			defaultModelId?: string;
		},
	): Promise<string> {
		const api = options.api ?? "openai-responses";
		const created = await registry.create({
			displayName: options.displayName,
			api,
			baseUrl: options.baseUrl,
			apiKey: options.apiKey,
		});
		await registry.setModels(
			created.id,
			options.models.map((model) => ({ ...model, api })),
			modelsFetchedAt,
		);
		registry.setModelsEnabled(created.id, options.enabledModelIds);
		if (options.defaultModelId !== undefined) {
			registry.setDefaultModel({ providerId: created.id, modelId: options.defaultModelId });
		}
		return created.id;
	}

	test("sends against the Session's own model when set and the default otherwise", async () => {
		const database = openAppDatabase(":memory:");
		const scheduler = new ManualScheduler();
		const registry = createTestProviderRegistry({ seed: false });
		const runtime = new FakeAskChatRuntime({ deltas: ["ok"] });
		const service = createService(database, runtime, scheduler, { providers: registry });

		try {
			const primaryId = await seedProvider(registry, {
				displayName: "Primary",
				baseUrl: "https://primary.example/v1",
				apiKey: "sk-primary",
				models: [createProviderModel("gpt-5.4", { enabled: false })],
				enabledModelIds: ["gpt-5.4"],
				defaultModelId: "gpt-5.4",
			});
			const secondaryId = await seedProvider(registry, {
				displayName: "Secondary",
				api: "anthropic-messages",
				baseUrl: "https://secondary.example/v1",
				apiKey: "sk-secondary",
				models: [
					createProviderModel("claude-4", {
						api: "anthropic-messages",
						enabled: false,
					}),
				],
				enabledModelIds: ["claude-4"],
			});

			const defaultSession = service.createSession().session;
			service.sendMessage({ sessionId: defaultSession.id, content: "use default" });
			scheduler.runAll();
			await service.waitForIdle();
			expect(runtime.inputs[0]?.provider.providerId).toBe(primaryId);
			expect(runtime.inputs[0]?.provider.model).toBe("gpt-5.4");
			expect(runtime.inputs[0]?.provider.api).toBe("openai-responses");

			const pinnedSession = service.createSession().session;
			service.setSessionModel({
				sessionId: pinnedSession.id,
				model: { providerId: secondaryId, modelId: "claude-4" },
			});
			service.sendMessage({ sessionId: pinnedSession.id, content: "use pinned" });
			scheduler.runAll();
			await service.waitForIdle();
			expect(runtime.inputs[1]?.provider.providerId).toBe(secondaryId);
			expect(runtime.inputs[1]?.provider.model).toBe("claude-4");
			expect(runtime.inputs[1]?.provider.api).toBe("anthropic-messages");
		} finally {
			await service.shutdown();
			database.close();
		}
	});

	test("falls back to the default when the Session provider is removed, disabled, or drops the model", async () => {
		const database = openAppDatabase(":memory:");
		const scheduler = new ManualScheduler();
		const registry = createTestProviderRegistry({ seed: false });
		const runtime = new FakeAskChatRuntime({ deltas: ["ok"] });
		const service = createService(database, runtime, scheduler, { providers: registry });

		try {
			const fallbackId = await seedProvider(registry, {
				displayName: "Fallback",
				baseUrl: "https://fallback.example/v1",
				apiKey: "sk-fallback",
				models: [createProviderModel("gpt-5.4", { enabled: false })],
				enabledModelIds: ["gpt-5.4"],
				defaultModelId: "gpt-5.4",
			});

			const removableId = await seedProvider(registry, {
				displayName: "Removable",
				baseUrl: "https://removable.example/v1",
				apiKey: "sk-removable",
				models: [createProviderModel("temp-model", { enabled: false })],
				enabledModelIds: ["temp-model"],
			});
			const removableSession = service.createSession().session;
			service.setSessionModel({
				sessionId: removableSession.id,
				model: { providerId: removableId, modelId: "temp-model" },
			});
			await registry.delete(removableId);
			service.sendMessage({ sessionId: removableSession.id, content: "provider deleted" });
			scheduler.runAll();
			await service.waitForIdle();
			expect(runtime.inputs[0]?.provider.providerId).toBe(fallbackId);

			const disabledId = await seedProvider(registry, {
				displayName: "Disabled",
				baseUrl: "https://disabled.example/v1",
				apiKey: "sk-disabled",
				models: [createProviderModel("off-model", { enabled: false })],
				enabledModelIds: ["off-model"],
			});
			const disabledSession = service.createSession().session;
			service.setSessionModel({
				sessionId: disabledSession.id,
				model: { providerId: disabledId, modelId: "off-model" },
			});
			await registry.update({ providerId: disabledId, enabled: false });
			service.sendMessage({ sessionId: disabledSession.id, content: "provider disabled" });
			scheduler.runAll();
			await service.waitForIdle();
			expect(runtime.inputs[1]?.provider.providerId).toBe(fallbackId);

			const droppedId = await seedProvider(registry, {
				displayName: "Dropped",
				baseUrl: "https://dropped.example/v1",
				apiKey: "sk-dropped",
				models: [createProviderModel("gone-model", { enabled: false })],
				enabledModelIds: ["gone-model"],
			});
			const droppedSession = service.createSession().session;
			service.setSessionModel({
				sessionId: droppedSession.id,
				model: { providerId: droppedId, modelId: "gone-model" },
			});
			await registry.setModels(
				droppedId,
				[createProviderModel("other-model", { enabled: false })],
				modelsFetchedAt,
			);
			service.sendMessage({ sessionId: droppedSession.id, content: "model dropped" });
			scheduler.runAll();
			await service.waitForIdle();
			expect(runtime.inputs[2]?.provider.providerId).toBe(fallbackId);

			const disabledModelId = await seedProvider(registry, {
				displayName: "Disabled model",
				baseUrl: "https://disabled-model.example/v1",
				apiKey: "sk-disabled-model",
				models: [createProviderModel("kept-model", { enabled: false })],
				enabledModelIds: ["kept-model"],
			});
			const disabledModelSession = service.createSession().session;
			service.setSessionModel({
				sessionId: disabledModelSession.id,
				model: { providerId: disabledModelId, modelId: "kept-model" },
			});
			registry.setModelsEnabled(disabledModelId, []);
			service.sendMessage({ sessionId: disabledModelSession.id, content: "model disabled" });
			scheduler.runAll();
			await service.waitForIdle();
			expect(runtime.inputs[3]?.provider.providerId).toBe(fallbackId);
		} finally {
			await service.shutdown();
			database.close();
		}
	});

	test("throws not_configured when neither the Session nor the default resolves", async () => {
		const database = openAppDatabase(":memory:");
		const scheduler = new ManualScheduler();
		const service = createService(database, new FakeAskChatRuntime({}), scheduler, {
			providers: createTestProviderRegistry({ seed: false }),
		});

		try {
			const { session } = service.createSession();
			expect(() => service.sendMessage({ sessionId: session.id, content: "no provider" })).toThrow(
				"No Provider and model are selected for this chat.",
			);
		} finally {
			await service.shutdown();
			database.close();
		}
	});

	test("rejects unknown providers and models and clears the Session model with null", async () => {
		const database = openAppDatabase(":memory:");
		const scheduler = new ManualScheduler();
		const registry = createTestProviderRegistry({ seed: false });
		const service = createService(database, new FakeAskChatRuntime({}), scheduler, {
			providers: registry,
		});

		try {
			const providerId = await seedProvider(registry, {
				displayName: "OpenAI",
				baseUrl: "https://api.openai.com/v1",
				apiKey: "sk-secret",
				models: [createProviderModel("gpt-5.4", { enabled: false })],
				enabledModelIds: ["gpt-5.4"],
			});
			const { session } = service.createSession();

			expect(() =>
				service.setSessionModel({
					sessionId: session.id,
					model: { providerId: createUuidV7(), modelId: "gpt-5.4" },
				}),
			).toThrow(ProviderNotFoundError);
			expect(() =>
				service.setSessionModel({
					sessionId: session.id,
					model: { providerId, modelId: "missing-model" },
				}),
			).toThrow(ProviderModelNotFoundError);

			const selected = service.setSessionModel({
				sessionId: session.id,
				model: { providerId, modelId: "gpt-5.4" },
			});
			expect(selected.session.model).toEqual({ providerId, modelId: "gpt-5.4" });

			const cleared = service.setSessionModel({ sessionId: session.id, model: null });
			expect(cleared.session.model).toBeUndefined();
		} finally {
			await service.shutdown();
			database.close();
		}
	});

	test("keeps supported thinking levels and rejects unsupported ones", async () => {
		const database = openAppDatabase(":memory:");
		const scheduler = new ManualScheduler();
		const registry = createTestProviderRegistry({ seed: false });
		const service = createService(database, new FakeAskChatRuntime({}), scheduler, {
			providers: registry,
		});

		try {
			const providerId = await seedProvider(registry, {
				displayName: "Claude gateway",
				api: "anthropic-messages",
				baseUrl: "https://api.anthropic.com/v1",
				apiKey: "sk-secret",
				models: [
					createProviderModel("claude-opus-4.6", {
						api: "anthropic-messages",
						enabled: false,
						thinkingLevels: ["off", "low", "high"],
					}),
				],
				enabledModelIds: ["claude-opus-4.6"],
			});
			const { session } = service.createSession();

			const kept = service.setSessionModel({
				sessionId: session.id,
				model: {
					providerId,
					modelId: "claude-opus-4.6",
					thinkingLevel: "high",
				},
			});
			expect(kept.session.model?.thinkingLevel).toBe("high");

			expect(() =>
				service.setSessionModel({
					sessionId: session.id,
					model: {
						providerId,
						modelId: "claude-opus-4.6",
						thinkingLevel: "medium",
					},
				}),
			).toThrow("thinking level");

			const cleared = service.setSessionModel({
				sessionId: session.id,
				model: {
					providerId,
					modelId: "claude-opus-4.6",
					thinkingLevel: "off",
				},
			});
			expect(cleared.session.model?.thinkingLevel).toBe("off");
		} finally {
			await service.shutdown();
			database.close();
		}
	});

	test("omits a stored thinking level after refreshed model capabilities drop it", async () => {
		const database = openAppDatabase(":memory:");
		const scheduler = new ManualScheduler();
		const registry = createTestProviderRegistry({ seed: false });
		const runtime = new FakeAskChatRuntime({ deltas: ["ok"] });
		const service = createService(database, runtime, scheduler, { providers: registry });

		try {
			const providerId = await seedProvider(registry, {
				displayName: "Capability drift",
				api: "anthropic-messages",
				baseUrl: "https://capability.example/v1",
				apiKey: "sk-secret",
				models: [
					createProviderModel("drifting-model", {
						api: "anthropic-messages",
						enabled: false,
						thinkingLevels: ["off", "high"],
					}),
				],
				enabledModelIds: ["drifting-model"],
			});
			const { session } = service.createSession();
			service.setSessionModel({
				sessionId: session.id,
				model: { providerId, modelId: "drifting-model", thinkingLevel: "high" },
			});
			await registry.setModels(
				providerId,
				[
					createProviderModel("drifting-model", {
						api: "anthropic-messages",
						enabled: false,
						thinkingLevels: ["off"],
					}),
				],
				modelsFetchedAt,
			);

			service.sendMessage({ sessionId: session.id, content: "use current capabilities" });
			scheduler.runAll();
			await service.waitForIdle();

			expect(runtime.inputs[0]?.provider).toMatchObject({
				providerId,
				model: "drifting-model",
			});
			expect(runtime.inputs[0]?.provider.thinkingLevel).toBeUndefined();
			expect(
				(await service.getSession({ sessionId: session.id })).session.model?.thinkingLevel,
			).toBe("high");
		} finally {
			await service.shutdown();
			database.close();
		}
	});

	test("fetchProviderModels stores the normalized catalog and preserves enabled ids", async () => {
		const database = openAppDatabase(":memory:");
		const scheduler = new ManualScheduler();
		const registry = createTestProviderRegistry({ seed: false });
		const requests: string[] = [];
		const service = createService(database, new FakeAskChatRuntime({}), scheduler, {
			providers: registry,
			fetchProviderModels: async (request) => {
				requests.push(request);
				return [createProviderModel("m1"), createProviderModel("m2"), createProviderModel("m3")];
			},
		});

		try {
			const providerId = await seedProvider(registry, {
				displayName: "OpenAI",
				baseUrl: "https://api.openai.com/v1",
				apiKey: "sk-catalog-secret",
				models: [
					createProviderModel("m1", { enabled: false }),
					createProviderModel("m2", { enabled: false }),
				],
				enabledModelIds: ["m1"],
			});

			const output = await service.fetchProviderModels({ schemaVersion: 2, providerId });
			const enabledById = new Map(output.provider.models.map((model) => [model.id, model.enabled]));
			expect(enabledById.get("m1")).toBe(true);
			expect(enabledById.get("m2")).toBe(false);
			expect(enabledById.get("m3")).toBe(false);
			expect(output.provider.modelsFetchedAt).toBeDefined();
			expect(requests).toEqual([providerId]);
		} finally {
			await service.shutdown();
			database.close();
		}
	});

	test("listAvailableModels returns only enabled models of authorized enabled providers", async () => {
		const database = openAppDatabase(":memory:");
		const scheduler = new ManualScheduler();
		const registry = createTestProviderRegistry({ seed: false });
		const service = createService(database, new FakeAskChatRuntime({}), scheduler, {
			providers: registry,
		});

		try {
			const openAiId = await seedProvider(registry, {
				displayName: "OpenAI",
				baseUrl: "https://api.openai.com/v1",
				apiKey: "sk-openai",
				models: [
					createProviderModel("gpt-5.4", { enabled: false }),
					createProviderModel("gpt-legacy", { enabled: false }),
				],
				enabledModelIds: ["gpt-5.4"],
			});
			const anthropicId = await seedProvider(registry, {
				displayName: "Anthropic",
				api: "anthropic-messages",
				baseUrl: "https://api.anthropic.com/v1",
				apiKey: "sk-anthropic",
				models: [
					createProviderModel("claude-4", {
						api: "anthropic-messages",
						enabled: false,
						thinkingLevels: ["off", "low", "medium", "high"],
					}),
				],
				enabledModelIds: ["claude-4"],
			});
			const disabledProviderId = await seedProvider(registry, {
				displayName: "Disabled",
				baseUrl: "https://disabled.example/v1",
				apiKey: "sk-disabled",
				models: [createProviderModel("hidden", { enabled: false })],
				enabledModelIds: ["hidden"],
			});
			await registry.update({ providerId: disabledProviderId, enabled: false });
			const unauthorized = await registry.create({
				displayName: "Unauthorized",
				api: "openai-responses",
				baseUrl: "https://unauthorized.example/v1",
			});
			await registry.setModels(
				unauthorized.id,
				[createProviderModel("unauthorized", { enabled: false })],
				modelsFetchedAt,
			);
			registry.setModelsEnabled(unauthorized.id, ["unauthorized"]);

			const output = service.listAvailableModels();
			const identities = output.models.map((entry) => `${entry.providerId}:${entry.model.id}`);
			expect(identities).toEqual([`${openAiId}:gpt-5.4`, `${anthropicId}:claude-4`]);

			const openAiModel = output.models.find((entry) => entry.providerId === openAiId);
			const anthropicModel = output.models.find((entry) => entry.providerId === anthropicId);
			expect(openAiModel?.model.thinkingLevels).toContain("high");
			expect(anthropicModel?.model.thinkingLevels).toEqual(["off", "low", "medium", "high"]);
		} finally {
			await service.shutdown();
			database.close();
		}
	});
});
