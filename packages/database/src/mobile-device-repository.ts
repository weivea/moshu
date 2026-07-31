import {
	type ListMobileDevicesOutput,
	type MobileDevice,
	mobileDeviceListPageSize,
	mobileDeviceSchema,
} from "@moshu/contracts";
import { and, asc, eq, isNull, sql } from "drizzle-orm";

import type { AppDrizzleDatabase } from "./database";
import {
	mobileDeviceGenerationFencesTable,
	mobileDeviceKeysTable,
	mobileDevicesTable,
} from "./schema";

interface RepositoryClock {
	now(): number;
}

type AppDatabaseTransaction = Parameters<Parameters<AppDrizzleDatabase["transaction"]>[0]>[0];

export type MobileDeviceGenerationAcceptance =
	| { accepted: true }
	| {
			accepted: false;
			code: "STALE_GENERATION" | "GENERATION_CONFLICT";
			currentGeneration: number;
	  };

export class MobileDeviceNotFoundError extends Error {
	constructor(readonly mobileClientId: string) {
		super(`Mobile device ${mobileClientId} was not found.`);
		this.name = "MobileDeviceNotFoundError";
	}
}

export class MobileDeviceRevokedError extends Error {
	constructor(readonly mobileClientId: string) {
		super(`Mobile device ${mobileClientId} is revoked.`);
		this.name = "MobileDeviceRevokedError";
	}
}

export class MobileDeviceCursorError extends Error {
	constructor() {
		super("Mobile device list cursor is malformed.");
		this.name = "MobileDeviceCursorError";
	}
}

export interface MobileDeviceListOptions {
	cursor?: string | undefined;
	limit?: number | undefined;
}

interface MobileDeviceCursor {
	readonly revokedSort: 0 | 1;
	readonly createdAtMs: number;
	readonly id: string;
}

export interface MobileDeviceRepository {
	list(options?: MobileDeviceListOptions): ListMobileDevicesOutput;
	get(mobileClientId: string): MobileDevice;
	markLastSeen(mobileClientId: string): void;
	revokeDevice(mobileClientId: string): void;
	acceptGeneration(
		mobileClientId: string,
		instanceId: string,
		generation: number,
	): MobileDeviceGenerationAcceptance;
}

export class SqliteMobileDeviceRepository implements MobileDeviceRepository {
	constructor(
		private readonly orm: AppDrizzleDatabase,
		private readonly clock: RepositoryClock = { now: () => Date.now() },
	) {}

