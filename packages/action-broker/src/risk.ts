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

// Patterns that additionally raise a shell command from high to *critical*:
// destructive, privilege-escalating, or remote-code-execution shapes. This list
// is only a high-signal annotation for the operator — it is NEVER the security
// boundary. Every shell command is already non-overridable (see classifyBash), so
// obfuscation that evades these patterns still cannot be auto-approved by a
// "Session Allow all" policy; it only downgrades the displayed tier to high.
const criticalBashPatterns: { pattern: RegExp; reason: string }[] = [
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

// --- Fail-closed shell command preview ------------------------------------
//
// A shell command's public preview must never expose a credential. The argument
// surface of a shell is unbounded — attached credential flags (`-uuser:secret`,
// `-pSECRET`), arbitrary/unknown flags, URL userinfo, query secrets, env
// assignments, and operator right-hand sides — so no denylist can be trusted.
// The preview is therefore fully fail-closed: it discloses ONLY the safely
// parsed executable basename (or "shell" when that cannot be proven), followed
// by "[arguments hidden]". No argv, flag value, URL, env assignment, or operator
// right-hand side is ever shown. The raw validated command stays exclusively on
// the server-only execution path (the Action intent); it never reaches the
// Approval contract, events, UI, or logs.

const hiddenArgumentsLabel = "[arguments hidden]";
const shellFallbackLabel = "shell";

export function buildSafeCommandPreview(command: string): string {
	return truncate(
		`${shellExecutableLabel(command)} ${hiddenArgumentsLabel}`,
		maxCommandSummaryLength,
	);
}

// Discloses only the executable basename we can *prove* safe to show. Unbalanced
// quotes, command/process substitution, a quoted or metacharacter-bearing
// program word, or an empty command all collapse to "shell".
function shellExecutableLabel(command: string): string {
	const tokens = tokenizeCommand(command);
	if (tokens === null) {
		return shellFallbackLabel;
	}
	let index = 0;
	// Skip leading `NAME=VALUE` environment assignments; their value may be secret.
	while (index < tokens.length && /^[A-Za-z_][A-Za-z0-9_]*=/.test(tokens[index] ?? "")) {
		index += 1;
	}
	const executable = tokens[index];
	if (executable === undefined || executable.length === 0) {
		return shellFallbackLabel;
	}
	const basename = executable.slice(executable.lastIndexOf("/") + 1);
	// Only a clean, metacharacter-free program name is ever disclosed.
	if (!/^[A-Za-z0-9._+-]{1,64}$/.test(basename)) {
		return shellFallbackLabel;
	}
	return basename;
}

// Conservative POSIX-ish tokenizer. Returns null on unbalanced quotes so the
// caller fails closed instead of guessing. Only used to locate the executable;
// argument contents are never surfaced.
function tokenizeCommand(command: string): string[] | null {
	const tokens: string[] = [];
	let current = "";
	let has = false;
	let quote: '"' | "'" | null = null;
	for (let i = 0; i < command.length; i += 1) {
		const ch = command[i] ?? "";
		if (quote === "'") {
			if (ch === "'") {
				quote = null;
			} else {
				current += ch;
			}
			continue;
		}
		if (quote === '"') {
			if (ch === "\\" && i + 1 < command.length) {
				i += 1;
				current += command[i] ?? "";
			} else if (ch === '"') {
				quote = null;
			} else {
				current += ch;
			}
			continue;
		}
		if (ch === "'" || ch === '"') {
			quote = ch;
			has = true;
			continue;
		}
		if (ch === "\\" && i + 1 < command.length) {
			i += 1;
			current += command[i] ?? "";
			has = true;
			continue;
		}
		if (/\s/.test(ch)) {
			if (has) {
				tokens.push(current);
				current = "";
				has = false;
			}
			continue;
		}
		current += ch;
		has = true;
	}
	if (quote !== null) {
		return null;
	}
	if (has) {
		tokens.push(current);
	}
	return tokens;
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
	const dangerReasons: string[] = [];
	for (const { pattern, reason } of criticalBashPatterns) {
		if (pattern.test(command)) {
			dangerReasons.push(reason);
		}
	}
	const critical = dangerReasons.length > 0;
	// Fail closed: a shell command's true effect can never be proven safe by
	// static pattern matching (interpreter paths, env wrappers, quoting, command
	// substitution, and obfuscation all defeat a denylist). Every bash Action is
	// therefore NON-overridable — a Session "Allow all" policy can never
	// auto-approve it. Known-dangerous shapes only raise the tier from high to
	// critical and attach explanatory reasons.
	const reasons = critical
		? dangerReasons
		: [
				"Runs a shell command whose full effect cannot be verified; it always requires explicit approval.",
			];
	return {
		operation: "bash",
		risk: {
			tier: critical ? "critical" : "high",
			overridable: false,
			reasons,
		},
		requiresApproval: true,
		summary: {
			operation: "bash",
			command: buildSafeCommandPreview(command),
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
