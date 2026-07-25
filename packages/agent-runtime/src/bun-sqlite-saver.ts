import type { RunnableConfig } from "@langchain/core/runnables";
import {
	BaseCheckpointSaver,
	type ChannelVersions,
	type Checkpoint,
	type CheckpointListOptions,
	type CheckpointMetadata,
	type CheckpointPendingWrite,
	type CheckpointTuple,
	type PendingWrite,
	type SerializerProtocol,
	WRITES_IDX_MAP,
	copyCheckpoint,
	getCheckpointId,
} from "@langchain/langgraph-checkpoint";
import Database from "bun:sqlite";

const CURRENT_CHECKPOINT_DATABASE_VERSION = 1;

interface CheckpointRow {
	thread_id: string;
	checkpoint_ns: string;
	checkpoint_id: string;
	parent_checkpoint_id: string | null;
	checkpoint_type: string;
	checkpoint: Uint8Array | string;
	metadata_type: string;
	metadata: Uint8Array | string;
}

interface CheckpointWriteRow {
	task_id: string;
	channel: string;
	value_type: string;
	value: Uint8Array | string;
}

interface SerializedWrite {
	index: number;
	channel: string;
	type: string;
	value: Uint8Array;
}

export class BunSqliteSaver extends BaseCheckpointSaver {
	readonly #client: Database;
	#closed = false;

