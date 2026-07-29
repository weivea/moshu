import { createHash } from "node:crypto";
import type { ChildProcessWithoutNullStreams } from "node:child_process";
import {
	mcpToolDescriptorSchema,
	type McpSecretInput,
	type McpToolDescriptor,
	type McpTransportConfig,
} from "@moshu/contracts";
import { rpcJsonValueSchema, type JsonValue } from "@moshu/process-rpc";
import { spawnExecutorProcess, terminateExecutorProcess } from "./tools/process-runner";

const mcpProtocolVersion = "2025-03-26";
const maxMcpMessageBytes = 4 * 1024 * 1024;

export interface McpConnection {
	readonly tools: readonly McpToolDescriptor[];
	readonly closed?: Promise<void>;
	callTool(
		stableToolId: string,
		argumentsValue: JsonValue,
		signal?: AbortSignal,
	): Promise<JsonValue>;
	close(): Promise<void>;
}

export class McpToolOutcomeUnknownError extends Error {
	constructor(message: string, options?: ErrorOptions) {
		super(message, options);
		this.name = "McpToolOutcomeUnknownError";
	}
}

class McpDefinitiveResponseError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "McpDefinitiveResponseError";
	}
}

class McpHttpStatusError extends McpDefinitiveResponseError {
	constructor(readonly status: number) {
		super(`MCP HTTP request failed with status ${status}.`);
		this.name = "McpHttpStatusError";
	}
}

export async function connectMcpServer(input: {
	transport: McpTransportConfig;
	secret?: McpSecretInput;
	signal?: AbortSignal;
}): Promise<McpConnection> {
	input.signal?.throwIfAborted();
	if (input.transport.type === "stdio") {
		return StdioMcpConnection.connect(input.transport, input.secret, input.signal);
	}
	if (input.transport.type === "streamable-http") {
		return HttpMcpConnection.connect(input.transport, input.secret, input.signal);
	}
	return LegacySseMcpConnection.connect(input.transport, input.secret, input.signal);
}

interface RemoteMcpTool {
	name: string;
	description?: string;
	inputSchema: JsonValue;
	outputSchema?: JsonValue;
}

class StdioMcpConnection implements McpConnection {
	readonly tools: readonly McpToolDescriptor[];
	readonly #toolNameById: ReadonlyMap<string, string>;
	readonly #process: ChildProcessWithoutNullStreams;
	readonly #pending = new Map<
		number,
		{ resolve: (value: JsonValue) => void; reject: (error: unknown) => void }
	>();
	#nextRequestId = 1;
	#closed = false;
	readonly #closedSignal = Promise.withResolvers<void>();
	#cleanupPromise: Promise<void> | undefined;

