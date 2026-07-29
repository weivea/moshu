import { describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { validateProjectPath } from "./project-path";

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
				normalizedPath: canonicalNested,
				displayName: "app",
				gitRootPath: canonicalProject,
				gitBranch: "runtime-box",
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
			await expect(validateProjectPath({ path: "relative/project" })).rejects.toThrow(
				"must be absolute",
			);
			await expect(validateProjectPath({ path: file })).rejects.toThrow("directory");
		} finally {
			await rm(root, { force: true, recursive: true });
		}
	});
});
