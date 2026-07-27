import { AppIcon } from "@moshu/ui";
import { type FormEvent, useCallback, useEffect, useRef, useState } from "react";
import { ConfirmationDialog } from "../confirmation-dialog";
import { useI18n } from "../i18n";
import { isRendererSessionRetired, useChatSessionRecovery } from "./session-recovery-coordinator";
import type { ChatSessionSummary, ChatTransport } from "./transport";

export interface SessionSidebarProps {
	transport: ChatTransport;
	selectedSessionId?: string;
	refreshKey: string;
	isNewSessionDisabled?: boolean;
	onNewSession(): void;
	onSessionUpdated?(session: ChatSessionSummary): void;
	onSelectSession(sessionId: string): void;
}

export function SessionSidebar({
	transport,
	selectedSessionId,
	refreshKey,
	isNewSessionDisabled = false,
	onNewSession,
	onSessionUpdated,
	onSelectSession,
}: SessionSidebarProps) {
	const { t } = useI18n();
	const { coordinator: sessionRecoveryCoordinator } = useChatSessionRecovery(
		transport,
		selectedSessionId,
	);
	const [query, setQuery] = useState("");
	const [showArchived, setShowArchived] = useState(false);
	const [isFilterOpen, setIsFilterOpen] = useState(false);
	const [showAllSessions, setShowAllSessions] = useState(false);
	const [sessions, setSessions] = useState<ChatSessionSummary[]>([]);
	const [isLoading, setIsLoading] = useState(true);
	const [errorMessage, setErrorMessage] = useState<string>();
	const [editingSessionId, setEditingSessionId] = useState<string>();
	const [editingTitle, setEditingTitle] = useState("");
	const [pendingSessionId, setPendingSessionId] = useState<string>();
	const [sessionToDelete, setSessionToDelete] = useState<ChatSessionSummary>();
	const [openMenuSessionId, setOpenMenuSessionId] = useState<string>();
	const requestNumberRef = useRef(0);
	const selectedSessionIdRef = useRef(selectedSessionId);
	const mountedRef = useRef(false);
	selectedSessionIdRef.current = selectedSessionId;

	useEffect(() => {
		mountedRef.current = true;
		return () => {
			mountedRef.current = false;
		};
	}, []);

	const loadSessions = useCallback(async (): Promise<void> => {
		const requestNumber = requestNumberRef.current + 1;
		requestNumberRef.current = requestNumber;
		setIsLoading(true);
		setErrorMessage(undefined);

		try {
			const items = await transport.listSessions({
				...(query.trim().length === 0 ? {} : { query: query.trim() }),
				archived: showArchived,
			});
			if (requestNumberRef.current === requestNumber) {
				setSessions(items.filter((session) => !isRendererSessionRetired(session.id)));
			}
		} catch {
			if (requestNumberRef.current === requestNumber) {
				setErrorMessage(t("sessions.error.load"));
			}
		} finally {
			if (requestNumberRef.current === requestNumber) {
				setIsLoading(false);
			}
		}
	}, [query, showArchived, t, transport]);

	// biome-ignore lint/correctness/useExhaustiveDependencies: refreshKey invalidates this query.
	useEffect(() => {
		void loadSessions();
		return () => {
			requestNumberRef.current += 1;
		};
	}, [loadSessions, refreshKey]);

	useEffect(() => {
		return transport.subscribeSessionInvalidations?.(() => {
			void loadSessions();
		});
	}, [loadSessions, transport]);

	useEffect(
		() =>
			sessionRecoveryCoordinator.subscribeRetirements((sessionId) => {
				setSessions((current) => current.filter((session) => session.id !== sessionId));
				setEditingSessionId((current) => (current === sessionId ? undefined : current));
				setPendingSessionId((current) => (current === sessionId ? undefined : current));
				setSessionToDelete((current) => (current?.id === sessionId ? undefined : current));
				setOpenMenuSessionId((current) => (current === sessionId ? undefined : current));
			}),
		[sessionRecoveryCoordinator],
	);

	const startRename = (session: ChatSessionSummary) => {
		setEditingSessionId(session.id);
		setEditingTitle(session.title);
		setErrorMessage(undefined);
		setOpenMenuSessionId(undefined);
	};

	const submitRename = async (event: FormEvent<HTMLFormElement>) => {
		event.preventDefault();
		if (editingSessionId === undefined || editingTitle.trim().length === 0) {
			return;
		}

		setPendingSessionId(editingSessionId);
		setErrorMessage(undefined);
		try {
			const updated = await transport.renameSession(editingSessionId, editingTitle.trim());
			if (!mountedRef.current) {
				return;
			}
			setSessions((current) =>
				current.map((session) => (session.id === updated.id ? updated : session)),
			);
			onSessionUpdated?.(updated);
			setEditingSessionId(undefined);
		} catch (error) {
			if (
				!sessionRecoveryCoordinator.handleSessionMiss(editingSessionId, error) &&
				mountedRef.current
			) {
				setErrorMessage(t("sessions.error.rename"));
			}
		} finally {
			if (mountedRef.current) {
				setPendingSessionId(undefined);
			}
		}
	};

	const toggleArchived = async (session: ChatSessionSummary) => {
		setPendingSessionId(session.id);
		setErrorMessage(undefined);
		setOpenMenuSessionId(undefined);
		try {
			const wasArchived = session.archivedAt !== undefined;
			const updated = await transport.setSessionArchived(session.id, !wasArchived);
			if (!mountedRef.current) {
				return;
			}
			setSessions((current) => current.filter((candidate) => candidate.id !== session.id));
			onSessionUpdated?.(updated);
			if (session.id === selectedSessionIdRef.current && !wasArchived) {
				onNewSession();
			}
		} catch (error) {
			if (!sessionRecoveryCoordinator.handleSessionMiss(session.id, error) && mountedRef.current) {
				setErrorMessage(
					session.archivedAt === undefined
						? t("sessions.error.archive")
						: t("sessions.error.restore"),
				);
			}
		} finally {
			if (mountedRef.current) {
				setPendingSessionId(undefined);
			}
		}
	};

	const deleteSession = async () => {
		const session = sessionToDelete;
		if (session === undefined) {
			return;
		}

		setPendingSessionId(session.id);
		setErrorMessage(undefined);
		try {
			await transport.deleteSession(session.id);
			sessionRecoveryCoordinator.recordSessionRetired(session.id);
			if (!mountedRef.current) {
				return;
			}
			setSessions((current) => current.filter((candidate) => candidate.id !== session.id));
		} catch (error) {
			if (!sessionRecoveryCoordinator.handleSessionMiss(session.id, error) && mountedRef.current) {
				setErrorMessage(t("sessions.error.delete"));
			}
		} finally {
			if (mountedRef.current) {
				setPendingSessionId(undefined);
				setSessionToDelete(undefined);
				setOpenMenuSessionId(undefined);
			}
		}
	};

	return (
		<aside className="session-sidebar" aria-label={t("sessions.title")}>
			<header className="session-sidebar__header">
				<h2>{t("sessions.title")}</h2>
				<div className="session-sidebar__header-actions">
					<button
						type="button"
						aria-label={t("sessions.filter.toggle")}
						aria-expanded={isFilterOpen}
						title={t("sessions.filter.toggle")}
						className={isFilterOpen || showArchived || query.trim().length > 0 ? "is-active" : ""}
						onClick={() => setIsFilterOpen((current) => !current)}
					>
						<AppIcon name="filter" size={17} />
					</button>
					<button
						type="button"
						aria-label={t("sessions.new")}
						title={t("sessions.new")}
						disabled={isNewSessionDisabled}
						onClick={onNewSession}
					>
						<AppIcon name="plus" size={18} />
					</button>
				</div>
			</header>

			{isFilterOpen ? (
				<div className="session-filter-panel">
					<label className="session-search">
						<span className="chat-live-region">{t("sessions.search.label")}</span>
						<input
							type="search"
							value={query}
							placeholder={t("sessions.search.placeholder")}
							onChange={(event) => {
								setQuery(event.currentTarget.value);
								setShowAllSessions(false);
							}}
						/>
					</label>

					<fieldset className="session-tabs">
						<legend className="chat-live-region">{t("sessions.filter.label")}</legend>
						<button
							type="button"
							className={showArchived ? "" : "is-active"}
							onClick={() => {
								setShowArchived(false);
								setShowAllSessions(false);
							}}
						>
							{t("sessions.filter.active")}
						</button>
						<button
							type="button"
							className={showArchived ? "is-active" : ""}
							onClick={() => {
								setShowArchived(true);
								setShowAllSessions(false);
							}}
						>
							{t("sessions.filter.archived")}
						</button>
					</fieldset>
				</div>
			) : null}

			{errorMessage ? (
				<p className="session-sidebar__error" role="alert">
					{errorMessage}
				</p>
			) : null}

			<div className="session-sidebar__group-title">
				<AppIcon name="chat" size={18} />
				<h3>{t("nav.chats")}</h3>
			</div>

			<div className="session-sidebar__list">
				{isLoading ? (
					<p className="session-sidebar__status" role="status">
						{t("sessions.loading")}
					</p>
				) : sessions.length === 0 ? (
					<p className="session-sidebar__status">
						{query.trim().length > 0
							? t("sessions.empty.search")
							: showArchived
								? t("sessions.empty.archived")
								: t("sessions.empty.active")}
					</p>
				) : (
					<>
						<ul className="session-list">
							{(showAllSessions ? sessions : sessions.slice(0, 8)).map((session) => {
								const isPending = pendingSessionId === session.id;
								return (
									<li
										key={session.id}
										className={
											session.id === selectedSessionId ? "session-item is-selected" : "session-item"
										}
									>
										{editingSessionId === session.id ? (
											<form
												className="session-rename"
												onSubmit={(event) => void submitRename(event)}
											>
												<input
													maxLength={200}
													aria-label={t("sessions.rename.label")}
													value={editingTitle}
													onChange={(event) => setEditingTitle(event.currentTarget.value)}
												/>
												<div>
													<button
														type="submit"
														disabled={isPending || editingTitle.trim().length === 0}
													>
														{t("sessions.rename.save")}
													</button>
													<button
														type="button"
														disabled={isPending}
														onClick={() => setEditingSessionId(undefined)}
													>
														{t("sessions.rename.cancel")}
													</button>
												</div>
											</form>
										) : (
											<>
												<button
													type="button"
													className="session-item__main"
													onClick={() => onSelectSession(session.id)}
												>
													<strong>{session.title}</strong>
												</button>
												<div
													className={
														openMenuSessionId === session.id
															? "session-item__menu is-open"
															: "session-item__menu"
													}
												>
													<button
														type="button"
														className="session-item__menu-trigger"
														aria-label={t("sessions.actions")}
														aria-expanded={openMenuSessionId === session.id}
														title={t("sessions.actions")}
														onClick={(event) => {
															event.preventDefault();
															setOpenMenuSessionId((current) =>
																current === session.id ? undefined : session.id,
															);
														}}
													>
														<AppIcon name="menu" size={16} />
													</button>
													{openMenuSessionId === session.id ? (
														<div>
															<button
																type="button"
																disabled={isPending}
																onClick={() => startRename(session)}
															>
																{t("sessions.rename.action")}
															</button>
															<button
																type="button"
																disabled={isPending}
																onClick={() => void toggleArchived(session)}
															>
																{session.archivedAt === undefined
																	? t("sessions.archive")
																	: t("sessions.restore")}
															</button>
															<ConfirmationDialog
																isOpen={sessionToDelete?.id === session.id}
																isPending={isPending}
																isTriggerDisabled={isPending}
																triggerLabel={t("sessions.delete.action")}
																triggerClassName="confirmation-dialog-trigger confirmation-dialog-trigger--menu session-item__delete"
																title={t("sessions.delete.title")}
																description={t("sessions.delete.confirm", session.title)}
																cancelLabel={t("action.cancel")}
																confirmLabel={t("sessions.delete.action")}
																pendingLabel={t("sessions.deleting")}
																onOpenChange={(isOpen) =>
																	setSessionToDelete(isOpen ? session : undefined)
																}
																onConfirm={deleteSession}
															/>
														</div>
													) : null}
												</div>
											</>
										)}
									</li>
								);
							})}
						</ul>
						{sessions.length > 8 ? (
							<button
								type="button"
								className="session-list__more"
								onClick={() => setShowAllSessions((current) => !current)}
							>
								{showAllSessions ? t("sessions.showLess") : t("sessions.showMore")}
							</button>
						) : null}
					</>
				)}
			</div>
		</aside>
	);
}