	private constructor(process: ChildProcessWithoutNullStreams, tools: readonly RemoteMcpTool[]) {
		this.#process = process;
		this.tools = tools.map(createToolDescriptor);
		this.#toolNameById = new Map(
			this.tools.map((descriptor, index) => [
				descriptor.stableToolId,
				tools[index]?.name ?? descriptor.name,
			]),
		);
	}

	get closed(): Promise<void> {
		return this.#closedSignal.promise;
	}

	static async connect(
		transport: Extract<McpTransportConfig, { type: "stdio" }>,
		secret: McpSecretInput | undefined,
		signal: AbortSignal | undefined,
	): Promise<StdioMcpConnection> {
		const environment = createMinimalMcpEnvironment(secret?.environment);
		const child = spawnExecutorProcess(transport.command, transport.args, {
			cwd: transport.cwd ?? process.cwd(),
			env: environment,
			keepStdinOpen: true,
		});
		const bootstrap = new StdioMcpBootstrap(child);
		try {
			bootstrap.start();
			const initialized = await bootstrap.request(
				"initialize",
				{
					protocolVersion: mcpProtocolVersion,
					capabilities: {},
					clientInfo: { name: "moshu-runtime-box", version: "0.0.1" },
				},
				signal,
				transport.startupTimeoutMs,
			);
			requireInitializeResult(initialized);
			bootstrap.notify("notifications/initialized", {});
			const tools = await listAllTools(
				(method, params, requestSignal) =>
					bootstrap.request(method, params, requestSignal, transport.startupTimeoutMs),
				signal,
			);
			const connection = new StdioMcpConnection(child, tools);
			bootstrap.transfer(connection);
			return connection;
		} catch (error) {
			await terminateProcess(child);
			throw error;
		}
	}

	callTool(
		stableToolId: string,
		argumentsValue: JsonValue,
		signal?: AbortSignal,
	): Promise<JsonValue> {
		const name = this.#toolNameById.get(stableToolId);
		if (name === undefined) {
			return Promise.reject(new Error("MCP Tool is not part of the live inventory."));
		}
		return this.#request("tools/call", { name, arguments: argumentsValue }, signal, 120_000).catch(
			rethrowMcpToolFailure,
		);
	}

	async close(): Promise<void> {
		await this.#cleanup(new Error("MCP stdio connection closed."));
	}

	acceptMessage(message: unknown): void {
		if (
			typeof message !== "object" ||
			message === null ||
			!("id" in message) ||
			typeof message.id !== "number"
		) {
			return;
		}
		const pending = this.#pending.get(message.id);
		if (pending === undefined) {
			return;
		}
		this.#pending.delete(message.id);
		if ("error" in message) {
			pending.reject(new McpDefinitiveResponseError(readMcpError(message.error)));
			return;
		}
		if (!("result" in message)) {
			pending.reject(new Error("MCP response is missing a result."));
			return;
		}
		pending.resolve(rpcJsonValueSchema.parse(message.result));
	}

	handleClosed(error: unknown): void {
		void this.#cleanup(error).catch((cleanupError: unknown) => {
			console.error(
				cleanupError instanceof Error
					? `MCP stdio cleanup failed: ${cleanupError.message}`
					: "MCP stdio cleanup failed.",
			);
		});
	}

	#request(
		method: string,
		params: unknown,
		signal: AbortSignal | undefined,
		timeoutMs: number,
	): Promise<JsonValue> {
		if (this.#closed) {
			return Promise.reject(new Error("MCP stdio connection is closed."));
		}
		const id = this.#nextRequestId++;
		const payload = JSON.stringify({ jsonrpc: "2.0", id, method, params });
		if (Buffer.byteLength(payload, "utf8") > maxMcpMessageBytes) {
			return Promise.reject(new Error("MCP request exceeds the message limit."));
		}
		return new Promise<JsonValue>((resolve, reject) => {
			let settled = false;
			const finish = (callback: () => void): void => {
				if (settled) {
					return;
				}
				settled = true;
				clearTimeout(timer);
				signal?.removeEventListener("abort", abort);
				this.#pending.delete(id);
				callback();
			};
			const abort = () => finish(() => reject(signal?.reason));
			const timer = setTimeout(
				() => finish(() => reject(new Error(`MCP request ${method} timed out.`))),
				timeoutMs,
			);
			this.#pending.set(id, {
				resolve: (value) => finish(() => resolve(value)),
				reject: (error) => finish(() => reject(error)),
			});
			signal?.addEventListener("abort", abort, { once: true });
			if (signal?.aborted) {
				abort();
				return;
			}
			try {
				this.#process.stdin.write(`${payload}\n`);
			} catch (error) {
				finish(() => reject(error));
			}
		});
	}

	#rejectPending(error: unknown): void {
		for (const pending of this.#pending.values()) {
			pending.reject(error);
		}
		this.#pending.clear();
	}

	#cleanup(error: unknown): Promise<void> {
		if (this.#cleanupPromise !== undefined) {
			return this.#cleanupPromise;
		}
		this.#closed = true;
		this.#rejectPending(error);
		this.#cleanupPromise = terminateProcess(this.#process).then(
			() => {
				this.#closedSignal.resolve();
			},
			(cleanupError: unknown) => {
				this.#cleanupPromise = undefined;
				throw cleanupError;
			},
		);
		return this.#cleanupPromise;
	}
}

class StdioMcpBootstrap {
	readonly #process: ChildProcessWithoutNullStreams;
	readonly #pending = new Map<
		number,
		{ resolve: (value: JsonValue) => void; reject: (error: unknown) => void }
	>();
	#nextRequestId = 1;
	#target: StdioMcpConnection | undefined;
	#started = false;

	constructor(process: ChildProcessWithoutNullStreams) {
		this.#process = process;
	}

