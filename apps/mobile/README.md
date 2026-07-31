# @moshu/mobile — iOS Mobile App (Mobile stack Layer 4 + Layer 5)

A real, buildable iPhone App: a Capacitor Web UI (React + Vite + TypeScript strict +
HeroUI + React Router HashRouter) bundled with the app, plus a native Swift secure
transport plugin (`MoshuMobileTransport`). Web assets ship inside the app
(`base: "./"`, `webDir: "dist"`, no `server.url`); the Agent Server only carries data.

This layer depends on the Layer 3 Mobile ingress / pairing / device auth
(`packages/contracts/src/mobile.ts`, `apps/agents-server`). It implements the iOS
**client** side of those contracts. **Layer 5** adds the durable Agent-Server-owned
attention/unread feed contracts + client, iOS lifecycle/reconnect, best-effort local
notifications, and release hardening. There is **no cloud push relay, no APNs/remote or
silent push, and no background fake keep-alive** — see "No-cloud-push boundary" below.

## Scripts

| Script | Purpose |
| --- | --- |
| `bun run dev` | Vite dev server (browser preview of the Web UI) |
| `bun run build` | Vite production build to `dist/` |
| `bun run test` | Vitest (jsdom + Testing Library) |
| `bun run typecheck` | `tsc --noEmit` (app + node config projects) |
| `bun run cap:sync` | `cap sync ios` — copy `dist/` into the iOS project + update native deps |
| `bun run cap:copy` | `cap copy ios` — copy `dist/` + config into iOS (no pod install) |
| `bun run cap:open` | Open the iOS project in Xcode |
| `bun run release:version` | Fan `release.config.json` version into pbxproj + `package.json` (`-- --check` to verify) |
| `bun run release:gate` | Static pre-release gate (see "Release hardening") |
| `bun run gen:vectors` | Regenerate shared canonical test vectors from TS contracts |

## Layout

```text
src/
  app/          mobile shell, connection lifecycle, appearance, i18n, keyboard
  components/   layout, tab bar, approval card
  screens/      Chats, Projects, Activity, Settings, connection/onboarding
  rpc/          browser-safe process-rpc handshake, product client, reducers,
                connection controller (fatalCodeMap), native transport adapter,
                attention controller (durable feed recovery + badge + no replay),
                notification-tap coordinator (opaque route, gated navigate)
  native/       Capacitor plugin JS surface (transport-plugin.ts), injectable
                lifecycle.ts (@capacitor/app) + notifications.ts (LocalNotifications +
                tap listener + route validation)
native/MoshuMobile/   pure-Swift `MoshuMobileCore` SPM package + XCTest + fixtures
  Sources/.../BackgroundActivityCoordinator.swift   single bounded bg task, stale-guard cleanup
  Sources/.../NotificationContentBuilder.swift       stable id + generic keys + opaque route ids
ios/App/              Capacitor 8 iOS project (SPM mode); App/plugins/*.swift
                      (MoshuMobileTransportPlugin owns bg-task + lifecycle observers),
                      App/PrivacyInfo.xcprivacy, App/AppDelegate.swift (bg-task delegated to plugin)
scripts/gen-canonical-vectors.ts   shared TS↔Swift byte-parity fixture generator
scripts/sync-version.ts            single-source-of-truth version fan-out
scripts/release-gate.ts            fail-closed pre-release static checks
release.config.json                marketingVersion / buildNumber / bundle-id policy
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

## Durable attention feed (Layer 5)

The unread/attention state is **owned by the Agent Server**, never by the phone. The
server durably appends a desensitized `MobileAttentionEvent` when an approval enters
`pending` or a Run reaches a terminal state (`run_completed` / `run_failed` /
`run_cancelled`). Each event carries only opaque ids (`sessionId` / `runId` /
`approvalId`), a stable `eventId` + monotonic `seq`, `createdAt`, and generic
localization keys (`titleKey` / `bodyKey`) — **never** a prompt, tool args, path body,
shell command, or provider secret. The write path is a **transactional outbox**: the
server appends to `mobile_attention_outbox` (unique `dedupeKey`) inside the *same* SQLite
transaction as the approval/run business write, so the business commit and the outbox row
are atomic. An idempotent `MobileAttentionOutboxDrainer` then projects outbox rows into
`mobile_attention_events` and marks them processed (drained at startup and during runtime;
a projection failure is retained + retried with diagnostics, never swallowed as success).
A crash between the business commit and projection therefore can never permanently lose an
unread, and a lost `attention.changed` hint never affects the reconnect `list`.

- Per authenticated `mobileClientId`/device the server keeps a monotonic **ack cursor**
  (read state). The phone stores **no** business events. RPC `mobile.attention.list`
  does cursor pagination and returns `unreadCount` / `nextCursor` / `latestSeq` /
  `resyncRequired`; `mobile.attention.ack` is CAS + idempotent and monotonic (an older
  ack never regresses the cursor). Peer identity comes from the auth context — a caller
  can never forge a `clientId` or roll the cursor backward. The list/ack/revoke handler
  logic lives in a pi-free `apps/agents-server/src/mobile-ingress-handlers.ts`, and the whole
  Mobile ingress (strict allowlist + merged attention handlers + transactional-outbox drainer
  + revoke) is assembled by the pi-free `createMobileIngressComposition`
  (`mobile-ingress-composition.ts`) — the single production wiring source that both
  `create-agents-server.ts` and the ingress smoke call, so the smoke exercises the real
  composition (a wiring contract test guarantees new ingress methods stay covered).
- Retention is bounded and **enforced in production** (age 30 days + per-client 500),
  pruned at startup (forced), after each drain (throttled + jittered), and on a bounded
  periodic path. If a cursor is older than what is retained, `list` returns
  `resyncRequired: true` (a resnapshot) instead of pretending "no unread". A revoked device
  can no longer read the feed; unpair does not leak an old feed to a new server binding.
- Live updates send mobile clients only a minimal `attention.changed` **hint** (no
  business body). The Desktop Product RPC never exposes mobile device unread.

The client `AttentionController` (`src/rpc/attention-controller.ts`) attaches on connect,
takes a **recovery snapshot** (badge only — it never replays historical events as system
notifications), tracks a `#seenSeq` baseline, and drives the Activity tab badge from
`max(pendingApprovals, unread)`. Returning to the foreground while the socket is still alive
re-runs a **non-notifying** refresh + snapshot-freshness check (`onAppActive` re-emits the
surviving `connected` state) so unread updates without re-firing historical local
notifications. Notification routes are resolved by walking the server cursor up to a bounded
page count (`MAX_ROUTE_LOOKUP_PAGES`) so a tap on the newest event still resolves past the
first page (150+ events); a retention gap falls back to the safe Activity screen rather than
using a stale opaque id.

