import type { CustomProviderApi } from "@moshu/contracts";

import type { MessageKey } from "../i18n";

export const providerTypeOptions = [
	{ value: "openai-completions", label: "providers.type.openaiCompatible" },
	{ value: "openai-responses", label: "providers.type.openaiCompatible" },
	{ value: "anthropic-messages", label: "providers.type.anthropicCompatible" },
	{ value: "google-generative-ai", label: "providers.type.openaiCompatible" },
] as const satisfies readonly { value: CustomProviderApi; label: MessageKey }[];

export function providerTypeLabelKey(type: CustomProviderApi): MessageKey {
	return (
		providerTypeOptions.find((option) => option.value === type)?.label ??
		"providers.type.openaiCompatible"
	);
}

export class CustomHeadersParseError extends Error {
	constructor() {
		super("Custom headers must be a JSON object of string values.");
		this.name = "CustomHeadersParseError";
	}
}

/** Parses the Custom headers textarea. An empty value clears the stored headers. */
export function parseCustomHeaders(value: string): Record<string, string> | undefined {
	const normalized = value.trim();
	if (normalized.length === 0) {
		return undefined;
	}

	let parsed: unknown;
	try {
		parsed = JSON.parse(normalized);
	} catch {
		throw new CustomHeadersParseError();
	}
	if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
		throw new CustomHeadersParseError();
	}
	const entries = Object.entries(parsed);
	if (
		entries.some(
			([name, headerValue]) => name.trim().length === 0 || typeof headerValue !== "string",
		)
	) {
		throw new CustomHeadersParseError();
	}

	return Object.fromEntries(entries) as Record<string, string>;
}

export function formatTokenCount(tokens: number): string {
	if (tokens >= 1_000_000) {
		return `${trimZero(tokens / 1_000_000)}M`;
	}
	if (tokens >= 1_000) {
		return `${trimZero(tokens / 1_000)}K`;
	}
	return String(tokens);
}

function trimZero(value: number): string {
	return value.toFixed(1).replace(/\.0$/, "");
}
