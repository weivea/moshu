import { expect, test } from "bun:test";
import { projectToolInput, projectToolOutput, projectToolProgress } from "../src";

test("redacts camelCase sensitive keys recursively", () => {
	const projected = projectToolInput(
		{ kind: "mcp", name: "query", mcpServerId: "server", stableToolId: "query" },
		{
			apiKey: "secret-1",
			nested: [{ accessToken: "secret-2" }, { clientSecret: "secret-3" }],
			safe: "visible",
		},
	);

	expect(projected.value).toEqual({
		apiKey: "[redacted]",
		nested: [{ accessToken: "[redacted]" }, { clientSecret: "[redacted]" }],
		safe: "visible",
	});
	expect(projected.redactionCount).toBe(3);
});

test("redacts exact invocation Secret values from structured and text output", () => {
	const secret = "injected-value-123";
	const projected = projectToolOutput(
		{ kind: "builtin", name: "bash" },
		{
			stdout: `first ${secret} second ${secret}`,
			nested: { value: secret },
		},
		{ secretValues: [secret] },
	);

	expect(JSON.stringify(projected.value)).not.toContain(secret);
	expect(projected.redactionCount).toBe(3);
});

test("redacts short exact Secrets from object keys and values", () => {
	const projected = projectToolOutput(
		{ kind: "mcp", name: "query", mcpServerId: "server", stableToolId: "query" },
		{ xy: { value: "before-xy-after" } },
		{ secretValues: ["xy"] },
	);

	expect(JSON.stringify(projected.value)).not.toContain("xy");
	expect(projected.redactionCount).toBe(2);
});

test("uses output allowlists for edit and write Tools", () => {
	const edit = projectToolOutput(
		{ kind: "builtin", name: "edit" },
		{
			content: [{ type: "text", text: "raw file body" }],
			details: {
				diff: "--- a/file\n+++ b/file\n-old secret\n+new secret",
				patch: "*** Begin Patch\nraw patch\n*** End Patch",
				firstChangedLine: 8,
			},
		},
	);
	const write = projectToolOutput(
		{ kind: "builtin", name: "write" },
		{ content: [{ type: "text", text: "raw written body" }] },
	);

	expect(edit.value).toMatchObject({
		summary: "File edit completed.",
		changedLineCount: 2,
		firstChangedLine: 8,
	});
	expect(JSON.stringify(edit.value)).not.toContain("raw file body");
	expect(JSON.stringify(edit.value)).not.toContain("raw patch");
	expect(JSON.stringify(edit.value)).not.toContain("old secret");
	expect(write.value).toMatchObject({ summary: "File write completed." });
	expect(JSON.stringify(write.value)).not.toContain("raw written body");
});

test("uses input allowlists for edit and write Tools even when arguments are malformed", () => {
	const edit = projectToolInput(
		{ kind: "builtin", name: "edit" },
		{
			path: "/workspace/file.txt",
			edits: { oldText: "raw old body", newText: "raw new body" },
			unexpected: "raw extra body",
		},
		{ rootDirectory: "/workspace" },
	);
	const write = projectToolInput(
		{ kind: "builtin", name: "write" },
		{
			path: "/workspace/file.txt",
			content: { text: "raw written body" },
			unexpected: "raw extra body",
		},
		{ rootDirectory: "/workspace" },
	);

	expect(edit.value).toEqual({ path: "file.txt", edits: { count: 0 } });
	expect(write.value).toEqual({ path: "file.txt", content: { bytes: 0 } });
	expect(JSON.stringify(edit.value)).not.toContain("raw");
	expect(JSON.stringify(write.value)).not.toContain("raw");
});

test("uses progress allowlists for edit and write Tools", () => {
	const edit = projectToolProgress(
		{ kind: "builtin", name: "edit" },
		{ oldText: "raw old body", newText: "raw new body" },
	);
	const write = projectToolProgress(
		{ kind: "builtin", name: "write" },
		{ content: "raw written body" },
	);

	expect(edit.value).toMatchObject({ summary: "File edit in progress." });
	expect(write.value).toMatchObject({ summary: "File write in progress." });
	expect(JSON.stringify(edit.value)).not.toContain("raw");
	expect(JSON.stringify(write.value)).not.toContain("raw");
});
