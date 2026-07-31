import {
	acknowledgeRuntimeBoxInvocationsOutputSchema,
	currentRuntimeBoxProtocolVersion,
	type DeleteRuntimeBoxMcpServerInput,
	type DeleteRuntimeBoxSkillInput,
	deleteRuntimeBoxMcpServerInputSchema,
	deleteRuntimeBoxSkillInputSchema,
	type ExecutorExecutionContext,
	type ExecutorToolInvokeInput,
	type ExecutorToolInvokeOutput,
	type ExecutorToolName,
	type ExecutorToolProgressEvent,
	executorToolRpcTimeoutMs,
	type GetRuntimeBoxSkillContentInput,
	type GetRuntimeBoxSkillContentOutput,
	getRuntimeBoxSkillContentInputSchema,
	getRuntimeBoxSkillContentOutputSchema,
	type InstallRuntimeBoxSkillInput,
	installRuntimeBoxSkillInputSchema,
	listRuntimeBoxMcpServersInputSchema,
	listRuntimeBoxMcpServersOutputSchema,
	listRuntimeBoxSkillsInputSchema,
	listRuntimeBoxSkillsOutputSchema,
	maxRuntimeBoxInventoryPayloadBytes,
	maxRuntimeBoxInventoryResources,
	productRpcMethods,
	type ReadRuntimeBoxProjectRootAgentsInput,
	type ReadRuntimeBoxProjectRootAgentsOutput,
	type ReconcileRuntimeBoxInvocationsOutput,
	type RuntimeBoxConnectionInfo,
	type RuntimeBoxDescriptor,
	type RuntimeBoxInventoryChange,
	type RuntimeBoxInventoryChangedHint,
	type RuntimeBoxInvocationEvidence,
	type RuntimeBoxMcpServer,
	type RuntimeBoxMcpToolInvokeInput,
	type RuntimeBoxMcpToolInvokeOutput,
	type RuntimeBoxResourceMutationResult,
	type RuntimeBoxSkill,
	type RuntimeBoxTransportSecurity,
	readRuntimeBoxProjectRootAgentsInputSchema,
	readRuntimeBoxProjectRootAgentsOutputSchema,
	runtimeBoxDescriptorSchema,
	runtimeBoxInventoryChangedHintSchema,
	runtimeBoxInventoryChangesPageSchema,
	runtimeBoxInventorySnapshotSchema,
	runtimeBoxMcpToolInvokeInputSchema,
	runtimeBoxMcpToolInvokeOutputSchema,
	runtimeBoxProtocolVersionSchema,
	runtimeBoxResourceMutationResultSchema,
	runtimeBoxToolInvokeInputSchema,
	runtimeBoxToolInvokeOutputSchema,
	type SetRuntimeBoxMcpServerEnabledInput,
	type SetRuntimeBoxSkillEnabledInput,
	setRuntimeBoxMcpServerEnabledInputSchema,
	setRuntimeBoxSkillEnabledInputSchema,
	type UpsertRuntimeBoxMcpServerInput,
	upsertRuntimeBoxMcpServerInputSchema,
	type ValidateRuntimeBoxProjectPathInput,
	type ValidateRuntimeBoxProjectPathOutput,
	type ValidateRuntimeBoxResourcesInput,
	type ValidateRuntimeBoxResourcesOutput,
	validateRuntimeBoxProjectPathInputSchema,
	validateRuntimeBoxProjectPathOutputSchema,
	validateRuntimeBoxResourcesInputSchema,
	validateRuntimeBoxResourcesOutputSchema,
} from "@moshu/contracts";
import type { RuntimeBoxInventoryRepository } from "@moshu/database";
import {
	type JsonValue,
	RpcCancelledError,
	RpcConnectionClosedError,
	type RpcPeer,
	type RpcPeerIdentity,
	RpcRemoteError,
	RpcRequestLimitError,
	RpcTimeoutError,
	rpcJsonValueSchema,
} from "@moshu/process-rpc";

export interface RuntimeBoxInvocationOptions {
	signal?: AbortSignal;
	onProgress?: (event: ExecutorToolProgressEvent) => void;
	executionContext?: ExecutorExecutionContext;
}

export type RuntimeBoxGatewayPeer = Pick<
	RpcPeer,
	"close" | "isClosed" | "remoteIdentity" | "request"
>;

export interface RuntimeBoxRegistryOptions {
	descriptors?: readonly RuntimeBoxDescriptor[];
	compatibilities?: readonly {
		runtimeBoxId: string;
		state: "upgrade_required";
		generation: number;
		protocolVersion: number;
	}[];
	activeRuntimeBoxId?: string;
	onRegister?: (descriptor: RuntimeBoxDescriptor) => void;
	isDeviceKeyActive?: (runtimeBoxId: string, deviceKeyId: string) => boolean;
	onChange?: () => void;
	actionAuthorizer?: RuntimeBoxActionAuthorizer;
	reportDiagnostic?: (message: string) => void;
	inventoryRepository?: RuntimeBoxInventoryRepository;
	inventoryPollIntervalMs?: number;
	inventoryRandom?: () => number;
}

export interface RuntimeBoxActionAuthorizer {
	authorize(
		runtimeBoxId: string,
		input: ExecutorToolInvokeInput,
		targetIdentity: RpcPeerIdentity,
		executionContext: ExecutorExecutionContext,
		options?: { signal?: AbortSignal },
	): ExecutorToolInvokeInput | Promise<ExecutorToolInvokeInput>;
	authorizeMcp?(
		runtimeBoxId: string,
		input: RuntimeBoxMcpToolInvokeInput,
		targetIdentity: RpcPeerIdentity,
		options?: { signal?: AbortSignal },
	): RuntimeBoxMcpToolInvokeInput | Promise<RuntimeBoxMcpToolInvokeInput>;
	complete(
		runtimeBoxId: string,
		input: ExecutorToolInvokeInput | RuntimeBoxMcpToolInvokeInput,
		result: ExecutorToolInvokeOutput | RuntimeBoxMcpToolInvokeOutput,
	): void;
	fail(input: ExecutorToolInvokeInput | RuntimeBoxMcpToolInvokeInput, safeError: string): void;
	cancel(input: ExecutorToolInvokeInput | RuntimeBoxMcpToolInvokeInput, safeError: string): void;
	cancelUndispatched(
		input: ExecutorToolInvokeInput | RuntimeBoxMcpToolInvokeInput,
		safeError: string,
	): void;
	markOutcomeUnknown(
		input: ExecutorToolInvokeInput | RuntimeBoxMcpToolInvokeInput,
		safeError: string,
	): void;
	reconcile(
		runtimeBoxId: string,
		items: readonly RuntimeBoxInvocationEvidence[],
		acknowledgedInvocationIds: readonly string[],
	): ReconcileRuntimeBoxInvocationsOutput;
	markServerAcked(invocationIds: readonly string[]): void;
	markReceiptConfirmed(runtimeBoxId: string, invocationIds: readonly string[]): void;
}

