import { createPrivateKey, createPublicKey, sign, verify, type KeyObject } from "node:crypto";

export interface StableReleaseCredentials {
	updatePrivateKey: KeyObject;
	updatePublicKey: KeyObject;
}

export function assertStableReleaseEnvironment(
	environment: NodeJS.ProcessEnv,
	platform: NodeJS.Platform,
): StableReleaseCredentials {
	const appIdentifier = required(environment, "MOSHU_APP_IDENTIFIER");
	if (
		!appIdentifier.includes(".") ||
		appIdentifier === "dev.moshu.app" ||
		!/^[A-Za-z0-9]+(?:[.-][A-Za-z0-9]+)+$/.test(appIdentifier)
	) {
		throw new Error("MOSHU_APP_IDENTIFIER must be a permanent reverse-DNS application ID.");
	}
	const releaseBaseUrl = new URL(required(environment, "MOSHU_RELEASE_BASE_URL"));
	if (releaseBaseUrl.protocol !== "https:") {
		throw new Error("MOSHU_RELEASE_BASE_URL must use HTTPS.");
	}

	const updatePrivateKey = decodePrivateKey(required(environment, "MOSHU_UPDATE_PRIVATE_KEY"));
	const updatePublicKey = decodePublicKey(required(environment, "MOSHU_UPDATE_PUBLIC_KEY"));
	const proof = Buffer.from("moshu-stable-release-key-proof-v1", "utf8");
	if (!verify(undefined, proof, updatePublicKey, sign(undefined, proof, updatePrivateKey))) {
		throw new Error("MOSHU_UPDATE_PRIVATE_KEY does not match MOSHU_UPDATE_PUBLIC_KEY.");
	}

	if (platform === "darwin") {
		const identity = required(environment, "ELECTROBUN_DEVELOPER_ID");
		if (identity === "-") {
			throw new Error("Stable macOS releases require a Developer ID signing identity.");
		}
		const hasApiCredentials = allPresent(environment, [
			"ELECTROBUN_APPLEAPIISSUER",
			"ELECTROBUN_APPLEAPIKEY",
			"ELECTROBUN_APPLEAPIKEYPATH",
		]);
		const hasAppleIdCredentials = allPresent(environment, [
			"ELECTROBUN_APPLEID",
			"ELECTROBUN_APPLEIDPASS",
			"ELECTROBUN_TEAMID",
		]);
		if (!hasApiCredentials && !hasAppleIdCredentials) {
			throw new Error(
				"Stable macOS releases require complete App Store Connect API or Apple ID notarization credentials.",
			);
		}
	}

	if (platform === "win32") {
		const thumbprint = required(environment, "MOSHU_WINDOWS_CERT_SHA1").replaceAll(" ", "");
		if (!/^[A-Fa-f0-9]{40}$/.test(thumbprint)) {
			throw new Error("MOSHU_WINDOWS_CERT_SHA1 must be a 40-character certificate thumbprint.");
		}
		const timestampUrl = new URL(required(environment, "MOSHU_WINDOWS_TIMESTAMP_URL"));
		if (timestampUrl.protocol !== "https:" && timestampUrl.protocol !== "http:") {
			throw new Error("MOSHU_WINDOWS_TIMESTAMP_URL must use HTTP or HTTPS.");
		}
	}

	return { updatePrivateKey, updatePublicKey };
}

function decodePrivateKey(encoded: string): KeyObject {
	try {
		const key = createPrivateKey({
			key: Buffer.from(encoded, "base64url"),
			format: "der",
			type: "pkcs8",
		});
		if (key.asymmetricKeyType !== "ed25519") {
			throw new Error("not Ed25519");
		}
		return key;
	} catch (error) {
		throw new Error("MOSHU_UPDATE_PRIVATE_KEY must be an Ed25519 PKCS8 DER base64url key.", {
			cause: error,
		});
	}
}

function decodePublicKey(encoded: string): KeyObject {
	try {
		const key = createPublicKey({
			key: Buffer.from(encoded, "base64url"),
			format: "der",
			type: "spki",
		});
		if (key.asymmetricKeyType !== "ed25519") {
			throw new Error("not Ed25519");
		}
		return key;
	} catch (error) {
		throw new Error("MOSHU_UPDATE_PUBLIC_KEY must be an Ed25519 SPKI DER base64url key.", {
			cause: error,
		});
	}
}

function allPresent(environment: NodeJS.ProcessEnv, names: string[]): boolean {
	return names.every((name) => environment[name]?.trim());
}

function required(environment: NodeJS.ProcessEnv, name: string): string {
	const value = environment[name]?.trim();
	if (!value) {
		throw new Error(`${name} is required for a stable release.`);
	}
	return value;
}
