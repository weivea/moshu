import {
	type MobileDevice,
	type MobilePairingClaim,
	type MobilePlatform,
	mobileDeviceSchema,
	mobilePairingClaimSchema,
} from "@moshu/contracts";
import { and, asc, eq, gt, isNull } from "drizzle-orm";

import type { AppDrizzleDatabase } from "./database";
import { createUuidV7 } from "./ids";
import { mobileDeviceKeysTable, mobileDevicesTable, mobilePairingSessionsTable } from "./schema";

interface RepositoryClock {
	now(): number;
}

interface RepositoryIdGenerator {
	create(nowMs?: number): string;
}

export interface CreateMobilePairingSessionInput {
	id: string;
	codeHash: string;
	expiresAtMs: number;
}

export interface ClaimMobilePairingSessionInput {
	codeHash: string;
	claimTokenHash: string;
	deviceKeyId: string;
	publicKey: string;
	publicKeyFingerprint: string;
	displayName: string;
	model: string;
	platform: MobilePlatform;
	appVersion: string;
}

export type MobilePairingSessionStatus =
	| { status: "pending_approval" }
	| { status: "rejected" }
	| { status: "expired" }
	| { status: "approved"; mobileClientId: string };

export interface MobileDeviceKey {
	keyId: string;
	mobileClientId: string;
	publicKey: string;
	publicKeyFingerprint: string;
}

export class MobilePairingSessionNotFoundError extends Error {
	constructor() {
		super("Mobile pairing session was not found.");
		this.name = "MobilePairingSessionNotFoundError";
	}
}

export class MobilePairingSessionStateError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "MobilePairingSessionStateError";
	}
}

export class MobilePairingFingerprintMismatchError extends Error {
	constructor() {
		super("Mobile pairing fingerprint did not match the claimed device key.");
		this.name = "MobilePairingFingerprintMismatchError";
	}
}

export interface MobilePairingRepository {
	create(input: CreateMobilePairingSessionInput): void;
	claim(input: ClaimMobilePairingSessionInput): { pairingId: string };
	listPendingClaims(): MobilePairingClaim[];
	approve(pairingId: string, expectedFingerprint: string): MobileDevice;
	reject(pairingId: string): void;
	getStatus(pairingId: string, claimTokenHash: string): MobilePairingSessionStatus;
	listActiveDeviceKeys(mobileClientId: string): MobileDeviceKey[];
	getActiveDeviceKey(mobileClientId: string, keyId: string): MobileDeviceKey;
	revokeDeviceKey(mobileClientId: string, keyId: string): void;
}

export class SqliteMobilePairingRepository implements MobilePairingRepository {
	constructor(
		private readonly orm: AppDrizzleDatabase,
		private readonly clock: RepositoryClock = { now: () => Date.now() },
		private readonly idGenerator: RepositoryIdGenerator = { create: createUuidV7 },
	) {}

	create(input: CreateMobilePairingSessionInput): void {
		if (!Number.isSafeInteger(input.expiresAtMs) || input.expiresAtMs <= this.clock.now()) {
			throw new TypeError("Mobile pairing expiry must be in the future.");
		}
		this.orm
			.insert(mobilePairingSessionsTable)
			.values({
				id: input.id,
				codeHash: input.codeHash,
				state: "open",
				createdAtMs: this.clock.now(),
				expiresAtMs: input.expiresAtMs,
			})
			.run();
	}

	claim(input: ClaimMobilePairingSessionInput): { pairingId: string } {
		return this.orm.transaction((transaction) => {
			const now = this.clock.now();
			const row = transaction
				.select()
				.from(mobilePairingSessionsTable)
				.where(eq(mobilePairingSessionsTable.codeHash, input.codeHash))
				.get();
			if (row === undefined) {
				throw new MobilePairingSessionNotFoundError();
			}
			if (row.expiresAtMs <= now) {
				throw new MobilePairingSessionStateError("Mobile pairing session expired.");
			}
			if (row.state !== "open") {
				throw new MobilePairingSessionStateError("Mobile pairing code was already used.");
			}
			transaction
				.update(mobilePairingSessionsTable)
				.set({
					state: "claimed",
					claimTokenHash: input.claimTokenHash,
					deviceKeyId: input.deviceKeyId,
					publicKey: input.publicKey,
					publicKeyFingerprint: input.publicKeyFingerprint,
					displayName: input.displayName,
					model: input.model,
					platform: input.platform,
					appVersion: input.appVersion,
					claimedAtMs: now,
				})
				.where(eq(mobilePairingSessionsTable.id, row.id))
				.run();
			return { pairingId: row.id };
		});
	}

