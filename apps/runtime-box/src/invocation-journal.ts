import { createHash } from "node:crypto";
import {
	chmodSync,
	closeSync,
	existsSync,
	fsyncSync,
	lstatSync,
	mkdirSync,
	openSync,
	readFileSync,
	renameSync,
	unlinkSync,
	writeFileSync,
} from "node:fs";
import { dirname, join, resolve } from "node:path";
import {
	actionParameterDigestSchema,
	createExecutorToolParameterPayload,
	type ExecutorToolInvokeInput,
	type ExecutorToolInvokeOutput,
	runtimeBoxInvocationEvidenceSchema,
	runtimeBoxToolInvokeOutputSchema,
	type RuntimeBoxInvocationEvidence,
	productRpcMaxFrameBytes,
	productRpcMethods,
	reconcileRuntimeBoxInvocationsInputSchema,
	reconcileRuntimeBoxInvocationsOutputSchema,
} from "@moshu/contracts";
import {
	type JsonValue,
	type RpcPeerIdentity,
	type RpcRequestOptions,
	rpcJsonValueSchema,
} from "@moshu/process-rpc";
import { z } from "zod";

const maxInvocationJournalRecords = 1_024;
const maxConsumedGrantTombstones = 4_096;
const unconfirmedReceiptRetentionMs = 30 * 24 * 60 * 60 * 1_000;

const consumedGrantSchema = z
	.object({
		grantId: z.string().uuid(),
		invocationId: z.string().uuid(),
		parameterDigest: actionParameterDigestSchema,
		expiresAt: z.string().datetime({ offset: true }),
		recoveryExpiresAt: z.string().datetime({ offset: true }),
		serverConfirmed: z.boolean().default(false),
	})
	.strict();

const journalRecordSchema = z
	.object({
		invocationId: z.string().uuid(),
		actionId: z.string().uuid(),
		grantId: z.string().uuid(),
		grantTokenHash: z.string().regex(/^[a-f0-9]{64}$/),
		parameterDigest: actionParameterDigestSchema,
		originInstanceId: z.string().min(1).max(256),
		originGeneration: z.int().nonnegative().safe(),
		targetRuntimeBoxId: z.string().min(1).max(128),
		targetInstanceId: z.string().min(1).max(256),
		targetGeneration: z.int().nonnegative().safe(),
		executionScope: z.enum(["request-cwd", "runtime-box-workspace"]),
		grantExpiresAt: z.string().datetime({ offset: true }),
		state: z.enum(["prepared", "running", "succeeded", "failed", "cancelled", "outcome_unknown"]),
		result: runtimeBoxToolInvokeOutputSchema.optional(),
		safeError: z.string().min(1).max(1_024).optional(),
		startedAt: z.string().datetime({ offset: true }),
		completedAt: z.string().datetime({ offset: true }).optional(),
	})
	.strict();

const journalFileSchema = z
	.object({
		schemaVersion: z.literal(1),
		records: z.array(journalRecordSchema).max(maxInvocationJournalRecords),
		consumedGrants: z.array(consumedGrantSchema).max(maxConsumedGrantTombstones).default([]),
	})
	.strict();

type JournalRecord = z.infer<typeof journalRecordSchema>;
type ConsumedGrant = z.infer<typeof consumedGrantSchema>;

export class InvocationGrantRejectedError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "InvocationGrantRejectedError";
	}
}

export class RuntimeBoxInvocationJournal {
	readonly #filename: string;
	readonly #records = new Map<string, JournalRecord>();
	readonly #consumedGrants = new Map<string, ConsumedGrant>();

	constructor(root: string) {
		const normalizedRoot = resolve(root);
		mkdirSync(normalizedRoot, { recursive: true, mode: 0o700 });
		chmodSync(normalizedRoot, 0o700);
		this.#filename = join(normalizedRoot, "invocations.json");
		this.#load();
	}

