import { Button } from "@heroui/react";
import {
	type ApprovalOperation,
	type ApprovalRequest,
	approvalRpcErrorCodes,
	type SessionApprovalPolicy,
} from "@moshu/contracts";
import { useCallback, useMemo, useState } from "react";
import { useApprovals } from "../approvals";
import { type MessageKey, useI18n } from "../i18n";

const operationLabelKeys: Record<ApprovalOperation, MessageKey> = {
	read: "approval.operation.read",
	search: "approval.operation.search",
	list: "approval.operation.list",
	edit: "approval.operation.edit",
	write: "approval.operation.write",
	bash: "approval.operation.bash",
	mcp: "approval.operation.mcp",
	other: "approval.operation.other",
};

const riskLabelKeys: Record<ApprovalRequest["risk"]["tier"], MessageKey> = {
	low: "approval.risk.low",
	medium: "approval.risk.medium",
	high: "approval.risk.high",
	critical: "approval.risk.critical",
};

function formatTimestamp(iso: string): string {
	const parsed = new Date(iso);
	if (Number.isNaN(parsed.getTime())) {
		return iso;
	}
	return parsed.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
}

type Feedback = "conflict" | "offline" | "generic" | "decidedElsewhere";

function classifyError(error: unknown): Feedback {
	if (typeof navigator !== "undefined" && navigator.onLine === false) {
		return "offline";
	}
	const message = error instanceof Error ? error.message : "";
	if (
		message.includes(approvalRpcErrorCodes.revisionConflict) ||
		message.includes(approvalRpcErrorCodes.alreadyDecided) ||
		message.includes(approvalRpcErrorCodes.notFound)
	) {
		return "conflict";
	}
	return "generic";
}

interface ApprovalCardProps {
	request: ApprovalRequest;
	policy: SessionApprovalPolicy | undefined;
	disabled?: boolean;
}

