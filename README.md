# 墨枢

墨枢是一款 Local-first Agent 应用，提供 Desktop 与 iPhone 两种操作界面。当前仓库处于首次外部分发前的
POC 阶段，三应用角色、Local/Remote Runtime Box、独立 Mobile ingress 与 iOS Mobile App 已经落地。

## 当前能力

- **Desktop Client**：Electrobun + React 桌面界面，负责窗口、设置、Runtime Box 切换和本地 companion 监管。
- **Agent Server**：独占 Provider、Agent runtime、Session、Project、Run/event、Policy/Action、产品数据库、Pi Session JSONL，以及 Server-owned MCP 和 prompt-only Skills。
- **Runtime Box**：在本机或远程设备执行 `read`、`bash`、`edit`、`write`、`grep`、`find`、`ls`，并拥有自己的 MCP、完整 Skill packages、credential、journal 和 workspace。
- **Remote Runtime Box**：通过 Agent Server 管理的 Anonymous Microsoft Dev Tunnel 主动连接，使用一次性配对码、Ed25519 双向身份、generation fence 和版本协商。
- **iOS Mobile App**：`apps/mobile` 使用 Capacitor + React + Vite + HeroUI，本地打包 Web UI，并通过原生
  Swift plugin、Keychain Ed25519 设备身份和独立 Mobile ingress 连接 Agent Server；支持 Chat、Project、
  Runtime Box 选择、审批、Activity、durable 未读和 best-effort 本地通知。
- **多 Box 路由**：Desktop 与 iOS 分别保存自己的 active Runtime preference；切换后只改变该 Client 的
  默认列表和新建放置。Server-owned MCP/Skills 保持不变，既有 Session/Project/Run 永远按持久归属路由。
- **Projects 与 Project Chat**：支持 Local 目录选择和 Remote 路径、预览确认、路径健康/重新关联、归档/删除、Project Session 管理、根 `AGENTS.md` 上下文和 Project root 文件 Tool 边界。
- **MCP 与 Skills**：支持 MCP 与 Skills 双归属、MCP stdio/Streamable HTTP/SSE、prompt-only Server Skills、Box immutable Skill packages、global/Runtime Profile 和 inventory reconciliation。
- **恢复与发布门**：durable Action intent、单次 grant、fsync journal、未知结果对账、进程树清理、协议升级状态、脱敏诊断、流量估算及签名 package/update gate。

## 架构

```text
Desktop React WebView
  <-> Electrobun RPC
Desktop Client
  <-> loopback Product RPC
Agent Server
  <-> Runtime RPC
Local Runtime Box

iOS Mobile App
  -> authenticated WSS
  -> Anonymous Dev Tunnel Mobile ingress
  -> Agent Server

Remote Runtime Box
  -> Anonymous Dev Tunnel Runtime ingress
  -> Agent Server
```

“三角色”指 Client、Agent Server 和 Runtime Box 的职责边界；Desktop 与 iOS 都是 Client 实现。它不表示
操作系统中永远只有三个 PID，Electrobun 仍会创建 launcher、application worker 和 WebView 等框架进程。

数据所有权：

| 领域 | 所有者 |
| --- | --- |
| Provider、Agent、Session、Project、Run/event、Policy/Action | Agent Server |
| Server-owned MCP、prompt-only Skills、Agent global refs | Agent Server |
| Mobile 配对、设备、attention/outbox 与 ack cursor | Agent Server |
| Box-owned MCP、完整 Skill packages、Tool 执行、workspace | owning Runtime Box |
| UI、窗口、Updater、本地 companion supervisor | Desktop Client |
| iOS private key 与单 Server binding | iOS Keychain |

Remote Tunnel 只公开彼此隔离的 Runtime ingress 与 Mobile ingress；Product RPC、Provider、数据库和 Desktop
native action 不进入 Tunnel。两个 ingress 分别使用独立角色、认证和 method allowlist。

## POC 安全边界

当前版本已实现 server-authoritative Tool/Action 审批、单次决定、Session Allow all 和 durable execution
grant。所有 shell/bash Action 都不可被 Allow all 绕过，公开摘要固定为 `shell [arguments hidden]`。
尚未实现 shell sandbox；通过审批的命令仍在 Runtime Box 所在 OS 用户上下文中执行。

Remote path tools 仍执行 canonical workspace containment；`bash` 不受文件 containment 限制。
iOS 使用软件 Ed25519 key（非 Secure Enclave），当前传输信任 Dev Tunnel TLS，Microsoft Relay 可见应用 payload；
Noise 应用层端到端加密后置。

## 环境

仓库开发环境：

- macOS 14+
- Bun 1.3.14
- Electrobun 1.18.1
- iOS 开发另需支持 iOS 15+ deployment target 的 Xcode，以及开启 Developer Mode 的 iPhone

