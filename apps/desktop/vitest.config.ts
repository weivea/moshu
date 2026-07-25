import react from "@vitejs/plugin-react";
import { defineConfig } from "vitest/config";

export default defineConfig({
	plugins: [react()],
	test: {
		environment: "jsdom",
		include: ["src/views/main/**/*.test.{ts,tsx}"],
		setupFiles: ["./src/views/main/test/setup.ts"],
	},
});
