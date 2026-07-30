import { describe, expect, test } from "bun:test";
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { FileSkillContentStore, prepareSkillPackage } from "../src";

const markdown =
	"---\nname: release-helper\ndescription: Prepare releases\nallowed-tools: [read, bash]\n---\n\nFollow the checklist.";

describe("Skill runtime", () => {
	test("enforces prompt-only Agent Server packages", () => {
		expect(
			prepareSkillPackage(
				[{ path: "SKILL.md", encoding: "utf8", content: markdown, executable: false }],
				{ ownerKind: "agent-server", allowBundleFiles: false, allowExecutableFiles: false },
			),
		).toMatchObject({
			metadata: { name: "release-helper", allowedTools: ["read", "bash"] },
		});
		expect(() =>
			prepareSkillPackage(
				[
					{ path: "SKILL.md", encoding: "utf8", content: markdown, executable: false },
					{ path: "scripts/check.sh", encoding: "utf8", content: "exit 0", executable: true },
				],
				{ ownerKind: "agent-server", allowBundleFiles: false, allowExecutableFiles: false },
			),
		).toThrow("only contain SKILL.md");
	});

	test("writes immutable private versions and detects tampering", () => {
		const directory = mkdtempSync(join(tmpdir(), "moshu-skill-runtime-"));
		try {
			const prepared = prepareSkillPackage(
				[{ path: "SKILL.md", encoding: "utf8", content: markdown, executable: false }],
				{ ownerKind: "agent-server", allowBundleFiles: false, allowExecutableFiles: false },
			);
			const store = new FileSkillContentStore(directory);
			const locator = store.writeVersion("release-helper", crypto.randomUUID(), prepared.files);
			expect(store.readSkillMarkdown(locator)).toBe(markdown);
			store.verifyVersion(locator, prepared.contentHash);
			const filename = join(store.resolveLocator(locator), "SKILL.md");
			writeFileSync(filename, "tampered", { mode: 0o600 });
			chmodSync(filename, 0o600);
			expect(() => store.verifyVersion(locator, prepared.contentHash)).toThrow("immutable version");
		} finally {
			rmSync(directory, { recursive: true, force: true });
		}
	});
});
