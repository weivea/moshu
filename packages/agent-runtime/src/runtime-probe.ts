import { ModelRuntime } from "@earendil-works/pi-coding-agent";

export const PI_AI_VERSION = "0.82.1";
export const PI_AGENT_CORE_VERSION = "0.82.1";
export const PI_CODING_AGENT_VERSION = "0.82.1";

export interface AgentRuntimeProbe {
	loaded: boolean;
	foundation: "pi-agent";
	versions: {
		piAi: string;
		piAgentCore: string;
		piCodingAgent: string;
	};
}

export function probeAgentRuntime(): AgentRuntimeProbe {
	return {
		loaded: typeof ModelRuntime.create === "function",
		foundation: "pi-agent",
		versions: {
			piAi: PI_AI_VERSION,
			piAgentCore: PI_AGENT_CORE_VERSION,
			piCodingAgent: PI_CODING_AGENT_VERSION,
		},
	};
}
