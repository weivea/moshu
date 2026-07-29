import type { JsonValue } from "@moshu/process-rpc";

import { connectMcpServer, type McpConnection } from "./mcp-client";
import {
	RuntimeResourceNotFoundError,
	type RuntimeMcpConnectionConfig,
	type RuntimeResourceStore,
} from "./runtime-resource-store";

export interface McpLifecycleManagerOptions {
	readonly connect?: typeof connectMcpServer;
	readonly reportDiagnostic?: (message: string) => void;
	readonly reconnectDelayMs?: number;
}

export class McpLifecycleManager {
	readonly #connections = new Map<string, McpConnection>();
	readonly #executions = new Map<string, Promise<void>>();
	readonly #reconnectTimers = new Map<string, ReturnType<typeof setTimeout>>();
	readonly #reconnectAttempts = new Map<string, number>();
	readonly #connect: typeof connectMcpServer;
	readonly #reportDiagnostic: (message: string) => void;
	readonly #reconnectDelayMs: number;
	#stopping = false;

	constructor(
		private readonly store: RuntimeResourceStore,
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
		const servers = this.store.listMcpServers("runtime-box-internal").items;
		await Promise.allSettled(
			servers.map(async (server) => {
				try {
					await this.#enqueueReconcile(server.stableResourceId, signal);
				} catch (error) {
					this.#reportDiagnostic(
						`MCP Server ${server.stableResourceId} startup reconciliation failed: ${
							error instanceof Error ? error.message : "unknown failure"
						}`,
					);
					this.#scheduleReconnect(server.stableResourceId);
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
		const config = this.store.getMcpConnectionConfig(stableResourceId);
		const descriptor = config.server.tools.find((tool) => tool.stableToolId === stableToolId);
		const connection = this.#connections.get(stableResourceId);
		if (
			config.server.health !== "ready" ||
			config.server.version !== expected.version ||
			config.server.contentHash !== expected.contentHash ||
			descriptor?.schemaHash !== expected.schemaHash ||
			connection === undefined
		) {
			throw new Error("MCP Tool is not ready on this Runtime Box.");
		}

		return connection.callTool(stableToolId, argumentsValue, signal);
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
			if (error instanceof RuntimeResourceNotFoundError) {
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
		await Promise.allSettled(
			[...this.#connections.keys()].map((stableResourceId) =>
				this.#stopConnection(stableResourceId),
			),
		);
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
		await this.#stopConnection(stableResourceId);
		let config: RuntimeMcpConnectionConfig;
		try {
			config = this.store.getMcpConnectionConfig(stableResourceId);
		} catch (error) {
			if (error instanceof RuntimeResourceNotFoundError) {
				return;
			}
			throw error;
		}
		if (!config.server.enabled) {
			this.store.updateMcpRuntimeState(stableResourceId, "stopped", []);
			return;
		}
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
			if (current.server.version !== config.server.version) {
				await uncommittedConnection.close();
				return;
			}
			this.store.updateMcpRuntimeState(stableResourceId, "ready", uncommittedConnection.tools);
			this.#connections.set(stableResourceId, uncommittedConnection);
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
			if (error instanceof RuntimeResourceNotFoundError) {
				return;
			}
			try {
				this.store.updateMcpRuntimeState(stableResourceId, "error", []);
			} catch (stateError) {
				if (stateError instanceof RuntimeResourceNotFoundError) {
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
					if (!(error instanceof RuntimeResourceNotFoundError)) {
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
