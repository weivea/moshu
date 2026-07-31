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

// --- Fail-closed command preview ------------------------------------------
//
// The command preview stored in the (persisted, broadcast) Approval summary must
// never contain a raw credential. It is generated fail-closed:
//   * recognised secret-bearing positions are masked (auth/api-key/cookie/user/
//     password/token flags + headers, URL credentials + secret query params,
//     secret env assignments, and known secret literals anywhere), and
//   * any command we cannot safely tokenise (command substitution, backticks,
//     process substitution, or unbalanced quotes) is reduced to
//     "<executable> [arguments hidden]".
// The raw validated command stays on the server-only execution path (the Action
// intent) — only this preview reaches the Approval contract, events, UI, and logs.

const redactedPlaceholder = "[redacted]";
const hiddenArgumentsLabel = "[arguments hidden]";

// Flags whose *following* argument is a credential (curl/http clients, ssh, …).
const credentialValueFlags = new Set([
	"-u",
	"--user",
	"-p",
	"--password",
	"--passwd",
	"--pass",
	"--token",
	"--api-key",
	"--apikey",
	"--access-key",
	"--secret",
	"--auth",
	"--authorization",
	"--bearer",
	"--cookie",
	"--proxy-user",
	"--tlspassword",
	"--key-password",
]);

// Flags whose following argument is an HTTP header (value masked when sensitive).
const headerValueFlags = new Set(["-H", "--header"]);

// Inline "--flag=value" credential forms.
const sensitiveInlineFlag =
	/^(--?(?:user|password|passwd|pass|token|api[-_]?key|access[-_]?key|secret|auth|authorization|bearer|cookie|proxy-user|tlspassword|key-password))=/i;

// Header names whose value must never be shown.
const sensitiveHeaderName =
	/^(?:authorization|proxy-authorization|cookie|set-cookie|x-api-key|api-key|x-auth-token|x-access-token|x-amz-security-token|x-goog-api-key)$/i;

// Environment-assignment names that carry secrets.
const sensitiveEnvName =
	/(?:secret|token|password|passwd|api[-_]?key|access[-_]?key|auth|credential|private[-_]?key|session[-_]?key|passphrase)/i;

// Query-string parameter names whose value must never be shown.
const sensitiveQueryParam =
	/(?:token|secret|password|passwd|api[-_]?key|access[-_]?key|auth|signature|sig|credential|session)/i;

// High-signal standalone secret literals (masked wherever they appear).
const secretLiteralPatterns: RegExp[] = [
	/A(?:KIA|SIA|GPA|IDA|ROA|IPA|NPA|NVA|CCA)[0-9A-Z]{12,}/, // AWS keys
	/gh[posur]_[A-Za-z0-9]{20,}/, // GitHub tokens
	/github_pat_[A-Za-z0-9_]{20,}/,
	/xox[baprs]-[A-Za-z0-9-]{10,}/, // Slack
	/sk-[A-Za-z0-9_-]{16,}/, // OpenAI-style keys
	/AIza[0-9A-Za-z_-]{20,}/, // Google API key
	/ya29\.[0-9A-Za-z_-]{20,}/, // Google OAuth token
	/eyJ[A-Za-z0-9_-]{6,}\.[A-Za-z0-9_-]{6,}\.[A-Za-z0-9_-]{4,}/, // JWT
	/-----BEGIN[A-Z0-9 ]*PRIVATE KEY-----/, // PEM private key
];

// Constructs whose contents we cannot statically reason about → hide all args.
const unsafeSubstitution = /\$\(|`|<\(|>\(/;

export function buildSafeCommandPreview(command: string): string {
	if (unsafeSubstitution.test(command)) {
		return truncate(fallbackPreview(command), maxCommandSummaryLength);
	}
	const tokens = tokenizeCommand(command);
	if (tokens === null) {
		return truncate(fallbackPreview(command), maxCommandSummaryLength);
	}
	const masked: string[] = [];
	let pending: "credential" | "header" | null = null;
	for (const token of tokens) {
		if (pending === "credential") {
			masked.push(redactedPlaceholder);
			pending = null;
			continue;
		}
		if (pending === "header") {
			masked.push(maskHeaderValue(token));
			pending = null;
			continue;
		}
		const lower = token.toLowerCase();
		if (credentialValueFlags.has(lower)) {
			masked.push(token);
			pending = "credential";
			continue;
		}
		// `-H` (curl header) is case-sensitive; `--header` is not.
		if (headerValueFlags.has(token) || headerValueFlags.has(lower)) {
			masked.push(token);
			pending = "header";
			continue;
		}
		masked.push(maskToken(token));
	}
	return truncate(masked.join(" "), maxCommandSummaryLength);
}

function maskToken(token: string): string {
	const inline = token.match(sensitiveInlineFlag);
	if (inline !== null) {
		return `${inline[1]}=${redactedPlaceholder}`;
	}
	const env = token.match(/^([A-Za-z_][A-Za-z0-9_]*)=([\s\S]*)$/);
	if (env !== null) {
		const name = env[1] ?? "";
		const value = env[2] ?? "";
		if (sensitiveEnvName.test(name) || containsSecretLiteral(value) || hasUrlCredentials(value)) {
			return `${name}=${redactedPlaceholder}`;
		}
	}
	return maskSecretLiterals(maskUrl(token));
}

function maskHeaderValue(token: string): string {
	const colon = token.indexOf(":");
	if (colon > 0) {
		const name = token.slice(0, colon).trim();
		if (sensitiveHeaderName.test(name)) {
			return `${name}: ${redactedPlaceholder}`;
		}
	}
	return maskToken(token);
}

function maskUrl(token: string): string {
	if (!token.includes("://")) {
		return token;
	}
	let out = token.replace(
		/([a-z][a-z0-9+.-]*:\/\/)([^/@\s]+)@/i,
		(_match, scheme: string) => `${scheme}${redactedPlaceholder}@`,
	);
	out = out.replace(/([?&]([^=&\s]+)=)([^&\s]+)/g, (match, prefix: string, key: string) =>
		sensitiveQueryParam.test(key) ? `${prefix}${redactedPlaceholder}` : match,
	);
	return out;
}

function maskSecretLiterals(token: string): string {
	let out = token;
	for (const pattern of secretLiteralPatterns) {
		out = out.replace(new RegExp(pattern.source, "g"), () => redactedPlaceholder);
	}
	return out;
}

function containsSecretLiteral(value: string): boolean {
	return secretLiteralPatterns.some((pattern) => pattern.test(value));
}

function hasUrlCredentials(value: string): boolean {
	return /[a-z][a-z0-9+.-]*:\/\/[^/@\s]+@/i.test(value);
}

// Conservative POSIX-ish tokenizer. Returns null on unbalanced quotes so the
// caller fails closed instead of guessing.
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

function fallbackPreview(command: string): string {
	return `${safeExecutableLabel(command)} ${hiddenArgumentsLabel}`;
}

function safeExecutableLabel(command: string): string {
	for (const token of command.trim().split(/\s+/)) {
		// Skip leading environment assignments (their value may be a secret).
		if (/^[A-Za-z_][A-Za-z0-9_]*=/.test(token)) {
			continue;
		}
		const cleaned = token.replace(/[;&|<>()`'"$].*$/, "");
		if (cleaned.length > 0 && /^[A-Za-z0-9_./+-]{1,64}$/.test(cleaned)) {
			return cleaned;
		}
		return "command";
	}
	return "command";
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
