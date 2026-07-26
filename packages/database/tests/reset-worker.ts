import { writeFileSync } from "node:fs";

import { prepareCoordinatedDatabaseReset } from "../src";

const [productDatabase, checkpointDatabase, readyPath, delayText] = Bun.argv.slice(2);
if (productDatabase === undefined || checkpointDatabase === undefined) {
	throw new Error("Reset worker requires product and checkpoint database paths.");
}

const delayMs = Number(delayText ?? "0");
const result = prepareCoordinatedDatabaseReset(
	{ productDatabase, checkpointDatabase },
	{
		beforeBoundary(boundary) {
			if (boundary !== "delete-checkpoint-database" || readyPath === undefined) {
				return;
			}
			writeFileSync(readyPath, "ready");
			if (delayMs > 0) {
				Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, delayMs);
			}
		},
	},
);
process.stdout.write(`${JSON.stringify(result)}\n`);
