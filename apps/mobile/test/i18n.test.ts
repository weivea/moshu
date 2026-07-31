import { describe, expect, it } from "vitest";
import { messagesByLanguage } from "../src/app/i18n";

describe("i18n", () => {
	it("has full key parity between en and zh", () => {
		const enKeys = Object.keys(messagesByLanguage.en).sort();
		const zhKeys = Object.keys(messagesByLanguage.zh).sort();
		expect(zhKeys).toEqual(enKeys);
	});

	it("has no empty translations", () => {
		for (const [language, messages] of Object.entries(messagesByLanguage)) {
			for (const [key, value] of Object.entries(messages)) {
				expect(value.length, `${language}.${key}`).toBeGreaterThan(0);
			}
		}
	});

	it("renders the fixed, argument-hidden shell approval label", () => {
		expect(messagesByLanguage.en["approval.shell"]).toBe("shell [arguments hidden]");
		expect(messagesByLanguage.zh["approval.shell"]).toContain("shell");
		// The raw command must never be part of the template.
		for (const messages of Object.values(messagesByLanguage)) {
			expect(messages["approval.shell"]).not.toContain("{0}");
		}
	});
});
