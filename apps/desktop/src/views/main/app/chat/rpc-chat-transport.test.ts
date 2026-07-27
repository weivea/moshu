import { describe, expect, test } from "vitest";
import { chatTransport } from "./rpc-chat-transport";

describe("chatTransport browser preview", () => {
	test("uses the preview transport outside an Electrobun WebView", async () => {
		expect("__electrobun" in window).toBe(false);
		await expect(chatTransport.listAvailableModels()).resolves.toEqual({ models: [] });
	});
});
