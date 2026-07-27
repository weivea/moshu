import Database from "bun:sqlite";
import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type {
	Checkpoint,
	CheckpointMetadata,
	CheckpointPendingWrite,
} from "@langchain/langgraph-checkpoint";
import { INTERRUPT } from "@langchain/langgraph-checkpoint";

import { BunSqliteSaver } from "../src";

describe("BunSqliteSaver", () => {
	test("implements the locked checkpoint, write, list, and delete contracts", async () => {
		await withTempDirectory(async (directoryPath) => {
			const saver = new BunSqliteSaver(join(directoryPath, "checkpoints.db"));
			const firstCheckpoint = createCheckpoint(CHECKPOINT_IDS.first, "first");
			const secondCheckpoint = createCheckpoint(CHECKPOINT_IDS.second, "second");
			const otherCheckpoint = createCheckpoint(CHECKPOINT_IDS.other, "other");

			try {
				const firstConfig = await saver.put(
					threadConfig("thread-a", "ask"),
					firstCheckpoint,
					createMetadata(-1, "first"),
					{ messages: 1 },
				);
				await saver.putWrites(
					firstConfig,
					[
						["result", { value: "first-write" }],
						[INTERRUPT, { value: "first-interrupt" }],
					],
					"task-a",
				);
				await saver.putWrites(firstConfig, [["result", { value: "must-not-replace" }]], "task-a");
				await saver.putWrites(
					firstConfig,
					[[INTERRUPT, { value: "replacement-interrupt" }]],
					"task-a",
				);

				const secondConfig = await saver.put(
					firstConfig,
					secondCheckpoint,
					createMetadata(0, "second"),
					{ messages: 2 },
				);
				await saver.putWrites(secondConfig, [["bytes", new Uint8Array([1, 2, 3])]], "task-b");
				await saver.put(
					threadConfig("thread-b", "ask"),
					otherCheckpoint,
					createMetadata(-1, "other"),
					{ messages: 1 },
				);

				const latest = await saver.getTuple(threadConfig("thread-a", "ask"));
				expect(latest?.checkpoint).toEqual(secondCheckpoint);
				expect(latest?.config).toEqual(secondConfig);
				expect(latest?.parentConfig).toEqual(firstConfig);
				expect(findWrite(latest?.pendingWrites, "bytes")).toEqual(new Uint8Array([1, 2, 3]));

				const first = await saver.getTuple(firstConfig);
				expect(findWrite(first?.pendingWrites, "result")).toEqual({
					value: "first-write",
				});
				expect(findWrite(first?.pendingWrites, INTERRUPT)).toEqual({
					value: "replacement-interrupt",
				});

				expect(
					(await collect(saver.list(threadConfig("thread-a", "ask")))).map(
						(tuple) => tuple.checkpoint.id,
					),
				).toEqual([CHECKPOINT_IDS.second, CHECKPOINT_IDS.first]);
				expect(
					(
						await collect(
							saver.list(threadConfig("thread-a", "ask"), {
								before: secondConfig,
							}),
						)
					).map((tuple) => tuple.checkpoint.id),
				).toEqual([CHECKPOINT_IDS.first]);
				expect(
					(
						await collect(
							saver.list(threadConfig("thread-a", "ask"), {
								filter: { label: "second" },
								limit: 1,
							}),
						)
					).map((tuple) => tuple.checkpoint.id),
				).toEqual([CHECKPOINT_IDS.second]);
				expect(
					(await collect(saver.list({}))).map((tuple) => tuple.config.configurable?.thread_id),
				).toEqual(["thread-b", "thread-a", "thread-a"]);

				await saver.deleteThread("thread-a");
				expect(await saver.getTuple(threadConfig("thread-a", "ask"))).toBeUndefined();
				expect(await collect(saver.list(threadConfig("thread-a", "ask")))).toEqual([]);
				expect((await saver.getTuple(threadConfig("thread-b", "ask")))?.checkpoint.id).toBe(
					CHECKPOINT_IDS.other,
				);
			} finally {
				saver.close();
			}
		});
	});

	test("reopens the dedicated WAL database with current-schema checkpoints intact", async () => {
		await withTempDirectory(async (directoryPath) => {
			const databasePath = join(directoryPath, "deep-agent-checkpoints.db");
			const checkpoint = createCheckpoint(CHECKPOINT_IDS.first, new Uint8Array([7, 8, 9]));
			const saver = new BunSqliteSaver(databasePath);
			const config = await saver.put(
				threadConfig("reopen-thread", "ask"),
				checkpoint,
				createMetadata(-1, "reopen"),
				{ messages: 1 },
			);
			saver.close();

			const inspector = new Database(databasePath, { readonly: true, strict: true });
			try {
				expect(
					inspector.query<{ journal_mode: string }, []>("PRAGMA journal_mode").get()?.journal_mode,
				).toBe("wal");
				expect(
					inspector.query<{ user_version: number }, []>("PRAGMA user_version").get()?.user_version,
				).toBe(1);
				expect(
					inspector
						.query<{ name: string }, []>(
							"SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name",
						)
						.all()
						.map((row) => row.name),
				).toEqual(["checkpoint_writes", "checkpoints"]);
			} finally {
				inspector.close();
			}

			const reopened = new BunSqliteSaver(databasePath);
			try {
				const restored = await reopened.getTuple(config);
				expect(restored?.checkpoint).toEqual(checkpoint);
				expect(restored?.metadata).toMatchObject({ label: "reopen" });
			} finally {
				reopened.close();
				reopened.close();
			}

			await expect(reopened.getTuple(config)).rejects.toThrow("BunSqliteSaver is closed.");
		});
	});

	test("rejects unsupported checkpoint schema versions instead of silently migrating them", async () => {
		await withTempDirectory(async (directoryPath) => {
			const databasePath = join(directoryPath, "unsupported.db");
			const unsupported = new Database(databasePath, { create: true, strict: true });
			unsupported.exec("PRAGMA user_version = 2");
			unsupported.close();

			expect(() => new BunSqliteSaver(databasePath)).toThrow(
				"Checkpoint database user_version 2 is unsupported",
			);
		});
	});
});

