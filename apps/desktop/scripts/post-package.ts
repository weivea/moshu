import { join } from "node:path";
import { assertStableReleaseEnvironment } from "./release-gates";
import {
	verifySignedReleaseArtifactManifest,
	writeSignedReleaseArtifactManifest,
} from "./release-artifact-manifest";
import { signAndVerifyWindowsInstallerArtifact } from "./windows-package-signing";

const macVerification = Bun.spawnSync({
	cmd: [process.execPath, join(import.meta.dir, "verify-mac-package.ts")],
	env: process.env,
	stdout: "inherit",
	stderr: "inherit",
});
if (macVerification.exitCode !== 0) {
	throw new Error(`macOS package verification failed with exit code ${macVerification.exitCode}.`);
}

if (process.env.MOSHU_STABLE_RELEASE === "1") {
	const credentials = assertStableReleaseEnvironment(process.env, process.platform);
	const artifactDirectory = requireEnvironment("ELECTROBUN_ARTIFACT_DIR");
	const platform = parsePlatform(requireEnvironment("ELECTROBUN_OS"));
	const arch = requireEnvironment("ELECTROBUN_ARCH");
	if (platform === "win") {
		signAndVerifyWindowsInstallerArtifact({
			artifactDirectory,
			arch,
			certificateSha1: requireEnvironment("MOSHU_WINDOWS_CERT_SHA1"),
			timestampUrl: requireEnvironment("MOSHU_WINDOWS_TIMESTAMP_URL"),
		});
	}
	const manifestPath = writeSignedReleaseArtifactManifest({
		artifactDirectory,
		platform,
		arch,
		privateKey: credentials.updatePrivateKey,
		publicKey: credentials.updatePublicKey,
	});
	verifySignedReleaseArtifactManifest({
		manifestPath,
		artifactDirectory,
		publicKey: credentials.updatePublicKey,
	});
	console.info(`Signed and verified stable update artifacts in ${artifactDirectory}.`);
}

function parsePlatform(value: string): "macos" | "win" | "linux" {
	if (value === "macos" || value === "win" || value === "linux") {
		return value;
	}
	throw new Error(`Unsupported stable release platform: ${value}`);
}

function requireEnvironment(name: string): string {
	const value = process.env[name]?.trim();
	if (!value) {
		throw new Error(`${name} is required by the package verification hook.`);
	}
	return value;
}
