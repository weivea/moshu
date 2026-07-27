import { prepareCoordinatedDatabaseReset } from "../src";

const [productDatabase] = Bun.argv.slice(2);
if (productDatabase === undefined) {
	throw new Error("Reset worker requires a product database path.");
}

const result = prepareCoordinatedDatabaseReset({ productDatabase });
process.stdout.write(`${JSON.stringify(result)}\n`);
