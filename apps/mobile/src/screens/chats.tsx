import type { ChatSession } from "@moshu/contracts";
import { Button } from "@heroui/react";
import { AppIcon } from "@moshu/ui";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useNavigate } from "react-router-dom";
import { useConnectedSession } from "../app/connection";
import { useI18n } from "../app/i18n";
import { useWorkspace } from "../app/workspace";
import { EmptyRow, LoadingState, Screen, ScreenHeader, ScrollArea } from "../components/layout";
import { formatTimestamp } from "../lib/format";
import { newUuid } from "../lib/uuid";

export function ChatsScreen() {
	const { t, language } = useI18n();
	const navigate = useNavigate();
	const { client } = useConnectedSession();
	const { activeRuntimeBoxId } = useWorkspace();
	const [sessions, setSessions] = useState<ChatSession[] | null>(null);
	const [query, setQuery] = useState("");
	const [creating, setCreating] = useState(false);
	const [showCreate, setShowCreate] = useState(false);
	const [newTitle, setNewTitle] = useState("");
	const mounted = useRef(true);

	const load = useCallback(async () => {
		if (!activeRuntimeBoxId) {
			return;
		}
		const result = await client.listSessions({ runtimeBoxId: activeRuntimeBoxId, limit: 100 });
		if (mounted.current) {
			setSessions([...result.items]);
		}
	}, [client, activeRuntimeBoxId]);

	useEffect(() => {
		mounted.current = true;
		void load();
		return () => {
			mounted.current = false;
		};
	}, [load]);

	const filtered = useMemo(() => {
		if (!sessions) {
			return null;
		}
		const needle = query.trim().toLowerCase();
		const visible = needle
			? sessions.filter((session) => session.title.toLowerCase().includes(needle))
			: sessions;
		return [...visible].sort((a, b) => (a.updatedAt < b.updatedAt ? 1 : -1));
	}, [sessions, query]);

	async function create(): Promise<void> {
		if (!activeRuntimeBoxId || newTitle.trim().length === 0) {
			return;
		}
		setCreating(true);
		try {
			const result = await client.createSession({
				schemaVersion: 1,
				title: newTitle.trim(),
				defaultMode: "agent",
				createKey: newUuid(),
				runtimeBoxId: activeRuntimeBoxId,
			});
			setShowCreate(false);
			setNewTitle("");
			navigate(`/chats/${result.session.id}`);
		} finally {
			setCreating(false);
		}
	}

	return (
		<Screen>
			<ScreenHeader
				title={t("chats.title")}
				trailing={
					<Button
						variant="ghost"
						size="sm"
						isIconOnly
						aria-label={t("chats.new")}
						onPress={() => setShowCreate((value) => !value)}
					>
						<AppIcon name="plus" size={22} />
					</Button>
				}
			/>
			<div className="border-b border-[var(--line)] px-4 py-2">
				<input
					type="search"
					value={query}
					onChange={(event) => setQuery(event.target.value)}
					placeholder={t("chats.search")}
					aria-label={t("chats.search")}
					className="w-full rounded-[var(--radius)] bg-[var(--surface-muted)] px-3 py-2 text-[var(--text)] outline-none"
				/>
			</div>

			{showCreate ? (
				<div className="flex gap-2 border-b border-[var(--line)] px-4 py-3">
					<input
						value={newTitle}
						onChange={(event) => setNewTitle(event.target.value)}
						placeholder={t("chats.newTitlePlaceholder")}
						aria-label={t("chats.newTitlePlaceholder")}
						className="min-w-0 flex-1 rounded-[var(--radius)] border border-[var(--line)] bg-[var(--surface)] px-3 py-2 text-[var(--text)] outline-none focus:border-[var(--accent)]"
					/>
					<Button
						variant="primary"
						size="sm"
						isDisabled={creating || newTitle.trim().length === 0}
						onPress={() => void create()}
					>
						{creating ? t("chats.creating") : t("chats.create")}
					</Button>
				</div>
			) : null}

			<ScrollArea>
				{filtered === null ? (
					<LoadingState label={t("chats.loading")} />
				) : filtered.length === 0 ? (
					<EmptyRow label={t("chats.empty")} />
				) : (
					<ul>
						{filtered.map((session) => (
							<li key={session.id}>
								<button
									type="button"
									className="list-row"
									onClick={() => navigate(`/chats/${session.id}`)}
								>
									<span className="text-[var(--text-faint)]">
										<AppIcon name="chat" size={20} />
									</span>
									<span className="min-w-0 flex-1">
										<span className="block truncate font-medium text-[var(--text)]">
											{session.title}
										</span>
										<span className="block truncate text-xs text-[var(--text-muted)]">
											{t("chats.lastActivity", formatTimestamp(session.updatedAt, language))}
										</span>
									</span>
									<span className="text-[var(--text-faint)]">
										<AppIcon name="forward" size={18} />
									</span>
								</button>
							</li>
						))}
					</ul>
				)}
			</ScrollArea>
		</Screen>
	);
}
