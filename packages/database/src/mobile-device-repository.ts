import { type MobileDevice, mobileDeviceSchema } from "@moshu/contracts";
import { and, asc, eq, isNull } from "drizzle-orm";

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

export interface MobileDeviceRepository {
	list(): MobileDevice[];
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

	list(): MobileDevice[] {
		const devices = this.orm
			.select()
			.from(mobileDevicesTable)
			.orderBy(asc(mobileDevicesTable.approvedAtMs), asc(mobileDevicesTable.id))
			.all();
		return devices.map((device) => this.#buildDevice(device));
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
