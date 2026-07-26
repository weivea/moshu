import { maxRetainedSessionRetirements, retiredSessionTombstoneTtlMs } from "@moshu/contracts";
import { createContext, type ReactNode, useContext, useLayoutEffect, useRef } from "react";

import { isChatSessionNotFoundError } from "../../../../shared/rpc-errors";
import {
	SessionRetirementCache,
	SessionRetirementCapacityError,
} from "../../../../shared/session-retirement-cache";
import type { ChatSessionInvalidation, ChatTransport } from "./transport";

const retiredChatSessionsStorageKey = "moshu.retiredChatSessions.v1";
const lastChatSessionStorageKey = "moshu.lastChatSessionId";
const maxRecoveryRouteAttempts = 4;
const controllerRegistrationWaitMs = 100;

interface RecoveryRoute {
	generation: number;
	key: string;
	sessionId: string | null;
}

interface RecoveryController {
	generation: number;
	sessionId: string;
	refresh(): Promise<boolean>;
	retire(): void;
}

interface RecoveryContextValue {
	coordinator: ChatSessionRecoveryCoordinator;
	route: RecoveryRoute;
}

interface RendererRetiredSession {
	sessionId: string;
	retiredAtMs: number;
}

interface ConcludedRetirement {
	status: "processing" | "concluded";
}

const RecoveryContext = createContext<RecoveryContextValue | null>(null);
const coordinators = new WeakMap<ChatTransport, ChatSessionRecoveryCoordinator>();

export class ChatSessionRecoveryCoordinator {
	readonly #transport: ChatTransport;
	#route: RecoveryRoute = { generation: 0, key: "initial", sessionId: null };
	#controllers = new Map<number, RecoveryController>();
	#controllerWaiters = new Map<number, Set<(controller?: RecoveryController) => void>>();
	#rootRetirementHandlers = new Set<(sessionId: string) => void>();
	#retirementListeners = new Set<(sessionId: string) => void>();
	readonly #concludedRetirements: SessionRetirementCache<ConcludedRetirement>;
	#unsubscribeInvalidations?: () => void;

	constructor(
		transport: ChatTransport,
		private readonly now: () => number = Date.now,
	) {
		this.#transport = transport;
		this.#concludedRetirements = new SessionRetirementCache({ now });
	}

	usesTransport(transport: ChatTransport): boolean {
		return this.#transport === transport;
	}

