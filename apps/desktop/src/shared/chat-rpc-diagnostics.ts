export type ChatRpcDiagnosticSide = "bun" | "web";
export type ChatRpcDiagnosticDirection = "receive" | "send";

interface TraceChatRpcRequestOptions<T> {
	side: ChatRpcDiagnosticSide;
	operation: string;
	input: unknown;
	execute(): T | Promise<T>;
}

export async function traceChatRpcRequest<T>({
	side,
	operation,
	input,
	execute,
}: TraceChatRpcRequestOptions<T>): Promise<T> {
	const requestDirection = side === "web" ? "send" : "receive";
	const responseDirection = side === "web" ? "receive" : "send";
	logChatRpcDiagnostic(side, requestDirection, `${operation}.request`, input);

	try {
		const output = await execute();
		logChatRpcDiagnostic(side, responseDirection, `${operation}.response`, output);
		return output;
	} catch (error) {
		logChatRpcDiagnostic(side, responseDirection, `${operation}.error`, toDiagnosticError(error));
		throw error;
	}
}

export function logChatRpcDiagnostic(
	side: ChatRpcDiagnosticSide,
	direction: ChatRpcDiagnosticDirection,
	operation: string,
	payload: unknown,
): void {
	console.info(`[chat-rpc][${side}][${direction}] ${operation}`, {
		timestamp: new Date().toISOString(),
		payload,
	});
}

function toDiagnosticError(error: unknown): { name: string; message: string } {
	if (error instanceof Error) {
		return {
			name: error.name,
			message: error.message,
		};
	}

	return {
		name: "UnknownError",
		message: String(error),
	};
}
