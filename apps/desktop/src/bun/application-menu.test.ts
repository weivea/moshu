import { describe, expect, test } from "bun:test";

import { macApplicationMenu } from "./application-menu";

describe("macOS application menu", () => {
	test("installs standard application, editing, and window roles", () => {
		expect(macApplicationMenu).toEqual([
			{
				submenu: [
					{ role: "about" },
					{ type: "separator" },
					{ role: "hide" },
					{ role: "hideOthers" },
					{ role: "showAll" },
					{ type: "separator" },
					{ role: "quit" },
				],
			},
			{
				label: "Edit",
				submenu: [
					{ role: "undo" },
					{ role: "redo" },
					{ type: "separator" },
					{ role: "cut" },
					{ role: "copy" },
					{ role: "paste" },
					{ role: "pasteAndMatchStyle" },
					{ role: "delete" },
					{ role: "selectAll" },
				],
			},
			{
				label: "Window",
				submenu: [
					{ role: "minimize" },
					{ role: "zoom" },
					{ type: "separator" },
					{ role: "close" },
					{ role: "bringAllToFront" },
				],
			},
		]);
	});
});
