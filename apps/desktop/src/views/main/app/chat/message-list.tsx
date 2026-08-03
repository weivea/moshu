import type {
	ApprovalRequest,
	ChatRunPart,
	ChatRunSnapshot,
	ChatRunTextPart,
	ChatRunToolPart,
	SessionApprovalPolicy,
	ToolPublicPayload,
} from "@moshu/contracts";
import { AppIcon } from "@moshu/ui";
import { useEffect, useRef, useState } from "react";
import { useApprovals } from "../approvals";
import { useI18n } from "../i18n";
import { ApprovalCard } from "./approval-card";

export interface MessageListProps {
	compact?: boolean;
	isLoading: boolean;
	runs: ChatRunSnapshot[];
	sessionId?: string;
	approvalsDisabled?: boolean;
}

type TimelineGroup =
	| { kind: "text"; part: ChatRunTextPart }
	| { kind: "tools"; id: string; parts: ChatRunToolPart[] };

export function MessageList({
	compact = false,
	isLoading,
	runs,
	sessionId,
	approvalsDisabled = false,
}: MessageListProps) {
	const { t } = useI18n();
	const { approvalsForSession, policyForSession } = useApprovals();
	const scrollAnchorRef = useRef<HTMLDivElement | null>(null);
	const scrollContainerRef = useRef<HTMLDivElement | null>(null);
	const shouldFollowRef = useRef(true);
	const approvals =
		sessionId === undefined
			? new Map<string, ApprovalRequest>()
			: new Map(approvalsForSession(sessionId).map((request) => [request.id, request] as const));
	const approvalPolicy = sessionId === undefined ? undefined : policyForSession(sessionId);

	// biome-ignore lint/correctness/useExhaustiveDependencies: Timeline changes intentionally trigger bottom-follow.
	useEffect(() => {
		if (shouldFollowRef.current) {
			scrollAnchorRef.current?.scrollIntoView({ block: "end" });
		}
	}, [isLoading, runs]);

	const updateFollowState = (): void => {
		const container = scrollContainerRef.current;
		if (container === null) {
			return;
		}
		shouldFollowRef.current =
			container.scrollHeight - container.scrollTop - container.clientHeight <= 24;
	};

	return (
		<section className={compact ? "chat-transcript-shell" : "chat-card chat-card--transcript"}>
			{compact ? null : (
				<div className="chat-card__header chat-card__header--compact">
					<div>
						<span className="chat-card__eyebrow">{t("chat.transcript.eyebrow")}</span>
						<h2>{t("chat.transcript.title")}</h2>
					</div>
					{sessionId ? <p>{t("chat.transcript.sessionLabel", sessionId)}</p> : null}
				</div>
			)}

			<div
				ref={scrollContainerRef}
				className="chat-transcript"
				aria-live="polite"
				onScroll={updateFollowState}
			>
				{isLoading ? (
					<EmptyState
						title={t("chat.transcript.loading")}
						description={t("chat.transcript.loadingDetail")}
					/>
				) : runs.length === 0 ? (
					<EmptyState
						title={t("chat.transcript.emptyTitle")}
						description={t("chat.transcript.emptyDescription")}
					/>
				) : (
					<>
						<ul className="chat-message-list">
							{runs.map((run) => (
								<RunTranscript
									key={run.id}
									run={run}
									approvals={approvals}
									approvalPolicy={approvalPolicy}
									approvalsDisabled={approvalsDisabled}
								/>
							))}
						</ul>
						<div ref={scrollAnchorRef} />
					</>
				)}
			</div>
		</section>
	);
}

function EmptyState({ title, description }: { title: string; description: string }) {
	return (
		<div className="chat-empty">
			<AppIcon name="agents" size={40} />
			<strong>{title}</strong>
			<p>{description}</p>
		</div>
	);
}

function RunTranscript({
	run,
	approvals,
	approvalPolicy,
	approvalsDisabled,
}: {
	run: ChatRunSnapshot;
	approvals: ReadonlyMap<string, ApprovalRequest>;
	approvalPolicy: SessionApprovalPolicy | undefined;
	approvalsDisabled: boolean;
}) {
	const { t } = useI18n();
	const groups = groupTimeline(run.timeline);
	return (
		<>
			<li className="chat-message chat-message--user">
				<header className="chat-message__header">
					<strong>{t("chat.message.user")}</strong>
				</header>
				<p className="chat-message__content">{run.userMessage.content}</p>
			</li>
			{groups.map((group) =>
				group.kind === "text" ? (
					<TextPart key={group.part.id} part={group.part} />
				) : (
					<li key={group.id} className="chat-message chat-message--assistant chat-tool-group">
						<header className="chat-message__header">
							<strong>{t("chat.message.assistant")}</strong>
							<span className="chat-message__status">{group.parts.length} tools</span>
						</header>
						<div className="chat-tool-list">
							{group.parts.map((part) => (
								<ToolCard
									key={part.id}
									part={part}
									approval={
										part.approvalId === undefined ? undefined : approvals.get(part.approvalId)
									}
									approvalPolicy={approvalPolicy}
									approvalDisabled={approvalsDisabled}
								/>
							))}
						</div>
					</li>
				),
			)}
			{groups.length === 0 && !isTerminalRun(run) ? (
				<li className="chat-message chat-message--assistant">
					<header className="chat-message__header">
						<strong>{t("chat.message.assistant")}</strong>
						<span className="chat-message__status chat-message__status--streaming">
							{t("chat.message.streaming")}
						</span>
					</header>
					<p className="chat-message__content">{t("chat.message.waiting")}</p>
				</li>
			) : null}
			{run.lastError !== undefined ? (
				<li className="chat-message chat-message--assistant chat-message--run-error">
					<header className="chat-message__header">
						<strong>{t("chat.message.assistant")}</strong>
						<span className="chat-message__status chat-message__status--error">
							{t("chat.message.error")}
						</span>
					</header>
					<p className="chat-message__detail">{run.lastError.safeMessage}</p>
				</li>
			) : null}
		</>
	);
}

