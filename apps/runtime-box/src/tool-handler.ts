import { constants } from "node:fs";
import { access, lstat, readlink, realpath, stat } from "node:fs/promises";
import { dirname, isAbsolute, resolve } from "node:path";
import {
	acknowledgeRuntimeBoxInvocationsInputSchema,
	acknowledgeRuntimeBoxInvocationsOutputSchema,
	type ExecutorToolInvokeInput,
	type ExecutorToolInvokeOutput,
	productRpcEvents,
	runtimeBoxToolInvokeInputSchema,
} from "@moshu/contracts";
import {
	RpcConnectionClosedError,
	RpcHandlerError,
	type RpcPeer,
	type RpcRequestHandler,
	rpcJsonValueSchema,
} from "@moshu/process-rpc";
import {
	InvocationGrantRejectedError,
	InvocationJournalPrepareFailedError,
	type RuntimeBoxInvocationJournal,
	type RuntimeBoxToolDeployment,
} from "./invocation-journal";
import type { ExecutorToolRuntime } from "./tools/index.ts";
import { assertPathContained, resolveReadPath, resolveToCwd } from "./tools/path-utils.ts";
import { truncateUtf8FromEnd } from "./tools/truncate.ts";

const maxRpcErrorMessageBytes = 1024;

function executionErrorMessage(error: unknown): string {
	return truncateUtf8FromEnd(
		error instanceof Error ? error.message : String(error),
		maxRpcErrorMessageBytes,
		"[earlier output truncated]\n",
	);
}

export interface ExecutorToolRequestHandlerOptions {
	readonly journal: Pick<RuntimeBoxInvocationJournal, "begin" | "succeed" | "fail" | "cancel">;
	readonly deployment: RuntimeBoxToolDeployment;
	readonly activeExecutions?: Set<Promise<unknown>>;
	readonly lifecycleSignal?: AbortSignal;
	readonly onProgressError?: (error: unknown) => void;
}

export function createExecutorToolRequestHandler(
	runtime: ExecutorToolRuntime,
	options: ExecutorToolRequestHandlerOptions,
): RpcRequestHandler {
	const deployment = options.deployment;
	if (deployment.kind === "remote" && !isAbsolute(deployment.workspacePath)) {
		throw new TypeError("Remote Runtime Box workspace must be an absolute path.");
	}
	const activeInvocations = new WeakMap<RpcPeer, Set<string>>();
	const handle = async (
		payload: Parameters<RpcRequestHandler>[0],
		context: Parameters<RpcRequestHandler>[1],
	) => {
		const parsed = runtimeBoxToolInvokeInputSchema.safeParse(payload);
		if (!parsed.success) {
			throw new RpcHandlerError(
				"INVALID_RUNTIME_BOX_TOOL_REQUEST",
				executionErrorMessage(parsed.error),
			);
		}
		const input: ExecutorToolInvokeInput = parsed.data;
		let peerInvocations = activeInvocations.get(context.peer);
		if (!peerInvocations) {
			peerInvocations = new Set();
			activeInvocations.set(context.peer, peerInvocations);
		}
		if (peerInvocations.has(input.invocationId)) {
			throw new RpcHandlerError(
				"DUPLICATE_RUNTIME_BOX_TOOL_INVOCATION",
				`Executor tool invocation ${input.invocationId} is already running on this connection.`,
			);
		}
		peerInvocations.add(input.invocationId);
		let begun: { replayResult?: ExecutorToolInvokeOutput };
		try {
			begun = options.journal.begin(
				input,
				context.peer.remoteIdentity,
				context.peer.localIdentity,
				deployment,
			);
		} catch (error) {
			peerInvocations.delete(input.invocationId);
			throw new RpcHandlerError(
				error instanceof InvocationGrantRejectedError
					? "RUNTIME_BOX_EXECUTION_GRANT_REJECTED"
					: error instanceof InvocationJournalPrepareFailedError
						? "RUNTIME_BOX_INVOCATION_JOURNAL_PREPARE_FAILED"
						: "RUNTIME_BOX_INVOCATION_JOURNAL_FAILED",
				executionErrorMessage(error),
			);
		}

		let executionSignal: ReturnType<typeof createActionExecutionSignal> | undefined;
		try {
			if (begun.replayResult !== undefined) {
				return rpcJsonValueSchema.parse(begun.replayResult);
			}
			const activeExecutionSignal = createActionExecutionSignal(
				context.signal,
				context.deadlineAt,
				options.lifecycleSignal,
			);
			executionSignal = activeExecutionSignal;
			let result: ExecutorToolInvokeOutput;
			try {
				activeExecutionSignal.signal.throwIfAborted();
				const policy = await resolveInvocationPolicy(input, deployment);
				const executionInput = { ...input, cwd: policy.cwd };
				let effectiveFilePath: string | undefined;
				if (policy.containmentRoot !== undefined && input.call.tool !== "bash") {
					try {
						if (input.call.tool === "read" || input.call.tool === "edit") {
							effectiveFilePath = await resolveReadPath(
								input.call.arguments.path,
								policy.cwd,
								policy.containmentRoot,
							);
						}
						await assertCallContained(executionInput, policy.containmentRoot);
					} catch (error) {
						throw new RpcHandlerError(
							"RUNTIME_BOX_WORKSPACE_VIOLATION",
							executionErrorMessage(error),
						);
					}
				}
				activeExecutionSignal.signal.throwIfAborted();
				const execution = Promise.resolve().then(() =>
					runtime.execute(executionInput, {
						signal: activeExecutionSignal.signal,
						...(policy.containmentRoot === undefined
							? {}
							: { containmentRoot: policy.containmentRoot }),
						...(effectiveFilePath === undefined ? {} : { effectiveFilePath }),
						onProgress: (event) => {
							if (context.peer.isClosed) {
								return;
							}
							try {
								context.peer.emitEvent(
									productRpcEvents.runtimeBoxToolProgress,
									rpcJsonValueSchema.parse(event),
									{ traceId: context.traceId },
								);
							} catch (error) {
								(options.onProgressError ?? defaultProgressErrorReporter)(error);
							}
						},
					}),
				);
				result = await execution;
			} finally {
				activeExecutionSignal.dispose();
			}
			options.journal.succeed(input.invocationId, result);
			return rpcJsonValueSchema.parse(result);
		} catch (error) {
			if (executionSignal?.signal.aborted) {
				options.journal.cancel(
					input.invocationId,
					executionErrorMessage(executionSignal.signal.reason),
				);
				throw new RpcHandlerError(
					"RUNTIME_BOX_TOOL_CANCELLED",
					executionErrorMessage(executionSignal.signal.reason),
				);
			}

			try {
				options.journal.fail(input.invocationId, executionErrorMessage(error));
			} catch (journalError) {
				throw new RpcHandlerError(
					"RUNTIME_BOX_INVOCATION_JOURNAL_FAILED",
					executionErrorMessage(journalError),
				);
			}
			if (error instanceof RpcHandlerError) {
				throw error;
			}
			throw new RpcHandlerError("RUNTIME_BOX_TOOL_FAILED", executionErrorMessage(error));
		} finally {
			peerInvocations.delete(input.invocationId);
		}
	};
	return (payload, context) => {
		const execution = Promise.resolve(handle(payload, context));
		const activeExecutions = options.activeExecutions;
		if (activeExecutions !== undefined) {
			activeExecutions.add(execution);
			void execution.then(
				() => activeExecutions.delete(execution),
				() => activeExecutions.delete(execution),
			);
		}
		return execution;
	};
}

