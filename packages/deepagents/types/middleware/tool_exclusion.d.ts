import { type AgentMiddleware } from "langchain";
/**
 * Create middleware that removes excluded tools after all tool-injecting
 * middleware has had a chance to add tools to the request.
 *
 * @internal
 */
export declare function createToolExclusionMiddleware(
	excludedTools: ReadonlySet<string>,
): AgentMiddleware;
