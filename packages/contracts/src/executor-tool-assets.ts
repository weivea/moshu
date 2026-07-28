export const executorToolBinaryNames = ["rg", "fd"] as const;
export const executorImageProcessorWasmFilename = "photon_rs_bg.wasm";

export type ExecutorToolBinaryName = (typeof executorToolBinaryNames)[number];

export function getExecutorToolBinaryFilename(
	tool: ExecutorToolBinaryName,
	platform: NodeJS.Platform = process.platform,
): string {
	return platform === "win32" ? `${tool}.exe` : tool;
}
