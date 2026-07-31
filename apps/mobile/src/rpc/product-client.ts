import {
	type AgentsRuntimeInfo,
	type CancelChatRunInput,
	type CancelChatRunOutput,
	type ChatSendAcceptedOutput,
	chatSessionsRetiredEventSchema,
	type CreateChatSessionOutput,
	type CreateProcessChatSessionInput,
	type DecideApprovalInput,
	type DecideApprovalOutput,
	type GetApprovalOutput,
	type GetChatSessionPageInput,
	type GetChatSessionPageOutput,
	type GetProjectOutput,
	type GetProjectSidebarOutput,
	type GetSessionApprovalPolicyOutput,
	type ListApprovalsInput,
	type ListApprovalsOutput,
	type ListAvailableModelsOutput,
	type ListChatSessionsInput,
	type ListChatSessionsOutput,
	type ListProjectsOutput,
	type ListRuntimeBoxesOutput,
	mobileClientProductEventMethods,
	mobileClientProductRequestMethods,
	productRpcEvents,
	productRpcEventSchemas,
	productRpcMethods,
	productRpcRequestSchemas,
	type ReplayChatEventsInput,
	type ReplayChatEventsOutput,
	type SendAskChatMessageInput,
	type SwitchRuntimeBoxInput,
	type SwitchRuntimeBoxOutput,
	type UpdateSessionApprovalPolicyInput,
	type UpdateSessionApprovalPolicyOutput,
} from "@moshu/contracts";
import type { JsonValue, RpcHandlers, RpcMethodAllowlist, RpcPeer } from "@moshu/process-rpc-core";
import { MobileEventBus } from "./events";

const allowedRequestMethods = new Set<string>(mobileClientProductRequestMethods);

// Maps a wire event name to the Zod schema used to validate its payload before it reaches the bus.
// `chat.sessions.retired` is allowlisted for Mobile but not present in `productRpcEventSchemas`, so
// its schema is supplied explicitly.
const eventSchemasByWireName: Record<string, { parse(value: unknown): unknown }> = {
	...(productRpcEventSchemas as Record<string, { parse(value: unknown): unknown }>),
	[productRpcEvents.chatSessionsRetired]: chatSessionsRetiredEventSchema,
};

const eventNameByWire: Record<string, keyof MobileEventBusEventMapMarker> = {
	[productRpcEvents.chatEvent]: "chatEvent",
	[productRpcEvents.chatSessionsRetired]: "chatSessionsRetired",
	[productRpcEvents.runtimeBoxesChanged]: "runtimeBoxesChanged",
	[productRpcEvents.approvalEvent]: "approvalEvent",
	[productRpcEvents.sessionApprovalPolicyChanged]: "sessionApprovalPolicyChanged",
	[productRpcEvents.approvalActivityChanged]: "approvalActivityChanged",
};

// Purely a compile-time marker so the wire→name map stays exhaustive over the bus event names.
interface MobileEventBusEventMapMarker {
	chatEvent: unknown;
	chatSessionsRetired: unknown;
	runtimeBoxesChanged: unknown;
	approvalEvent: unknown;
	sessionApprovalPolicyChanged: unknown;
	approvalActivityChanged: unknown;
}

/**
 * The inbound-method allowlist installed on the {@link RpcPeer}. The remote peer is the Agent
 * Server (role "agents"); Mobile only ever accepts the allowlisted product *events* from it and no
 * inbound requests at all. This is defense-in-depth on top of the server-side allowlist.
 */
export const mobileInboundAllowlist: RpcMethodAllowlist = {
	agents: { events: [...mobileClientProductEventMethods] },
};

/**
 * Builds the RpcPeer event handlers that validate each allowlisted event and forward it to the
 * typed {@link MobileEventBus}. A validation failure throws, which the peer treats as an event
 * handler failure (strict Zod on every event, per the DoD).
 */
export function buildMobileRpcHandlers(bus: MobileEventBus): RpcHandlers {
	const events: Record<string, (payload: JsonValue) => void> = {};
	for (const wire of mobileClientProductEventMethods) {
		const schema = eventSchemasByWireName[wire];
		const name = eventNameByWire[wire];
		if (!schema || !name) {
			continue;
		}
		events[wire] = (payload: JsonValue) => {
			const parsed = schema.parse(payload);
			// The name/schema pairing is validated by the maps above; the bus is typed per event.
			bus.emit(name as never, parsed as never);
		};
	}
	return { events };
}

/**
 * Typed, allowlist-enforcing client over the authenticated Mobile RPC peer. Every request validates
 * its input and output against the shared contract schemas; any Desktop-only method is impossible to
 * call because it is not on {@link mobileClientProductRequestMethods}.
 */
export class MobileProductClient {
	readonly #peer: RpcPeer;

	constructor(peer: RpcPeer) {
		this.#peer = peer;
	}

	get isClosed(): boolean {
		return this.#peer.isClosed;
	}

