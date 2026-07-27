export class ProviderCatalogError extends Error {
	readonly statusCode: number | undefined;

	constructor(message: string, statusCode?: number, options?: { cause?: unknown }) {
		super(message, options);
		this.name = "ProviderCatalogError";
		this.statusCode = statusCode;
	}
}
