# 实施进度

> 更新日期：2026-07-31
> 当前产品阶段：Phase 0
> 当前架构里程碑：RB-09 发布加固
> 当前代码基线：Local/Remote Runtime Box、强认证 ingress、Dev Tunnel、durable Action recovery、双 owner MCP/Skills、独立 Mobile ingress + 二维码配对 + Ed25519 设备认证、可构建的 iOS Mobile App（Capacitor Web UI + 原生 Ed25519 安全传输）

本文只记录代码或自动化测试已经证明的能力。批准的目标见[技术架构](./architecture.md)，后续顺序见[工程交付计划](./delivery-plan.md)。

## 1. 当前架构状态

| 口径 | 状态 |
| --- | --- |
| 批准的应用角色 | Client、agents server、Runtime Box；Runtime Box 是 Box 内部执行组件 |
| 当前仓库实现 | client 监管 agents-server 和 Local Runtime Box companion；Provider、Agent、产品 DB 和 Agent Session 位于 agents server；七工具只在 Box 内部 Executor 执行 |

```text
React WebView
  -> typed Electrobun RPC
  -> authenticated client/agents-server JSON RPC
  -> ChatApplicationService
  -> public Pi ModelRuntime + headless AgentSession
  -> Product DB RunJournal + Pi SessionManager JSONL

Local Runtime Box
  -> Runtime Box descriptor registration + keyed registry/invocation gateway
  -> read/bash/edit/write/grep/find/ls
  -> MCP stdio/Streamable HTTP/SSE + immutable Skills

Agent Server
  -> Server-owned MCP stdio/Streamable HTTP/SSE
  -> global Agent MCP refs + local Action dispatcher
```

“三进程”表示三个应用角色；Electrobun framework 仍会创建 launcher、application worker 和 WebView 等额外进程。

## 2. 已完成的基础

- 两个 TypeScript + Bun compiled companion 由 desktop supervisor 启动、认证、监管和协作关闭。
- 动态 loopback bootstrap、stable identity、instance/generation fencing、请求 allowlist、取消和 event replay 已有合同与测试。
- packaged canary、standalone binary、three-process、parent-death 和 companion smoke 构成当前发布门槛。
- Runtime protocol v2 已冻结到独立 min/max/current；v2 增加 MCP config revision，旧 Remote Box 在 Upgrade 前收到 HTTP 426，
  再用设备 key 提交短时防重放兼容性报告；Server 验证 generation 后持久化，registry/UI 跨重启显示
  `upgrade_required`。报告受 lifecycle/5 秒 timeout 约束；Relay TLS 与未来 Noise negotiation 字段均进入签名。
- Runtime RPC 收发字节按月持久估算，设置页显示 5 GiB 的 50/80/100% 告警及公开 Dev Tunnels 数量、
  端口和速率限制；该值不冒充 Microsoft Relay 计费。
- Product RPC 提供严格 Schema 的脱敏 Runtime diagnostics，仅包含版本/identity/protocol、registry、
  inventory 摘要、DB quick-check 和 Remote Access 状态，不包含 Secret、MCP config、Skill body 或 locator。
- desktop、agents-server 和 Runtime Box 共用 release version；最终 package 写入两个 companion 的
  SHA-256/protocol 清单，supervisor 拒绝 READY version mismatch，package smoke 在无系统 Bun/Node PATH 下启动。
- stable package gate 要求永久 app ID、HTTPS release origin 和 Ed25519 更新密钥；macOS 要求 Developer ID、
  notarization/staple/Gatekeeper，Windows 对完整 bundle 执行 Authenticode SHA-256 + RFC 3161。
  最终 `Setup.exe` 也在 installer ZIP 内签名并验证；update metadata/archive/installer 由一个签名清单整体绑定。
- Remote Runtime Box 可作为普通用户服务安装在 Linux/macOS/Windows；单二进制携带校验后的
  rg、fd 和 Photon WASM 资源，并使用私有配置、generation 和 workspace。
- Agent Server 暴露独立 Runtime-only ingress，使用一次性 pairing code、Ed25519 challenge、
  device-key revocation、持久 generation fence、入口限流和 canonical RPC identity。
