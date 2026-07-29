import { eq } from "drizzle-orm";

import type { AppDrizzleDatabase } from "./database";
import { remoteAccessSettingsTable } from "./schema";

export interface RemoteAccessSettings {
	enabled: boolean;
	tunnelId?: string;
	publicUrl?: string;
	runtimeIngressPort?: number;
}

export interface RemoteAccessRepository {
	get(): RemoteAccessSettings;
	setRuntimeIngressPort(port: number): void;
	replaceRuntimeIngressPort(port: number): void;
	setEnabled(enabled: boolean): void;
	setTunnel(tunnelId: string, publicUrl?: string): void;
	setPublicUrl(publicUrl: string): void;
	clearTunnel(): void;
}

export class SqliteRemoteAccessRepository implements RemoteAccessRepository {
	constructor(
		private readonly orm: AppDrizzleDatabase,
		private readonly now: () => number = Date.now,
	) {
		if (this.orm.select().from(remoteAccessSettingsTable).get() === undefined) {
			this.orm
				.insert(remoteAccessSettingsTable)
				.values({ id: 1, enabled: false, updatedAtMs: this.now() })
				.run();
		}
	}

	get(): RemoteAccessSettings {
		const row = this.orm.select().from(remoteAccessSettingsTable).get();
		if (row === undefined) {
			throw new Error("Remote access settings are not initialized.");
		}
		return {
			enabled: row.enabled,
			...(row.tunnelId === null ? {} : { tunnelId: row.tunnelId }),
			...(row.publicUrl === null ? {} : { publicUrl: row.publicUrl }),
			...(row.runtimeIngressPort === null ? {} : { runtimeIngressPort: row.runtimeIngressPort }),
		};
	}

	setRuntimeIngressPort(port: number): void {
		if (!Number.isSafeInteger(port) || port < 1 || port > 65_535) {
			throw new TypeError("Runtime ingress port must be between 1 and 65535.");
		}
		const current = this.get().runtimeIngressPort;
		if (current !== undefined && current !== port) {
			throw new Error(`Runtime ingress port conflict: expected ${current}, bound ${port}.`);
		}
		this.#update({ runtimeIngressPort: port });
	}

	replaceRuntimeIngressPort(port: number): void {
		if (!Number.isSafeInteger(port) || port < 1 || port > 65_535) {
			throw new TypeError("Runtime ingress port must be between 1 and 65535.");
		}
		this.#update({ runtimeIngressPort: port });
	}

	setEnabled(enabled: boolean): void {
		this.#update({ enabled });
	}

	setTunnel(tunnelId: string, publicUrl?: string): void {
		if (!/^[A-Za-z0-9-]{3,60}(?:\.[A-Za-z0-9-]{2,32})?$/.test(tunnelId)) {
			throw new TypeError("Dev Tunnel ID has an invalid shape.");
		}
		this.#update({
			tunnelId,
			...(publicUrl === undefined ? {} : { publicUrl }),
		});
	}

	setPublicUrl(publicUrl: string): void {
		const url = new URL(publicUrl);
		if (url.protocol !== "https:" || !url.hostname.endsWith(".devtunnels.ms")) {
			throw new TypeError("Dev Tunnel public URL must use HTTPS on devtunnels.ms.");
		}
		this.#update({ publicUrl: url.toString().replace(/\/$/, "") });
	}

	clearTunnel(): void {
		this.orm
			.update(remoteAccessSettingsTable)
			.set({
				tunnelId: null,
				publicUrl: null,
				updatedAtMs: this.now(),
			})
			.where(eq(remoteAccessSettingsTable.id, 1))
			.run();
	}

	#update(values: Partial<typeof remoteAccessSettingsTable.$inferInsert>): void {
		this.orm
			.update(remoteAccessSettingsTable)
			.set({ ...values, updatedAtMs: this.now() })
			.where(eq(remoteAccessSettingsTable.id, 1))
			.run();
	}
}
