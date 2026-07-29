import {
	runtimeBoxToolInvokeInputSchema,
	runtimeBoxToolInvokeOutputSchema,
	executorToolRpcTimeoutMs,
	productRpcMethods,
	type ExecutorToolInvokeInput,
	type ExecutorToolInvokeOutput,
	type ExecutorToolName,
	type ExecutorToolProgressEvent,
	type RuntimeBoxConnectionInfo,
	type RuntimeBoxDescriptor,
	type RuntimeBoxInvocationEvidence,
	type ReconcileRuntimeBoxInvocationsOutput,
	acknowledgeRuntimeBoxInvocationsOutputSchema,
	runtimeBoxDescriptorSchema,
	type ValidateRuntimeBoxProjectPathInput,
	type ValidateRuntimeBoxProjectPathOutput,
	validateRuntimeBoxProjectPathInputSchema,
	validateRuntimeBoxProjectPathOutputSchema,
} from "@moshu/contracts";
import {
	type RpcPeer,
	type RpcPeerIdentity,
	RpcRemoteError,
	RpcRequestLimitError,
	rpcJsonValueSchema,
} from "@moshu/process-rpc";

export interface RuntimeBoxInvocationOptions {
	signal?: AbortSignal;
	onProgress?: (event: ExecutorToolProgressEvent) => void;
}

export type RuntimeBoxGatewayPeer = Pick<
	RpcPeer,
	"close" | "isClosed" | "remoteIdentity" | "request"
>;

export interface RuntimeBoxRegistryOptions {
	descriptors?: readonly RuntimeBoxDescriptor[];
	activeRuntimeBoxId?: string;
	onRegister?: (descriptor: RuntimeBoxDescriptor) => void;
	isDeviceKeyActive?: (runtimeBoxId: string, deviceKeyId: string) => boolean;
	onChange?: () => void;
	actionAuthorizer?: RuntimeBoxActionAuthorizer;
	reportDiagnostic?: (message: string) => void;
}

export interface RuntimeBoxActionAuthorizer {
	authorize(
		runtimeBoxId: string,
		input: ExecutorToolInvokeInput,
		targetIdentity: RpcPeerIdentity,
		executionScope: "request-cwd" | "runtime-box-workspace",
	): ExecutorToolInvokeInput | Promise<ExecutorToolInvokeInput>;
	complete(
		runtimeBoxId: string,
		input: ExecutorToolInvokeInput,
		result: ExecutorToolInvokeOutput,
	): void;
	fail(input: ExecutorToolInvokeInput, safeError: string): void;
	cancel(input: ExecutorToolInvokeInput, safeError: string): void;
	cancelUndispatched(input: ExecutorToolInvokeInput, safeError: string): void;
	markOutcomeUnknown(input: ExecutorToolInvokeInput, safeError: string): void;
	reconcile(
		runtimeBoxId: string,
		items: readonly RuntimeBoxInvocationEvidence[],
		acknowledgedInvocationIds: readonly string[],
	): ReconcileRuntimeBoxInvocationsOutput;
	markServerAcked(invocationIds: readonly string[]): void;
	markReceiptConfirmed(invocationIds: readonly string[]): void;
}

interface RuntimeBoxEntry {
	descriptor: RuntimeBoxDescriptor;
	peer: RuntimeBoxGatewayPeer | null;
	identity: RpcPeerIdentity | null;
	ready: boolean;
}

interface ActiveInvocation {
	readonly runtimeBoxId: string;
	readonly peer: RuntimeBoxGatewayPeer;
	readonly controller: AbortController;
	readonly onProgress: ((event: ExecutorToolProgressEvent) => void) | undefined;
	readonly tool: ExecutorToolName;
	nextSequence: number;
	failure: Error | undefined;
}

export class RuntimeBoxUnavailableError extends Error {
	constructor(message = "The selected Runtime Box is not connected and registered.") {
		super(message);
		this.name = "RuntimeBoxUnavailableError";
	}
}

export class RuntimeBoxInvocationError extends Error {
	constructor(message: string, options?: ErrorOptions) {
		super(message, options);
		this.name = "RuntimeBoxInvocationError";
	}
}

