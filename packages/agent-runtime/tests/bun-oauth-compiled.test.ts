import { describe, expect, test } from "bun:test";
import { mkdirSync, rmSync } from "node:fs";
import { resolve } from "node:path";

const repositoryRoot = resolve(import.meta.dir, "../../..");
const fixture = resolve(import.meta.dir, "fixtures", "compiled-oauth-entry.ts");

describe("compiled Bun OAuth registration", () => {
	test("embeds the public Pi OAuth loaders before a Provider login", async () => {
		const root = resolve(process.cwd(), ".test-artifacts", `compiled-oauth-${crypto.randomUUID()}`);
		const binary = resolve(root, "compiled-oauth");
		mkdirSync(root, { recursive: true });
		try {
			const build = Bun.spawn({
				cmd: [process.execPath, "build", fixture, "--compile", "--outfile", binary],
				cwd: repositoryRoot,
				stdout: "pipe",
				stderr: "pipe",
			});
			const [buildOutput, buildError, buildExitCode] = await Promise.all([
				new Response(build.stdout).text(),
				new Response(build.stderr).text(),
				build.exited,
			]);
			expect(buildExitCode, `${buildOutput}\n${buildError}`).toBe(0);

			const run = Bun.spawn({
				cmd: [binary],
				cwd: repositoryRoot,
				stdout: "pipe",
				stderr: "pipe",
			});
			const [stdout, stderr, exitCode] = await Promise.all([
				new Response(run.stdout).text(),
				new Response(run.stderr).text(),
				run.exited,
			]);
			expect(exitCode, stderr).toBe(0);
			expect(stdout).toContain("OAUTH_LOADER_READY");
			expect(stderr).not.toContain("ERR_MODULE_NOT_FOUND");
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	}, 30_000);
});
