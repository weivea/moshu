import { describe, expect, test } from "bun:test";

import {
	type RuntimeDiagnosticsOutput,
	remoteAccessStatusOutputSchema,
	runtimeDiagnosticsOutputSchema,
} from "./runtime-box";

const diagnostics: RuntimeDiagnosticsOutput = {
	generatedAt: new Date().toISOString(),
	server: {
		version: "0.0.1",
		identity: {
			role: "agents" as const,
			peerId: "agents",
			instanceId: "agents-instance",
			generation: 1,
		},
		processRpcProtocol: { major: 1, minor: 0 },
		runtimeProtocolMinVersion: 5 as const,
		runtimeProtocolMaxVersion: 5 as const,
		transportSecurity: "relay-tls" as const,
		noiseUpgradeAvailable: false as const,
	},
	database: { schemaVersion: 18, integrity: "ok" as const },
	runtimeBoxes: [],
	inventories: [],
	remoteAccess: {
		enabled: false,
		authenticated: false,
		state: "disabled" as const,
		runtimeIngressPort: 41_000,
		trafficEstimate: {
			month: new Date().toISOString().slice(0, 7),
			receivedBytes: 0,
			sentBytes: 0,
			totalBytes: 0,
			monthlyLimitBytes: 5 * 1024 * 1024 * 1024,
			warningLevel: "none" as const,
			source: "runtime-rpc-application-payload-estimate" as const,
		},
		serviceLimits: {
			maxTunnelsPerUser: 10,
			maxPortsPerTunnel: 10,
			maxBytesPerSecond: 20 * 1024 * 1024,
		},
	},
};

describe("Runtime diagnostics contract", () => {
	test("accepts only the redacted support surface", () => {
		expect(runtimeDiagnosticsOutputSchema.parse(diagnostics)).toEqual(diagnostics);
		for (const forbiddenKey of [
			"secret",
			"credential",
			"privateKey",
			"mcpConfig",
			"skillBody",
			"filesystemLocator",
		]) {
			expect(() =>
				runtimeDiagnosticsOutputSchema.parse({
					...diagnostics,
					[forbiddenKey]: "must-not-leave-the-owner",
				}),
			).toThrow();
		}
	});
});

describe("Remote Access status contract (v1 wire compatibility)", () => {
	const v1Status = {
		enabled: false,
		authenticated: false,
		state: "disabled" as const,
		runtimeIngressPort: 41_000,
		trafficEstimate: {
			month: "2026-07",
			receivedBytes: 0,
			sentBytes: 0,
			totalBytes: 0,
			monthlyLimitBytes: 5 * 1024 * 1024 * 1024,
			warningLevel: "none" as const,
			source: "runtime-rpc-application-payload-estimate" as const,
		},
		serviceLimits: {
			maxTunnelsPerUser: 10 as const,
			maxPortsPerTunnel: 10 as const,
			maxBytesPerSecond: 20 * 1024 * 1024,
		},
	};

	test("accepts the existing v1 status shape without an ingress set", () => {
		expect(remoteAccessStatusOutputSchema.parse(v1Status)).toEqual(v1Status);
	});

	test("rejects a multi-ingress field on the strict v1 status schema", () => {
		// Layer 1 keeps ingress descriptors internal (DevTunnelService.getIngressReadiness). A future
		// Mobile ingress (Layer 3) must add multi-ingress readiness through an explicit versioned method,
		// never by widening this strict v1 schema, so old clients keep parsing status payloads.
		expect(() =>
			remoteAccessStatusOutputSchema.parse({
				...v1Status,
				ingresses: [{ kind: "runtime", port: 41_000, ready: false }],
			}),
		).toThrow();
	});
});
