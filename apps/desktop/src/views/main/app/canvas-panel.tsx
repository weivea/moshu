import { AppIcon } from "@moshu/ui";
import type { RefObject } from "react";
import { useI18n } from "./i18n";

export type CanvasTab = "changes" | "terminal";

interface CanvasPanelProps {
	activeTab: CanvasTab;
	isExpanded: boolean;
	panelRef: RefObject<HTMLElement | null>;
	onActiveTabChange(tab: CanvasTab): void;
	onExpandedChange(expanded: boolean): void;
}

const canvasTabs = [
	{ id: "changes", icon: "changes", label: "canvas.changes" },
	{ id: "terminal", icon: "terminal", label: "canvas.terminal" },
] as const;

export function CanvasPanel({
	activeTab,
	isExpanded,
	panelRef,
	onActiveTabChange,
	onExpandedChange,
}: CanvasPanelProps) {
	const { t } = useI18n();

	return (
		<aside className="canvas-panel" aria-label={t("canvas.title")} ref={panelRef}>
			<section className="canvas-panel__frame">
				<header className="canvas-tabs">
					<div role="tablist" aria-label={t("canvas.tabs")}>
						{canvasTabs.map((tab) => (
							<button
								key={tab.id}
								type="button"
								role="tab"
								aria-selected={activeTab === tab.id}
								className={activeTab === tab.id ? "canvas-tab is-active" : "canvas-tab"}
								onClick={() => onActiveTabChange(tab.id)}
							>
								<AppIcon name={tab.icon} size={16} />
								<span>{t(tab.label)}</span>
							</button>
						))}
						<button
							type="button"
							className="canvas-tab canvas-tab--icon"
							aria-label={t("canvas.addTab")}
							title={t("canvas.addTab")}
							disabled
						>
							<AppIcon name="plus" size={17} />
						</button>
					</div>
					<button
						type="button"
						className="canvas-tab canvas-tab--icon"
						aria-label={isExpanded ? t("canvas.restore") : t("canvas.expand")}
						title={isExpanded ? t("canvas.restore") : t("canvas.expand")}
						onClick={() => onExpandedChange(!isExpanded)}
					>
						<AppIcon name={isExpanded ? "collapse" : "expand"} size={17} />
					</button>
				</header>

				<div
					className="canvas-panel__content"
					role="tabpanel"
					aria-label={t(activeTab === "changes" ? "canvas.changes" : "canvas.terminal")}
				/>
			</section>
		</aside>
	);
}
