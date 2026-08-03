import type { ApprovalRequest, SessionApprovalPolicy } from "@moshu/contracts";
import { Button } from "@heroui/react";
import { useState } from "react";
import { useConnectedSession } from "../app/connection";
import { useI18n } from "../app/i18n";
import { useWorkspace } from "../app/workspace";
import { newUuid } from "../lib/uuid";

type Banner = "superseded" | "conflict" | null;

/**
 * Renders a single approval and its decision controls. Security-critical: a `bash` action NEVER
 * shows its raw command — only the fixed, redacted `shell [arguments hidden]` label. The raw
 * `action.command` / `action.path` fields are deliberately never read here.
 */
export function ApprovalCard({
	request,
	policy,
	onNavigate,
}: {
	request: ApprovalRequest;
	policy?: SessionApprovalPolicy;
	onNavigate?: (sessionId: string) => void;
}) {
	const { t } = useI18n();
	const { client } = useConnectedSession();
	const { refreshApprovals } = useWorkspace();
	const [busy, setBusy] = useState(false);
	const [banner, setBanner] = useState<Banner>(null);
	const [finalState, setFinalState] = useState(request.state);

	const isShell = request.action.operation === "bash";
	const primaryLabel = isShell ? t("approval.shell") : request.action.tool;
	const allowAllOn = policy?.allowAll ?? false;
	const decided = finalState !== "pending";

	async function decide(decision: "approve_once" | "reject"): Promise<void> {
		setBusy(true);
		setBanner(null);
		try {
			const result = await client.decideApproval({
				approvalId: request.id,
				expectedRevision: request.revision,
				decision,
				idempotencyKey: newUuid(),
			});
			setFinalState(result.request.state);
			if (result.outcome === "superseded") {
				setBanner("superseded");
			}
		} catch {
			// A revision conflict (another device decided first) is not retriable with our stale
			// revision — surface the authoritative state via a refresh instead of blind retry.
			setBanner("conflict");
		} finally {
			setBusy(false);
			await refreshApprovals();
		}
	}

	async function allowAll(): Promise<void> {
		setBusy(true);
		setBanner(null);
		try {
			const output = await client.updateSessionApprovalPolicy({
				sessionId: request.sessionId,
				allowAll: true,
				expectedRevision: policy?.revision ?? 0,
				idempotencyKey: newUuid(),
				approveRequest: {
					approvalId: request.id,
					expectedRevision: request.revision,
				},
			});
			if (output.request !== undefined) {
				setFinalState(output.request.state);
			}
		} catch {
			setBanner("conflict");
		} finally {
			setBusy(false);
			await refreshApprovals();
		}
	}

	return (
		<div className="card space-y-3 p-4">
			<div className="flex items-start justify-between gap-2">
				<div className="min-w-0">
					<p className="text-xs font-medium uppercase tracking-wide text-[var(--text-faint)]">
						{t("approval.title")}
					</p>
					<p className="mt-1 font-mono text-sm text-[var(--text)]">{primaryLabel}</p>
				</div>
				<span className={`pill ${riskClass(request.risk.tier)}`}>{request.risk.tier}</span>
			</div>

			{!isShell ? (
				<p className="text-xs text-[var(--text-muted)]">
					{t("approval.operation")}: {request.action.operation}
				</p>
			) : null}

			{banner === "superseded" ? (
				<p role="status" className="text-xs text-[var(--warning)]">
					{t("approval.superseded")}
				</p>
			) : null}
			{banner === "conflict" ? (
				<p role="status" className="text-xs text-[var(--warning)]">
					{t("approval.conflict")}
				</p>
			) : null}

			{decided ? (
				<p className="text-sm text-[var(--text-muted)]">
					{finalState === "approved" ? "✓" : "✕"} {finalState}
				</p>
			) : (
				<div className="flex flex-wrap gap-2">
					<Button
						variant="primary"
						size="sm"
						isDisabled={busy}
						onPress={() => void decide("approve_once")}
					>
						{t("approval.approve")}
					</Button>
					<Button
						variant="danger-soft"
						size="sm"
						isDisabled={busy}
						onPress={() => void decide("reject")}
					>
						{t("approval.reject")}
					</Button>
					{allowAllOn ? (
						<span className="pill bg-[var(--accent-soft)] text-[var(--accent)]">
							{t("approval.allowAllOn")}
						</span>
					) : (
						<Button variant="ghost" size="sm" isDisabled={busy} onPress={() => void allowAll()}>
							{t("approval.allowAll")}
						</Button>
					)}
				</div>
			)}

			{onNavigate ? (
				<Button variant="ghost" size="sm" onPress={() => onNavigate(request.sessionId)}>
					{t("activity.openSession")}
				</Button>
			) : null}
		</div>
	);
}

function riskClass(tier: ApprovalRequest["risk"]["tier"]): string {
	switch (tier) {
		case "critical":
		case "high":
			return "bg-[var(--danger-soft)] text-[var(--danger)]";
		case "medium":
			return "bg-[var(--accent-soft)] text-[var(--accent)]";
		default:
			return "bg-[var(--surface-muted)] text-[var(--text-muted)]";
	}
}
