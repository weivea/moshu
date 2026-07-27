import { Button } from "@heroui/react";
import type { AvailableModel, DefaultModelSelection } from "@moshu/contracts";
import { useEffect, useState } from "react";

import type { ChatTransport } from "../chat/transport";
import { type MessageKey, useI18n } from "../i18n";
import { ModelSelector } from "./model-selector";

export interface DefaultModelSettingsPageProps {
	transport: ChatTransport;
}

export function DefaultModelSettingsPage({ transport }: DefaultModelSettingsPageProps) {
	const { t } = useI18n();
	const [models, setModels] = useState<AvailableModel[]>([]);
	const [selection, setSelection] = useState<DefaultModelSelection>();
	const [isLoading, setIsLoading] = useState(true);
	const [isSaving, setIsSaving] = useState(false);
	const [feedback, setFeedback] = useState<{ tone: "info" | "danger"; messageKey: MessageKey }>();

	useEffect(() => {
		let active = true;
		void transport
			.listAvailableModels()
			.then((output) => {
				if (!active) {
					return;
				}
				setModels(output.models);
				setSelection(output.defaultModel);
			})
			.catch(() => {
				if (active) {
					setFeedback({ tone: "danger", messageKey: "defaultModel.error.load" });
				}
			})
			.finally(() => {
				if (active) {
					setIsLoading(false);
				}
			});

		return () => {
			active = false;
		};
	}, [transport]);

	const save = async (next: DefaultModelSelection | null) => {
		setIsSaving(true);
		setFeedback(undefined);
		try {
			setSelection(await transport.setDefaultModel(next));
			setFeedback({ tone: "info", messageKey: "defaultModel.saved" });
		} catch {
			setFeedback({ tone: "danger", messageKey: "defaultModel.error.save" });
		} finally {
			setIsSaving(false);
		}
	};

	return (
		<section className="settings-section">
			<header className="settings-section__header">
				<h1>{t("defaultModel.title")}</h1>
				<p>{t("defaultModel.description")}</p>
			</header>

			{feedback === undefined ? null : (
				<div
					className={`chat-notice chat-notice--${feedback.tone}`}
					role={feedback.tone === "danger" ? "alert" : "status"}
				>
					{t(feedback.messageKey)}
				</div>
			)}

			{isLoading ? (
				<p className="chat-loading" role="status">
					{t("providers.loading")}
				</p>
			) : (
				<section className="chat-card default-model-card">
					<span className="chat-card__eyebrow">{t("defaultModel.current")}</span>
					{models.length === 0 ? (
						<p className="provider-models__hint">{t("defaultModel.empty")}</p>
					) : (
						<>
							{selection === undefined ? (
								<p className="provider-models__hint">{t("defaultModel.none")}</p>
							) : null}
							<ModelSelector
								models={models}
								isDisabled={isSaving}
								{...(selection === undefined
									? {}
									: {
											providerId: selection.providerId,
											modelId: selection.modelId,
											...(selection.reasoning === undefined
												? {}
												: { reasoning: selection.reasoning }),
										})}
								onSelect={(providerId, modelId) => void save({ providerId, modelId })}
								onReasoningChange={(reasoning) => {
									if (selection === undefined) {
										return;
									}
									void save({
										providerId: selection.providerId,
										modelId: selection.modelId,
										...(reasoning === undefined ? {} : { reasoning }),
									});
								}}
							/>
							{selection === undefined ? null : (
								<Button
									className="chat-button"
									isDisabled={isSaving}
									onPress={() => void save(null)}
								>
									{t("defaultModel.clear")}
								</Button>
							)}
						</>
					)}
				</section>
			)}
		</section>
	);
}
