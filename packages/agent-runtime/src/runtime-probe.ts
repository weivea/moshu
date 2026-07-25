import { createDeepAgent } from "@moshu/deepagents/browser";

export const DEEP_AGENTS_VERSION = "1.12.0-rc.0-moshu.0+1225a7f";

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
