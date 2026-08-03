# 实现状态

> 更新日期：2026-08-03
> 产品阶段：首次外部分发前 POC
> 架构状态：Desktop、Agent Server、Local/Remote Runtime Box 与 iOS Mobile Client 已形成可运行闭环

本文只记录当前代码和仓库内自动化可以证明的事实。架构约束见[技术架构](./architecture.md)，协议和数据定义见
[数据与接口契约](./data-contracts.md)。

## 1. 当前部署

| 组件 | 当前实现 |
| --- | --- |
| Desktop Client | Electrobun + React；监管本地 Agent Server 与 Local Runtime Box 两个 compiled companion |
| Agent Server | Product/Runtime/Mobile 三个独立 RPC listener；业务 DB、Pi runtime、Provider、Policy 和调度中枢 |
| Local Runtime Box | Desktop bootstrap 启动；loopback Runtime ingress；默认 `request-cwd` execution scope |
| Remote Runtime Box | standalone CLI/user service；Dev Tunnel Runtime port；Ed25519 配对认证；默认 private workspace |
| iOS Mobile Client | Capacitor Web UI + Swift transport；Dev Tunnel Mobile port；Keychain 设备身份；内存业务状态 |

同一个 Agent Server registry 可同时管理 Local 与 Remote Box。Desktop supervisor 不启停 Remote Box；Desktop
退出后 Agent Server/Tunnel 停止，Remote Box 和 Mobile Client 等待其恢复。

## 2. 已实现能力

| 领域 | 已实现事实 | 主要代码 |
| --- | --- | --- |
| Companion 生命周期 | 构建、受控 bootstrap、认证、协作关闭、capped restart、parent-death cleanup | `apps/desktop/src/bun/companion-process-supervisor.ts` |
| RPC | browser-safe core、Bun adapter、角色 allowlist、limits、cancel、event replay、generation fence | `packages/process-rpc-core`、`packages/process-rpc` |
| Agent Server | Provider/model、Pi headless Agent Session、Chat/Project、Run/event、Session cleanup | `apps/agents-server`、`packages/agent-runtime` |
| Runtime registry | Local/Remote descriptor、持久 generation、client preference、Session/Project/Run Box placement | `runtime-box-registry.ts`、`packages/database` |
| Tool execution | `read`、`bash`、`edit`、`write`、`grep`、`find`、`ls`、取消、输出限制、进程树 | `apps/runtime-box/src/tool-handler.ts`、`tools/` |
| Authorization | server-authoritative risk、durable approval、Session Allow all、Action intent、single-use grant | `approval-service.ts`、`action-authorization-service.ts` |
| Recovery | JSON invocation journal、deadline lease、`outcome_unknown`、evidence/receipt reconciliation | `invocation-journal.ts`、`runtime-box-registry.ts` |
| Projects | Local/Remote path validation、Project Session、path health/relink、root `AGENTS.md`、`project-root` scope | `project-application-service.ts` |
| MCP | Server-owned 与 Box-owned authority、stdio/Streamable HTTP/SSE、Tool schema、Action/grant bridge | `packages/mcp-runtime`、`runtime-resource-store.ts` |
| Skills | prompt-only Server Skill、immutable Box Skill package、global/Runtime Profile、live hash validation | `packages/skill-runtime`、`packages/database` |
| Inventory | reconnect full snapshot、hint debounce、delta/tombstone、48–72 秒 poll、snapshot fallback、stale cache | `runtime-box-registry.ts`、`runtime-box-inventory-repository.ts` |
| Remote access | Microsoft device-code、单 Tunnel 双端口、pairing、signed challenge、revoke、HTTP 426 | `dev-tunnel-service.ts`、`runtime-ingress-auth.ts` |
| Mobile | Chat/Project、Runtime selection、Approval、attention/unread、best-effort notification、reconnect | `apps/mobile`、`mobile-ingress-composition.ts` |
| Packaging | standalone companions、embedded `rg`/`fd`/Photon、package manifests、release gates | `scripts/`、`apps/desktop/scripts/` |

## 3. 持久状态与路由

- Product DB 保存结构化 Session、Project、Run/event、Approval、Action、Runtime catalog 和 Mobile attention。
- Pi `SessionManager` JSONL 保存 conversation context；Product DB 只保存定位它的 `piSessionId` 等元数据。
- `app_settings.active_runtime_box_id` 是无 Client preference 时的全局默认；
  `client_runtime_box_preferences` 记录每个 authenticated Client 的独立选择。
- Project 创建时绑定一个 Box；Project Session 继承 Project Box；普通 Session 使用请求值或发起 Client preference；
  Run 再从 Session 继承并保存 `runtimeBoxId` 快照。
- Local 与 Remote Box 使用同一 Tool/resource/journal 实现，但分别使用 Desktop bootstrap data root 与 Remote
  private data root。invocation journal 是 `invocations.json`，不是 Runtime Box SQLite 表。
- Runtime Box-owned MCP/Skill 的权威状态只在该 Box；Agent Server 仅保留可替换 inventory projection 和稳定 ref。
- Runtime Box 和 Mobile Client 都使用数据库持久化的 generation high-water mark；Agent Server 重启不会清空 fence。

## 4. 明确限制

- 没有 shell sandbox。所有 `bash` 都必须单独审批且不可被 Session Allow all 绕过，但批准后仍以 Box OS 用户执行。
- Remote/Mobile 传输当前使用 Dev Tunnel TLS + 应用层设备签名；Microsoft Relay 可见 payload，Noise 尚未实现。
- iOS 不落业务数据、不离线排队；无 Push Relay/APNs，suspended/terminated 状态不保证通知。
- Provider vault 当前是权限加固文件，macOS Keychain adapter 仍是外部分发前工作。
- 独立 Git Tool、Diff journal/revert、Plan、自定义 Agent、subagent、任务中心和桌面通知尚未实现。
- MCP OAuth 2.1 browser flow/DCR、Git URL Skill 更新和完整包导入 UI 尚未实现。
- 团队共享、多 Agent Server 聚合、Docker/cloud Runtime Box、云端 Agent Server和多租户不在当前范围。
- 真正的跨 Box Session/Project 迁移未实现；切换 preference 不会移动既有数据。

## 5. 外部发布前阻塞项

1. 在有 Microsoft 登录状态的环境执行真实 Dev Tunnel 隔离与兼容性探针。
2. 在 macOS/Windows/Linux release runner 执行正式签名、公证、installer 和安装级 E2E。
3. 完成 Provider vault 的发布级平台 Secret adapter。
4. 为 Desktop 与 Mobile 设置永久应用标识，并完成真实设备签名与 App Store/分发流程。
5. 首次外部发布前冻结 schema，并建立正式 migration、backup 和 rollback gate。
