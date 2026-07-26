#!/usr/bin/env bun

import { spawnSync } from "node:child_process";
import { resolve } from "node:path";
import {
	parseFinalAppTarInvocation,
	signAndVerifyFinalizedMacApp,
	writeAdHocSigningMarker,
} from "./mac-finalized-app-signing";

export function runElectrobunAdHocTar(
	arguments_: string[],
	environment: NodeJS.ProcessEnv = process.env,
	cwd = process.cwd(),
): number {
	const invocation = parseFinalAppTarInvocation(arguments_, cwd);
	if (invocation && environment.MOSHU_MAC_PACKAGE_SIGNING_MODE === "ad-hoc") {
		signAndVerifyFinalizedMacApp(
			invocation.appPath,
			"-",
			resolve(import.meta.dir, "..", "companion-entitlements.plist"),
		);
		writeAdHocSigningMarker(invocation.tarPath, invocation.appPath);
	}
	const result = spawnSync("/usr/bin/tar", arguments_, {
		cwd,
		env: environment,
		stdio: "inherit",
	});
	if (result.error) {
		throw result.error;
	}
	return result.status ?? 1;
}

if (import.meta.main) {
	process.exit(runElectrobunAdHocTar(Bun.argv.slice(2)));
}