## Lifecycle & reconnect (Layer 5)

- `src/native/lifecycle.ts` wraps `@capacitor/app` `appStateChange` (with a web
  `visibilitychange` fallback). Foreground → connect/resume + one immediate retry;
  background → **pause** reconnect (no new sockets), letting only an already-open socket
  live inside the OS's short background window; OS expiration tears the socket down.
- Reconnect uses **bounded exponential backoff + jitter** (`reconnectMaxDelayMs`,
  `reconnectJitterRatio`), reset to zero on a stable `connected` and on user `retry()`.
  Fatal `AUTH_REVOKED` / `AUTH_FAILED` / `PROTOCOL_MISMATCH` / `UNSUPPORTED_PROTOCOL` /
  identity mismatch never retry; backoff timers pause while backgrounded/offline. A socket
  close while backgrounded goes straight to `offline` (no scheduled reconnect). Stale
  connection callbacks can never revive a torn-down connection.
- Native `BackgroundActivityCoordinator` (pure logic in `MoshuMobileCore`, XCTest-covered)
  owns a **single, idempotent, bounded** `UIApplication` background task. It is assembled
  **by `MoshuMobileTransportPlugin`** (the same owner as the transport engine, so there is
  no cross-object wiring from `AppDelegate`): the plugin registers the lifecycle observers
  in `load()` (background→`begin`, active/terminate→`end`, `deinit` removes them), and the
  OS expiration handler calls `engine.closeActiveConnection(reason:)` to close the **exact**
  active socket and emit `closed` (the web layer then goes offline) before ending the task.
  A late/stale expiration arriving after `end()` is a **strict no-op** (it can never close a
  newer connection). This is a plain finite task — it declares **no** `UIBackgroundModes`,
  and is not remote/silent push or a VoIP/audio keep-alive.

## Local notifications (best effort, Layer 5)

- Uses the official `@capacitor/local-notifications` plugin (lazy-imported, iOS-only,
  degrades to a no-op on web/tests). The user must **explicitly enable** notifications
  from Settings after the first successful pairing — the app never ambushes the
  permission prompt on cold start. Settings shows the permission state + toggle.