	start(): void {
		if (this.#started) {
			return;
		}
		this.#started = true;
		void this.#readStdout();
		this.#process.stderr.resume();
		this.#process.once("error", (error) => {
			this.#failPending(error);
		});
		this.#process.once("close", (exitCode, signal) => {
			const error = new Error(
				`MCP stdio process exited with code ${exitCode ?? "null"} and signal ${signal ?? "none"}.`,
			);
			this.#failPending(error);
		});
	}

	#failPending(error: unknown): void {
		this.#target?.handleClosed(error);
		for (const pending of this.#pending.values()) {
			pending.reject(error);
		}
		this.#pending.clear();
	}

	transfer(target: StdioMcpConnection): void {
		this.#target = target;
	}

	request(
		method: string,
		params: unknown,
		signal: AbortSignal | undefined,
		timeoutMs: number,
	): Promise<JsonValue> {
		const id = this.#nextRequestId++;
		const payload = JSON.stringify({ jsonrpc: "2.0", id, method, params });
		return new Promise<JsonValue>((resolve, reject) => {
			let settled = false;
			const finish = (callback: () => void): void => {
				if (settled) {
					return;
				}
				settled = true;
				clearTimeout(timer);
				signal?.removeEventListener("abort", abort);
				this.#pending.delete(id);
				callback();
			};
			const abort = () => finish(() => reject(signal?.reason));
			const timer = setTimeout(
				() => finish(() => reject(new Error(`MCP request ${method} timed out.`))),
				timeoutMs,
			);
			this.#pending.set(id, {
				resolve: (value) => finish(() => resolve(value)),
				reject: (error) => finish(() => reject(error)),
			});
			signal?.addEventListener("abort", abort, { once: true });
			if (signal?.aborted) {
				abort();
				return;
			}
			this.#process.stdin.write(`${payload}\n`);
		});
	}

	notify(method: string, params: unknown): void {
		this.#process.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", method, params })}\n`);
	}

	async #readStdout(): Promise<void> {
		const decoder = new TextDecoder();
		let buffered = "";
		try {
			for await (const rawChunk of this.#process.stdout) {
				const chunk = Buffer.isBuffer(rawChunk) ? rawChunk : Buffer.from(rawChunk);
				buffered += decoder.decode(chunk, { stream: true });
				if (Buffer.byteLength(buffered, "utf8") > maxMcpMessageBytes) {
					throw new Error("MCP stdio response exceeds the message limit.");
				}
				let newline = buffered.indexOf("\n");
				while (newline >= 0) {
					const line = buffered.slice(0, newline).trim();
					buffered = buffered.slice(newline + 1);
					if (line.length > 0) {
						this.#acceptMessage(JSON.parse(line));
					}
					newline = buffered.indexOf("\n");
				}
			}
		} catch (error) {
			this.#failPending(error);
		}
	}

	#acceptMessage(message: unknown): void {
		if (this.#target !== undefined) {
			this.#target.acceptMessage(message);
			return;
		}
		if (
			typeof message !== "object" ||
			message === null ||
			!("id" in message) ||
			typeof message.id !== "number"
		) {
			return;
		}
		const pending = this.#pending.get(message.id);
		if (pending === undefined) {
			return;
		}
		if ("error" in message) {
			pending.reject(new Error(readMcpError(message.error)));
		} else if ("result" in message) {
			pending.resolve(rpcJsonValueSchema.parse(message.result));
		} else {
			pending.reject(new Error("MCP response is missing a result."));
		}
	}
}

class LegacySseMcpConnection implements McpConnection {
	#tools: readonly McpToolDescriptor[] = [];
	#toolNameById: ReadonlyMap<string, string> = new Map();
	readonly #headers: Readonly<Record<string, string>>;
	readonly #timeoutMs: number;
	readonly #streamUrl: string;
	readonly #controller = new AbortController();
	readonly #endpoint = Promise.withResolvers<string>();
	readonly #pending = new Map<
		number,
		{ resolve: (value: JsonValue) => void; reject: (error: unknown) => void }
	>();
	#nextRequestId = 1;
	readonly #closedSignal = Promise.withResolvers<void>();
	#cancelReader: (() => Promise<void>) | undefined;
	#cleanupPromise: Promise<void> | undefined;

	private constructor(input: {
		url: string;
		headers: Readonly<Record<string, string>>;
		timeoutMs: number;
	}) {
		this.#streamUrl = input.url;
		this.#headers = input.headers;
		this.#timeoutMs = input.timeoutMs;
	}

	get tools(): readonly McpToolDescriptor[] {
		return this.#tools;
	}

	get closed(): Promise<void> {
		return this.#closedSignal.promise;
	}

