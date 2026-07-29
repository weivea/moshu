import {
	type RuntimeBoxDescriptor,
	type RuntimeBoxPairingClaim,
	runtimeBoxDescriptorSchema,
	runtimeBoxPairingClaimSchema,
} from "@moshu/contracts";
import { and, asc, eq, gt, isNull } from "drizzle-orm";

import type { AppDrizzleDatabase } from "./database";
import { createUuidV7 } from "./ids";
import {
	runtimeBoxDeviceKeysTable,
	runtimeBoxPairingSessionsTable,
	runtimeBoxesTable,
} from "./schema";

interface RepositoryClock {
	now(): number;
}

interface RepositoryIdGenerator {
	create(nowMs?: number): string;
}

export interface CreatePairingSessionInput {
	id: string;
	codeHash: string;
	expiresAtMs: number;
}

export interface ClaimPairingSessionInput {
	codeHash: string;
	claimTokenHash: string;
	deviceKeyId: string;
	publicKey: string;
	publicKeyFingerprint: string;
	displayName: string;
	platform: "darwin" | "win32" | "linux";
	arch: string;
}

export type PairingSessionStatus =
	| { status: "pending_approval" }
	| { status: "rejected" }
	| { status: "expired" }
	| { status: "approved"; runtimeBoxId: string };

export interface RuntimeBoxDeviceKey {
	keyId: string;
	runtimeBoxId: string;
	publicKey: string;
	publicKeyFingerprint: string;
}

export class PairingSessionNotFoundError extends Error {
	constructor() {
		super("Runtime Box pairing session was not found.");
		this.name = "PairingSessionNotFoundError";
	}
}

export class PairingSessionStateError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "PairingSessionStateError";
	}
}

export class PairingFingerprintMismatchError extends Error {
	constructor() {
		super("Runtime Box pairing fingerprint did not match the claimed device key.");
		this.name = "PairingFingerprintMismatchError";
	}
}

export interface RuntimeBoxPairingRepository {
	create(input: CreatePairingSessionInput): void;
	claim(input: ClaimPairingSessionInput): { pairingId: string };
	listPendingClaims(): RuntimeBoxPairingClaim[];
	approve(pairingId: string, expectedFingerprint: string): RuntimeBoxDescriptor;
	reject(pairingId: string): void;
	getStatus(pairingId: string, claimTokenHash: string): PairingSessionStatus;
	listActiveDeviceKeys(runtimeBoxId: string): RuntimeBoxDeviceKey[];
	getActiveDeviceKey(runtimeBoxId: string, keyId: string): RuntimeBoxDeviceKey;
	revokeDeviceKey(runtimeBoxId: string, keyId: string): void;
}

export class SqliteRuntimeBoxPairingRepository implements RuntimeBoxPairingRepository {
	constructor(
		private readonly orm: AppDrizzleDatabase,
		private readonly clock: RepositoryClock = { now: () => Date.now() },
		private readonly idGenerator: RepositoryIdGenerator = { create: createUuidV7 },
	) {}

	create(input: CreatePairingSessionInput): void {
		if (!Number.isSafeInteger(input.expiresAtMs) || input.expiresAtMs <= this.clock.now()) {
			throw new TypeError("Runtime Box pairing expiry must be in the future.");
		}
		this.orm
			.insert(runtimeBoxPairingSessionsTable)
			.values({
				id: input.id,
				codeHash: input.codeHash,
				state: "open",
				createdAtMs: this.clock.now(),
				expiresAtMs: input.expiresAtMs,
			})
			.run();
	}

	claim(input: ClaimPairingSessionInput): { pairingId: string } {
		return this.orm.transaction((transaction) => {
			const now = this.clock.now();
			const row = transaction
				.select()
				.from(runtimeBoxPairingSessionsTable)
				.where(eq(runtimeBoxPairingSessionsTable.codeHash, input.codeHash))
				.get();
			if (row === undefined) {
				throw new PairingSessionNotFoundError();
			}
			if (row.expiresAtMs <= now) {
				throw new PairingSessionStateError("Runtime Box pairing session expired.");
			}
			if (row.state !== "open") {
				throw new PairingSessionStateError("Runtime Box pairing code was already used.");
			}
			transaction
				.update(runtimeBoxPairingSessionsTable)
				.set({
					state: "claimed",
					claimTokenHash: input.claimTokenHash,
					deviceKeyId: input.deviceKeyId,
					publicKey: input.publicKey,
					publicKeyFingerprint: input.publicKeyFingerprint,
					displayName: input.displayName,
					platform: input.platform,
					arch: input.arch,
					claimedAtMs: now,
				})
				.where(eq(runtimeBoxPairingSessionsTable.id, row.id))
				.run();
			return { pairingId: row.id };
		});
	}

