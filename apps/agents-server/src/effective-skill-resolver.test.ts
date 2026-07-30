import { describe, expect, test } from "bun:test";

import type { AgentServerSkillRepository } from "@moshu/database";

import { resolveEffectiveSkills } from "./effective-skill-resolver";
import type { RuntimeBoxRegistry } from "./runtime-box-registry";

const serverRef = {
	owner: { kind: "agent-server" as const },
	stableResourceId: "server-release",
	version: "550e8400-e29b-41d4-a716-446655440000",
	contentHash: "a".repeat(64),
};
const boxRef = {
	runtimeBoxId: "runtime-box",
	resourceKind: "skill" as const,
	stableResourceId: "box-release",
	version: "550e8400-e29b-41d4-a716-446655440001",
	contentHash: "b".repeat(64),
};

describe("effective Skill resolver", () => {
	test("merges owner-aware Skills and rejects duplicate metadata names", async () => {
		const serverSkills = {
			resolveRefs: () => [
				{
					summary: {
						owner: serverRef.owner,
						stableResourceId: serverRef.stableResourceId,
						configRevision: 1,
						version: serverRef.version,
						contentHash: serverRef.contentHash,
						metadata: {
							name: "release-helper",
							description: "Server release",
							allowedTools: [],
							metadata: {},
						},
						enabled: true,
						health: "ready",
						packageKind: "prompt-only",
						sourceKind: "inline-editor",
						stale: false,
						installedAt: new Date(0).toISOString(),
						updatedAt: new Date(0).toISOString(),
					},
					skillMarkdown: "server",
				},
			],
		} as unknown as AgentServerSkillRepository;
		const runtimeBoxes = {
			getSkillContent: async () => ({
				ref: boxRef,
				metadata: {
					name: "release-helper",
					description: "Box release",
					allowedTools: [],
					metadata: {},
				},
				skillMarkdown: "box",
			}),
		} as unknown as RuntimeBoxRegistry;
		await expect(
			resolveEffectiveSkills({
				runtimeBoxId: "runtime-box",
				serverRefs: [serverRef],
				boxRefs: [boxRef],
				serverSkills,
				runtimeBoxes,
				signal: new AbortController().signal,
			}),
		).rejects.toMatchObject({
			code: "SKILL_NAME_CONFLICT",
		});
	});

	test("keeps Server-owned Skills available alongside distinct Box-owned Skills", async () => {
		const serverSkills = {
			resolveRefs: () => [
				{
					summary: {
						owner: serverRef.owner,
						stableResourceId: serverRef.stableResourceId,
						configRevision: 1,
						version: serverRef.version,
						contentHash: serverRef.contentHash,
						metadata: {
							name: "server-release",
							description: "Server release",
							allowedTools: [],
							metadata: {},
						},
						enabled: true,
						health: "ready",
						packageKind: "prompt-only",
						sourceKind: "inline-editor",
						stale: false,
						installedAt: new Date(0).toISOString(),
						updatedAt: new Date(0).toISOString(),
					},
					skillMarkdown: "server",
				},
			],
		} as unknown as AgentServerSkillRepository;
		const runtimeBoxes = {
			getSkillContent: async () => ({
				ref: boxRef,
				metadata: {
					name: "box-release",
					description: "Box release",
					allowedTools: [],
					metadata: {},
				},
				skillMarkdown: "box",
			}),
		} as unknown as RuntimeBoxRegistry;
		await expect(
			resolveEffectiveSkills({
				runtimeBoxId: "runtime-box",
				serverRefs: [serverRef],
				boxRefs: [boxRef],
				serverSkills,
				runtimeBoxes,
				signal: new AbortController().signal,
			}),
		).resolves.toMatchObject([
			{ owner: { kind: "agent-server" }, metadata: { name: "server-release" } },
			{ owner: { kind: "runtime-box" }, metadata: { name: "box-release" } },
		]);
	});

	test("rejects an aggregate Skill prompt that exceeds the global byte limit", async () => {
		const serverSkills = {
			resolveRefs: () =>
				Array.from({ length: 5 }, (_value, index) => ({
					summary: {
						owner: serverRef.owner,
						stableResourceId: `large-${index}`,
						configRevision: 1,
						version: serverRef.version,
						contentHash: serverRef.contentHash,
						metadata: {
							name: `large-${index}`,
							description: "Large Skill",
							allowedTools: [],
							metadata: {},
						},
						enabled: true,
						health: "ready",
						packageKind: "prompt-only",
						sourceKind: "inline-editor",
						stale: false,
						installedAt: new Date(0).toISOString(),
						updatedAt: new Date(0).toISOString(),
					},
					skillMarkdown: "x".repeat(512 * 1024),
				})),
		} as unknown as AgentServerSkillRepository;
		await expect(
			resolveEffectiveSkills({
				runtimeBoxId: "runtime-box",
				serverRefs: [serverRef],
				boxRefs: [],
				serverSkills,
				runtimeBoxes: {} as RuntimeBoxRegistry,
				signal: new AbortController().signal,
			}),
		).rejects.toMatchObject({ code: "SKILL_PROMPT_LIMIT_EXCEEDED" });
	});
});
