import { describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { readProjectRootAgents, validateProjectPath } from "./project-path";

describe("Runtime Box Project path validation", () => {
	test("normalizes a readable directory and reports Git metadata", async () => {
		const root = await mkdtemp(join(tmpdir(), "moshu-project-"));
		try {
			const project = resolve(root, "workspace");
			const nested = resolve(project, "packages", "app");
			await mkdir(resolve(project, ".git"), { recursive: true });
			await mkdir(nested, { recursive: true });
			await writeFile(resolve(project, ".git", "HEAD"), "ref: refs/heads/runtime-box\n");
			const link = resolve(root, "linked-workspace");
			await symlink(nested, link);
			const canonicalNested = await realpath(nested);
			const canonicalProject = await realpath(project);

			await expect(validateProjectPath({ path: link })).resolves.toEqual({
				status: "available",
				normalizedPath: canonicalNested,
				displayName: "app",
				gitRootPath: canonicalProject,
				gitBranch: "runtime-box",
				rootAgents: { status: "missing" },
				confirmationToken: expect.stringMatching(/^[a-f0-9]{64}$/),
			});
		} finally {
			await rm(root, { force: true, recursive: true });
		}
	});

	test("rejects relative paths and regular files", async () => {
		const root = await mkdtemp(join(tmpdir(), "moshu-project-"));
		try {
			const file = resolve(root, "file.txt");
			await writeFile(file, "not a project");
			await expect(validateProjectPath({ path: "relative/project" })).resolves.toEqual({
				status: "unavailable",
				issueCode: "not_absolute",
			});
			await expect(validateProjectPath({ path: file })).resolves.toEqual({
				status: "unavailable",
				issueCode: "not_directory",
			});
		} finally {
			await rm(root, { force: true, recursive: true });
		}
	});

	test("reports root AGENTS.md metadata without returning its body", async () => {
		const root = await mkdtemp(join(tmpdir(), "moshu-project-"));
		try {
			const body = "private root instructions";
			await writeFile(resolve(root, "AGENTS.md"), body);
			const first = await validateProjectPath({ path: root });
			const second = await validateProjectPath({ path: root });
			expect(first).toEqual(second);
			expect(first).toMatchObject({
				status: "available",
				rootAgents: {
					status: "available",
					sizeBytes: Buffer.byteLength(body),
					modifiedAt: expect.any(String),
				},
			});
			expect(JSON.stringify(first)).not.toContain(body);
		} finally {
			await rm(root, { force: true, recursive: true });
		}
	});

	test("reports symlink and oversized root AGENTS.md warnings", async () => {
		const root = await mkdtemp(join(tmpdir(), "moshu-project-"));
		try {
			const target = resolve(root, "instructions.md");
			const agents = resolve(root, "AGENTS.md");
			await writeFile(target, "instructions");
			await symlink(target, agents);
			await expect(validateProjectPath({ path: root })).resolves.toMatchObject({
				status: "available",
				rootAgents: { status: "warning", issueCode: "not_regular_file" },
			});
			await rm(agents);
			await writeFile(agents, "x".repeat(64 * 1_024 + 1));
			await expect(validateProjectPath({ path: root })).resolves.toMatchObject({
				status: "available",
				rootAgents: { status: "warning", issueCode: "too_large" },
			});
		} finally {
			await rm(root, { force: true, recursive: true });
		}
	});

	test("reports invalid UTF-8 root AGENTS.md during preview without returning its body", async () => {
		const root = await mkdtemp(join(tmpdir(), "moshu-project-"));
		try {
			await writeFile(resolve(root, "AGENTS.md"), Buffer.from([0x66, 0x6f, 0x80]));
			const preview = await validateProjectPath({ path: root });

			expect(preview).toMatchObject({
				status: "available",
				rootAgents: { status: "warning", issueCode: "invalid_utf8" },
			});
			expect(JSON.stringify(preview)).not.toContain("body");
		} finally {
			await rm(root, { force: true, recursive: true });
		}
	});

	test("strictly loads only a bounded UTF-8 root AGENTS.md file", async () => {
		const root = await mkdtemp(join(tmpdir(), "moshu-project-"));
		try {
			const agents = resolve(root, "AGENTS.md");
			await expect(readProjectRootAgents({ projectPath: root })).resolves.toEqual({
				status: "missing",
			});
			await writeFile(agents, "Use the Project conventions.");
			await expect(readProjectRootAgents({ projectPath: root })).resolves.toEqual({
				status: "loaded",
				body: "Use the Project conventions.",
			});
			await rm(agents);
			await mkdir(agents);
			await expect(readProjectRootAgents({ projectPath: root })).resolves.toEqual({
				status: "warning",
				issueCode: "not_regular_file",
			});
			await rm(agents, { recursive: true });
			await writeFile(agents, Buffer.from([0xff, 0xfe]));
			await expect(readProjectRootAgents({ projectPath: root })).resolves.toEqual({
				status: "warning",
				issueCode: "invalid_utf8",
			});
			await writeFile(agents, "x".repeat(64 * 1_024 + 1));
			await expect(readProjectRootAgents({ projectPath: root })).resolves.toEqual({
				status: "warning",
				issueCode: "too_large",
			});
			await rm(agents);
			const target = resolve(root, "instructions.md");
			await writeFile(target, "must not follow");
			await symlink(target, agents);
			await expect(readProjectRootAgents({ projectPath: root })).resolves.toEqual({
				status: "warning",
				issueCode: "not_regular_file",
			});
		} finally {
			await rm(root, { force: true, recursive: true });
		}
	});

	test("honors cancellation before reading root AGENTS.md", async () => {
		const controller = new AbortController();
		controller.abort(new Error("cancelled"));
		await expect(
			readProjectRootAgents({ projectPath: resolve(".") }, controller.signal),
		).rejects.toThrow("cancelled");
	});
});