- Agent Server 另暴露**独立 Mobile ingress**（固定 loopback listener、`/mobile` 路径，与 Product RPC、
  Runtime ingress 物理/逻辑隔离，不复用其入口）。Mobile 配对使用 Desktop 展示的二维码（含 mobile public URL、
  pairingId、一次性 code、agentServerId、server 公钥/指纹、有效期、协议区间；绝不含 server secret 或长期 token），
  iOS 端生成 Ed25519 设备 key 并提交 claim；Desktop CAS 校验设备指纹后授权，之后自动重连。校验链为
  canonical SPKI 公钥/指纹 + `AgentServerIdentity` 签名 challenge（绑定 agentServerId、mobileClientId、
  deviceKeyId、instanceId、persisted generation、challengeId/nonce、协议版本与 `relay-tls` transportSecurity），
  WebSocket upgrade 前验证签名/激活 key/吊销/challenge 单次与过期/server identity，返回 role=`mobile-client`；
  独立持久 generation high-water fence 阻止旧 generation/instance/late connection 复活，设备吊销立即关闭匹配 peer。
  Mobile 方法走**独立 allowlist**（runtime info/list/client-scoped switch；projects list/get/sidebar；models
  listAvailable；session list/get/create/setModel；chat send/cancel/replay/subscribe/unsubscribe/retired；
  approvals list/get/decide + session policy get/update），Provider/Remote Access 控制/Runtime 配对/MCP/Skills/
  Project mutation/diagnostics 等一律 deny；事件按已订阅可见 Session 严格 Zod + redaction 下发。
  Mobile ingress 独立 frame/body/inflight/backpressure/handshake timeout、未认证连接与 HTTP 容量、per-source
  限流与流量计量；作为 DevTunnel 第二端口按 Layer 1 multi-port 模型逐端口 readiness/public URL 公开。
  Remote Access status v1 保持不变，新增 versioned `mobileAccess.status`（v2）向 Desktop 暴露 mobile ingress
  状态/URL。**iOS App 本体已实现**（Layer 4：Capacitor Web UI + 原生 Swift 安全传输，见下条）；**Layer 5（final）
  已实现** durable attention/未读 feed + 生命周期/重连 + best-effort 本地通知 + 发布加固（见 architecture §9.0.4）。
