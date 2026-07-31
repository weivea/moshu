import { Button } from "@heroui/react";
import type { ApprovalOperation, ApprovalRequest } from "@moshu/contracts";
import { useNavigate } from "react-router-dom";
import { useApprovals } from "./approvals";
import { EmptyState } from "./empty-state";
import { type MessageKey, useI18n } from "./i18n";

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
	return parsed.toLocaleString([], {
		month: "short",
		day: "numeric",
		hour: "2-digit",
		minute: "2-digit",
	});
}

export function ActivityPage() {
	const { t } = useI18n();
	const navigate = useNavigate();
	const { pending, isLoading, errorMessage } = useApprovals();

	if (errorMessage !== undefined && pending.length === 0) {
		return (
			<EmptyState
				icon="notifications"
				title={t("page.activity.title")}
				description={errorMessage}
			/>
		);
	}

	if (pending.length === 0) {
		return (
			<EmptyState
				icon="notifications"
				title={t("page.activity.title")}
				description={isLoading ? t("activity.loading") : t("activity.empty")}
			/>
		);
	}

	return (
		<section className="activity-page" aria-label={t("page.activity.title")}>
			<header className="activity-page__header">
				<span className="chat-card__eyebrow">{t("activity.eyebrow")}</span>
				<h1>{t("page.activity.title")}</h1>
				<p>{t("activity.description")}</p>
				<span className="activity-page__count">{t("activity.count", String(pending.length))}</span>
			</header>
			<ul className="activity-page__list">
				{pending.map((request) => (
					<li key={request.id} className="activity-row" data-risk={request.risk.tier}>
						<div className="activity-row__main">
							<span className="activity-row__tool">{request.action.tool}</span>
							<span className="activity-row__meta">
								{t(operationLabelKeys[request.action.operation])} · {request.action.target.id}
							</span>
							{request.action.command !== undefined ? (
								<code className="approval-card__code">{request.action.command}</code>
							) : null}
							{request.action.path !== undefined ? (
								<code className="approval-card__code">{request.action.path}</code>
							) : null}
						</div>
						<div className="activity-row__aside">
							<span className="approval-card__risk" data-risk={request.risk.tier}>
								{t(riskLabelKeys[request.risk.tier])}
							</span>
							<span className="activity-row__time">{formatTimestamp(request.createdAt)}</span>
							<Button
								className="chat-button chat-button--inline"
								onPress={() => navigate(`/chat/${request.sessionId}`)}
							>
								{t("activity.openSession")}
							</Button>
						</div>
					</li>
				))}
			</ul>
		</section>
	);
}
