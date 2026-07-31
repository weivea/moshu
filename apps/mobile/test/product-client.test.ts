import {
	mobileClientProductRequestMethods,
	productRpcEvents,
	productRpcMethods,
} from "@moshu/contracts";
import type { JsonValue, RpcPeer } from "@moshu/process-rpc-core";
import { describe, expect, it, vi } from "vitest";
import { MobileEventBus } from "../src/rpc/events";
import {
	buildMobileRpcHandlers,
	MobileProductClient,
	mobileInboundAllowlist,
} from "../src/rpc/product-client";

function fakePeer(request: (method: string, payload: JsonValue) => Promise<JsonValue>): RpcPeer {
	return {
		request: vi.fn(request),
		isClosed: false,
		close: vi.fn(),
	} as unknown as RpcPeer;
}

describe("MobileProductClient allowlist", () => {
	it("only exposes methods on the mobile allowlist and excludes Desktop-only ones", () => {
		const allowed = new Set<string>(mobileClientProductRequestMethods);
		for (const desktopOnly of [
			productRpcMethods.projectsCreate,
			productRpcMethods.projectsDelete,
			productRpcMethods.mcpList,
			productRpcMethods.skillsList,
			productRpcMethods.providersList,
		]) {
			expect(allowed.has(desktopOnly)).toBe(false);
		}
	});

	it("restricts inbound events to the agents peer's allowlisted product events", () => {
		expect(Object.keys(mobileInboundAllowlist)).toEqual(["agents"]);
		expect(mobileInboundAllowlist.agents?.events).toContain(productRpcEvents.chatEvent);
		expect(mobileInboundAllowlist.agents?.events).not.toContain("moshu.v1.providers.event");
	});

	it("sends the allowlisted wire method and Zod-validates the response", async () => {
		const active = { runtimeBoxId: "box-1", revision: 3 };
		const peer = fakePeer(async (method) => {
			expect(method).toBe(productRpcMethods.runtimeBoxesList);
			return { active, items: [] } as unknown as JsonValue;
		});
		const client = new MobileProductClient(peer);
		const output = await client.listRuntimeBoxes();
		expect(output.active).toEqual(active);
	});

	it("rejects a malformed server response", async () => {
		const peer = fakePeer(async () => ({ nope: true }) as unknown as JsonValue);
		const client = new MobileProductClient(peer);
		await expect(client.listRuntimeBoxes()).rejects.toThrow();
	});

	it("validates request input before hitting the peer", async () => {
		const request = vi.fn(async () => ({}) as JsonValue);
		const peer = fakePeer(request);
		const client = new MobileProductClient(peer);
		// expectedRevision must be a positive integer; 0 fails input validation.
		await expect(
			client.switchRuntimeBox({ runtimeBoxId: "box-1", expectedRevision: 0 }),
		).rejects.toThrow();
		expect(request).not.toHaveBeenCalled();
	});
});

describe("mobile event handlers", () => {
	it("routes and strictly validates allowlisted events onto the bus", () => {
		const bus = new MobileEventBus();
		const handlers = buildMobileRpcHandlers(bus);
		const received: unknown[] = [];
		bus.on("runtimeBoxesChanged", (payload) => received.push(payload));

		const valid = { active: { runtimeBoxId: "box-1", revision: 2 }, items: [] };
		handlers.events?.[productRpcEvents.runtimeBoxesChanged]?.(valid as unknown as JsonValue, {} as never);
		expect(received).toHaveLength(1);
	});

	it("throws on a malformed event payload (strict Zod)", () => {
		const bus = new MobileEventBus();
		const handlers = buildMobileRpcHandlers(bus);
		expect(() =>
			handlers.events?.[productRpcEvents.runtimeBoxesChanged]?.({ bad: 1 } as unknown as JsonValue, {} as never),
		).toThrow();
	});
});