	constructor(filename: string, serializer?: SerializerProtocol) {
		super(serializer);

		if (filename.trim().length === 0) {
			throw new TypeError("A checkpoint database filename is required.");
		}

		this.#client = new Database(filename, { create: true, strict: true });

		try {
			configureCheckpointDatabase(this.#client);
			applyCheckpointMigrations(this.#client);
		} catch (error) {
			this.#client.close();
			throw error;
		}
	}

	close(): void {
		if (this.#closed) {
			return;
		}

		this.#closed = true;
		this.#client.close();
	}

	async getTuple(config: RunnableConfig): Promise<CheckpointTuple | undefined> {
		this.#assertOpen();

		const threadId = readOptionalIdentifier(config, "thread_id");
		if (threadId === undefined) {
			return undefined;
		}

		const checkpointNamespace = readCheckpointNamespace(config);
		const requestedCheckpointId = getCheckpointId(config);
		const row =
			requestedCheckpointId.length > 0
				? this.#client
						.query<CheckpointRow, [string, string, string]>(
							`
								SELECT
									thread_id,
									checkpoint_ns,
									checkpoint_id,
									parent_checkpoint_id,
									checkpoint_type,
									checkpoint,
									metadata_type,
									metadata
								FROM checkpoints
								WHERE thread_id = ? AND checkpoint_ns = ? AND checkpoint_id = ?
							`,
						)
						.get(threadId, checkpointNamespace, requestedCheckpointId)
				: this.#client
						.query<CheckpointRow, [string, string]>(
							`
								SELECT
									thread_id,
									checkpoint_ns,
									checkpoint_id,
									parent_checkpoint_id,
									checkpoint_type,
									checkpoint,
									metadata_type,
									metadata
								FROM checkpoints
								WHERE thread_id = ? AND checkpoint_ns = ?
								ORDER BY checkpoint_id DESC
								LIMIT 1
							`,
						)
						.get(threadId, checkpointNamespace);

		if (row === null) {
			return undefined;
		}

		return this.#deserializeTuple(row, requestedCheckpointId.length > 0 ? config : undefined);
	}

	async *list(
		config: RunnableConfig,
		options: CheckpointListOptions = {},
	): AsyncGenerator<CheckpointTuple> {
		this.#assertOpen();

		const threadId = readOptionalIdentifier(config, "thread_id");
		const checkpointNamespace = readOptionalCheckpointNamespace(config);
		const checkpointId = readOptionalIdentifier(config, "checkpoint_id");
		const beforeCheckpointId = readOptionalIdentifier(options.before ?? {}, "checkpoint_id");
		const limit = options.limit;

		if (limit !== undefined && (!Number.isInteger(limit) || limit < 0)) {
			throw new TypeError("Checkpoint list limit must be a non-negative integer.");
		}
		if (limit === 0) {
			return;
		}

		const rows = this.#client
			.query<CheckpointRow, [string | null, string | null, string | null, string | null]>(
				`
					SELECT
						thread_id,
						checkpoint_ns,
						checkpoint_id,
						parent_checkpoint_id,
						checkpoint_type,
						checkpoint,
						metadata_type,
						metadata
					FROM checkpoints
					WHERE (? IS NULL OR thread_id = ?)
						AND (? IS NULL OR checkpoint_ns = ?)
					ORDER BY checkpoint_id DESC
				`,
			)
			.all(
				threadId ?? null,
				threadId ?? null,
				checkpointNamespace ?? null,
				checkpointNamespace ?? null,
			);

		let yielded = 0;
		for (const row of rows) {
			if (checkpointId !== undefined && row.checkpoint_id !== checkpointId) {
				continue;
			}
			if (beforeCheckpointId !== undefined && row.checkpoint_id >= beforeCheckpointId) {
				continue;
			}

			const tuple = await this.#deserializeTuple(row);
			if (!matchesMetadataFilter(tuple.metadata, options.filter)) {
				continue;
			}

			yield tuple;
			yielded += 1;
			if (limit !== undefined && yielded >= limit) {
				return;
			}
		}
	}

	async put(
		config: RunnableConfig,
		checkpoint: Checkpoint,
		metadata: CheckpointMetadata,
		_newVersions: ChannelVersions,
	): Promise<RunnableConfig> {
		this.#assertOpen();

		const threadId = readRequiredIdentifier(config, "thread_id", "put checkpoint");
		const checkpointNamespace = readCheckpointNamespace(config);
		assertIdentifier("checkpoint.id", checkpoint.id);
		const parentCheckpointId = getCheckpointId(config) || null;
		const preparedCheckpoint = copyCheckpoint(checkpoint);
		const [[checkpointType, serializedCheckpoint], [metadataType, serializedMetadata]] =
			await Promise.all([
				this.serde.dumpsTyped(preparedCheckpoint),
				this.serde.dumpsTyped(metadata),
			]);

		this.#assertOpen();
		this.#client
			.query<
				unknown,
				[string, string, string, string | null, string, Uint8Array, string, Uint8Array]
			>(
				`
					INSERT OR REPLACE INTO checkpoints (
						thread_id,
						checkpoint_ns,
						checkpoint_id,
						parent_checkpoint_id,
						checkpoint_type,
						checkpoint,
						metadata_type,
						metadata
					) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
				`,
			)
			.run(
				threadId,
				checkpointNamespace,
				checkpoint.id,
				parentCheckpointId,
				checkpointType,
				serializedCheckpoint,
				metadataType,
				serializedMetadata,
			);

		return checkpointConfig(threadId, checkpointNamespace, checkpoint.id);
	}

	async putWrites(config: RunnableConfig, writes: PendingWrite[], taskId: string): Promise<void> {
		this.#assertOpen();

		const threadId = readRequiredIdentifier(config, "thread_id", "put checkpoint writes");
		const checkpointNamespace = readCheckpointNamespace(config);
		const checkpointId = readRequiredIdentifier(config, "checkpoint_id", "put checkpoint writes");
		assertIdentifier("taskId", taskId);
		const serializedWrites = await Promise.all(
			writes.map(async ([channel, value], index): Promise<SerializedWrite> => {
				assertIdentifier("write channel", channel);
				const [type, serializedValue] = await this.serde.dumpsTyped(value);
				return {
					index: WRITES_IDX_MAP[channel] ?? index,
					channel,
					type,
					value: serializedValue,
				};
			}),
		);

		this.#assertOpen();
		const insertMode = writes.every(([channel]) => channel in WRITES_IDX_MAP)
			? "OR REPLACE"
			: "OR IGNORE";
		const statement = this.#client.query<
			unknown,
			[string, string, string, string, number, string, string, Uint8Array]
		>(
			`
				INSERT ${insertMode} INTO checkpoint_writes (
					thread_id,
					checkpoint_ns,
					checkpoint_id,
					task_id,
					idx,
					channel,
					value_type,
					value
				) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
			`,
		);

		this.#client.exec("BEGIN IMMEDIATE");
		try {
			for (const write of serializedWrites) {
				statement.run(
					threadId,
					checkpointNamespace,
					checkpointId,
					taskId,
					write.index,
					write.channel,
					write.type,
					write.value,
				);
			}
			this.#client.exec("COMMIT");
		} catch (error) {
			this.#client.exec("ROLLBACK");
			throw error;
		}
	}

	async deleteThread(threadId: string): Promise<void> {
		this.#assertOpen();
		assertIdentifier("threadId", threadId);

		this.#client.exec("BEGIN IMMEDIATE");
		try {
			this.#client
				.query<unknown, [string]>("DELETE FROM checkpoint_writes WHERE thread_id = ?")
				.run(threadId);
			this.#client
				.query<unknown, [string]>("DELETE FROM checkpoints WHERE thread_id = ?")
				.run(threadId);
			this.#client.exec("COMMIT");
		} catch (error) {
			this.#client.exec("ROLLBACK");
			throw error;
		}
	}

	async #deserializeTuple(
		row: CheckpointRow,
		explicitConfig?: RunnableConfig,
	): Promise<CheckpointTuple> {
		const checkpoint = (await this.serde.loadsTyped(
			row.checkpoint_type,
			row.checkpoint,
		)) as Checkpoint;
		const metadata = (await this.serde.loadsTyped(
			row.metadata_type,
			row.metadata,
		)) as CheckpointMetadata;

		const tuple: CheckpointTuple = {
			config:
				explicitConfig ?? checkpointConfig(row.thread_id, row.checkpoint_ns, row.checkpoint_id),
			checkpoint,
			metadata,
			pendingWrites: await this.#readPendingWrites(
				row.thread_id,
				row.checkpoint_ns,
				row.checkpoint_id,
			),
		};

		if (row.parent_checkpoint_id !== null) {
			tuple.parentConfig = checkpointConfig(
				row.thread_id,
				row.checkpoint_ns,
				row.parent_checkpoint_id,
			);
		}

		return tuple;
	}

