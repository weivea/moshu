import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

// The web assets are bundled INTO the iOS App (Capacitor `webDir: "dist"`), so every asset must be
// referenced with a relative URL — the WebView loads them from `capacitor://localhost` with no
// server. `base: "./"` guarantees no absolute `/assets/...` URL that would 404 inside the App. There
// is deliberately no `server.url`/remote origin: the UI is never loaded from the Agent Server.
export default defineConfig({
	plugins: [react(), tailwindcss()],
	base: "./",
	build: {
		outDir: "dist",
		emptyOutDir: true,
		target: "es2021",
		sourcemap: false,
	},
	server: {
		host: "127.0.0.1",
		port: 5273,
		strictPort: true,
	},
});
