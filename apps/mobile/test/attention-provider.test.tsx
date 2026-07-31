import type {
	AckMobileAttentionOutput,
	ListMobileAttentionOutput,
	ListRuntimeBoxesOutput,
} from "@moshu/contracts";
import { act, render, screen, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import { MemoryRouter, useLocation } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { App } from "../src/app/app";
import { AppearanceProvider } from "../src/app/appearance";
import { AttentionProvider } from "../src/app/attention";
import { ConnectionProvider } from "../src/app/connection";
import { I18nProvider } from "../src/app/i18n";
import type { AppLifecycle, AppLifecycleObserver } from "../src/native/lifecycle";
import type {
	LocalNotificationRequest,
	LocalNotificationScheduler,
	NotificationPermissionState,
	NotificationRoute,
} from "../src/native/notifications";
import type { ConnectionController, ConnectionState } from "../src/rpc/connection-controller";
import { MobileEventBus } from "../src/rpc/events";
import type { MobileProductClient } from "../src/rpc/product-client";
import { makeSessionPage } from "./helpers";

// ---------------------------------------------------------------------------
// Production-root integration tests for the notification-tap wiring (#1) and the surviving-socket
// foreground resnapshot (#2). These render the EXACT provider composition from `main.tsx` (Appearance
// → I18n → Router → Connection → Attention → App) so we exercise the real router-backed navigation the
// AttentionProvider installs by default — NOT injected callbacks. Only the native seams (connection
// controller, app lifecycle, notification scheduler) are faked. The real ConnectionController's
// foreground re-emit is proven separately in connection-controller.test.ts; here the fake controller
// mirrors that contract so we can drive deterministic transitions.
// ---------------------------------------------------------------------------

function boxes(): ListRuntimeBoxesOutput {
	return {
		active: { runtimeBoxId: "box-1", revision: 1 },
		items: [
			{
				runtimeBox: {
					schemaVersion: 1,
					runtimeBoxId: "box-1",
					kind: "local",
					displayName: "Box 1",
					runtimeBoxVersion: "1.0.0",
					platform: "darwin",
					arch: "arm64",
					capabilities: [],
				},
				connected: true,
				registered: true,
				deviceKeyIds: [],
				state: "online",
				compatibility: "compatible",
			},
		],
	} as ListRuntimeBoxesOutput;
}

function attentionPage(): ListMobileAttentionOutput {
	return {
		schemaVersion: 1,
		items: [
			{
				schemaVersion: 1,
				eventId: "00000000-0000-7000-8000-0000000000a1",
				seq: 5,
				type: "approval_required",
				visibility: "mobile-clients",
				sessionId: "sess-1",
				approvalId: "ap-1",
				createdAt: "2025-01-01T00:00:00.000Z",
				titleKey: "attention.approvalRequired.title",
				bodyKey: "attention.approvalRequired.body",
			},
		],
		unreadCount: 1,
		ackSeq: 0,
		latestSeq: 5,
		resyncRequired: false,
	};
}

interface FakeClient {
	listAttention: ReturnType<typeof vi.fn>;
	ackAttention: ReturnType<typeof vi.fn>;
}

function makeFakeClient(): MobileProductClient & FakeClient {
	const client = {
		listRuntimeBoxes: vi.fn(async () => boxes()),
		listApprovals: vi.fn(async () => ({ items: [], policies: [] })),
		listSessions: vi.fn(async () => ({ items: [] })),
		listAvailableModels: vi.fn(async () => ({ models: [] })),
		getSessionPage: vi.fn(async () => makeSessionPage("sess-1")),
		chatSubscribe: vi.fn(async () => ({})),
		chatUnsubscribe: vi.fn(async () => ({})),
		chatReplay: vi.fn(async () => ({ events: [] })),
		listAttention: vi.fn(async () => attentionPage()),
		ackAttention: vi.fn(
			async (): Promise<AckMobileAttentionOutput> => ({
				schemaVersion: 1,
				ackSeq: 5,
				unreadCount: 0,
				latestSeq: 5,
			}),
		),
	};
	return client as unknown as MobileProductClient & FakeClient;
}

/** Records scheduled notifications and lets tests fire a tap with an opaque route. */
class FakeScheduler implements LocalNotificationScheduler {
	readonly scheduled: LocalNotificationRequest[] = [];
	readonly badges: number[] = [];
	#tap: ((route: NotificationRoute) => void) | null = null;

	async getPermission(): Promise<NotificationPermissionState> {
		return "granted";
	}
	async requestPermission(): Promise<NotificationPermissionState> {
		return "granted";
	}
	async schedule(request: LocalNotificationRequest): Promise<void> {
		this.scheduled.push(request);
	}
	async setBadge(count: number): Promise<void> {
		this.badges.push(count);
	}
	onTap(handler: (route: NotificationRoute) => void): () => void {
		this.#tap = handler;
		return () => {
			this.#tap = null;
		};
	}
	fireTap(route: NotificationRoute): void {
		this.#tap?.(route);
	}
	get hasTapListener(): boolean {
		return this.#tap !== null;
	}
}

/** Faithful, minimal fake of the connection state machine the providers drive. */
class FakeController {
	#state: ConnectionState;
	#backgrounded = false;
	readonly #listeners = new Set<(state: ConnectionState) => void>();

	constructor(initial: ConnectionState) {
		this.#state = initial;
	}

	getState(): ConnectionState {
		return this.#state;
	}
	subscribe(listener: (state: ConnectionState) => void): () => void {
		this.#listeners.add(listener);
		return () => {
			this.#listeners.delete(listener);
		};
	}
	#setState(state: ConnectionState): void {
		this.#state = state;
		for (const listener of [...this.#listeners]) {
			listener(state);
		}
	}
	async init(): Promise<void> {}
	onAppBackground(): void {
		this.#backgrounded = true;
	}
	async onAppActive(): Promise<void> {
		const wasBackgrounded = this.#backgrounded;
		this.#backgrounded = false;
		// Mirror ConnectionController: a surviving connected socket re-emits so subscribers resnapshot.
		if (this.#state.kind === "connected" && wasBackgrounded) {
			this.#setState({ ...this.#state });
		}
	}
}

class FakeLifecycle implements AppLifecycle {
	#observer: AppLifecycleObserver | null = null;
	subscribe(observer: AppLifecycleObserver): () => void {
		this.#observer = observer;
		return () => {
			this.#observer = null;
		};
	}
	fireBackground(): void {
		this.#observer?.onBackground();
	}
	fireActive(): void {
		this.#observer?.onActive();
	}
}

function LocationProbe() {
	const location = useLocation();
	return <span data-testid="path">{location.pathname}</span>;
}

function connectedState(client: MobileProductClient, bus: MobileEventBus): ConnectionState {
	return {
		kind: "connected",
		binding: {
			agentServerId: "22222222-2222-4222-8222-222222222222",
			mobileClientId: "mobile-client-01",
			deviceKeyId: "device-key-01",
			serverPublicKeyFingerprint: "SHA256:server-fp",
			devicePublicKeyFingerprint: "SHA256:device-fp",
			protocolVersion: 1,
			transportSecurity: "relay-tls",
			serverLabel: "Desktop",
		},
		client,
		bus,
	};
}

function renderApp(options: {
	controller: FakeController;
	lifecycle: FakeLifecycle;
	scheduler: FakeScheduler;
	initialPath?: string;
	children?: ReactNode;
}) {
	return render(
		<AppearanceProvider>
			<I18nProvider>
				<MemoryRouter initialEntries={[options.initialPath ?? "/chats"]}>
					<ConnectionProvider
						controller={options.controller as unknown as ConnectionController}
						lifecycle={options.lifecycle}
					>
						<AttentionProvider scheduler={options.scheduler}>
							<LocationProbe />
							<App />
						</AttentionProvider>
					</ConnectionProvider>
				</MemoryRouter>
			</I18nProvider>
		</AppearanceProvider>,
	);
}

let bus: MobileEventBus;

beforeEach(() => {
	bus = new MobileEventBus();
	vi.spyOn(document, "visibilityState", "get").mockReturnValue("visible");
});

afterEach(() => {
	vi.restoreAllMocks();
});

describe("AttentionProvider notification-tap production wiring (#1)", () => {
	it("navigates through the real router to the approval hub after a validated tap while connected", async () => {
		const client = makeFakeClient();
		const controller = new FakeController(connectedState(client, bus));
		const lifecycle = new FakeLifecycle();
		const scheduler = new FakeScheduler();

		renderApp({ controller, lifecycle, scheduler });

		// The single native tap listener is installed by the production provider (not an injected no-op).
		await waitFor(() => expect(scheduler.hasTapListener).toBe(true));
		await waitFor(() => expect(screen.getByTestId("path")).toHaveTextContent("/chats"));

		await act(async () => {
			scheduler.fireTap({ approvalId: "ap-1", attentionEventId: "att-1" });
			await Promise.resolve();
		});

		await waitFor(() => expect(screen.getByTestId("path")).toHaveTextContent("/activity"));
	});

	it("deep-links a session-scoped tap to that chat after readiness", async () => {
		const client = makeFakeClient();
		const controller = new FakeController(connectedState(client, bus));
		const lifecycle = new FakeLifecycle();
		const scheduler = new FakeScheduler();

		renderApp({ controller, lifecycle, scheduler });
		await waitFor(() => expect(scheduler.hasTapListener).toBe(true));

		await act(async () => {
			scheduler.fireTap({ sessionId: "sess-1", attentionEventId: "att-1" });
			await Promise.resolve();
		});

		await waitFor(() => expect(screen.getByTestId("path")).toHaveTextContent("/chats/sess-1"));
	});

	it("shows a safe state (never a deep link) when a tap lands while unpaired", async () => {
		const controller = new FakeController({ kind: "unpaired" });
		const lifecycle = new FakeLifecycle();
		const scheduler = new FakeScheduler();

		renderApp({ controller, lifecycle, scheduler, initialPath: "/chats" });
		await waitFor(() => expect(scheduler.hasTapListener).toBe(true));

		await act(async () => {
			scheduler.fireTap({ sessionId: "sess-1", attentionEventId: "att-1" });
			await Promise.resolve();
		});

		// The safe hub is selected and the stale opaque session id is NOT used to deep-link.
		await waitFor(() => expect(screen.getByTestId("path")).toHaveTextContent("/activity"));
		expect(screen.getByTestId("path")).not.toHaveTextContent("/chats/sess-1");
	});

	it("routes a Moshu-owned safe-activity tap (retention gap) to the Activity hub after readiness", async () => {
		const client = makeFakeClient();
		const controller = new FakeController(connectedState(client, bus));
		const lifecycle = new FakeLifecycle();
		const scheduler = new FakeScheduler();

		renderApp({ controller, lifecycle, scheduler, initialPath: "/chats" });
		await waitFor(() => expect(scheduler.hasTapListener).toBe(true));

		// A retention-gap / lookup-exhausted notification delivers the id-less safe-activity marker. The
		// tap must still be actionable (not silently dropped) and, after the session is authenticated and
		// re-snapshotted, land on the safe Activity hub without using any stale opaque id.
		await act(async () => {
			scheduler.fireTap({ safeActivity: true });
			await Promise.resolve();
		});

		await waitFor(() => expect(screen.getByTestId("path")).toHaveTextContent("/activity"));
		// A fresh snapshot was taken before navigating (never surface stale content on a gap tap).
		expect(client.listAttention).toHaveBeenCalled();
	});
});

describe("AttentionProvider surviving-socket foreground resnapshot (#2)", () => {
	it("refreshes attention on background→foreground while connected without replaying notifications", async () => {
		const client = makeFakeClient();
		const controller = new FakeController(connectedState(client, bus));
		const lifecycle = new FakeLifecycle();
		const scheduler = new FakeScheduler();

		renderApp({ controller, lifecycle, scheduler });

		// Initial connect takes exactly one recovery snapshot (badge only, no notification).
		await waitFor(() => expect(client.listAttention).toHaveBeenCalledTimes(1));
		const initialCalls = client.listAttention.mock.calls.length;

		// The socket survives the whole background window; returning to the foreground must resnapshot.
		await act(async () => {
			lifecycle.fireBackground();
			lifecycle.fireActive();
			await Promise.resolve();
		});

		await waitFor(() =>
			expect(client.listAttention.mock.calls.length).toBeGreaterThan(initialCalls),
		);
		// A foreground resnapshot is NON-notifying: the missed backlog is never replayed to the lock
		// screen as a historical local notification.
		expect(scheduler.scheduled).toHaveLength(0);
	});
});
