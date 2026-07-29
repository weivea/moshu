const runtimeBaseUrl = process.env.MOSHU_LIVE_RUNTIME_BASE_URL?.trim();
if (runtimeBaseUrl === undefined || runtimeBaseUrl.length === 0) {
	throw new Error("MOSHU_LIVE_RUNTIME_BASE_URL is required for the live Dev Tunnel probe.");
}

const base = new URL(runtimeBaseUrl);
if (base.protocol !== "https:" || !base.hostname.endsWith(".devtunnels.ms")) {
	throw new Error("Live Runtime ingress must use HTTPS on devtunnels.ms.");
}

const request = async (pathname: string, init?: RequestInit): Promise<Response> =>
	fetch(new URL(pathname, base), {
		redirect: "manual",
		signal: AbortSignal.timeout(15_000),
		...init,
	});

const productRpc = await request("/rpc");
if (productRpc.status !== 404) {
	throw new Error(`Dev Tunnel exposed unexpected Product RPC status ${productRpc.status}.`);
}

const invalidChallenge = await request("/runtime-auth/challenge", {
	method: "POST",
	headers: { "content-type": "application/json" },
	body: JSON.stringify({
		runtimeBoxId: "live-probe-invalid",
		deviceKeyId: "live-probe-invalid",
		instanceId: crypto.randomUUID(),
		generation: 1,
		protocolVersion: 1,
	}),
});
if (invalidChallenge.status === 200) {
	runtimeBoxChallengeOutputSchema.parse(await invalidChallenge.json());
} else if (invalidChallenge.status !== 429) {
	throw new Error(
		`Runtime challenge did not preserve anti-enumeration behavior: ${invalidChallenge.status}.`,
	);
}

const incompatibleChallenge = await request("/runtime-auth/challenge", {
	method: "POST",
	headers: { "content-type": "application/json" },
	body: JSON.stringify({
		runtimeBoxId: "live-probe-invalid",
		deviceKeyId: "live-probe-invalid",
		instanceId: crypto.randomUUID(),
		generation: 1,
		protocolVersion: 65_535,
	}),
});
if (incompatibleChallenge.status !== 426) {
	throw new Error(
		`Runtime protocol incompatibility did not return upgrade-required: ${incompatibleChallenge.status}.`,
	);
}

const invalidPairingClaim = await request("/runtime-pair/claim", {
	method: "POST",
	headers: { "content-type": "application/json" },
	body: JSON.stringify({
		code: "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
		deviceKeyId: "live-probe-invalid",
		publicKey: "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
		displayName: "Live probe invalid device",
		platform: "linux",
		arch: "x64",
	}),
});
if (invalidPairingClaim.status !== 400 && invalidPairingClaim.status !== 429) {
	throw new Error(
		`Unknown pairing code did not fail closed through the Tunnel: ${invalidPairingClaim.status}.`,
	);
}

const unknownRoute = await request("/runtime-probe-unknown");
if (unknownRoute.status !== 404) {
	throw new Error(`Unknown Runtime ingress route returned ${unknownRoute.status}.`);
}

console.log(
	JSON.stringify({
		ok: true,
		origin: base.origin,
		productRpcStatus: productRpc.status,
		invalidChallengeStatus: invalidChallenge.status,
		incompatibleChallengeStatus: incompatibleChallenge.status,
		invalidPairingClaimStatus: invalidPairingClaim.status,
		unknownRouteStatus: unknownRoute.status,
	}),
);
import { runtimeBoxChallengeOutputSchema } from "@moshu/contracts";