export function ApprovalCard({ request, policy, disabled = false }: ApprovalCardProps) {
	const { t } = useI18n();
	const { decide, setAllowAll } = useApprovals();
	const [submitting, setSubmitting] = useState<"approve" | "reject" | "allowAll" | undefined>();
	const [feedback, setFeedback] = useState<Feedback>();

	const isBusy = submitting !== undefined;
	const isInteractive = !disabled && request.state === "pending";

	const submitDecision = useCallback(
		async (decision: "approve_once" | "reject") => {
			setFeedback(undefined);
			setSubmitting(decision === "approve_once" ? "approve" : "reject");
			try {
				const output = await decide(request, decision);
				if (output.outcome === "superseded") {
					setFeedback("decidedElsewhere");
				}
			} catch (error) {
				setFeedback(classifyError(error));
			} finally {
				setSubmitting(undefined);
			}
		},
		[decide, request],
	);

	const toggleAllowAll = useCallback(async () => {
		setFeedback(undefined);
		setSubmitting("allowAll");
		try {
			await setAllowAll(request.sessionId, !(policy?.allowAll ?? false));
		} catch {
			setFeedback("generic");
		} finally {
			setSubmitting(undefined);
		}
	}, [policy?.allowAll, request.sessionId, setAllowAll]);

	const feedbackMessage = useMemo(() => {
		switch (feedback) {
			case "conflict":
				return t("approval.error.conflict");
			case "offline":
				return t("approval.error.offline");
			case "decidedElsewhere":
				return t("approval.status.decidedElsewhere");
			case "generic":
				return t("approval.error.generic");
			default:
				return undefined;
		}
	}, [feedback, t]);

	const allowAllEnabled = policy?.allowAll ?? false;
	const isCritical = !request.risk.overridable;

	return (
		<article
			className="chat-card approval-card"
			data-risk={request.risk.tier}
			data-state={request.state}
			aria-label={t("approval.card.title")}
		>
			<header className="approval-card__header">
				<div>
					<span className="chat-card__eyebrow">{t("approval.card.title")}</span>
					<h2>{request.action.tool}</h2>
					<p>{t("approval.card.subtitle")}</p>
				</div>
				<div className="approval-card__badges">
					<span className="approval-card__risk" data-risk={request.risk.tier}>
						{t(riskLabelKeys[request.risk.tier])}
					</span>
					{isCritical ? (
						<span className="approval-card__risk approval-card__risk--locked">
							{t("approval.badge.nonOverridable")}
						</span>
					) : null}
				</div>
			</header>

			<dl className="approval-card__meta">
				<div>
					<dt>{t("approval.card.operation")}</dt>
					<dd>{t(operationLabelKeys[request.action.operation])}</dd>
				</div>
				<div>
					<dt>{t("approval.card.target")}</dt>
					<dd>{request.action.target.id}</dd>
				</div>
				{request.action.command !== undefined ? (
					<div className="approval-card__meta-wide">
						<dt>{t("approval.card.command")}</dt>
						<dd>
							<code className="approval-card__code">{request.action.command}</code>
						</dd>
					</div>
				) : null}
				{request.action.path !== undefined ? (
					<div className="approval-card__meta-wide">
						<dt>{t("approval.card.path")}</dt>
						<dd>
							<code className="approval-card__code">{request.action.path}</code>
						</dd>
					</div>
				) : null}
			</dl>

			{request.risk.reasons.length > 0 ? (
				<div className="approval-card__reasons">
					<span className="chat-card__eyebrow">{t("approval.card.reasons")}</span>
					<ul>
						{request.risk.reasons.map((reason) => (
							<li key={reason}>{reason}</li>
						))}
					</ul>
				</div>
			) : null}

			<p className="approval-card__timing">
				<span>{t("approval.card.requested", formatTimestamp(request.createdAt))}</span>
				<span aria-hidden="true">·</span>
				<span>{t("approval.card.expires", formatTimestamp(request.expiresAt))}</span>
			</p>

			{allowAllEnabled ? (
				<div className="chat-notice chat-notice--info" role="status">
					<span>
						{t("approval.allowAll.on")} {t("approval.allowAll.note")}
					</span>
				</div>
			) : null}

			{feedbackMessage !== undefined ? (
				<div
					className={`chat-notice ${feedback === "decidedElsewhere" ? "chat-notice--info" : "chat-notice--danger"}`}
					role={feedback === "decidedElsewhere" ? "status" : "alert"}
				>
					<span>{feedbackMessage}</span>
				</div>
			) : null}

			<footer className="approval-card__actions">
				<Button
					className="chat-button chat-button--primary"
					isDisabled={!isInteractive || isBusy}
					isLoading={submitting === "approve"}
					onPress={() => void submitDecision("approve_once")}
				>
					{t("approval.action.approve")}
				</Button>
				<Button
					className="chat-button chat-button--danger"
					isDisabled={!isInteractive || isBusy}
					isLoading={submitting === "reject"}
					onPress={() => void submitDecision("reject")}
				>
					{t("approval.action.reject")}
				</Button>
				{isCritical ? null : (
					<Button
						className="chat-button chat-button--inline"
						isDisabled={disabled || isBusy}
						isLoading={submitting === "allowAll"}
						onPress={() => void toggleAllowAll()}
					>
						{allowAllEnabled ? t("approval.action.allowAllOff") : t("approval.action.allowAll")}
					</Button>
				)}
			</footer>
		</article>
	);
}

interface SessionApprovalCardsProps {
	sessionId: string | undefined;
	disabled?: boolean;
}

export function SessionApprovalCards({ sessionId, disabled = false }: SessionApprovalCardsProps) {
	const { approvalsForSession, policyForSession } = useApprovals();
	if (sessionId === undefined) {
		return null;
	}
	const requests = approvalsForSession(sessionId);
	if (requests.length === 0) {
		return null;
	}
	const policy = policyForSession(sessionId);
	return (
		<div className="approval-card-list">
			{requests.map((request) => (
				<ApprovalCard key={request.id} request={request} policy={policy} disabled={disabled} />
			))}
		</div>
	);
}
