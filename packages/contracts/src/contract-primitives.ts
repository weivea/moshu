import { z } from "zod";

export const uuidV7Pattern =
	/^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export const uuidV7Schema = z.string().regex(uuidV7Pattern, "Expected UUIDv7.");
export const isoDateTimeSchema = z.string().datetime({ offset: true });

export const maxToolCallIdBytes = 512;
const textEncoder = new TextEncoder();

export const toolCallIdSchema = z
	.string()
	.min(1)
	.max(maxToolCallIdBytes)
	.superRefine((value, context) => {
		if (textEncoder.encode(value).byteLength > maxToolCallIdBytes) {
			context.addIssue({
				code: "custom",
				message: `Tool call ID must encode to at most ${maxToolCallIdBytes} UTF-8 bytes.`,
			});
		}
	});