	begin(
		input: ExecutorToolInvokeInput,
		authority: RpcPeerIdentity,
		target: RpcPeerIdentity,
		executionCwdOverride?: string,
	): { replayResult?: ExecutorToolInvokeOutput } {
		const authorization = input.authorization;
		if (authorization === undefined) {
			throw new InvocationGrantRejectedError("Tool invocation is missing an execution grant.");
		}
		if (
			authority.role !== "agents" ||
			authorization.originInstanceId !== authority.instanceId ||
			authorization.originGeneration !== authority.generation
		) {
			throw new InvocationGrantRejectedError(
				"Execution grant origin did not match the authenticated Agent Server.",
			);
		}
		if (
			(authorization.executionScope === "runtime-box-workspace") !==
			(executionCwdOverride !== undefined)
		) {
			throw new InvocationGrantRejectedError(
				"Execution grant scope did not match Runtime Box workspace policy.",
			);
		}
		if (
			target.role !== "runtime-box" ||
			authorization.targetRuntimeBoxId !== target.peerId ||
			authorization.targetInstanceId !== target.instanceId ||
			authorization.targetGeneration !== target.generation
		) {
			throw new InvocationGrantRejectedError(
				"Execution grant target did not match this Runtime Box generation.",
			);
		}
		if (Date.parse(authorization.expiresAt) <= Date.now()) {
			throw new InvocationGrantRejectedError("Execution grant expired before execution.");
		}
		const { authorization: _authorization, ...parameters } = input;
		const parameterDigest = sha256(createExecutorToolParameterPayload(parameters));
		if (parameterDigest !== authorization.parameterDigest) {
			throw new InvocationGrantRejectedError("Execution grant parameter digest did not match.");
		}
		this.#pruneExpiredGrantTombstones();
		if (this.#consumedGrants.has(authorization.grantId)) {
			throw new InvocationGrantRejectedError(
				"Execution grant was already acknowledged and consumed.",
			);
		}
		for (const record of this.#records.values()) {
			if (record.grantId !== authorization.grantId) {
				continue;
			}
			if (
				record.invocationId !== input.invocationId ||
				record.actionId !== authorization.actionId ||
				record.parameterDigest !== parameterDigest
			) {
				throw new InvocationGrantRejectedError("Execution grant was already used.");
			}
			if (record.state === "succeeded" && record.result !== undefined) {
				return { replayResult: record.result };
			}
			throw new InvocationGrantRejectedError(
				"Execution grant cannot replay an incomplete or non-successful Action.",
			);
		}
		if (this.#records.size >= maxInvocationJournalRecords) {
			throw new InvocationGrantRejectedError("Runtime Box invocation journal is full.");
		}
		const record: JournalRecord = {
			invocationId: input.invocationId,
			actionId: authorization.actionId,
			grantId: authorization.grantId,
			grantTokenHash: sha256(authorization.grantToken),
			parameterDigest,
			originInstanceId: authorization.originInstanceId,
			originGeneration: authorization.originGeneration,
			targetRuntimeBoxId: authorization.targetRuntimeBoxId,
			targetInstanceId: authorization.targetInstanceId,
			targetGeneration: authorization.targetGeneration,
			executionScope: authorization.executionScope,
			grantExpiresAt: authorization.expiresAt,
			state: "prepared",
			startedAt: new Date().toISOString(),
		};
		this.#records.set(record.invocationId, record);
		this.#persist();
		record.state = "running";
		this.#persist();
		return {};
	}

	succeed(invocationId: string, resultValue: ExecutorToolInvokeOutput): void {
		const record = this.#requireRunning(invocationId);
		record.state = "succeeded";
		record.result = runtimeBoxToolInvokeOutputSchema.parse(resultValue);
		record.completedAt = new Date().toISOString();
		this.#persist();
	}

	fail(invocationId: string, safeError: string): void {
		this.#finishWithoutResult(invocationId, "failed", safeError);
	}

	cancel(invocationId: string, safeError: string): void {
		this.#finishWithoutResult(invocationId, "cancelled", safeError);
	}