	list(options: MobileDeviceListOptions = {}): ListMobileDevicesOutput {
		const limit =
			options.limit === undefined
				? mobileDeviceListPageSize
				: Math.min(Math.max(Math.trunc(options.limit), 1), mobileDeviceListPageSize);
		const cursor =
			options.cursor === undefined ? undefined : decodeMobileDeviceCursor(options.cursor);
		// Active devices (revoked_at_ms IS NULL) sort ahead of revoked ones; ties break on the stable
		// creation time and then the immutable id, giving a total order that a keyset cursor can walk
		// without skipping or duplicating an active device.
		const revokedSort = sql<number>`(case when ${mobileDevicesTable.revokedAtMs} is null then 0 else 1 end)`;
		const afterCursor =
			cursor === undefined
				? undefined
				: sql`(
					${revokedSort} > ${cursor.revokedSort}
					or (${revokedSort} = ${cursor.revokedSort} and ${mobileDevicesTable.createdAtMs} > ${cursor.createdAtMs})
					or (
						${revokedSort} = ${cursor.revokedSort}
						and ${mobileDevicesTable.createdAtMs} = ${cursor.createdAtMs}
						and ${mobileDevicesTable.id} > ${cursor.id}
					)
				)`;
		const rows = this.orm
			.select()
			.from(mobileDevicesTable)
			.where(afterCursor)
			.orderBy(revokedSort, asc(mobileDevicesTable.createdAtMs), asc(mobileDevicesTable.id))
			.limit(limit + 1)
			.all();
		const hasMore = rows.length > limit;
		const pageRows = hasMore ? rows.slice(0, limit) : rows;
		const items = pageRows.map((device) => this.#buildDevice(device));
		const lastRow = pageRows.at(-1);
		if (!hasMore || lastRow === undefined) {
			return { items };
		}
		return { items, nextCursor: encodeMobileDeviceCursor(lastRow) };
	}

	get(mobileClientId: string): MobileDevice {
		const device = this.orm
			.select()
			.from(mobileDevicesTable)
			.where(eq(mobileDevicesTable.id, mobileClientId))
			.get();
		if (device === undefined) {
			throw new MobileDeviceNotFoundError(mobileClientId);
		}
		return this.#buildDevice(device);
	}

	markLastSeen(mobileClientId: string): void {
		const now = this.clock.now();
		this.orm
			.update(mobileDevicesTable)
			.set({ lastSeenAtMs: now, updatedAtMs: now })
			.where(eq(mobileDevicesTable.id, mobileClientId))
			.run();
	}

	revokeDevice(mobileClientId: string): void {
		this.orm.transaction((transaction) => {
			const now = this.clock.now();
			const device = transaction
				.select({ id: mobileDevicesTable.id })
				.from(mobileDevicesTable)
				.where(eq(mobileDevicesTable.id, mobileClientId))
				.get();
			if (device === undefined) {
				throw new MobileDeviceNotFoundError(mobileClientId);
			}
			transaction
				.update(mobileDeviceKeysTable)
				.set({ revokedAtMs: now })
				.where(
					and(
						eq(mobileDeviceKeysTable.mobileClientId, mobileClientId),
						isNull(mobileDeviceKeysTable.revokedAtMs),
					),
				)
				.run();
			transaction
				.update(mobileDevicesTable)
				.set({ revokedAtMs: now, updatedAtMs: now })
				.where(eq(mobileDevicesTable.id, mobileClientId))
				.run();
		});
	}

	acceptGeneration(
		mobileClientId: string,
		instanceId: string,
		generation: number,
	): MobileDeviceGenerationAcceptance {
		if (!Number.isSafeInteger(generation) || generation < 0) {
			throw new TypeError("Mobile device generation must be a nonnegative safe integer.");
		}
		if (instanceId.length === 0 || instanceId.length > 256) {
			throw new TypeError("Mobile device instanceId must be between 1 and 256 characters.");
		}
		return this.orm.transaction((transaction) =>
			this.#acceptGeneration(transaction, mobileClientId, instanceId, generation),
		);
	}

	#acceptGeneration(
		transaction: AppDatabaseTransaction,
		mobileClientId: string,
		instanceId: string,
		generation: number,
	): MobileDeviceGenerationAcceptance {
		const device = transaction
			.select({ revokedAtMs: mobileDevicesTable.revokedAtMs })
			.from(mobileDevicesTable)
			.where(eq(mobileDevicesTable.id, mobileClientId))
			.get();
		if (device === undefined) {
			throw new MobileDeviceNotFoundError(mobileClientId);
		}
		if (device.revokedAtMs !== null) {
			throw new MobileDeviceRevokedError(mobileClientId);
		}
		const existing = transaction
			.select()
			.from(mobileDeviceGenerationFencesTable)
			.where(eq(mobileDeviceGenerationFencesTable.mobileClientId, mobileClientId))
			.get();
		if (existing !== undefined) {
			if (generation < existing.acceptedGeneration) {
				return {
					accepted: false,
					code: "STALE_GENERATION",
					currentGeneration: existing.acceptedGeneration,
				};
			}
			if (
				generation === existing.acceptedGeneration &&
				instanceId !== existing.acceptedInstanceId
			) {
				return {
					accepted: false,
					code: "GENERATION_CONFLICT",
					currentGeneration: existing.acceptedGeneration,
				};
			}
		}
		transaction
			.insert(mobileDeviceGenerationFencesTable)
			.values({
				mobileClientId,
				acceptedGeneration: generation,
				acceptedInstanceId: instanceId,
				updatedAtMs: this.clock.now(),
			})
			.onConflictDoUpdate({
				target: mobileDeviceGenerationFencesTable.mobileClientId,
				set: {
					acceptedGeneration: generation,
					acceptedInstanceId: instanceId,
					updatedAtMs: this.clock.now(),
				},
			})
			.run();
		transaction
			.update(mobileDevicesTable)
			.set({ lastSeenAtMs: this.clock.now(), updatedAtMs: this.clock.now() })
			.where(eq(mobileDevicesTable.id, mobileClientId))
			.run();
		return { accepted: true };
	}

	#buildDevice(device: typeof mobileDevicesTable.$inferSelect): MobileDevice {
		const keys = this.orm
			.select({ keyId: mobileDeviceKeysTable.keyId })
			.from(mobileDeviceKeysTable)
			.where(
				and(
					eq(mobileDeviceKeysTable.mobileClientId, device.id),
					isNull(mobileDeviceKeysTable.revokedAtMs),
				),
			)
			.orderBy(asc(mobileDeviceKeysTable.createdAtMs), asc(mobileDeviceKeysTable.keyId))
			.all();
		return mobileDeviceSchema.parse({
			schemaVersion: 1,
			mobileClientId: device.id,
			displayName: device.displayName,
			model: device.model,
			platform: device.platform,
			appVersion: device.appVersion,
			deviceKeyIds: keys.map((key) => key.keyId),
			approvedAt: new Date(device.approvedAtMs).toISOString(),
			...(device.lastSeenAtMs === null
				? {}
				: { lastSeenAt: new Date(device.lastSeenAtMs).toISOString() }),
			revoked: device.revokedAtMs !== null,
		});
	}
}

function encodeMobileDeviceCursor(row: typeof mobileDevicesTable.$inferSelect): string {
	const revokedSort = row.revokedAtMs === null ? 0 : 1;
	const encoded = JSON.stringify([revokedSort, row.createdAtMs, row.id]);
	return Buffer.from(encoded, "utf8").toString("base64url");
}

function decodeMobileDeviceCursor(cursor: string): MobileDeviceCursor {
	let parsed: unknown;
	try {
		parsed = JSON.parse(Buffer.from(cursor, "base64url").toString("utf8"));
	} catch {
		throw new MobileDeviceCursorError();
	}
	if (!Array.isArray(parsed) || parsed.length !== 3) {
		throw new MobileDeviceCursorError();
	}
	const [revokedSort, createdAtMs, id] = parsed;
	if (
		(revokedSort !== 0 && revokedSort !== 1) ||
		typeof createdAtMs !== "number" ||
		!Number.isSafeInteger(createdAtMs) ||
		typeof id !== "string" ||
		id.length === 0
	) {
		throw new MobileDeviceCursorError();
	}
	return { revokedSort, createdAtMs, id };
}
