import { RouterProvider } from "react-router-dom";
import { I18nProvider } from "./i18n";
import { LocalProfileProvider } from "./local-profile";
import { AppearanceProvider } from "./providers";
import { router } from "./router";

export function App() {
	return (
		<I18nProvider>
			<AppearanceProvider>
				<LocalProfileProvider>
					<RouterProvider router={router} />
				</LocalProfileProvider>
			</AppearanceProvider>
		</I18nProvider>
	);
}