	listPendingClaims(): MobilePairingClaim[] {
		const now = this.clock.now();
		return this.orm
			.select()
			.from(mobilePairingSessionsTable)
			.where(
				and(
					eq(mobilePairingSessionsTable.state, "claimed"),
					gt(mobilePairingSessionsTable.expiresAtMs, now),
				),
			)
			.orderBy(asc(mobilePairingSessionsTable.claimedAtMs))
			.all()
			.map((row) =>
				mobilePairingClaimSchema.parse({
					pairingId: row.id,
					deviceKeyId: requireValue(row.deviceKeyId),
					displayName: requireValue(row.displayName),
					model: requireValue(row.model),
					platform: requireValue(row.platform),
					appVersion: requireValue(row.appVersion),
					publicKeyFingerprint: requireValue(row.publicKeyFingerprint),
					claimedAt: new Date(requireValue(row.claimedAtMs)).toISOString(),
					expiresAt: new Date(row.expiresAtMs).toISOString(),
				}),
			);
	}

	approve(pairingId: string, expectedFingerprint: string): MobileDevice {
		return this.orm.transaction((transaction) => {
			const now = this.clock.now();
			const row = transaction
				.select()
				.from(mobilePairingSessionsTable)
				.where(eq(mobilePairingSessionsTable.id, pairingId))
				.get();
			if (row === undefined) {
				throw new MobilePairingSessionNotFoundError();
			}
			if (row.expiresAtMs <= now) {
				throw new MobilePairingSessionStateError("Mobile pairing session expired.");
			}
			if (row.state !== "claimed") {
				throw new MobilePairingSessionStateError("Mobile pairing session is not pending approval.");
			}
			const fingerprint = requireValue(row.publicKeyFingerprint);
			if (fingerprint !== expectedFingerprint) {
				throw new MobilePairingFingerprintMismatchError();
			}
			const mobileClientId = this.idGenerator.create(now);
			const deviceKeyId = requireValue(row.deviceKeyId);
			const displayName = requireValue(row.displayName);
			const model = requireValue(row.model);
			const platform = requireValue(row.platform);
			const appVersion = requireValue(row.appVersion);
			transaction
				.insert(mobileDevicesTable)
				.values({
					id: mobileClientId,
					displayName,
					model,
					platform,
					appVersion,
					createdAtMs: now,
					updatedAtMs: now,
					approvedAtMs: now,
				})
				.run();
			transaction
				.insert(mobileDeviceKeysTable)
				.values({
					keyId: deviceKeyId,
					mobileClientId,
					publicKey: requireValue(row.publicKey),
					publicKeyFingerprint: fingerprint,
					createdAtMs: now,
				})
				.run();
			transaction
				.update(mobilePairingSessionsTable)
				.set({
					state: "approved",
					mobileClientId,
					decidedAtMs: now,
				})
				.where(eq(mobilePairingSessionsTable.id, pairingId))
				.run();
			return mobileDeviceSchema.parse({
				schemaVersion: 1,
				mobileClientId,
				displayName,
				model,
				platform,
				appVersion,
				deviceKeyIds: [deviceKeyId],
				approvedAt: new Date(now).toISOString(),
				revoked: false,
			});
		});
	}

	reject(pairingId: string): void {
		this.orm.transaction((transaction) => {
			const row = transaction
				.select()
				.from(mobilePairingSessionsTable)
				.where(eq(mobilePairingSessionsTable.id, pairingId))
				.get();
			if (row === undefined) {
				throw new MobilePairingSessionNotFoundError();
			}
			if (row.state !== "claimed") {
				throw new MobilePairingSessionStateError("Mobile pairing session is not pending approval.");
			}
			transaction
				.update(mobilePairingSessionsTable)
				.set({ state: "rejected", decidedAtMs: this.clock.now() })
				.where(eq(mobilePairingSessionsTable.id, pairingId))
				.run();
		});
	}