async function resolveInvocationPolicy(
	input: ExecutorToolInvokeInput,
	deployment: RuntimeBoxToolDeployment,
): Promise<{ cwd: string; containmentRoot?: string }> {
	const scope =
		input.authorization?.executionScope ??
		(deployment.kind === "remote" ? "runtime-box-workspace" : "request-cwd");
	switch (scope) {
		case "request-cwd":
			return { cwd: input.cwd };
		case "runtime-box-workspace": {
			if (deployment.kind !== "remote") {
				throw new RpcHandlerError(
					"RUNTIME_BOX_EXECUTION_SCOPE_INCOMPATIBLE",
					"runtime-box-workspace requires a Remote Runtime Box workspace.",
				);
			}
			const containmentRoot = await realpath(deployment.workspacePath);
			return { cwd: deployment.workspacePath, containmentRoot };
		}
		case "project-root": {
			const cwd = await requireCanonicalProjectCwd(input.cwd);
			return { cwd, containmentRoot: cwd };
		}
	}
}

async function requireCanonicalProjectCwd(requestedCwd: string): Promise<string> {
	if (!isAbsolute(requestedCwd)) {
		throw new RpcHandlerError(
			"RUNTIME_BOX_PROJECT_CWD_NOT_CANONICAL",
			"Project cwd must be an absolute canonical path.",
		);
	}
	let canonicalCwd: string;
	try {
		canonicalCwd = await realpath(requestedCwd);
	} catch (error) {
		throw mapProjectCwdError(error);
	}
	if (canonicalCwd !== requestedCwd) {
		throw new RpcHandlerError(
			"RUNTIME_BOX_PROJECT_CWD_NOT_CANONICAL",
			"Project cwd does not match its canonical path.",
		);
	}
	let metadata: Awaited<ReturnType<typeof stat>>;
	try {
		metadata = await stat(canonicalCwd);
	} catch (error) {
		throw mapProjectCwdError(error);
	}
	if (!metadata.isDirectory()) {
		throw new RpcHandlerError(
			"RUNTIME_BOX_PROJECT_CWD_NOT_DIRECTORY",
			"Project cwd is not a directory.",
		);
	}
	try {
		await access(canonicalCwd, constants.R_OK | constants.X_OK);
	} catch {
		throw new RpcHandlerError(
			"RUNTIME_BOX_PROJECT_CWD_NOT_READABLE",
			"Project cwd is not readable.",
		);
	}
	return canonicalCwd;
}