	listEvidence(): RuntimeBoxInvocationEvidence[] {
		return [...this.#records.values()]
			.filter(
				(record) =>
					record.state === "succeeded" ||
					record.state === "failed" ||
					record.state === "cancelled" ||
					record.state === "outcome_unknown",
			)
			.map((record) =>
				runtimeBoxInvocationEvidenceSchema.parse({
					invocationId: record.invocationId,
					actionId: record.actionId,
					grantId: record.grantId,
					parameterDigest: record.parameterDigest,
					originInstanceId: record.originInstanceId,
					originGeneration: record.originGeneration,
					targetRuntimeBoxId: record.targetRuntimeBoxId,
					targetInstanceId: record.targetInstanceId,
					targetGeneration: record.targetGeneration,
					state: record.state,
					...(record.result === undefined ? {} : { result: record.result }),
					...(record.safeError === undefined ? {} : { safeError: record.safeError }),
					completedAt: record.completedAt ?? record.startedAt,
				}),
			);
	}

	nextReconciliationBatch(maxBytes = productRpcMaxFrameBytes - 64 * 1024): {
		items: RuntimeBoxInvocationEvidence[];
		acknowledgedInvocationIds: string[];
	} {
		const batch: RuntimeBoxInvocationEvidence[] = [];
		for (const evidence of this.listEvidence()) {
			const candidate = {
				items: [...batch, evidence],
				acknowledgedInvocationIds: [] as string[],
			};
			if (Buffer.byteLength(JSON.stringify(candidate), "utf8") > maxBytes) {
				if (batch.length === 0) {
					throw new Error(
						"One Runtime Box invocation evidence record exceeds the RPC frame limit.",
					);
				}
				break;
			}
			batch.push(evidence);
			if (batch.length >= 64) {
				break;
			}
		}
		const acknowledgedInvocationIds: string[] = [];
		for (const consumed of this.#consumedGrants.values()) {
			if (consumed.serverConfirmed) {
				continue;
			}
			const candidate = {
				items: batch,
				acknowledgedInvocationIds: [...acknowledgedInvocationIds, consumed.invocationId],
			};
			if (
				candidate.acknowledgedInvocationIds.length > 64 ||
				Buffer.byteLength(JSON.stringify(candidate), "utf8") > maxBytes
			) {
				break;
			}
			acknowledgedInvocationIds.push(consumed.invocationId);
		}
		return { items: batch, acknowledgedInvocationIds };
	}

	acknowledge(invocationIds: readonly string[]): string[] {
		this.#pruneExpiredGrantTombstones();
		const acknowledged: string[] = [];
		const removedRecords: JournalRecord[] = [];
		const previousConsumed = new Map<string, ConsumedGrant | undefined>();
		for (const invocationId of new Set(invocationIds)) {
			const record = this.#records.get(invocationId);
			if (record === undefined || record.state === "prepared" || record.state === "running") {
				continue;
			}
			if (
				!this.#consumedGrants.has(record.grantId) &&
				this.#consumedGrants.size >= maxConsumedGrantTombstones
			) {
				continue;
			}
			this.#records.delete(invocationId);
			removedRecords.push(record);
			previousConsumed.set(record.grantId, this.#consumedGrants.get(record.grantId));
			this.#consumedGrants.set(record.grantId, {
				grantId: record.grantId,
				invocationId: record.invocationId,
				parameterDigest: record.parameterDigest,
				expiresAt: record.grantExpiresAt,
				recoveryExpiresAt: new Date(Date.now() + unconfirmedReceiptRetentionMs).toISOString(),
				serverConfirmed: false,
			});
			acknowledged.push(invocationId);
		}
		if (acknowledged.length > 0) {
			try {
				this.#persist();
			} catch (error) {
				for (const record of removedRecords) {
					this.#records.set(record.invocationId, record);
					const previous = previousConsumed.get(record.grantId);
					if (previous === undefined) {
						this.#consumedGrants.delete(record.grantId);
					} else {
						this.#consumedGrants.set(record.grantId, previous);
					}
				}
				throw error;
			}
		}
		return acknowledged;
	}

	confirmAcknowledgements(invocationIds: readonly string[]): string[] {
		const requested = new Set(invocationIds);
		const confirmed: string[] = [];
		const changed: ConsumedGrant[] = [];
		for (const consumed of this.#consumedGrants.values()) {
			if (!requested.has(consumed.invocationId)) {
				continue;
			}
			consumed.serverConfirmed = true;
			changed.push(consumed);
			confirmed.push(consumed.invocationId);
		}
		if (confirmed.length > 0) {
			try {
				this.#persist();
			} catch (error) {
				for (const consumed of changed) {
					consumed.serverConfirmed = false;
				}
				throw error;
			}
		}
		return confirmed;
	}

