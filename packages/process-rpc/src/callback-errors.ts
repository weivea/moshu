export function reportRpcCallbackError(error: unknown): void {
	try {
		console.error("Unhandled process RPC callback error.", error);
	} catch {
		// Error reporting must never become a second unhandled callback failure.
	}
}

export function invokeRpcCallback(
	callback: () => unknown,
	report: (error: unknown) => void = reportRpcCallbackError,
): void {
	let result: unknown;
	try {
		result = callback();
	} catch (error) {
		safelyReport(report, error);
		return;
	}
	Promise.resolve(result).catch((error: unknown) => safelyReport(report, error));
}

function safelyReport(report: (error: unknown) => void, error: unknown): void {
	try {
		const result: unknown = report(error);
		Promise.resolve(result).catch(reportRpcCallbackError);
	} catch (reportError) {
		reportRpcCallbackError(reportError);
	}
}
