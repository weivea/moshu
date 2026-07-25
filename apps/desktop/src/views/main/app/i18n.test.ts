import { describe, expect, test } from "vitest";
import { resolveLocale } from "./i18n";

describe("resolveLocale", () => {
	test("defaults Chinese locales to simplified Chinese", () => {
		expect(resolveLocale("zh-Hans-CN")).toBe("zh-CN");
	});

	test("uses English for other locales", () => {
		expect(resolveLocale("fr-FR")).toBe("en");
	});
});