	listPendingClaims(): RuntimeBoxPairingClaim[] {
		const now = this.clock.now();
		return this.orm
			.select()
			.from(runtimeBoxPairingSessionsTable)
			.where(
				and(
					eq(runtimeBoxPairingSessionsTable.state, "claimed"),
					gt(runtimeBoxPairingSessionsTable.expiresAtMs, now),
				),
			)
			.orderBy(asc(runtimeBoxPairingSessionsTable.claimedAtMs))
			.all()
			.map((row) =>
				runtimeBoxPairingClaimSchema.parse({
					pairingId: row.id,
					deviceKeyId: requireValue(row.deviceKeyId),
					displayName: requireValue(row.displayName),
					platform: requireValue(row.platform),
					arch: requireValue(row.arch),
					publicKeyFingerprint: requireValue(row.publicKeyFingerprint),
					claimedAt: new Date(requireValue(row.claimedAtMs)).toISOString(),
					expiresAt: new Date(row.expiresAtMs).toISOString(),
				}),
			);
	}

	approve(pairingId: string, expectedFingerprint: string): RuntimeBoxDescriptor {
		return this.orm.transaction((transaction) => {
			const now = this.clock.now();
			const row = transaction
				.select()
				.from(runtimeBoxPairingSessionsTable)
				.where(eq(runtimeBoxPairingSessionsTable.id, pairingId))
				.get();
			if (row === undefined) {
				throw new PairingSessionNotFoundError();
			}
			if (row.expiresAtMs <= now) {
				throw new PairingSessionStateError("Runtime Box pairing session expired.");
			}
			if (row.state !== "claimed") {
				throw new PairingSessionStateError("Runtime Box pairing session is not pending approval.");
			}
			const fingerprint = requireValue(row.publicKeyFingerprint);
			if (fingerprint !== expectedFingerprint) {
				throw new PairingFingerprintMismatchError();
			}
			const descriptor = runtimeBoxDescriptorSchema.parse({
				schemaVersion: 1,
				runtimeBoxId: this.idGenerator.create(now),
				kind: "remote",
				displayName: requireValue(row.displayName),
				runtimeBoxVersion: "unregistered",
				platform: requireValue(row.platform),
				arch: requireValue(row.arch),
				capabilities: [],
			});
			transaction
				.insert(runtimeBoxesTable)
				.values({
					id: descriptor.runtimeBoxId,
					kind: descriptor.kind,
					displayName: descriptor.displayName,
					runtimeBoxVersion: descriptor.runtimeBoxVersion,
					platform: descriptor.platform,
					arch: descriptor.arch,
					capabilitiesJson: "[]",
					createdAtMs: now,
					updatedAtMs: now,
				})
				.run();
			transaction
				.insert(runtimeBoxDeviceKeysTable)
				.values({
					keyId: requireValue(row.deviceKeyId),
					runtimeBoxId: descriptor.runtimeBoxId,
					publicKey: requireValue(row.publicKey),
					publicKeyFingerprint: fingerprint,
					createdAtMs: now,
				})
				.run();
			transaction
				.update(runtimeBoxPairingSessionsTable)
				.set({
					state: "approved",
					runtimeBoxId: descriptor.runtimeBoxId,
					decidedAtMs: now,
				})
				.where(eq(runtimeBoxPairingSessionsTable.id, pairingId))
				.run();
			return descriptor;
		});
	}

	reject(pairingId: string): void {
		this.orm.transaction((transaction) => {
			const row = transaction
				.select()
				.from(runtimeBoxPairingSessionsTable)
				.where(eq(runtimeBoxPairingSessionsTable.id, pairingId))
				.get();
			if (row === undefined) {
				throw new PairingSessionNotFoundError();
			}
			if (row.state !== "claimed") {
				throw new PairingSessionStateError("Runtime Box pairing session is not pending approval.");
			}
			transaction
				.update(runtimeBoxPairingSessionsTable)
				.set({ state: "rejected", decidedAtMs: this.clock.now() })
				.where(eq(runtimeBoxPairingSessionsTable.id, pairingId))
				.run();
		});
	}

