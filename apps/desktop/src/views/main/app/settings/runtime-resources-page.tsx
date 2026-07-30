import {
	Button,
	Card,
	Chip,
	Description,
	Form,
	Input,
	Label,
	ListBox,
	NumberField,
	Select,
	Tabs,
	TextArea,
	TextField,
} from "@heroui/react";
import { mcpSecretInputSchema, mcpTransportConfigSchema } from "@moshu/contracts";
import type {
	AgentGlobalProfile,
	McpOwner,
	McpServerSummary,
	RuntimeBoxResourceRef,
	RuntimeBoxSkill,
	RuntimeProfile,
} from "@moshu/contracts";
import { useCallback, useEffect, useRef, useState } from "react";

import { desktopClient } from "../../lib/rpc";
import { useI18n } from "../i18n";
import { useRuntimeBoxes } from "../runtime-boxes";
import { getImportedMcpServerKey, McpConfigJsonError, parseMcpConfigJson } from "./mcp-config-json";

interface McpView {
	stableResourceId: string;
	configRevision: number;
	version: string;
	contentHash: string;
	displayName: string;
	health: "ready" | "stopped" | "error";
	credentialConfigured: boolean;
	toolCount: number;
	server?: McpServerSummary;
}

interface SkillView {
	stableResourceId: string;
	version: string;
	contentHash: string;
	health: "ready" | "stopped" | "error";
	skill?: RuntimeBoxSkill;
}