export class RuntimeBoxRegistry {
	readonly #entries = new Map<string, RuntimeBoxEntry>();
	readonly #runtimeBoxIdByPeer = new Map<RuntimeBoxGatewayPeer, string>();
	readonly #activeInvocations = new Map<string, ActiveInvocation>();
	readonly #onRegister: ((descriptor: RuntimeBoxDescriptor) => void) | undefined;
	readonly #isDeviceKeyActive: ((runtimeBoxId: string, deviceKeyId: string) => boolean) | undefined;
	readonly #onChange: (() => void) | undefined;
	readonly #actionAuthorizer: RuntimeBoxActionAuthorizer | undefined;
	readonly #reportDiagnostic: (message: string) => void;
	#activeRuntimeBoxId: string | undefined;

	constructor(options: RuntimeBoxRegistryOptions = {}) {
		this.#onRegister = options.onRegister;
		this.#isDeviceKeyActive = options.isDeviceKeyActive;
		this.#onChange = options.onChange;
		this.#actionAuthorizer = options.actionAuthorizer;
		this.#reportDiagnostic = options.reportDiagnostic ?? (() => undefined);
		for (const descriptorValue of options.descriptors ?? []) {
			const descriptor = runtimeBoxDescriptorSchema.parse(descriptorValue);
			this.#entries.set(descriptor.runtimeBoxId, {
				descriptor,
				peer: null,
				identity: null,
				ready: false,
			});
			this.#onChange?.();
		}

		if (options.activeRuntimeBoxId !== undefined) {
			this.setActiveRuntimeBoxId(options.activeRuntimeBoxId);
		} else {
			this.#activeRuntimeBoxId = [...this.#entries.values()].find(
				(entry) => entry.descriptor.kind === "local",
			)?.descriptor.runtimeBoxId;
		}
	}

	addDescriptor(descriptorValue: RuntimeBoxDescriptor): void {
		const descriptor = runtimeBoxDescriptorSchema.parse(descriptorValue);
		const existing = this.#entries.get(descriptor.runtimeBoxId);
		this.#entries.set(descriptor.runtimeBoxId, {
			descriptor,
			peer: existing?.peer ?? null,
			identity: existing?.identity ?? null,
			ready: existing?.ready ?? false,
		});
		this.#onChange?.();
	}

	register(peer: RuntimeBoxGatewayPeer, descriptorValue: RuntimeBoxDescriptor): void {
		if (peer.remoteIdentity.role !== "runtime-box") {
			throw new Error("Only an authenticated Runtime Box can register.");
		}
		const descriptor = runtimeBoxDescriptorSchema.parse(descriptorValue);
		if (descriptor.runtimeBoxId !== peer.remoteIdentity.peerId) {
			throw new Error("Runtime Box identity did not match the authenticated peer.");
		}
		if (descriptor.kind === "remote") {
			const deviceKeyId = peer.remoteIdentity.deviceKeyId;
			if (
				deviceKeyId === undefined ||
				this.#isDeviceKeyActive?.(descriptor.runtimeBoxId, deviceKeyId) !== true
			) {
				throw new Error("Runtime Box device key is not active.");
			}
		}
		const existingPeerRuntimeBoxId = this.#runtimeBoxIdByPeer.get(peer);
		if (
			existingPeerRuntimeBoxId !== undefined &&
			existingPeerRuntimeBoxId !== descriptor.runtimeBoxId
		) {
			throw new Error("A Runtime Box connection cannot register multiple stable identities.");
		}
		this.#onRegister?.(descriptor);

		const existing = this.#entries.get(descriptor.runtimeBoxId);
		if (existing?.peer !== null && existing?.peer !== undefined && existing.peer !== peer) {
			this.#runtimeBoxIdByPeer.delete(existing.peer);
			this.#failInvocationsForPeer(
				existing.peer,
				new RuntimeBoxUnavailableError("The registered Runtime Box connection was replaced."),
			);
		}
		this.#entries.set(descriptor.runtimeBoxId, {
			descriptor,
			peer,
			identity: peer.remoteIdentity,
			ready: false,
		});
		this.#runtimeBoxIdByPeer.set(peer, descriptor.runtimeBoxId);
		if (descriptor.kind === "local" && this.#activeRuntimeBoxId === undefined) {
			this.#activeRuntimeBoxId = descriptor.runtimeBoxId;
		}
		this.#onChange?.();
	}

	clear(peer: RuntimeBoxGatewayPeer): void {
		const runtimeBoxId = this.#runtimeBoxIdByPeer.get(peer);
		if (runtimeBoxId === undefined) {
			return;
		}
		this.#runtimeBoxIdByPeer.delete(peer);
		const entry = this.#entries.get(runtimeBoxId);
		if (entry?.peer !== peer) {
			return;
		}
		entry.peer = null;
		entry.identity = null;
		entry.ready = false;
		this.#failInvocationsForPeer(
			peer,
			new RuntimeBoxUnavailableError("The Runtime Box disconnected during tool execution."),
		);
		this.#onChange?.();
	}

	isReady(runtimeBoxId = this.#activeRuntimeBoxId): boolean {
		if (runtimeBoxId === undefined) {
			return false;
		}
		const peer = this.#entries.get(runtimeBoxId)?.peer;
		return (
			peer !== null &&
			peer !== undefined &&
			!peer.isClosed &&
			this.#entries.get(runtimeBoxId)?.ready === true
		);
	}

	getActiveRuntimeBoxId(): string | undefined {
		return this.#activeRuntimeBoxId;
	}

	setActiveRuntimeBoxId(runtimeBoxId: string): void {
		if (!this.#entries.has(runtimeBoxId)) {
			throw new RuntimeBoxUnavailableError(`Runtime Box ${runtimeBoxId} is not registered.`);
		}
		this.#activeRuntimeBoxId = runtimeBoxId;
		this.#onChange?.();
	}

	disconnectRuntimeBox(runtimeBoxId: string, reason: string): void {
		const peer = this.#entries.get(runtimeBoxId)?.peer;
		if (peer !== null && peer !== undefined && !peer.isClosed) {
			peer.close(1008, reason);
		}
		this.#onChange?.();
	}

	markReady(peer: RuntimeBoxGatewayPeer): void {
		const runtimeBoxId = this.#runtimeBoxIdByPeer.get(peer);
		const entry = runtimeBoxId === undefined ? undefined : this.#entries.get(runtimeBoxId);
		if (entry?.peer !== peer || peer.isClosed) {
			throw new RuntimeBoxUnavailableError("Runtime Box connection is not registered.");
		}
		entry.ready = true;
		this.#onChange?.();
	}

	listInfo(): RuntimeBoxConnectionInfo[] {
		return [...this.#entries.values()]
			.map((entry) => {
				const connected = entry.peer !== null && !entry.peer.isClosed;
				return {
					runtimeBox: entry.descriptor,
					connected,
					registered: connected && entry.ready,
					deviceKeyIds: [],
					...(connected && entry.identity !== null
						? {
								instanceId: entry.identity.instanceId,
								generation: entry.identity.generation,
							}
						: {}),
				};
			})
			.sort((left, right) =>
				left.runtimeBox.runtimeBoxId.localeCompare(right.runtimeBox.runtimeBoxId),
			);
	}

	invoke(
		inputValue: ExecutorToolInvokeInput,
		options: RuntimeBoxInvocationOptions = {},
	): Promise<ExecutorToolInvokeOutput> {
		const runtimeBoxId = this.#activeRuntimeBoxId;
		if (runtimeBoxId === undefined) {
			return Promise.reject(new RuntimeBoxUnavailableError());
		}
		return this.invokeForRuntimeBox(runtimeBoxId, inputValue, options);
	}

	async invokeForRuntimeBox(
		runtimeBoxId: string,
		inputValue: ExecutorToolInvokeInput,
		options: RuntimeBoxInvocationOptions = {},
	): Promise<ExecutorToolInvokeOutput> {
		const input = runtimeBoxToolInvokeInputSchema.parse(inputValue);
		if (options.signal?.aborted) {
			throw abortReason(options.signal);
		}
		if (input.authorization !== undefined) {
			throw new RuntimeBoxInvocationError("Tool authorization is owned by Agent Server.");
		}
		const peer = this.#entries.get(runtimeBoxId)?.peer;
		if (
			peer === null ||
			peer === undefined ||
			peer.isClosed ||
			this.#entries.get(runtimeBoxId)?.ready !== true
		) {
			throw new RuntimeBoxUnavailableError(`Runtime Box ${runtimeBoxId} is not available.`);
		}
		if (this.#activeInvocations.has(input.invocationId)) {
			throw new RuntimeBoxInvocationError(
				`Runtime Box invocation ${input.invocationId} is already active.`,
			);
		}
		const controller = new AbortController();
		const authorizedInput =
			this.#actionAuthorizer === undefined
				? input
				: await this.#actionAuthorizer.authorize(
						runtimeBoxId,
						input,
						peer.remoteIdentity,
						this.#entries.get(runtimeBoxId)?.descriptor.kind === "remote"
							? "runtime-box-workspace"
							: "request-cwd",
					);
		if (options.signal?.aborted) {
			this.#actionAuthorizer?.cancelUndispatched(
				authorizedInput,
				"Action caller cancelled before dispatch.",
			);
			throw abortReason(options.signal);
		}
		if (
			this.#entries.get(runtimeBoxId)?.peer !== peer ||
			this.#entries.get(runtimeBoxId)?.ready !== true ||
			peer.isClosed
		) {
			this.#actionAuthorizer?.cancelUndispatched(
				authorizedInput,
				"Runtime Box left ready state before Action dispatch.",
			);
			throw new RuntimeBoxUnavailableError(
				`Runtime Box ${runtimeBoxId} is not ready for Action dispatch.`,
			);
		}
		const active: ActiveInvocation = {
			runtimeBoxId,
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
			const payload = rpcJsonValueSchema.parse(authorizedInput);
			const rawOutput = await peer.request(productRpcMethods.runtimeBoxToolInvoke, payload, {
				signal: combinedSignal.signal,
				timeoutMs: executorToolRpcTimeoutMs,
			});
			if (active.failure) {
				throw active.failure;
			}
			const output = runtimeBoxToolInvokeOutputSchema.parse(rawOutput);
			if (output.invocationId !== input.invocationId || output.tool !== input.call.tool) {
				throw new RuntimeBoxInvocationError(
					"Runtime Box returned a result for a different tool invocation.",
				);
			}
			this.#actionAuthorizer?.complete(runtimeBoxId, authorizedInput, output);
			if (authorizedInput.authorization !== undefined) {
				this.#actionAuthorizer?.markServerAcked([input.invocationId]);
				try {
					const acknowledgement = await peer.request(
						productRpcMethods.runtimeBoxInvocationsAck,
						rpcJsonValueSchema.parse({ invocationIds: [input.invocationId] }),
					);
					const parsed = acknowledgeRuntimeBoxInvocationsOutputSchema.parse(acknowledgement);
					this.#actionAuthorizer?.markReceiptConfirmed(parsed.ackedInvocationIds);
				} catch (error) {
					this.#reportDiagnostic(
						`Runtime Box acknowledgement deferred to reconciliation: ${
							error instanceof Error ? error.message : "unknown failure"
						}`,
					);
				}
			}
			return output;
		} catch (error) {
			if (active.failure) {
				this.#actionAuthorizer?.markOutcomeUnknown(
					authorizedInput,
					"The Runtime Box connection was replaced during execution.",
				);
				throw active.failure;
			}
			if (this.#entries.get(runtimeBoxId)?.peer !== peer || peer.isClosed) {
				this.#actionAuthorizer?.markOutcomeUnknown(
					authorizedInput,
					"The Runtime Box disconnected before the Action outcome was confirmed.",
				);
				throw new RuntimeBoxUnavailableError(
					`Runtime Box ${runtimeBoxId} disconnected during tool execution.`,
				);
			}
			if (
				error instanceof RpcRequestLimitError ||
				(error instanceof RpcRemoteError &&
					[
						"INVALID_RUNTIME_BOX_TOOL_REQUEST",
						"RUNTIME_BOX_EXECUTION_GRANT_REJECTED",
						"RUNTIME_BOX_INVOCATION_JOURNAL_PREPARE_FAILED",
					].includes(error.code))
			) {
				this.#actionAuthorizer?.cancelUndispatched(
					authorizedInput,
					"The Runtime Box rejected the Action before execution began.",
				);
				throw error;
			}
			this.#actionAuthorizer?.markOutcomeUnknown(
				authorizedInput,
				combinedSignal.signal.aborted
					? "The Action was cancelled locally before Box evidence was reconciled."
					: `The Action RPC ended without validated Box evidence: ${
							error instanceof Error ? error.message : "unknown failure"
						}`,
			);
			throw error;
		} finally {
			combinedSignal.dispose();
			if (this.#activeInvocations.get(input.invocationId) === active) {
				this.#activeInvocations.delete(input.invocationId);
			}
		}
	}

	reconcileInvocations(
		runtimeBoxId: string,
		items: readonly RuntimeBoxInvocationEvidence[],
		acknowledgedInvocationIds: readonly string[],
	): ReconcileRuntimeBoxInvocationsOutput {
		if (this.#actionAuthorizer === undefined) {
			throw new RuntimeBoxInvocationError("Action reconciliation is unavailable.");
		}
		return this.#actionAuthorizer.reconcile(runtimeBoxId, items, acknowledgedInvocationIds);
	}

	async validateProjectPath(
		runtimeBoxId: string,
		inputValue: ValidateRuntimeBoxProjectPathInput,
		signal?: AbortSignal,
	): Promise<ValidateRuntimeBoxProjectPathOutput> {
		const input = validateRuntimeBoxProjectPathInputSchema.parse(inputValue);
		const peer = this.#entries.get(runtimeBoxId)?.peer;
		if (peer === null || peer === undefined || peer.isClosed) {
			throw new RuntimeBoxUnavailableError(`Runtime Box ${runtimeBoxId} is not available.`);
		}
		const rawOutput = await peer.request(
			productRpcMethods.runtimeBoxProjectValidatePath,
			rpcJsonValueSchema.parse(input),
			{ timeoutMs: 30_000, ...(signal === undefined ? {} : { signal }) },
		);
		if (this.#entries.get(runtimeBoxId)?.peer !== peer || peer.isClosed) {
			throw new RuntimeBoxUnavailableError(
				`Runtime Box ${runtimeBoxId} disconnected during Project path validation.`,
			);
		}
		return validateRuntimeBoxProjectPathOutputSchema.parse(rawOutput);
	}

	handleProgress(peer: RuntimeBoxGatewayPeer, event: ExecutorToolProgressEvent): boolean {
		const active = this.#activeInvocations.get(event.invocationId);
		const registeredRuntimeBoxId = this.#runtimeBoxIdByPeer.get(peer);
		if (
			active === undefined ||
			active.peer !== peer ||
			registeredRuntimeBoxId !== active.runtimeBoxId ||
			this.#entries.get(active.runtimeBoxId)?.peer !== peer
		) {
			return false;
		}
		if (event.sequence !== active.nextSequence) {
			this.#failInvocation(
				active,
				new RuntimeBoxInvocationError(
					`Runtime Box progress sequence mismatch for ${event.invocationId}: expected ${active.nextSequence}, received ${event.sequence}.`,
				),
			);
			return false;
		}
		if (active.tool !== event.tool) {
			this.#failInvocation(
				active,
				new RuntimeBoxInvocationError(
					`Runtime Box emitted ${event.tool} progress for an active ${active.tool} invocation.`,
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
				new RuntimeBoxInvocationError("Runtime Box progress consumer failed.", {
					cause: error,
				}),
			);
			return false;
		}
	}

	#failInvocation(active: ActiveInvocation, error: Error): void {
		if (active.failure === undefined) {
			active.failure = error;
			active.controller.abort(error);
		}
	}

	#failInvocationsForPeer(peer: RuntimeBoxGatewayPeer, error: Error): void {
		for (const active of this.#activeInvocations.values()) {
			if (active.peer === peer) {
				this.#failInvocation(active, error);
			}
		}
	}
}

function abortReason(signal: AbortSignal): Error {
	return signal.reason instanceof Error ? signal.reason : new Error("Action caller cancelled.");
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
