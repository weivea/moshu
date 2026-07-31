import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { productRpcMethods } from "@moshu/contracts";
import { openAppDatabase } from "@moshu/database";
import type { RpcHandlers, RpcPeer, RpcRequestContext } from "@moshu/process-rpc";
import {
	agentsServerMobileMethodAllowlist,
	createMobileIngressComposition,
	type MobileIngressCompositionDeps,
	mobileIngressCompositionRequestMethods,
} from "./mobile-ingress-composition";
import { MobileIngressGenerationFence } from "./mobile-ingress-generation-fence";

// The Mobile ingress composition is the single production wiring source shared by create-agents-server
// and the ingress smoke. These contract tests pin that guarantee: the composition owns exactly the
// declared ingress request methods, every owned method is on the strict Mobile allowlist AND present
// in the merged handler map, and — crucially — the ingress smoke drives every owned method. So a newly
// added ingress method that is not also exercised by the smoke fails here.

function stubAuthenticate(): never {
	throw new Error("authenticate should not run in the composition wiring contract test.");
}

function baseDeps(): MobileIngressCompositionDeps {
	const database = openAppDatabase(":memory:");
	return {
		serverIdentity: {
			role: "agents",
			peerId: "composition-test-agents",
			instanceId: "composition-test-agents-1",
			generation: 1,
		},
		authenticate: stubAuthenticate as unknown as MobileIngressCompositionDeps["authenticate"],
		handleHttpRequest: () => undefined,
		generationFence: new MobileIngressGenerationFence(database.mobileDevices),
		mobileAttention: database.mobileAttention,
		mobileAttentionOutbox: database.mobileAttentionOutbox,
	};
}

function mobilePeerContext(peerId: string): RpcRequestContext {
	return {
		peer: { remoteIdentity: { role: "mobile-client", peerId } } as unknown as RpcPeer,
		remoteIdentity: { role: "mobile-client", peerId },
	} as unknown as RpcRequestContext;
}

describe("Mobile ingress composition wiring contract", () => {
	test("owns exactly the declared ingress request methods, all allowlisted and wired", () => {
		const composition = createMobileIngressComposition(baseDeps());
		const owned = new Set<string>(mobileIngressCompositionRequestMethods);

		// The declared owned methods are the durable attention list/ack surface.
		expect([...owned].sort()).toEqual(
			[productRpcMethods.mobileAttentionList, productRpcMethods.mobileAttentionAck].sort(),
		);

		const allowlistedRequests = new Set(
			agentsServerMobileMethodAllowlist["mobile-client"]?.requests ?? [],
		);
		const mergedRequests = new Set(Object.keys(composition.handlers.requests ?? {}));
		for (const method of owned) {
			// Every owned method must be reachable (on the strict Mobile allowlist)...
			expect(allowlistedRequests.has(method)).toBe(true);
			// ...and actually wired into the merged handler map even with no base handlers supplied.
			expect(mergedRequests.has(method)).toBe(true);
		}
	});

	test("merges the durable attention handlers on top of an injected base handler map", () => {
		const base: RpcHandlers = {
			requests: { [productRpcMethods.runtimeGet]: () => ({ ok: true }) },
		};
		const composition = createMobileIngressComposition({ ...baseDeps(), baseHandlers: base });
		const keys = new Set(Object.keys(composition.handlers.requests ?? {}));
		// Base handlers are preserved and the owned attention handlers are added — never re-declared.
		expect(keys.has(productRpcMethods.runtimeGet)).toBe(true);
		for (const method of mobileIngressCompositionRequestMethods) {
			expect(keys.has(method)).toBe(true);
		}
	});

	test("attention handlers validate input and derive the peer identity from auth context", async () => {
		const composition = createMobileIngressComposition(baseDeps());
		const requests = composition.handlers.requests ?? {};
		const listHandler = requests[productRpcMethods.mobileAttentionList];
		const ackHandler = requests[productRpcMethods.mobileAttentionAck];
		expect(listHandler).toBeDefined();
		expect(ackHandler).toBeDefined();

		// A valid list request over an empty feed returns the desensitized empty snapshot.
		const listOutput = (await listHandler?.({}, mobilePeerContext("client-a"))) as {
			schemaVersion: number;
			unreadCount: number;
			latestSeq: number;
			resyncRequired: boolean;
		};
		expect(listOutput.schemaVersion).toBe(1);
		expect(listOutput.unreadCount).toBe(0);
		expect(listOutput.latestSeq).toBe(0);
		expect(listOutput.resyncRequired).toBe(false);

		// Invalid input is rejected before any repository work (INVALID_ARGUMENT).
		await expect(
			Promise.resolve().then(() => listHandler?.({ limit: 0 }, mobilePeerContext("client-a"))),
		).rejects.toThrow();

		// A monotonic ack is honored and echoes the clamped cursor.
		const ackOutput = (await ackHandler?.({ seq: 0 }, mobilePeerContext("client-a"))) as {
			schemaVersion: number;
			ackSeq: number;
		};
		expect(ackOutput.schemaVersion).toBe(1);
		expect(ackOutput.ackSeq).toBe(0);
	});

	test("revoke requires a revokeDeviceKey and otherwise fails loudly", () => {
		const composition = createMobileIngressComposition(baseDeps());
		expect(() =>
			composition.revoke({ mobileClientId: "client-a", deviceKeyId: "device-key-1" }),
		).toThrow(/revokeDeviceKey/);

		let revoked: string | undefined;
		const wired = createMobileIngressComposition({
			...baseDeps(),
			revokeDeviceKey: (input) => {
				revoked = input.mobileClientId;
				return { revoked: true };
			},
		});
		const output = wired.revoke({ mobileClientId: "client-b", deviceKeyId: "device-key-2" });
		expect(revoked).toBe("client-b");
		expect(output.revoked).toBe(true);
	});

	test("the ingress smoke drives every method the composition owns", () => {
		const smokeSource = readFileSync(join(import.meta.dir, "mobile-ingress-smoke.test.ts"), "utf8");
		const nameByValue = new Map(
			Object.entries(productRpcMethods).map(([name, value]) => [value, name]),
		);
		for (const method of mobileIngressCompositionRequestMethods) {
			const name = nameByValue.get(method);
			expect(name).toBeDefined();
			// The smoke must exercise each owned ingress method by name, so newly wired ingress methods
			// cannot silently escape end-to-end coverage.
			expect(smokeSource).toContain(`productRpcMethods.${name}`);
		}
	});
});
