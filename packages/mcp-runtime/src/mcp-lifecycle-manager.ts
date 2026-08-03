import type { McpSecretInput, McpToolDescriptor, McpTransportConfig } from "@moshu/contracts";
import type { JsonValue } from "@moshu/process-rpc";

import {
	connectMcpServer,
	McpDefinitiveResponseError,
	type McpConnection,
	McpToolOutcomeUnknownError,
} from "./mcp-client";

export interface McpConnectionConfig {
	server: {
		stableResourceId: string;
		configRevision: number;
		version: string;
		contentHash: string;
		enabled: boolean;
		health: "ready" | "stopped" | "error";
		transport: McpTransportConfig;
		tools: readonly McpToolDescriptor[];
	};
	secret: McpSecretInput | undefined;
}

export interface McpLifecycleStore {
	setMcpConfigChangedListener(
		listener:
			| ((change: { stableResourceId: string; operation: "upsert" | "delete" }) => void)
			| undefined,
	): void;
	listMcpServerIds(): readonly string[];
	getMcpConnectionConfig(stableResourceId: string): McpConnectionConfig;
	updateMcpRuntimeState(
		stableResourceId: string,
		health: "ready" | "stopped" | "error",
		tools: readonly McpToolDescriptor[],
	): unknown;
}

export interface McpLifecycleManagerOptions {
	readonly connect?: typeof connectMcpServer;
	readonly reportDiagnostic?: (message: string) => void;
	readonly reconnectDelayMs?: number;
}

export class McpToolNotReadyError extends Error {
	constructor(message = "MCP Tool is not ready on its owner.", options?: ErrorOptions) {
		super(message, options);
		this.name = "McpToolNotReadyError";
	}
}

export class McpLifecycleManager {
	readonly #connections = new Map<string, McpConnection>();
	readonly #appliedConfigRevisions = new Map<string, number>();
	readonly #executions = new Map<string, Promise<void>>();
	readonly #reconnectTimers = new Map<string, ReturnType<typeof setTimeout>>();
	readonly #reconnectAttempts = new Map<string, number>();
	readonly #connect: typeof connectMcpServer;
	readonly #reportDiagnostic: (message: string) => void;
	readonly #reconnectDelayMs: number;
	#stopping = false;

