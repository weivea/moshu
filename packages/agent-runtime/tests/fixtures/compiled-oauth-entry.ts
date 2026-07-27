import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
	HeadlessAuthController,
	initializeBunAgentRuntime,
	InMemoryModelsStore,
	ModelRuntime,
	SecretVaultCredentialStore,
} from "../../src";

initializeBunAgentRuntime();
const root = mkdtempSync(join(tmpdir(), "moshu-compiled-oauth-"));

try {
	const modelRuntime = await ModelRuntime.create({
		credentials: new SecretVaultCredentialStore(join(root, "vault.json")),
		modelsPath: null,
		modelsStore: new InMemoryModelsStore(),
		allowModelNetwork: false,
	});
	const controller = new HeadlessAuthController(modelRuntime);
	const started = controller.start({
		schemaVersion: 2,
		providerId: "github-copilot",
		authType: "oauth",
	});
	let attempt = started.attempt;
	for (let index = 0; index < 100 && attempt.challenge === undefined; index += 1) {
		await Bun.sleep(10);
		attempt = controller.get(started.attempt.id).attempt;
		if (attempt.status === "failed") {
			break;
		}
	}
	if (attempt.challenge?.type !== "text") {
		throw new Error(`Compiled OAuth loader failed before prompting (${attempt.status}).`);
	}
	console.log("OAUTH_LOADER_READY");
	await controller.dispose();
} finally {
	rmSync(root, { recursive: true, force: true });
}
