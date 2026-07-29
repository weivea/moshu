import { maxExecutorToolImageBase64Chars } from "@moshu/contracts";
import { applyExifOrientation } from "./exif-orientation.ts";
import { loadPhoton } from "./photon.ts";

export interface ProcessedImage {
	data: string;
	mimeType: "image/jpeg" | "image/png" | "image/gif" | "image/webp";
	originalWidth: number;
	originalHeight: number;
	width: number;
	height: number;
	wasResized: boolean;
}

export type SupportedInputImageMime = ProcessedImage["mimeType"] | "image/bmp";
export const MAX_IMAGE_INPUT_BYTES = 32 * 1024 * 1024;
export const MAX_IMAGE_PIXELS = 25_000_000;
export const MAX_IMAGE_DIMENSION = 32_768;

export function detectImageMime(bytes: Uint8Array): SupportedInputImageMime | undefined {
	if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) {
		return "image/jpeg";
	}
	if (
		bytes.length >= 8 &&
		bytes[0] === 0x89 &&
		bytes[1] === 0x50 &&
		bytes[2] === 0x4e &&
		bytes[3] === 0x47 &&
		bytes[4] === 0x0d &&
		bytes[5] === 0x0a &&
		bytes[6] === 0x1a &&
		bytes[7] === 0x0a
	) {
		return "image/png";
	}
	if (
		bytes.length >= 6 &&
		(String.fromCharCode(...bytes.subarray(0, 6)) === "GIF87a" ||
			String.fromCharCode(...bytes.subarray(0, 6)) === "GIF89a")
	) {
		return "image/gif";
	}
	if (
		bytes.length >= 12 &&
		String.fromCharCode(...bytes.subarray(0, 4)) === "RIFF" &&
		String.fromCharCode(...bytes.subarray(8, 12)) === "WEBP"
	) {
		return "image/webp";
	}
	if (bytes.length >= 2 && bytes[0] === 0x42 && bytes[1] === 0x4d) {
		return "image/bmp";
	}
	return undefined;
}

interface EncodedCandidate {
	data: string;
	mimeType: "image/jpeg" | "image/png";
}

interface ImageDimensions {
	width: number;
	height: number;
}

function readUint24LittleEndian(bytes: Buffer, offset: number): number {
	return (bytes[offset] ?? 0) | ((bytes[offset + 1] ?? 0) << 8) | ((bytes[offset + 2] ?? 0) << 16);
}

function jpegDimensions(bytes: Buffer): ImageDimensions | undefined {
	let offset = 2;
	while (offset + 3 < bytes.length) {
		if (bytes[offset] !== 0xff) {
			offset += 1;
			continue;
		}
		while (bytes[offset] === 0xff) {
			offset += 1;
		}
		const marker = bytes[offset];
		offset += 1;
		if (marker === undefined || marker === 0xd9 || marker === 0xda) {
			return undefined;
		}
		if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd8)) {
			continue;
		}
		if (offset + 1 >= bytes.length) {
			return undefined;
		}
		const segmentLength = bytes.readUInt16BE(offset);
		if (segmentLength < 2 || offset + segmentLength > bytes.length) {
			return undefined;
		}
		if (
			[0xc0, 0xc1, 0xc2, 0xc3, 0xc5, 0xc6, 0xc7, 0xc9, 0xca, 0xcb, 0xcd, 0xce, 0xcf].includes(
				marker,
			) &&
			segmentLength >= 7
		) {
			return {
				height: bytes.readUInt16BE(offset + 3),
				width: bytes.readUInt16BE(offset + 5),
			};
		}
		offset += segmentLength;
	}
	return undefined;
}