const CHECKPOINT_IDS = {
	first: "00000000-0000-6000-8000-000000000001",
	second: "00000000-0000-6000-8000-000000000002",
	other: "00000000-0000-6000-8000-000000000003",
} as const;

function createCheckpoint(id: string, value: unknown): Checkpoint {
	return {
		v: 4,
		id,
		ts: "2026-07-25T00:00:00.000Z",
		channel_values: {
			messages: value,
		},
		channel_versions: {
			messages: 1,
		},
		versions_seen: {},
	};
}

function createMetadata(step: number, label: string): CheckpointMetadata & { label: string } {
	return {
		source: step === -1 ? "input" : "loop",
		step,
		parents: {},
		label,
	};
}

function threadConfig(threadId: string, checkpointNamespace: string) {
	return {
		configurable: {
			thread_id: threadId,
			checkpoint_ns: checkpointNamespace,
		},
	};
}

function findWrite(writes: CheckpointPendingWrite[] | undefined, channel: string): unknown {
	return writes?.find((write) => write[1] === channel)?.[2];
}

async function collect<T>(iterable: AsyncIterable<T>): Promise<T[]> {
	const values: T[] = [];
	for await (const value of iterable) {
		values.push(value);
	}
	return values;
}

async function withTempDirectory(run: (directoryPath: string) => Promise<void>): Promise<void> {
	const directoryPath = mkdtempSync(join(tmpdir(), "moshu-checkpoints-"));
	try {
		await run(directoryPath);
	} finally {
		rmSync(directoryPath, { force: true, recursive: true });
	}
}