- **iOS Mobile App（Layer 4）** 是同 monorepo 内可构建的 `apps/mobile` workspace：React + Vite + TypeScript strict +
  HeroUI + React Router HashRouter，Web assets 随 App 打包（`base:"./"`、`webDir:"dist"`、无 `server.url`），
  独立 mobile shell（底部 Chats/Projects/Activity/Settings tabs、`100dvh`/safe-area/VisualViewport 键盘避让、
  中英 i18n、light/dark、VoiceOver labels），复用 `@moshu/contracts` 与 `@moshu/ui` tokens。RPC 走 Layer 1
  browser-safe `@moshu/process-rpc-core`，经原生 authenticated socket adapter 做 hello/ack 与 expected server
  identity 校验，Product client 严格遵循 Layer 3 mobile allowlist；连接恢复按 subscribe→buffer→replay→dedupe→
  flush→ready，业务数据仅存 React 内存（断线即清空、只显示 offline/reconnect，不缓存、不离线排队）。
  Capacitor 8（SPM 模式、iOS 15+、bundle id `dev.moshu.mobile`），Info.plist 仅申请相机（二维码）说明、
  无宽泛 ATS/无 Bonjour；保留自定义 URL scheme deeplink hook 但首版不依赖。原生 `MoshuMobileTransport`
  Swift plugin 使用 CryptoKit Curve25519 (Ed25519) 生成**软件**设备 key，private key 存 Keychain
  （`WhenUnlockedThisDeviceOnly` + 不同步 iCloud），JS 永不接触私钥；单 Server binding（exact URL/agentServerId/
  server 公钥指纹/协议），已绑定拒绝覆盖、显式 unpair 才清 Keychain 与 socket；配对解析 versioned 二维码 →
  URLSession claim/轮询 status → 核对 server 公钥指纹后原子持久化；重连持久单调 generation、每连接新 instanceId，
  验证 Agent Server challenge 签名后用设备 key 签 canonical upgrade payload，经 `URLSessionWebSocketTask` 带
  `x-moshu-*` headers 连 WSS，帧按 connectionId + 单调 sequence 上送、限制帧/队列大小、拒绝 binary、丢弃旧连接。
  canonical payload 有从 TS contracts 固定的共享 test vectors，Swift `MoshuMobileCore` 纯包（47 XCTest）验证
  Swift/TS 逐字节一致、SPKI DER、base64url、challenge 签名、generation 递增/并发原子、单绑定/unpair、
  hello identity（含 deviceKeyId）、close code 分类与入站帧限额（59 XCTest）；
  Web 侧 63 Vitest（native plugin mock、pairing 状态、断线清业务态、无持久化、RPC schema/allowlist、
  subscribe/replay 边界、stream/cancel、approval race/allow-all、Projects、RuntimeBox 独立选择、
  responsive/键盘、i18n parity、hello 握手 accepted、fatal-auth 关闭无盲重连、pre-bind 溢出、历史分页、
  ambiguous-send 幂等、4MiB 帧限额）。iOS simulator `xcodebuild`（禁签名）构建通过。**PR #8 审查加固**：hello 必含
  `deviceKeyId`；致命关闭按 close code/HTTP 状态数值分类（1008→AUTH_REVOKED、401/403→AUTH_FAILED、
  426→PROTOCOL_MISMATCH）并停止盲重连清业务态；失败路径必 dispose provisional connection、pre-bind buffer
  有界 fail-closed；Keychain `set` update-not-delete-then-add、generation 并发 distinct/单调；入站按 UTF-8
  字节限帧、binary protocol-close；chat 历史按 nextCursor 分页含 active run；send 复用 requestId 幂等重试。
  复审再对齐 transport 帧上限＝Product-RPC `productRpcMaxFrameBytes`＝4 MiB（共享向量固定防漂移、合法 1–4 MiB 帧接受），
  并将 teardown 关闭码安全映射到 `URLSessionWebSocketTask.CloseCode`（oversize→1009、binary→1003）而非一律 1001，
  close reason 按 UTF-8 边界截断到 123 字节。
  传输边界仍是 relay TLS +
  应用设备签名（relay 可见），Noise 端到端后置。**Layer 5（final，已实现，见下方 M-L5 与 architecture §9.0.4）**：
  Agent Server 持有 durable attention/未读 feed、iOS 生命周期/重连、best-effort 本地通知与发布加固；按硬边界
  **无云 Push Relay/APNs/后台伪保活，suspended/terminated 不保证通知**，重连从 server feed 恢复 missed 未读。
- Agent Server 管理 Dev Tunnel Microsoft device-code 登录、持久 cluster-qualified Tunnel ID、
  单一 Anonymous HTTP ingress port、Host watchdog、重建/修复、取消和重试；Product RPC 不暴露到 Tunnel。
- Agent Server 在派发前持久化 Action intent，并签发参数、来源、目标 generation 与 execution scope
  绑定的短时单次 grant；Runtime Box 执行前 fsync invocation journal。
- Runtime 断线不会提前终止已开始 Action；执行继续到原 RPC deadline，显式取消、deadline 或 daemon
  shutdown 才立即取消。结果通过 evidence ack、Box receipt、Server confirmation 三阶段幂等收敛，
  非幂等 Action 不自动重放。
- Remote Runtime Box 使用 data-directory 单实例锁；永久认证失败或 daemon shutdown 会先取消并排空所有
  Action，再释放锁。数据库 reset 通过 `actionJournalEpoch` 隔离旧 journal。
- Runtime Box 私有 SQLite/SecretStore/Skill store 保存 MCP config/credential、immutable Skill content、
  inventory epoch/revision/change log；Agent Server 仅保存严格脱敏 projection 和稳定 Runtime Profile ref。
- Agent Server-owned MCP 使用 Product DB metadata、独立 MCP SecretStore 和全局 Agent profile；连接不随 active
  Runtime Box 切换，stdio 运行在 Agent Server host。
- MCP list 给 renderer 的 DTO 不含 command/args/cwd/URL 等 transport config；启停使用 Box 内部
  `setEnabled` mutation，不再把持久 transport round-trip 到 WebView。