	getStatus(pairingId: string, claimTokenHash: string): MobilePairingSessionStatus {
		const row = this.orm
			.select()
			.from(mobilePairingSessionsTable)
			.where(
				and(
					eq(mobilePairingSessionsTable.id, pairingId),
					eq(mobilePairingSessionsTable.claimTokenHash, claimTokenHash),
				),
			)
			.get();
		if (row === undefined) {
			throw new MobilePairingSessionNotFoundError();
		}
		if (row.state === "rejected") {
			return { status: "rejected" };
		}
		if (row.expiresAtMs <= this.clock.now() && row.state !== "approved") {
			return { status: "expired" };
		}
		if (row.state === "approved") {
			return {
				status: "approved",
				mobileClientId: requireValue(row.mobileClientId),
			};
		}
		return { status: "pending_approval" };
	}

	getActiveDeviceKey(mobileClientId: string, keyId: string): MobileDeviceKey {
		const row = this.orm
			.select({
				keyId: mobileDeviceKeysTable.keyId,
				mobileClientId: mobileDeviceKeysTable.mobileClientId,
				publicKey: mobileDeviceKeysTable.publicKey,
				publicKeyFingerprint: mobileDeviceKeysTable.publicKeyFingerprint,
				revokedAtMs: mobileDevicesTable.revokedAtMs,
			})
			.from(mobileDeviceKeysTable)
			.innerJoin(
				mobileDevicesTable,
				eq(mobileDevicesTable.id, mobileDeviceKeysTable.mobileClientId),
			)
			.where(
				and(
					eq(mobileDeviceKeysTable.mobileClientId, mobileClientId),
					eq(mobileDeviceKeysTable.keyId, keyId),
					isNull(mobileDeviceKeysTable.revokedAtMs),
				),
			)
			.get();
		if (row === undefined || row.revokedAtMs !== null) {
			throw new MobilePairingSessionNotFoundError();
		}
		return {
			keyId: row.keyId,
			mobileClientId: row.mobileClientId,
			publicKey: row.publicKey,
			publicKeyFingerprint: row.publicKeyFingerprint,
		};
	}

	listActiveDeviceKeys(mobileClientId: string): MobileDeviceKey[] {
		return this.orm
			.select({
				keyId: mobileDeviceKeysTable.keyId,
				mobileClientId: mobileDeviceKeysTable.mobileClientId,
				publicKey: mobileDeviceKeysTable.publicKey,
				publicKeyFingerprint: mobileDeviceKeysTable.publicKeyFingerprint,
			})
			.from(mobileDeviceKeysTable)
			.innerJoin(
				mobileDevicesTable,
				eq(mobileDevicesTable.id, mobileDeviceKeysTable.mobileClientId),
			)
			.where(
				and(
					eq(mobileDeviceKeysTable.mobileClientId, mobileClientId),
					isNull(mobileDeviceKeysTable.revokedAtMs),
					isNull(mobileDevicesTable.revokedAtMs),
				),
			)
			.orderBy(asc(mobileDeviceKeysTable.createdAtMs), asc(mobileDeviceKeysTable.keyId))
			.all();
	}

	revokeDeviceKey(mobileClientId: string, keyId: string): void {
		this.getActiveDeviceKey(mobileClientId, keyId);
		this.orm.transaction((transaction) => {
			const now = this.clock.now();
			transaction
				.update(mobileDeviceKeysTable)
				.set({ revokedAtMs: now })
				.where(
					and(
						eq(mobileDeviceKeysTable.mobileClientId, mobileClientId),
						eq(mobileDeviceKeysTable.keyId, keyId),
						isNull(mobileDeviceKeysTable.revokedAtMs),
					),
				)
				.run();
			// When the last active key is revoked the device can no longer authenticate, so record
			// the device itself as revoked to keep the device list and generation fence consistent.
			const remaining = transaction
				.select({ keyId: mobileDeviceKeysTable.keyId })
				.from(mobileDeviceKeysTable)
				.where(
					and(
						eq(mobileDeviceKeysTable.mobileClientId, mobileClientId),
						isNull(mobileDeviceKeysTable.revokedAtMs),
					),
				)
				.get();
			if (remaining === undefined) {
				transaction
					.update(mobileDevicesTable)
					.set({ revokedAtMs: now, updatedAtMs: now })
					.where(
						and(eq(mobileDevicesTable.id, mobileClientId), isNull(mobileDevicesTable.revokedAtMs)),
					)
					.run();
			}
		});
	}
}

function requireValue<T>(value: T | null): T {
	if (value === null) {
		throw new Error("Mobile pairing record is incomplete.");
	}
	return value;
}