	async #readPendingWrites(
		threadId: string,
		checkpointNamespace: string,
		checkpointId: string,
	): Promise<CheckpointPendingWrite[]> {
		const rows = this.#client
			.query<CheckpointWriteRow, [string, string, string]>(
				`
					SELECT task_id, channel, value_type, value
					FROM checkpoint_writes
					WHERE thread_id = ? AND checkpoint_ns = ? AND checkpoint_id = ?
					ORDER BY task_id, idx
				`,
			)
			.all(threadId, checkpointNamespace, checkpointId);

		return Promise.all(
			rows.map(
				async (row): Promise<CheckpointPendingWrite> => [
					row.task_id,
					row.channel,
					await this.serde.loadsTyped(row.value_type, row.value),
				],
			),
		);
	}

	#assertOpen(): void {
		if (this.#closed) {
			throw new Error("BunSqliteSaver is closed.");
		}
	}
}

function configureCheckpointDatabase(client: Database): void {
	client.exec(`
		PRAGMA foreign_keys = ON;
		PRAGMA busy_timeout = 5000;
		PRAGMA journal_mode = WAL;
		PRAGMA synchronous = NORMAL;
	`);
}

function applyCheckpointMigrations(client: Database): void {
	const currentVersion =
		client.query<{ user_version: number }, []>("PRAGMA user_version").get()?.user_version ?? 0;

	if (currentVersion !== 0 && currentVersion !== CURRENT_CHECKPOINT_DATABASE_VERSION) {
		throw new Error(
			`Checkpoint database user_version ${currentVersion} is unsupported; expected ${CURRENT_CHECKPOINT_DATABASE_VERSION}.`,
		);
	}
	if (currentVersion === CURRENT_CHECKPOINT_DATABASE_VERSION) {
		return;
	}

	client.exec("BEGIN IMMEDIATE");
	try {
		client.exec(`
			CREATE TABLE checkpoints (
				thread_id TEXT NOT NULL,
				checkpoint_ns TEXT NOT NULL DEFAULT '',
				checkpoint_id TEXT NOT NULL,
				parent_checkpoint_id TEXT,
				checkpoint_type TEXT NOT NULL,
				checkpoint BLOB NOT NULL,
				metadata_type TEXT NOT NULL,
				metadata BLOB NOT NULL,
				PRIMARY KEY (thread_id, checkpoint_ns, checkpoint_id)
			) WITHOUT ROWID;

			CREATE TABLE checkpoint_writes (
				thread_id TEXT NOT NULL,
				checkpoint_ns TEXT NOT NULL DEFAULT '',
				checkpoint_id TEXT NOT NULL,
				task_id TEXT NOT NULL,
				idx INTEGER NOT NULL,
				channel TEXT NOT NULL,
				value_type TEXT NOT NULL,
				value BLOB NOT NULL,
				PRIMARY KEY (thread_id, checkpoint_ns, checkpoint_id, task_id, idx)
			) WITHOUT ROWID;

			CREATE INDEX checkpoints_thread_namespace_id_idx
				ON checkpoints(thread_id, checkpoint_ns, checkpoint_id DESC);
			CREATE INDEX checkpoint_writes_thread_idx
				ON checkpoint_writes(thread_id, checkpoint_ns, checkpoint_id, task_id, idx);
			PRAGMA user_version = ${CURRENT_CHECKPOINT_DATABASE_VERSION};
			COMMIT;
		`);
	} catch (error) {
		client.exec("ROLLBACK");
		throw error;
	}
}

