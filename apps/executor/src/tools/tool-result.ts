import type {
	ExecutorBashToolDetails,
	ExecutorEditToolDetails,
	ExecutorFindToolDetails,
	ExecutorGrepToolDetails,
	ExecutorLsToolDetails,
	ExecutorReadToolDetails,
	ExecutorToolContent,
	ExecutorToolTextContent,
} from "@moshu/contracts";

export interface ToolResult<TDetails> {
	content: ExecutorToolContent[];
	details?: TDetails;
}

export type TextToolResult<TDetails> = {
	content: [ExecutorToolTextContent];
	details?: TDetails;
};

export type ReadToolResult = ToolResult<ExecutorReadToolDetails>;
export type BashToolResult = TextToolResult<ExecutorBashToolDetails>;
export type EditToolResult = {
	content: [ExecutorToolTextContent];
	details: ExecutorEditToolDetails;
};
export type WriteToolResult = {
	content: [ExecutorToolTextContent];
};
export type GrepToolResult = TextToolResult<ExecutorGrepToolDetails>;
export type FindToolResult = TextToolResult<ExecutorFindToolDetails>;
export type LsToolResult = TextToolResult<ExecutorLsToolDetails>;

export function textContent(text: string): ExecutorToolTextContent {
	return { type: "text", text };
}

export function throwIfAborted(signal: AbortSignal | undefined): void {
	if (signal?.aborted) {
		throw signal.reason instanceof Error ? signal.reason : new Error("Operation aborted");
	}
}
