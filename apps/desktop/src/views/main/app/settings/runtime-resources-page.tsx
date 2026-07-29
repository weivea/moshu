import { Button } from "@heroui/react";
import type {
	RuntimeBoxMcpServerSummary,
	RuntimeBoxResourceRef,
	RuntimeBoxSkill,
	RuntimeProfile,
} from "@moshu/contracts";
import { useCallback, useEffect, useRef, useState } from "react";

import { desktopClient } from "../../lib/rpc";
import { useI18n } from "../i18n";
import { useRuntimeBoxes } from "../runtime-boxes";

interface McpView {
	stableResourceId: string;
	version: string;
	contentHash: string;
	displayName: string;
	health: "ready" | "stopped" | "error";
	credentialConfigured: boolean;
	toolCount: number;
	server?: RuntimeBoxMcpServerSummary;
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
	const [items, setItems] = useState<McpView[]>([]);
	const [profile, setProfile] = useState<RuntimeProfile>();
	const [stale, setStale] = useState(false);
	const [error, setError] = useState<string>();
	const [pending, setPending] = useState(false);
	const [displayName, setDisplayName] = useState("");
	const [transportType, setTransportType] = useState<"stdio" | "streamable-http">("stdio");
	const [endpoint, setEndpoint] = useState("");
	const [argumentsText, setArgumentsText] = useState("");
	const [secretName, setSecretName] = useState("MCP_TOKEN");
	const [secretValue, setSecretValue] = useState("");
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
				const live = await desktopClient.listMcpServers(runtimeBoxId);
				if (generation !== loadGeneration.current || activeRuntimeBoxId.current !== runtimeBoxId) {
					return;
				}
				setItems(
					appendMissingMcpRefs(
						live.items.map((server) => ({
							stableResourceId: server.stableResourceId,
							version: server.version,
							contentHash: server.contentHash,
							displayName: server.displayName,
							health: server.health,
							credentialConfigured: server.credentialConfigured,
							toolCount: server.tools.length,
							server,
						})),
						profileOutput.profile,
					),
				);
			} else {
				setItems(
					appendMissingMcpRefs(
						inventory.resources
							.filter((resource) => resource.resourceKind === "mcp")
							.map((resource) => ({
								stableResourceId: resource.stableResourceId,
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

	const addServer = async () => {
		const trimmedEndpoint = endpoint.trim();
		const commandId = createCommandId.current ?? crypto.randomUUID();
		createCommandId.current = commandId;
		const succeeded = await mutate(async () => {
			await desktopClient.upsertMcpServer({
				runtimeBoxId,
				commandId,
				stableResourceId: `mcp-${commandId}`,
				displayName: displayName.trim(),
				enabled: true,
				transport:
					transportType === "stdio"
						? {
								type: "stdio",
								command: trimmedEndpoint,
								args: argumentsText
									.split("\n")
									.map((value) => value.trim())
									.filter((value) => value.length > 0),
								startupTimeoutMs: 30_000,
							}
						: {
								type: "streamable-http",
								url: trimmedEndpoint,
								timeoutMs: 30_000,
							},
				...(secretValue.length === 0
					? {}
					: {
							secret:
								transportType === "stdio"
									? { environment: { [secretName.trim()]: secretValue } }
									: { headers: { [secretName.trim()]: secretValue } },
						}),
			});
		});
		if (succeeded) {
			createCommandId.current = undefined;
			setDisplayName("");
			setEndpoint("");
			setArgumentsText("");
			setSecretValue("");
		}
	};

	const toggleProfile = async (item: McpView) => {
		if (profile === undefined) {
			return;
		}
		const existing = profile.resources.find(
			(ref) => ref.resourceKind === "mcp" && ref.stableResourceId === item.stableResourceId,
		);
		const assigned =
			existing?.version === item.version && existing.contentHash === item.contentHash;
		const resources = assigned
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
			runtimeBoxId={runtimeBoxId}
			stale={stale}
			error={error}
			onRefresh={() => void load()}
		>
			<section className="chat-card provider-form">
				<h2>{t("runtimeResources.addMcp")}</h2>
				<label>
					<span>{t("runtimeResources.name")}</span>
					<input value={displayName} onChange={(event) => setDisplayName(event.target.value)} />
				</label>
				<label>
					<span>{t("runtimeResources.transport")}</span>
					<select
						value={transportType}
						onChange={(event) =>
							setTransportType(event.target.value as "stdio" | "streamable-http")
						}
					>
						<option value="stdio">stdio</option>
						<option value="streamable-http">Streamable HTTP</option>
					</select>
				</label>
				<label>
					<span>
						{transportType === "stdio" ? t("runtimeResources.command") : t("runtimeResources.url")}
					</span>
					<input value={endpoint} onChange={(event) => setEndpoint(event.target.value)} />
				</label>
				{transportType === "stdio" ? (
					<label>
						<span>{t("runtimeResources.arguments")}</span>
						<textarea
							value={argumentsText}
							onChange={(event) => setArgumentsText(event.target.value)}
						/>
					</label>
				) : null}
				<label>
					<span>{t("runtimeResources.secretName")}</span>
					<input value={secretName} onChange={(event) => setSecretName(event.target.value)} />
				</label>
				<label>
					<span>{t("runtimeResources.secretValue")}</span>
					<input
						type="password"
						value={secretValue}
						autoComplete="off"
						onChange={(event) => setSecretValue(event.target.value)}
					/>
				</label>
				<Button
					className="chat-button chat-button--primary"
					isDisabled={
						pending ||
						!runtimeBoxes.isActiveReady ||
						displayName.trim().length === 0 ||
						endpoint.trim().length === 0
					}
					onPress={() => void addServer()}
				>
					{t("runtimeResources.add")}
				</Button>
			</section>

			<ResourceCards
				emptyLabel={t("runtimeResources.noMcp")}
				items={items.map((item) => {
					const server = item.server;
					const assigned = profile?.resources.some(
						(ref) =>
							ref.resourceKind === "mcp" &&
							ref.stableResourceId === item.stableResourceId &&
							ref.version === item.version &&
							ref.contentHash === item.contentHash,
					);
					const referenced = profile?.resources.some(
						(ref) => ref.resourceKind === "mcp" && ref.stableResourceId === item.stableResourceId,
					);
					return {
						key: item.stableResourceId,
						title: item.displayName,
						subtitle: `${item.health} · ${item.toolCount} tools · ${
							item.credentialConfigured ? "credential configured" : "no credential"
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
								{server ? (
									<Button
										className="chat-button"
										isDisabled={pending || !runtimeBoxes.isActiveReady || referenced}
										onPress={() =>
											void mutate(() =>
												desktopClient.setMcpServerEnabled({
													runtimeBoxId,
													commandId: crypto.randomUUID(),
													stableResourceId: server.stableResourceId,
													expectedVersion: server.version,
													enabled: !server.enabled,
												}),
											)
										}
									>
										{server.enabled ? t("runtimeResources.stop") : t("runtimeResources.start")}
									</Button>
								) : null}
								{server ? (
									<Button
										className="chat-button chat-button--danger"
										isDisabled={pending || !runtimeBoxes.isActiveReady}
										onPress={() =>
											void mutate(() =>
												desktopClient.deleteMcpServer({
													runtimeBoxId,
													commandId: crypto.randomUUID(),
													stableResourceId: server.stableResourceId,
													expectedVersion: server.version,
													deleteCredentials: true,
												}),
											)
										}
									>
										{t("runtimeResources.delete")}
									</Button>
								) : null}
							</>
						),
					};
				})}
			/>
		</RuntimeResourceSection>
	);
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

function appendMissingMcpRefs(items: McpView[], profile: RuntimeProfile): McpView[] {
	const installed = new Set(items.map((item) => item.stableResourceId));
	for (const ref of profile.resources) {
		if (ref.resourceKind !== "mcp" || installed.has(ref.stableResourceId)) {
			continue;
		}
		items.push({
			stableResourceId: ref.stableResourceId,
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
