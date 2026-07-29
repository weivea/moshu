import { RouterProvider } from "react-router-dom";
import { I18nProvider } from "./i18n";
import { LocalProfileProvider } from "./local-profile";
import { AppearanceProvider } from "./providers";
import { RuntimeBoxesProvider } from "./runtime-boxes";
import { router } from "./router";

export function App() {
	return (
		<I18nProvider>
			<AppearanceProvider>
				<LocalProfileProvider>
					<RuntimeBoxesProvider>
						<RouterProvider router={router} />
					</RuntimeBoxesProvider>
				</LocalProfileProvider>
			</AppearanceProvider>
		</I18nProvider>
	);
}
