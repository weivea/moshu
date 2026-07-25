export interface BeforeQuitEvent {
	response: {
		allow: boolean;
	};
}

export interface DesktopShutdownCoordinator {
	handleBeforeQuit(event: BeforeQuitEvent): void;
	handleWindowClose(): void;
	shutdown(): Promise<void>;
}

export interface DesktopShutdownCoordinatorOptions {
	cleanup(): Promise<void>;
	quit(): void;
	reportError(error: unknown): void;
	cleanupTimeoutMs?: number;
	timers?: {
		setTimer(callback: () => void, delayMs: number): ReturnType<typeof setTimeout>;
		clearTimer(handle: ReturnType<typeof setTimeout>): void;
	};
}

export const DEFAULT_DESKTOP_CLEANUP_TIMEOUT_MS = 20_000;

export function createDesktopShutdownCoordinator(
	options: DesktopShutdownCoordinatorOptions,
): DesktopShutdownCoordinator {
	const cleanupTimeoutMs = options.cleanupTimeoutMs ?? DEFAULT_DESKTOP_CLEANUP_TIMEOUT_MS;
	if (!Number.isFinite(cleanupTimeoutMs) || cleanupTimeoutMs <= 0) {
		throw new Error("Desktop cleanup timeout must be greater than zero.");
	}
	const timers = options.timers ?? {
		setTimer: (callback: () => void, delayMs: number) => setTimeout(callback, delayMs),
		clearTimer: (handle: ReturnType<typeof setTimeout>) => clearTimeout(handle),
	};
	let phase: "idle" | "cleaning" | "complete" = "idle";
	let shutdownPromise: Promise<void> | undefined;

	const shutdown = (): Promise<void> => {
		if (shutdownPromise !== undefined) {
			return shutdownPromise;
		}

		phase = "cleaning";
		shutdownPromise = (async () => {
			try {
				await withCleanupTimeout(options.cleanup(), cleanupTimeoutMs, timers);
			} catch (error) {
				options.reportError(error);
			} finally {
				phase = "complete";
				options.quit();
			}
		})();
		return shutdownPromise;
	};

	const requestShutdown = (): void => {
		void shutdown().catch(options.reportError);
	};

	return {
		handleBeforeQuit(event) {
			if (phase === "complete") {
				event.response = { allow: true };
				return;
			}

			event.response = { allow: false };
			requestShutdown();
		},
		handleWindowClose() {
			requestShutdown();
		},
		shutdown,
	};
}

function withCleanupTimeout(
	cleanup: Promise<void>,
	timeoutMs: number,
	timers: NonNullable<DesktopShutdownCoordinatorOptions["timers"]>,
): Promise<void> {
	return new Promise((resolve, reject) => {
		const timer = timers.setTimer(() => {
			reject(new Error(`Desktop cleanup did not complete within ${timeoutMs}ms.`));
		}, timeoutMs);
		void cleanup.then(
			() => {
				timers.clearTimer(timer);
				resolve();
			},
			(error: unknown) => {
				timers.clearTimer(timer);
				reject(error);
			},
		);
	});
}