	activateRoute(key: string, sessionId: string | null): RecoveryRoute {
		if (this.#route.key === key && this.#route.sessionId === sessionId) {
			return this.#route;
		}
		this.#route = {
			generation: this.#route.generation + 1,
			key,
			sessionId,
		};
		return this.#route;
	}

	mountRoot(onActiveSessionRetired: (sessionId: string) => void): () => void {
		this.#rootRetirementHandlers.add(onActiveSessionRetired);
		this.#ensureSubscribed();
		return () => {
			this.#rootRetirementHandlers.delete(onActiveSessionRetired);
			this.#stopIfUnused();
		};
	}

	registerController(controller: RecoveryController): () => void {
		this.#controllers.set(controller.generation, controller);
		this.#ensureSubscribed();
		for (const resolveController of this.#controllerWaiters.get(controller.generation) ?? []) {
			resolveController(controller);
		}
		this.#controllerWaiters.delete(controller.generation);
		return () => {
			if (this.#controllers.get(controller.generation) === controller) {
				this.#controllers.delete(controller.generation);
			}
			this.#stopIfUnused();
		};
	}

	subscribeRetirements(listener: (sessionId: string) => void): () => void {
		this.#retirementListeners.add(listener);
		return () => {
			this.#retirementListeners.delete(listener);
		};
	}

	async handleInvalidation(invalidation: ChatSessionInvalidation): Promise<void> {
		if (invalidation.reason === "session_retired") {
			this.#concludeRetirement(invalidation.sessionId);
			return;
		}

		const startingRoute = this.#route;
		if (startingRoute.sessionId !== invalidation.sessionId) {
			try {
				await this.#transport.getSession(invalidation.sessionId);
			} catch (error) {
				if (this.handleSessionMiss(invalidation.sessionId, error)) {
					return;
				}
				const currentRoute = this.#route;
				if (currentRoute.sessionId !== invalidation.sessionId) {
					throw error;
				}
				await this.#rebuildActiveRoute(invalidation.sessionId, currentRoute, error);
				return;
			}
			const currentRoute = this.#route;
			if (currentRoute.sessionId === invalidation.sessionId) {
				await this.#rebuildActiveRoute(invalidation.sessionId, currentRoute);
			}
			return;
		}

		await this.#rebuildActiveRoute(invalidation.sessionId, startingRoute);
	}

	recordSessionRetired(sessionId: string): void {
		this.#concludeRetirement(sessionId);
	}

	handleSessionMiss(sessionId: string, error: unknown): boolean {
		if (!isChatSessionNotFoundError(error)) {
			return false;
		}
		this.#concludeRetirement(sessionId);
		return true;
	}

	shutdown(): void {
		this.#unsubscribeInvalidations?.();
		this.#unsubscribeInvalidations = undefined;
		for (const waiters of this.#controllerWaiters.values()) {
			for (const resolveController of waiters) {
				resolveController();
			}
		}
		this.#controllerWaiters.clear();
	}

	async #rebuildActiveRoute(
		sessionId: string,
		startingRoute: RecoveryRoute,
		startingError?: unknown,
	): Promise<void> {
		let route = startingRoute;
		let failure: unknown = startingError ?? new Error("Chat Session refresh was superseded.");
		const attemptedGenerations = new Set<number>();

		for (let attempt = 0; attempt < maxRecoveryRouteAttempts; attempt += 1) {
			if (route.sessionId !== sessionId) {
				return;
			}
			if (attemptedGenerations.has(route.generation)) {
				throw failure;
			}
			attemptedGenerations.add(route.generation);

			let controller = this.#controllers.get(route.generation);
			if (controller === undefined) {
				controller = await this.#waitForController(route.generation);
				const currentRoute = this.#route;
				if (currentRoute.sessionId !== sessionId) {
					return;
				}
				if (currentRoute.generation !== route.generation) {
					route = currentRoute;
					continue;
				}
			}
			try {
				let rebuilt: boolean;
				if (controller?.sessionId === sessionId) {
					rebuilt = await controller.refresh();
				} else {
					rebuilt = await this.#fetchAuthoritativeSession(sessionId);
					const routeAfterFetch = this.#route;
					if (routeAfterFetch.sessionId !== sessionId) {
						return;
					}
					if (routeAfterFetch.generation !== route.generation) {
						route = routeAfterFetch;
						continue;
					}
					const lateController = this.#controllers.get(route.generation);
					if (lateController?.sessionId === sessionId) {
						rebuilt = await lateController.refresh();
					}
				}
				const currentRoute = this.#route;
				if (currentRoute.sessionId !== sessionId) {
					return;
				}
				if (currentRoute.generation !== route.generation) {
					route = currentRoute;
					if (!rebuilt) {
						failure = new Error("Chat Session refresh was superseded.");
					}
					continue;
				}
				if (rebuilt) {
					return;
				}
				throw new Error("Chat Session refresh was superseded.");
			} catch (error) {
				if (this.handleSessionMiss(sessionId, error)) {
					return;
				}
				failure = error;
			}

			const currentRoute = this.#route;
			if (currentRoute.sessionId !== sessionId) {
				return;
			}
			if (currentRoute.generation === route.generation) {
				throw failure;
			}
			route = currentRoute;
		}
		throw failure;
	}

	async #fetchAuthoritativeSession(sessionId: string): Promise<boolean> {
		await this.#transport.getSession(sessionId);
		return true;
	}

	#concludeRetirement(sessionId: string): void {
		const nowMs = this.now();
		const createdRendererTombstone = recordRendererSessionRetirement(sessionId, nowMs);
		const existing = this.#concludedRetirements.get(sessionId);
		if (
			!createdRendererTombstone &&
			existing !== undefined &&
			existing.value.status === "concluded"
		) {
			return;
		}
		const conclusion = createdRendererTombstone
			? this.#concludedRetirements.remember(
					sessionId,
					{ status: "processing" },
					{
						refreshExisting: true,
						retiredAtMs: nowMs,
					},
				).entry
			: (existing ??
				this.#concludedRetirements.remember(
					sessionId,
					{ status: "processing" },
					{ retiredAtMs: nowMs },
				).entry);
		this.#transport.retireSession?.(sessionId);
		conclusion.value.status = "concluded";
		for (const listener of [...this.#retirementListeners]) {
			try {
				listener(sessionId);
			} catch (error) {
				console.error("Chat Session retirement listener failed.", error);
			}
		}
		if (this.#route.sessionId !== sessionId) {
			return;
		}
		const controller = this.#controllers.get(this.#route.generation);
		if (controller?.sessionId === sessionId) {
			try {
				controller.retire();
				return;
			} catch (error) {
				console.error("Chat Session controller retirement failed.", error);
			}
		}
		for (const onActiveSessionRetired of this.#rootRetirementHandlers) {
			try {
				onActiveSessionRetired(sessionId);
			} catch (error) {
				console.error("Chat Session retirement navigation failed.", error);
			}
		}
	}

	#ensureSubscribed(): void {
		if (this.#unsubscribeInvalidations !== undefined) {
			return;
		}
		this.#unsubscribeInvalidations = this.#transport.subscribeSessionInvalidations?.(
			(invalidation) => this.handleInvalidation(invalidation),
			{ authoritative: true },
		);
	}

	#stopIfUnused(): void {
		if (this.#controllers.size > 0 || this.#rootRetirementHandlers.size > 0) {
			return;
		}
		this.#unsubscribeInvalidations?.();
		this.#unsubscribeInvalidations = undefined;
	}

	#waitForController(generation: number): Promise<RecoveryController | undefined> {
		const existing = this.#controllers.get(generation);
		if (existing !== undefined) {
			return Promise.resolve(existing);
		}
		return new Promise((resolveController) => {
			let settled = false;
			const settle = (controller?: RecoveryController) => {
				if (settled) {
					return;
				}
				settled = true;
				clearTimeout(timer);
				const waiters = this.#controllerWaiters.get(generation);
				waiters?.delete(settle);
				if (waiters?.size === 0) {
					this.#controllerWaiters.delete(generation);
				}
				resolveController(controller);
			};
			const timer = setTimeout(() => settle(), controllerRegistrationWaitMs);
			const waiters = this.#controllerWaiters.get(generation) ?? new Set();
			waiters.add(settle);
			this.#controllerWaiters.set(generation, waiters);
		});
	}
}

