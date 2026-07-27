import type {
	ProviderModel,
	ProviderType,
	ReasoningCapability,
	ReasoningSelection,
} from "@moshu/contracts";
import {
	minAnthropicThinkingBudgetTokens,
	minOutputTokensAboveThinkingBudget,
} from "@moshu/contracts";

const maxNormalizedModels = 1_024;
const maxSupportedEndpoints = 16;
const maxReasoningEfforts = 16;
const maxModelIdCharacters = 200;
const maxModelDisplayNameCharacters = 200;
const maxVendorCharacters = 120;
const maxKindCharacters = 64;
const maxEndpointCharacters = 200;
const maxEffortCharacters = 32;

export const modelProtocolValues = [
	"openai-chat-completions",
	"openai-responses",
	"anthropic-messages",
] as const;

export type ModelProtocol = (typeof modelProtocolValues)[number];

/**
 * Level set used when a catalog declares a reasoning parameter without enumerating its levels
 * (OpenRouter style `supported_parameters: ["reasoning"]`). These are the OpenAI-compatible
 * `reasoning_effort` values, so nothing outside the wire contract is invented.
 */
const openAiCompatibleDefaultReasoningEfforts = ["low", "medium", "high"] as const;

/**
 * Reads a `/models` payload from any supported wire shape and keeps only the fields the
 * response actually declared. Absent metadata stays absent so the UI can skip rendering it.
 */
export function normalizeModelListResponse(
	providerType: ProviderType,
	payload: unknown,
): ProviderModel[] {
	const entries = readModelEntries(payload);
	const normalized: ProviderModel[] = [];
	const seen = new Set<string>();

	for (const entry of entries) {
		if (normalized.length >= maxNormalizedModels) {
			break;
		}
		const model = normalizeModelEntry(entry);
		if (model === undefined || seen.has(model.id)) {
			continue;
		}
		seen.add(model.id);
		normalized.push(model);
	}
	void providerType;

	return normalized.sort((left, right) => left.id.localeCompare(right.id));
}

/**
 * Resolves a model's concrete wire protocol. Catalog order is authoritative within a Provider
 * family; when no endpoint in that family is available, the first recognized endpoint wins.
 * Catalogs without usable endpoint metadata fall back to the Provider family's default protocol.
 */
export function resolveModelProtocol(
	providerType: ProviderType,
	model: Pick<ProviderModel, "supportedEndpoints"> = {},
): ModelProtocol {
	const protocols = (model.supportedEndpoints ?? []).flatMap((endpoint): ModelProtocol[] => {
		const protocol = protocolForEndpoint(endpoint);
		return protocol === undefined ? [] : [protocol];
	});
	const matchingFamily = protocols.find((protocol) =>
		providerType === "openai-compatible"
			? protocol !== "anthropic-messages"
			: protocol === "anthropic-messages",
	);

	return matchingFamily ?? protocols[0] ?? defaultProtocol(providerType);
}

/**
 * Effort levels and thinking budgets are two coexisting mechanisms. Only what the catalog
 * declared is offered. A thinking budget is only offered when the model resolves to Anthropic
 * Messages because that is the only wire format the runtime can send one on. For that protocol,
 * the budget is inherent to the wire format, so it is offered even when undeclared.
 */
export function resolveReasoningCapability(
	providerType: ProviderType,
	model: Pick<
		ProviderModel,
		"reasoningEfforts" | "thinking" | "maxOutputTokens" | "supportedEndpoints"
	>,
): ReasoningCapability {
	const levels = model.reasoningEfforts ?? [];
	const hasEffort = levels.length > 0;
	const declaredThinking = model.thinking;
	const supportsBudget = resolveModelProtocol(providerType, model) === "anthropic-messages";

	if (hasEffort && supportsBudget) {
		return {
			kind: "both",
			levels: [...levels],
			...budgetRange(declaredThinking, model.maxOutputTokens),
		};
	}
	if (hasEffort) {
		return { kind: "effort", levels: [...levels] };
	}
	if (supportsBudget) {
		return { kind: "budget", ...budgetRange(declaredThinking, model.maxOutputTokens) };
	}

	return { kind: "none" };
}

function defaultProtocol(providerType: ProviderType): ModelProtocol {
	return providerType === "anthropic-compatible" ? "anthropic-messages" : "openai-chat-completions";
}

