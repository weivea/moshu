import { z } from "zod";

export const agentModeSchema = z.enum(["ask", "plan", "agent"]);

export type AgentMode = z.infer<typeof agentModeSchema>;