export function inspectImageDimensions(
	inputBytes: Uint8Array,
	mimeType: SupportedInputImageMime,
): ImageDimensions {
	const bytes = Buffer.from(inputBytes.buffer, inputBytes.byteOffset, inputBytes.byteLength);
	let dimensions: ImageDimensions | undefined;
	switch (mimeType) {
		case "image/png":
			if (bytes.length >= 24 && bytes.toString("ascii", 12, 16) === "IHDR") {
				dimensions = { width: bytes.readUInt32BE(16), height: bytes.readUInt32BE(20) };
			}
			break;
		case "image/gif":
			if (bytes.length >= 10) {
				dimensions = { width: bytes.readUInt16LE(6), height: bytes.readUInt16LE(8) };
			}
			break;
		case "image/bmp":
			if (bytes.length >= 26) {
				const dibHeaderSize = bytes.readUInt32LE(14);
				dimensions =
					dibHeaderSize === 12
						? { width: bytes.readUInt16LE(18), height: bytes.readUInt16LE(20) }
						: {
								width: Math.abs(bytes.readInt32LE(18)),
								height: Math.abs(bytes.readInt32LE(22)),
							};
			}
			break;
		case "image/webp": {
			const chunkType = bytes.toString("ascii", 12, 16);
			if (chunkType === "VP8X" && bytes.length >= 30) {
				dimensions = {
					width: readUint24LittleEndian(bytes, 24) + 1,
					height: readUint24LittleEndian(bytes, 27) + 1,
				};
			} else if (chunkType === "VP8L" && bytes.length >= 25 && bytes[20] === 0x2f) {
				const packed = bytes.readUInt32LE(21);
				dimensions = {
					width: (packed & 0x3fff) + 1,
					height: ((packed >>> 14) & 0x3fff) + 1,
				};
			} else if (
				chunkType === "VP8 " &&
				bytes.length >= 30 &&
				bytes[23] === 0x9d &&
				bytes[24] === 0x01 &&
				bytes[25] === 0x2a
			) {
				dimensions = {
					width: bytes.readUInt16LE(26) & 0x3fff,
					height: bytes.readUInt16LE(28) & 0x3fff,
				};
			}
			break;
		}
		case "image/jpeg":
			dimensions = jpegDimensions(bytes);
			break;
	}
	if (!dimensions || dimensions.width <= 0 || dimensions.height <= 0) {
		throw new Error(`Unable to determine ${mimeType} dimensions before decoding`);
	}
	if (
		dimensions.width > MAX_IMAGE_DIMENSION ||
		dimensions.height > MAX_IMAGE_DIMENSION ||
		dimensions.width * dimensions.height > MAX_IMAGE_PIXELS
	) {
		throw new Error(
			`Image dimensions ${dimensions.width}x${dimensions.height} exceed the executor decode limit`,
		);
	}
	return dimensions;
}

function encodeCandidate(
	buffer: Uint8Array,
	mimeType: EncodedCandidate["mimeType"],
): EncodedCandidate {
	return {
		data: Buffer.from(buffer).toString("base64"),
		mimeType,
	};
}

export async function processImage(
	inputBytes: Uint8Array,
	mimeType: SupportedInputImageMime,
): Promise<ProcessedImage> {
	const inspectedDimensions = inspectImageDimensions(inputBytes, mimeType);
	const photon = await loadPhoton();
	let image: ReturnType<typeof photon.PhotonImage.new_from_byteslice> | undefined;
	try {
		const rawImage = photon.PhotonImage.new_from_byteslice(inputBytes);
		image = applyExifOrientation(photon, rawImage, inputBytes);
		if (image !== rawImage) {
			rawImage.free();
		}

		const originalWidth = image.get_width();
		const originalHeight = image.get_height();
		if (
			originalWidth !== inspectedDimensions.width ||
			originalHeight !== inspectedDimensions.height
		) {
			throw new Error("Decoded image dimensions did not match the validated header");
		}
		const originalData = Buffer.from(inputBytes).toString("base64");
		if (
			mimeType !== "image/bmp" &&
			originalWidth <= 2_000 &&
			originalHeight <= 2_000 &&
			originalData.length <= maxExecutorToolImageBase64Chars
		) {
			return {
				data: originalData,
				mimeType,
				originalWidth,
				originalHeight,
				width: originalWidth,
				height: originalHeight,
				wasResized: false,
			};
		}

		let targetWidth = originalWidth;
		let targetHeight = originalHeight;
		if (targetWidth > 2_000) {
			targetHeight = Math.max(1, Math.round((targetHeight * 2_000) / targetWidth));
			targetWidth = 2_000;
		}
		if (targetHeight > 2_000) {
			targetWidth = Math.max(1, Math.round((targetWidth * 2_000) / targetHeight));
			targetHeight = 2_000;
		}

		const qualitySteps = [80, 85, 70, 55, 40];
		while (true) {
			const resized = photon.resize(
				image,
				targetWidth,
				targetHeight,
				photon.SamplingFilter.Lanczos3,
			);
			try {
				const candidates: EncodedCandidate[] = [
					encodeCandidate(resized.get_bytes(), "image/png"),
					...qualitySteps.map((quality) =>
						encodeCandidate(resized.get_bytes_jpeg(quality), "image/jpeg"),
					),
				];
				const candidate = candidates.find(
					(value) => value.data.length <= maxExecutorToolImageBase64Chars,
				);
				if (candidate) {
					return {
						...candidate,
						originalWidth,
						originalHeight,
						width: targetWidth,
						height: targetHeight,
						wasResized: true,
					};
				}
			} finally {
				resized.free();
			}

			if (targetWidth === 1 && targetHeight === 1) {
				throw new Error("Image cannot be compressed below the executor RPC image limit");
			}
			targetWidth = targetWidth === 1 ? 1 : Math.max(1, Math.floor(targetWidth * 0.75));
			targetHeight = targetHeight === 1 ? 1 : Math.max(1, Math.floor(targetHeight * 0.75));
		}
	} catch (error) {
		throw new Error(`Unable to decode or resize ${mimeType} image`, { cause: error });
	} finally {
		image?.free();
	}
}
