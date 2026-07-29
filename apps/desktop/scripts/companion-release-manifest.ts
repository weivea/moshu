import { createHash } from "node:crypto";
import {
	chmodSync,
	closeSync,
	lstatSync,
	openSync,
	readFileSync,
	readSync,
	writeFileSync,
} from "node:fs";
import { join } from "node:path";
import {
	companionControlVersion,
	currentRuntimeBoxProtocolVersion,
	moshuReleaseVersion,
	runtimeBoxProtocolMaxVersion,
	runtimeBoxProtocolMinVersion,
} from "@moshu/contracts";
import { PROCESS_RPC_PROTOCOL_MAJOR, PROCESS_RPC_PROTOCOL_MINOR } from "@moshu/process-rpc";
import { z } from "zod";
import {
	COMPANION_EXECUTABLE_ROLES,
	companionReleaseManifestFilename,
	getCompanionExecutableFilename,
} from "../src/shared/companion-executable-names";

const protocolVersionSchema = z
	.object({ major: z.number().int(), minor: z.number().int() })
	.strict();
const companionReleaseManifestSchema = z
	.object({
		schemaVersion: z.literal(1),
		releaseVersion: z.string(),
		protocols: z
			.object({
				companionBootstrap: z.object({ version: z.number().int() }).strict(),
				processRpc: protocolVersionSchema,
				runtimeBox: z
					.object({
						current: z.number().int(),
						min: z.number().int(),
						max: z.number().int(),
					})
					.strict(),
			})
			.strict(),
		companions: z
			.array(
				z
					.object({
						role: z.enum(COMPANION_EXECUTABLE_ROLES),
						filename: z.string().min(1),
						sha256: z.string().regex(/^[a-f0-9]{64}$/),
					})
					.strict(),
			)
			.length(COMPANION_EXECUTABLE_ROLES.length),
	})
	.strict();

type CompanionReleaseManifest = z.infer<typeof companionReleaseManifestSchema>;

export function writeCompanionReleaseManifest(
	companionDirectory: string,
	platform: NodeJS.Platform,
): string {
	const manifestPath = join(companionDirectory, companionReleaseManifestFilename);
	const manifest: CompanionReleaseManifest = {
		schemaVersion: 1,
		releaseVersion: moshuReleaseVersion,
		protocols: expectedProtocols(),
		companions: COMPANION_EXECUTABLE_ROLES.map((role) => {
			const filename = getCompanionExecutableFilename(role, platform);
			return {
				role,
				filename,
				sha256: hashFile(join(companionDirectory, filename)),
			};
		}),
	};
	writeFileSync(manifestPath, `${JSON.stringify(manifest, undefined, 2)}\n`, {
		encoding: "utf8",
		mode: 0o644,
	});
	chmodSync(manifestPath, 0o644);
	return manifestPath;
}

export function verifyCompanionReleaseManifest(
	companionDirectory: string,
	platform: NodeJS.Platform,
): void {
	const manifestPath = join(companionDirectory, companionReleaseManifestFilename);
	const stats = lstatSync(manifestPath);
	if (!stats.isFile() || stats.isSymbolicLink() || stats.size > 64 * 1024) {
		throw new Error(`Invalid companion release manifest at ${manifestPath}.`);
	}

	const manifest = parseManifest(readFileSync(manifestPath, "utf8"));
	if (manifest.releaseVersion !== moshuReleaseVersion) {
		throw new Error(
			`Companion release version ${manifest.releaseVersion} does not match desktop version ${moshuReleaseVersion}.`,
		);
	}
	if (JSON.stringify(manifest.protocols) !== JSON.stringify(expectedProtocols())) {
		throw new Error(
			"Companion release manifest protocol versions do not match this desktop build.",
		);
	}

	for (const role of COMPANION_EXECUTABLE_ROLES) {
		const expectedFilename = getCompanionExecutableFilename(role, platform);
		const entry = manifest.companions.find((candidate) => candidate.role === role);
		if (entry === undefined || entry.filename !== expectedFilename) {
			throw new Error(`Companion release manifest is missing ${role}:${expectedFilename}.`);
		}
		const actualHash = hashFile(join(companionDirectory, entry.filename));
		if (actualHash !== entry.sha256) {
			throw new Error(`Packaged companion hash mismatch for ${entry.filename}.`);
		}
	}
}

function parseManifest(value: string): CompanionReleaseManifest {
	const parsed = companionReleaseManifestSchema.parse(JSON.parse(value));
	if (
		new Set(parsed.companions.map((entry) => entry.role)).size !== COMPANION_EXECUTABLE_ROLES.length
	) {
		throw new Error("Companion release manifest contains duplicate companion roles.");
	}
	return parsed;
}

function expectedProtocols(): CompanionReleaseManifest["protocols"] {
	return {
		companionBootstrap: {
			version: companionControlVersion,
		},
		processRpc: {
			major: PROCESS_RPC_PROTOCOL_MAJOR,
			minor: PROCESS_RPC_PROTOCOL_MINOR,
		},
		runtimeBox: {
			current: currentRuntimeBoxProtocolVersion,
			min: runtimeBoxProtocolMinVersion,
			max: runtimeBoxProtocolMaxVersion,
		},
	};
}

function hashFile(path: string): string {
	const stats = lstatSync(path);
	if (!stats.isFile() || stats.isSymbolicLink()) {
		throw new Error(`Expected a regular packaged companion at ${path}.`);
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
	return hash.digest("hex");
}
