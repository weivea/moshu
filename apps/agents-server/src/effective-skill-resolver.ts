import type { AskChatSkillResource } from "@moshu/agent-runtime";
import {
	maxEffectiveSkillMarkdownBytes,
	type AgentServerSkillResourceRef,
	type RuntimeBoxResourceRef,
} from "@moshu/contracts";
import type { AgentServerSkillRepository } from "@moshu/database";

import type { RuntimeBoxRegistry } from "./runtime-box-registry";

const maxConcurrentSkillFetches = 8;

export class EffectiveSkillResolutionError extends Error {
	constructor(
		readonly code: "SKILL_NAME_CONFLICT" | "SKILL_PROMPT_LIMIT_EXCEEDED",
		message: string,
	) {
		super(message);
		this.name = "EffectiveSkillResolutionError";
	}
}

export async function resolveEffectiveSkills(input: {
	runtimeBoxId: string;
	serverRefs: readonly AgentServerSkillResourceRef[];
	boxRefs: readonly RuntimeBoxResourceRef[];
	serverSkills: AgentServerSkillRepository;
	runtimeBoxes: RuntimeBoxRegistry;
	signal: AbortSignal;
}): Promise<AskChatSkillResource[]> {
	const serverSkills = input.serverSkills.resolveRefs(input.serverRefs).map((resolved) => {
		if (resolved.summary.metadata === undefined) {
			throw new Error("Agent Server Skill metadata is unavailable.");
		}
		return {
			owner: { kind: "agent-server" as const },
			stableResourceId: resolved.summary.stableResourceId,
			version: resolved.summary.version,
			contentHash: resolved.summary.contentHash,
			metadata: resolved.summary.metadata,
			skillMarkdown: resolved.skillMarkdown,
		};
	});
	const boxSkills = await mapWithConcurrency(
		input.boxRefs.filter((ref) => ref.resourceKind === "skill"),
		maxConcurrentSkillFetches,
		async (ref) => {
			const content = await input.runtimeBoxes.getSkillContent(
				input.runtimeBoxId,
				{ ref },
				input.signal,
			);
			return {
				owner: { kind: "runtime-box" as const, runtimeBoxId: input.runtimeBoxId },
				stableResourceId: ref.stableResourceId,
				version: ref.version,
				contentHash: ref.contentHash,
				metadata: content.metadata,
				skillMarkdown: content.skillMarkdown,
			};
		},
	);
	const skills = [...serverSkills, ...boxSkills];
	const names = new Map<string, AskChatSkillResource>();
	let totalBytes = 0;
	const encoder = new TextEncoder();
	for (const skill of skills) {
		const previous = names.get(skill.metadata.name);
		if (previous !== undefined) {
			throw new EffectiveSkillResolutionError(
				"SKILL_NAME_CONFLICT",
				`Skill name ${skill.metadata.name} is assigned by more than one owner.`,
			);
		}
		names.set(skill.metadata.name, skill);
		totalBytes += encoder.encode(skill.skillMarkdown).byteLength;
		if (totalBytes > maxEffectiveSkillMarkdownBytes) {
			throw new EffectiveSkillResolutionError(
				"SKILL_PROMPT_LIMIT_EXCEEDED",
				"Assigned Skill content exceeds the aggregate prompt limit.",
			);
		}
	}
	return skills;
}

async function mapWithConcurrency<TInput, TOutput>(
	values: readonly TInput[],
	limit: number,
	mapper: (value: TInput) => Promise<TOutput>,
): Promise<TOutput[]> {
	const output = new Array<TOutput>(values.length);
	let nextIndex = 0;
	const workers = Array.from({ length: Math.min(limit, values.length) }, async () => {
		while (nextIndex < values.length) {
			const index = nextIndex;
			nextIndex += 1;
			const value = values[index];
			if (value !== undefined) {
				output[index] = await mapper(value);
			}
		}
	});
	await Promise.all(workers);
	return output;
}
