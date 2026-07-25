import type { AgentMode } from "@moshu/contracts";

export type ToolCapability =
	| "read_context"
	| "submit_plan"
	| "write_project"
	| "execute_command"
	| "external_side_effect";

const MODE_CAPABILITIES = {
	ask: ["read_context"],
	plan: ["read_context", "submit_plan"],
	agent: [
		"read_context",
		"submit_plan",
		"write_project",
		"execute_command",
		"external_side_effect",
	],
} as const satisfies Record<AgentMode, readonly ToolCapability[]>;

export const DEFAULT_MAX_ACTIVE_SESSIONS = 3;
export const MIN_ACTIVE_SESSIONS = 1;
export const MAX_ACTIVE_SESSIONS = 5;

export function capabilitiesForMode(mode: AgentMode): readonly ToolCapability[] {
	return MODE_CAPABILITIES[mode];
}

export function modeAllowsCapability(mode: AgentMode, capability: ToolCapability): boolean {
	return capabilitiesForMode(mode).includes(capability);
}

export function validateMaxActiveSessions(value: number): number {
	if (!Number.isInteger(value) || value < MIN_ACTIVE_SESSIONS || value > MAX_ACTIVE_SESSIONS) {
		throw new RangeError(
			`maxActiveSessions must be an integer from ${MIN_ACTIVE_SESSIONS} to ${MAX_ACTIVE_SESSIONS}`,
		);
	}

	return value;
}
