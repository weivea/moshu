import Database from "bun:sqlite";
import { chmodSync, existsSync, lstatSync, mkdirSync, rmSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { drizzle } from "drizzle-orm/bun-sqlite";

import {
	applyAppMigrations,
	currentAppDatabaseVersion,
	getDatabaseUserVersion,
} from "./migrations";
import { createRunJournalRepository, type RunJournalRepository } from "./run-journal-repository";
import { appSchema } from "./schema";
import { createSessionRepository, type SessionRepository } from "./session-repository";

export type AppDrizzleDatabase = ReturnType<typeof drizzle>;

export interface AppDatabase {
	client: Database;
	orm: AppDrizzleDatabase;
	sessions: SessionRepository;
	runs: RunJournalRepository;
	close(): void;
}

export const coordinatedDatabaseResetReason = "product-schema-cutover" as const;

export interface CoordinatedDatabaseResetResult {
	reset: boolean;
	reason?: typeof coordinatedDatabaseResetReason;
	previousProductVersion?: number;
}

export function prepareCoordinatedDatabaseReset(input: {
	productDatabase: string;
}): CoordinatedDatabaseResetResult {
	const filename = requireDatabaseFilename(input.productDatabase);
	if (!existsSync(filename)) {
		return { reset: false };
	}
	const metadata = lstatSync(filename);
	if (!metadata.isFile() || metadata.isSymbolicLink()) {
		throw new Error("Product database path must be a regular file.");
	}
	const inspection = new Database(filename, { readonly: true, strict: true });
	let previousProductVersion: number;
	try {
		previousProductVersion = getDatabaseUserVersion(inspection);
	} finally {
		inspection.close();
	}
	if (previousProductVersion === currentAppDatabaseVersion) {
		return { reset: false };
	}
	for (const path of [filename, `${filename}-wal`, `${filename}-shm`]) {
		if (existsSync(path)) {
			const pathMetadata = lstatSync(path);
			if (!pathMetadata.isFile() || pathMetadata.isSymbolicLink()) {
				throw new Error("Product database artifact must be a regular file.");
			}
			rmSync(path);
		}
	}
	return {
		reset: true,
		reason: coordinatedDatabaseResetReason,
		previousProductVersion,
	};
}

export function configureAppDatabase(client: Database): void {
	client.exec(`
		PRAGMA foreign_keys = ON;
		PRAGMA busy_timeout = 5000;
		PRAGMA journal_mode = WAL;
	`);
}

export function openAppDatabase(filename: string): AppDatabase {
	const normalized = requireDatabaseFilename(filename);
	mkdirSync(dirname(normalized), { recursive: true, mode: 0o700 });
	chmodSync(dirname(normalized), 0o700);
	const client = new Database(normalized, { create: true, strict: true });
	try {
		configureAppDatabase(client);
		applyAppMigrations(client);
	} catch (error) {
		client.close();
		throw error;
	}
	const orm = drizzle(client, { schema: appSchema });
	return {
		client,
		orm,
		sessions: createSessionRepository({ orm }),
		runs: createRunJournalRepository({ client, orm }),
		close: () => client.close(),
	};
}

function requireDatabaseFilename(value: string): string {
	if (value.trim().length === 0) {
		throw new TypeError("A product database filename is required.");
	}
	if (value === ":memory:") {
		return value;
	}
	return resolve(value);
}
