import { afterEach, describe, expect, test } from "bun:test";
import {
	getExecutorToolBinaryFilename,
	type ExecutorToolCall,
	type ExecutorToolInvokeInput,
} from "@moshu/contracts";
import {
	lstat,
	mkdtemp,
	mkdir,
	open,
	readFile,
	readdir,
	rm,
	stat,
	symlink,
	writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { atomicWriteFile } from "./atomic-write";
import { MAX_EDIT_FILE_BYTES } from "./edit";
import { withFileMutationQueue } from "./file-mutation-queue";
import { MAX_IMAGE_PIXELS, processImage } from "./image";
import { ExecutorToolRuntime } from "./index";
import { MAX_TOTAL_RETAINED_OUTPUT_BYTES, OutputAccumulator } from "./output-accumulator";
import { loadPhoton } from "./photon";

const temporaryDirectories: string[] = [];
const binaryDirectory = resolve(import.meta.dir, "..", "..", "dist");
const runtime = new ExecutorToolRuntime({
	rg: join(binaryDirectory, getExecutorToolBinaryFilename("rg")),
	fd: join(binaryDirectory, getExecutorToolBinaryFilename("fd")),
});
let invocationSequence = 0;

afterEach(async () => {
	await Promise.all(
		temporaryDirectories.splice(0).map((path) => rm(path, { recursive: true, force: true })),
	);
});

async function createWorkspace(): Promise<string> {
	const path = await mkdtemp(join(tmpdir(), "moshu-executor-tools-"));
	temporaryDirectories.push(path);
	return path;
}

async function invoke(cwd: string, call: ExecutorToolCall, signal?: AbortSignal) {
	invocationSequence += 1;
	const input: ExecutorToolInvokeInput = {
		schemaVersion: 1,
		invocationId: crypto.randomUUID(),
		runId: "018f47a2-9bcd-7def-8abc-1234567890ab",
		toolCallId: `tool-call-${invocationSequence}`,
		cwd,
		call,
	};
	return runtime.execute(input, signal ? { signal } : {});
}

describe("executor filesystem tools", () => {
	test("write, read, edit, grep, find, and ls share Pi-compatible path semantics", async () => {
		const cwd = await createWorkspace();
		await mkdir(join(cwd, ".hidden"), { recursive: true });
		await invoke(cwd, {
			tool: "write",
			arguments: {
				path: "src/example.ts",
				content: 'export const value = "needle";\n',
			},
		});
		await invoke(cwd, {
			tool: "write",
			arguments: { path: ".hidden/value.txt", content: "hidden\n" },
		});

		const read = await invoke(cwd, {
			tool: "read",
			arguments: { path: "src/example.ts" },
		});
		expect(read.tool).toBe("read");
		expect(read.content[0]).toEqual({
			type: "text",
			text: 'export const value = "needle";\n',
		});

		const edit = await invoke(cwd, {
			tool: "edit",
			arguments: {
				path: "src/example.ts",
				edits: [{ oldText: '"needle"', newText: '"changed"' }],
			},
		});
		expect(edit.tool).toBe("edit");
		if (edit.tool !== "edit") throw new Error("Expected edit result.");
		expect(edit.content[0]?.text).toContain('+1 export const value = "changed";');
		expect(await readFile(join(cwd, "src/example.ts"), "utf8")).toContain("changed");

		const grep = await invoke(cwd, {
			tool: "grep",
			arguments: { pattern: "changed", path: ".", glob: "*.ts", literal: true },
		});
		expect(grep.tool).toBe("grep");
		if (grep.tool !== "grep") throw new Error("Expected grep result.");
		expect(grep.content[0]?.text).toContain("src/example.ts:1:");

		const find = await invoke(cwd, {
			tool: "find",
			arguments: { pattern: "src/**/*.ts" },
		});
		expect(find.tool).toBe("find");
		if (find.tool !== "find") throw new Error("Expected find result.");
		expect(find.content[0]?.text).toContain("src/example.ts");

		const ls = await invoke(cwd, {
			tool: "ls",
			arguments: { path: "." },
		});
		expect(ls.tool).toBe("ls");
		if (ls.tool !== "ls") throw new Error("Expected ls result.");
		expect(ls.content[0]?.text).toContain(".hidden/");
		expect(ls.content[0]?.text).toContain("src/");
	});

	test("edit fuzzy-matches Unicode punctuation and trailing whitespace atomically", async () => {
		const cwd = await createWorkspace();
		const path = join(cwd, "notes.txt");
		await writeFile(path, "title: \u201cvalue\u201d   \nsecond line\n", "utf8");

		await invoke(cwd, {
			tool: "edit",
			arguments: {
				path: "notes.txt",
				edits: [{ oldText: 'title: "value"\n', newText: 'title: "updated"\n' }],
			},
		});
		expect(await readFile(path, "utf8")).toBe('title: "updated"\nsecond line\n');

		await expect(
			invoke(cwd, {
				tool: "edit",
				arguments: {
					path: "notes.txt",
					edits: [
						{ oldText: "updated", newText: "changed" },
						{ oldText: "missing", newText: "never-written" },
					],
				},
			}),
		).rejects.toThrow("Could not find");
		expect(await readFile(path, "utf8")).toBe('title: "updated"\nsecond line\n');
	});

	test("edit atomically commits a contract-bounded diff and preserves file mode", async () => {
		const cwd = await createWorkspace();
		const path = join(cwd, "large-line.txt");
		await writeFile(path, `${"a".repeat(300 * 1024)}\n`, { encoding: "utf8", mode: 0o640 });

		const result = await invoke(cwd, {
			tool: "edit",
			arguments: {
				path: "large-line.txt",
				edits: [{ oldText: "a".repeat(300 * 1024), newText: "b".repeat(300 * 1024) }],
			},
		});
		if (result.tool !== "edit") throw new Error("Expected edit result.");
		expect(result.content[0]?.text).toContain("[edit diff truncated]");
		expect(Buffer.byteLength(result.details.diff, "utf8")).toBeLessThanOrEqual(1024 * 1024);
		expect(await readFile(path, "utf8")).toBe(`${"b".repeat(300 * 1024)}\n`);
		if (process.platform !== "win32") {
			expect((await stat(path)).mode & 0o777).toBe(0o640);
		}
	});

	test("serializes missing-file writes through symlinked parent aliases", async () => {
		const cwd = await createWorkspace();
		const realDirectory = join(cwd, "real");
		const aliasDirectory = join(cwd, "alias");
		await mkdir(realDirectory);
		await symlink(realDirectory, aliasDirectory, process.platform === "win32" ? "junction" : "dir");
		const firstContent = "a".repeat(512 * 1024);
		const secondContent = "b".repeat(512 * 1024);

		await Promise.all([
			invoke(cwd, {
				tool: "write",
				arguments: { path: "alias/new.txt", content: firstContent },
			}),
			invoke(cwd, {
				tool: "write",
				arguments: { path: "real/new.txt", content: secondContent },
			}),
		]);
		const output = await readFile(join(realDirectory, "new.txt"), "utf8");
		expect([firstContent, secondContent]).toContain(output);
	});

	test("keeps the mutation lock stable across atomic inode replacement", async () => {
		const cwd = await createWorkspace();
		const path = join(cwd, "stable-lock.txt");
		await writeFile(path, "before", "utf8");
		const replaced = Promise.withResolvers<void>();
		const release = Promise.withResolvers<void>();
		const first = withFileMutationQueue(path, async (canonicalPath) => {
			await atomicWriteFile(canonicalPath, "after");
			replaced.resolve();
			await release.promise;
		});
		await replaced.promise;
		let secondEntered = false;
		const second = withFileMutationQueue(path, async () => {
			secondEntered = true;
		});
		await Bun.sleep(20);
		expect(secondEntered).toBe(false);
		release.resolve();
		await Promise.all([first, second]);
		expect(secondEntered).toBe(true);
	});

	test.skipIf(process.platform === "win32")(
		"writes through a dangling symlink without replacing the link",
		async () => {
			const cwd = await createWorkspace();
			await symlink("target.txt", join(cwd, "link.txt"));
			await invoke(cwd, {
				tool: "write",
				arguments: { path: "link.txt", content: "through-link" },
			});
			expect((await lstat(join(cwd, "link.txt"))).isSymbolicLink()).toBe(true);
			expect(await readFile(join(cwd, "target.txt"), "utf8")).toBe("through-link");
		},
	);

	test("rejects edit targets above the explicit in-memory processing limit", async () => {
		const cwd = await createWorkspace();
		const path = join(cwd, "oversized-edit.txt");
		const file = await open(path, "w");
		try {
			await file.write("keep", 0, "utf8");
			await file.truncate(MAX_EDIT_FILE_BYTES + 1);
		} finally {
			await file.close();
		}
		await expect(
			invoke(cwd, {
				tool: "edit",
				arguments: {
					path: "oversized-edit.txt",
					edits: [{ oldText: "keep", newText: "changed" }],
				},
			}),
		).rejects.toThrow("edit limit");
		expect((await stat(path)).size).toBe(MAX_EDIT_FILE_BYTES + 1);
	});

	test("read returns bounded head output and a continuation offset", async () => {
		const cwd = await createWorkspace();
		await writeFile(
			join(cwd, "large.txt"),
			Array.from({ length: 2_500 }, (_, index) => `line ${index + 1}`).join("\n"),
			"utf8",
		);
		const result = await invoke(cwd, {
			tool: "read",
			arguments: { path: "large.txt" },
		});
		expect(result.tool).toBe("read");
		if (result.tool !== "read") throw new Error("Expected read result.");
		expect(result.details?.truncation?.truncated).toBe(true);
		const content = result.content[0];
		if (content?.type !== "text") throw new Error("Expected text read content.");
		expect(content.text).toContain("Use offset=2001 to continue");
		expect(content.text).not.toContain("line 2001");
	});

	test("read streams a small range from a sparse multi-gigabyte text file", async () => {
		const cwd = await createWorkspace();
		const path = join(cwd, "sparse.txt");
		const handle = await open(path, "w");
		try {
			await handle.write("first\nsecond\n", 0, "utf8");
			await handle.write("end", 2 * 1024 * 1024 * 1024, "utf8");
		} finally {
			await handle.close();
		}

		const result = await invoke(cwd, {
			tool: "read",
			arguments: { path: "sparse.txt", limit: 1 },
		});
		if (result.tool !== "read" || result.content[0]?.type !== "text") {
			throw new Error("Expected text read result.");
		}
		expect(result.content[0].text).toContain("first");
	});

	test("find reports exact full-result byte totals after truncating retained output", async () => {
		const cwd = await createWorkspace();
		const filenames = Array.from(
			{ length: 300 },
			(_, index) => `${index.toString().padStart(3, "0")}-${"x".repeat(220)}.txt`,
		);
		await Promise.all(filenames.map((filename) => writeFile(join(cwd, filename), "", "utf8")));

		const result = await invoke(cwd, {
			tool: "find",
			arguments: { pattern: "*.txt" },
		});
		expect(result.tool).toBe("find");
		if (result.tool !== "find") throw new Error("Expected find result.");
		expect(result.details?.truncation).toMatchObject({
			truncated: true,
			totalLines: filenames.length,
			totalBytes: Buffer.byteLength(filenames.join("\n"), "utf8"),
		});
	});

	test("read supports JPEG, PNG, GIF, WebP, and BMP by magic bytes", async () => {
		const cwd = await createWorkspace();
		const pngBytes = Buffer.from(
			"iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=",
			"base64",
		);
		await writeFile(join(cwd, "pixel.png"), pngBytes);
		const photon = await loadPhoton();
		const photonImage = photon.PhotonImage.new_from_byteslice(pngBytes);
		try {
			await writeFile(join(cwd, "pixel.jpg"), photonImage.get_bytes_jpeg(80));
			await writeFile(join(cwd, "pixel.webp"), photonImage.get_bytes_webp());
		} finally {
			photonImage.free();
		}
		await writeFile(
			join(cwd, "pixel.gif"),
			Buffer.from("R0lGODlhAQABAIAAAAAAAP///ywAAAAAAQABAAACAUwAOw==", "base64"),
		);
		await writeFile(join(cwd, "pixel.bmp"), createOnePixelBmp());

		for (const [filename, mimeType] of [
			["pixel.jpg", "image/jpeg"],
			["pixel.png", "image/png"],
			["pixel.gif", "image/gif"],
			["pixel.webp", "image/webp"],
		] as const) {
			const result = await invoke(cwd, {
				tool: "read",
				arguments: { path: filename },
			});
			if (result.tool !== "read") throw new Error("Expected read result.");
			expect(result.content[1]).toMatchObject({ type: "image", mimeType });
		}

		const bmp = await invoke(cwd, {
			tool: "read",
			arguments: { path: "pixel.bmp" },
		});
		expect(bmp.tool).toBe("read");
		expect(bmp.content[1]?.type).toBe("image");
		if (bmp.content[1]?.type === "image") {
			expect(["image/png", "image/jpeg"]).toContain(bmp.content[1].mimeType);
		}
	});

	test("read resizes extreme-aspect-ratio images without producing a zero dimension", async () => {
		const cwd = await createWorkspace();
		const photon = await loadPhoton();
		const image = new photon.PhotonImage(new Uint8Array(5_000 * 4), 5_000, 1);
		try {
			await writeFile(join(cwd, "wide.png"), image.get_bytes());
		} finally {
			image.free();
		}
		const result = await invoke(cwd, {
			tool: "read",
			arguments: { path: "wide.png" },
		});
		if (result.tool !== "read" || result.content[1]?.type !== "image") {
			throw new Error("Expected image read result.");
		}
		const note = result.content[0];
		if (note?.type !== "text") throw new Error("Expected image note.");
		expect(note.text).toContain("resized to 2000x1");
	});

	test("rejects compressed image headers whose decoded pixel count exceeds the limit", async () => {
		const header = Buffer.alloc(24);
		Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(header);
		header.write("IHDR", 12, "ascii");
		const dimension = Math.ceil(Math.sqrt(MAX_IMAGE_PIXELS + 1));
		header.writeUInt32BE(dimension, 16);
		header.writeUInt32BE(dimension, 20);
		await expect(processImage(header, "image/png")).rejects.toThrow(
			"exceed the executor decode limit",
		);
	});

	test("grep bounds context collection for large files and context windows", async () => {
		const cwd = await createWorkspace();
		const lines = Array.from({ length: 20_000 }, (_, index) =>
			index === 10_000 ? "needle" : `line ${index}`,
		);
		await writeFile(join(cwd, "context.txt"), lines.join("\n"), "utf8");
		const result = await invoke(cwd, {
			tool: "grep",
			arguments: { pattern: "needle", path: "context.txt", context: 10_000, limit: 1 },
		});
		if (result.tool !== "grep") throw new Error("Expected grep result.");
		expect(result.content[0]?.text).toContain("context.txt:10001: needle");
		expect(result.details?.truncation?.truncated).toBe(true);
	});
});

describe("executor bash tool", () => {
	test("inherits the executor environment, streams progress, and merges stdout/stderr", async () => {
		const cwd = await createWorkspace();
		const previous = process.env.MOSHU_EXECUTOR_TOOL_TEST;
		process.env.MOSHU_EXECUTOR_TOOL_TEST = "inherited-value";
		const progress: string[] = [];
		try {
			invocationSequence += 1;
			const result = await runtime.execute(
				{
					schemaVersion: 1,
					invocationId: crypto.randomUUID(),
					runId: "018f47a2-9bcd-7def-8abc-1234567890ab",
					toolCallId: `tool-call-${invocationSequence}`,
					cwd,
					call: {
						tool: "bash",
						arguments: {
							command:
								'printf "%s\\n" "$MOSHU_EXECUTOR_TOOL_TEST"; sleep 0.2; printf "stderr-line\\n" >&2',
						},
					},
				},
				{
					onProgress: (event) => {
						progress.push(event.content[0]?.text ?? "");
					},
				},
			);
			expect(result.tool).toBe("bash");
			if (result.tool !== "bash") throw new Error("Expected bash result.");
			expect(result.content[0]?.text).toContain("inherited-value");
			expect(result.content[0]?.text).toContain("stderr-line");
			expect(progress.some((text) => text.includes("inherited-value"))).toBe(true);
		} finally {
			if (previous === undefined) {
				delete process.env.MOSHU_EXECUTOR_TOOL_TEST;
			} else {
				process.env.MOSHU_EXECUTOR_TOOL_TEST = previous;
			}
		}
	});

	test("surfaces non-zero exit codes as tool failures", async () => {
		const cwd = await createWorkspace();
		await expect(
			invoke(cwd, {
				tool: "bash",
				arguments: { command: 'printf "failure-output"; exit 7' },
			}),
		).rejects.toThrow("Command exited with code 7");
	});

	test("preserves the retained-output path for command failures", async () => {
		const cwd = await createWorkspace();
		let failure: Error | undefined;
		try {
			await invoke(cwd, {
				tool: "bash",
				arguments: {
					command: "for i in {1..60000}; do printf x; done; exit 9",
				},
			});
		} catch (error) {
			failure = error instanceof Error ? error : new Error(String(error));
		}
		expect(failure?.message).toContain("Command exited with code 9");
		const fullOutputPath = failure?.message.match(/Full output: ([^\n]+)/)?.[1];
		if (fullOutputPath === undefined) {
			throw new Error("Expected the failure to expose its retained-output path.");
		}
		expect((await readFile(fullOutputPath)).byteLength).toBe(60_000);
		await rm(fullOutputPath);
	});

	test("retains full bash output when only the line limit is exceeded", async () => {
		const cwd = await createWorkspace();
		const result = await invoke(cwd, {
			tool: "bash",
			arguments: { command: 'for i in {1..2501}; do printf "x\\n"; done' },
		});
		if (result.tool !== "bash") throw new Error("Expected bash result.");
		expect(result.details?.truncation?.truncatedBy).toBe("lines");
		const fullOutputPath = result.details?.fullOutputPath;
		if (fullOutputPath === undefined) {
			throw new Error("Expected a retained full-output path.");
		}
		expect((await readFile(fullOutputPath, "utf8")).split("\n")).toHaveLength(2_502);
		if (process.platform !== "win32") {
			expect((await stat(fullOutputPath)).mode & 0o777).toBe(0o600);
			expect((await stat(dirname(fullOutputPath))).mode & 0o777).toBe(0o700);
		}
		await rm(fullOutputPath);
	});

	test("honors retained-output backpressure without dropping bytes", async () => {
		const cwd = await createWorkspace();
		const result = await invoke(cwd, {
			tool: "bash",
			arguments: {
				command:
					'chunk=xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx; for i in {1..16384}; do printf %s "$chunk"; done',
			},
		});
		if (result.tool !== "bash") throw new Error("Expected bash result.");
		const fullOutputPath = result.details?.fullOutputPath;
		if (fullOutputPath === undefined) {
			throw new Error("Expected a retained full-output path.");
		}
		const output = await readFile(fullOutputPath);
		expect(output.byteLength).toBe(1024 * 1024);
		expect(output.every((value) => value === 0x78)).toBe(true);
		await rm(fullOutputPath);
	});

	test("rejects retained output beyond its explicit resource cap", () => {
		const accumulator = new OutputAccumulator({ maxRetainedBytes: 16 });
		expect(() => accumulator.append("x".repeat(17))).toThrow(
			"exceeded the 16-byte retained-output limit",
		);
	});

	test("enforces the aggregate retained-output directory quota", async () => {
		const modulePath = join(import.meta.dir, "output-accumulator.ts");
		const script = `
			import { mkdir, open, rm } from "node:fs/promises";
			import { tmpdir } from "node:os";
			import { join } from "node:path";
			const outputDirectory = join(
				tmpdir(),
				"moshu-executor-tool-output-" + (process.getuid?.() ?? "user"),
			);
			await mkdir(outputDirectory, { recursive: true, mode: 0o700 });
			const seedPath = join(outputDirectory, "quota-seed-" + crypto.randomUUID());
			const seed = await open(seedPath, "w", 0o600);
			await seed.truncate(${MAX_TOTAL_RETAINED_OUTPUT_BYTES - 1});
			await seed.close();
			try {
				const { OutputAccumulator } = await import(${JSON.stringify(modulePath)});
				const accumulator = new OutputAccumulator();
				let message = "";
				try {
					accumulator.append("x".repeat(51 * 1024));
				} catch (error) {
					message = error instanceof Error ? error.message : String(error);
				}
				if (!message.includes("retained-output directory would exceed")) {
					throw new Error("Expected aggregate quota failure, received: " + message);
				}
			} finally {
				await rm(seedPath, { force: true });
			}
		`;
		const child = Bun.spawn([process.execPath, "-e", script], {
			cwd: import.meta.dir,
			stdout: "pipe",
			stderr: "pipe",
		});
		const [exitCode, stderr] = await Promise.all([child.exited, new Response(child.stderr).text()]);
		expect(stderr).toBe("");
		expect(exitCode).toBe(0);
	});

	test("preserves UTF-8 characters split across process output chunks", async () => {
		const cwd = await createWorkspace();
		const result = await invoke(cwd, {
			tool: "bash",
			arguments: {
				command: "printf '\\342'; sleep 0.05; printf '\\202'; sleep 0.05; printf '\\254\\n'",
			},
		});
		if (result.tool !== "bash") throw new Error("Expected bash result.");
		expect(result.content[0]?.text).toBe("€\n");
	});

	test.skipIf(process.platform === "win32")(
		"cleans background descendants after a successful shell exit",
		async () => {
			const cwd = await createWorkspace();
			const result = await invoke(cwd, {
				tool: "bash",
				arguments: {
					command: 'sleep 30 >/dev/null 2>&1 & child=$!; printf "%s" "$child"',
				},
			});
			if (result.tool !== "bash") throw new Error("Expected bash result.");
			const childPid = Number.parseInt(result.content[0]?.text ?? "", 10);
			expect(childPid).toBeGreaterThan(0);
			expect(isProcessRunning(childPid)).toBe(false);
		},
	);

	test.skipIf(process.platform === "win32")(
		"cancellation terminates the complete Unix process group",
		async () => {
			const cwd = await createWorkspace();
			const outputDirectory = join(
				tmpdir(),
				`moshu-executor-tool-output-${process.getuid?.() ?? "user"}`,
			);
			const outputsBefore = new Set(await readdir(outputDirectory));
			const controller = new AbortController();
			const run = invoke(
				cwd,
				{
					tool: "bash",
					arguments: {
						command:
							'for i in {1..60000}; do printf x; done; sleep 30 & child=$!; printf "%s" "$child" > child.pid; wait "$child"',
					},
				},
				controller.signal,
			);
			const childPidPath = join(cwd, "child.pid");
			await waitForFile(childPidPath);
			const childPid = Number.parseInt(await readFile(childPidPath, "utf8"), 10);
			await Bun.sleep(50);
			controller.abort(new Error("cancelled by test"));
			await expect(run).rejects.toThrow("cancelled by test");
			await Bun.sleep(300);
			expect(isProcessRunning(childPid)).toBe(false);
			expect(new Set(await readdir(outputDirectory))).toEqual(outputsBefore);
		},
	);
});

function createOnePixelBmp(): Buffer {
	const buffer = Buffer.alloc(58);
	buffer.write("BM", 0, "ascii");
	buffer.writeUInt32LE(buffer.length, 2);
	buffer.writeUInt32LE(54, 10);
	buffer.writeUInt32LE(40, 14);
	buffer.writeInt32LE(1, 18);
	buffer.writeInt32LE(1, 22);
	buffer.writeUInt16LE(1, 26);
	buffer.writeUInt16LE(24, 28);
	buffer.writeUInt32LE(4, 34);
	buffer[54] = 0;
	buffer[55] = 0;
	buffer[56] = 255;
	return buffer;
}

async function waitForFile(path: string): Promise<void> {
	const deadline = Date.now() + 2_000;
	while (Date.now() < deadline) {
		try {
			await readFile(path);
			return;
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
				throw error;
			}
			await Bun.sleep(20);
		}
	}
	throw new Error(`Timed out waiting for ${path}`);
}

function isProcessRunning(pid: number): boolean {
	try {
		process.kill(pid, 0);
		return true;
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ESRCH") {
			return false;
		}
		throw error;
	}
}
