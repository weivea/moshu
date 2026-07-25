import { describe, expect, test } from "bun:test";
import { DEEP_AGENTS_VERSION, probeAgentRuntime } from "../src";

describe("Deep Agents runtime probe", () => {
	test("imports the locked Deep Agents build in Bun", () => {
		expect(probeAgentRuntime()).toEqual({
			loaded: true,
			version: DEEP_AGENTS_VERSION,
		});
	});
});
