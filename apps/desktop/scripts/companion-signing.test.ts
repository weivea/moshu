import { describe, expect, test } from "bun:test";

import {
	assertEmbeddedCompanionEntitlements,
	createCompanionCodesignCommand,
	createCompanionEntitlementsInspectionCommand,
	createElectrobunCodesignEnvironment,
	createElectrobunPackageEnvironment,
	createMacAppVerificationCommand,
	createOuterAppCodesignCommand,
	requiredCompanionEntitlements,
	resolveCompanionCodesignIdentity,
} from "./companion-signing";

describe("companion signing contract", () => {
	test.each(["-", "Developer ID Application: Moshu"])(
		"always signs with the versioned entitlement file for %s",
		(identity) => {
			const command = createCompanionCodesignCommand({
				executable: "/tmp/moshu-agents-server",
				identity,
				entitlementsPath: "/repo/apps/desktop/companion-entitlements.plist",
			});
			expect(command).toContain("--entitlements");
			expect(command).toContain("/repo/apps/desktop/companion-entitlements.plist");
			expect(command.at(-1)).toBe("/tmp/moshu-agents-server");
			expect(command.includes("runtime")).toBe(identity !== "-");
		},
	);

	test("requires both Bun JIT entitlements in embedded codesign output", () => {
		const output = `<?xml version="1.0"?><plist><dict>${requiredCompanionEntitlements
			.map((key) => `<key>${key}</key><true/>`)
			.join("")}</dict></plist>`;
		expect(() => assertEmbeddedCompanionEntitlements(output, "companion")).not.toThrow();
		expect(() =>
			assertEmbeddedCompanionEntitlements(
				"<plist><dict><key>com.apple.security.cs.allow-jit</key><true/></dict></plist>",
				"companion",
			),
		).toThrow("allow-unsigned-executable-memory");
	});

	test("inspects the exact executable entitlements as XML", () => {
		expect(createCompanionEntitlementsInspectionCommand("/tmp/moshu-executor")).toEqual([
			"codesign",
			"-d",
			"--entitlements",
			":-",
			"--xml",
			"/tmp/moshu-executor",
		]);
	});

	test("uses the companion identity for Electrobun outer signing", () => {
		const environment = createElectrobunCodesignEnvironment(
			{
				ELECTROBUN_DEVELOPER_ID: "Developer ID Application: old",
				MOSHU_COMPANION_CODESIGN_IDENTITY: "Developer ID Application: Moshu",
			},
			"darwin",
		);
		expect(resolveCompanionCodesignIdentity(environment)).toBe("Developer ID Application: Moshu");
		expect(environment.ELECTROBUN_DEVELOPER_ID).toBe("Developer ID Application: Moshu");
	});

	test("uses an ad-hoc fallback on macOS and leaves non-mac environments untouched", () => {
		const environment = { PATH: "/bin" };
		expect(createElectrobunCodesignEnvironment(environment, "darwin")).toMatchObject({
			ELECTROBUN_DEVELOPER_ID: "-",
			MOSHU_COMPANION_CODESIGN_IDENTITY: "-",
		});
		expect(createElectrobunCodesignEnvironment(environment, "linux")).toBe(environment);
	});

	test("installs the finalized pre-archive hook only for ad-hoc macOS packaging", () => {
		const adHoc = createElectrobunPackageEnvironment(
			{ PATH: "/usr/bin" },
			"darwin",
			"/workspace/apps/desktop",
		);
		expect(adHoc).toMatchObject({
			MOSHU_MAC_PACKAGE_SIGNING_MODE: "ad-hoc",
			ELECTROBUN_DEVELOPER_ID: "-",
		});
		expect(adHoc.PATH?.split(":")[0]).toBe("/workspace/apps/desktop/scripts/electrobun-ad-hoc-bin");

		const developerId = createElectrobunPackageEnvironment(
			{
				PATH: "/usr/bin",
				MOSHU_COMPANION_CODESIGN_IDENTITY: "Developer ID Application: Moshu",
			},
			"darwin",
			"/workspace/apps/desktop",
		);
		expect(developerId.PATH).toBe("/usr/bin");
		expect(developerId.MOSHU_MAC_PACKAGE_SIGNING_MODE).toBe("developer-id");
		expect(developerId.ELECTROBUN_DEVELOPER_ID).toBe("Developer ID Application: Moshu");
	});

	test("signs development outer apps and deeply verifies the exact bundle", () => {
		expect(createOuterAppCodesignCommand("/build/Moshu-dev.app", "-")).toEqual([
			"codesign",
			"--force",
			"--sign",
			"-",
			"/build/Moshu-dev.app",
		]);
		expect(createMacAppVerificationCommand("/build/Moshu-dev.app")).toEqual([
			"codesign",
			"--verify",
			"--deep",
			"--strict",
			"--verbose=2",
			"/build/Moshu-dev.app",
		]);
	});
});