Remote Runtime Box 二进制可在 macOS、Linux 和 Windows 对应主机上构建；当前不支持交叉平台编译。终端用户运行 compiled binary 时不需要安装 Bun 或 Node。

安装依赖：

```bash
bun install --frozen-lockfile
```

## 快速开始

推荐使用带 React WebView 热更新的开发入口：

```bash
bun run dev:hmr
```

该命令会并行启动 Vite HMR 和 Electrobun 开发流程。Desktop 会编译并监管：

```text
apps/agents-server/dist/moshu-agents-server
apps/runtime-box/dist/moshu-runtime-box
```

不需要 Vite HMR 时运行：

```bash
bun run dev
```

修改 Agent Server、Runtime Box 或其共享包后，Electrobun watch 会停止当前应用、重新编译 companion 并重启 Desktop；产品 DB 和 Pi Session JSONL 保持持久。

自动重载覆盖：

```text
apps/agents-server/src/
apps/runtime-box/src/
packages/agent-runtime/src/
packages/contracts/src/
packages/database/src/
packages/process-rpc/src/
```

## 连接 Remote Runtime Box

完整操作手册见[连接 Remote Runtime Box](./docs/guides/remote-runtime-box.md)，包括：

1. Microsoft Dev Tunnels 登录和 Remote Access 启用；
2. 一次性配对码和设备指纹确认；
3. macOS、Linux、Windows 用户服务安装；
4. Runtime Box 切换、状态验证、排障、卸载和解除绑定。

POC 源码构建：

```bash
bun run --cwd apps/runtime-box build:binary
```

然后在远程设备上使用匹配平台的 `moshu-runtime-box` 或 `moshu-runtime-box.exe`。

## 在 iPhone 上安装

iOS App 可直接由 Xcode 安装到连接的 iPhone，不需要 App Store 发布：

```bash
bun run --cwd apps/mobile build
bun run --cwd apps/mobile cap:sync
bun run --cwd apps/mobile cap:open
```

在 Xcode 的 `App` target 中启用 Automatically manage signing，选择 Apple Team、设置唯一开发 Bundle ID，
选择已连接且开启 Developer Mode 的 iPhone，然后 Run。安装后保持 Desktop 在线，在 **设置 → Mobile Access**
启用 Remote Access、创建二维码并完成设备指纹确认。完整实现、配对、安全边界和排障见
[iOS Mobile Client 实现](./docs/implementation/mobile-client.md)。

## 目录

```text
apps/
  desktop/          Electrobun Client 与 React WebView
  agents-server/    Agent Server、Product/Mobile/Runtime RPC ingress、Dev Tunnel
  runtime-box/      Local/Remote Runtime Box、Tools、MCP、Skills、用户服务
  mobile/           iOS Mobile App：Capacitor Web UI + 原生 MoshuMobileTransport Swift plugin

packages/
  contracts/        跨角色 Zod contract 与 RPC allowlist
  process-rpc-core/ 浏览器安全的 transport-neutral RPC core
  process-rpc/      认证 WebSocket JSON RPC
  database/         Agent Server 产品数据库 repository
  agent-runtime/    Pi Agent runtime 与 Tool/MCP proxy
  action-broker/    Action/grant contract
```

## 构建与打包

| 命令 | 作用 |
| --- | --- |
| `bun run build:companions` | 编译 Agent Server 和 Runtime Box standalone binary |
| `bun run build:web` | 使用 Vite 构建 React WebView |
| `bun run build` | 构建两个 companion 和 WebView，不生成桌面安装包 |
| `bun run package:canary` | 为当前主机生成并验证 ad-hoc canary package |
| `bun run package:release` | 执行 stable package gate，需要正式标识、更新签名和平台签名凭据 |
| `bun run --cwd apps/mobile build` | 构建 iOS App 的本地 Web bundle |
| `bun run --cwd apps/mobile cap:sync` | 将 Web bundle 与 Capacitor plugin 同步到 iOS 工程 |
| `bun run --cwd apps/mobile release:gate` | 检查 iOS bundle、权限、版本、资源清单和 release identity |

主要产物：

```text
apps/agents-server/dist/
apps/runtime-box/dist/
apps/desktop/dist/mainview/
apps/desktop/build/
apps/desktop/artifacts/
apps/mobile/dist/
apps/mobile/ios/App/
```

Desktop package 将两个 companion 复制到 `Resources/app/companions`，并验证：

- 同一 release version 和 protocol matrix；
- companion SHA-256 manifest；
- 可执行权限和平台签名；
- 无系统 Bun/Node 时的实际启动与协作关闭。