export function McpServersSettingsPage() {
	const { t } = useI18n();
	const runtimeBoxes = useRuntimeBoxes();
	const runtimeBoxId = runtimeBoxes.snapshot.active.runtimeBoxId;
	const [scope, setScope] = useState<"agent-server" | "runtime-box">("agent-server");
	const [items, setItems] = useState<McpView[]>([]);
	const [profile, setProfile] = useState<RuntimeProfile>();
	const [globalProfile, setGlobalProfile] = useState<AgentGlobalProfile>();
	const [stale, setStale] = useState(false);
	const [error, setError] = useState<string>();
	const [pending, setPending] = useState(false);
	const [displayName, setDisplayName] = useState("");
	const [transportType, setTransportType] = useState<"stdio" | "streamable-http" | "sse">("stdio");
	const [endpoint, setEndpoint] = useState("");
	const [argumentsText, setArgumentsText] = useState("");
	const [cwd, setCwd] = useState("");
	const [timeoutMs, setTimeoutMs] = useState(30_000);
	const [secretName, setSecretName] = useState("MCP_TOKEN");
	const [secretValue, setSecretValue] = useState("");
	const [entryMode, setEntryMode] = useState<"form" | "json">("form");
	const [jsonText, setJsonText] = useState("");
	const [jsonError, setJsonError] = useState<string>();
	const [jsonFeedback, setJsonFeedback] = useState<string>();
	const loadGeneration = useRef(0);
	const createCommandId = useRef<string | undefined>(undefined);
	const activeRuntimeBoxId = useRef(runtimeBoxId);
	const activeScope = useRef(scope);
	const secretOwnerKey = useRef("");
	const mutationGeneration = useRef(0);
	const manualDraftRevision = useRef(0);
	const jsonDraftRevision = useRef(0);
	const jsonImportAttempt = useRef<
		| {
				ownerKey: string;
				items: Map<
					string,
					{
						commandId: string;
						stableResourceId: string;
						completed: boolean;
					}
				>;
		  }
		| undefined
	>(undefined);
	activeRuntimeBoxId.current = runtimeBoxId;
	activeScope.current = scope;
	const owner: McpOwner =
		scope === "agent-server" ? { kind: "agent-server" } : { kind: "runtime-box", runtimeBoxId };
	const ownerReady = scope === "agent-server" || runtimeBoxes.isActiveReady;
	const ownerKey =
		owner.kind === "agent-server" ? owner.kind : `${owner.kind}:${owner.runtimeBoxId}`;
	const manualTransport = mcpTransportConfigSchema.safeParse(
		transportType === "stdio"
			? {
					type: "stdio",
					command: endpoint.trim(),
					args: argumentsText
						.split("\n")
						.map((value) => value.trim())
						.filter((value) => value.length > 0),
					...(cwd.trim().length === 0 ? {} : { cwd: cwd.trim() }),
					startupTimeoutMs: timeoutMs,
				}
			: {
					type: transportType,
					url: endpoint.trim(),
					timeoutMs,
				},
	);
	const ownerSecretValue = secretOwnerKey.current === ownerKey ? secretValue : "";
	const manualSecret =
		ownerSecretValue.length === 0
			? { success: true as const, data: undefined }
			: mcpSecretInputSchema.safeParse(
					transportType === "stdio"
						? { environment: { [secretName.trim()]: ownerSecretValue } }
						: { headers: { [secretName.trim()]: ownerSecretValue } },
				);
	const manualFormValid =
		displayName.trim().length > 0 && manualTransport.success && manualSecret.success;
	const markManualDraftChanged = () => {
		manualDraftRevision.current += 1;
		createCommandId.current = undefined;
	};

	const load = useCallback(async () => {
		if (scope === "runtime-box" && activeRuntimeBoxId.current !== runtimeBoxId) {
			return;
		}
		const generation = ++loadGeneration.current;
		setError(undefined);
		try {
			if (scope === "agent-server") {
				const [live, globalOutput] = await Promise.all([
					desktopClient.listOwnedMcpServers({ owner: { kind: "agent-server" } }),
					desktopClient.getAgentGlobalProfile(),
				]);
				if (generation !== loadGeneration.current) {
					return;
				}
				setStale(false);
				setProfile(undefined);
				setGlobalProfile(globalOutput.profile);
				setItems(appendMissingAgentServerMcpRefs(live.items.map(toMcpView), globalOutput.profile));
				return;
			}
			const [inventory, profileOutput] = await Promise.all([
				desktopClient.listRuntimeInventory(runtimeBoxId),
				desktopClient.getRuntimeProfile(runtimeBoxId),
			]);
			if (
				generation !== loadGeneration.current ||
				(scope === "runtime-box" && activeRuntimeBoxId.current !== runtimeBoxId)
			) {
				return;
			}
			setStale(inventory.stale);
			setProfile(profileOutput.profile);
			setGlobalProfile(undefined);
			if (runtimeBoxes.isActiveReady) {
				const live = await desktopClient.listOwnedMcpServers({
					owner: { kind: "runtime-box", runtimeBoxId },
				});
				if (generation !== loadGeneration.current || activeRuntimeBoxId.current !== runtimeBoxId) {
					return;
				}
				setItems(appendMissingMcpRefs(live.items.map(toMcpView), profileOutput.profile));
			} else {
				setItems(
					appendMissingMcpRefs(
						inventory.resources
							.filter((resource) => resource.resourceKind === "mcp")
							.map((resource) => ({
								stableResourceId: resource.stableResourceId,
								configRevision: 1,
								version: resource.version,
								contentHash: resource.contentHash,
								displayName: resource.stableResourceId,
								health: resource.health,
								credentialConfigured: resource.credentialConfigured,
								toolCount: resource.mcpTools.length,
							})),
						profileOutput.profile,
					),
				);
			}
		} catch (loadError) {
			if (
				generation !== loadGeneration.current ||
				(scope === "runtime-box" && activeRuntimeBoxId.current !== runtimeBoxId)
			) {
				return;
			}
			setError(loadError instanceof Error ? loadError.message : t("runtimeResources.loadFailed"));
		}
	}, [runtimeBoxId, runtimeBoxes.isActiveReady, scope, t]);

	useEffect(() => {
		setItems([]);
		setProfile(undefined);
		setGlobalProfile(undefined);
		setPending(false);
		mutationGeneration.current += 1;
		createCommandId.current = undefined;
		setDisplayName("");
		setEndpoint("");
		setArgumentsText("");
		setCwd("");
		setTimeoutMs(30_000);
		setSecretValue("");
		setJsonText("");
		setJsonError(undefined);
		setJsonFeedback(undefined);
		secretOwnerKey.current = ownerKey;
		jsonImportAttempt.current = undefined;
		manualDraftRevision.current += 1;
		jsonDraftRevision.current += 1;
	}, [ownerKey]);

	useEffect(() => {
		void load();
		const timer = setInterval(() => void load(), 2_000);
		return () => {
			clearInterval(timer);
			loadGeneration.current += 1;
		};
	}, [load]);

	const mutate = async (operation: () => Promise<unknown>) => {
		const generation = ++mutationGeneration.current;
		setPending(true);
		setError(undefined);
		try {
			await operation();
			const stillSelected =
				mutationGeneration.current === generation &&
				activeScope.current === scope &&
				(scope === "agent-server" || activeRuntimeBoxId.current === runtimeBoxId);
			if (stillSelected) {
				await load();
			}
			return (
				stillSelected &&
				mutationGeneration.current === generation &&
				activeScope.current === scope &&
				(scope === "agent-server" || activeRuntimeBoxId.current === runtimeBoxId)
			);
		} catch (mutationError) {
			if (
				activeScope.current === scope &&
				(scope === "agent-server" || activeRuntimeBoxId.current === runtimeBoxId) &&
				mutationGeneration.current === generation
			) {
				setError(
					mutationError instanceof Error
						? mutationError.message
						: t("runtimeResources.mutationFailed"),
				);
			}
			return false;
		} finally {
			if (mutationGeneration.current === generation) {
				setPending(false);
			}
		}
	};

	const addServer = async () => {
		if (!manualFormValid || !manualTransport.success || !manualSecret.success) {
			setError(t("runtimeResources.invalidForm"));
			return;
		}
		const commandId = createCommandId.current ?? crypto.randomUUID();
		createCommandId.current = commandId;
		const submittedDraftRevision = manualDraftRevision.current;
		const succeeded = await mutate(async () => {
			await desktopClient.upsertOwnedMcpServer({
				owner,
				commandId,
				stableResourceId: `mcp-${commandId}`,
				displayName: displayName.trim(),
				enabled: true,
				transport: manualTransport.data,
				...(manualSecret.data === undefined ? {} : { secret: manualSecret.data }),
			});
		});
		if (succeeded && manualDraftRevision.current === submittedDraftRevision) {
			createCommandId.current = undefined;
			manualDraftRevision.current += 1;
			setDisplayName("");
			setEndpoint("");
			setArgumentsText("");
			setCwd("");
			setTimeoutMs(30_000);
			setSecretValue("");
		}
	};

	const importJson = async () => {
		setJsonError(undefined);
		setJsonFeedback(undefined);
		let servers: ReturnType<typeof parseMcpConfigJson>;
		try {
			servers = parseMcpConfigJson(jsonText);
		} catch (importError) {
			const code = importError instanceof McpConfigJsonError ? importError.code : "invalid-json";
			setJsonError(
				code === "empty"
					? t("runtimeResources.jsonError.empty")
					: code === "invalid-root"
						? t("runtimeResources.jsonError.invalid-root")
						: code === "invalid-server"
							? t("runtimeResources.jsonError.invalid-server")
							: code === "too-large"
								? t("runtimeResources.jsonError.too-large")
								: code === "too-many"
									? t("runtimeResources.jsonError.too-many")
									: t("runtimeResources.jsonError.invalid-json"),
			);
			return;
		}
		const attempt =
			jsonImportAttempt.current?.ownerKey === ownerKey
				? jsonImportAttempt.current
				: { ownerKey, items: new Map() };
		const occurrenceBySemanticKey = new Map<string, number>();
		const importItems = servers.map((server) => {
			const semanticKey = getImportedMcpServerKey(server);
			const occurrence = occurrenceBySemanticKey.get(semanticKey) ?? 0;
			occurrenceBySemanticKey.set(semanticKey, occurrence + 1);
			const itemKey = `${semanticKey}\0${occurrence}`;
			let progress = attempt.items.get(itemKey);
			if (progress === undefined) {
				const commandId = crypto.randomUUID();
				progress = {
					commandId,
					stableResourceId: `mcp-${commandId}`,
					completed: false,
				};
				attempt.items.set(itemKey, progress);
			}
			return { itemKey, server, progress };
		});
		const activeItemKeys = new Set(importItems.map((item) => item.itemKey));
		for (const itemKey of attempt.items.keys()) {
			if (!activeItemKeys.has(itemKey)) {
				attempt.items.delete(itemKey);
			}
		}
		jsonImportAttempt.current = attempt;
		const submittedDraftRevision = jsonDraftRevision.current;
		const succeeded = await mutate(async () => {
			const pendingItems = importItems.filter((item) => !item.progress.completed);
			const results = await Promise.allSettled(
				pendingItems.map(({ server, progress }) =>
					desktopClient.upsertOwnedMcpServer({
						owner,
						commandId: progress.commandId,
						stableResourceId: progress.stableResourceId,
						displayName: server.displayName,
						enabled: server.enabled,
						transport: server.transport,
						...(server.secret === undefined ? {} : { secret: server.secret }),
					}),
				),
			);
			const failures: unknown[] = [];
			for (const [index, result] of results.entries()) {
				const item = pendingItems[index];
				if (item === undefined) {
					throw new Error("MCP JSON import result did not match its input.");
				}
				if (result.status === "fulfilled") {
					item.progress.completed = true;
				} else {
					failures.push(result.reason);
				}
			}
			if (failures.length > 0) {
				throw new AggregateError(failures, "One or more MCP Servers could not be imported.");
			}
		});
		if (succeeded && jsonDraftRevision.current === submittedDraftRevision) {
			jsonImportAttempt.current = undefined;
			jsonDraftRevision.current += 1;
			setJsonText("");
			setJsonFeedback(t("runtimeResources.jsonImported", String(servers.length)));
		}
	};

	const toggleProfile = async (item: McpView) => {
		if (scope === "agent-server") {
			if (globalProfile === undefined) {
				return;
			}
			const existing = globalProfile.serverMcpRefs.find(
				(ref) => ref.stableResourceId === item.stableResourceId,
			);
			const assigned =
				existing?.version === item.version && existing.contentHash === item.contentHash;
			const shouldRemove = existing !== undefined && (assigned || item.health !== "ready");
			const serverMcpRefs = shouldRemove
				? globalProfile.serverMcpRefs.filter(
						(ref) => ref.stableResourceId !== item.stableResourceId,
					)
				: [
						...globalProfile.serverMcpRefs.filter(
							(ref) => ref.stableResourceId !== item.stableResourceId,
						),
						{
							owner: { kind: "agent-server" as const },
							stableResourceId: item.stableResourceId,
							version: item.version,
							contentHash: item.contentHash,
						},
					];
			await mutate(() =>
				desktopClient.updateAgentGlobalProfile({
					agentId: globalProfile.agentId,
					expectedRevision: globalProfile.revision,
					serverMcpRefs,
				}),
			);
			return;
		}
		if (profile === undefined) {
			return;
		}
		const existing = profile.resources.find(
			(ref) => ref.resourceKind === "mcp" && ref.stableResourceId === item.stableResourceId,
		);
		const assigned =
			existing?.version === item.version && existing.contentHash === item.contentHash;
		const shouldRemove = existing !== undefined && (assigned || item.health !== "ready");
		const resources = shouldRemove
			? profile.resources.filter(
					(ref) => !(ref.resourceKind === "mcp" && ref.stableResourceId === item.stableResourceId),
				)
			: [
					...profile.resources.filter(
						(ref) =>
							!(ref.resourceKind === "mcp" && ref.stableResourceId === item.stableResourceId),
					),
					createResourceRef(runtimeBoxId, "mcp", item),
				];
		await mutate(async () => {
			await desktopClient.updateRuntimeProfile({
				agentId: profile.agentId,
				runtimeBoxId,
				expectedRevision: profile.revision,
				resources,
			});
		});
	};

	return (
		<RuntimeResourceSection
			eyebrow={t("runtimeResources.mcpEyebrow")}
			title={t("runtimeResources.mcpTitle")}
			description={t("runtimeResources.mcpDescription")}
			runtimeBoxId={scope === "agent-server" ? "agent-server" : runtimeBoxId}
			stale={stale}
			error={error}
			onRefresh={() => void load()}
		>
			<div className="mcp-settings">
				<Card className="mcp-settings__owner" variant="secondary">
					<Card.Header>
						<Card.Title>{t("runtimeResources.mcpScope")}</Card.Title>
						<Card.Description>
							{scope === "agent-server"
								? t("runtimeResources.agentServerScopeDescription")
								: t("runtimeResources.runtimeBoxScopeDescription")}
						</Card.Description>
					</Card.Header>
					<Card.Content>
						<Select
							fullWidth
							aria-label={t("runtimeResources.mcpScope")}
							selectedKey={scope}
							onSelectionChange={(key) => {
								const nextScope = String(key) as "agent-server" | "runtime-box";
								setSecretValue("");
								setScope(nextScope);
							}}
						>
							<Label>{t("runtimeResources.mcpScope")}</Label>
							<Select.Trigger>
								<Select.Value />
								<Select.Indicator />
							</Select.Trigger>
							<Select.Popover>
								<ListBox>
									<ListBox.Item
										id="agent-server"
										textValue={t("runtimeResources.agentServerScope")}
									>
										{t("runtimeResources.agentServerScope")}
									</ListBox.Item>
									<ListBox.Item
										id="runtime-box"
										textValue={`${t("runtimeResources.runtimeBoxScope")} · ${runtimeBoxId}`}
									>
										{t("runtimeResources.runtimeBoxScope")} · {runtimeBoxId}
									</ListBox.Item>
								</ListBox>
							</Select.Popover>
						</Select>
					</Card.Content>
				</Card>

				<Card className="mcp-settings__create" variant="secondary">
					<Card.Header>
						<Card.Title>{t("runtimeResources.addMcp")}</Card.Title>
						<Card.Description>{t("runtimeResources.addMcpDescription")}</Card.Description>
					</Card.Header>
					<Card.Content>
						<Tabs
							selectedKey={entryMode}
							onSelectionChange={(key) => setEntryMode(String(key) as "form" | "json")}
						>
							<Tabs.ListContainer>
								<Tabs.List aria-label={t("runtimeResources.addMcp")}>
									<Tabs.Tab id="form">{t("runtimeResources.formMode")}</Tabs.Tab>
									<Tabs.Tab id="json">{t("runtimeResources.jsonMode")}</Tabs.Tab>
								</Tabs.List>
							</Tabs.ListContainer>
							<Tabs.Panel id="form">
								<Form
									className="mcp-settings__form"
									onSubmit={(event) => {
										event.preventDefault();
										void addServer();
									}}
								>
									<div className="mcp-settings__form-grid">
										<TextField
											fullWidth
											isRequired
											value={displayName}
											onChange={(value) => {
												markManualDraftChanged();
												setDisplayName(value);
											}}
										>
											<Label>{t("runtimeResources.name")}</Label>
											<Input placeholder={t("runtimeResources.namePlaceholder")} />
										</TextField>
										<Select
											fullWidth
											selectedKey={transportType}
											onSelectionChange={(key) => {
												markManualDraftChanged();
												setTransportType(String(key) as "stdio" | "streamable-http" | "sse");
											}}
										>
											<Label>{t("runtimeResources.transport")}</Label>
											<Select.Trigger>
												<Select.Value />
												<Select.Indicator />
											</Select.Trigger>
											<Select.Popover>
												<ListBox>
													<ListBox.Item id="stdio">stdio</ListBox.Item>
													<ListBox.Item id="streamable-http">Streamable HTTP</ListBox.Item>
													<ListBox.Item id="sse">SSE</ListBox.Item>
												</ListBox>
											</Select.Popover>
										</Select>
										<TextField
											fullWidth
											isRequired
											value={endpoint}
											onChange={(value) => {
												markManualDraftChanged();
												setEndpoint(value);
											}}
										>
											<Label>
												{transportType === "stdio"
													? t("runtimeResources.command")
													: t("runtimeResources.url")}
											</Label>
											<Input
												placeholder={
													transportType === "stdio"
														? t("runtimeResources.commandPlaceholder")
														: t("runtimeResources.urlPlaceholder")
												}
											/>
										</TextField>
										<NumberField
											fullWidth
											isRequired
											minValue={1_000}
											maxValue={120_000}
											step={1_000}
											value={timeoutMs}
											onChange={(value) => {
												markManualDraftChanged();
												setTimeoutMs(value);
											}}
										>
											<Label>{t("runtimeResources.timeout")}</Label>
											<NumberField.Group>
												<NumberField.Input />
												<NumberField.DecrementButton>-</NumberField.DecrementButton>
												<NumberField.IncrementButton>+</NumberField.IncrementButton>
											</NumberField.Group>
											<Description>{t("runtimeResources.timeoutDescription")}</Description>
										</NumberField>
										{transportType === "stdio" ? (
											<>
												<TextField
													fullWidth
													value={cwd}
													onChange={(value) => {
														markManualDraftChanged();
														setCwd(value);
													}}
												>
													<Label>{t("runtimeResources.cwd")}</Label>
													<Input placeholder={t("runtimeResources.cwdPlaceholder")} />
												</TextField>
												<TextField
													className="mcp-settings__wide-field"
													fullWidth
													value={argumentsText}
													onChange={(value) => {
														markManualDraftChanged();
														setArgumentsText(value);
													}}
												>
													<Label>{t("runtimeResources.arguments")}</Label>
													<TextArea rows={4} />
													<Description>{t("runtimeResources.argumentsDescription")}</Description>
												</TextField>
											</>
										) : null}
										<TextField
											fullWidth
											value={secretName}
											onChange={(value) => {
												markManualDraftChanged();
												setSecretName(value);
											}}
										>
											<Label>{t("runtimeResources.secretName")}</Label>
											<Input placeholder="MCP_TOKEN" />
										</TextField>
										<TextField
											fullWidth
											value={secretValue}
											onChange={(value) => {
												markManualDraftChanged();
												secretOwnerKey.current = ownerKey;
												setSecretValue(value);
											}}
										>
											<Label>{t("runtimeResources.secretValue")}</Label>
											<Input type="password" autoComplete="off" />
											<Description>{t("runtimeResources.secretDescription")}</Description>
										</TextField>
									</div>
									<div className="mcp-settings__form-actions">
										<Button
											type="submit"
											variant="primary"
											isDisabled={pending || !ownerReady || !manualFormValid}
										>
											{t("runtimeResources.add")}
										</Button>
									</div>
								</Form>
							</Tabs.Panel>
							<Tabs.Panel id="json">
								<div className="mcp-settings__json">
									<TextField
										fullWidth
										isInvalid={jsonError !== undefined}
										value={jsonText}
										onChange={(value) => {
											jsonDraftRevision.current += 1;
											setJsonText(value);
											setJsonError(undefined);
											setJsonFeedback(undefined);
										}}
									>
										<Label>{t("runtimeResources.jsonConfig")}</Label>
										<TextArea
											className="mcp-settings__json-input"
											rows={12}
											placeholder={t("runtimeResources.jsonPlaceholder")}
											spellCheck={false}
										/>
										<Description>{t("runtimeResources.jsonDescription")}</Description>
									</TextField>
									{jsonError === undefined ? null : (
										<p className="mcp-settings__feedback is-error" role="alert">
											{jsonError}
										</p>
									)}
									{jsonFeedback === undefined ? null : (
										<p className="mcp-settings__feedback" role="status">
											{jsonFeedback}
										</p>
									)}
									<div className="mcp-settings__form-actions">
										<Button
											variant="primary"
											isDisabled={pending || !ownerReady || jsonText.trim().length === 0}
											onPress={() => void importJson()}
										>
											{t("runtimeResources.importJson")}
										</Button>
									</div>
								</div>
							</Tabs.Panel>
						</Tabs>
					</Card.Content>
				</Card>

				<section className="mcp-settings__servers">
					<div className="mcp-settings__section-heading">
						<div>
							<h2>{t("runtimeResources.configuredMcp")}</h2>
							<p>{t("runtimeResources.configuredMcpDescription")}</p>
						</div>
						<Chip color="default" variant="soft">
							{t("runtimeResources.serverCount", String(items.length))}
						</Chip>
					</div>
					{items.length === 0 ? (
						<Card className="mcp-settings__empty" variant="secondary">
							<Card.Content>{t("runtimeResources.noMcp")}</Card.Content>
						</Card>
					) : (
						<div className="mcp-settings__server-grid">
							{items.map((item) => {
								const server = item.server;
								const assigned =
									scope === "agent-server"
										? globalProfile?.serverMcpRefs.some(
												(ref) =>
													ref.stableResourceId === item.stableResourceId &&
													ref.version === item.version &&
													ref.contentHash === item.contentHash,
											)
										: profile?.resources.some(
												(ref) =>
													ref.resourceKind === "mcp" &&
													ref.stableResourceId === item.stableResourceId &&
													ref.version === item.version &&
													ref.contentHash === item.contentHash,
											);
								const referenced =
									scope === "agent-server"
										? globalProfile?.serverMcpRefs.some(
												(ref) => ref.stableResourceId === item.stableResourceId,
											)
										: profile?.resources.some(
												(ref) =>
													ref.resourceKind === "mcp" &&
													ref.stableResourceId === item.stableResourceId,
											);
								const removeReference =
									referenced === true && (assigned === true || item.health !== "ready");
								return (
									<Card className="mcp-server-card" key={item.stableResourceId} variant="secondary">
										<Card.Header>
											<div className="mcp-server-card__title">
												<Card.Title>{item.displayName}</Card.Title>
												<Chip color={mcpHealthColor(item.health)} size="sm" variant="soft">
													{item.health === "ready"
														? t("runtimeResources.health.ready")
														: item.health === "stopped"
															? t("runtimeResources.health.stopped")
															: t("runtimeResources.health.error")}
												</Chip>
											</div>
											<Card.Description>
												<code>{item.stableResourceId}</code>
											</Card.Description>
										</Card.Header>
										<Card.Content className="mcp-server-card__content">
											<div className="mcp-server-card__chips">
												<Chip color="default" size="sm" variant="soft">
													{t("runtimeResources.toolCount", String(item.toolCount))}
												</Chip>
												<Chip
													color={item.credentialConfigured ? "success" : "default"}
													size="sm"
													variant="soft"
												>
													{item.credentialConfigured
														? t("runtimeResources.credentialConfigured")
														: t("runtimeResources.credentialMissing")}
												</Chip>
												{referenced ? (
													<Chip color="accent" size="sm" variant="soft">
														{t("runtimeResources.usedByAgent")}
													</Chip>
												) : null}
											</div>
										</Card.Content>
										<Card.Footer className="mcp-server-card__actions">
											<Button
												size="sm"
												variant="secondary"
												isDisabled={
													pending ||
													!ownerReady ||
													(removeReference !== true && item.health !== "ready")
												}
												onPress={() => void toggleProfile(item)}
											>
												{removeReference
													? t("runtimeResources.removeFromProfile")
													: t("runtimeResources.addToProfile")}
											</Button>
											{server ? (
												<Button
													size="sm"
													variant="tertiary"
													isDisabled={
														pending ||
														!ownerReady ||
														(scope === "runtime-box" && referenced === true)
													}
													onPress={() =>
														void mutate(() =>
															desktopClient.setOwnedMcpServerEnabled({
																owner,
																commandId: crypto.randomUUID(),
																stableResourceId: server.stableResourceId,
																expectedConfigRevision: server.configRevision,
																enabled: !server.enabled,
															}),
														)
													}
												>
													{server.enabled
														? t("runtimeResources.stop")
														: t("runtimeResources.start")}
												</Button>
											) : null}
											{server ? (
												<Button
													size="sm"
													variant="danger-soft"
													isDisabled={pending || !ownerReady}
													onPress={() =>
														void mutate(() =>
															desktopClient.deleteOwnedMcpServer({
																owner,
																commandId: crypto.randomUUID(),
																stableResourceId: server.stableResourceId,
																expectedConfigRevision: server.configRevision,
																deleteCredentials: true,
															}),
														)
													}
												>
													{t("runtimeResources.delete")}
												</Button>
											) : null}
										</Card.Footer>
									</Card>
								);
							})}
						</div>
					)}
				</section>
			</div>
		</RuntimeResourceSection>
	);
}