function protocolForEndpoint(endpoint: string): ModelProtocol | undefined {
	let path = endpoint.trim().toLowerCase();
	if (path.length === 0) {
		return undefined;
	}
	try {
		const url = new URL(path);
		if (url.protocol === "http:" || url.protocol === "https:") {
			path = url.pathname;
		}
	} catch {
		// Relative endpoint paths are the normal catalog representation.
	}
	path = `/${path.split(/[?#]/, 1)[0]?.replace(/^\/+|\/+$/g, "") ?? ""}`;

	if (path.endsWith("/chat/completions")) {
		return "openai-chat-completions";
	}
	if (path.endsWith("/responses")) {
		return "openai-responses";
	}
	if (path.endsWith("/messages")) {
		return "anthropic-messages";
	}
	return undefined;
}

/**
 * Drops any reasoning selection the resolved capability cannot honour and clamps a thinking
 * budget into the advertised range, so the runtime never sends an unsupported parameter.
 */
export function normalizeReasoningSelection(
	capability: ReasoningCapability,
	selection: { effort?: string | undefined; budgetTokens?: number | undefined } | undefined,
): ReasoningSelection | undefined {
	if (selection === undefined || capability.kind === "none") {
		return undefined;
	}

	const normalized: ReasoningSelection = {};
	if (
		(capability.kind === "effort" || capability.kind === "both") &&
		selection.effort !== undefined &&
		capability.levels.includes(selection.effort)
	) {
		normalized.effort = selection.effort;
	}
	if (
		(capability.kind === "budget" || capability.kind === "both") &&
		selection.budgetTokens !== undefined
	) {
		normalized.budgetTokens = clampBudgetTokens(
			selection.budgetTokens,
			capability.minBudgetTokens,
			capability.maxBudgetTokens,
		);
	}

	return normalized.effort === undefined && normalized.budgetTokens === undefined
		? undefined
		: normalized;
}

export function clampBudgetTokens(
	value: number,
	minBudgetTokens: number,
	maxBudgetTokens: number | undefined,
): number {
	if (value <= 0) {
		return 0;
	}
	const upperBounded =
		maxBudgetTokens === undefined ? value : Math.min(value, Math.max(maxBudgetTokens, 0));
	return Math.max(upperBounded, minBudgetTokens);
}

function budgetRange(
	thinking: ProviderModel["thinking"],
	maxOutputTokens: number | undefined,
): { adaptive?: boolean; minBudgetTokens: number; maxBudgetTokens?: number } {
	const minBudgetTokens = thinking?.minBudgetTokens ?? minAnthropicThinkingBudgetTokens;
	// The runtime raises `max_tokens` to `budget + minOutputTokensAboveThinkingBudget`, so the
	// advertised ceiling has to leave that headroom under the model's own output limit.
	const outputCeiling =
		maxOutputTokens === undefined
			? undefined
			: maxOutputTokens - minOutputTokensAboveThinkingBudget;
	const declaredMax = thinking?.maxBudgetTokens;
	const maxBudgetTokens =
		declaredMax === undefined
			? outputCeiling
			: outputCeiling === undefined
				? declaredMax
				: Math.min(declaredMax, outputCeiling);

	return {
		...(thinking?.adaptive === undefined ? {} : { adaptive: thinking.adaptive }),
		minBudgetTokens,
		...(maxBudgetTokens === undefined || maxBudgetTokens < minBudgetTokens
			? {}
			: { maxBudgetTokens }),
	};
}

function readModelEntries(payload: unknown): Record<string, unknown>[] {
	if (Array.isArray(payload)) {
		return payload.filter(isRecord);
	}
	if (!isRecord(payload)) {
		return [];
	}
	for (const key of ["data", "models", "body"]) {
		const candidate = payload[key];
		if (Array.isArray(candidate)) {
			return candidate.filter(isRecord);
		}
	}
	return [];
}

