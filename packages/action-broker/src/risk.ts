import type {
	ActionRisk,
	ApprovalActionSummary,
	ApprovalOperation,
	ExecutorToolCall,
	RuntimeBoxMcpToolInvokeInput,
} from "@moshu/contracts";

// ---------------------------------------------------------------------------
// Server-authoritative Action risk classification.
//
// Risk is computed ONLY from the tool identity and the already-validated,
// normalized tool parameters. Nothing here trusts a Runtime Box, an LLM, or any
// caller-supplied hint — the tool-call schema has no risk field to forge, and
// the tier is re-derived from the actual command/path content every time.
// ---------------------------------------------------------------------------

// The redacted params mirror the wire contract's JSON-value record so the summary
// this classifier produces drops straight into an ApprovalActionSummary.
type RedactedParams = ApprovalActionSummary["redactedParams"];

export interface RedactedActionSummary {
	operation: ApprovalOperation;
	command?: string;
	path?: string;
	mcpServerId?: string;
	mcpToolId?: string;
	redactedParams: RedactedParams;
}

export interface ActionClassification {
	operation: ApprovalOperation;
	risk: ActionRisk;
	// Read-only actions never require interactive approval; side-effecting ones do.
	requiresApproval: boolean;
	summary: RedactedActionSummary;
}

const maxCommandSummaryLength = 2_048;
const maxPathSummaryLength = 1_024;

// Patterns that mark a bash command as critical / non-overridable: destructive,
// privilege-escalating, or remote-code-execution shapes. A "Session Allow all"
// policy must never auto-approve these.
const nonOverridableBashPatterns: { pattern: RegExp; reason: string }[] = [
	{ pattern: /(^|[\s;&|])sudo(\s|$)/, reason: "Runs a command with elevated privileges (sudo)." },
	{
		pattern: /\brm\s+(-[a-z]*r[a-z]*f|-[a-z]*f[a-z]*r|-r\s+-f|-f\s+-r)\b/i,
		reason: "Recursively force-deletes files (rm -rf).",
	},
	{ pattern: /\bmkfs\b/, reason: "Formats a filesystem (mkfs)." },
	{ pattern: /\bdd\s+[^\n]*\bof=/, reason: "Writes a raw device image (dd of=)." },
	{ pattern: /:\s*\(\s*\)\s*\{[^}]*\|[^}]*&\s*\}/, reason: "Contains a fork-bomb pattern." },
	{
		pattern: /\b(curl|wget)\b[^\n|]*\|\s*(sudo\s+)?(sh|bash|zsh|python[0-9.]*|node)\b/i,
		reason: "Pipes a downloaded script directly into a shell.",
	},
	{
		pattern: />\s*\/dev\/(sd|nvme|disk|hd)[a-z0-9]*/i,
		reason: "Writes directly to a block device.",
	},
	{
		pattern: /\bchmod\s+(-[a-z]*R[a-z]*\s+)?0*777\b/i,
		reason: "Grants world-writable permissions (chmod 777).",
	},
	{
		pattern: /(^|[\s;&|])(shutdown|reboot|halt|poweroff)(\s|$)/,
		reason: "Powers off or reboots the host.",
	},
];

const secretRedactionPatterns: RegExp[] = [
	// key=value style secrets: TOKEN=..., --password=..., api_key=...
	/((?:^|[\s;&|])(?:[A-Za-z0-9_]*(?:secret|token|password|passwd|api[_-]?key|access[_-]?key|auth)[A-Za-z0-9_]*)\s*=\s*)(\S+)/gi,
	// --password value / --token value
	/(--(?:password|token|secret|api[_-]?key|access[_-]?key)\s+)(\S+)/gi,
	// Authorization: Bearer <token>
	/(Authorization:\s*Bearer\s+)(\S+)/gi,
];

export function redactCommand(command: string): string {
	let redacted = command;
	for (const pattern of secretRedactionPatterns) {
		redacted = redacted.replace(pattern, (_match, prefix: string) => `${prefix}[redacted]`);
	}
	return truncate(redacted, maxCommandSummaryLength);
}

