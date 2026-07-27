import { Button } from "@heroui/react";
import type { AvailableModel, ReasoningSelection } from "@moshu/contracts";
import { AppIcon } from "@moshu/ui";
import { type KeyboardEvent, useId } from "react";
import { useI18n } from "../i18n";
import { ModelSelector } from "../settings/model-selector";
import type { SessionModelSelection } from "./transport";

export interface ChatComposerProps {
	canSend: boolean;
	draft: string;
	isResponding: boolean;
	isStopping: boolean;
	availableModels: readonly AvailableModel[];
	selectedModel?: AvailableModel;
	reasoning?: ReasoningSelection;
	onDraftChange(value: string): void;
	onModelChange(selection: SessionModelSelection | null): void;
	onSend(): void;
	onStop(): void;
}

export function ChatComposer({
	canSend,
	draft,
	isResponding,
	isStopping,
	availableModels,
	selectedModel,
	reasoning,
	onDraftChange,
	onModelChange,
	onSend,
	onStop,
}: ChatComposerProps) {
	const { t } = useI18n();
	const textareaId = useId();

	function handleKeyDown(event: KeyboardEvent<HTMLTextAreaElement>) {
		if (event.key !== "Enter" || event.shiftKey || event.nativeEvent.isComposing) {
			return;
		}

		event.preventDefault();
		if (canSend) {
			onSend();
		}
	}

	return (
		<section className="chat-card chat-card--composer">
			<label className="chat-field chat-field--composer" htmlFor={textareaId}>
				<span className="chat-live-region">{t("chat.composer.label")}</span>
				<textarea
					id={textareaId}
					name="message"
					rows={3}
					value={draft}
					onChange={(event) => onDraftChange(event.target.value)}
					onKeyDown={handleKeyDown}
					placeholder={t("chat.composer.placeholder")}
				/>
			</label>

			<div className="chat-composer__footer">
				<ModelSelector
					models={availableModels}
					isDisabled={isResponding}
					{...(selectedModel === undefined
						? {}
						: { providerId: selectedModel.providerId, modelId: selectedModel.model.id })}
					{...(reasoning === undefined ? {} : { reasoning })}
					onSelect={(providerId, modelId) =>
						onModelChange({
							providerId,
							modelId,
							...(reasoning === undefined ? {} : { reasoning }),
						})
					}
					onReasoningChange={(nextReasoning) => {
						if (selectedModel === undefined) {
							return;
						}
						onModelChange({
							providerId: selectedModel.providerId,
							modelId: selectedModel.model.id,
							...(nextReasoning === undefined ? {} : { reasoning: nextReasoning }),
						});
					}}
				/>
				<div className="chat-composer__actions">
					{isResponding ? (
						<Button
							className="chat-button chat-button--danger"
							onPress={onStop}
							isDisabled={isStopping}
						>
							{isStopping ? t("chat.composer.stopping") : t("chat.composer.stop")}
						</Button>
					) : (
						<button
							type="button"
							className="chat-button chat-button--primary"
							aria-label={t("chat.composer.send")}
							title={t("chat.composer.send")}
							onClick={onSend}
							disabled={!canSend}
						>
							<AppIcon name="send" size={17} />
						</button>
					)}
				</div>
			</div>
		</section>
	);
}
