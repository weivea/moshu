import { copyFile, mkdir } from "node:fs/promises";
import { dirname, resolve } from "node:path";

export const stagedThirdPartyNoticesSource = "dist/package-resources/THIRD_PARTY_NOTICES.txt";

export async function stagePackageResources(
	repositoryRoot = resolve(import.meta.dir, "../../.."),
	desktopRoot = resolve(import.meta.dir, ".."),
): Promise<void> {
	const destination = resolve(desktopRoot, stagedThirdPartyNoticesSource);
	await mkdir(dirname(destination), { recursive: true });
	await copyFile(resolve(repositoryRoot, "THIRD_PARTY_NOTICES.txt"), destination);
}

if (import.meta.main) {
	await stagePackageResources();
}
