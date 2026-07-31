# @moshu/mobile — iOS Mobile App (Mobile stack Layer 4)

A real, buildable iPhone App: a Capacitor Web UI (React + Vite + TypeScript strict +
HeroUI + React Router HashRouter) bundled with the app, plus a native Swift secure
transport plugin (`MoshuMobileTransport`). Web assets ship inside the app
(`base: "./"`, `webDir: "dist"`, no `server.url`); the Agent Server only carries data.

This layer depends on the Layer 3 Mobile ingress / pairing / device auth
(`packages/contracts/src/mobile.ts`, `apps/agents-server`). It implements the iOS
**client** side of those contracts and adds no new server contracts.

## Scripts

| Script | Purpose |
| --- | --- |
| `bun run dev` | Vite dev server (browser preview of the Web UI) |
| `bun run build` | Vite production build to `dist/` |
| `bun run test` | Vitest (jsdom + Testing Library) |
| `bun run typecheck` | `tsc --noEmit` (app + node config projects) |
| `bun run cap:sync` | `cap sync ios` — copy `dist/` into the iOS project |
| `bun run cap:open` | Open the iOS project in Xcode |
| `bun run gen:vectors` | Regenerate shared canonical test vectors from TS contracts |

## Layout

```text
src/
  app/          mobile shell, connection lifecycle, appearance, i18n, keyboard
  components/   layout, tab bar, approval card
  screens/      Chats, Projects, Activity, Settings, connection/onboarding
  rpc/          browser-safe process-rpc handshake, product client, reducers,
                connection controller (fatalCodeMap), native transport adapter
  native/       Capacitor plugin JS surface (transport-plugin.ts)
native/MoshuMobile/   pure-Swift `MoshuMobileCore` SPM package + XCTest + fixtures
ios/App/              Capacitor 8 iOS project (SPM mode); App/plugins/*.swift
scripts/gen-canonical-vectors.ts   shared TS↔Swift byte-parity fixture generator
```

## Native transport (`MoshuMobileTransport`)

- **Software** CryptoKit `Curve25519.Signing` (Ed25519) device key. The private key
  never touches JS. It is stored in the Keychain with
  `kSecAttrAccessibleWhenUnlockedThisDeviceOnly` and is **not** synced to iCloud, and
  never written to UserDefaults/localStorage. This is a software key, **not** a
  Secure Enclave key.
- **Single Server binding**: exact mobile URL, agentServerId, server public
  key/fingerprint, mobileClientId/deviceKeyId/protocol. A second bind is rejected;
  only an explicit `unpair` clears the Keychain binding + private key and closes the
  socket.
- **Pairing**: parse/verify the versioned QR (URL/expiry/protocol/server identity),
  `URLSession` POST claim, sign + poll status, and on approval verify the Agent
  Server public key against the QR fingerprint before atomically persisting the
  binding. Codes/claim tokens/keys are never logged.
- **Reconnect**: persistent monotonic generation, a fresh instanceId per connection;
  request a challenge, verify the Agent Server's app-layer Ed25519 signature against
  the pinned server key, then device-sign the canonical upgrade payload and connect
  the WSS via `URLSessionWebSocketTask` with `x-moshu-*` headers. TLS trusts only the
  system trust chain (relay TLS is visible; the relay cert is never mis-pinned).
- Frames are delivered per connectionId + monotonic sequence; frame/queue sizes are
  bounded, binary frames are rejected, and stale connections are dropped.

## Security boundaries

- Private keys / long-lived tokens never live in JS; long-lived credentials go in
  headers/signatures, never in a query string.
- No remote-loaded UI (`base: "./"`, no `server.url`). No broad ATS exception, no
  Local Network/Bonjour. Info.plist requests only camera use (QR).
- Business data (Session/Project/message/approval) lives only in React memory — never
  localStorage/Preferences/Keychain. Only appearance/language may persist; the binding
  lives only in the native Keychain. On disconnect the app clears business state and
  shows offline/reconnect (no cache, no offline queue, no silent fake "connected").
- Raw shell commands are never shown or persisted in approvals — the card shows a
  fixed `shell [arguments hidden]`.

## Canonical test vectors

`scripts/gen-canonical-vectors.ts` derives a shared fixture from the TS contracts
(`createMobileServerChallengePayload` / `createMobileAuthenticationPayload`). Both the
Swift `MoshuMobileCore` XCTest suite and the Web `canonical-vectors` test consume it to
prove Swift/TS canonical payloads are byte-for-byte identical. Note CryptoKit Ed25519
signatures are randomized (not RFC 8032 deterministic), so the vectors assert
cross-implementation **verification**, not signature byte-equality.

## Correctness hardening (PR #8 review pass)

A post-implementation review tightened seven correctness/robustness edges; all are
covered by tests:

- **Hello identity** — the native `connect()` result and the JS hello now carry
  `deviceKeyId`, so the process-rpc hello exact-matches the Layer 3 authenticated
  canonical identity (server rejects otherwise).
- **Fatal-auth close mapping** — the receive loop classifies close signals from the WS
  close code / HTTP upgrade status only (never a localized string):
  `1008 → AUTH_REVOKED`, `401/403 → AUTH_FAILED`, `426 → PROTOCOL_MISMATCH`. The
  controller stops blind reconnecting on a fatal reason, clears business state, and
  prompts to re-authorize / unpair.
- **No provisional-connection leak** — every failed/aborted connect disposes the
  `NativeRpcConnection` (removing plugin listeners, closing the native socket). The
  pre-bind frame buffer is bounded by count and bytes and fails closed on overflow.
- **Keychain generation atomicity** — `SecretStore.set` updates in place
  (`SecItemUpdate`, `SecItemAdd` only when absent) instead of delete-then-add, and the
  generation read→increment→persist is serialized so concurrent callers get distinct,
  monotonic values and a failed write never regresses the old value.
- **Inbound WS limits** — oversized (enforced on UTF-8 byte count) and binary frames are
  protocol-closed before bridging, pre- and post-handshake.
- **Session history pagination** — the chat controller drains `getSessionPage` via
  `nextCursor` to the last page (which holds the active run), bounded by page/byte caps
  and failing closed on a non-advancing cursor.
- **Ambiguous-send idempotency** — the chat controller owns the `requestId` reservation:
  a retry of the same draft reuses it (server dedupes to one run); a definitive rejection
  or a content edit mints a new id.

A follow-up review pass tightened two transport edges (also fully tested):

- **Frame limit alignment** — the native inbound guard, outbound queue and JS pre-bind
  buffer all use the Product-RPC per-frame cap (`productRpcMaxFrameBytes` = 4 MiB, was a
  stale 1 MiB) so a legal 1–4 MiB server frame is no longer wrongly rejected. The value is
  sourced from `@moshu/contracts` and pinned by a shared field in the canonical test-vector
  fixture that both Vitest and Swift assert against, so the limit can't silently drift.
  Queued-byte bounds stay conservative but never below one max frame.
- **WebSocket close-code mapping** — teardown maps the intended numeric code to a real
  `URLSessionWebSocketTask.CloseCode` (oversize → `messageTooBig`/1009, binary →
  `unsupportedData`/1003, and the standard codes), instead of always sending `.goingAway`
  (1001). Reserved/local-only or unknown codes fall back to a safe sendable code, and the
  close reason is bounded to the 123-byte control-frame budget on UTF-8 scalar boundaries.

## Status

Layer 4 (this app) is implemented and builds. Background/suspended reliable
notifications and release hardening are Layer 5. The pairing HTTP/WSS endpoint paths
follow the current Layer 3 ingress convention; full end-to-end pairing requires an
online Desktop.
