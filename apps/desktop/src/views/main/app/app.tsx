import { RouterProvider } from "react-router-dom";
import { I18nProvider } from "./i18n";
import { AppearanceProvider } from "./providers";
import { router } from "./router";

export function App() {
	return (
		<I18nProvider>
			<AppearanceProvider>
				<RouterProvider router={router} />
			</AppearanceProvider>
		</I18nProvider>
	);
}
