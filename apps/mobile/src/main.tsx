import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { HashRouter } from "react-router-dom";
import { App } from "./app/app";
import { AppearanceProvider } from "./app/appearance";
import { AttentionProvider } from "./app/attention";
import { ConnectionProvider } from "./app/connection";
import { I18nProvider } from "./app/i18n";
import "./styles.css";

const container = document.getElementById("root");
if (!container) {
	throw new Error("Missing #root element.");
}

createRoot(container).render(
	<StrictMode>
		<AppearanceProvider>
			<I18nProvider>
				<HashRouter>
					<ConnectionProvider>
						<AttentionProvider>
							<App />
						</AttentionProvider>
					</ConnectionProvider>
				</HashRouter>
			</I18nProvider>
		</AppearanceProvider>
	</StrictMode>,
);