	constructor(
		private readonly store: McpLifecycleStore,
		options: McpLifecycleManagerOptions = {},
	) {
		this.#connect = options.connect ?? connectMcpServer;
		this.#reportDiagnostic = options.reportDiagnostic ?? console.error;
		this.#reconnectDelayMs = options.reconnectDelayMs ?? 1_000;
		if (!Number.isSafeInteger(this.#reconnectDelayMs) || this.#reconnectDelayMs < 1) {
			throw new TypeError("MCP reconnect delay must be a positive safe integer.");
		}
	}

	async start(signal?: AbortSignal): Promise<void> {
		this.#stopping = false;
		this.store.setMcpConfigChangedListener((change) => {
			if (change.operation === "delete") {
				const timer = this.#reconnectTimers.get(change.stableResourceId);
				if (timer !== undefined) {
					clearTimeout(timer);
					this.#reconnectTimers.delete(change.stableResourceId);
				}
				void this.#enqueueOperation(change.stableResourceId, () =>
					this.#stopConnection(change.stableResourceId),
				).catch((error: unknown) => {
					this.#reportDiagnostic(
						`MCP Server ${change.stableResourceId} deletion cleanup failed: ${
							error instanceof Error ? error.message : "unknown failure"
						}`,
					);
					this.#scheduleReconnect(change.stableResourceId);
				});
				return;
			}
			void this.#enqueueReconcile(change.stableResourceId).catch((error: unknown) => {
				this.#reportDiagnostic(
					`MCP Server ${change.stableResourceId} reconciliation failed: ${
						error instanceof Error ? error.message : "unknown failure"
					}`,
				);
				this.#scheduleReconnect(change.stableResourceId);
			});
		});
		const serverIds = this.store.listMcpServerIds();
		await Promise.allSettled(
			serverIds.map(async (stableResourceId) => {
				try {
					await this.#enqueueReconcile(stableResourceId, signal);
				} catch (error) {
					this.#reportDiagnostic(
						`MCP Server ${stableResourceId} startup reconciliation failed: ${
							error instanceof Error ? error.message : "unknown failure"
						}`,
					);
					this.#scheduleReconnect(stableResourceId);
				}
			}),
		);
	}

	async callTool(
		stableResourceId: string,
		stableToolId: string,
		argumentsValue: JsonValue,
		expected: {
			version: string;
			contentHash: string;
			schemaHash: string;
		},
		signal?: AbortSignal,
	): Promise<JsonValue> {
		let config: McpConnectionConfig;
		try {
			config = this.store.getMcpConnectionConfig(stableResourceId);
		} catch (error) {
			throw new McpToolNotReadyError("MCP Tool configuration is unavailable.", {
				cause: error,
			});
		}
		const descriptor = config.server.tools.find((tool) => tool.stableToolId === stableToolId);
		const connection = this.#connections.get(stableResourceId);
		if (
			config.server.health !== "ready" ||
			config.server.version !== expected.version ||
			config.server.contentHash !== expected.contentHash ||
			descriptor?.schemaHash !== expected.schemaHash ||
			connection === undefined
		) {
			throw new McpToolNotReadyError();
		}

		try {
			const result = await connection.callTool(stableToolId, argumentsValue, signal);
			return redactInjectedMcpSecrets(result, config.secret);
		} catch (error) {
			throw redactMcpCallError(error, config.secret);
		}
	}

	isToolReady(
		stableResourceId: string,
		stableToolId: string,
		expected: { version: string; contentHash: string; schemaHash: string },
	): boolean {
		try {
			const config = this.store.getMcpConnectionConfig(stableResourceId);
			return (
				config.server.health === "ready" &&
				config.server.version === expected.version &&
				config.server.contentHash === expected.contentHash &&
				config.server.tools.some(
					(tool) => tool.stableToolId === stableToolId && tool.schemaHash === expected.schemaHash,
				) &&
				this.#connections.has(stableResourceId)
			);
		} catch (error) {
			if (isResourceNotFound(error)) {
				return false;
			}
			throw error;
		}
	}

	async shutdown(): Promise<void> {
		if (this.#stopping) {
			return;
		}
		this.#stopping = true;
		this.store.setMcpConfigChangedListener(undefined);
		for (const timer of this.#reconnectTimers.values()) {
			clearTimeout(timer);
		}
		this.#reconnectTimers.clear();
		this.#reconnectAttempts.clear();
		await Promise.allSettled(this.#executions.values());
		const closeResults = await Promise.allSettled(
			[...this.#connections.keys()].map((stableResourceId) =>
				this.#stopConnection(stableResourceId),
			),
		);
		const closeFailures = closeResults.flatMap((result) =>
			result.status === "rejected" ? [result.reason] : [],
		);
		if (closeFailures.length > 0) {
			this.#stopping = false;
			throw new AggregateError(closeFailures, "One or more MCP connections failed to close.");
		}
		this.#appliedConfigRevisions.clear();
	}

	#enqueueReconcile(stableResourceId: string, signal?: AbortSignal): Promise<void> {
		return this.#enqueueOperation(stableResourceId, () =>
			this.#reconcile(stableResourceId, signal),
		).then(() => {
			this.#reconnectAttempts.delete(stableResourceId);
		});
	}

	#enqueueOperation(stableResourceId: string, operation: () => Promise<void>): Promise<void> {
		const existing = this.#executions.get(stableResourceId) ?? Promise.resolve();
		const execution = existing.then(operation, operation);
		this.#executions.set(stableResourceId, execution);
		void execution.then(
			() => {
				if (this.#executions.get(stableResourceId) === execution) {
					this.#executions.delete(stableResourceId);
				}
			},
			() => {
				if (this.#executions.get(stableResourceId) === execution) {
					this.#executions.delete(stableResourceId);
				}
			},
		);
		return execution;
	}

	async #reconcile(stableResourceId: string, signal?: AbortSignal): Promise<void> {
		if (this.#stopping) {
			return;
		}
		const reconnectTimer = this.#reconnectTimers.get(stableResourceId);
		if (reconnectTimer !== undefined) {
			clearTimeout(reconnectTimer);
			this.#reconnectTimers.delete(stableResourceId);
		}
		let config: McpConnectionConfig;
		try {
			config = this.store.getMcpConnectionConfig(stableResourceId);
		} catch (error) {
			if (isResourceNotFound(error)) {
				await this.#stopConnection(stableResourceId);
				this.#appliedConfigRevisions.delete(stableResourceId);
				return;
			}
			throw error;
		}
		if (!config.server.enabled) {
			if (
				this.#appliedConfigRevisions.get(stableResourceId) === config.server.configRevision &&
				!this.#connections.has(stableResourceId)
			) {
				return;
			}
			await this.#stopConnection(stableResourceId);
			this.store.updateMcpRuntimeState(stableResourceId, "stopped", []);
			this.#appliedConfigRevisions.set(stableResourceId, config.server.configRevision);
			return;
		}
		if (
			this.#appliedConfigRevisions.get(stableResourceId) === config.server.configRevision &&
			this.#connections.has(stableResourceId) &&
			config.server.health === "ready"
		) {
			return;
		}
		await this.#stopConnection(stableResourceId);
		this.#appliedConfigRevisions.delete(stableResourceId);
		let uncommittedConnection: McpConnection | undefined;
		try {
			uncommittedConnection = await this.#connect({
				transport: config.server.transport,
				...(config.secret === undefined ? {} : { secret: config.secret }),
				...(signal === undefined ? {} : { signal }),
			});
			if (this.#stopping) {
				await uncommittedConnection.close();
				return;
			}
			const current = this.store.getMcpConnectionConfig(stableResourceId);
			if (current.server.configRevision !== config.server.configRevision) {
				await uncommittedConnection.close();
				return;
			}
			this.store.updateMcpRuntimeState(stableResourceId, "ready", uncommittedConnection.tools);
			this.#connections.set(stableResourceId, uncommittedConnection);
			this.#appliedConfigRevisions.set(stableResourceId, config.server.configRevision);
			this.#observeConnection(stableResourceId, uncommittedConnection);
			uncommittedConnection = undefined;
		} catch (error) {
			let cleanupFailure: unknown;
			if (uncommittedConnection !== undefined) {
				try {
					await uncommittedConnection.close();
				} catch (cleanupError) {
					cleanupFailure = cleanupError;
					if (!this.#connections.has(stableResourceId)) {
						this.#connections.set(stableResourceId, uncommittedConnection);
					}
					this.#reportDiagnostic(
						`MCP Server ${stableResourceId} uncommitted connection cleanup failed: ${
							cleanupError instanceof Error ? cleanupError.message : "unknown failure"
						}`,
					);
				}
			}
			if (cleanupFailure !== undefined) {
				throw new AggregateError(
					[error, cleanupFailure],
					`MCP Server ${stableResourceId} startup and cleanup both failed.`,
				);
			}
			if (isResourceNotFound(error)) {
				return;
			}
			try {
				this.store.updateMcpRuntimeState(stableResourceId, "error", []);
			} catch (stateError) {
				if (isResourceNotFound(stateError)) {
					return;
				}
				throw stateError;
			}
			this.#reportDiagnostic(
				`MCP Server ${stableResourceId} failed to start: ${
					error instanceof Error ? error.message : "unknown failure"
				}`,
			);
			throw error;
		}
	}

	async #stopConnection(stableResourceId: string): Promise<void> {
		const connection = this.#connections.get(stableResourceId);
		if (connection === undefined) {
			return;
		}
		this.#connections.delete(stableResourceId);
		this.#appliedConfigRevisions.delete(stableResourceId);
		try {
			await connection.close();
		} catch (error) {
			if (!this.#connections.has(stableResourceId)) {
				this.#connections.set(stableResourceId, connection);
			}
			throw error;
		}
	}

	#observeConnection(stableResourceId: string, connection: McpConnection): void {
		if (connection.closed === undefined) {
			return;
		}
		void connection.closed.then(
			() => {
				if (this.#stopping || this.#connections.get(stableResourceId) !== connection) {
					return;
				}
				this.#connections.delete(stableResourceId);
				try {
					const config = this.store.getMcpConnectionConfig(stableResourceId);
					this.store.updateMcpRuntimeState(stableResourceId, "error", config.server.tools);
					this.#scheduleReconnect(stableResourceId);
				} catch (error) {
					if (!isResourceNotFound(error)) {
						this.#reportDiagnostic(
							`MCP Server ${stableResourceId} close handling failed: ${
								error instanceof Error ? error.message : "unknown failure"
							}`,
						);
					}
				}
			},
			(error: unknown) => {
				this.#reportDiagnostic(
					`MCP Server ${stableResourceId} close observation failed: ${
						error instanceof Error ? error.message : "unknown failure"
					}`,
				);
			},
		);
	}

	#scheduleReconnect(stableResourceId: string): void {
		if (this.#stopping) {
			return;
		}
		const existingTimer = this.#reconnectTimers.get(stableResourceId);
		if (existingTimer !== undefined) {
			clearTimeout(existingTimer);
		}
		const attempt = (this.#reconnectAttempts.get(stableResourceId) ?? 0) + 1;
		this.#reconnectAttempts.set(stableResourceId, attempt);
		const delay = Math.min(30_000, this.#reconnectDelayMs * 2 ** Math.min(attempt - 1, 10));
		const timer = setTimeout(() => {
			this.#reconnectTimers.delete(stableResourceId);
			void this.#enqueueReconcile(stableResourceId).catch((error: unknown) => {
				this.#reportDiagnostic(
					`MCP Server ${stableResourceId} reconnect failed: ${
						error instanceof Error ? error.message : "unknown failure"
					}`,
				);
				this.#scheduleReconnect(stableResourceId);
			});
		}, delay);
		this.#reconnectTimers.set(stableResourceId, timer);
	}
}