- 每次连接先 full inventory sync，连续 delta/hint 和 48–72 秒独立 poll 维持 cache；gap、压缩、epoch reset、
  无前进 cursor 或旧 peer 结果均 fail closed/full snapshot，offline 只标 stale。
- MCP stdio、Streamable HTTP 与兼容 SSE lifecycle 已接入，进程树/session/stream 均可回收；每次 MCP Tool
  仍使用 durable intent、版本/hash/schema 绑定的单次 grant 与 invocation journal。
- Server-owned MCP 与 Box-owned MCP 共用协议/lifecycle package、owner-aware ToolDefinition 和 Action
  语义；Server 本地调用不伪装成 Runtime Box target，Box 调用继续使用 journal/evidence。
- Skills 使用 YAML 规范校验、内容 hash、不可变版本、filesystem-safe 目录和 fsync commit；Run 启动时 live
  验证并只在内存加载 `SKILL.md`，不会写入 Product DB、事件或 Pi Session JSONL。
- Agent Server-owned Skill 使用 Product DB metadata、private immutable content store 和 Agent global profile，
  首期只接受单个非 executable `SKILL.md`；Box-owned Skill 保留完整 package。两类 owner 同名时 Run fail closed。
- 产品数据库只有 agents server 写入，保存 SessionCatalog、RunJournal、durable events、retirement tombstone 和
  agent-session cleanup outbox。
- 每个 Chat Session 拥有稳定 Pi session ID；conversation context 由显式
  `agentDataDirectory/sessions` 下的 `SessionManager` JSONL 保存和恢复。
- 删除 Session 先建立持久 cleanup job，再经 lease/dispose、路径 containment 和 targeted unlink 清理 Pi 文件；
  失败按有界 backoff 重试。

## 3. 当前 Agent 与 Provider 实现

- `@earendil-works/pi-ai`、`pi-agent-core`、`pi-coding-agent` 固定为 `0.82.1`，生产代码只使用公开导出。
- `ModelRuntime` 动态枚举内置 Provider；不保存静态 Provider 清单。
- 自定义 Provider 仅支持 `openai-completions`、`openai-responses`、`anthropic-messages` 和
  `google-generative-ai`，可使用稳定的多个实例 ID。
- builtin/custom 启用状态、模型勾选和默认模型由 app-owned Provider registry 保存；刷新只针对选中的
  public Pi Provider。
- Provider credential 由 `SecretVaultCredentialStore` 保存：目录 `0700`、文件 `0600`、provider lock、
  whole-file commit lock、fresh read/apply、atomic rename 和 fsync。
- API Key/OAuth 通过 `Models.login/logout` 和异步 auth attempt 驱动。UI 轮询 attempt，支持
  text/secret/select/manual code、info/auth URL/device code/progress；secret 回答不回显、不持久化。
- 默认 Chat Session/Run 使用 `agent` mode。`PiAgentRuntime` 使用 `createAgentSession`、
  `DefaultResourceLoader`、`SettingsManager` 和 `SessionManager`。
- runtime 固定 `noTools: "builtin"`，禁用 Pi extensions/skills/prompt templates/themes/context files 和
  TUI；注册七个 Executor SDK proxy，并按 live Runtime Profile 增加 MCP SDK ToolDefinition，不能回退到
  Pi built-in 或绕过 Runtime Box grant。
- proxy 只做 Zod/TypeBox 校验和 Runtime Box RPC 映射；标准 tool-call/tool-result 循环、progress、abort、
  Runtime Box unavailable 和 gateway error 已有自动化覆盖。
- Runtime Box 文件变更按稳定 canonical pathname 串行化并使用 atomic rename，覆盖 inode 替换和 dangling
  symlink；`edit` 在读取前执行 16 MiB 上限并先验证有界 diff/result 再提交。
- `read` 流式读取文本；图片在 Photon 解码前执行 32 MiB 输入、32,768 单维和 25M 像素上限。`grep`
  有界收集 context，避免大文件整文件 materialize。
- `bash` 使用流式 UTF-8 解码、输出 backpressure、64 MiB 单命令上限、256 MiB 保留目录总配额和私有
  `0700`/`0600` 路径；失败保留可诊断路径，取消等不能返回路径的失败释放文件和配额。
