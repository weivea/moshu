import { describe, expect, test } from "bun:test";
import { appErrorSchema, runtimeInfoSchema } from "../src";

describe("shared contracts", () => {
	test("accepts safe application errors", () => {
		const result = appErrorSchema.parse({
			code: "RUNTIME_UNAVAILABLE",
			category: "runtime",
			messageKey: "errors.runtimeUnavailable",
			safeMessage: "The runtime is unavailable.",
			retryable: true,
		});

		expect(result.code).toBe("RUNTIME_UNAVAILABLE");
	});

	test("rejects unknown runtime channels", () => {
		expect(() =>
			runtimeInfoSchema.parse({
				apiVersion: 1,
				appName: "墨枢",
				appVersion: "0.0.1",
				channel: "nightly",
				electrobunVersion: "1.18.1",
				bunVersion: "1.3.14",
				platform: "darwin",
				arch: "arm64",
				deepAgents: { loaded: true, version: "1.11.0" },
			}),
		).toThrow();
	});
});
