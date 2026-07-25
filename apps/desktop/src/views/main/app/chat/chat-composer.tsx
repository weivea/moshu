import { Button } from "@heroui/react";
import { type KeyboardEvent, useId } from "react";
import { useI18n } from "../i18n";

export interface ChatComposerProps {
	canSend: boolean;
	draft: string;
	isResponding: boolean;
	isStopping: boolean;
	onDraftChange(value: string): void;
	onSend(): void;
	onStop(): void;
}

export function ChatComposer({
	canSend,
	draft,
	isResponding,
	isStopping,
	onDraftChange,
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
				<span>{t("chat.composer.label")}</span>
				<textarea
					id={textareaId}
					name="message"
					rows={4}
					value={draft}
					onChange={(event) => onDraftChange(event.target.value)}
					onKeyDown={handleKeyDown}
					placeholder={t("chat.composer.placeholder")}
				/>
			</label>

			<div className="chat-composer__footer">
				<p>{t("chat.composer.hint")}</p>
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
						<Button
							className="chat-button chat-button--primary"
							onPress={onSend}
							isDisabled={!canSend}
						>
							{t("chat.composer.send")}
						</Button>
					)}
				</div>
			</div>
		</section>
	);
}