- Unix process group 与 Windows Job Object 都纳入命令生命周期；成功、失败、timeout 或 cancel
  都会清理残留进程树。
- streaming text、final usage、Provider 错误、abort/cancel、同 Session 单 owner、跨 Session 并发、restore、
  disposal 和安全删除已有自动化覆盖。
- 模型推理使用 Pi `ThinkingLevel`。设置时拒绝无效档位；运行时若已保存档位不再被刷新后的模型支持，则安全省略，
  不让 Chat 因 capability drift 持久失败。

## 4. 当前产品能力

- Providers 页面区分动态 builtin 与 custom Provider；builtin 身份/Endpoint 只读，custom 可编辑和删除。
- Provider auth、退出、连接测试、按 Provider 刷新模型、模型启停和 authentication readiness 已贯通
  renderer、Electrobun RPC 和 Product RPC。
- 普通 Chat 支持流式回复、停止、继续已有 Session、失败状态、自动标题、搜索、重命名、归档和永久删除。
- `/chat/new` 与 `/chat/:sessionId` 是当前 Session 选择事实来源。
- Projects 支持 Local 系统目录选择、Remote 绝对路径输入、规范化/Git/根 `AGENTS.md` 预览确认、路径健康检查、
  重命名、重新关联、归档/恢复和 typed-confirmation durable 删除；删除只清理产品记录与 Pi Session，
  不删除 Runtime Box 上的目录。
- Project Session 使用不可变 `projectId + runtimeBoxId` 归属；全局 Chats 不返回 Project Session。
  `/projects/:projectId` 提供完整 Session 搜索与管理，Project Chat 复用现有 Chat controller，
  archived/offline/path unavailable 状态下历史只读。
- Project Run 在执行前实时验证 owning Box 与 canonical path，只在内存加载根 `AGENTS.md` 正文，
  并持久化 path revision/Git/hash 快照。Local/Remote Project 的文件 Tool 使用签名的 `project-root`
  scope 和 lexical/canonical containment；`bash` 仅以 Project 为默认 cwd，仍不属于 shell sandbox。
- Project 删除按持久 job 分批 retire Session；tombstone 同时提供 TTL 内的 replay 与 Desktop retirement
  recovery，Pi JSONL 由 cleanup outbox 最终清理。
- 事件先持久化再发布；snapshot、cursor、replay、tombstone 和 reconciliation 可处理重连。
- 非终态 orphan Run 在启动时安全终结；当前不宣称可从进程崩溃点继续执行同一个 Run。

## 5. 当前明确未实现

- 当前 POC 的 Policy 默认信任已认证且绑定的 Agent Server 用于 durable dispatch、单次消费、generation
  fencing 和恢复。**用户级 Tool/Action 交互审批已由 Mobile stack Layer 2 实现**（server-authoritative 风险分级、
  durable approval request + Session Allow-all、CAS/idempotent 决策、多 client 事件同步、Desktop 卡片/待办面板；
  见 architecture §9.0.1 与 data-contracts §9.2/§10.2）。仍后置的是：把该审批门与最终 execution grant / Action
  intent / outcome recovery 完整串起来，以及 shell sandbox 与 Mobile client。
- Remote 普通 Chat 的 path tools 受 Box workspace canonical containment；Project Chat 文件 Tool 受
  Project root containment。`bash` 按当前完全信任决策不受文件 containment 限制。
