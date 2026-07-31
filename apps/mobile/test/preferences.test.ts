import { afterEach, describe, expect, it } from "vitest";
import {
	readStoredLanguage,
	readStoredTheme,
	writeStoredLanguage,
	writeStoredTheme,
} from "../src/app/preferences";

afterEach(() => {
	localStorage.clear();
});

describe("preferences persistence boundary", () => {
	it("persists only appearance theme and language", () => {
		writeStoredTheme("dark");
		writeStoredLanguage("zh");
		expect(readStoredTheme()).toBe("dark");
		expect(readStoredLanguage()).toBe("zh");

		// The ONLY keys ever written are the two appearance preferences — never business data,
		// bindings, tokens, or credentials.
		const keys = Object.keys(localStorage);
		expect(keys.sort()).toEqual(["moshu.appearance.language", "moshu.appearance.theme"]);
	});

	it("ignores malformed stored values", () => {
		localStorage.setItem("moshu.appearance.theme", "chartreuse");
		localStorage.setItem("moshu.appearance.language", "fr");
		expect(readStoredTheme()).toBeNull();
		expect(readStoredLanguage()).toBeNull();
	});

	it("never writes any key that looks like a credential or business record", () => {
		writeStoredTheme("light");
		writeStoredLanguage("en");
		for (const key of Object.keys(localStorage)) {
			expect(key).not.toMatch(/token|key|secret|binding|session|approval|project|message/i);
		}
	});
});
