const textEncoder = new TextEncoder();
const MAX_WEBSOCKET_CLOSE_REASON_BYTES = 123;

export function truncateWebSocketCloseReason(reason: string): string {
	if (textEncoder.encode(reason).byteLength <= MAX_WEBSOCKET_CLOSE_REASON_BYTES) {
		return reason;
	}

	const characters: string[] = [];
	let byteLength = 0;
	for (const character of reason) {
		const characterBytes = textEncoder.encode(character).byteLength;
		if (byteLength + characterBytes > MAX_WEBSOCKET_CLOSE_REASON_BYTES) {
			break;
		}
		characters.push(character);
		byteLength += characterBytes;
	}
	return characters.join("");
}