	#finishWithoutResult(
		invocationId: string,
		state: "failed" | "cancelled",
		safeError: string,
	): void {
		const record = this.#requireRunning(invocationId);
		record.state = state;
		record.safeError = boundSafeError(safeError);
		record.completedAt = new Date().toISOString();
		this.#persist();
	}

	#requireRunning(invocationId: string): JournalRecord {
		const record = this.#records.get(invocationId);
		if (record?.state !== "running") {
			throw new InvocationGrantRejectedError("Invocation is not running in the Box journal.");
		}
		return record;
	}

	#load(): void {
		if (!existsSync(this.#filename)) {
			return;
		}
		const metadata = lstatSync(this.#filename);
		if (!metadata.isFile() || metadata.isSymbolicLink()) {
			throw new Error("Runtime Box invocation journal must be a regular file.");
		}
		chmodSync(this.#filename, 0o600);
		const parsed = journalFileSchema.parse(JSON.parse(readFileSync(this.#filename, "utf8")));
		let recovered = false;
		for (const record of parsed.records) {
			if (record.state === "prepared" || record.state === "running") {
				record.state = "outcome_unknown";
				record.safeError = "Runtime Box restarted before the Action outcome was confirmed.";
				record.completedAt = new Date().toISOString();
				recovered = true;
			}
			this.#records.set(record.invocationId, record);
		}
		for (const consumed of parsed.consumedGrants) {
			this.#consumedGrants.set(consumed.grantId, consumed);
		}
		this.#pruneExpiredGrantTombstones();
		if (recovered) {
			this.#persist();
		}
	}

	#persist(): void {
		const temporary = `${this.#filename}.${process.pid}.${crypto.randomUUID()}.tmp`;
		const content = `${JSON.stringify({
			schemaVersion: 1,
			records: [...this.#records.values()],
			consumedGrants: [...this.#consumedGrants.values()],
		})}\n`;
		let fileDescriptor: number | undefined;
		try {
			fileDescriptor = openSync(temporary, "wx", 0o600);
			writeFileSync(fileDescriptor, content, "utf8");
			fsyncSync(fileDescriptor);
			closeSync(fileDescriptor);
			fileDescriptor = undefined;
			renameSync(temporary, this.#filename);
			chmodSync(this.#filename, 0o600);
			if (process.platform !== "win32") {
				const directoryDescriptor = openSync(dirname(this.#filename), "r");
				try {
					fsyncSync(directoryDescriptor);
				} finally {
					closeSync(directoryDescriptor);
				}
			}
		} catch (error) {
			if (fileDescriptor !== undefined) {
				closeSync(fileDescriptor);
			}
			if (existsSync(temporary)) {
				unlinkSync(temporary);
			}
			throw error;
		}
	}

	#pruneExpiredGrantTombstones(): void {
		const now = Date.now();
		for (const [grantId, consumed] of this.#consumedGrants) {
			const expiry = consumed.serverConfirmed
				? Date.parse(consumed.expiresAt)
				: Date.parse(consumed.recoveryExpiresAt);
			if (expiry <= now) {
				this.#consumedGrants.delete(grantId);
			}
		}
	}
}

export async function reconcileInvocationJournal(
	peer: {
		request(method: string, payload: JsonValue, options?: RpcRequestOptions): Promise<JsonValue>;
	},
	journal: RuntimeBoxInvocationJournal,
	signal: AbortSignal,
): Promise<void> {
	while (true) {
		const batch = journal.nextReconciliationBatch();
		if (batch.items.length === 0 && batch.acknowledgedInvocationIds.length === 0) {
			return;
		}
		const response = await peer.request(
			productRpcMethods.runtimeBoxInvocationsReconcile,
			rpcJsonValueSchema.parse(reconcileRuntimeBoxInvocationsInputSchema.parse(batch)),
			{ signal },
		);
		const output = reconcileRuntimeBoxInvocationsOutputSchema.parse(response);
		const acknowledged = journal.acknowledge(output.ackedInvocationIds);
		const confirmed = journal.confirmAcknowledgements(output.confirmedAcknowledgementIds);
		if (acknowledged.length === 0 && confirmed.length === 0) {
			throw new Error("Agent Server did not acknowledge Runtime Box invocation evidence.");
		}
	}
}

export async function watchInvocationReconciliation(
	peer: Parameters<typeof reconcileInvocationJournal>[0],
	journal: RuntimeBoxInvocationJournal,
	signal: AbortSignal,
	options: {
		intervalMs?: number;
		onError?: (error: unknown) => void;
	} = {},
): Promise<void> {
	const intervalMs = options.intervalMs ?? 1_000;
	while (!signal.aborted) {
		await waitForAbortableDelay(intervalMs, signal);
		if (signal.aborted) {
			return;
		}
		try {
			await reconcileInvocationJournal(peer, journal, signal);
		} catch (error) {
			if (signal.aborted) {
				return;
			}
			options.onError?.(error);
		}
	}
}

function sha256(value: string): string {
	return createHash("sha256").update(value).digest("hex");
}

function boundSafeError(value: string): string {
	const normalized = value.trim();
	return normalized.length === 0 ? "Action failed." : normalized.slice(0, 1_024);
}

function waitForAbortableDelay(milliseconds: number, signal: AbortSignal): Promise<void> {
	if (signal.aborted) {
		return Promise.resolve();
	}
	return new Promise((resolveDelay) => {
		const timer = setTimeout(done, milliseconds);
		function done() {
			clearTimeout(timer);
			signal.removeEventListener("abort", done);
			resolveDelay();
		}
		signal.addEventListener("abort", done, { once: true });
	});
}
