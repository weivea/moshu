export const MAX_RPC_JSON_DEPTH = 64;
export const MAX_RPC_JSON_CONTAINERS = 4_096;
export const MAX_RPC_JSON_VALUES = 100_000;

export function hasSafeRpcJsonStructure(text: string): boolean {
	let depth = 0;
	let containers = 0;
	let values = 1;
	let inString = false;
	let escaped = false;

	for (let index = 0; index < text.length; index += 1) {
		const character = text.charCodeAt(index);
		if (inString) {
			if (escaped) {
				escaped = false;
			} else if (character === 0x5c) {
				escaped = true;
			} else if (character === 0x22) {
				inString = false;
			}
			continue;
		}

		if (character === 0x22) {
			inString = true;
			continue;
		}
		if (character === 0x7b || character === 0x5b) {
			depth += 1;
			containers += 1;
			if (depth > MAX_RPC_JSON_DEPTH || containers > MAX_RPC_JSON_CONTAINERS) {
				return false;
			}
		} else if (character === 0x7d || character === 0x5d) {
			depth -= 1;
			if (depth < 0) {
				return false;
			}
		} else if (character === 0x2c) {
			values += 1;
			if (values > MAX_RPC_JSON_VALUES) {
				return false;
			}
		}
	}

	return depth === 0 && !inString;
}