function checkpointConfig(
	threadId: string,
	checkpointNamespace: string,
	checkpointId: string,
): RunnableConfig {
	return {
		configurable: {
			thread_id: threadId,
			checkpoint_ns: checkpointNamespace,
			checkpoint_id: checkpointId,
		},
	};
}

function readRequiredIdentifier(config: RunnableConfig, key: string, action: string): string {
	const value = readOptionalIdentifier(config, key);
	if (value === undefined) {
		throw new Error(`Cannot ${action}: config.configurable.${key} must be a non-empty string.`);
	}
	return value;
}

function readOptionalIdentifier(config: RunnableConfig, key: string): string | undefined {
	const value = config.configurable?.[key];
	if (value === undefined) {
		return undefined;
	}
	assertIdentifier(`config.configurable.${key}`, value);
	return value;
}

function readCheckpointNamespace(config: RunnableConfig): string {
	return readOptionalCheckpointNamespace(config) ?? "";
}

function readOptionalCheckpointNamespace(config: RunnableConfig): string | undefined {
	const value = config.configurable?.checkpoint_ns;
	if (value === undefined) {
		return undefined;
	}
	if (typeof value !== "string") {
		throw new TypeError("config.configurable.checkpoint_ns must be a string.");
	}
	return value;
}

function assertIdentifier(name: string, value: unknown): asserts value is string {
	if (typeof value !== "string" || value.length === 0) {
		throw new TypeError(`${name} must be a non-empty string.`);
	}
}

function matchesMetadataFilter(
	metadata: CheckpointMetadata | undefined,
	filter: Record<string, unknown> | undefined,
): boolean {
	if (filter === undefined) {
		return true;
	}
	if (metadata === undefined) {
		return false;
	}

	return Object.entries(filter).every(
		([key, value]) => value === undefined || Reflect.get(metadata, key) === value,
	);
}