interface RuntimeBoxEntry {
	descriptor: RuntimeBoxDescriptor;
	peer: RuntimeBoxGatewayPeer | null;
	identity: RpcPeerIdentity | null;
	ready: boolean;
	inventorySynced: boolean;
	inventorySyncTail: Promise<void>;
	inventoryTimer: ReturnType<typeof setTimeout> | undefined;
	pendingInventoryHint: RuntimeBoxInventoryChangedHint | undefined;
	compatibility: "compatible" | "unknown" | "upgrade_required";
	protocolVersion: number | undefined;
	transportSecurity: RuntimeBoxTransportSecurity | undefined;
}

interface ActiveInvocation {
	readonly runtimeBoxId: string;
	readonly peer: RuntimeBoxGatewayPeer;
	readonly controller: AbortController;
	readonly onProgress: ((event: ExecutorToolProgressEvent) => void) | undefined;
	readonly tool: ExecutorToolName | "mcp";
	nextSequence: number;
	failure: Error | undefined;
}

interface ActiveProjectRequest {
	readonly peer: RuntimeBoxGatewayPeer;
	readonly controller: AbortController;
	failure: RuntimeBoxUnavailableError | undefined;
}

class InventoryResyncRequested extends Error {
	constructor() {
		super("Runtime Box inventory requires a full snapshot.");
		this.name = "InventoryResyncRequested";
	}
}

export class RuntimeBoxUnavailableError extends Error {
	constructor(message = "The selected Runtime Box is not connected and registered.") {
		super(message);
		this.name = "RuntimeBoxUnavailableError";
	}
}

