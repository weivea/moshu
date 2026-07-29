import {
	deleteRuntimeBoxMcpServerInputSchema,
	deleteRuntimeBoxSkillInputSchema,
	emptyParamsSchema,
	getRuntimeBoxInventoryChangesInputSchema,
	getRuntimeBoxSkillContentInputSchema,
	installRuntimeBoxSkillInputSchema,
	listRuntimeBoxMcpServersInputSchema,
	listRuntimeBoxSkillsInputSchema,
	productRpcMethods,
	setRuntimeBoxMcpServerEnabledInputSchema,
	upsertRuntimeBoxMcpServerInputSchema,
	validateRuntimeBoxResourcesInputSchema,
} from "@moshu/contracts";
import { RpcHandlerError, type RpcRequestHandler, rpcJsonValueSchema } from "@moshu/process-rpc";

import {
	InventoryResyncRequiredError,
	RuntimeResourceNotFoundError,
	type RuntimeResourceStore,
	RuntimeResourceVersionConflictError,
} from "./runtime-resource-store";

export interface RuntimeResourceHandlerContext {
	readonly runtimeBoxId: string;
	readonly generation: number;
	readonly capabilities: readonly string[];
}

export function createRuntimeResourceRequestHandlers(
	store: RuntimeResourceStore,
	context: RuntimeResourceHandlerContext,
): Readonly<Record<string, RpcRequestHandler>> {
	const targetRuntimeBox = (runtimeBoxId: string | undefined): void => {
		if (runtimeBoxId !== undefined && runtimeBoxId !== context.runtimeBoxId) {
			throw new RpcHandlerError(
				"RUNTIME_RESOURCE_WRONG_BOX",
				"Resource command targets another Runtime Box.",
			);
		}
	};
	const handle =
		<TInput>(
			parse: (payload: unknown) => TInput,
			execute: (input: TInput) => unknown,
		): RpcRequestHandler =>
		(payload) => {
			try {
				return rpcJsonValueSchema.parse(execute(parse(payload)));
			} catch (error) {
				throw mapResourceError(error);
			}
		};

	return {
		[productRpcMethods.runtimeBoxInventoryGetSnapshot]: handle(
			(payload) => emptyParamsSchema.parse(payload),
			() =>
				store.getInventorySnapshot({
					runtimeBoxId: context.runtimeBoxId,
					runtimeBoxGeneration: context.generation,
					capabilities: context.capabilities,
				}),
		),
		[productRpcMethods.runtimeBoxInventoryGetChanges]: handle(
			(payload) => getRuntimeBoxInventoryChangesInputSchema.parse(payload),
			(input) => store.getInventoryChanges(input),
		),
		[productRpcMethods.runtimeBoxMcpServersList]: handle(
			(payload) => listRuntimeBoxMcpServersInputSchema.parse(payload),
			(input) => {
				targetRuntimeBox(input.runtimeBoxId);
				return store.listMcpServers(context.runtimeBoxId);
			},
		),
		[productRpcMethods.runtimeBoxMcpServersUpsert]: handle(
			(payload) => upsertRuntimeBoxMcpServerInputSchema.parse(payload),
			(input) => {
				targetRuntimeBox(input.runtimeBoxId);
				return store.upsertMcpServer(input);
			},
		),
		[productRpcMethods.runtimeBoxMcpServersSetEnabled]: handle(
			(payload) => setRuntimeBoxMcpServerEnabledInputSchema.parse(payload),
			(input) => {
				targetRuntimeBox(input.runtimeBoxId);
				return store.setMcpServerEnabled(input);
			},
		),
		[productRpcMethods.runtimeBoxMcpServersDelete]: handle(
			(payload) => deleteRuntimeBoxMcpServerInputSchema.parse(payload),
			(input) => {
				targetRuntimeBox(input.runtimeBoxId);
				return store.deleteMcpServer(input);
			},
		),
		[productRpcMethods.runtimeBoxSkillsList]: handle(
			(payload) => listRuntimeBoxSkillsInputSchema.parse(payload),
			(input) => {
				targetRuntimeBox(input.runtimeBoxId);
				return store.listSkills(context.runtimeBoxId);
			},
		),
		[productRpcMethods.runtimeBoxSkillsInstall]: handle(
			(payload) => installRuntimeBoxSkillInputSchema.parse(payload),
			(input) => {
				targetRuntimeBox(input.runtimeBoxId);
				return store.installSkill(input);
			},
		),
		[productRpcMethods.runtimeBoxSkillsDelete]: handle(
			(payload) => deleteRuntimeBoxSkillInputSchema.parse(payload),
			(input) => {
				targetRuntimeBox(input.runtimeBoxId);
				return store.deleteSkill(input);
			},
		),
		[productRpcMethods.runtimeBoxResourcesValidate]: handle(
			(payload) => validateRuntimeBoxResourcesInputSchema.parse(payload),
			(input) => store.validateResources(context.runtimeBoxId, input),
		),
		[productRpcMethods.runtimeBoxSkillGetContent]: handle(
			(payload) => getRuntimeBoxSkillContentInputSchema.parse(payload),
			(input) => store.getSkillContent(context.runtimeBoxId, input),
		),
	};
}

function mapResourceError(error: unknown): unknown {
	if (error instanceof RpcHandlerError) {
		return error;
	}
	if (error instanceof InventoryResyncRequiredError) {
		return new RpcHandlerError("INVENTORY_RESYNC_REQUIRED", error.message);
	}
	if (error instanceof RuntimeResourceVersionConflictError) {
		return new RpcHandlerError("RUNTIME_RESOURCE_VERSION_CONFLICT", error.message);
	}
	if (error instanceof RuntimeResourceNotFoundError) {
		return new RpcHandlerError("RUNTIME_RESOURCE_NOT_FOUND", error.message);
	}
	return error;
}
