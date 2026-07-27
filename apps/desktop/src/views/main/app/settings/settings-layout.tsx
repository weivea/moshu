import { Outlet } from "react-router-dom";

import { SettingsNavigation } from "./settings-navigation";

export function SettingsLayout() {
	return (
		<section className="settings-page">
			<div className="settings-page__body">
				<SettingsNavigation />
				<div className="settings-page__content">
					<Outlet />
				</div>
			</div>
		</section>
	);
}
