import { createDeepAgent } from "deepagents/browser";

export const DEEP_AGENTS_VERSION = "1.11.0";

export interface AgentRuntimeProbe {
	loaded: boolean;
	version: string;
}

export function probeAgentRuntime(): AgentRuntimeProbe {
	return {
		loaded: typeof createDeepAgent === "function",
		version: DEEP_AGENTS_VERSION,
	};
}
