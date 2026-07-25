import { z } from "zod";

export const agentModeValues = ["ask", "plan", "agent"] as const;
export const agentModeSchema = z.enum(agentModeValues);

export type AgentMode = z.infer<typeof agentModeSchema>;
