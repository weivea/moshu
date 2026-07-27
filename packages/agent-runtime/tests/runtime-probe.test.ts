import { describe, expect, test } from "bun:test";
import {
	PI_AGENT_CORE_VERSION,
	PI_AI_VERSION,
	PI_CODING_AGENT_VERSION,
	probeAgentRuntime,
} from "../src";

describe("Pi runtime probe", () => {
	test("reports the pinned public Pi packages", () => {
		expect(probeAgentRuntime()).toEqual({
			loaded: true,
			foundation: "pi-agent",
			versions: {
				piAi: PI_AI_VERSION,
				piAgentCore: PI_AGENT_CORE_VERSION,
				piCodingAgent: PI_CODING_AGENT_VERSION,
			},
		});
	});
});
