import type { CapacitorConfig } from "@capacitor/cli";

// Development bundle identity only. Signing team/provisioning is intentionally NOT encoded here or in
// the Xcode project — it is supplied at build time by whoever signs the App. The Web UI is bundled
// (`webDir`) and there is no `server.url`, so the App never loads UI from a remote origin.
const config: CapacitorConfig = {
	appId: "dev.moshu.mobile",
	appName: "Moshu",
	webDir: "dist",
	ios: {
		// The Web layer manages its own safe-area insets and internal scrolling, so the native WebView
		// must never inset or bounce the content. Mirrors the mature pinyin-learning configuration.
		contentInset: "never",
		scrollEnabled: false,
		limitsNavigationsToAppBoundDomains: true,
		backgroundColor: "#0d1015",
	},
	server: {
		// Local bundle load only; never a remote UI origin.
		androidScheme: "https",
		iosScheme: "capacitor",
	},
};

export default config;
