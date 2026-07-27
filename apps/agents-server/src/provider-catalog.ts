import { normalizeModelListResponse } from "@moshu/agent-runtime";
import type { ProviderModel, ProviderType } from "@moshu/contracts";

export const anthropicApiVersion = "2023-06-01";
const modelListTimeoutMs = 15_000;
const maxModelListResponseBytes = 4 * 1024 * 1024;

export interface ProviderCatalogRequest {
	type: ProviderType;
	baseUrl: string;
	apiKey: string;
	customHeaders?: Record<string, string>;
}

export class ProviderCatalogError extends Error {
	readonly statusCode?: number;

	constructor(message: string, statusCode?: number, options?: { cause?: unknown }) {
		super(message, options);
		this.name = "ProviderCatalogError";
		if (statusCode !== undefined) {
			this.statusCode = statusCode;
		}
	}
}

export function buildModelListRequest(request: ProviderCatalogRequest): {
	url: string;
	headers: Record<string, string>;
} {
	const url = `${request.baseUrl.replace(/\/+$/, "")}/models`;
	const headers: Record<string, string> =
		request.type === "anthropic-compatible"
			? { "x-api-key": request.apiKey, "anthropic-version": anthropicApiVersion }
			: { authorization: `Bearer ${request.apiKey}` };

	return {
		url,
		headers: { accept: "application/json", ...headers, ...(request.customHeaders ?? {}) },
	};
}

export async function fetchProviderModelCatalog(
	request: ProviderCatalogRequest,
	fetchImplementation: typeof fetch = fetch,
): Promise<ProviderModel[]> {
	const { url, headers } = buildModelListRequest(request);
	const controller = new AbortController();
	const timeout = setTimeout(() => controller.abort(), modelListTimeoutMs);

	let response: Response;
	try {
		response = await fetchImplementation(url, {
			method: "GET",
			headers,
			signal: controller.signal,
		});
	} catch (error) {
		throw new ProviderCatalogError("The Provider model list could not be reached.", undefined, {
			cause: error,
		});
	} finally {
		clearTimeout(timeout);
	}

	if (!response.ok) {
		throw new ProviderCatalogError(
			`The Provider model list request failed with status ${response.status}.`,
			response.status,
		);
	}

	const body = await response.text();
	if (body.length > maxModelListResponseBytes) {
		throw new ProviderCatalogError("The Provider model list response is too large.");
	}

	let payload: unknown;
	try {
		payload = JSON.parse(body);
	} catch (error) {
		throw new ProviderCatalogError(
			"The Provider model list response is not valid JSON.",
			undefined,
			{
				cause: error,
			},
		);
	}

	return normalizeModelListResponse(request.type, payload);
}
