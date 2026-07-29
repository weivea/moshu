import { createHash, sign, verify, type KeyObject } from "node:crypto";
import {
	closeSync,
	lstatSync,
	openSync,
	readFileSync,
	readSync,
	readdirSync,
	writeFileSync,
} from "node:fs";
import { basename, join } from "node:path";
import { moshuReleaseVersion } from "@moshu/contracts";
import { z } from "zod";

const artifactSchema = z
	.object({
		filename: z.string().min(1),
		bytes: z.number().int().nonnegative().safe(),
		sha256: z.string().regex(/^[a-f0-9]{64}$/),
	})
	.strict();

const payloadSchema = z
	.object({
		schemaVersion: z.literal(1),
		releaseVersion: z.literal(moshuReleaseVersion),
		channel: z.literal("stable"),
		platform: z.enum(["macos", "win", "linux"]),
		arch: z.string().min(1).max(32),
		keyId: z.string().regex(/^[a-f0-9]{32}$/),
		artifacts: z.array(artifactSchema).min(2),
	})
	.strict();

const manifestSchema = z
	.object({
		payload: payloadSchema,
		signature: z
			.string()
			.min(64)
			.max(256)
			.regex(/^[A-Za-z0-9_-]+$/),
	})
	.strict();

export type SignedReleaseArtifactManifest = z.infer<typeof manifestSchema>;

export function releaseArtifactManifestFilename(platform: string, arch: string): string {
	return `stable-${platform}-${arch}-moshu-update-manifest.json`;
}

export function writeSignedReleaseArtifactManifest(options: {
	artifactDirectory: string;
	platform: "macos" | "win" | "linux";
	arch: string;
	privateKey: KeyObject;
	publicKey: KeyObject;
}): string {
	const prefix = `stable-${options.platform}-${options.arch}-`;
	const manifestFilename = releaseArtifactManifestFilename(options.platform, options.arch);
	const artifactFilenames = readdirSync(options.artifactDirectory)
		.filter((filename) => filename.startsWith(prefix) && filename !== manifestFilename)
		.sort();
	if (
		!artifactFilenames.some((filename) => filename.endsWith("-update.json")) ||
		!artifactFilenames.some((filename) => filename.endsWith(".tar.zst"))
	) {
		throw new Error(
			"Stable release output must contain update metadata and a full update archive.",
		);
	}
	const payload = payloadSchema.parse({
		schemaVersion: 1,
		releaseVersion: moshuReleaseVersion,
		channel: "stable",
		platform: options.platform,
		arch: options.arch,
		keyId: publicKeyId(options.publicKey),
		artifacts: artifactFilenames.map((filename) =>
			describeArtifact(options.artifactDirectory, filename),
		),
	});
	const signature = sign(undefined, canonicalPayload(payload), options.privateKey).toString(
		"base64url",
	);
	const manifestPath = join(options.artifactDirectory, manifestFilename);
	writeFileSync(manifestPath, `${JSON.stringify({ payload, signature }, undefined, 2)}\n`, {
		encoding: "utf8",
		mode: 0o644,
	});
	return manifestPath;
}

export function verifySignedReleaseArtifactManifest(options: {
	manifestPath: string;
	artifactDirectory: string;
	publicKey: KeyObject;
}): SignedReleaseArtifactManifest {
	const manifestStats = lstatSync(options.manifestPath);
	if (
		!manifestStats.isFile() ||
		manifestStats.isSymbolicLink() ||
		manifestStats.size > 256 * 1024
	) {
		throw new Error("Signed update manifest must be a bounded regular file.");
	}
	const manifest = manifestSchema.parse(JSON.parse(readFileSync(options.manifestPath, "utf8")));
	if (manifest.payload.keyId !== publicKeyId(options.publicKey)) {
		throw new Error("Signed update manifest was produced by an unexpected key.");
	}
	if (
		!verify(
			undefined,
			canonicalPayload(manifest.payload),
			options.publicKey,
			Buffer.from(manifest.signature, "base64url"),
		)
	) {
		throw new Error("Signed update manifest signature is invalid.");
	}
	for (const artifact of manifest.payload.artifacts) {
		if (basename(artifact.filename) !== artifact.filename) {
			throw new Error("Signed update manifest contains an invalid artifact filename.");
		}
		const actual = describeArtifact(options.artifactDirectory, artifact.filename);
		if (actual.bytes !== artifact.bytes || actual.sha256 !== artifact.sha256) {
			throw new Error(`Signed update artifact mismatch for ${artifact.filename}.`);
		}
	}
	return manifest;
}

function canonicalPayload(payload: z.infer<typeof payloadSchema>): Buffer {
	return Buffer.from(JSON.stringify(payload), "utf8");
}

function publicKeyId(publicKey: KeyObject): string {
	return createHash("sha256")
		.update(publicKey.export({ format: "der", type: "spki" }))
		.digest("hex")
		.slice(0, 32);
}

function describeArtifact(directory: string, filename: string) {
	const path = join(directory, filename);
	const stats = lstatSync(path);
	if (!stats.isFile() || stats.isSymbolicLink()) {
		throw new Error(`Release artifact must be a regular file: ${filename}`);
	}
	const hash = createHash("sha256");
	const descriptor = openSync(path, "r");
	const buffer = Buffer.allocUnsafe(1024 * 1024);
	try {
		for (;;) {
			const bytesRead = readSync(descriptor, buffer, 0, buffer.byteLength, null);
			if (bytesRead === 0) {
				break;
			}
			hash.update(buffer.subarray(0, bytesRead));
		}
	} finally {
		closeSync(descriptor);
	}
	return {
		filename,
		bytes: stats.size,
		sha256: hash.digest("hex"),
	};
}
