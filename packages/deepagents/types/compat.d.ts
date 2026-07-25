/**
 * @deprecated Legacy prompt compatibility exports.
 *
 * These prompts are retained only so existing imports continue to resolve.
 * Deep Agents no longer injects authored base prose or duplicate built-in
 * middleware guidance by default. Do not use these in new code; they will be
 * removed in the next major release.
 */
import { type SystemMessage } from "langchain";
/**
 * @deprecated Compatibility type for the former structured `systemPrompt` API.
 * Existing callers may continue using it, but new code should pass a string or
 * `SystemMessage` directly. This type and its compatibility behavior will be
 * removed in the next major release.
 */
export interface SystemPromptConfig {
	/** Content placed before the profile base prompt. */
	prefix?: string | SystemMessage | null;
	/** Replacement for the profile base prompt; `null` omits that base. */
	base?: string | SystemMessage | null;
	/** Content placed after the base prompt and before the profile suffix. */
	suffix?: string | SystemMessage | null;
}
/**
 * @deprecated Retained for compatibility only. This prompt is not injected by
 * default and will be removed in the next major release.
 */
export declare const BASE_AGENT_PROMPT: string;
/**
 * @deprecated Retained for compatibility only. Task-tool guidance now lives in
 * the task tool schema and this export will be removed in the next major release.
 */
export declare const TASK_SYSTEM_PROMPT: string;
/**
 * @deprecated Retained for compatibility only. Async-subagent guidance now
 * lives in tool schemas and this export will be removed in the next major release.
 */
export declare const ASYNC_TASK_SYSTEM_PROMPT =
	'## Async subagents (remote servers)\n\nYou have access to async subagent tools that launch background tasks on remote servers.\n\n### Tools:\n- `start_async_task`: Start a new background task. Returns a task ID immediately.\n- `check_async_task`: Check the status of a running task. Returns status and result if complete.\n- `update_async_task`: Send an update or new instructions to a running task.\n- `cancel_async_task`: Cancel a running task that is no longer needed.\n- `list_async_tasks`: List all tracked tasks with live statuses. Use this to check all tasks at once.\n\n### Workflow:\n1. **Launch** \u2014 Use `start_async_task` to start a task. Report the task ID to the user and stop.\n   Do NOT immediately check the status \u2014 the task runs in the background while you and the user continue other work.\n2. **Check (on request)** \u2014 Only use `check_async_task` when the user explicitly asks for a status update or\n   result. If the status is "running", report that and stop \u2014 do not poll in a loop.\n3. **Update** (optional) \u2014 Use `update_async_task` to send new instructions to a running task. This interrupts\n   the current run and starts a fresh one on the same thread. The task_id stays the same.\n4. **Cancel** (optional) \u2014 Use `cancel_async_task` to stop a task that is no longer needed.\n5. **Collect** \u2014 When `check_async_task` returns status "success", the result is included in the response.\n6. **List** \u2014 Use `list_async_tasks` to see live statuses for all tasks at once, or to recall task IDs after context compaction.\n\n### Critical rules:\n- After launching, ALWAYS return control to the user immediately. Never auto-check after launching.\n- Never poll `check_async_task` in a loop. Check once per user request, then stop.\n- If a check returns "running", tell the user and wait for them to ask again.\n- Task statuses in conversation history are ALWAYS stale \u2014 a task that was "running" may now be done.\n  NEVER report a status from a previous tool result. ALWAYS call a tool to get the current status:\n  use `list_async_tasks` when the user asks about multiple tasks or "all tasks",\n  use `check_async_task` when the user asks about a specific task.\n- Always show the full task_id \u2014 never truncate or abbreviate it.\n\n### When to use async subagents:\n- Long-running tasks that would block the main agent\n- Tasks that benefit from running on specialized remote deployments\n- When you want to run multiple tasks concurrently and collect results later';
/**
 * @deprecated Retained for compatibility only. Execute guidance now lives in
 * the execute tool schema and this export will be removed in the next major release.
 */
export declare const EXECUTION_SYSTEM_PROMPT: string;
