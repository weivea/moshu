import { describe, expect, test } from "bun:test";
import { generateKeyPairSync } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import {
	releaseArtifactManifestFilename,
	verifySignedReleaseArtifactManifest,
	writeSignedReleaseArtifactManifest,
} from "./release-artifact-manifest";

describe("signed release artifact manifest", () => {
	test("binds update metadata and the complete package to one release signature", () => {
		const directory = createArtifactDirectory();
		const keys = generateKeyPairSync("ed25519");
		try {
			const manifestPath = writeSignedReleaseArtifactManifest({
				artifactDirectory: directory,
				platform: "linux",
				arch: "x64",
				privateKey: keys.privateKey,
				publicKey: keys.publicKey,
			});
			expect(manifestPath).toBe(join(directory, releaseArtifactManifestFilename("linux", "x64")));
			expect(
				verifySignedReleaseArtifactManifest({
					manifestPath,
					artifactDirectory: directory,
					publicKey: keys.publicKey,
				}).payload.artifacts,
			).toHaveLength(2);
		} finally {
			rmSync(directory, { recursive: true, force: true });
		}
	});

	test("rejects a package modified after signing", () => {
		const directory = createArtifactDirectory();
		const keys = generateKeyPairSync("ed25519");
		try {
			const manifestPath = writeSignedReleaseArtifactManifest({
				artifactDirectory: directory,
				platform: "linux",
				arch: "x64",
				privateKey: keys.privateKey,
				publicKey: keys.publicKey,
			});
			writeFileSync(join(directory, "stable-linux-x64-Moshu.tar.zst"), "tampered");
			expect(() =>
				verifySignedReleaseArtifactManifest({
					manifestPath,
					artifactDirectory: directory,
					publicKey: keys.publicKey,
				}),
			).toThrow("artifact mismatch");
		} finally {
			rmSync(directory, { recursive: true, force: true });
		}
	});
});

function createArtifactDirectory(): string {
	const directory = mkdtempSync(join(process.cwd(), ".release-manifest-test-"));
	writeFileSync(join(directory, "stable-linux-x64-update.json"), '{"hash":"abc"}');
	writeFileSync(join(directory, "stable-linux-x64-Moshu.tar.zst"), "archive");
	return directory;
}
