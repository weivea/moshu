export const agentsUnavailableCode = "AGENTS_UNAVAILABLE" as const;
export const agentsUnavailableMessagePrefix = `${agentsUnavailableCode}: `;
export const chatSessionNotFoundCode = "SESSION_NOT_FOUND" as const;
export const chatSessionNotFoundMessagePrefix = `${chatSessionNotFoundCode}: `;
export const projectPreviewStaleCode = "PROJECT_PREVIEW_STALE" as const;
export const projectPreviewStaleMessagePrefix = `${projectPreviewStaleCode}: `;

export class AgentsUnavailableError extends Error {
	readonly code = agentsUnavailableCode;

	constructor(
		detail = "The local agents service is unavailable or recovering.",
		options?: ErrorOptions,
	) {
		super(`${agentsUnavailableMessagePrefix}${stripAgentsUnavailablePrefix(detail)}`, options);
		this.name = "AgentsUnavailableError";
	}
}

export class ChatSessionNotFoundError extends Error {
	readonly code = chatSessionNotFoundCode;

	constructor(detail = "The chat Session was not found.", options?: ErrorOptions) {
		super(`${chatSessionNotFoundMessagePrefix}${stripChatSessionNotFoundPrefix(detail)}`, options);
		this.name = "ChatSessionNotFoundError";
	}
}

export class ProjectPreviewStaleError extends Error {
	readonly code = projectPreviewStaleCode;

	constructor(detail = "The Project path preview is stale.", options?: ErrorOptions) {
		super(`${projectPreviewStaleMessagePrefix}${stripProjectPreviewStalePrefix(detail)}`, options);
		this.name = "ProjectPreviewStaleError";
	}
}

export function isAgentsUnavailableError(error: unknown): error is Error {
	return error instanceof Error && error.message.startsWith(agentsUnavailableMessagePrefix);
}

export function isChatSessionNotFoundError(error: unknown): error is Error {
	return (
		error instanceof Error &&
		(error.message.startsWith(chatSessionNotFoundMessagePrefix) ||
			("code" in error && error.code === chatSessionNotFoundCode))
	);
}

export function isProjectPreviewStaleError(error: unknown): error is Error {
	return (
		error instanceof Error &&
		(error.message.startsWith(projectPreviewStaleMessagePrefix) ||
			("code" in error && error.code === projectPreviewStaleCode))
	);
}

export function normalizeDesktopRpcError(error: unknown): Error {
	if (isAgentsUnavailableError(error)) {
		return new AgentsUnavailableError(error.message, { cause: error });
	}
	if (isChatSessionNotFoundError(error)) {
		return new ChatSessionNotFoundError(error.message, { cause: error });
	}
	if (isProjectPreviewStaleError(error)) {
		return new ProjectPreviewStaleError(error.message, { cause: error });
	}
	return error instanceof Error ? error : new Error("Desktop RPC request failed.");
}

function stripAgentsUnavailablePrefix(message: string): string {
	return message.startsWith(agentsUnavailableMessagePrefix)
		? message.slice(agentsUnavailableMessagePrefix.length)
		: message;
}

function stripChatSessionNotFoundPrefix(message: string): string {
	return message.startsWith(chatSessionNotFoundMessagePrefix)
		? message.slice(chatSessionNotFoundMessagePrefix.length)
		: message;
}

function stripProjectPreviewStalePrefix(message: string): string {
	return message.startsWith(projectPreviewStaleMessagePrefix)
		? message.slice(projectPreviewStaleMessagePrefix.length)
		: message;
}
