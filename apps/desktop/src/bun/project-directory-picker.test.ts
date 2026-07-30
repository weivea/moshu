import { describe, expect, test } from "bun:test";
import { pickProjectDirectory } from "./rpc";

describe("Project directory picker", () => {
	test("models cancellation explicitly and requests one directory", async () => {
		let received:
			| Parameters<NonNullable<Parameters<typeof pickProjectDirectory>[0]>>[0]
			| undefined;
		const result = await pickProjectDirectory(async (options) => {
			received = options;
			return [""];
		});
		expect(result).toEqual({ cancelled: true });
		expect(received).toMatchObject({
			canChooseFiles: false,
			canChooseDirectory: true,
			allowsMultipleSelection: false,
		});
	});

	test("returns the selected directory", async () => {
		expect(await pickProjectDirectory(async () => ["/Users/example/project"])).toEqual({
			cancelled: false,
			path: "/Users/example/project",
		});
	});
});
