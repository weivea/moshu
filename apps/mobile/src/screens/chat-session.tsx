import type { AvailableModel, SessionModelSelection, ThinkingLevel } from "@moshu/contracts";
import { Button, Spinner } from "@heroui/react";
import { AppIcon } from "@moshu/ui";
import { useEffect, useMemo, useReducer, useRef, useState } from "react";
import { useNavigate, useParams } from "react-router-dom";
import { useConnectedSession } from "../app/connection";
import { useI18n } from "../app/i18n";
import { useWorkspace } from "../app/workspace";
import { ApprovalCard } from "../components/approval-card";
import { CenteredState, LoadingState } from "../components/layout";
import { ChatSessionController } from "../rpc/chat-session-controller";

function modelKey(providerId: string, modelId: string): string {
	return `${providerId}\u0000${modelId}`;
}

export function ChatSessionScreen() {
	const { sessionId = "" } = useParams();
	const { t } = useI18n();
	const navigate = useNavigate();
	const { client, bus } = useConnectedSession();
	const { pendingApprovals, policies } = useWorkspace();
	const [, force] = useReducer((value: number) => value + 1, 0);
	const controllerRef = useRef<ChatSessionController | null>(null);
	const [draft, setDraft] = useState("");
	const [sending, setSending] = useState(false);
	const [models, setModels] = useState<AvailableModel[]>([]);
	const listRef = useRef<HTMLDivElement | null>(null);

	useEffect(() => {
		const controller = new ChatSessionController({
			client,
			bus,
			sessionId,
			onChange: force,
		});
		controllerRef.current = controller;
		void controller.start();
		return () => {
			controllerRef.current = null;
			void controller.dispose();
		};
	}, [client, bus, sessionId]);

	useEffect(() => {
		let active = true;
		void client
			.listAvailableModels()
			.then((result) => {
				if (active) {
					setModels(result.models);
				}
			})
			.catch(() => {
				/* selector stays empty; sending still works with the session default */
			});
		return () => {
			active = false;
		};
	}, [client]);

	const view = controllerRef.current?.getView();

	// biome-ignore lint/correctness/useExhaustiveDependencies: Message activity intentionally triggers auto-scroll.
	useEffect(() => {
		const node = listRef.current;
		if (node) {
			node.scrollTop = node.scrollHeight;
		}
	}, [view?.messages.length, view?.responding]);

	const sessionApprovals = useMemo(
		() => pendingApprovals.filter((request) => request.sessionId === sessionId),
		[pendingApprovals, sessionId],
	);
	const policy = useMemo(
		() => policies.find((item) => item.sessionId === sessionId),
		[policies, sessionId],
	);

	const selectedModel = view?.model ?? null;
	const activeModel = useMemo(() => {
		if (!selectedModel) {
			return undefined;
		}
		return models.find(
			(entry) =>
				entry.providerId === selectedModel.providerId && entry.model.id === selectedModel.modelId,
		);
	}, [models, selectedModel]);

	async function persistModel(next: SessionModelSelection | null): Promise<void> {
		controllerRef.current?.applyModel(next);
		try {
			await client.setSessionModel({ sessionId, model: next });
		} catch {
			/* keep optimistic selection; next snapshot reconciles */
		}
	}

	function onModelChange(value: string): void {
		const [providerId, modelId] = value.split("\u0000");
		const entry = models.find(
			(item) => item.providerId === providerId && item.model.id === modelId,
		);
		if (!entry) {
			return;
		}
		const thinking = entry.model.thinkingLevels[0];
		void persistModel({
			providerId: entry.providerId,
			modelId: entry.model.id,
			...(thinking ? { thinkingLevel: thinking } : {}),
		});
	}

	function onThinkingChange(level: ThinkingLevel): void {
		if (!selectedModel) {
			return;
		}
		void persistModel({ ...selectedModel, thinkingLevel: level });
	}

	async function send(): Promise<void> {
		const content = draft.trim();
		const controller = controllerRef.current;
		if (!content || !controller || sending) {
			return;
		}
		setSending(true);
		try {
			// The controller owns the requestId reservation: retrying the same draft reuses it so the
			// server dedupes to one run; only editing the draft mints a new id.
			await controller.send(content);
			setDraft("");
		} catch {
			/* Do not auto-resend an unknown send; leave the draft so a Retry reuses the same requestId. */
		} finally {
			setSending(false);
		}
	}

	if (!view || view.phase === "loading") {
		return <LoadingState label={t("common.loading")} />;
	}
	if (view.phase === "error") {
		return (
			<CenteredState title={t("chat.loadError")} body={view.errorMessage}>
				<Button variant="ghost" onPress={() => navigate("/chats")}>
					{t("chat.back")}
				</Button>
			</CenteredState>
		);
	}

	return (
		<div className="flex h-full min-h-0 flex-col">
			<header className="safe-top flex items-center gap-2 border-b border-[var(--line)] px-2 pb-2 pt-2">
				<Button
					variant="ghost"
					size="sm"
					isIconOnly
					aria-label={t("chat.back")}
					onPress={() => navigate("/chats")}
				>
					<AppIcon name="back" size={22} />
				</Button>
				<h1 className="min-w-0 flex-1 truncate text-base font-semibold text-[var(--text)]">
					{view.title}
				</h1>
			</header>

			<div ref={listRef} className="app-scroll min-h-0 flex-1 space-y-3 px-4 py-4">
				{view.messages.length === 0 && sessionApprovals.length === 0 ? (
					<p className="py-10 text-center text-sm text-[var(--text-muted)]">{t("chat.empty")}</p>
				) : null}
				{view.messages.map((message) => (
					<MessageBubble
						key={message.id}
						role={message.role}
						content={message.content}
						status={message.status}
						failedLabel={t("chat.status.failed")}
						cancelledLabel={t("chat.status.cancelled")}
					/>
				))}
				{sessionApprovals.map((request) => (
					<ApprovalCard key={request.id} request={request} policy={policy} />
				))}
				{view.responding ? (
					<div className="flex items-center gap-2 text-sm text-[var(--text-muted)]">
						<Spinner size="sm" aria-hidden="true" />
						<span>{t("chat.streaming")}</span>
					</div>
				) : null}
			</div>

			<div className="composer-inset border-t border-[var(--line)] bg-[var(--surface)] px-3 pt-2">
				{view.pendingSendAmbiguous ? (
					<div
						role="status"
						className="mb-2 rounded-md bg-[var(--warning-soft,var(--surface-muted))] px-2 py-1 text-xs text-[var(--text-muted)]"
					>
						{t("chat.composer.retryHint")}
					</div>
				) : null}
				<div className="mb-2 flex items-center gap-2 overflow-x-auto text-xs">
					<label className="flex items-center gap-1 text-[var(--text-muted)]">
						<span className="sr-only">{t("chat.model")}</span>
						<AppIcon name="agents" size={16} />
						<select
							aria-label={t("chat.model")}
							value={selectedModel ? modelKey(selectedModel.providerId, selectedModel.modelId) : ""}
							onChange={(event) => onModelChange(event.target.value)}
							className="max-w-[9rem] truncate rounded-md bg-[var(--surface-muted)] px-2 py-1 text-[var(--text)]"
						>
							<option value="" disabled>
								{t("chat.noModel")}
							</option>
							{models.map((entry) => (
								<option
									key={modelKey(entry.providerId, entry.model.id)}
									value={modelKey(entry.providerId, entry.model.id)}
								>
									{entry.model.displayName}
								</option>
							))}
						</select>
					</label>
					{activeModel && activeModel.model.thinkingLevels.length > 0 ? (
						<label className="flex items-center gap-1 text-[var(--text-muted)]">
							<span className="sr-only">{t("chat.thinking")}</span>
							<select
								aria-label={t("chat.thinking")}
								value={selectedModel?.thinkingLevel ?? ""}
								onChange={(event) => onThinkingChange(event.target.value as ThinkingLevel)}
								className="rounded-md bg-[var(--surface-muted)] px-2 py-1 text-[var(--text)]"
							>
								{activeModel.model.thinkingLevels.map((level) => (
									<option key={level} value={level}>
										{level}
									</option>
								))}
							</select>
						</label>
					) : null}
					{policy?.allowAll ? (
						<span className="pill bg-[var(--accent-soft)] text-[var(--accent)]">
							{t("approval.allowAllOn")}
						</span>
					) : null}
				</div>
				<div className="flex items-end gap-2 pb-2">
					<textarea
						value={draft}
						onChange={(event) => setDraft(event.target.value)}
						onKeyDown={(event) => {
							if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) {
								event.preventDefault();
								void send();
							}
						}}
						placeholder={t("chat.composer.placeholder")}
						aria-label={t("chat.composer.placeholder")}
						rows={1}
						className="max-h-32 min-h-[2.75rem] min-w-0 flex-1 resize-none rounded-[var(--radius)] border border-[var(--line)] bg-[var(--app-bg)] px-3 py-2 text-[var(--text)] outline-none focus:border-[var(--accent)]"
					/>
					{view.responding ? (
						<Button
							variant="danger-soft"
							isDisabled={view.stopping}
							onPress={() => void controllerRef.current?.cancel()}
						>
							{view.stopping ? t("chat.composer.stopping") : t("chat.composer.stop")}
						</Button>
					) : (
						<Button
							variant="primary"
							isDisabled={sending || draft.trim().length === 0}
							onPress={() => void send()}
						>
							{t("chat.composer.send")}
						</Button>
					)}
				</div>
			</div>
		</div>
	);
}

function MessageBubble({
	role,
	content,
	status,
	failedLabel,
	cancelledLabel,
}: {
	role: "user" | "assistant";
	content: string;
	status: string;
	failedLabel: string;
	cancelledLabel: string;
}) {
	const isUser = role === "user";
	return (
		<div className={`flex ${isUser ? "justify-end" : "justify-start"}`}>
			<div
				className={`max-w-[85%] whitespace-pre-wrap break-words rounded-2xl px-3 py-2 text-sm ${
					isUser
						? "bg-[var(--accent)] text-[var(--accent-contrast)]"
						: "bg-[var(--surface)] text-[var(--text)]"
				}`}
			>
				{content}
				{status === "failed" ? (
					<p className="mt-1 text-xs text-[var(--danger)]">{failedLabel}</p>
				) : null}
				{status === "cancelled" ? (
					<p className="mt-1 text-xs text-[var(--text-muted)]">{cancelledLabel}</p>
				) : null}
			</div>
		</div>
	);
}
