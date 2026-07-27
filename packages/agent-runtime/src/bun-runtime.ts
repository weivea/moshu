import { registerBunOAuthFlows } from "@earendil-works/pi-ai/bun-oauth";

let initialized = false;

export function initializeBunAgentRuntime(): void {
	if (initialized) {
		return;
	}
	registerBunOAuthFlows();
	initialized = true;
}
