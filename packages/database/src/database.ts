import Database from "bun:sqlite";
import { drizzle } from "drizzle-orm/bun-sqlite";

import { applyAppMigrations } from "./migrations";
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

export function configureAppDatabase(client: Database): void {
	client.exec(`
		PRAGMA foreign_keys = ON;
		PRAGMA busy_timeout = 5000;
		PRAGMA journal_mode = WAL;
	`);
}

export function openAppDatabase(filename: string): AppDatabase {
	if (filename.trim().length === 0) {
		throw new TypeError("A database filename is required.");
	}

	const client = new Database(filename, { create: true, strict: true });

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