export class RuntimeBoxCapabilityError extends Error {
	constructor(
		readonly runtimeBoxId: string,
		readonly capability: string,
	) {
		super(`Runtime Box ${runtimeBoxId} does not support ${capability}.`);
		this.name = "RuntimeBoxCapabilityError";
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
	readonly #activeProjectRequests = new Set<ActiveProjectRequest>();
	readonly #onRegister: ((descriptor: RuntimeBoxDescriptor) => void) | undefined;
	readonly #isDeviceKeyActive: ((runtimeBoxId: string, deviceKeyId: string) => boolean) | undefined;
	readonly #onChange: (() => void) | undefined;
	readonly #actionAuthorizer: RuntimeBoxActionAuthorizer | undefined;
	readonly #reportDiagnostic: (message: string) => void;
	readonly #inventoryRepository: RuntimeBoxInventoryRepository | undefined;
	readonly #inventoryPollIntervalMs: number;
	readonly #inventoryRandom: () => number;
	#activeRuntimeBoxId: string | undefined;

	constructor(options: RuntimeBoxRegistryOptions = {}) {
		this.#onRegister = options.onRegister;
		this.#isDeviceKeyActive = options.isDeviceKeyActive;
		this.#onChange = options.onChange;
		this.#actionAuthorizer = options.actionAuthorizer;
		this.#reportDiagnostic = options.reportDiagnostic ?? (() => undefined);
		this.#inventoryRepository = options.inventoryRepository;
		this.#inventoryPollIntervalMs = options.inventoryPollIntervalMs ?? 60_000;
		this.#inventoryRandom = options.inventoryRandom ?? Math.random;
		if (
			!Number.isSafeInteger(this.#inventoryPollIntervalMs) ||
			this.#inventoryPollIntervalMs < 10
		) {
			throw new TypeError("Runtime Box inventory poll interval must be at least 10 milliseconds.");
		}
		const compatibilityByRuntimeBoxId = new Map(
			(options.compatibilities ?? []).map((compatibility) => {
				if (!Number.isSafeInteger(compatibility.generation) || compatibility.generation < 0) {
					throw new TypeError("Runtime Box compatibility generation is invalid.");
				}
				runtimeBoxProtocolVersionSchema.parse(compatibility.protocolVersion);
				return [compatibility.runtimeBoxId, compatibility] as const;
			}),
		);
		for (const descriptorValue of options.descriptors ?? []) {
			const descriptor = runtimeBoxDescriptorSchema.parse(descriptorValue);
			const compatibility = compatibilityByRuntimeBoxId.get(descriptor.runtimeBoxId);
			this.#entries.set(descriptor.runtimeBoxId, {
				descriptor,
				peer: null,
				identity: null,
				ready: false,
				inventorySynced: false,
				inventorySyncTail: Promise.resolve(),
				inventoryTimer: undefined,
				pendingInventoryHint: undefined,
				compatibility: compatibility?.state ?? "unknown",
				protocolVersion: undefined,
				transportSecurity: undefined,
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
			inventorySynced: existing?.inventorySynced ?? false,
			inventorySyncTail: existing?.inventorySyncTail ?? Promise.resolve(),
			inventoryTimer: existing?.inventoryTimer,
			pendingInventoryHint: existing?.pendingInventoryHint,
			compatibility: existing?.compatibility ?? "unknown",
			protocolVersion: existing?.protocolVersion,
			transportSecurity: existing?.transportSecurity,
		});
		this.#onChange?.();
	}

	register(
		peer: RuntimeBoxGatewayPeer,
		descriptorValue: RuntimeBoxDescriptor,
		protocol: {
			protocolVersion: number;
			transportSecurity: RuntimeBoxTransportSecurity;
		} = {
			protocolVersion: currentRuntimeBoxProtocolVersion,
			transportSecurity: "relay-tls",
		},
	): void {
		if (peer.remoteIdentity.role !== "runtime-box") {
			throw new Error("Only an authenticated Runtime Box can register.");
		}
		const descriptor = runtimeBoxDescriptorSchema.parse(descriptorValue);
		const protocolVersion = runtimeBoxProtocolVersionSchema.parse(protocol.protocolVersion);
		if (protocolVersion !== currentRuntimeBoxProtocolVersion) {
			throw new RuntimeBoxUnavailableError("Runtime Box protocol version is incompatible.");
		}
		if (protocol.transportSecurity !== "relay-tls") {
			throw new RuntimeBoxUnavailableError(
				"Runtime Box transport security was not negotiated by this Agent Server.",
			);
		}
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
			this.#clearInventoryTimer(existing);
			this.#runtimeBoxIdByPeer.delete(existing.peer);
			this.#failInvocationsForPeer(
				existing.peer,
				new RuntimeBoxUnavailableError("The registered Runtime Box connection was replaced."),
			);
			this.#failProjectRequestsForPeer(
				existing.peer,
				new RuntimeBoxUnavailableError("The registered Runtime Box connection was replaced."),
			);
		}
		this.#entries.set(descriptor.runtimeBoxId, {
			descriptor,
			peer,
			identity: peer.remoteIdentity,
			ready: false,
			inventorySynced: this.#inventoryRepository === undefined,
			inventorySyncTail: Promise.resolve(),
			inventoryTimer: undefined,
			pendingInventoryHint: undefined,
			compatibility: "compatible",
			protocolVersion,
			transportSecurity: protocol.transportSecurity,
		});
		this.#inventoryRepository?.markStale(descriptor.runtimeBoxId);
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
		entry.inventorySynced = false;
		entry.pendingInventoryHint = undefined;
		this.#clearInventoryTimer(entry);
		this.#inventoryRepository?.markStale(runtimeBoxId);
		this.#failInvocationsForPeer(
			peer,
			new RuntimeBoxUnavailableError("The Runtime Box disconnected during tool execution."),
		);
		this.#failProjectRequestsForPeer(
			peer,
			new RuntimeBoxUnavailableError("The Runtime Box disconnected during Project inspection."),
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
			this.#failProjectRequestsForPeer(
				peer,
				new RuntimeBoxUnavailableError("The Runtime Box was disconnected."),
			);
			peer.close(1008, reason);
		}
		this.#onChange?.();
	}

	markUpgradeRequired(runtimeBoxId: string): void {
		const entry = this.#entries.get(runtimeBoxId);
		if (entry === undefined) {
			return;
		}
		if (entry.peer !== null && !entry.peer.isClosed) {
			entry.peer.close(1008, "A newer Runtime Box generation requires a protocol upgrade.");
			this.#failInvocationsForPeer(
				entry.peer,
				new RuntimeBoxUnavailableError("Runtime Box protocol upgrade is required."),
			);
			this.#failProjectRequestsForPeer(
				entry.peer,
				new RuntimeBoxUnavailableError("Runtime Box protocol upgrade is required."),
			);
		}
		entry.compatibility = "upgrade_required";
		entry.protocolVersion = undefined;
		entry.transportSecurity = undefined;
		entry.ready = false;
		entry.inventorySynced = false;
		this.#inventoryRepository?.markStale(runtimeBoxId);
		this.#onChange?.();
	}

	markReady(peer: RuntimeBoxGatewayPeer): void {
		const runtimeBoxId = this.#runtimeBoxIdByPeer.get(peer);
		const entry = runtimeBoxId === undefined ? undefined : this.#entries.get(runtimeBoxId);
		if (entry?.peer !== peer || peer.isClosed) {
			throw new RuntimeBoxUnavailableError("Runtime Box connection is not registered.");
		}
		if (!entry.inventorySynced) {
			throw new RuntimeBoxUnavailableError("Runtime Box inventory has not completed initial sync.");
		}
		entry.ready = true;
		this.#onChange?.();
	}

	async synchronizeInventory(peer: RuntimeBoxGatewayPeer): Promise<void> {
		const runtimeBoxId = this.#runtimeBoxIdByPeer.get(peer);
		const entry = runtimeBoxId === undefined ? undefined : this.#entries.get(runtimeBoxId);
		if (entry?.peer !== peer || peer.isClosed) {
			throw new RuntimeBoxUnavailableError("Runtime Box connection is not registered.");
		}
		if (this.#inventoryRepository === undefined) {
			entry.inventorySynced = true;
			return;
		}
		await this.#enqueueInventorySync(entry, async () => {
			const rawSnapshot = await peer.request(
				productRpcMethods.runtimeBoxInventoryGetSnapshot,
				{},
				{ timeoutMs: 30_000 },
			);
			const snapshot = runtimeBoxInventorySnapshotSchema.parse(rawSnapshot);
			if (
				snapshot.runtimeBoxId !== runtimeBoxId ||
				snapshot.runtimeBoxGeneration !== peer.remoteIdentity.generation
			) {
				throw new RuntimeBoxInvocationError(
					"Runtime Box inventory snapshot identity does not match the connection.",
				);
			}
			if (this.#entries.get(runtimeBoxId)?.peer !== peer || peer.isClosed) {
				throw new RuntimeBoxUnavailableError(
					`Runtime Box ${runtimeBoxId} disconnected during inventory sync.`,
				);
			}
			this.#inventoryRepository?.replaceSnapshot(snapshot);
			entry.inventorySynced = true;
			entry.pendingInventoryHint = undefined;
			this.#scheduleInventoryPoll(entry);
			this.#onChange?.();
		});
	}

	handleInventoryChanged(
		peer: RuntimeBoxGatewayPeer,
		hintValue: RuntimeBoxInventoryChangedHint,
	): boolean {
		const runtimeBoxId = this.#runtimeBoxIdByPeer.get(peer);
		const entry = runtimeBoxId === undefined ? undefined : this.#entries.get(runtimeBoxId);
		if (entry?.peer !== peer || peer.isClosed || !entry.inventorySynced) {
			return false;
		}
		const hint = runtimeBoxInventoryChangedHintSchema.parse(hintValue);
		const pending = entry.pendingInventoryHint;
		entry.pendingInventoryHint =
			pending === undefined ||
			pending.inventoryEpoch !== hint.inventoryEpoch ||
			pending.inventoryRevision <= hint.inventoryRevision
				? hint
				: pending;
		if (entry.inventoryTimer !== undefined) {
			clearTimeout(entry.inventoryTimer);
		}
		entry.inventoryTimer = setTimeout(() => {
			entry.inventoryTimer = undefined;
			const target = entry.pendingInventoryHint;
			entry.pendingInventoryHint = undefined;
			void this.#reconcileInventory(entry, target).finally(() => {
				if (this.#entries.get(entry.descriptor.runtimeBoxId)?.peer === peer) {
					this.#scheduleInventoryPoll(entry);
				}
			});
		}, 100);
		return true;
	}

	getInventory(runtimeBoxId: string) {
		if (this.#inventoryRepository === undefined) {
			throw new RuntimeBoxInvocationError("Runtime Box inventory cache is unavailable.");
		}
		return this.#inventoryRepository.list(runtimeBoxId);
	}

	async listMcpServers(
		runtimeBoxId: string,
		signal?: AbortSignal,
	): Promise<{ runtimeBoxId: string; items: RuntimeBoxMcpServer[] }> {
		const peer = this.#requireReadyPeer(runtimeBoxId);
		const raw = await peer.request(
			productRpcMethods.runtimeBoxMcpServersList,
			rpcJsonValueSchema.parse(listRuntimeBoxMcpServersInputSchema.parse({ runtimeBoxId })),
			{ timeoutMs: 30_000, ...(signal === undefined ? {} : { signal }) },
		);
		const output = listRuntimeBoxMcpServersOutputSchema.parse(raw);
		if (output.runtimeBoxId !== runtimeBoxId || this.#entries.get(runtimeBoxId)?.peer !== peer) {
			throw new RuntimeBoxUnavailableError("Runtime Box changed during MCP query.");
		}
		return output;
	}

	async upsertMcpServer(
		runtimeBoxId: string,
		inputValue: UpsertRuntimeBoxMcpServerInput,
		signal?: AbortSignal,
	): Promise<RuntimeBoxResourceMutationResult> {
		const input = upsertRuntimeBoxMcpServerInputSchema.parse({
			...inputValue,
			runtimeBoxId,
			stableResourceId: inputValue.stableResourceId ?? `mcp-${inputValue.commandId}`,
		});
		return this.#mutateResource(
			runtimeBoxId,
			productRpcMethods.runtimeBoxMcpServersUpsert,
			input,
			"mcp",
			signal,
		);
	}

	async setMcpServerEnabled(
		runtimeBoxId: string,
		inputValue: SetRuntimeBoxMcpServerEnabledInput,
		signal?: AbortSignal,
	): Promise<RuntimeBoxResourceMutationResult> {
		const input = setRuntimeBoxMcpServerEnabledInputSchema.parse({
			...inputValue,
			runtimeBoxId,
		});
		return this.#mutateResource(
			runtimeBoxId,
			productRpcMethods.runtimeBoxMcpServersSetEnabled,
			input,
			"mcp",
			signal,
		);
	}

	async deleteMcpServer(
		runtimeBoxId: string,
		inputValue: DeleteRuntimeBoxMcpServerInput,
		signal?: AbortSignal,
	): Promise<RuntimeBoxResourceMutationResult> {
		const input = deleteRuntimeBoxMcpServerInputSchema.parse({
			...inputValue,
			runtimeBoxId,
		});
		return this.#mutateResource(
			runtimeBoxId,
			productRpcMethods.runtimeBoxMcpServersDelete,
			input,
			"mcp",
			signal,
		);
	}

	async listSkills(
		runtimeBoxId: string,
		signal?: AbortSignal,
	): Promise<{ runtimeBoxId: string; items: RuntimeBoxSkill[] }> {
		const peer = this.#requireReadyPeer(runtimeBoxId);
		const raw = await peer.request(
			productRpcMethods.runtimeBoxSkillsList,
			rpcJsonValueSchema.parse(listRuntimeBoxSkillsInputSchema.parse({ runtimeBoxId })),
			{ timeoutMs: 30_000, ...(signal === undefined ? {} : { signal }) },
		);
		const output = listRuntimeBoxSkillsOutputSchema.parse(raw);
		if (output.runtimeBoxId !== runtimeBoxId || this.#entries.get(runtimeBoxId)?.peer !== peer) {
			throw new RuntimeBoxUnavailableError("Runtime Box changed during Skill query.");
		}

		return output;
	}

	requireCapability(runtimeBoxId: string, capability: string): void {
		const entry = this.#entries.get(runtimeBoxId);
		if (entry === undefined || !entry.descriptor.capabilities.includes(capability)) {
			throw new RuntimeBoxCapabilityError(runtimeBoxId, capability);
		}
	}

	async installSkill(
		runtimeBoxId: string,
		inputValue: InstallRuntimeBoxSkillInput,
		signal?: AbortSignal,
	): Promise<RuntimeBoxResourceMutationResult> {
		const input = installRuntimeBoxSkillInputSchema.parse({
			...inputValue,
			runtimeBoxId,
			stableResourceId: inputValue.stableResourceId ?? `skill-${inputValue.commandId}`,
		});
		return this.#mutateResource(
			runtimeBoxId,
			productRpcMethods.runtimeBoxSkillsInstall,
			input,
			"skill",
			signal,
		);
	}

	async setSkillEnabled(
		runtimeBoxId: string,
		inputValue: SetRuntimeBoxSkillEnabledInput,
		signal?: AbortSignal,
	): Promise<RuntimeBoxResourceMutationResult> {
		const input = setRuntimeBoxSkillEnabledInputSchema.parse({
			...inputValue,
			runtimeBoxId,
		});
		return this.#mutateResource(
			runtimeBoxId,
			productRpcMethods.runtimeBoxSkillsSetEnabled,
			input,
			"skill",
			signal,
		);
	}

	async deleteSkill(
		runtimeBoxId: string,
		inputValue: DeleteRuntimeBoxSkillInput,
		signal?: AbortSignal,
	): Promise<RuntimeBoxResourceMutationResult> {
		const input = deleteRuntimeBoxSkillInputSchema.parse({
			...inputValue,
			runtimeBoxId,
		});
		return this.#mutateResource(
			runtimeBoxId,
			productRpcMethods.runtimeBoxSkillsDelete,
			input,
			"skill",
			signal,
		);
	}

	async validateResources(
		runtimeBoxId: string,
		inputValue: ValidateRuntimeBoxResourcesInput,
		signal?: AbortSignal,
	): Promise<ValidateRuntimeBoxResourcesOutput> {
		const input = validateRuntimeBoxResourcesInputSchema.parse(inputValue);
		const peer = this.#requireReadyPeer(runtimeBoxId);
		const raw = await peer.request(
			productRpcMethods.runtimeBoxResourcesValidate,
			rpcJsonValueSchema.parse(input),
			{ timeoutMs: 30_000, ...(signal === undefined ? {} : { signal }) },
		);
		if (this.#entries.get(runtimeBoxId)?.peer !== peer || peer.isClosed) {
			throw new RuntimeBoxUnavailableError("Runtime Box disconnected during resource validation.");
		}
		return validateRuntimeBoxResourcesOutputSchema.parse(raw);
	}

	async getSkillContent(
		runtimeBoxId: string,
		inputValue: GetRuntimeBoxSkillContentInput,
		signal?: AbortSignal,
	): Promise<GetRuntimeBoxSkillContentOutput> {
		const input = getRuntimeBoxSkillContentInputSchema.parse(inputValue);
		const peer = this.#requireReadyPeer(runtimeBoxId);
		const raw = await peer.request(
			productRpcMethods.runtimeBoxSkillGetContent,
			rpcJsonValueSchema.parse(input),
			{ timeoutMs: 30_000, ...(signal === undefined ? {} : { signal }) },
		);
		if (this.#entries.get(runtimeBoxId)?.peer !== peer || peer.isClosed) {
			throw new RuntimeBoxUnavailableError("Runtime Box disconnected during Skill fetch.");
		}
		const output = getRuntimeBoxSkillContentOutputSchema.parse(raw);
		if (output.ref.runtimeBoxId !== runtimeBoxId) {
			throw new RuntimeBoxInvocationError("Runtime Box returned Skill content for another Box.");
		}
		return output;
	}

	async shutdown(): Promise<void> {
		for (const entry of this.#entries.values()) {
			this.#clearInventoryTimer(entry);
		}
		await Promise.allSettled([...this.#entries.values()].map((entry) => entry.inventorySyncTail));
	}

	listInfo(): RuntimeBoxConnectionInfo[] {
		return [...this.#entries.values()]
			.map((entry) => {
				const connected = entry.peer !== null && !entry.peer.isClosed;
				return {
					runtimeBox: entry.descriptor,
					connected,
					registered: connected && entry.ready,
					state:
						entry.compatibility === "upgrade_required"
							? ("upgrade_required" as const)
							: connected
								? entry.ready
									? ("online" as const)
									: ("syncing" as const)
								: ("offline" as const),
					compatibility: entry.compatibility,
					...(entry.protocolVersion === undefined
						? {}
						: { negotiatedProtocolVersion: entry.protocolVersion }),
					...(entry.transportSecurity === undefined
						? {}
						: { transportSecurity: entry.transportSecurity }),
					...(entry.compatibility === "upgrade_required"
						? {
								requiredProtocolMinVersion: currentRuntimeBoxProtocolVersion,
								requiredProtocolMaxVersion: currentRuntimeBoxProtocolVersion,
							}
						: {}),
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
						options.executionContext ??
							(this.#entries.get(runtimeBoxId)?.descriptor.kind === "remote"
								? { executionScope: "runtime-box-workspace" }
								: { executionScope: "request-cwd" }),
						options.signal === undefined ? {} : { signal: options.signal },
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
					if (
						parsed.ackedInvocationIds.length !== 1 ||
						parsed.ackedInvocationIds[0] !== input.invocationId
					) {
						throw new RuntimeBoxInvocationError(
							"Runtime Box acknowledged an invocation outside the request.",
						);
					}
					this.#actionAuthorizer?.markReceiptConfirmed(runtimeBoxId, parsed.ackedInvocationIds);
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
						"REQUEST_LIMIT_EXCEEDED",
						"RUNTIME_BOX_EXECUTION_GRANT_REJECTED",
						"RUNTIME_BOX_INVOCATION_JOURNAL_PREPARE_FAILED",
						"RUNTIME_BOX_WORKSPACE_VIOLATION",
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

	async invokeMcpForRuntimeBox(
		runtimeBoxId: string,
		inputValue: RuntimeBoxMcpToolInvokeInput,
		options: { signal?: AbortSignal } = {},
	): Promise<RuntimeBoxMcpToolInvokeOutput> {
		const input = runtimeBoxMcpToolInvokeInputSchema.parse(inputValue);
		if (options.signal?.aborted) {
			throw abortReason(options.signal);
		}
		if (input.authorization !== undefined) {
			throw new RuntimeBoxInvocationError("MCP Tool authorization is owned by Agent Server.");
		}
		const peer = this.#requireReadyPeer(runtimeBoxId);
		if (this.#activeInvocations.has(input.invocationId)) {
			throw new RuntimeBoxInvocationError(
				`Runtime Box invocation ${input.invocationId} is already active.`,
			);
		}
		if (this.#actionAuthorizer === undefined) {
			throw new RuntimeBoxInvocationError("MCP Tool authorization is unavailable.");
		}
		const authorizeMcp = this.#actionAuthorizer.authorizeMcp;
		if (authorizeMcp === undefined) {
			throw new RuntimeBoxInvocationError("MCP Tool authorization is unavailable.");
		}
		const authorizedInput = await authorizeMcp.call(
			this.#actionAuthorizer,
			runtimeBoxId,
			input,
			peer.remoteIdentity,
			options.signal === undefined ? {} : { signal: options.signal },
		);
		if (options.signal?.aborted) {
			this.#actionAuthorizer.cancelUndispatched(
				authorizedInput,
				"Action caller cancelled before dispatch.",
			);
			throw abortReason(options.signal);
		}
		if (this.#entries.get(runtimeBoxId)?.peer !== peer || peer.isClosed) {
			this.#actionAuthorizer.cancelUndispatched(
				authorizedInput,
				"Runtime Box left ready state before MCP Action dispatch.",
			);
			throw new RuntimeBoxUnavailableError(
				`Runtime Box ${runtimeBoxId} is not ready for MCP Action dispatch.`,
			);
		}
		const controller = new AbortController();
		const active: ActiveInvocation = {
			runtimeBoxId,
			peer,
			controller,
			onProgress: undefined,
			tool: "mcp",
			nextSequence: 0,
			failure: undefined,
		};
		this.#activeInvocations.set(input.invocationId, active);
		const combinedSignal = combineAbortSignals(options.signal, controller.signal);
		try {
			const raw = await peer.request(
				productRpcMethods.runtimeBoxMcpToolInvoke,
				rpcJsonValueSchema.parse(authorizedInput),
				{ signal: combinedSignal.signal, timeoutMs: executorToolRpcTimeoutMs },
			);
			if (active.failure) {
				throw active.failure;
			}
			const output = runtimeBoxMcpToolInvokeOutputSchema.parse(raw);
			if (
				output.invocationId !== input.invocationId ||
				output.mcpServerId !== input.mcpServerId ||
				output.stableToolId !== input.stableToolId
			) {
				throw new RuntimeBoxInvocationError(
					"Runtime Box returned a result for a different MCP Tool invocation.",
				);
			}
			if (output.isError) {
				this.#actionAuthorizer.fail(authorizedInput, extractMcpReportedError(output.result));
			} else {
				this.#actionAuthorizer.complete(runtimeBoxId, authorizedInput, output);
			}
			this.#actionAuthorizer.markServerAcked([input.invocationId]);
			try {
				const acknowledgement = await peer.request(
					productRpcMethods.runtimeBoxInvocationsAck,
					rpcJsonValueSchema.parse({ invocationIds: [input.invocationId] }),
				);
				const parsed = acknowledgeRuntimeBoxInvocationsOutputSchema.parse(acknowledgement);
				if (
					parsed.ackedInvocationIds.length !== 1 ||
					parsed.ackedInvocationIds[0] !== input.invocationId
				) {
					throw new RuntimeBoxInvocationError(
						"Runtime Box acknowledged an invocation outside the request.",
					);
				}
				this.#actionAuthorizer.markReceiptConfirmed(runtimeBoxId, parsed.ackedInvocationIds);
			} catch (error) {
				this.#reportDiagnostic(
					`Runtime Box MCP acknowledgement deferred to reconciliation: ${
						error instanceof Error ? error.message : "unknown failure"
					}`,
				);
			}
			if (output.isError) {
				throw new RuntimeBoxInvocationError(extractMcpReportedError(output.result));
			}
			return output;
		} catch (error) {
			if (active.failure || this.#entries.get(runtimeBoxId)?.peer !== peer || peer.isClosed) {
				this.#actionAuthorizer.markOutcomeUnknown(
					authorizedInput,
					"The Runtime Box disconnected before the MCP Action outcome was confirmed.",
				);
				throw (
					active.failure ??
					new RuntimeBoxUnavailableError(
						`Runtime Box ${runtimeBoxId} disconnected during MCP Tool execution.`,
					)
				);
			}
			if (
				error instanceof RpcRequestLimitError ||
				(error instanceof RpcRemoteError &&
					[
						"INVALID_RUNTIME_BOX_MCP_TOOL_REQUEST",
						"RUNTIME_BOX_EXECUTION_GRANT_REJECTED",
						"RUNTIME_BOX_INVOCATION_JOURNAL_PREPARE_FAILED",
						"RUNTIME_BOX_MCP_TOOL_NOT_READY",
					].includes(error.code))
			) {
				this.#actionAuthorizer.cancelUndispatched(
					authorizedInput,
					"The Runtime Box rejected the MCP Action before execution began.",
				);
				throw error;
			}
			this.#actionAuthorizer.markOutcomeUnknown(
				authorizedInput,
				combinedSignal.signal.aborted
					? "The MCP Action was cancelled before Box evidence was reconciled."
					: `The MCP Action RPC ended without validated Box evidence: ${
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
		const entry = this.#entries.get(runtimeBoxId);
		const peer = entry?.peer;
		if (peer === null || peer === undefined || peer.isClosed || entry?.ready !== true) {
			throw new RuntimeBoxUnavailableError(`Runtime Box ${runtimeBoxId} is not available.`);
		}
		const rawOutput = await this.#requestProjectData(
			runtimeBoxId,
			peer,
			productRpcMethods.runtimeBoxProjectValidatePath,
			rpcJsonValueSchema.parse(input),
			"Project path validation",
			signal,
		);
		return validateRuntimeBoxProjectPathOutputSchema.parse(rawOutput);
	}

	async readProjectRootAgents(
		runtimeBoxId: string,
		inputValue: ReadRuntimeBoxProjectRootAgentsInput,
		signal?: AbortSignal,
	): Promise<ReadRuntimeBoxProjectRootAgentsOutput> {
		const input = readRuntimeBoxProjectRootAgentsInputSchema.parse(inputValue);
		const entry = this.#entries.get(runtimeBoxId);
		const peer = entry?.peer;
		if (peer === null || peer === undefined || peer.isClosed || entry?.ready !== true) {
			throw new RuntimeBoxUnavailableError(`Runtime Box ${runtimeBoxId} is not available.`);
		}
		const rawOutput = await this.#requestProjectData(
			runtimeBoxId,
			peer,
			productRpcMethods.runtimeBoxProjectReadRootAgents,
			rpcJsonValueSchema.parse(input),
			"root AGENTS.md loading",
			signal,
		);
		return readRuntimeBoxProjectRootAgentsOutputSchema.parse(rawOutput);
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

	#requireReadyPeer(runtimeBoxId: string): RuntimeBoxGatewayPeer {
		const entry = this.#entries.get(runtimeBoxId);
		const peer = entry?.peer;
		if (
			peer === null ||
			peer === undefined ||
			peer.isClosed ||
			entry?.ready !== true ||
			entry?.inventorySynced !== true
		) {
			throw new RuntimeBoxUnavailableError(`Runtime Box ${runtimeBoxId} is not ready.`);
		}
		return peer;
	}

	async #requestProjectData(
		runtimeBoxId: string,
		peer: RuntimeBoxGatewayPeer,
		method: string,
		payload: JsonValue,
		operation: string,
		signal?: AbortSignal,
	): Promise<JsonValue> {
		const active: ActiveProjectRequest = {
			peer,
			controller: new AbortController(),
			failure: undefined,
		};
		this.#activeProjectRequests.add(active);
		const combinedSignal = combineAbortSignals(signal, active.controller.signal);
		try {
			const output = await peer.request(method, payload, {
				timeoutMs: 30_000,
				signal: combinedSignal.signal,
			});
			if (active.failure !== undefined) {
				throw active.failure;
			}
			if (this.#entries.get(runtimeBoxId)?.peer !== peer || peer.isClosed) {
				throw new RuntimeBoxUnavailableError(
					`Runtime Box ${runtimeBoxId} disconnected during ${operation}.`,
				);
			}
			return output;
		} catch (error) {
			if (signal?.aborted === true || error instanceof RpcTimeoutError) {
				throw error;
			}
			if (active.failure !== undefined) {
				throw active.failure;
			}
			if (error instanceof RpcCancelledError) {
				throw error;
			}
			if (
				error instanceof RpcConnectionClosedError ||
				peer.isClosed ||
				this.#entries.get(runtimeBoxId)?.peer !== peer
			) {
				throw new RuntimeBoxUnavailableError(
					`Runtime Box ${runtimeBoxId} disconnected during ${operation}.`,
				);
			}
			throw error;
		} finally {
			combinedSignal.dispose();
			this.#activeProjectRequests.delete(active);
		}
	}

	async #mutateResource(
		runtimeBoxId: string,
		method: string,
		input: unknown,
		expectedKind: "mcp" | "skill",
		signal?: AbortSignal,
	): Promise<RuntimeBoxResourceMutationResult> {
		const peer = this.#requireReadyPeer(runtimeBoxId);
		const raw = await peer.request(method, rpcJsonValueSchema.parse(input), {
			timeoutMs: 120_000,
			...(signal === undefined ? {} : { signal }),
		});
		if (this.#entries.get(runtimeBoxId)?.peer !== peer || peer.isClosed) {
			throw new RuntimeBoxUnavailableError("Runtime Box disconnected during resource mutation.");
		}
		const output = runtimeBoxResourceMutationResultSchema.parse(raw);
		if (
			!output.deleted &&
			(output.descriptor?.stableResourceId !== output.stableResourceId ||
				output.descriptor.resourceKind !== expectedKind)
		) {
			throw new RuntimeBoxInvocationError("Runtime Box returned an inconsistent mutation result.");
		}
		const entry = this.#entries.get(runtimeBoxId);
		if (entry?.peer === peer) {
			await this.#reconcileInventory(
				entry,
				runtimeBoxInventoryChangedHintSchema.parse({
					inventoryEpoch: output.inventoryEpoch,
					inventoryRevision: output.inventoryRevision,
					categories:
						output.descriptor?.resourceKind === "skill" ? ["skill"] : ["mcp", "mcp_tool_schema"],
				}),
			);
		}
		return output;
	}

	#enqueueInventorySync(entry: RuntimeBoxEntry, operation: () => Promise<void>): Promise<void> {
		const execution = entry.inventorySyncTail.then(operation, operation);
		entry.inventorySyncTail = execution.then(
			() => undefined,
			() => undefined,
		);
		return execution;
	}

	async #reconcileInventory(
		entry: RuntimeBoxEntry,
		targetHint?: RuntimeBoxInventoryChangedHint,
	): Promise<boolean> {
		const runtimeBoxId = entry.descriptor.runtimeBoxId;
		const expectedPeer = entry.peer;
		if (
			this.#inventoryRepository === undefined ||
			expectedPeer === null ||
			expectedPeer.isClosed ||
			this.#entries.get(runtimeBoxId) !== entry
		) {
			return false;
		}
		try {
			await this.#enqueueInventorySync(entry, async () => {
				this.#assertInventoryPeerCurrent(entry, expectedPeer);
				const state = this.#inventoryRepository?.getState(runtimeBoxId);
				if (
					state === undefined ||
					state.inventoryEpoch === undefined ||
					state.inventoryRevision === undefined ||
					(targetHint !== undefined && targetHint.inventoryEpoch !== state.inventoryEpoch)
				) {
					await this.#replaceInventorySnapshot(entry, expectedPeer);
					return;
				}
				try {
					let fromRevisionExclusive = state.inventoryRevision;
					for (let pass = 0; pass < 8; pass += 1) {
						let cursor: string | undefined;
						let pageCount = 0;
						const seenCursors = new Set<string>();
						let throughRevision: number | undefined;
						const changes: RuntimeBoxInventoryChange[] = [];
						do {
							pageCount += 1;
							if (pageCount > 64) {
								throw new InventoryResyncRequested();
							}
							const rawPage = await expectedPeer.request(
								productRpcMethods.runtimeBoxInventoryGetChanges,
								rpcJsonValueSchema.parse({
									inventoryEpoch: state.inventoryEpoch,
									fromRevisionExclusive,
									...(cursor === undefined ? {} : { cursor }),
								}),
								{ timeoutMs: 30_000 },
							);
							this.#assertInventoryPeerCurrent(entry, expectedPeer);
							const page = runtimeBoxInventoryChangesPageSchema.parse(rawPage);
							if (
								page.inventoryEpoch !== state.inventoryEpoch ||
								page.fromRevisionExclusive !== fromRevisionExclusive ||
								(throughRevision !== undefined && page.throughRevision !== throughRevision) ||
								fromRevisionExclusive < Math.max(0, page.oldestAvailableRevision - 1)
							) {
								throw new InventoryResyncRequested();
							}
							throughRevision = page.throughRevision;
							changes.push(...page.changes);
							if (
								changes.length > maxRuntimeBoxInventoryResources ||
								Buffer.byteLength(JSON.stringify(changes), "utf8") >
									maxRuntimeBoxInventoryPayloadBytes
							) {
								throw new InventoryResyncRequested();
							}
							const nextCursor = page.nextCursor;
							if (
								nextCursor !== undefined &&
								(page.changes.length === 0 || seenCursors.has(nextCursor))
							) {
								throw new InventoryResyncRequested();
							}
							if (nextCursor !== undefined) {
								seenCursors.add(nextCursor);
							}
							cursor = nextCursor;
						} while (cursor !== undefined);
						if (throughRevision === undefined) {
							throw new InventoryResyncRequested();
						}
						this.#assertInventoryPeerCurrent(entry, expectedPeer);
						this.#inventoryRepository?.applyChanges({
							runtimeBoxId,
							inventoryEpoch: state.inventoryEpoch,
							fromRevisionExclusive,
							throughRevision,
							changes,
						});
						fromRevisionExclusive = throughRevision;
						if (
							targetHint === undefined ||
							targetHint.inventoryEpoch !== state.inventoryEpoch ||
							fromRevisionExclusive >= targetHint.inventoryRevision
						) {
							return;
						}
					}
					throw new InventoryResyncRequested();
				} catch (error) {
					if (
						error instanceof InventoryResyncRequested ||
						(error instanceof RpcRemoteError && error.code === "INVENTORY_RESYNC_REQUIRED")
					) {
						await this.#replaceInventorySnapshot(entry, expectedPeer);
						return;
					}
					throw error;
				}
			});
			return true;
		} catch (error) {
			if (this.#entries.get(runtimeBoxId) === entry && entry.peer === expectedPeer) {
				this.#inventoryRepository.markStale(runtimeBoxId);
			}
			this.#reportDiagnostic(
				`Runtime Box inventory reconciliation failed for ${runtimeBoxId}: ${
					error instanceof Error ? error.message : "unknown failure"
				}`,
			);
			return false;
		}
	}

	async #replaceInventorySnapshot(
		entry: RuntimeBoxEntry,
		peer: RuntimeBoxGatewayPeer,
	): Promise<void> {
		const runtimeBoxId = entry.descriptor.runtimeBoxId;
		const rawSnapshot = await peer.request(
			productRpcMethods.runtimeBoxInventoryGetSnapshot,
			{},
			{ timeoutMs: 30_000 },
		);
		const snapshot = runtimeBoxInventorySnapshotSchema.parse(rawSnapshot);
		if (
			snapshot.runtimeBoxId !== runtimeBoxId ||
			snapshot.runtimeBoxGeneration !== peer.remoteIdentity.generation ||
			this.#entries.get(runtimeBoxId)?.peer !== peer ||
			peer.isClosed
		) {
			throw new RuntimeBoxUnavailableError(
				"Runtime Box inventory snapshot identity is no longer current.",
			);
		}
		this.#inventoryRepository?.replaceSnapshot(snapshot);
		entry.inventorySynced = true;
	}

	#scheduleInventoryPoll(entry: RuntimeBoxEntry): void {
		if (
			this.#entries.get(entry.descriptor.runtimeBoxId) !== entry ||
			entry.peer === null ||
			entry.peer.isClosed
		) {
			return;
		}
		this.#clearInventoryTimer(entry);
		const random = Math.max(0, Math.min(1, this.#inventoryRandom()));
		const delay = Math.round(this.#inventoryPollIntervalMs * (0.8 + random * 0.4));
		entry.inventoryTimer = setTimeout(() => {
			entry.inventoryTimer = undefined;
			void this.#reconcileInventory(entry).finally(() => {
				if (
					this.#entries.get(entry.descriptor.runtimeBoxId) === entry &&
					entry.peer !== null &&
					!entry.peer.isClosed
				) {
					this.#scheduleInventoryPoll(entry);
				}
			});
		}, delay);
	}

	#clearInventoryTimer(entry: RuntimeBoxEntry): void {
		if (entry.inventoryTimer !== undefined) {
			clearTimeout(entry.inventoryTimer);
			entry.inventoryTimer = undefined;
		}
	}

	#assertInventoryPeerCurrent(entry: RuntimeBoxEntry, peer: RuntimeBoxGatewayPeer): void {
		if (
			this.#entries.get(entry.descriptor.runtimeBoxId) !== entry ||
			entry.peer !== peer ||
			peer.isClosed
		) {
			throw new RuntimeBoxUnavailableError(
				"Runtime Box inventory synchronization peer is no longer current.",
			);
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

	#failProjectRequestsForPeer(
		peer: RuntimeBoxGatewayPeer,
		error: RuntimeBoxUnavailableError,
	): void {
		for (const active of this.#activeProjectRequests) {
			if (active.peer === peer && active.failure === undefined) {
				active.failure = error;
				active.controller.abort(error);
			}
		}
	}
}

function abortReason(signal: AbortSignal): Error {
	return signal.reason instanceof Error ? signal.reason : new Error("Action caller cancelled.");
}

function extractMcpReportedError(result: RuntimeBoxMcpToolInvokeOutput["result"]): string {
	if (
		typeof result === "object" &&
		result !== null &&
		!Array.isArray(result) &&
		"content" in result &&
		Array.isArray(result.content)
	) {
		const text = result.content
			.flatMap((block) =>
				typeof block === "object" &&
				block !== null &&
				"type" in block &&
				block.type === "text" &&
				"text" in block &&
				typeof block.text === "string"
					? [block.text]
					: [],
			)
			.join("\n")
			.trim();
		if (text.length > 0) {
			return text.slice(0, 1_024);
		}
	}
	return "MCP Tool returned an error.";
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
