import { RouterProvider } from "react-router-dom";
import { ApprovalsProvider } from "./approvals";
import { I18nProvider } from "./i18n";
import { LocalProfileProvider } from "./local-profile";
import { ProjectDataProvider } from "./projects/project-data";
import { AppearanceProvider } from "./providers";
import { router } from "./router";
import { RuntimeBoxesProvider } from "./runtime-boxes";

export function App() {
	return (
		<I18nProvider>
			<AppearanceProvider>
				<LocalProfileProvider>
					<RuntimeBoxesProvider>
						<ProjectDataProvider>
							<ApprovalsProvider>
								<RouterProvider router={router} />
							</ApprovalsProvider>
						</ProjectDataProvider>
					</RuntimeBoxesProvider>
				</LocalProfileProvider>
			</AppearanceProvider>
		</I18nProvider>
	);
}