function TextPart({ part }: { part: ChatRunTextPart }) {
	const { t } = useI18n();
	return (
		<li className="chat-message chat-message--assistant">
			<header className="chat-message__header">
				<strong>{t("chat.message.assistant")}</strong>
				{part.status !== "completed" ? (
					<span
						className={`chat-message__status chat-message__status--${
							part.status === "streaming" ? "streaming" : "cancelled"
						}`}
					>
						{part.status === "streaming"
							? t("chat.message.streaming")
							: humanizeStatus(part.status)}
					</span>
				) : null}
			</header>
			<p className="chat-message__content">{part.content || t("chat.message.waiting")}</p>
		</li>
	);
}

function ToolCard({
	part,
	approval,
	approvalPolicy,
	approvalDisabled,
}: {
	part: ChatRunToolPart;
	approval: ApprovalRequest | undefined;
	approvalPolicy: SessionApprovalPolicy | undefined;
	approvalDisabled: boolean;
}) {
	const { t } = useI18n();
	const { ensureApproval, errorMessage: approvalError } = useApprovals();
	const waitingApproval = part.status === "waiting_approval";
	const [expanded, setExpanded] = useState(waitingApproval);

	useEffect(() => {
		if (waitingApproval) {
			setExpanded(true);
		}
	}, [waitingApproval]);

	useEffect(() => {
		if (waitingApproval && part.approvalId !== undefined && approval === undefined) {
			void ensureApproval(part.approvalId);
		}
	}, [approval, ensureApproval, part.approvalId, waitingApproval]);

	return (
		<details
			className={`chat-tool-card chat-tool-card--${part.status}`}
			open={expanded}
			onToggle={(event) => setExpanded(event.currentTarget.open)}
		>
			<summary>
				<span className="chat-tool-card__chevron">
					<AppIcon name="forward" size={13} />
				</span>
				<span className="chat-tool-card__icon">
					<AppIcon name="terminal" size={15} />
				</span>
				<span className="chat-tool-card__identity">
					<strong>{part.tool.name}</strong>
					<span>{part.summary}</span>
				</span>
				<span className="chat-tool-card__status">{humanizeStatus(part.status)}</span>
			</summary>
			<div className="chat-tool-card__body">
				{part.input ? <ToolPayload label="Input" payload={part.input} /> : null}
				{part.progress ? <ToolPayload label="Progress" payload={part.progress} /> : null}
				{part.output ? <ToolPayload label="Output" payload={part.output} /> : null}
				{part.payloadsTruncated ? (
					<p className="chat-tool-card__error">
						Additional details were omitted because this Run reached its payload limit.
					</p>
				) : null}
				{part.error ? <p className="chat-tool-card__error">{part.error.safeMessage}</p> : null}
				{waitingApproval && approval === undefined ? (
					<p
						className={
							approvalError === undefined
								? "chat-tool-card__approval-loading"
								: "chat-tool-card__error"
						}
						role={approvalError === undefined ? "status" : "alert"}
					>
						{approvalError === undefined ? t("approval.status.loading") : t("approval.error.load")}
					</p>
				) : waitingApproval && approval !== undefined ? (
					<ApprovalCard
						request={approval}
						policy={approvalPolicy}
						disabled={approvalDisabled}
						embedded
					/>
				) : null}
				{part.durationMs !== undefined ? (
					<span className="chat-tool-card__duration">{formatDuration(part.durationMs)}</span>
				) : null}
			</div>
		</details>
	);
}

function ToolPayload({ label, payload }: { label: string; payload: ToolPublicPayload }) {
	return (
		<section className="chat-tool-payload">
			<strong>
				{label}
				{payload.truncated ? " (truncated)" : ""}
			</strong>
			<pre>{formatPayload(payload)}</pre>
		</section>
	);
}

function groupTimeline(timeline: readonly ChatRunPart[]): TimelineGroup[] {
	const groups: TimelineGroup[] = [];
	for (const part of [...timeline].sort((left, right) => left.position - right.position)) {
		if (part.kind === "text") {
			groups.push({ kind: "text", part });
			continue;
		}
		const previous = groups.at(-1);
		if (
			previous?.kind === "tools" &&
			previous.parts.at(-1)?.assistantTurnId === part.assistantTurnId
		) {
			previous.parts.push(part);
		} else {
			groups.push({ kind: "tools", id: part.id, parts: [part] });
		}
	}
	return groups;
}

function formatPayload(payload: ToolPublicPayload): string {
	if (typeof payload.value === "string") {
		return payload.value;
	}
	return JSON.stringify(payload.value, null, 2);
}

function humanizeStatus(status: string): string {
	return status.replaceAll("_", " ");
}

function formatDuration(durationMs: number): string {
	return durationMs < 1_000 ? `${durationMs} ms` : `${(durationMs / 1_000).toFixed(1)} s`;
}

function isTerminalRun(run: ChatRunSnapshot): boolean {
	return run.status === "completed" || run.status === "failed" || run.status === "cancelled";
}
