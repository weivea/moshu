import type { AvailableModel, ReasoningCapability, ReasoningSelection } from "@moshu/contracts";
import { useId } from "react";

import { useI18n } from "../i18n";

export interface ModelSelectorProps {
	models: readonly AvailableModel[];
	providerId?: string;
	modelId?: string;
	reasoning?: ReasoningSelection;
	isDisabled?: boolean;
	onSelect(providerId: string, modelId: string): void;
	onReasoningChange(reasoning: ReasoningSelection | undefined): void;
}

/**
 * Provider-grouped model picker plus the reasoning control the selected model advertises.
 * Metadata the catalog did not return is simply not rendered.
 */
export function ModelSelector({
	models,
	providerId,
	modelId,
	reasoning,
	isDisabled = false,
	onSelect,
	onReasoningChange,
}: ModelSelectorProps) {
	const { t } = useI18n();
	const selectId = useId();
	const selected = models.find(
		(entry) => entry.providerId === providerId && entry.model.id === modelId,
	);
	const groups = groupByProvider(models);

	return (
		<div className="model-selector">
			<label className="model-selector__field" htmlFor={selectId}>
				<span className="chat-live-region">{t("model.picker.label")}</span>
				<select
					id={selectId}
					value={selected === undefined ? "" : toOptionValue(selected)}
					disabled={isDisabled || models.length === 0}
					onChange={(event) => {
						const [nextProviderId, nextModelId] = splitOptionValue(event.currentTarget.value);
						if (nextProviderId !== undefined && nextModelId !== undefined) {
							onSelect(nextProviderId, nextModelId);
						}
					}}
				>
					<option value="" disabled>
						{models.length === 0 ? t("model.picker.empty") : t("model.picker.placeholder")}
					</option>
					{groups.map((group) => (
						<optgroup key={group.providerId} label={group.providerDisplayName}>
							{group.models.map((entry) => (
								<option key={toOptionValue(entry)} value={toOptionValue(entry)}>
									{entry.model.displayName ?? entry.model.id}
								</option>
							))}
						</optgroup>
					))}
				</select>
			</label>

			{selected?.model.contextWindowTokens === undefined ? null : (
				<span className="model-selector__context">
					{t("model.picker.contextWindow", formatTokens(selected.model.contextWindowTokens))}
				</span>
			)}

			{selected === undefined ? null : (
				<ReasoningControl
					capability={selected.reasoning}
					{...(reasoning === undefined ? {} : { reasoning })}
					isDisabled={isDisabled}
					onChange={onReasoningChange}
				/>
			)}
		</div>
	);
}

export interface ReasoningControlProps {
	capability: ReasoningCapability;
	reasoning?: ReasoningSelection;
	isDisabled?: boolean;
	onChange(reasoning: ReasoningSelection | undefined): void;
}

export function ReasoningControl({
	capability,
	reasoning,
	isDisabled = false,
	onChange,
}: ReasoningControlProps) {
	const { t } = useI18n();
	const effortId = useId();
	const budgetId = useId();

	if (capability.kind === "none") {
		return null;
	}

	const showsEffort = capability.kind === "effort" || capability.kind === "both";
	const showsBudget = capability.kind === "budget" || capability.kind === "both";

	return (
		<div className="model-selector__reasoning">
			{showsEffort && (capability.kind === "effort" || capability.kind === "both") ? (
				<label className="model-selector__field" htmlFor={effortId}>
					<span className="chat-live-region">{t("model.reasoning.effortLabel")}</span>
					<select
						id={effortId}
						value={reasoning?.effort ?? ""}
						disabled={isDisabled}
						onChange={(event) => {
							const effort = event.currentTarget.value;
							onChange(
								effort.length === 0 ? stripEffort(reasoning) : { ...(reasoning ?? {}), effort },
							);
						}}
					>
						<option value="">{t("model.reasoning.effortDefault")}</option>
						{capability.levels.map((level) => (
							<option key={level} value={level}>
								{level}
							</option>
						))}
					</select>
				</label>
			) : null}

			{showsBudget && (capability.kind === "budget" || capability.kind === "both") ? (
				<label className="model-selector__field" htmlFor={budgetId}>
					<span className="chat-live-region">{t("model.reasoning.budgetLabel")}</span>
					<select
						id={budgetId}
						value={reasoning?.budgetTokens === undefined ? "" : String(reasoning.budgetTokens)}
						disabled={isDisabled}
						onChange={(event) => {
							const raw = event.currentTarget.value;
							onChange(
								raw.length === 0
									? stripBudget(reasoning)
									: { ...(reasoning ?? {}), budgetTokens: Number(raw) },
							);
						}}
					>
						<option value="">{t("model.reasoning.effortDefault")}</option>
						<option value="0">{t("model.reasoning.budgetOff")}</option>
						{budgetOptions(capability.minBudgetTokens, capability.maxBudgetTokens).map((tokens) => (
							<option key={tokens} value={String(tokens)}>
								{t("model.reasoning.budgetTokens", formatTokens(tokens))}
							</option>
						))}
					</select>
					<small className="chat-field__hint">
						{capability.maxBudgetTokens === undefined
							? t("model.reasoning.budgetTokens", `≥ ${formatTokens(capability.minBudgetTokens)}`)
							: t(
									"model.reasoning.budgetRange",
									formatTokens(capability.minBudgetTokens),
									formatTokens(capability.maxBudgetTokens),
								)}
					</small>
				</label>
			) : null}
		</div>
	);
}

function stripEffort(reasoning: ReasoningSelection | undefined): ReasoningSelection | undefined {
	if (reasoning?.budgetTokens === undefined) {
		return undefined;
	}
	return { budgetTokens: reasoning.budgetTokens };
}

function stripBudget(reasoning: ReasoningSelection | undefined): ReasoningSelection | undefined {
	if (reasoning?.effort === undefined) {
		return undefined;
	}
	return { effort: reasoning.effort };
}

function budgetOptions(minBudgetTokens: number, maxBudgetTokens: number | undefined): number[] {
	const ceiling = maxBudgetTokens ?? minBudgetTokens * 32;
	const options: number[] = [];
	for (let tokens = Math.max(minBudgetTokens, 1); tokens <= ceiling; tokens *= 2) {
		options.push(tokens);
	}
	if (options.at(-1) !== ceiling && ceiling >= minBudgetTokens) {
		options.push(ceiling);
	}
	return options;
}

function groupByProvider(models: readonly AvailableModel[]) {
	const groups = new Map<
		string,
		{ providerId: string; providerDisplayName: string; models: AvailableModel[] }
	>();
	for (const entry of models) {
		const group = groups.get(entry.providerId) ?? {
			providerId: entry.providerId,
			providerDisplayName: entry.providerDisplayName,
			models: [],
		};
		group.models.push(entry);
		groups.set(entry.providerId, group);
	}
	return [...groups.values()];
}

function toOptionValue(entry: AvailableModel): string {
	return `${entry.providerId}\u0000${entry.model.id}`;
}

function splitOptionValue(value: string): [string | undefined, string | undefined] {
	const [providerId, modelId] = value.split("\u0000");
	return [providerId, modelId];
}

export function formatTokens(tokens: number): string {
	if (tokens >= 1_000_000) {
		return `${(tokens / 1_000_000).toFixed(1).replace(/\.0$/, "")}M`;
	}
	if (tokens >= 1_000) {
		return `${(tokens / 1_000).toFixed(1).replace(/\.0$/, "")}K`;
	}
	return String(tokens);
}
