import "@testing-library/jest-dom/vitest";
import { cleanup } from "@testing-library/react";
import { afterEach, vi } from "vitest";

// jsdom does not implement matchMedia; the appearance provider reads it for the system theme.
if (typeof window !== "undefined" && typeof window.matchMedia !== "function") {
	window.matchMedia = ((query: string) => ({
		matches: false,
		media: query,
		onchange: null,
		addEventListener: () => undefined,
		removeEventListener: () => undefined,
		addListener: () => undefined,
		removeListener: () => undefined,
		dispatchEvent: () => false,
	})) as unknown as typeof window.matchMedia;
}

// jsdom lacks VisualViewport; the keyboard-avoidance hook feature-detects it and no-ops when absent.
afterEach(() => {
	cleanup();
	vi.restoreAllMocks();
});