Canary 使用开发 Bundle ID 和 ad-hoc 签名，不能视为正式发布。Stable release 还要求：

- macOS Developer ID、notarization、staple 和 Gatekeeper；
- Windows Authenticode SHA-256、RFC 3161 timestamp 和已签名 `Setup.exe`；
- Ed25519 签名的整体 update artifact manifest；
- 对应平台 runner 和外部发布凭据。

## 质量检查

| 命令 | 作用 |
| --- | --- |
| `bun run format` | 使用 Biome 写入格式化结果 |
| `bun run lint` | 运行 Biome lint |
| `bun run typecheck` | 检查所有 `@moshu/*` workspace |
| `bun run test:packages` | 运行共享 package 测试 |
| `bun run test:companions` | 运行 Agent Server 和 Runtime Box 测试 |
| `bun run test:tooling` | 运行构建与发布脚本测试 |
| `bun run test:web` | 运行 Desktop Bun/Vitest 测试 |
| `bun run test` | 运行全部测试 |
| `bun run check` | 运行格式检查、lint、类型检查和全部测试 |
| `bun run smoke:companions` | 验证两个 compiled companion 可启动并正常退出 |
| `bun run smoke:three-process` | 验证三角色认证、Chat、Tool、恢复、取消和所有权 |
| `bun run smoke:parent-death` | 验证 Desktop parent 异常退出后 companion 不残留 |
| `bun run smoke:runtime-box-single` | 验证 Remote Runtime Box 单二进制和内嵌资源 |
| `bun run smoke:live-tunnel` | 对真实 Dev Tunnel 执行 opt-in ingress 隔离探针 |
| `bun run --cwd apps/mobile test` | 运行 Mobile Vitest |
| `bun run --cwd apps/mobile typecheck` | 检查 Mobile Web 与构建配置类型 |
| `swift test --package-path apps/mobile/native/MoshuMobile` | 运行原生 Swift core 测试 |

真实 Tunnel 探针需要显式提供 URL：

```bash
MOSHU_LIVE_RUNTIME_BASE_URL='https://example.devtunnels.ms' \
  bun run smoke:live-tunnel
```

`bun run check` 不包含 compiled smoke、真实 Tunnel 或桌面打包；发布流水线必须单独执行对应门。

## Agent runtime

墨枢固定使用 `@earendil-works/pi-ai`、`pi-agent-core` 和 `pi-coding-agent` 0.82.1 的公开 API。

- `ModelRuntime` 动态枚举 builtin Provider，并支持批准的 custom API family。
- Provider credential 只保存在 Agent Server `SecretVaultCredentialStore`。
- 每个 Chat Session 映射到 `agentDataDirectory/sessions` 下的 Pi `SessionManager` JSONL。
- Pi builtin tools、extensions 和动态资源被禁用；七个 Tool 和 live MCP tools 只能经 Moshu Runtime Box gateway、Policy/grant 和 journal 执行。
- Skill prompt 经过 owner/version/hash live validation 后只加载到 Agent 内存，不写入 Product DB、事件或 Pi Session JSONL。

## 当前未实现

- shell sandbox 与 Noise 应用层端到端加密；
- 独立 Git Tool、Diff journal 和 revert；
- Plan、自定义 Agent、subagent、任务中心和桌面通知；
- MCP OAuth 2.1 浏览器授权/DCR、Git URL Skill 更新和完整包导入；
- 云 Push Relay、APNs remote/silent push，以及 suspended/terminated 状态下的可靠移动通知；
- iPad 专用布局、多 Agent Server 聚合和离线业务缓存/消息队列；
- 团队共享、Docker/cloud、多租户和云端 Agent Server；
- 正式外部分发所需的永久 Bundle ID、Apple/桌面平台签名凭据、真实 Tunnel gate 和 App Store 提交流程。

当前仍处于首次外部分发前，不兼容的旧开发数据可以明确 reset；首次发布冻结 schema 后必须使用正式 migration/rollback gate。

## 文档

- [实现状态](./docs/implementation/progress.md)
- [技术架构](./docs/implementation/architecture.md)
- [iOS Mobile Client 实现](./docs/implementation/mobile-client.md)
- [Runtime Box 架构与实现](./docs/implementation/runtime-box.md)
- [Remote Runtime Box 使用文档](./docs/guides/remote-runtime-box.md)
- [数据与接口契约](./docs/implementation/data-contracts.md)
- [质量与发布](./docs/implementation/quality-release.md)
- [产品需求](./docs/product/README.md)

“墨枢”为正式产品名称，项目采用 [MIT License](./LICENSE)。Desktop `dev.moshu.app` 与 Mobile
`dev.moshu.mobile` 都是开发 Bundle ID，正式发布前必须替换为发布方的永久标识。
