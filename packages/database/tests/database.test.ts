import { describe, expect, test } from "bun:test";
import { openAppDatabase } from "../src";

describe("application database", () => {
	test("enables the SQLite safety baseline", () => {
		const database = openAppDatabase(":memory:");

		try {
			const foreignKeys = database.client
				.query<{ foreign_keys: number }, []>("PRAGMA foreign_keys")
				.get();
			const busyTimeout = database.client
				.query<{ timeout: number }, []>("PRAGMA busy_timeout")
				.get();

			expect(foreignKeys?.foreign_keys).toBe(1);
			expect(busyTimeout?.timeout).toBe(5000);
			expect(database.orm).toBeDefined();
		} finally {
			database.close();
		}
	});
});
