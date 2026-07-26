export const agentsUnavailableCode = "AGENTS_UNAVAILABLE" as const;
export const agentsUnavailableMessagePrefix = `${agentsUnavailableCode}: `;
export const chatSessionNotFoundCode = "SESSION_NOT_FOUND" as const;
export const chatSessionNotFoundMessagePrefix = `${chatSessionNotFoundCode}: `;

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

export function normalizeDesktopRpcError(error: unknown): Error {
	if (isAgentsUnavailableError(error)) {
		return new AgentsUnavailableError(error.message, { cause: error });
	}
	if (isChatSessionNotFoundError(error)) {
		return new ChatSessionNotFoundError(error.message, { cause: error });
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