export function ChatSessionRecoveryRoot({
	activeSessionId,
	children,
	onActiveSessionRetired,
	routeKey,
	transport,
}: {
	activeSessionId: string | null;
	children: ReactNode;
	onActiveSessionRetired(sessionId: string): void;
	routeKey: string;
	transport: ChatTransport;
}) {
	const coordinator = getChatSessionRecoveryCoordinator(transport);
	const route = coordinator.activateRoute(routeKey, activeSessionId);
	const retirementHandlerRef = useRef(onActiveSessionRetired);
	retirementHandlerRef.current = onActiveSessionRetired;

	useLayoutEffect(() => {
		const unmount = coordinator.mountRoot((sessionId) => retirementHandlerRef.current(sessionId));
		const shutdown = () => coordinator.shutdown();
		window.addEventListener("beforeunload", shutdown);
		return () => {
			window.removeEventListener("beforeunload", shutdown);
			unmount();
		};
	}, [coordinator]);

	return (
		<RecoveryContext.Provider value={{ coordinator, route }}>{children}</RecoveryContext.Provider>
	);
}

export function useChatSessionRecovery(
	transport: ChatTransport,
	sessionId: string | undefined,
): RecoveryContextValue {
	const context = useContext(RecoveryContext);
	if (context?.coordinator.usesTransport(transport)) {
		return context;
	}
	const coordinator = getChatSessionRecoveryCoordinator(transport);
	return {
		coordinator,
		route: coordinator.activateRoute(`standalone:${sessionId ?? "none"}`, sessionId ?? null),
	};
}