function normalizeModelEntry(entry: Record<string, unknown>): ProviderModel | undefined {
	const id = truncate(
		readNonEmptyString(entry.id) ?? readNonEmptyString(entry.name),
		maxModelIdCharacters,
	);
	if (id === undefined) {
		return undefined;
	}

	const capabilities = isRecord(entry.capabilities) ? entry.capabilities : undefined;
	const limits =
		capabilities !== undefined && isRecord(capabilities.limits) ? capabilities.limits : undefined;
	const supports =
		capabilities !== undefined && isRecord(capabilities.supports)
			? capabilities.supports
			: undefined;
	const topProvider = isRecord(entry.top_provider) ? entry.top_provider : undefined;
	const architecture = isRecord(entry.architecture) ? entry.architecture : undefined;

	const displayName = truncate(
		readNonEmptyString(entry.display_name) ??
			readNonEmptyString(entry.displayName) ??
			(readNonEmptyString(entry.name) === id ? undefined : readNonEmptyString(entry.name)),
		maxModelDisplayNameCharacters,
	);
	const vendor = truncate(
		readNonEmptyString(entry.vendor) ??
			readNonEmptyString(entry.owned_by) ??
			readNonEmptyString(entry.ownedBy),
		maxVendorCharacters,
	);
	const kind = truncate(
		(capabilities === undefined ? undefined : readNonEmptyString(capabilities.type)) ??
			(architecture === undefined ? undefined : readNonEmptyString(architecture.modality)) ??
			(readNonEmptyString(entry.type) === "model" ? undefined : readNonEmptyString(entry.type)),
		maxKindCharacters,
	);
	const contextWindowTokens =
		readPositiveInteger(limits?.max_context_window_tokens) ??
		readPositiveInteger(entry.context_length) ??
		readPositiveInteger(entry.context_window) ??
		readPositiveInteger(entry.max_context_window_tokens);
	const maxOutputTokens =
		readPositiveInteger(limits?.max_output_tokens) ??
		readPositiveInteger(topProvider?.max_completion_tokens) ??
		readPositiveInteger(entry.max_output_tokens);
	const supportedEndpoints = readStringArray(
		entry.supported_endpoints,
		maxSupportedEndpoints,
		maxEndpointCharacters,
	);
	const reasoningEfforts =
		readReasoningEfforts(supports) ??
		(declaresUnenumeratedReasoning(entry)
			? [...openAiCompatibleDefaultReasoningEfforts]
			: undefined);
	const thinking = readThinking(supports);
	const preview = typeof entry.preview === "boolean" ? entry.preview : undefined;

	const model: ProviderModel = { id, enabled: false };
	if (displayName !== undefined) {
		model.displayName = displayName;
	}
	if (vendor !== undefined) {
		model.vendor = vendor;
	}
	if (kind !== undefined) {
		model.kind = kind;
	}
	if (preview !== undefined) {
		model.preview = preview;
	}
	if (contextWindowTokens !== undefined) {
		model.contextWindowTokens = contextWindowTokens;
	}
	if (maxOutputTokens !== undefined) {
		model.maxOutputTokens = maxOutputTokens;
	}
	if (supportedEndpoints !== undefined) {
		model.supportedEndpoints = supportedEndpoints;
	}
	if (reasoningEfforts !== undefined) {
		model.reasoningEfforts = reasoningEfforts;
	}
	if (thinking !== undefined) {
		model.thinking = thinking;
	}

	return model;
}

function readReasoningEfforts(supports: Record<string, unknown> | undefined): string[] | undefined {
	const levels = readStringArray(
		supports?.reasoning_effort,
		maxReasoningEfforts,
		maxEffortCharacters,
	);
	return levels === undefined || levels.length === 0 ? undefined : levels;
}

function readThinking(
	supports: Record<string, unknown> | undefined,
): ProviderModel["thinking"] | undefined {
	if (supports === undefined) {
		return undefined;
	}
	const adaptive =
		typeof supports.adaptive_thinking === "boolean" ? supports.adaptive_thinking : undefined;
	const minBudgetTokens = readPositiveInteger(supports.min_thinking_budget);
	const maxBudgetTokens = readPositiveInteger(supports.max_thinking_budget);
	if (adaptive === undefined && minBudgetTokens === undefined && maxBudgetTokens === undefined) {
		return undefined;
	}

	return {
		...(adaptive === undefined ? {} : { adaptive }),
		...(minBudgetTokens === undefined ? {} : { minBudgetTokens }),
		...(maxBudgetTokens === undefined ? {} : { maxBudgetTokens }),
	};
}

function declaresUnenumeratedReasoning(entry: Record<string, unknown>): boolean {
	return readStringArray(entry.supported_parameters, 64, 64)?.includes("reasoning") ?? false;
}

function readStringArray(
	value: unknown,
	limit: number,
	maxCharacters: number,
): string[] | undefined {
	if (!Array.isArray(value)) {
		return undefined;
	}
	const items: string[] = [];
	for (const item of value) {
		const normalized = truncate(readNonEmptyString(item), maxCharacters);
		if (normalized !== undefined && !items.includes(normalized)) {
			items.push(normalized);
		}
		if (items.length >= limit) {
			break;
		}
	}
	return items.length === 0 ? undefined : items;
}

function truncate(value: string | undefined, maxCharacters: number): string | undefined {
	return value === undefined ? undefined : value.slice(0, maxCharacters);
}

function readNonEmptyString(value: unknown): string | undefined {
	if (typeof value !== "string") {
		return undefined;
	}
	const normalized = value.trim();
	return normalized.length === 0 ? undefined : normalized;
}

function readPositiveInteger(value: unknown): number | undefined {
	if (typeof value !== "number" || !Number.isSafeInteger(value) || value <= 0) {
		return undefined;
	}
	return value;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}