function mcpHealthColor(health: McpView["health"]): "success" | "default" | "danger" {
	if (health === "ready") {
		return "success";
	}
	if (health === "error") {
		return "danger";
	}
	return "default";
}

export function SkillsSettingsPage() {
	const { t } = useI18n();
	const runtimeBoxes = useRuntimeBoxes();
	const runtimeBoxId = runtimeBoxes.snapshot.active.runtimeBoxId;
	const [items, setItems] = useState<SkillView[]>([]);
	const [profile, setProfile] = useState<RuntimeProfile>();
	const [stale, setStale] = useState(false);
	const [error, setError] = useState<string>();
	const [pending, setPending] = useState(false);
	const [source, setSource] = useState("local-upload");
	const [skillMarkdown, setSkillMarkdown] = useState(
		"---\nname: my-skill\ndescription: Describe when this Skill should be used\n---\n\nAdd Skill instructions here.",
	);
	const loadGeneration = useRef(0);
	const createCommandId = useRef<string | undefined>(undefined);
	const activeRuntimeBoxId = useRef(runtimeBoxId);
	const mutationGeneration = useRef(0);
	activeRuntimeBoxId.current = runtimeBoxId;

	const load = useCallback(async () => {
		if (activeRuntimeBoxId.current !== runtimeBoxId) {
			return;
		}
		const generation = ++loadGeneration.current;
		setError(undefined);
		try {
			const [inventory, profileOutput] = await Promise.all([
				desktopClient.listRuntimeInventory(runtimeBoxId),
				desktopClient.getRuntimeProfile(runtimeBoxId),
			]);
			if (generation !== loadGeneration.current || activeRuntimeBoxId.current !== runtimeBoxId) {
				return;
			}
			setStale(inventory.stale);
			setProfile(profileOutput.profile);
			if (runtimeBoxes.isActiveReady) {
				const live = await desktopClient.listSkills(runtimeBoxId);
				if (generation !== loadGeneration.current || activeRuntimeBoxId.current !== runtimeBoxId) {
					return;
				}
				setItems(
					appendMissingSkillRefs(
						live.items.map((skill) => ({
							stableResourceId: skill.stableResourceId,
							version: skill.version,
							contentHash: skill.contentHash,
							health: skill.enabled ? "ready" : "stopped",
							skill,
						})),
						profileOutput.profile,
					),
				);
			} else {
				setItems(
					appendMissingSkillRefs(
						inventory.resources
							.filter((resource) => resource.resourceKind === "skill")
							.map((resource) => ({
								stableResourceId: resource.stableResourceId,
								version: resource.version,
								contentHash: resource.contentHash,
								health: resource.health,
							})),
						profileOutput.profile,
					),
				);
			}
		} catch (loadError) {
			if (generation !== loadGeneration.current || activeRuntimeBoxId.current !== runtimeBoxId) {
				return;
			}
			setError(loadError instanceof Error ? loadError.message : t("runtimeResources.loadFailed"));
		}
	}, [runtimeBoxId, runtimeBoxes.isActiveReady, t]);

	useEffect(() => {
		setItems([]);
		setProfile(undefined);
		setPending(false);
		mutationGeneration.current += 1;
		createCommandId.current = undefined;
		void load();
		const timer = setInterval(() => void load(), 2_000);
		return () => {
			clearInterval(timer);
			loadGeneration.current += 1;
		};
	}, [load]);

	const mutate = async (operation: () => Promise<unknown>) => {
		const generation = ++mutationGeneration.current;
		setPending(true);
		setError(undefined);
		try {
			await operation();
			const stillSelected = activeRuntimeBoxId.current === runtimeBoxId;
			if (stillSelected) {
				await load();
			}
			return stillSelected;
		} catch (mutationError) {
			if (
				activeRuntimeBoxId.current === runtimeBoxId &&
				mutationGeneration.current === generation
			) {
				setError(
					mutationError instanceof Error
						? mutationError.message
						: t("runtimeResources.mutationFailed"),
				);
			}
			return false;
		} finally {
			if (mutationGeneration.current === generation) {
				setPending(false);
			}
		}
	};

	const toggleProfile = async (item: SkillView) => {
		if (profile === undefined) {
			return;
		}
		const existing = profile.resources.find(
			(ref) => ref.resourceKind === "skill" && ref.stableResourceId === item.stableResourceId,
		);
		const assigned =
			existing?.version === item.version && existing.contentHash === item.contentHash;
		const resources = assigned
			? profile.resources.filter(
					(ref) =>
						!(ref.resourceKind === "skill" && ref.stableResourceId === item.stableResourceId),
				)
			: [
					...profile.resources.filter(
						(ref) =>
							!(ref.resourceKind === "skill" && ref.stableResourceId === item.stableResourceId),
					),
					createResourceRef(runtimeBoxId, "skill", item),
				];
		await mutate(async () => {
			await desktopClient.updateRuntimeProfile({
				agentId: profile.agentId,
				runtimeBoxId,
				expectedRevision: profile.revision,
				resources,
			});
		});
	};

	return (
		<RuntimeResourceSection
			eyebrow={t("runtimeResources.skillsEyebrow")}
			title={t("runtimeResources.skillsTitle")}
			description={t("runtimeResources.skillsDescription")}
			runtimeBoxId={runtimeBoxId}
			stale={stale}
			error={error}
			onRefresh={() => void load()}
		>
			<section className="chat-card provider-form">
				<h2>{t("runtimeResources.installSkill")}</h2>
				<label>
					<span>{t("runtimeResources.source")}</span>
					<input value={source} onChange={(event) => setSource(event.target.value)} />
				</label>
				<label>
					<span>SKILL.md</span>
					<textarea
						rows={12}
						value={skillMarkdown}
						onChange={(event) => setSkillMarkdown(event.target.value)}
					/>
				</label>
				<Button
					className="chat-button chat-button--primary"
					isDisabled={pending || !runtimeBoxes.isActiveReady || skillMarkdown.trim().length === 0}
					onPress={() => {
						const commandId = createCommandId.current ?? crypto.randomUUID();
						createCommandId.current = commandId;
						void mutate(() =>
							desktopClient.installSkill({
								runtimeBoxId,
								commandId,
								stableResourceId: `skill-${commandId}`,
								source,
								enabled: true,
								files: [
									{
										path: "SKILL.md",
										encoding: "utf8",
										content: skillMarkdown,
										executable: false,
									},
								],
							}),
						).then((succeeded) => {
							if (succeeded) {
								createCommandId.current = undefined;
							}
						});
					}}
				>
					{t("runtimeResources.install")}
				</Button>
			</section>

			<ResourceCards
				emptyLabel={t("runtimeResources.noSkills")}
				items={items.map((item) => {
					const assigned = profile?.resources.some(
						(ref) =>
							ref.resourceKind === "skill" &&
							ref.stableResourceId === item.stableResourceId &&
							ref.version === item.version &&
							ref.contentHash === item.contentHash,
					);
					const referenced = profile?.resources.some(
						(ref) => ref.resourceKind === "skill" && ref.stableResourceId === item.stableResourceId,
					);
					return {
						key: item.stableResourceId,
						title: item.skill?.metadata.name ?? item.stableResourceId,
						subtitle: `${item.health} · ${
							item.skill?.metadata.description ?? item.contentHash.slice(0, 12)
						}`,
						actions: (
							<>
								<Button
									className="chat-button"
									isDisabled={
										pending || !runtimeBoxes.isActiveReady || (!assigned && item.health !== "ready")
									}
									onPress={() => void toggleProfile(item)}
								>
									{assigned
										? t("runtimeResources.removeFromProfile")
										: t("runtimeResources.addToProfile")}
								</Button>
								<Button
									className="chat-button chat-button--danger"
									isDisabled={
										pending || !runtimeBoxes.isActiveReady || item.skill === undefined || referenced
									}
									onPress={() =>
										void mutate(() =>
											desktopClient.deleteSkill({
												runtimeBoxId,
												commandId: crypto.randomUUID(),
												stableResourceId: item.stableResourceId,
												expectedVersion: item.version,
											}),
										)
									}
								>
									{t("runtimeResources.delete")}
								</Button>
							</>
						),
					};
				})}
			/>
		</RuntimeResourceSection>
	);
}