	static async connect(
		transport: Extract<McpTransportConfig, { type: "sse" }>,
		secret: McpSecretInput | undefined,
		signal: AbortSignal | undefined,
	): Promise<LegacySseMcpConnection> {
		const connection = new LegacySseMcpConnection({
			url: transport.url,
			headers: { ...(secret?.headers ?? {}) },
			timeoutMs: transport.timeoutMs,
		});
		try {
			await connection.#open(signal);
			const initialized = await connection.#request(
				"initialize",
				{
					protocolVersion: mcpProtocolVersion,
					capabilities: {},
					clientInfo: { name: "moshu-runtime-box", version: "0.0.1" },
				},
				signal,
			);
			requireInitializeResult(initialized);
			await connection.#notify("notifications/initialized", {}, signal);
			const remoteTools = await listAllTools(
				(method, params, requestSignal) => connection.#request(method, params, requestSignal),
				signal,
			);
			connection.#tools = remoteTools.map(createToolDescriptor);
			connection.#toolNameById = new Map(
				connection.#tools.map((descriptor, index) => [
					descriptor.stableToolId,
					remoteTools[index]?.name ?? descriptor.name,
				]),
			);
			return connection;
		} catch (error) {
			await connection.close();
			throw error;
		}
	}

	callTool(
		stableToolId: string,
		argumentsValue: JsonValue,
		signal?: AbortSignal,
	): Promise<JsonValue> {
		const name = this.#toolNameById.get(stableToolId);
		if (name === undefined) {
			return Promise.reject(new Error("MCP Tool is not part of the live inventory."));
		}
		return this.#request("tools/call", { name, arguments: argumentsValue }, signal).catch(
			rethrowMcpToolFailure,
		);
	}

	async close(): Promise<void> {
		await this.#cleanup(new Error("MCP SSE connection closed."));
	}

	async #open(signal: AbortSignal | undefined): Promise<void> {
		const openTimeout = AbortSignal.timeout(this.#timeoutMs);
		const openSignal =
			signal === undefined
				? AbortSignal.any([this.#controller.signal, openTimeout])
				: AbortSignal.any([this.#controller.signal, openTimeout, signal]);
		const response = await fetch(this.#streamUrl, {
			method: "GET",
			headers: { ...this.#headers, accept: "text/event-stream" },
			signal: openSignal,
			redirect: "manual",
		});
		if (!response.ok || response.body === null) {
			throw new Error(`MCP SSE connection failed with status ${response.status}.`);
		}
		void this.#readEvents(response.body);
		await Promise.race([
			this.#endpoint.promise,
			Bun.sleep(this.#timeoutMs).then(() => {
				throw new Error("MCP SSE endpoint discovery timed out.");
			}),
		]);
	}

	#request(method: string, params: unknown, signal?: AbortSignal): Promise<JsonValue> {
		const id = this.#nextRequestId++;
		return new Promise<JsonValue>((resolve, reject) => {
			let settled = false;
			const finish = (callback: () => void): void => {
				if (settled) {
					return;
				}
				settled = true;
				clearTimeout(timer);
				signal?.removeEventListener("abort", abort);
				this.#pending.delete(id);
				callback();
			};
			const abort = () => finish(() => reject(signal?.reason));
			const timer = setTimeout(
				() => finish(() => reject(new Error(`MCP request ${method} timed out.`))),
				this.#timeoutMs,
			);
			this.#pending.set(id, {
				resolve: (value) => finish(() => resolve(value)),
				reject: (error) => finish(() => reject(error)),
			});
			signal?.addEventListener("abort", abort, { once: true });
			if (signal?.aborted) {
				abort();
				return;
			}
			void this.#post({ jsonrpc: "2.0", id, method, params }, signal).catch((error) => {
				finish(() => reject(error));
			});
		});
	}

	#notify(method: string, params: unknown, signal?: AbortSignal): Promise<void> {
		return this.#post({ jsonrpc: "2.0", method, params }, signal);
	}

	async #post(message: unknown, signal?: AbortSignal): Promise<void> {
		const endpoint = await this.#endpoint.promise;
		const timeout = AbortSignal.timeout(this.#timeoutMs);
		const requestSignal =
			signal === undefined
				? AbortSignal.any([this.#controller.signal, timeout])
				: AbortSignal.any([this.#controller.signal, timeout, signal]);
		const response = await fetch(endpoint, {
			method: "POST",
			headers: { ...this.#headers, "content-type": "application/json" },
			body: JSON.stringify(message),
			signal: requestSignal,
			redirect: "manual",
		});
		if (!response.ok) {
			throw response.status >= 400 && response.status < 500
				? new McpDefinitiveResponseError(`MCP SSE message failed with status ${response.status}.`)
				: new Error(`MCP SSE message failed with status ${response.status}.`);
		}
	}

	async #readEvents(stream: ReadableStream<Uint8Array>): Promise<void> {
		const reader = stream.getReader();
		const cancelReader = () => reader.cancel();
		this.#cancelReader = cancelReader;
		const decoder = new TextDecoder();
		let buffered = "";
		let boundarySearchStart = 0;
		try {
			while (!this.#controller.signal.aborted) {
				const chunk = await reader.read();
				if (chunk.done) {
					throw new Error("MCP SSE stream closed.");
				}
				buffered += decoder.decode(chunk.value, { stream: true });
				if (Buffer.byteLength(buffered, "utf8") > maxMcpMessageBytes) {
					throw new Error("MCP SSE event exceeds the message limit.");
				}
				let boundary = findSseBoundary(buffered, boundarySearchStart);
				while (boundary !== undefined) {
					const event = buffered.slice(0, boundary.index);
					buffered = buffered.slice(boundary.index + boundary.length);
					this.#acceptEvent(event);
					boundarySearchStart = 0;
					boundary = findSseBoundary(buffered, boundarySearchStart);
				}
				boundarySearchStart = Math.max(0, buffered.length - 3);
			}
		} catch (error) {
			if (!this.#controller.signal.aborted) {
				await this.#cleanup(error);
			}
		} finally {
			if (this.#cancelReader === cancelReader) {
				this.#cancelReader = undefined;
			}
			reader.releaseLock();
		}
	}

	#acceptEvent(rawEvent: string): void {
		let eventName = "message";
		const data: string[] = [];
		for (const line of rawEvent.split(/\r\n|\n|\r/)) {
			if (line.startsWith("event:")) {
				eventName = line.slice("event:".length).trim();
			} else if (line.startsWith("data:")) {
				data.push(line.slice("data:".length).trimStart());
			}
		}
		const payload = data.join("\n");
		if (eventName === "endpoint") {
			const endpoint = new URL(payload, this.#streamUrl);
			const streamUrl = new URL(this.#streamUrl);
			if (
				endpoint.origin !== streamUrl.origin ||
				(endpoint.protocol !== "http:" && endpoint.protocol !== "https:")
			) {
				throw new Error("MCP SSE endpoint must use the configured origin.");
			}
			this.#endpoint.resolve(endpoint.toString());
			return;
		}
		if (payload.length === 0) {
			return;
		}
		const message: unknown = JSON.parse(payload);
		if (
			typeof message !== "object" ||
			message === null ||
			!("id" in message) ||
			typeof message.id !== "number"
		) {
			return;
		}
		const pending = this.#pending.get(message.id);
		if (pending === undefined) {
			return;
		}
		if ("error" in message) {
			pending.reject(new McpDefinitiveResponseError(readMcpError(message.error)));
		} else if ("result" in message) {
			pending.resolve(rpcJsonValueSchema.parse(message.result));
		} else {
			pending.reject(new Error("MCP SSE response is missing a result."));
		}
	}

	#rejectPending(error: unknown): void {
		for (const pending of this.#pending.values()) {
			pending.reject(error);
		}
		this.#pending.clear();
	}

	#cleanup(error: unknown): Promise<void> {
		if (this.#cleanupPromise !== undefined) {
			return this.#cleanupPromise;
		}
		this.#endpoint.reject(error);
		this.#rejectPending(error);
		const cancelReader = this.#cancelReader;
		this.#cancelReader = undefined;
		this.#cleanupPromise = (cancelReader === undefined ? Promise.resolve() : cancelReader())
			.catch((cancelError: unknown) => {
				console.error(
					cancelError instanceof Error
						? `MCP SSE stream cleanup failed: ${cancelError.message}`
						: "MCP SSE stream cleanup failed.",
				);
			})
			.finally(() => {
				this.#controller.abort(error);
				this.#closedSignal.resolve();
			});
		return this.#cleanupPromise;
	}
}

class HttpMcpConnection implements McpConnection {
	readonly tools: readonly McpToolDescriptor[];
	readonly #toolNameById: ReadonlyMap<string, string>;
	readonly #url: string;
	readonly #headers: Readonly<Record<string, string>>;
	readonly #timeoutMs: number;
	readonly #sessionId: string | undefined;
	#nextRequestId = 1;
	#closed = false;
	readonly #closedSignal = Promise.withResolvers<void>();
	#closePromise: Promise<void> | undefined;
	#sessionCleanupComplete = false;

	private constructor(input: {
		url: string;
		headers: Readonly<Record<string, string>>;
		timeoutMs: number;
		sessionId?: string;
		tools: readonly RemoteMcpTool[];
	}) {
		this.#url = input.url;
		this.#headers = input.headers;
		this.#timeoutMs = input.timeoutMs;
		this.#sessionId = input.sessionId;
		this.tools = input.tools.map(createToolDescriptor);
		this.#toolNameById = new Map(
			this.tools.map((descriptor, index) => [
				descriptor.stableToolId,
				input.tools[index]?.name ?? descriptor.name,
			]),
		);
	}

	get closed(): Promise<void> {
		return this.#closedSignal.promise;
	}

	static async connect(
		transport: Extract<McpTransportConfig, { type: "streamable-http" }>,
		secret: McpSecretInput | undefined,
		signal: AbortSignal | undefined,
	): Promise<HttpMcpConnection> {
		const headers = { ...(secret?.headers ?? {}) };
		let sessionId: string | undefined;
		try {
			const initialized = await postMcpHttp({
				url: transport.url,
				headers,
				timeoutMs: transport.timeoutMs,
				method: "initialize",
				params: {
					protocolVersion: mcpProtocolVersion,
					capabilities: {},
					clientInfo: { name: "moshu-runtime-box", version: "0.0.1" },
				},
				id: 1,
				onSessionId: (value) => {
					sessionId = value;
				},
				...(signal === undefined ? {} : { signal }),
			});
			sessionId = initialized.sessionId ?? sessionId;
			requireInitializeResult(initialized.result);
			await postMcpHttp({
				url: transport.url,
				headers,
				timeoutMs: transport.timeoutMs,
				method: "notifications/initialized",
				params: {},
				...(sessionId === undefined ? {} : { sessionId }),
				...(signal === undefined ? {} : { signal }),
			});
			let requestId = 2;
			const tools = await listAllTools(async (method, params, requestSignal) => {
				const response = await postMcpHttp({
					url: transport.url,
					headers,
					timeoutMs: transport.timeoutMs,
					method,
					params,
					id: requestId++,
					...(sessionId === undefined ? {} : { sessionId }),
					...(requestSignal === undefined ? {} : { signal: requestSignal }),
				});
				return response.result;
			}, signal);
			return new HttpMcpConnection({
				url: transport.url,
				headers,
				timeoutMs: transport.timeoutMs,
				...(sessionId === undefined ? {} : { sessionId }),
				tools,
			});
		} catch (error) {
			if (sessionId !== undefined) {
				try {
					await closeMcpHttpSession(transport.url, headers, transport.timeoutMs, sessionId);
				} catch (cleanupError) {
					throw new AggregateError(
						[error, cleanupError],
						"MCP HTTP initialization and session cleanup both failed.",
					);
				}
			}
			throw error;
		}
	}

	async callTool(
		stableToolId: string,
		argumentsValue: JsonValue,
		signal?: AbortSignal,
	): Promise<JsonValue> {
		if (this.#closed) {
			throw new Error("MCP HTTP connection is closed.");
		}
		const name = this.#toolNameById.get(stableToolId);
		if (name === undefined) {
			throw new Error("MCP Tool is not part of the live inventory.");
		}
		try {
			const response = await postMcpHttp({
				url: this.#url,
				headers: this.#headers,
				timeoutMs: this.#timeoutMs,
				method: "tools/call",
				params: { name, arguments: argumentsValue },
				id: this.#nextRequestId++,
				...(this.#sessionId === undefined ? {} : { sessionId: this.#sessionId }),
				...(signal === undefined ? {} : { signal }),
			});
			return response.result;
		} catch (error) {
			if (
				error instanceof McpHttpStatusError &&
				this.#sessionId !== undefined &&
				(error.status === 404 || error.status === 410)
			) {
				this.#closed = true;
				this.#closedSignal.resolve();
			}
			return rethrowMcpToolFailure(error);
		}
	}

	async close(): Promise<void> {
		this.#closed = true;
		if (this.#sessionCleanupComplete) {
			return;
		}
		if (this.#sessionId === undefined) {
			this.#sessionCleanupComplete = true;
			this.#closedSignal.resolve();
			return;
		}
		if (this.#closePromise !== undefined) {
			return this.#closePromise;
		}
		const cleanup = closeMcpHttpSession(
			this.#url,
			this.#headers,
			this.#timeoutMs,
			this.#sessionId,
		).then(
			() => {
				this.#sessionCleanupComplete = true;
				this.#closedSignal.resolve();
			},
			(error: unknown) => {
				this.#closePromise = undefined;
				throw error;
			},
		);
		this.#closePromise = cleanup;
		return cleanup;
	}
}

async function listAllTools(
	request: (method: string, params: unknown, signal?: AbortSignal) => Promise<JsonValue>,
	signal?: AbortSignal,
): Promise<RemoteMcpTool[]> {
	const tools: RemoteMcpTool[] = [];
	let cursor: string | undefined;
	for (let page = 0; page < 16; page += 1) {
		const result = await request("tools/list", cursor === undefined ? {} : { cursor }, signal);
		if (typeof result !== "object" || result === null || Array.isArray(result)) {
			throw new Error("MCP tools/list returned an invalid result.");
		}
		const rawTools = "tools" in result ? result.tools : undefined;
		if (!Array.isArray(rawTools) || rawTools.length > 256) {
			throw new Error("MCP tools/list returned an invalid tool list.");
		}
		for (const rawTool of rawTools) {
			tools.push(parseRemoteTool(rawTool));
			if (tools.length > 256) {
				throw new Error("MCP Server exposes too many tools.");
			}
		}
		const nextCursor = "nextCursor" in result ? result.nextCursor : undefined;
		if (nextCursor === undefined || nextCursor === null) {
			return tools;
		}
		if (typeof nextCursor !== "string" || nextCursor.length === 0 || nextCursor.length > 2_048) {
			throw new Error("MCP tools/list returned an invalid cursor.");
		}
		cursor = nextCursor;
	}
	throw new Error("MCP tools/list pagination exceeded the page limit.");
}

function parseRemoteTool(value: unknown): RemoteMcpTool {
	if (
		typeof value !== "object" ||
		value === null ||
		!("name" in value) ||
		typeof value.name !== "string" ||
		value.name.length === 0 ||
		value.name.length > 128 ||
		!("inputSchema" in value)
	) {
		throw new Error("MCP Server returned an invalid Tool descriptor.");
	}
	return {
		name: value.name,
		...("description" in value && typeof value.description === "string"
			? { description: value.description.slice(0, 2_048) }
			: {}),
		inputSchema: rpcJsonValueSchema.parse(value.inputSchema),
		...("outputSchema" in value
			? { outputSchema: rpcJsonValueSchema.parse(value.outputSchema) }
			: {}),
	};
}

function createToolDescriptor(tool: RemoteMcpTool): McpToolDescriptor {
	const schemaHash = createHash("sha256")
		.update(JSON.stringify([tool.inputSchema, tool.outputSchema ?? null]))
		.digest("hex");
	return mcpToolDescriptorSchema.parse({
		stableToolId: `tool-${createHash("sha256").update(tool.name).digest("hex").slice(0, 32)}`,
		name: tool.name,
		...(tool.description === undefined ? {} : { description: tool.description }),
		schemaHash,
		inputSchema: tool.inputSchema,
		...(tool.outputSchema === undefined ? {} : { outputSchema: tool.outputSchema }),
	});
}

function requireInitializeResult(value: JsonValue): void {
	if (
		typeof value !== "object" ||
		value === null ||
		Array.isArray(value) ||
		!("protocolVersion" in value) ||
		typeof value.protocolVersion !== "string"
	) {
		throw new Error("MCP initialize returned an invalid result.");
	}
}

function createMinimalMcpEnvironment(
	secret: Readonly<Record<string, string>> | undefined,
): Record<string, string> {
	const environment: Record<string, string> = {};
	for (const key of ["PATH", "HOME", "TMPDIR", "TEMP", "TMP", "SystemRoot", "ComSpec"] as const) {
		const value = process.env[key];
		if (value !== undefined) {
			environment[key] = value;
		}
	}
	Object.assign(environment, secret);
	return environment;
}

async function closeMcpHttpSession(
	url: string,
	headers: Readonly<Record<string, string>>,
	timeoutMs: number,
	sessionId: string,
): Promise<void> {
	const response = await fetch(url, {
		method: "DELETE",
		headers: {
			...headers,
			"mcp-session-id": sessionId,
		},
		signal: AbortSignal.timeout(timeoutMs),
		redirect: "manual",
	});
	if (
		!response.ok &&
		response.status !== 404 &&
		response.status !== 405 &&
		response.status !== 410
	) {
		throw new Error(`MCP HTTP session close failed with status ${response.status}.`);
	}
}

async function postMcpHttp(input: {
	url: string;
	headers: Readonly<Record<string, string>>;
	timeoutMs: number;
	method: string;
	params: unknown;
	id?: number;
	sessionId?: string;
	signal?: AbortSignal;
	onSessionId?: (sessionId: string) => void;
}): Promise<{ result: JsonValue; sessionId?: string }> {
	const timeout = AbortSignal.timeout(input.timeoutMs);
	const signal = input.signal === undefined ? timeout : AbortSignal.any([input.signal, timeout]);
	const response = await fetch(input.url, {
		method: "POST",
		headers: {
			...input.headers,
			"content-type": "application/json",
			accept: "application/json, text/event-stream",
			...(input.sessionId === undefined ? {} : { "mcp-session-id": input.sessionId }),
		},
		body: JSON.stringify({
			jsonrpc: "2.0",
			...(input.id === undefined ? {} : { id: input.id }),
			method: input.method,
			params: input.params,
		}),
		signal,
		redirect: "manual",
	});
	const responseSessionId = response.headers.get("mcp-session-id");
	if (responseSessionId !== null) {
		input.onSessionId?.(responseSessionId);
	}
	if (!response.ok) {
		throw response.status >= 400 && response.status < 500
			? new McpHttpStatusError(response.status)
			: new Error(`MCP HTTP request failed with status ${response.status}.`);
	}
	if (input.id === undefined) {
		return {
			result: null,
			...(responseSessionId === null ? {} : { sessionId: responseSessionId }),
		};
	}
	const contentType = response.headers.get("content-type") ?? "";
	const declaredLength = Number(response.headers.get("content-length") ?? "0");
	if (Number.isFinite(declaredLength) && declaredLength > maxMcpMessageBytes) {
		throw new Error("MCP HTTP response exceeds the message limit.");
	}
	const raw = contentType.includes("text/event-stream")
		? await readMatchingSseResponse(response, input.id)
		: await readBoundedJsonResponse(response);
	if (typeof raw !== "object" || raw === null) {
		throw new Error("MCP HTTP response is invalid.");
	}
	if (!("id" in raw) || raw.id !== input.id) {
		throw new Error("MCP HTTP response ID does not match the request.");
	}
	if ("error" in raw) {
		throw new McpDefinitiveResponseError(readMcpError(raw.error));
	}
	if (!("result" in raw)) {
		throw new Error("MCP HTTP response is missing a result.");
	}
	const sessionId = responseSessionId ?? input.sessionId;
	return {
		result: rpcJsonValueSchema.parse(raw.result),
		...(sessionId === undefined ? {} : { sessionId }),
	};
}

async function readBoundedJsonResponse(response: Response): Promise<unknown> {
	if (response.body === null) {
		throw new Error("MCP HTTP response body is missing.");
	}
	const reader = response.body.getReader();
	const chunks: Uint8Array[] = [];
	let totalBytes = 0;
	try {
		while (true) {
			const chunk = await reader.read();
			if (chunk.done) {
				break;
			}
			totalBytes += chunk.value.byteLength;
			if (totalBytes > maxMcpMessageBytes) {
				throw new Error("MCP HTTP response exceeds the message limit.");
			}
			chunks.push(chunk.value);
		}
		return JSON.parse(
			new TextDecoder("utf-8", { fatal: true }).decode(concatBytes(chunks, totalBytes)),
		);
	} finally {
		await reader.cancel().catch(() => undefined);
		reader.releaseLock();
	}
}

async function readMatchingSseResponse(response: Response, expectedId: number): Promise<unknown> {
	if (response.body === null) {
		throw new Error("MCP HTTP event stream body is missing.");
	}
	const reader = response.body.getReader();
	const decoder = new TextDecoder("utf-8", { fatal: true });
	let buffered = "";
	let totalBytes = 0;
	let boundarySearchStart = 0;
	try {
		while (true) {
			const chunk = await reader.read();
			if (chunk.done) {
				throw new Error("MCP HTTP event stream ended before the matching response.");
			}
			totalBytes += chunk.value.byteLength;
			if (totalBytes > maxMcpMessageBytes) {
				throw new Error("MCP HTTP event stream exceeds the message limit.");
			}
			buffered += decoder.decode(chunk.value, { stream: true });
			let boundary = findSseBoundary(buffered, boundarySearchStart);
			while (boundary !== undefined) {
				const rawEvent = buffered.slice(0, boundary.index);
				buffered = buffered.slice(boundary.index + boundary.length);
				const data = rawEvent
					.split(/\r\n|\n|\r/)
					.filter((line) => line.startsWith("data:"))
					.map((line) => line.slice("data:".length).trimStart())
					.join("\n");
				if (data.length > 0) {
					const candidate: unknown = JSON.parse(data);
					if (
						typeof candidate === "object" &&
						candidate !== null &&
						"id" in candidate &&
						candidate.id === expectedId
					) {
						return candidate;
					}
				}
				boundarySearchStart = 0;
				boundary = findSseBoundary(buffered, boundarySearchStart);
			}
			boundarySearchStart = Math.max(0, buffered.length - 3);
		}
	} finally {
		await reader.cancel().catch(() => undefined);
		reader.releaseLock();
	}
}

function concatBytes(chunks: readonly Uint8Array[], totalBytes: number): Uint8Array {
	const combined = new Uint8Array(totalBytes);
	let offset = 0;
	for (const chunk of chunks) {
		combined.set(chunk, offset);
		offset += chunk.byteLength;
	}
	return combined;
}

function findSseBoundary(
	value: string,
	startIndex = 0,
): { index: number; length: number } | undefined {
	let previousStart = -1;
	let previousEnd = -1;
	for (let index = startIndex; index < value.length; ) {
		const character = value[index];
		if (character !== "\r" && character !== "\n") {
			previousStart = -1;
			previousEnd = -1;
			index += 1;
			continue;
		}
		const lineEndingLength = character === "\r" && value[index + 1] === "\n" ? 2 : 1;
		if (previousEnd === index) {
			return {
				index: previousStart,
				length: index + lineEndingLength - previousStart,
			};
		}
		previousStart = index;
		previousEnd = index + lineEndingLength;
		index += lineEndingLength;
	}
	return undefined;
}

function readMcpError(value: unknown): string {
	if (
		typeof value === "object" &&
		value !== null &&
		"message" in value &&
		typeof value.message === "string"
	) {
		return value.message.slice(0, 1_024);
	}

	return "MCP Server returned an error.";
}

function rethrowMcpToolFailure(error: unknown): never {
	if (error instanceof McpDefinitiveResponseError || error instanceof McpToolOutcomeUnknownError) {
		throw error;
	}
	throw new McpToolOutcomeUnknownError(
		error instanceof Error ? error.message : "MCP Tool outcome is unknown.",
		{ cause: error },
	);
}

async function terminateProcess(process: ChildProcessWithoutNullStreams): Promise<void> {
	const rootExited = process.exitCode !== null || process.signalCode !== null;
	const closed = rootExited
		? Promise.resolve()
		: new Promise<void>((resolve) => {
				process.once("close", () => resolve());
			});
	if (!rootExited) {
		try {
			process.stdin.end();
		} catch {
			// The process may already have closed stdin.
		}
	}
	await terminateExecutorProcess(process);
	await Promise.race([closed, Bun.sleep(1_000)]);
}