	async #call(method: string, input: unknown): Promise<unknown> {
		if (!allowedRequestMethods.has(method)) {
			throw new Error(`Method "${method}" is not on the Mobile allowlist.`);
		}
		const schemas = productRpcRequestSchemas[method as keyof typeof productRpcRequestSchemas];
		const validatedInput = schemas.input.parse(input);
		const raw = await this.#peer.request(method, validatedInput as unknown as JsonValue);
		return schemas.output.parse(raw);
	}

	runtimeGet(): Promise<AgentsRuntimeInfo> {
		return this.#call(productRpcMethods.runtimeGet, {}) as Promise<AgentsRuntimeInfo>;
	}

	listRuntimeBoxes(): Promise<ListRuntimeBoxesOutput> {
		return this.#call(productRpcMethods.runtimeBoxesList, {}) as Promise<ListRuntimeBoxesOutput>;
	}

	switchRuntimeBox(input: SwitchRuntimeBoxInput): Promise<SwitchRuntimeBoxOutput> {
		return this.#call(productRpcMethods.runtimeBoxesSwitch, input) as Promise<SwitchRuntimeBoxOutput>;
	}

	listProjects(input: { runtimeBoxId?: string; archived?: boolean; limit?: number } = {}): Promise<ListProjectsOutput> {
		return this.#call(productRpcMethods.projectsList, input) as Promise<ListProjectsOutput>;
	}

	getProject(projectId: string): Promise<GetProjectOutput> {
		return this.#call(productRpcMethods.projectsGet, { projectId }) as Promise<GetProjectOutput>;
	}

	getProjectSidebar(input: { runtimeBoxId?: string } = {}): Promise<GetProjectSidebarOutput> {
		return this.#call(productRpcMethods.projectsGetSidebar, input) as Promise<GetProjectSidebarOutput>;
	}

	listAvailableModels(): Promise<ListAvailableModelsOutput> {
		return this.#call(productRpcMethods.modelsListAvailable, {}) as Promise<ListAvailableModelsOutput>;
	}

	createSession(input: CreateProcessChatSessionInput): Promise<CreateChatSessionOutput> {
		return this.#call(productRpcMethods.sessionCreate, input) as Promise<CreateChatSessionOutput>;
	}

	getSessionPage(input: GetChatSessionPageInput): Promise<GetChatSessionPageOutput> {
		return this.#call(productRpcMethods.sessionGet, input) as Promise<GetChatSessionPageOutput>;
	}

	listSessions(input: ListChatSessionsInput = {}): Promise<ListChatSessionsOutput> {
		return this.#call(productRpcMethods.sessionList, input) as Promise<ListChatSessionsOutput>;
	}

	setSessionModel(input: {
		sessionId: string;
		model: { providerId: string; modelId: string; thinkingLevel?: string } | null;
	}): Promise<unknown> {
		return this.#call(productRpcMethods.sessionSetModel, input);
	}

	chatSend(input: SendAskChatMessageInput): Promise<ChatSendAcceptedOutput> {
		return this.#call(productRpcMethods.chatSend, input) as Promise<ChatSendAcceptedOutput>;
	}

	chatCancel(input: CancelChatRunInput): Promise<CancelChatRunOutput> {
		return this.#call(productRpcMethods.chatCancel, input) as Promise<CancelChatRunOutput>;
	}

	chatReplay(input: ReplayChatEventsInput): Promise<ReplayChatEventsOutput> {
		return this.#call(productRpcMethods.chatReplay, input) as Promise<ReplayChatEventsOutput>;
	}

	chatSubscribe(sessionId: string): Promise<unknown> {
		return this.#call(productRpcMethods.chatSubscribe, { sessionId });
	}

	chatUnsubscribe(sessionId: string): Promise<unknown> {
		return this.#call(productRpcMethods.chatUnsubscribe, { sessionId });
	}

	listApprovals(input: ListApprovalsInput = {}): Promise<ListApprovalsOutput> {
		return this.#call(productRpcMethods.approvalsList, input) as Promise<ListApprovalsOutput>;
	}

	getApproval(approvalId: string): Promise<GetApprovalOutput> {
		return this.#call(productRpcMethods.approvalsGet, { approvalId }) as Promise<GetApprovalOutput>;
	}

	decideApproval(input: DecideApprovalInput): Promise<DecideApprovalOutput> {
		return this.#call(productRpcMethods.approvalsDecide, input) as Promise<DecideApprovalOutput>;
	}

	getSessionApprovalPolicy(sessionId: string): Promise<GetSessionApprovalPolicyOutput> {
		return this.#call(productRpcMethods.sessionApprovalPolicyGet, {
			sessionId,
		}) as Promise<GetSessionApprovalPolicyOutput>;
	}

	updateSessionApprovalPolicy(
		input: UpdateSessionApprovalPolicyInput,
	): Promise<UpdateSessionApprovalPolicyOutput> {
		return this.#call(
			productRpcMethods.sessionApprovalPolicyUpdate,
			input,
		) as Promise<UpdateSessionApprovalPolicyOutput>;
	}
}