function RuntimeResourceSection(props: {
	eyebrow: string;
	title: string;
	description: string;
	runtimeBoxId: string;
	stale: boolean;
	error?: string;
	onRefresh(): void;
	children: React.ReactNode;
}) {
	const { t } = useI18n();
	return (
		<section className="settings-section runtime-resources-settings">
			<header className="settings-section__header">
				<span className="chat-page__eyebrow">{props.eyebrow}</span>
				<h1>{props.title}</h1>
				<p>{props.description}</p>
				<code>{props.runtimeBoxId}</code>
				{props.stale ? <strong>{t("runtimeResources.stale")}</strong> : null}
				<Button className="chat-button" onPress={props.onRefresh}>
					{t("runtimeResources.refresh")}
				</Button>
			</header>
			{props.error ? (
				<p className="session-sidebar__error" role="alert">
					{props.error}
				</p>
			) : null}
			{props.children}
		</section>
	);
}

function ResourceCards(props: {
	emptyLabel: string;
	items: readonly {
		key: string;
		title: string;
		subtitle: string;
		actions: React.ReactNode;
	}[];
}) {
	if (props.items.length === 0) {
		return <p className="chat-card">{props.emptyLabel}</p>;
	}
	return (
		<section className="runtime-boxes-list">
			{props.items.map((item) => (
				<article className="runtime-box-card" key={item.key}>
					<div className="runtime-box-card__identity">
						<div>
							<strong>{item.title}</strong>
							<span>{item.subtitle}</span>
							<code>{item.key}</code>
						</div>
					</div>
					<div className="runtime-box-card__actions">{item.actions}</div>
				</article>
			))}
		</section>
	);
}

