import type { RuntimeInfo } from "@moshu/contracts";
import { AppIcon } from "@moshu/ui";
import { Button } from "@heroui/react";
import { useCallback, useEffect, useState } from "react";
import { desktopClient } from "../lib/rpc";
import { useI18n } from "./i18n";

type RuntimeState =
	| { status: "checking" }
	| { status: "ready"; info: RuntimeInfo }
	| { status: "failed"; message: string };

export function RuntimeStatus() {
	const { t } = useI18n();
	const [state, setState] = useState<RuntimeState>({ status: "checking" });

	const refresh = useCallback(async () => {
		setState({ status: "checking" });
		try {
			setState({ status: "ready", info: await desktopClient.getRuntimeInfo() });
		} catch (error) {
			setState({
				status: "failed",
				message: error instanceof Error ? error.message : t("runtime.failed"),
			});
		}
	}, [t]);

	useEffect(() => {
		void refresh();
	}, [refresh]);

	return (
		<section className="runtime-card" aria-live="polite">
			<div className="runtime-card__header">
				<div>
					<span className="runtime-card__kicker">{t("runtime.title")}</span>
					<strong>
						{state.status === "checking"
							? t("runtime.checking")
							: state.status === "ready"
								? t("runtime.ready")
								: t("runtime.failed")}
					</strong>
				</div>
				<AppIcon name={state.status === "ready" ? "check" : "notifications"} size={20} />
			</div>

			{state.status === "ready" ? (
				<dl>
					<RuntimeRow label={t("runtime.electrobun")} value={state.info.electrobunVersion} />
					<RuntimeRow label={t("runtime.bun")} value={state.info.bunVersion} />
					<RuntimeRow label={t("runtime.deepAgents")} value={state.info.deepAgents.version} />
					<RuntimeRow label={t("runtime.channel")} value={state.info.channel} />
				</dl>
			) : null}

			{state.status === "failed" ? (
				<>
					<p className="runtime-card__error">{state.message}</p>
					<Button onPress={refresh}>{t("runtime.retry")}</Button>
				</>
			) : null}
		</section>
	);
}

function RuntimeRow({ label, value }: { label: string; value: string }) {
	return (
		<div>
			<dt>{label}</dt>
			<dd>{value}</dd>
		</div>
	);
}