- 尚无独立 Git Tool；Agent 可经 `bash` 调用环境中可用的 Git，但没有 Git 专用合同、Diff journal 或 revert。
- Plan、自定义 Agent、subagent、任务中心、Diff/撤销和桌面通知仍是后续产品范围。
- MCP OAuth 2.1 浏览器授权/DCR、Git URL Skill 更新和完整目录/压缩包导入 UI 仍是后续产品增强。
- macOS Provider vault 当前是权限加固的 app-owned 文件；Keychain adapter 仍是外部分发前安全工作。
- Mobile stack Layer 3 已实现独立 Mobile ingress、二维码配对与 Ed25519 设备认证（见 §2 与 architecture
  §9.0.2、data-contracts §9.3）。**iOS App 本体（Layer 4：Capacitor Web UI + 原生 Swift 安全传输）已实现**
  （见 §2 iOS Mobile App 条目）。**Mobile stack Layer 5（final）已实现**：Agent Server 持有 durable
  attention/未读 feed、iOS 生命周期/重连、best-effort 本地通知与发布加固（见 architecture §9.0.4、
  data-contracts §9.5、quality-release）。按硬边界 **无云 Push Relay/APNs/后台伪保活，suspended/terminated 不
  保证通知**；重连从 server feed 恢复 missed 未读。首版 Mobile client 只绑定一个 Agent Server（由 client 实现），Desktop 必须在线，relay TLS +
  应用设备签名是当前传输边界（relay 可见），Noise 端到端握手后置且不会谎称已启用；设备 key 为软件
  CryptoKit key（非 Secure Enclave），App 不缓存任何业务数据。iOS 端配对 HTTP/WSS 端点路径为对 Layer 3
  ingress 的当前实现约定，真实 E2E 需在线 Desktop 验证。
- Remote Runtime Box 的 ingress、设备配对认证、三平台 daemon、Dev Tunnel、durable grant、断线
  outcome reconciliation、MCP/Skill ownership 和发布故障矩阵已实现。真实 Microsoft Tunnel 探针、
  macOS 正式公证和 Windows 正式签名仍是需要外部账号、证书和对应 runner 的 release 执行门。
  团队共享、Docker/cloud 和多租户仍不在当前范围。

## 6. 架构迁移状态