function createResourceRef(
	runtimeBoxId: string,
	resourceKind: "mcp" | "skill",
	resource: {
		stableResourceId: string;
		version: string;
		contentHash: string;
	},
): RuntimeBoxResourceRef {
	return {
		runtimeBoxId,
		resourceKind,
		stableResourceId: resource.stableResourceId,
		version: resource.version,
		contentHash: resource.contentHash,
	};
}

function toMcpView(server: McpServerSummary): McpView {
	return {
		stableResourceId: server.stableResourceId,
		configRevision: server.configRevision,
		version: server.version,
		contentHash: server.contentHash,
		displayName: server.displayName,
		health: server.health,
		credentialConfigured: server.credentialConfigured,
		toolCount: server.tools.length,
		server,
	};
}

function appendMissingAgentServerMcpRefs(items: McpView[], profile: AgentGlobalProfile): McpView[] {
	const installed = new Set(items.map((item) => item.stableResourceId));
	for (const ref of profile.serverMcpRefs) {
		if (installed.has(ref.stableResourceId)) {
			continue;
		}
		items.push({
			stableResourceId: ref.stableResourceId,
			configRevision: 1,
			version: ref.version,
			contentHash: ref.contentHash,
			displayName: ref.stableResourceId,
			health: "error",
			credentialConfigured: false,
			toolCount: 0,
		});
	}
	return items;
}

function appendMissingMcpRefs(items: McpView[], profile: RuntimeProfile): McpView[] {
	const installed = new Set(items.map((item) => item.stableResourceId));
	for (const ref of profile.resources) {
		if (ref.resourceKind !== "mcp" || installed.has(ref.stableResourceId)) {
			continue;
		}
		items.push({
			stableResourceId: ref.stableResourceId,
			configRevision: 1,
			version: ref.version,
			contentHash: ref.contentHash,
			displayName: ref.stableResourceId,
			health: "error",
			credentialConfigured: false,
			toolCount: 0,
		});
	}
	return items;
}

function appendMissingSkillRefs(items: SkillView[], profile: RuntimeProfile): SkillView[] {
	const installed = new Set(items.map((item) => item.stableResourceId));
	for (const ref of profile.resources) {
		if (ref.resourceKind !== "skill" || installed.has(ref.stableResourceId)) {
			continue;
		}
		items.push({
			stableResourceId: ref.stableResourceId,
			version: ref.version,
			contentHash: ref.contentHash,
			health: "error",
		});
	}
	return items;
}
