import {
	appendFileSync,
	chmodSync,
	closeSync,
	existsSync,
	mkdirSync,
	openSync,
	renameSync,
	rmSync,
	statSync,
} from "node:fs";
import { dirname } from "node:path";
import type { ProviderAuthDiagnosticEvent } from "@moshu/agent-runtime";

const defaultMaxBytes = 512 * 1_024;

export interface ProviderAuthDiagnosticLogOptions {
	maxBytes?: number;
	now?: () => Date;
}

export function createProviderAuthDiagnosticLog(
	filename: string,
	options: ProviderAuthDiagnosticLogOptions = {},
): (event: ProviderAuthDiagnosticEvent) => void {
	const parent = dirname(filename);
	const previous = `${filename}.previous`;
	const maxBytes = options.maxBytes ?? defaultMaxBytes;
	const now = options.now ?? (() => new Date());
	mkdirSync(parent, { recursive: true, mode: 0o700 });
	chmodSync(parent, 0o700);
	ensureLogFile(filename);

	return (event) => {
		const line = `${JSON.stringify({ recordedAt: now().toISOString(), ...event })}\n`;
		ensureLogFile(filename);
		if (statSync(filename).size + Buffer.byteLength(line) > maxBytes) {
			rmSync(previous, { force: true });
			renameSync(filename, previous);
			chmodSync(previous, 0o600);
			ensureLogFile(filename);
		}
		appendFileSync(filename, line, { encoding: "utf8", mode: 0o600 });
		chmodSync(filename, 0o600);
	};
}

function ensureLogFile(filename: string): void {
	if (existsSync(filename)) {
		chmodSync(filename, 0o600);
		return;
	}
	const descriptor = openSync(filename, "wx", 0o600);
	closeSync(descriptor);
}
