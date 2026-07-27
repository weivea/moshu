import { type KeyboardEvent, type PointerEvent, useCallback, useRef, useState } from "react";

interface PersistedPanelResizeOptions {
	storageKey: string;
	minimumWidth: number;
	maximumWidth: number;
	dragDirection: 1 | -1;
	getDefaultWidth(): number;
	keyboardStep?: number;
}

interface ResizeState {
	pointerId: number;
	startX: number;
	startWidth: number;
}

export function usePersistedPanelResize({
	storageKey,
	minimumWidth,
	maximumWidth,
	dragDirection,
	getDefaultWidth,
	keyboardStep = 8,
}: PersistedPanelResizeOptions) {
	const clampWidth = useCallback(
		(width: number) => Math.min(maximumWidth, Math.max(minimumWidth, Math.round(width))),
		[maximumWidth, minimumWidth],
	);
	const [width, setWidth] = useState<number | null>(() => {
		const storedValue = localStorage.getItem(storageKey);
		if (storedValue === null) {
			return null;
		}
		const parsedWidth = Number.parseFloat(storedValue);
		return Number.isFinite(parsedWidth) ? clampWidth(parsedWidth) : null;
	});
	const [isResizing, setIsResizing] = useState(false);
	const panelRef = useRef<HTMLElement | null>(null);
	const widthRef = useRef<number | null>(width);
	const resizeRef = useRef<ResizeState | null>(null);

	const updateWidth = useCallback(
		(nextWidth: number, persist = false) => {
			const clampedWidth = clampWidth(nextWidth);
			widthRef.current = clampedWidth;
			setWidth(clampedWidth);
			if (persist) {
				localStorage.setItem(storageKey, String(clampedWidth));
			}
		},
		[clampWidth, storageKey],
	);

	const readCurrentWidth = useCallback(
		() => widthRef.current ?? panelRef.current?.getBoundingClientRect().width ?? getDefaultWidth(),
		[getDefaultWidth],
	);

	const handleResizeStart = useCallback(
		(event: PointerEvent<HTMLHRElement>) => {
			if (event.button !== 0) {
				return;
			}

			const startWidth = clampWidth(readCurrentWidth());
			resizeRef.current = {
				pointerId: event.pointerId,
				startX: event.clientX,
				startWidth,
			};
			updateWidth(startWidth);
			setIsResizing(true);
			if (typeof event.currentTarget.setPointerCapture === "function") {
				event.currentTarget.setPointerCapture(event.pointerId);
			}
			event.preventDefault();
		},
		[clampWidth, readCurrentWidth, updateWidth],
	);

	const handleResizeMove = useCallback(
		(event: PointerEvent<HTMLHRElement>) => {
			const resize = resizeRef.current;
			if (resize === null || resize.pointerId !== event.pointerId) {
				return;
			}

			updateWidth(resize.startWidth + dragDirection * (event.clientX - resize.startX));
			event.preventDefault();
		},
		[dragDirection, updateWidth],
	);

	const handleResizeEnd = useCallback(
		(event: PointerEvent<HTMLHRElement>) => {
			const resize = resizeRef.current;
			if (resize === null || resize.pointerId !== event.pointerId) {
				return;
			}

			resizeRef.current = null;
			setIsResizing(false);
			if (widthRef.current !== null) {
				localStorage.setItem(storageKey, String(widthRef.current));
			}
			if (
				typeof event.currentTarget.hasPointerCapture === "function" &&
				event.currentTarget.hasPointerCapture(event.pointerId)
			) {
				event.currentTarget.releasePointerCapture(event.pointerId);
			}
		},
		[storageKey],
	);

	const handleResizeKeyDown = useCallback(
		(event: KeyboardEvent<HTMLHRElement>) => {
			const currentWidth = readCurrentWidth();
			let nextWidth: number;
			switch (event.key) {
				case "ArrowLeft":
					nextWidth = currentWidth - dragDirection * keyboardStep;
					break;
				case "ArrowRight":
					nextWidth = currentWidth + dragDirection * keyboardStep;
					break;
				case "Home":
					nextWidth = minimumWidth;
					break;
				case "End":
					nextWidth = maximumWidth;
					break;
				default:
					return;
			}

			event.preventDefault();
			updateWidth(nextWidth, true);
		},
		[dragDirection, keyboardStep, maximumWidth, minimumWidth, readCurrentWidth, updateWidth],
	);

	return {
		width,
		isResizing,
		panelRef,
		reportedWidth: width ?? getDefaultWidth(),
		handleResizeStart,
		handleResizeMove,
		handleResizeEnd,
		handleResizeKeyDown,
	};
}
