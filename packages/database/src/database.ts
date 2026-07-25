import Database from "bun:sqlite";
import { drizzle } from "drizzle-orm/bun-sqlite";

import { createChatRepository, type ChatRepository } from "./chat-repository";
import { applyAppMigrations } from "./migrations";
import { appSchema } from "./schema";

export type AppDrizzleDatabase = ReturnType<typeof drizzle>;

export interface AppDatabase {
	client: Database;
	orm: AppDrizzleDatabase;
	chat: ChatRepository;
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
		chat: createChatRepository({ client, orm }),
		close: () => client.close(),
	};
}
