import {
	chatRunToolStatusSchema,
	type ChatRunToolStatus,
	type ToolPublicPayload,
	toolPublicPayloadSchema,
} from "@moshu/contracts";
import { sql } from "drizzle-orm";
import type { AppDrizzleDatabase } from "./database";
import { runTimelineOutboxTable } from "./schema";

export interface EnqueueRunTimelineTransitionInput {
	runId: string;
	toolCallId: string;
	authority: "approval" | "action";
	status: ChatRunToolStatus;
	approvalId?: string;
	safeError?: string;
	publicOutput?: ToolPublicPayload;
	createdAtMs?: number;
}

export interface RunTimelineOutboxWriter {
	enqueue(input: EnqueueRunTimelineTransitionInput): void;
}

export interface RunTimelineOutboxRepository extends RunTimelineOutboxWriter {
	pendingCount(): number;
}

export class SqliteRunTimelineOutboxRepository implements RunTimelineOutboxRepository {
	constructor(
		private readonly orm: AppDrizzleDatabase,
		private readonly clock: { now(): number } = { now: Date.now },
	) {}

	enqueue(input: EnqueueRunTimelineTransitionInput): void {
		const runId = input.runId.trim();
		const toolCallId = input.toolCallId.trim();
		if (runId.length === 0 || toolCallId.length === 0) {
			throw new TypeError("Run timeline outbox requires a Run ID and Tool call ID.");
		}
		const safeError = input.safeError?.trim().slice(0, 1_024);
		this.orm
			.insert(runTimelineOutboxTable)
			.values({
				runId,
				toolCallId,
				authority: input.authority,
				status: chatRunToolStatusSchema.parse(input.status),
				approvalId: input.approvalId ?? null,
				safeError: safeError === undefined || safeError.length === 0 ? null : safeError,
				publicOutputJson:
					input.publicOutput === undefined
						? null
						: JSON.stringify(toolPublicPayloadSchema.parse(input.publicOutput)),
				createdAtMs: input.createdAtMs ?? this.clock.now(),
			})
			.run();
	}

	pendingCount(): number {
		return (
			this.orm.select({ value: sql<number>`count(*)` }).from(runTimelineOutboxTable).get()?.value ??
			0
		);
	}
}
