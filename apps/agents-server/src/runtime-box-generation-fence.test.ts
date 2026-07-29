import { describe, expect, test } from "bun:test";
import { openAppDatabase } from "@moshu/database";

import { RuntimeBoxGenerationFence } from "./runtime-box-generation-fence";

describe("RuntimeBoxGenerationFence", () => {
	test("persists the high-water mark and fences a replaced live connection", () => {
		const database = openAppDatabase(":memory:");
		try {
			database.runtimeBoxes.upsertRegistration({
				schemaVersion: 1,
				runtimeBoxId: "remote-fence-box",
				kind: "remote",
				displayName: "Remote Fence Box",
				runtimeBoxVersion: "0.0.1",
				platform: "linux",
				arch: "x64",
				capabilities: [],
			});
			const fence = new RuntimeBoxGenerationFence(database.runtimeBoxes);
			const replacements: number[] = [];
			const first = fence.acquire(
				{
					role: "runtime-box",
					peerId: "remote-fence-box",
					instanceId: "instance-1",
					generation: 1,
				},
				(replacement) => replacements.push(replacement.generation),
			);
			expect(first.accepted).toBe(true);

			const second = fence.acquire(
				{
					role: "runtime-box",
					peerId: "remote-fence-box",
					instanceId: "instance-2",
					generation: 2,
				},
				() => undefined,
			);
			expect(second.accepted).toBe(true);
			expect(replacements).toEqual([2]);
			expect(
				fence.acquire(
					{
						role: "runtime-box",
						peerId: "remote-fence-box",
						instanceId: "stale",
						generation: 1,
					},
					() => undefined,
				),
			).toEqual({
				accepted: false,
				code: "STALE_GENERATION",
				currentGeneration: 2,
			});
		} finally {
			database.close();
		}
	});
});
