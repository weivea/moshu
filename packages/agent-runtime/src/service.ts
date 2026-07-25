import type { AgentMode } from "@moshu/contracts";

export interface StartRunInput {
	runId: string;
	sessionId: string;
	threadId: string;
	agentVersionId: string;
	modelProfileId: string;
	mode: AgentMode;
	projectId?: string;
}

export interface ResumeRunInput {
	runId: string;
	sessionId: string;
	threadId: string;
}

export interface CancelRunInput {
	runId: string;
	reason: string;
}

export interface RunAccepted {
	runId: string;
	threadId: string;
	executionId: string;
	acceptedAt: string;
}

export type ShutdownReason = "app_quit" | "restart" | "fatal_error";

export interface DeepAgentService {
	start(input: StartRunInput): Promise<RunAccepted>;
	resume(input: ResumeRunInput): Promise<RunAccepted>;
	cancel(input: CancelRunInput): Promise<void>;
	disposeSession(sessionId: string): Promise<void>;
	shutdown(reason: ShutdownReason): Promise<void>;
}
