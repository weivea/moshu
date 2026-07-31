import { Button } from "@heroui/react";
import { AppIcon } from "@moshu/ui";
import { useState } from "react";
import { useAppearance } from "../app/appearance";
import { useConnection, useConnectedSession } from "../app/connection";
import { useI18n } from "../app/i18n";
import type { Language } from "../app/i18n";
import { useWorkspace } from "../app/workspace";
import { Screen, ScreenHeader, ScrollArea } from "../components/layout";

function Row({ label, value }: { label: string; value: string }) {
	return (
		<div className="flex items-center justify-between gap-3 border-b border-[var(--line)] px-4 py-3 text-sm last:border-b-0">
			<span className="text-[var(--text-muted)]">{label}</span>
			<span className="max-w-[60%] truncate text-right font-mono text-xs text-[var(--text)]">
				{value}
			</span>
		</div>
	);
}

export function SettingsScreen() {
	const { t, language, setLanguage } = useI18n();
	const { theme, setTheme } = useAppearance();
	const { binding } = useConnectedSession();
	const { controller } = useConnection();
	const { runtimeBoxes, activeRuntimeBoxId, switchRuntimeBox } = useWorkspace();
	const [confirmUnpair, setConfirmUnpair] = useState(false);
	const [unpairing, setUnpairing] = useState(false);

	return (
		<Screen>
			<ScreenHeader title={t("settings.title")} />
			<ScrollArea>
				<p className="section-label">{t("settings.connection")}</p>
				<div className="card mx-4 overflow-hidden">
					<Row label={t("settings.server")} value={binding.serverLabel} />
					<Row label={t("settings.serverFingerprint")} value={binding.serverPublicKeyFingerprint} />
					<Row label={t("settings.deviceFingerprint")} value={binding.devicePublicKeyFingerprint} />
					<Row label={t("settings.protocol")} value={String(binding.protocolVersion)} />
					<Row label={t("settings.transport")} value={binding.transportSecurity} />
				</div>

				<p className="section-label">{t("settings.security")}</p>
				<div className="mx-4 space-y-2 text-xs text-[var(--text-muted)]">
					<p>{t("settings.securityNote")}</p>
					<p className="flex items-center gap-2">
						<AppIcon name="settings" size={14} />
						{t("settings.softwareKey")}
					</p>
					<p className="flex items-center gap-2">
						<AppIcon name="globe" size={14} />
						{t("settings.relayVisible")}
					</p>
				</div>

				<p className="section-label">{t("settings.runtimeBox")}</p>
				<p className="px-4 pb-2 text-xs text-[var(--text-muted)]">{t("settings.runtimeBoxNote")}</p>
				<div className="card mx-4 overflow-hidden">
					{(runtimeBoxes?.items ?? []).map((item) => {
						const selected = item.runtimeBox.runtimeBoxId === activeRuntimeBoxId;
						return (
							<button
								key={item.runtimeBox.runtimeBoxId}
								type="button"
								className="list-row justify-between"
								aria-pressed={selected}
								onClick={() => void switchRuntimeBox(item.runtimeBox.runtimeBoxId)}
							>
								<span className="min-w-0">
									<span className="block truncate text-sm font-medium text-[var(--text)]">
										{item.runtimeBox.displayName}
									</span>
									<span className="block text-xs text-[var(--text-muted)]">{item.state}</span>
								</span>
								{selected ? (
									<span className="text-[var(--accent)]">
										<AppIcon name="check" size={18} />
									</span>
								) : null}
							</button>
						);
					})}
				</div>

				<p className="section-label">{t("settings.appearance")}</p>
				<div className="card mx-4 overflow-hidden">
					<div className="flex items-center justify-between px-4 py-3">
						<span className="text-sm text-[var(--text-muted)]">{t("settings.theme")}</span>
						<div className="flex gap-1">
							<Button
								variant={theme === "light" ? "primary" : "ghost"}
								size="sm"
								onPress={() => setTheme("light")}
							>
								{t("settings.theme.light")}
							</Button>
							<Button
								variant={theme === "dark" ? "primary" : "ghost"}
								size="sm"
								onPress={() => setTheme("dark")}
							>
								{t("settings.theme.dark")}
							</Button>
						</div>
					</div>
					<div className="flex items-center justify-between border-t border-[var(--line)] px-4 py-3">
						<span className="text-sm text-[var(--text-muted)]">{t("settings.language")}</span>
						<div className="flex gap-1">
							{(["en", "zh"] as Language[]).map((lang) => (
								<Button
									key={lang}
									variant={language === lang ? "primary" : "ghost"}
									size="sm"
									onPress={() => setLanguage(lang)}
								>
									{t(lang === "en" ? "settings.language.en" : "settings.language.zh")}
								</Button>
							))}
						</div>
					</div>
				</div>

				<div className="p-4">
					{confirmUnpair ? (
						<div className="card space-y-3 p-4">
							<p className="font-semibold text-[var(--text)]">{t("settings.unpair.title")}</p>
							<p className="text-sm text-[var(--text-muted)]">{t("settings.unpair.body")}</p>
							<div className="flex gap-2">
								<Button
									variant="danger"
									fullWidth
									isDisabled={unpairing}
									onPress={() => {
										setUnpairing(true);
										void controller.unpair();
									}}
								>
									{unpairing ? t("settings.unpairing") : t("settings.unpair.confirm")}
								</Button>
								<Button
									variant="ghost"
									fullWidth
									isDisabled={unpairing}
									onPress={() => setConfirmUnpair(false)}
								>
									{t("settings.unpair.cancel")}
								</Button>
							</div>
						</div>
					) : (
						<Button variant="danger-soft" fullWidth onPress={() => setConfirmUnpair(true)}>
							{t("settings.unpair")}
						</Button>
					)}
				</div>
			</ScrollArea>
		</Screen>
	);
}