	getStatus(pairingId: string, claimTokenHash: string): PairingSessionStatus {
		const row = this.orm
			.select()
			.from(runtimeBoxPairingSessionsTable)
			.where(
				and(
					eq(runtimeBoxPairingSessionsTable.id, pairingId),
					eq(runtimeBoxPairingSessionsTable.claimTokenHash, claimTokenHash),
				),
			)
			.get();
		if (row === undefined) {
			throw new PairingSessionNotFoundError();
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
				runtimeBoxId: requireValue(row.runtimeBoxId),
			};
		}
		return { status: "pending_approval" };
	}

	getActiveDeviceKey(runtimeBoxId: string, keyId: string): RuntimeBoxDeviceKey {
		const row = this.orm
			.select({
				keyId: runtimeBoxDeviceKeysTable.keyId,
				runtimeBoxId: runtimeBoxDeviceKeysTable.runtimeBoxId,
				publicKey: runtimeBoxDeviceKeysTable.publicKey,
				publicKeyFingerprint: runtimeBoxDeviceKeysTable.publicKeyFingerprint,
				archivedAtMs: runtimeBoxesTable.archivedAtMs,
			})
			.from(runtimeBoxDeviceKeysTable)
			.innerJoin(
				runtimeBoxesTable,
				eq(runtimeBoxesTable.id, runtimeBoxDeviceKeysTable.runtimeBoxId),
			)
			.where(
				and(
					eq(runtimeBoxDeviceKeysTable.runtimeBoxId, runtimeBoxId),
					eq(runtimeBoxDeviceKeysTable.keyId, keyId),
					isNull(runtimeBoxDeviceKeysTable.revokedAtMs),
				),
			)
			.get();
		if (row === undefined || row.archivedAtMs !== null) {
			throw new PairingSessionNotFoundError();
		}

		return {
			keyId: row.keyId,
			runtimeBoxId: row.runtimeBoxId,
			publicKey: row.publicKey,
			publicKeyFingerprint: row.publicKeyFingerprint,
		};
	}

	listActiveDeviceKeys(runtimeBoxId: string): RuntimeBoxDeviceKey[] {
		return this.orm
			.select({
				keyId: runtimeBoxDeviceKeysTable.keyId,
				runtimeBoxId: runtimeBoxDeviceKeysTable.runtimeBoxId,
				publicKey: runtimeBoxDeviceKeysTable.publicKey,
				publicKeyFingerprint: runtimeBoxDeviceKeysTable.publicKeyFingerprint,
			})
			.from(runtimeBoxDeviceKeysTable)
			.innerJoin(
				runtimeBoxesTable,
				eq(runtimeBoxesTable.id, runtimeBoxDeviceKeysTable.runtimeBoxId),
			)
			.where(
				and(
					eq(runtimeBoxDeviceKeysTable.runtimeBoxId, runtimeBoxId),
					isNull(runtimeBoxDeviceKeysTable.revokedAtMs),
					isNull(runtimeBoxesTable.archivedAtMs),
				),
			)
			.orderBy(asc(runtimeBoxDeviceKeysTable.createdAtMs), asc(runtimeBoxDeviceKeysTable.keyId))
			.all();
	}

	revokeDeviceKey(runtimeBoxId: string, keyId: string): void {
		this.getActiveDeviceKey(runtimeBoxId, keyId);
		this.orm
			.update(runtimeBoxDeviceKeysTable)
			.set({ revokedAtMs: this.clock.now() })
			.where(
				and(
					eq(runtimeBoxDeviceKeysTable.runtimeBoxId, runtimeBoxId),
					eq(runtimeBoxDeviceKeysTable.keyId, keyId),
					isNull(runtimeBoxDeviceKeysTable.revokedAtMs),
				),
			)
			.run();
	}
}

function requireValue<T>(value: T | null): T {
	if (value === null) {
		throw new Error("Runtime Box pairing record is incomplete.");
	}
	return value;
}
