import type { PhotonImage } from "./photon.ts";

type Photon = typeof import("@silvia-odwyer/photon-node");
type DestinationIndex = (x: number, y: number, width: number, height: number) => number;

function readTiffOrientation(bytes: Uint8Array, tiffStart: number): number {
	if (tiffStart < 0 || tiffStart + 8 > bytes.length) {
		return 1;
	}
	const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
	const byteOrder = view.getUint16(tiffStart, false);
	const littleEndian = byteOrder === 0x4949;
	const ifdOffset = view.getUint32(tiffStart + 4, littleEndian);
	const ifdStart = tiffStart + ifdOffset;
	if (ifdStart + 2 > bytes.length) {
		return 1;
	}
	const entryCount = view.getUint16(ifdStart, littleEndian);
	for (let index = 0; index < entryCount; index += 1) {
		const entryPosition = ifdStart + 2 + index * 12;
		if (entryPosition + 12 > bytes.length) {
			return 1;
		}
		if (view.getUint16(entryPosition, littleEndian) === 0x0112) {
			const orientation = view.getUint16(entryPosition + 8, littleEndian);
			return orientation >= 1 && orientation <= 8 ? orientation : 1;
		}
	}
	return 1;
}

function hasExifHeader(bytes: Uint8Array, offset: number): boolean {
	return (
		bytes[offset] === 0x45 &&
		bytes[offset + 1] === 0x78 &&
		bytes[offset + 2] === 0x69 &&
		bytes[offset + 3] === 0x66 &&
		bytes[offset + 4] === 0x00 &&
		bytes[offset + 5] === 0x00
	);
}

function jpegTiffOffset(bytes: Uint8Array): number {
	let offset = 2;
	while (offset < bytes.length - 1) {
		if (bytes[offset] !== 0xff) {
			return -1;
		}
		const marker = bytes[offset + 1];
		if (marker === 0xff) {
			offset += 1;
			continue;
		}
		if (marker === 0xe1) {
			const segmentStart = offset + 4;
			return segmentStart + 6 <= bytes.length && hasExifHeader(bytes, segmentStart)
				? segmentStart + 6
				: -1;
		}
		if (offset + 4 > bytes.length) {
			return -1;
		}
		const length = ((bytes[offset + 2] ?? 0) << 8) | (bytes[offset + 3] ?? 0);
		if (length < 2) {
			return -1;
		}
		offset += 2 + length;
	}
	return -1;
}

function webpTiffOffset(bytes: Uint8Array): number {
	const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
	let offset = 12;
	while (offset + 8 <= bytes.length) {
		const chunkId = String.fromCharCode(
			bytes[offset] ?? 0,
			bytes[offset + 1] ?? 0,
			bytes[offset + 2] ?? 0,
			bytes[offset + 3] ?? 0,
		);
		const chunkSize = view.getUint32(offset + 4, true);
		const dataStart = offset + 8;
		if (dataStart + chunkSize > bytes.length) {
			return -1;
		}
		if (chunkId === "EXIF") {
			return chunkSize >= 6 && hasExifHeader(bytes, dataStart) ? dataStart + 6 : dataStart;
		}
		offset = dataStart + chunkSize + (chunkSize % 2);
	}
	return -1;
}

function exifOrientation(bytes: Uint8Array): number {
	if (bytes.length >= 2 && bytes[0] === 0xff && bytes[1] === 0xd8) {
		return readTiffOrientation(bytes, jpegTiffOffset(bytes));
	}
	if (
		bytes.length >= 12 &&
		String.fromCharCode(...bytes.subarray(0, 4)) === "RIFF" &&
		String.fromCharCode(...bytes.subarray(8, 12)) === "WEBP"
	) {
		return readTiffOrientation(bytes, webpTiffOffset(bytes));
	}
	return 1;
}

function rotate90(
	photon: Photon,
	image: PhotonImage,
	destinationIndex: DestinationIndex,
): PhotonImage {
	const width = image.get_width();
	const height = image.get_height();
	const source = image.get_raw_pixels();
	const destination = new Uint8Array(source.length);
	for (let y = 0; y < height; y += 1) {
		for (let x = 0; x < width; x += 1) {
			const sourceIndex = (y * width + x) * 4;
			const targetIndex = destinationIndex(x, y, width, height) * 4;
			destination[targetIndex] = source[sourceIndex] ?? 0;
			destination[targetIndex + 1] = source[sourceIndex + 1] ?? 0;
			destination[targetIndex + 2] = source[sourceIndex + 2] ?? 0;
			destination[targetIndex + 3] = source[sourceIndex + 3] ?? 0;
		}
	}
	return new photon.PhotonImage(destination, height, width);
}

export function applyExifOrientation(
	photon: Photon,
	image: PhotonImage,
	originalBytes: Uint8Array,
): PhotonImage {
	switch (exifOrientation(originalBytes)) {
		case 2:
			photon.fliph(image);
			return image;
		case 3:
			photon.fliph(image);
			photon.flipv(image);
			return image;
		case 4:
			photon.flipv(image);
			return image;
		case 5: {
			const rotated = rotate90(
				photon,
				image,
				(x, y, _width, height) => x * height + (height - 1 - y),
			);
			photon.fliph(rotated);
			return rotated;
		}
		case 6:
			return rotate90(photon, image, (x, y, _width, height) => x * height + (height - 1 - y));
		case 7: {
			const rotated = rotate90(
				photon,
				image,
				(x, y, width, height) => (width - 1 - x) * height + y,
			);
			photon.fliph(rotated);
			return rotated;
		}
		case 8:
			return rotate90(photon, image, (x, y, width, height) => (width - 1 - x) * height + y);
		default:
			return image;
	}
}
