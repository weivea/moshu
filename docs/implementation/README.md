# 墨枢工程文档

> 文档版本：v0.6
> 对应产品需求：[`docs/product`](../product/README.md)
> 状态：Desktop、Local/Remote Runtime Box、独立 Mobile ingress 与 iOS Mobile Client 已实现
> 更新日期：2026-08-03

## 1. 文档导航

| 文档 | 权威范围 |
| --- | --- |
| [实现状态](./progress.md) | 当前代码已实现能力、明确限制和外部发布阻塞项 |
| [技术架构](./architecture.md) | 应用角色、物理部署、RPC 拓扑、生命周期、职责和安全边界 |
| [数据与接口契约](./data-contracts.md) | 身份、注册、RPC、Run、Approval/grant、数据表和所有权 |
| [Runtime Box 架构与实现](./runtime-box.md) | Local/Remote Box、Tunnel、配对、执行、私有存储和恢复 |
| [iOS Mobile Client 实现](./mobile-client.md) | Mobile ingress、iOS App、Keychain、RPC 恢复、attention 和通知边界 |
| [Projects 与 Project Chat](./project-management.md) | Project 生命周期、Session 归属、路径检查和 Tool scope |
| [MCP 双归属接入](./mcp-integration.md) | Server-owned/Box-owned MCP 的所有权、生命周期和调用链 |
| [Skill 双归属管理](./skill-integration.md) | prompt-only Server Skill 与完整 Box Skill package |
| [质量与发布](./quality-release.md) | 跨角色测试、故障恢复、安全、打包和发布门槛 |
| [Remote Runtime Box 指南](../guides/remote-runtime-box.md) | 终端用户配对、安装、验证、排障和解除绑定 |

产品需求和路线图描述“要做什么”；本目录描述“当前系统如何工作”。当前实现证据只写入
[实现状态](./progress.md)，避免把历史计划或目标接口误写成已交付能力。

## 2. 当前运行模型

```text
Desktop React WebView
  <-> Electrobun RPC
Desktop Client
  <-> loopback Product RPC
Agent Server
  <-> loopback Runtime ingress
Local Runtime Box

iOS Mobile Client
  <-> Dev Tunnel Mobile port
  <-> Mobile ingress
Agent Server

Remote Runtime Box user service
  <-> Dev Tunnel Runtime port
  <-> Runtime ingress
Agent Server
```

- **三角色**是 Client、Agent Server、Runtime Box 的职责边界，不是固定 PID 数量。
- Client 目前有 Desktop 与 iOS 两种实现；二者共享 Agent Server 业务事实，但使用不同入口和权限。
- Desktop supervisor 只启停本地 Agent Server 与 Local Runtime Box，不管理 Remote Box 进程。
- Agent Server 使用 Product、Runtime、Mobile 三个独立 loopback listener；同一个 Dev Tunnel 只转发后两个端口。
- Local 与 Remote Box 复用 Tool/MCP/Skill 执行核心，但使用不同 bootstrap、身份、数据根和重连生命周期。

## 3. 所有权摘要

| 数据或资源 | 唯一所有者 |
| --- | --- |
| Product DB、Provider、Agent runtime、Session/Project/Run/event | Agent Server |
| Policy、Approval、Action intent/result、execution grant | Agent Server |
| Pi conversation context JSONL | Agent Server 管理的 Pi `SessionManager` |
| Server-owned MCP 与 prompt-only Skill | Agent Server |
| Box-owned MCP、完整 Skill package、Tool、workspace、journal | owning Runtime Box |
| Runtime Box inventory cache | Agent Server 的可丢弃、非权威 projection |
| Desktop 窗口、Updater、本地 companion supervisor | Desktop Client |
| iOS private key 与单 Server binding | iOS Keychain |

Product DB 保存结构化业务状态，Pi JSONL 保存 conversation context；两者不是同一数据的双写镜像。
Runtime Box 不读取 Product DB，Agent Server 也不保存可恢复的 Box-owned MCP/Skill/Secret 副本。

## 4. 关键运行不变量

1. `clientId`、`mobileClientId`、`runtimeBoxId` 是稳定身份；每次连接使用新的 `instanceId` 和单调 `generation`。
2. Runtime Box 与 Mobile generation high-water mark 均持久化；旧连接不能在 Server 重启后复活。
3. 每个 Client 的 active Runtime preference 独立；没有 preference 时才回退 `app_settings` 全局默认。
4. Session、Project、Run 创建后持久绑定 `runtimeBoxId`；切换 preference 不迁移既有对象。
5. Runtime Box 注册/重连先 full inventory sync；之后使用 hint、delta 和 60 秒 ±20% poll 对账。
6. Policy/Approval 与 Action intent 先持久化，Runtime Box 只执行有效的一次性 grant。
7. Local 默认 `request-cwd`、Remote 默认 Box workspace、Project 使用 `project-root`；`bash` 仍不是 shell sandbox。
8. Mobile 只能调用独立 allowlist，不能管理 Provider、Remote Access、Runtime pairing、MCP/Skill 或 Project path。

## 5. 技术基线

| 领域 | 当前基线 |
| --- | --- |
| Desktop | Electrobun `1.18.1`、React 19、React Router、HeroUI、Tailwind CSS v4 |
| Mobile | Capacitor 8、React/Vite、iOS 15+、Swift `MoshuMobileTransport` |
| Companions | TypeScript strict + Bun compiled binaries |
| RPC | WebSocket + versioned JSON RPC + Zod；browser-safe core 位于 `@moshu/process-rpc-core` |
| Agent | Pi `0.82.1` public API，仅运行于 Agent Server |
| Product DB | `bun:sqlite` + Drizzle，仅 Agent Server 写入 |
| Runtime resources | Box-private SQLite、immutable Skill files、SecretStore、JSON invocation journal |
| Security | Ed25519 device identity、持久 generation fence、server-authoritative approval、single-use grant |

终端用户不需要安装 Bun 或 Node。Desktop 将两个 companion 随应用一起构建、签名、校验和更新；Remote Box
使用匹配目标平台的 standalone binary。

## 6. 当前数据与发布口径

项目仍处于首次外部分发前。开发数据在不兼容时可以明确 reset；首次外部发布冻结 schema 后，升级必须使用正式
migration、backup 和 rollback gate。真实 Dev Tunnel、macOS/Windows 正式签名、公证、安装级 E2E 和 App Store
提交需要外部账号或凭据，不能由本地 canary 结果替代。

## 7. 参考资料

- [Electrobun](https://github.com/blackboardsh/electrobun)
- [Bun Compile](https://bun.sh/docs/bundler/executables)
- [Bun SQLite](https://bun.com/docs/runtime/sqlite)
- [Pi mono repository](https://github.com/badlogic/pi-mono)
- [Agent Skills Specification](https://agentskills.io/specification)