function mapProjectCwdError(error: unknown): RpcHandlerError {
	if (error instanceof Error && "code" in error) {
		if (error.code === "ENOENT") {
			return new RpcHandlerError(
				"RUNTIME_BOX_PROJECT_CWD_NOT_FOUND",
				"Project cwd does not exist.",
			);
		}
		if (error.code === "ENOTDIR") {
			return new RpcHandlerError(
				"RUNTIME_BOX_PROJECT_CWD_NOT_DIRECTORY",
				"Project cwd is not a directory.",
			);
		}
		if (error.code === "EACCES" || error.code === "EPERM") {
			return new RpcHandlerError(
				"RUNTIME_BOX_PROJECT_CWD_NOT_READABLE",
				"Project cwd is not readable.",
			);
		}
	}
	return new RpcHandlerError(
		"RUNTIME_BOX_PROJECT_CWD_INVALID",
		"Project cwd could not be validated.",
	);
}

async function assertCallContained(input: ExecutorToolInvokeInput, root: string): Promise<void> {
	const path =
		input.call.tool === "read" ||
		input.call.tool === "edit" ||
		input.call.tool === "write" ||
		input.call.tool === "grep" ||
		input.call.tool === "find" ||
		input.call.tool === "ls"
			? (input.call.arguments.path ?? ".")
			: ".";
	const lexicalRoot = resolveToCwd(".", input.cwd);
	const lexicalTarget = resolveToCwd(path, input.cwd);
	assertPathContained(lexicalRoot, lexicalTarget);
	const canonicalTarget = await resolveCanonicalTarget(lexicalTarget);
	assertPathContained(root, canonicalTarget);
}

async function resolveCanonicalTarget(path: string, visited = new Set<string>()): Promise<string> {
	const resolvedPath = resolve(path);
	let metadata: Awaited<ReturnType<typeof lstat>> | undefined;
	try {
		metadata = await lstat(resolvedPath);
	} catch (error) {
		if (!isMissingPathError(error)) {
			throw error;
		}
	}
	if (metadata === undefined) {
		const parent = dirname(resolvedPath);
		if (parent === resolvedPath) {
			throw new Error("Tool path has no existing canonical parent.");
		}
		return resolve(
			await resolveCanonicalTarget(parent, visited),
			resolvedPath.slice(parent.length + 1),
		);
	}
	if (!metadata.isSymbolicLink()) {
		return realpath(resolvedPath);
	}
	if (visited.has(resolvedPath)) {
		throw new Error("Tool path contains a symbolic-link cycle.");
	}
	visited.add(resolvedPath);
	const target = await readlink(resolvedPath);
	return resolveCanonicalTarget(
		isAbsolute(target) ? target : resolve(dirname(resolvedPath), target),
		visited,
	);
}

function isMissingPathError(error: unknown): boolean {
	return (
		error instanceof Error &&
		"code" in error &&
		(error.code === "ENOENT" || error.code === "ENOTDIR")
	);
}

function defaultProgressErrorReporter(error: unknown): void {
	console.error(
		error instanceof Error
			? `Runtime Box progress publication failed: ${error.message}`
			: "Runtime Box progress publication failed.",
	);
}

export function createActionExecutionSignal(
	requestSignal: AbortSignal,
	deadlineAt: number,
	lifecycleSignal: AbortSignal | undefined,
): { signal: AbortSignal; dispose(): void } {
	const controller = new AbortController();
	let leaseTimer: ReturnType<typeof setTimeout> | undefined;
	const abortFromLifecycle = () =>
		controller.abort(lifecycleSignal?.reason ?? new Error("Runtime Box is shutting down."));
	const abortFromRequest = () => {
		const reason = requestSignal.reason;
		if (reason instanceof RpcConnectionClosedError && lifecycleSignal?.aborted !== true) {
			const remainingMs = Math.max(0, deadlineAt - Date.now());
			leaseTimer = setTimeout(
				() => controller.abort(new Error("Action lease expired after transport loss.")),
				remainingMs,
			);
			return;
		}
		controller.abort(reason);
	};
	requestSignal.addEventListener("abort", abortFromRequest, { once: true });
	lifecycleSignal?.addEventListener("abort", abortFromLifecycle, {
		once: true,
	});
	if (lifecycleSignal?.aborted) {
		abortFromLifecycle();
	} else if (requestSignal.aborted) {
		abortFromRequest();
	}
	return {
		signal: controller.signal,
		dispose() {
			requestSignal.removeEventListener("abort", abortFromRequest);
			lifecycleSignal?.removeEventListener("abort", abortFromLifecycle);
			if (leaseTimer !== undefined) {
				clearTimeout(leaseTimer);
			}
		},
	};
}

export function createInvocationAcknowledgementHandler(
	journal: RuntimeBoxInvocationJournal,
): RpcRequestHandler {
	return (payload) => {
		const input = acknowledgeRuntimeBoxInvocationsInputSchema.parse(payload);
		return rpcJsonValueSchema.parse(
			acknowledgeRuntimeBoxInvocationsOutputSchema.parse({
				ackedInvocationIds: journal.acknowledge(input.invocationIds),
			}),
		);
	};
}
