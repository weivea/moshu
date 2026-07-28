import {
	executorToolInvokeInputSchema,
	executorToolInvokeOutputSchema,
	executorToolRpcTimeoutMs,
	productRpcMethods,
	type ExecutorToolInvokeInput,
	type ExecutorToolInvokeOutput,
	type ExecutorToolName,
	type ExecutorToolProgressEvent,
} from "@moshu/contracts";
import { type RpcPeer, type RpcPeerIdentity, rpcJsonValueSchema } from "@moshu/process-rpc";

export interface ExecutorInvocationOptions {
	signal?: AbortSignal;
	onProgress?: (event: ExecutorToolProgressEvent) => void;
}

export type ExecutorGatewayPeer = Pick<RpcPeer, "isClosed" | "remoteIdentity" | "request">;

interface ActiveInvocation {
	readonly peer: ExecutorGatewayPeer;
	readonly controller: AbortController;
	readonly onProgress: ((event: ExecutorToolProgressEvent) => void) | undefined;
	readonly tool: ExecutorToolName;
	nextSequence: number;
	failure: Error | undefined;
}

export class ExecutorUnavailableError extends Error {
	constructor(message = "The local executor is not connected and registered.") {
		super(message);
		this.name = "ExecutorUnavailableError";
	}
}

export class ExecutorInvocationError extends Error {
	constructor(message: string, options?: ErrorOptions) {
		super(message, options);
		this.name = "ExecutorInvocationError";
	}
}

export class ExecutorReadiness {
	#peer: ExecutorGatewayPeer | null = null;
	#identity: RpcPeerIdentity | null = null;
	readonly #activeInvocations = new Map<string, ActiveInvocation>();

	register(peer: ExecutorGatewayPeer): void {
		if (peer.remoteIdentity.role !== "executor") {
			throw new Error("Only an authenticated executor can register readiness.");
		}
		if (this.#peer !== null && this.#peer !== peer) {
			this.#failInvocationsForPeer(
				this.#peer,
				new ExecutorUnavailableError("The registered executor connection was replaced."),
			);
		}
		this.#peer = peer;
		this.#identity = peer.remoteIdentity;
	}

	clear(peer: ExecutorGatewayPeer): void {
		if (this.#peer === peer) {
			this.#peer = null;
			this.#identity = null;
			this.#failInvocationsForPeer(
				peer,
				new ExecutorUnavailableError("The executor disconnected during tool execution."),
			);
		}
	}

	isReady(): boolean {
		return this.#peer !== null && !this.#peer.isClosed;
	}

	async invoke(
		inputValue: ExecutorToolInvokeInput,
		options: ExecutorInvocationOptions = {},
	): Promise<ExecutorToolInvokeOutput> {
		const input = executorToolInvokeInputSchema.parse(inputValue);
		const peer = this.#peer;
		if (peer === null || peer.isClosed) {
			throw new ExecutorUnavailableError();
		}
		if (this.#activeInvocations.has(input.invocationId)) {
			throw new ExecutorInvocationError(
				`Executor invocation ${input.invocationId} is already active.`,
			);
		}
		const controller = new AbortController();
		const active: ActiveInvocation = {
			peer,
			controller,
			onProgress: options.onProgress,
			tool: input.call.tool,
			nextSequence: 0,
			failure: undefined,
		};
		this.#activeInvocations.set(input.invocationId, active);
		const combinedSignal = combineAbortSignals(options.signal, controller.signal);
		try {
			const payload = rpcJsonValueSchema.parse(input);
			const rawOutput = await peer.request(productRpcMethods.executorToolInvoke, payload, {
				signal: combinedSignal.signal,
				timeoutMs: executorToolRpcTimeoutMs,
			});
			if (active.failure) {
				throw active.failure;
			}
			const output = executorToolInvokeOutputSchema.parse(rawOutput);
			if (output.invocationId !== input.invocationId || output.tool !== input.call.tool) {
				throw new ExecutorInvocationError(
					"Executor returned a result for a different tool invocation.",
				);
			}
			return output;
		} catch (error) {
			if (active.failure) {
				throw active.failure;
			}
			if (this.#peer !== peer || peer.isClosed) {
				throw new ExecutorUnavailableError("The executor disconnected during tool execution.");
			}
			throw error;
		} finally {
			combinedSignal.dispose();
			if (this.#activeInvocations.get(input.invocationId) === active) {
				this.#activeInvocations.delete(input.invocationId);
			}
		}
	}

	handleProgress(peer: ExecutorGatewayPeer, event: ExecutorToolProgressEvent): boolean {
		const active = this.#activeInvocations.get(event.invocationId);
		if (active === undefined || active.peer !== peer || this.#peer !== peer) {
			return false;
		}
		if (event.sequence !== active.nextSequence) {
			this.#failInvocation(
				active,
				new ExecutorInvocationError(
					`Executor progress sequence mismatch for ${event.invocationId}: expected ${active.nextSequence}, received ${event.sequence}.`,
				),
			);
			return false;
		}
		if (active.tool !== event.tool) {
			this.#failInvocation(
				active,
				new ExecutorInvocationError(
					`Executor emitted ${event.tool} progress for an active ${active.tool} invocation.`,
				),
			);
			return false;
		}
		active.nextSequence += 1;
		try {
			active.onProgress?.(event);
			return true;
		} catch (error) {
			this.#failInvocation(
				active,
				new ExecutorInvocationError("Executor progress consumer failed.", {
					cause: error,
				}),
			);
			return false;
		}
	}

	getInfo(): {
		connected: boolean;
		registered: boolean;
		peerId?: string;
		instanceId?: string;
		generation?: number;
	} {
		if (this.#identity === null || !this.isReady()) {
			return { connected: false, registered: false };
		}
		return {
			connected: true,
			registered: true,
			peerId: this.#identity.peerId,
			instanceId: this.#identity.instanceId,
			generation: this.#identity.generation,
		};
	}

	#failInvocation(active: ActiveInvocation, error: Error): void {
		if (active.failure === undefined) {
			active.failure = error;
			active.controller.abort(error);
		}
	}

	#failInvocationsForPeer(peer: ExecutorGatewayPeer, error: Error): void {
		for (const active of this.#activeInvocations.values()) {
			if (active.peer === peer) {
				this.#failInvocation(active, error);
			}
		}
	}
}

function combineAbortSignals(
	external: AbortSignal | undefined,
	internal: AbortSignal,
): { signal: AbortSignal; dispose: () => void } {
	if (external === undefined) {
		return { signal: internal, dispose: () => undefined };
	}
	const controller = new AbortController();
	const forwardExternal = (): void => controller.abort(external.reason);
	const forwardInternal = (): void => controller.abort(internal.reason);
	external.addEventListener("abort", forwardExternal, { once: true });
	internal.addEventListener("abort", forwardInternal, { once: true });
	if (external.aborted) {
		forwardExternal();
	} else if (internal.aborted) {
		forwardInternal();
	}
	return {
		signal: controller.signal,
		dispose: () => {
			external.removeEventListener("abort", forwardExternal);
			internal.removeEventListener("abort", forwardInternal);
		},
	};
}
