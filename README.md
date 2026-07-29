# 墨枢

墨枢是一款 Local-first 桌面 Agent 应用。当前仓库处于首次外部分发前的 POC 阶段，三应用角色架构和 Local/Remote Runtime Box 平台已经落地。

## 当前能力

- **Desktop Client**：Electrobun + React 桌面界面，负责窗口、设置、Runtime Box 切换和本地 companion 监管。
- **Agent Server**：独占 Provider、Agent runtime、Session、Project、Run/event、Policy/Action、产品数据库和 Pi Session JSONL。
- **Runtime Box**：在本机或远程设备执行 `read`、`bash`、`edit`、`write`、`grep`、`find`、`ls`，并拥有自己的 MCP、Skills、credential、journal 和 workspace。
- **Remote Runtime Box**：通过 Agent Server 管理的 Anonymous Microsoft Dev Tunnel 主动连接，使用一次性配对码、Ed25519 双向身份、generation fence 和版本协商。
- **多 Box 路由**：切换 Runtime Box 后，界面切换到该 Box 对应的 Session、Project、MCP 和 Skills；既有 Session/Run 永远按持久归属路由，不随全局选择迁移。
- **MCP 与 Skills**：支持 MCP stdio、Streamable HTTP、兼容 SSE、Box 私有 SecretStore、immutable Skills、Runtime Profile 和 inventory full/delta reconciliation。
- **恢复与发布门**：durable Action intent、单次 grant、fsync journal、未知结果对账、进程树清理、协议升级状态、脱敏诊断、流量估算及签名 package/update gate。

## 架构

```text
React WebView
  <-> typed Electrobun RPC
Electrobun Client
  <-> authenticated WebSocket JSON RPC
Agent Server
  <-> authenticated Runtime RPC
Local Runtime Box

Remote Runtime Box
  -> HTTPS / WebSocket
  -> Anonymous Dev Tunnel
  -> Agent Server Runtime ingress
```

“三角色”描述应用职责，不表示操作系统中永远只有三个 PID。Electrobun 仍会创建 launcher、application worker 和 WebView 等框架进程。

数据所有权：

| 领域 | 所有者 |
| --- | --- |
| Provider、Agent、Session、Project、Run/event、Policy/Action | Agent Server |
| MCP config/credential/lifecycle、Skills、Tool 执行、workspace | owning Runtime Box |
| UI、窗口、Updater、本地 companion supervisor | Desktop Client |

Remote Tunnel 只公开 Runtime ingress，不公开 Product RPC、Provider 或数据库接口。

## POC 安全边界

当前版本中，完成设备认证并绑定的 Remote Runtime Box 完全信任其 Agent Server，包括执行 `bash`。用户级命令审批和 shell sandbox 后置；现有 grant 用于 durable dispatch、单次消费、generation fencing 和恢复，而不是交互审批。

Remote path tools 仍执行 canonical workspace containment；Remote `bash` 按当前信任决策不受该限制。

## 环境

仓库开发环境：

- macOS 14+
- Bun 1.3.14
- Electrobun 1.18.1

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

## 目录

```text
apps/
  desktop/          Electrobun Client 与 React WebView
  agents-server/    Agent Server、Product RPC、Runtime ingress、Dev Tunnel
  runtime-box/      Local/Remote Runtime Box、Tools、MCP、Skills、用户服务

packages/
  contracts/        跨角色 Zod contract 与 RPC allowlist
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

主要产物：

```text
apps/agents-server/dist/
apps/runtime-box/dist/
apps/desktop/dist/mainview/
apps/desktop/build/
apps/desktop/artifacts/
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

- 用户级命令审批与 shell sandbox；
- 独立 Git Tool、Diff journal 和 revert；
- Plan、自定义 Agent、subagent、任务中心和桌面通知；
- MCP OAuth 2.1 浏览器授权/DCR、Git URL Skill 更新和完整包导入；
- Mobile Client、团队共享、Docker/cloud、多租户和云端 Agent Server；
- 正式外部分发所需的真实 Tunnel、三平台签名 runner 和 macOS Keychain release gate。

当前仍处于首次外部分发前，不兼容的旧开发数据可以明确 reset；首次发布冻结 schema 后必须使用正式 migration/rollback gate。

## 文档

- [实施进度](./docs/implementation/progress.md)
- [技术架构](./docs/implementation/architecture.md)
- [Runtime Box 技术与实施方案](./docs/implementation/runtime-box.md)
- [Remote Runtime Box 使用文档](./docs/guides/remote-runtime-box.md)
- [数据与接口契约](./docs/implementation/data-contracts.md)
- [质量与发布计划](./docs/implementation/quality-release.md)
- [产品需求](./docs/product/README.md)

“墨枢”为正式产品名称，项目采用 [MIT License](./LICENSE)。当前 Bundle ID `dev.moshu.app` 仅用于开发，正式发布前必须替换为发布方的永久标识。