export function getChatSessionRecoveryCoordinator(
	transport: ChatTransport,
): ChatSessionRecoveryCoordinator {
	const existing = coordinators.get(transport);
	if (existing !== undefined) {
		return existing;
	}
	const coordinator = new ChatSessionRecoveryCoordinator(transport);
	coordinators.set(transport, coordinator);
	return coordinator;
}

function recordRendererSessionRetirement(sessionId: string, nowMs: number): boolean {
	const retained = readRendererRetiredSessions(nowMs);
	if (retained.some((entry) => entry.sessionId === sessionId)) {
		purgeRendererSessionCaches(sessionId);
		return false;
	}
	if (retained.length >= maxRetainedSessionRetirements) {
		throw new SessionRetirementCapacityError();
	}
	retained.unshift({ sessionId, retiredAtMs: nowMs });
	let stored = false;
	try {
		sessionStorage.setItem(retiredChatSessionsStorageKey, JSON.stringify(retained));
		stored = true;
	} catch {}
	purgeRendererSessionCaches(sessionId);
	return stored;
}

export function isRendererSessionRetired(sessionId: string, nowMs = Date.now()): boolean {
	return readRendererRetiredSessions(nowMs).some((entry) => entry.sessionId === sessionId);
}

function readRendererRetiredSessions(nowMs: number): RendererRetiredSession[] {
	let raw: string | null;
	try {
		raw = sessionStorage.getItem(retiredChatSessionsStorageKey);
	} catch {
		return [];
	}
	if (raw === null) {
		return [];
	}
	try {
		const parsed: unknown = JSON.parse(raw);
		if (!Array.isArray(parsed)) {
			return [];
		}
		const unique = new Set<string>();
		return parsed
			.flatMap((entry): RendererRetiredSession[] => {
				if (
					typeof entry !== "object" ||
					entry === null ||
					typeof Reflect.get(entry, "sessionId") !== "string" ||
					!Number.isSafeInteger(Reflect.get(entry, "retiredAtMs"))
				) {
					return [];
				}
				const sessionId = Reflect.get(entry, "sessionId") as string;
				const retiredAtMs = Reflect.get(entry, "retiredAtMs") as number;
				if (
					sessionId.length === 0 ||
					retiredAtMs > nowMs ||
					retiredAtMs <= nowMs - retiredSessionTombstoneTtlMs ||
					unique.has(sessionId)
				) {
					return [];
				}
				unique.add(sessionId);
				return [{ sessionId, retiredAtMs }];
			})
			.sort((left, right) => right.retiredAtMs - left.retiredAtMs)
			.slice(0, maxRetainedSessionRetirements);
	} catch {
		return [];
	}
}

function purgeRendererSessionCaches(sessionId: string): void {
	try {
		if (localStorage.getItem(lastChatSessionStorageKey) === sessionId) {
			localStorage.removeItem(lastChatSessionStorageKey);
		}
	} catch {}
	try {
		const currentState: unknown = window.history.state;
		const nextState = removeHydratedSessionFromHistoryState(currentState, sessionId);
		if (nextState !== currentState) {
			window.history.replaceState(nextState, "");
		}
	} catch {}
}

function removeHydratedSessionFromHistoryState(state: unknown, sessionId: string): unknown {
	if (typeof state !== "object" || state === null || Array.isArray(state)) {
		return state;
	}
	let changed = false;
	const next = { ...state } as Record<string, unknown>;
	const hydratedSession = next.hydratedSession;
	if (
		typeof hydratedSession === "object" &&
		hydratedSession !== null &&
		Reflect.get(hydratedSession, "id") === sessionId
	) {
		delete next.hydratedSession;
		changed = true;
	}
	const userState = next.usr;
	const nextUserState = removeHydratedSessionFromHistoryState(userState, sessionId);
	if (nextUserState !== userState) {
		next.usr = nextUserState;
		changed = true;
	}
	return changed ? next : state;
}