function truncate(value: string, max: number): string {
	if (value.length <= max) {
		return value;
	}
	return `${value.slice(0, max - 1)}…`;
}

function readOnly(
	operation: ApprovalOperation,
	summary: RedactedActionSummary,
): ActionClassification {
	return {
		operation,
		risk: { tier: "low", overridable: true, reasons: [] },
		requiresApproval: false,
		summary,
	};
}

export function classifyExecutorAction(call: ExecutorToolCall): ActionClassification {
	switch (call.tool) {
		case "read":
			return readOnly("read", {
				operation: "read",
				path: truncate(call.arguments.path, maxPathSummaryLength),
				redactedParams: {},
			});
		case "grep":
			return readOnly("search", {
				operation: "search",
				...(call.arguments.path === undefined
					? {}
					: { path: truncate(call.arguments.path, maxPathSummaryLength) }),
				redactedParams: { pattern: truncate(call.arguments.pattern, 256) },
			});
		case "find":
			return readOnly("search", {
				operation: "search",
				...(call.arguments.path === undefined
					? {}
					: { path: truncate(call.arguments.path, maxPathSummaryLength) }),
				redactedParams: { pattern: truncate(call.arguments.pattern, 256) },
			});
		case "ls":
			return readOnly("list", {
				operation: "list",
				...(call.arguments.path === undefined
					? {}
					: { path: truncate(call.arguments.path, maxPathSummaryLength) }),
				redactedParams: {},
			});
		case "edit":
			return {
				operation: "edit",
				risk: {
					tier: "medium",
					overridable: true,
					reasons: ["Edits a file in the workspace."],
				},
				requiresApproval: true,
				summary: {
					operation: "edit",
					path: truncate(call.arguments.path, maxPathSummaryLength),
					// Never surface the edit contents; only the shape is disclosed.
					redactedParams: { edits: call.arguments.edits.length },
				},
			};
		case "write":
			return {
				operation: "write",
				risk: {
					tier: "medium",
					overridable: true,
					reasons: ["Writes file contents in the workspace."],
				},
				requiresApproval: true,
				summary: {
					operation: "write",
					path: truncate(call.arguments.path, maxPathSummaryLength),
					redactedParams: { contentBytes: byteLength(call.arguments.content) },
				},
			};
		case "bash":
			return classifyBash(call.arguments.command);
	}
}

function classifyBash(command: string): ActionClassification {
	const reasons: string[] = [];
	for (const { pattern, reason } of nonOverridableBashPatterns) {
		if (pattern.test(command)) {
			reasons.push(reason);
		}
	}
	const overridable = reasons.length === 0;
	return {
		operation: "bash",
		risk: {
			tier: overridable ? "high" : "critical",
			overridable,
			reasons: overridable ? ["Runs a shell command that can change Runtime Box state."] : reasons,
		},
		requiresApproval: true,
		summary: {
			operation: "bash",
			command: redactCommand(command),
			redactedParams: {},
		},
	};
}

export function classifyMcpAction(
	input: Pick<RuntimeBoxMcpToolInvokeInput, "mcpServerId" | "stableToolId" | "arguments">,
): ActionClassification {
	return {
		operation: "mcp",
		risk: {
			tier: "high",
			overridable: true,
			reasons: ["Invokes an external MCP tool that can have side effects."],
		},
		requiresApproval: true,
		summary: {
			operation: "mcp",
			mcpServerId: input.mcpServerId,
			mcpToolId: input.stableToolId,
			// Disclose only the argument key names, never their values.
			redactedParams: redactMcpArguments(input.arguments),
		},
	};
}

function redactMcpArguments(args: unknown): RedactedParams {
	if (args === null || typeof args !== "object" || Array.isArray(args)) {
		return {};
	}
	const redacted: RedactedParams = {};
	for (const key of Object.keys(args as Record<string, unknown>).slice(0, 32)) {
		redacted[key.slice(0, 128)] = "[redacted]";
	}
	return redacted;
}

function byteLength(value: string): number {
	return new TextEncoder().encode(value).length;
}