function redactInjectedMcpSecrets(value: JsonValue, secret: McpSecretInput | undefined): JsonValue {
	const secretValues = collectSecretValues(secret);
	if (secretValues.length === 0) {
		return value;
	}
	return redactJsonStrings(value, secretValues);
}

function redactJsonStrings(value: JsonValue, secretValues: readonly string[]): JsonValue {
	if (typeof value === "string") {
		return redactText(value, secretValues);
	}
	if (Array.isArray(value)) {
		return value.map((item) => redactJsonStrings(item, secretValues));
	}
	if (typeof value === "object" && value !== null) {
		return Object.fromEntries(
			Object.entries(value).map(([key, item]) => [
				redactText(key, secretValues),
				redactJsonStrings(item, secretValues),
			]),
		);
	}
	return value;
}

function redactMcpCallError(error: unknown, secret: McpSecretInput | undefined): Error {
	const secretValues = collectSecretValues(secret);
	const message = redactText(error instanceof Error ? error.message : String(error), secretValues);
	if (error instanceof McpToolOutcomeUnknownError) {
		return new McpToolOutcomeUnknownError(message);
	}
	if (error instanceof McpDefinitiveResponseError) {
		return new McpDefinitiveResponseError(message);
	}
	const redacted = new Error(message);
	if (error instanceof Error) {
		redacted.name = error.name;
	}
	return redacted;
}

function collectSecretValues(secret: McpSecretInput | undefined): readonly string[] {
	if (secret === undefined) {
		return [];
	}
	return [
		...new Set(
			[...Object.values(secret.environment ?? {}), ...Object.values(secret.headers ?? {})].filter(
				(value) => value.length > 0,
			),
		),
	].sort((left, right) => right.length - left.length);
}

function redactText(value: string, secretValues: readonly string[]): string {
	let redacted = value;
	for (const secretValue of secretValues) {
		redacted = redacted.split(secretValue).join("[redacted]");
	}
	return redacted;
}

function isResourceNotFound(error: unknown): boolean {
	return (
		error instanceof Error &&
		(error.name === "RuntimeResourceNotFoundError" || error.name === "McpResourceNotFoundError")
	);
}
