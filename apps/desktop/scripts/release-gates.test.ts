import { describe, expect, test } from "bun:test";
import { generateKeyPairSync } from "node:crypto";

import { assertStableReleaseEnvironment } from "./release-gates";

describe("stable release gates", () => {
	test("requires signed update credentials and platform signing credentials", () => {
		expect(() => assertStableReleaseEnvironment({}, "darwin")).toThrow("MOSHU_APP_IDENTIFIER");
		const environment = baseEnvironment();
		expect(() => assertStableReleaseEnvironment(environment, "darwin")).toThrow(
			"ELECTROBUN_DEVELOPER_ID",
		);
		expect(() =>
			assertStableReleaseEnvironment(
				{
					...environment,
					ELECTROBUN_DEVELOPER_ID: "Developer ID Application: Moshu",
				},
				"darwin",
			),
		).toThrow("notarization credentials");
		expect(() => assertStableReleaseEnvironment(environment, "win32")).toThrow(
			"MOSHU_WINDOWS_CERT_SHA1",
		);
	});

	test("accepts complete macOS notarization credentials", () => {
		expect(() =>
			assertStableReleaseEnvironment(
				{
					...baseEnvironment(),
					ELECTROBUN_DEVELOPER_ID: "Developer ID Application: Moshu",
					ELECTROBUN_APPLEAPIISSUER: "issuer",
					ELECTROBUN_APPLEAPIKEY: "key-id",
					ELECTROBUN_APPLEAPIKEYPATH: "/secure/AuthKey.p8",
				},
				"darwin",
			),
		).not.toThrow();
	});

	test("rejects mismatched update signing keys", () => {
		const environment = baseEnvironment();
		const other = generateKeyPairSync("ed25519");
		environment.MOSHU_UPDATE_PUBLIC_KEY = other.publicKey
			.export({ format: "der", type: "spki" })
			.toString("base64url");
		expect(() => assertStableReleaseEnvironment(environment, "linux")).toThrow("does not match");
	});
});

function baseEnvironment(): NodeJS.ProcessEnv {
	const pair = generateKeyPairSync("ed25519");
	return {
		MOSHU_APP_IDENTIFIER: "com.example.moshu",
		MOSHU_RELEASE_BASE_URL: "https://updates.example.test/moshu",
		MOSHU_UPDATE_PRIVATE_KEY: pair.privateKey
			.export({ format: "der", type: "pkcs8" })
			.toString("base64url"),
		MOSHU_UPDATE_PUBLIC_KEY: pair.publicKey
			.export({ format: "der", type: "spki" })
			.toString("base64url"),
	};
}
