import { eq } from "drizzle-orm";

import type { AppDrizzleDatabase } from "./database";
import { remoteAccessSettingsTable } from "./schema";

export interface RemoteAccessSettings {
	enabled: boolean;
	tunnelId?: string;
	publicUrl?: string;
	runtimeIngressPort?: number;
	trafficMonth: string;
	trafficReceivedBytes: number;
	trafficSentBytes: number;
}

export interface RemoteAccessRepository {
	get(): RemoteAccessSettings;
	setRuntimeIngressPort(port: number): void;
	replaceRuntimeIngressPort(port: number): void;
	setEnabled(enabled: boolean): void;
	setTunnel(tunnelId: string, publicUrl?: string): void;
	setPublicUrl(publicUrl: string): void;
	clearTunnel(): void;
	recordTraffic(month: string, receivedBytes: number, sentBytes: number): void;
}

export class SqliteRemoteAccessRepository implements RemoteAccessRepository {
	constructor(
		private readonly orm: AppDrizzleDatabase,
		private readonly now: () => number = Date.now,
	) {
		if (this.orm.select().from(remoteAccessSettingsTable).get() === undefined) {
			this.orm
				.insert(remoteAccessSettingsTable)
				.values({
					id: 1,
					enabled: false,
					trafficMonth: currentUtcMonth(this.now()),
					trafficReceivedBytes: 0,
					trafficSentBytes: 0,
					updatedAtMs: this.now(),
				})
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
			trafficMonth: row.trafficMonth,
			trafficReceivedBytes: row.trafficReceivedBytes,
			trafficSentBytes: row.trafficSentBytes,
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

	recordTraffic(month: string, receivedBytes: number, sentBytes: number): void {
		if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(month)) {
			throw new TypeError("Remote Access traffic month must use YYYY-MM.");
		}
		if (
			!Number.isSafeInteger(receivedBytes) ||
			receivedBytes < 0 ||
			!Number.isSafeInteger(sentBytes) ||
			sentBytes < 0
		) {
			throw new TypeError("Remote Access traffic bytes must be nonnegative safe integers.");
		}
		if (receivedBytes === 0 && sentBytes === 0) {
			return;
		}
		this.orm.transaction((transaction) => {
			const row = transaction.select().from(remoteAccessSettingsTable).get();
			if (row === undefined) {
				throw new Error("Remote access settings are not initialized.");
			}
			const now = this.now();
			if (row.trafficMonth > month) {
				return;
			}
			const nextReceived =
				(row.trafficMonth === month ? row.trafficReceivedBytes : 0) + receivedBytes;
			const nextSent = (row.trafficMonth === month ? row.trafficSentBytes : 0) + sentBytes;
			if (!Number.isSafeInteger(nextReceived) || !Number.isSafeInteger(nextSent)) {
				throw new Error("Remote Access traffic counter overflow.");
			}
			transaction
				.update(remoteAccessSettingsTable)
				.set({
					trafficMonth: month,
					trafficReceivedBytes: nextReceived,
					trafficSentBytes: nextSent,
					updatedAtMs: now,
				})
				.where(eq(remoteAccessSettingsTable.id, 1))
				.run();
		});
	}

	#update(values: Partial<typeof remoteAccessSettingsTable.$inferInsert>): void {
		this.orm
			.update(remoteAccessSettingsTable)
			.set({ ...values, updatedAtMs: this.now() })
			.where(eq(remoteAccessSettingsTable.id, 1))
			.run();
	}
}

function currentUtcMonth(nowMs: number): string {
	return new Date(nowMs).toISOString().slice(0, 7);
}
