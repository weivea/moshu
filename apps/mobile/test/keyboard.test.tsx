import { render } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { useKeyboardInset } from "../src/app/keyboard";

function Probe() {
	useKeyboardInset();
	return <div>probe</div>;
}

afterEach(() => {
	document.documentElement.style.removeProperty("--keyboard-inset");
	// @ts-expect-error test cleanup of the optional API
	delete window.visualViewport;
});

describe("useKeyboardInset", () => {
	it("no-ops gracefully when VisualViewport is unavailable (jsdom / old WebView)", () => {
		expect(window.visualViewport).toBeFalsy();
		render(<Probe />);
		// Inset is never set, so the composer padding stays at its 0 default.
		expect(document.documentElement.style.getPropertyValue("--keyboard-inset")).toBe("");
	});

	it("tracks the occluded keyboard height from VisualViewport", () => {
		const listeners: Record<string, () => void> = {};
		const viewport = {
			height: 500,
			offsetTop: 0,
			addEventListener: (event: string, cb: () => void) => {
				listeners[event] = cb;
			},
			removeEventListener: () => {},
		};
		Object.defineProperty(window, "visualViewport", { value: viewport, configurable: true });
		Object.defineProperty(window, "innerHeight", { value: 800, configurable: true });

		render(<Probe />);
		// 800 (layout) - 500 (visual) - 0 (offset) = 300px keyboard.
		expect(document.documentElement.style.getPropertyValue("--keyboard-inset")).toBe("300px");

		viewport.height = 800;
		listeners.resize?.();
		expect(document.documentElement.style.getPropertyValue("--keyboard-inset")).toBe("0px");
	});
});