| 阶段 | 状态 | 下一项可验证结果 |
| --- | --- | --- |
| A0 RPC / binary POC | 已完成 | compiled companion、动态 loopback、认证 RPC、监管、关闭和 package gate |
| A1 agents-server extraction | 已完成 | Pi Agent、Provider/auth、产品 DB、Session JSONL 和 cleanup 全部归 agents server |
| A2 Runtime Box / Agent registry | 部分完成 | Runtime Box 注册/readiness/inventory 已有；自定义 Agent N:1 binding 尚未实现 |
| A3 Tool Bridge / Action Broker | 已完成（POC trust policy） | durable intent、单次 grant、journal、transport-loss lease、evidence/receipt reconciliation |
| A4 MCP / Skills | 已完成（POC） | 双 owner MCP/Skills、global/Runtime Profile、inventory reconciliation 与 live Tool/Skill resolution |
| A5 Recovery / release hardening | 已完成（外部 release gate 待执行） | restart/fault/package/update-signing 自动化完成；正式凭据与三平台 runner 不在仓库内 |
| RB-01 Runtime Box domain/local | 已完成 | Runtime Box contract、注册 descriptor、Local stable ID 和 keyed registry |
| RB-02 Persistence/routing | 已完成 | Box catalog、active CAS、Session/Run 归属、显式 Gateway 路由和 generation fence |
| RB-03 Ingress/pairing | 已完成 | Runtime-only ingress、Ed25519 配对认证、吊销、防重放、持久 generation 和限流 |
| RB-04 Remote service | 已完成 | 三平台普通用户服务、pair/run/status/doctor/unpair/uninstall 和单二进制资源 |
| RB-05 Dev Tunnel | 已完成 | Microsoft device-code、持久 Tunnel、精确端口/ACL、watchdog、修复、取消和重试 |
| RB-06 Switch/Projects/UI | 已完成 | active Box 过滤、Project lifecycle、Project Session/Chat、path health/relink、根 `AGENTS.md`、`project-root` Tool 和离线历史只读 |
| RB-07 Grants/recovery | 已完成 | durable Action/grant、Box journal、deadline lease、三阶段结果确认和 reset epoch |
| RB-08 MCP/Skills | 已完成 | Box private store、SecretStore、inventory sync、Runtime Profile、live validation 与 MCP grant bridge |
| RB-09 Hardening/release | 已完成（外部 release gate 待执行） | protocol/quota/diagnostics/fault matrix/signed package gates；真实 Tunnel 与正式平台签名由 release runner 验证 |
| M-L1 Browser-safe RPC core | 已完成 | `@moshu/process-rpc-core`、client-scoped Runtime Box、authorization-aware Chat 订阅、DevTunnel multi-port |
| M-L2 Durable approvals | 已完成 | server-authoritative 风险分级、durable approval + Session Allow-all、CAS/幂等决策、多 client 事件、Desktop UI |
| M-L3 Mobile ingress/pairing/auth | 已完成 | 独立 `/mobile` ingress、二维码配对、Ed25519 设备认证、generation fence、独立 allowlist、Desktop 配对 UI |
| M-L4 iOS Mobile App | 已完成（真机签名/后台通知后置） | 可构建 `apps/mobile` Capacitor Web UI + 原生 `MoshuMobileTransport` Swift plugin（Keychain 软件 Ed25519、单绑定/unpair、challenge 验签、WSS 帧序列/限额）、browser-safe RPC/Product allowlist client、离线清业务态、47 Vitest + 30 Swift XCTest、iOS simulator 构建通过；Layer 5 后台/suspended 通知与发布加固后置 |
| M-L5 生命周期/通知/durable 未读/发布加固（final） | 已完成（真机签名/真实 Tunnel/App Store 提交为发布方人工步骤） | Agent Server 持有 durable attention/未读 feed（脱敏事件、**transactional outbox + 幂等 drainer 投影**、per-client 单调 ack cursor、cursor 分页 + resyncRequired、**production 执行的 bounded retention 30d/500**、revoke/unpair 清 cursor、mobile-only `attention.changed` hint；handler 抽到 pi-free `mobile-ingress-handlers.ts`，并由 pi-free `mobile-ingress-composition.ts` 的 `createMobileIngressComposition`（strict allowlist + merged attention handler + outbox drainer + revoke 装配）作为生产装配单一来源供 `create-agents-server` + smoke 共同调用）；iOS 生命周期/重连（`@capacitor/app`、有界退避+jitter、background 暂停、fatal 含 `UNSUPPORTED_PROTOCOL` 不重试、background close→offline、**plugin 独占的单一有界 background task**，系统 expiration 由 `engine.closeActiveConnection` 关精确 socket + stale/late-A-vs-B/同步 expiration guard no-op、background→foreground 存活 socket non-notifying resnapshot、无 UIBackgroundModes）；best-effort 本地通知（用户显式开启、仅短后台收到事件时 schedule、generic 文案、稳定 id、**opaque route（>100 事件按 latestSeq 有界 cursor 走查、gap/走查耗尽→显式 `safeActivity` 安全路由使 tap 仍可点、异步走查后 re-validate app-active/权限/generation）+ `AttentionProvider` app-root 真实 React Router 装配 + `NotificationTapCoordinator` 先认证/刷新再导航、未配对/fatal 安全态**、suspended/terminated 不保证、无 APNs）；发布加固（`release.config.json`+version sync、`PrivacyInfo.xcprivacy`、release-gate 脚本含**真实发布 bundle id 强制**（`MOSHU_MOBILE_RELEASE_BUNDLE_ID` + `xcodebuild -showBuildSettings` 精确比对）与 **dist↔public 递归 SHA-256 manifest**、export compliance 待发布方确认）；**116 Vitest + 70 Swift XCTest + 125+87 contracts/database + 22 隔离 agents-server mobile（真实 production 组合 smoke + composition wiring contract）全绿，iOS simulator `xcodebuild build`（禁签名）BUILD SUCCEEDED** |

## 7. 开发数据策略

当前仍处于首次外部分发前。产品 DB 与 Provider registry 使用当前 schema；不兼容的旧开发数据可明确 reset，
不会保留已删除 runtime 的转换 adapter。Pi Session JSONL 是当前 conversation context 格式。
首次外部发布冻结 schema 后，升级必须遵守 backup、migration、rollback 和 fixture gate。

## 8. 下一优先级

1. 在有 Microsoft 登录状态的 release 环境执行真实 Dev Tunnel 探针。
2. 在 macOS/Windows/Linux runner 执行 stable package、正式签名/公证和安装级 E2E。
3. 在外部分发前完成 Provider vault Keychain adapter。
4. 后续版本实现 Noise 端到端握手和用户级命令审批。
