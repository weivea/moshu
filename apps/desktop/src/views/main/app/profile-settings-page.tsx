import { Button } from "@heroui/react";
import { type FormEvent, useState } from "react";
import { useI18n } from "./i18n";
import { useLocalProfile } from "./local-profile";
import { useAppearance } from "./providers";
import { SettingsNavigation } from "./settings-navigation";

export function ProfileSettingsPage() {
	const { t, toggleLocale } = useI18n();
	const { toggleTheme } = useAppearance();
	const profile = useLocalProfile();
	const [username, setUsername] = useState(profile.username ?? t("profile.defaultName"));
	const [saved, setSaved] = useState(false);

	const saveProfile = (event: FormEvent<HTMLFormElement>) => {
		event.preventDefault();
		const normalizedUsername = username.trim();
		if (normalizedUsername.length === 0) {
			return;
		}
		profile.setUsername(normalizedUsername);
		setUsername(normalizedUsername);
		setSaved(true);
	};

	return (
		<section className="profile-settings-page">
			<SettingsNavigation />

			<header className="settings-page__header">
				<span className="chat-page__eyebrow">{t("profile.eyebrow")}</span>
				<h1>{t("profile.title")}</h1>
				<p>{t("profile.description")}</p>
			</header>

			<div className="settings-page__grid">
				<form className="chat-card profile-form" onSubmit={saveProfile}>
					<div className="profile-preview" aria-hidden="true">
						<span>{(profile.username ?? t("profile.defaultName")).slice(0, 1).toUpperCase()}</span>
					</div>
					<label className="chat-field">
						<span>{t("profile.username")}</span>
						<input
							required
							maxLength={48}
							value={username}
							onChange={(event) => {
								setUsername(event.currentTarget.value);
								setSaved(false);
							}}
						/>
					</label>
					<div className="provider-form__actions">
						{saved ? <span className="profile-form__saved">{t("profile.saved")}</span> : null}
						<Button
							type="submit"
							className="chat-button chat-button--primary"
							isDisabled={username.trim().length === 0}
						>
							{t("profile.save")}
						</Button>
					</div>
				</form>

				<section className="chat-card appearance-card">
					<div>
						<span className="chat-card__eyebrow">{t("profile.appearance.eyebrow")}</span>
						<h2>{t("profile.appearance.title")}</h2>
					</div>
					<p>{t("profile.appearance.description")}</p>
					<div className="appearance-card__actions">
						<Button className="chat-button" onPress={toggleTheme}>
							{t("action.toggleTheme")}
						</Button>
						<Button className="chat-button" onPress={toggleLocale}>
							{t("action.toggleLanguage")}
						</Button>
					</div>
				</section>
			</div>
		</section>
	);
}
