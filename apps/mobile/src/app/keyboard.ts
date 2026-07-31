import { useEffect } from "react";

/**
 * Keeps a `--keyboard-inset` CSS variable in sync with the software keyboard height using the
 * VisualViewport API. The composer adds this inset as bottom padding so it stays above the keyboard
 * without any native plugin. When VisualViewport is unavailable (older WebViews, jsdom) the hook
 * no-ops and the inset stays at 0, so layout degrades gracefully.
 */
export function useKeyboardInset(): void {
	useEffect(() => {
		const viewport = typeof window !== "undefined" ? window.visualViewport : undefined;
		if (!viewport) {
			return;
		}

		const root = document.documentElement;
		const update = (): void => {
			// The occluded height is the gap between the layout viewport bottom and the visual viewport
			// bottom — i.e. the keyboard (and any accessory bar) overlapping the page.
			const occluded = Math.max(
				0,
				window.innerHeight - viewport.height - viewport.offsetTop,
			);
			root.style.setProperty("--keyboard-inset", `${Math.round(occluded)}px`);
		};

		update();
		viewport.addEventListener("resize", update);
		viewport.addEventListener("scroll", update);
		return () => {
			viewport.removeEventListener("resize", update);
			viewport.removeEventListener("scroll", update);
			root.style.setProperty("--keyboard-inset", "0px");
		};
	}, []);
}
