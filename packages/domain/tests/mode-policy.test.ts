import { describe, expect, test } from "bun:test";
import {
	DEFAULT_MAX_ACTIVE_SESSIONS,
	modeAllowsCapability,
	validateMaxActiveSessions,
} from "../src";

describe("agent mode policy", () => {
	test("keeps Ask and Plan free of side-effect capabilities", () => {
		expect(modeAllowsCapability("ask", "write_project")).toBe(false);
		expect(modeAllowsCapability("plan", "execute_command")).toBe(false);
		expect(modeAllowsCapability("agent", "write_project")).toBe(true);
	});

	test("uses and validates the documented concurrency range", () => {
		expect(validateMaxActiveSessions(DEFAULT_MAX_ACTIVE_SESSIONS)).toBe(3);
		expect(() => validateMaxActiveSessions(0)).toThrow(RangeError);
		expect(() => validateMaxActiveSessions(6)).toThrow(RangeError);
	});
});