- A generic local notification is scheduled **only** when the app is not active *and* an
  already-open short-background socket actually received an `attention.changed` hint.
  When active, the app just updates the Activity badge. Notification content is a
  localized generic string (no raw prompt/command/path/secret); the id is derived stably
  from the attention `seq` (`NotificationContentBuilder` / `notificationIdForSeq`) so the
  same event never double-fires.
- Each scheduled notification carries only a **validated opaque route**
  (`parseNotificationRoute` whitelists `sessionId` / `approvalId` / `attentionEventId`;
  anything else in the payload is dropped). Taps are handled by `NotificationTapCoordinator`
  (`src/rpc/notification-tap.ts`), which registers a **single** `localNotificationAction
  Performed` listener and disposes it cleanly (no leak): if the session is unpaired/fatal it
  shows a safe status and **does not navigate**; otherwise it waits for an authenticated
  connection **and** a fresh attention snapshot to succeed before navigating with the opaque
  id — it never surfaces a stale payload. The `AttentionProvider` is mounted at the app root
  (inside the `main.tsx` HashRouter) and wires the real React Router `useNavigate` +
  safe-state handlers as built-in defaults (not an optional no-op), so a validated route
  navigates to the Chat / Activity approval in production while unpaired/fatal/invalid routes
  land on an explicit safe screen.
- **Suspended/terminated delivers no notification** — there is no APNs and no server that
  can wake the app. On reconnect the phone recovers missed unread from the server feed and
  shows a badge, but does **not** batch-replay historical events as system notifications.

## Release hardening (Layer 5)

- **`release.config.json`** is the single source of truth for `marketingVersion` /
  `buildNumber` and the `bundleId.development` / `bundleId.release` policy;
  `scripts/sync-version.ts` fans version into the Xcode `MARKETING_VERSION` /
  `CURRENT_PROJECT_VERSION` and this `package.json` (`release:version -- --check` verifies
  without writing). Signing team / certificate / provisioning are **never** committed; they
  are supplied at build time by whoever signs.
- **`App/PrivacyInfo.xcprivacy`** declares no data collection, no tracking, and the single
  required-reason API actually used by the Capacitor runtime + plugins
  (`NSPrivacyAccessedAPICategoryUserDefaults`, reason `CA92.1`).
- **`scripts/release-gate.ts`** (`bun run release:gate`) is a fail-closed static gate:
  no remote UI (`server.url`), no node builtins / `Buffer` / `ws` in the bundle, no
  secret samples, no broad ATS, no forbidden background modes, no APNs entitlement /
  Local Network / Bonjour, no baked signing identity, version consistency,
  contracts↔canonical-vector sync, and a **recursive SHA-256 manifest** comparison of the
  web `dist` against the copied iOS `public` (path/size/content must match exactly; only
  Capacitor/native metadata like `capacitor.config.json` is excluded).
- **Dev vs release bundle id**: the committed project keeps the development id
  `dev.moshu.mobile`. A **real release gate** (`MOSHU_MOBILE_RELEASE=1` or `--release`)
  requires the publisher to set `MOSHU_MOBILE_RELEASE_BUNDLE_ID` (or `bundleId.release` in
  `release.config.json`) to a permanent non-dev id, rejects empty / `dev.moshu.mobile`, and
  verifies it against the resolved `PRODUCT_BUNDLE_IDENTIFIER` from
  `xcodebuild -showBuildSettings -configuration Release` (documented in
  `docs/implementation/quality-release.md`).
- **Export compliance**: the App uses CryptoKit Ed25519 (auth signatures) + TLS. The App
  Store encryption questionnaire / exemption must be confirmed by the publisher — the
  project does not assert `ITSAppUsesNonExemptEncryption`; see quality-release doc.

## No-cloud-push boundary

Layer 5 deliberately does **not** add any of: a cloud Push Relay, an APNs device token /
remote-notification entitlement, silent/background push, VoIP/audio/background-processing
keep-alive, an account system, on-device business caching, or an offline queue. The App
talks only to the user's own online Desktop; reliable delivery while suspended/terminated
is out of scope by design.
## Status

Layers 4 and 5 (this app) are implemented and build. The durable attention feed,
lifecycle/reconnect, best-effort local notifications, and release hardening are in place;
suspended/terminated reliable delivery is intentionally out of scope (no cloud push). The
pairing HTTP/WSS endpoint paths follow the current Layer 3 ingress convention; full
end-to-end pairing and live notifications require an **online Desktop**. Device signing,
a real Dev Tunnel probe, and App Store review submission remain manual publisher steps.
