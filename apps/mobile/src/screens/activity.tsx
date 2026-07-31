import { useNavigate } from "react-router-dom";
import { useI18n } from "../app/i18n";
import { useWorkspace } from "../app/workspace";
import { ApprovalCard } from "../components/approval-card";
import { EmptyRow, Screen, ScreenHeader, ScrollArea } from "../components/layout";

export function ActivityScreen() {
	const { t } = useI18n();
	const navigate = useNavigate();
	const { pendingApprovals, policies } = useWorkspace();

	return (
		<Screen>
			<ScreenHeader title={t("activity.title")} />
			<ScrollArea>
				{pendingApprovals.length === 0 ? (
					<EmptyRow label={t("activity.empty")} />
				) : (
					<>
						<p className="section-label">{t("activity.pending")}</p>
						<div className="space-y-3 px-4 py-2">
							{pendingApprovals.map((request) => (
								<ApprovalCard
									key={request.id}
									request={request}
									policy={policies.find((item) => item.sessionId === request.sessionId)}
									onNavigate={(sessionId) => navigate(`/chats/${sessionId}`)}
								/>
							))}
						</div>
					</>
				)}
			</ScrollArea>
		</Screen>
	);
}
