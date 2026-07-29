# 墨枢实施计划

> 文档版本：v0.4
> 对应产品需求：[`docs/product`](../product/README.md)  
> 状态：三应用角色架构已批准，尚在迁移；当前代码状态见[实施进度](./progress.md)
> 更新日期：2026-07-25

## 1. 文档导航

| 文档 | 内容 |
| --- | --- |
| [实施进度](./progress.md) | 已实现能力、目标架构迁移状态和下一里程碑 |
| [技术架构](./architecture.md) | 三应用角色、RPC 拓扑、生命周期、职责和安全边界 |
| [数据与接口契约](./data-contracts.md) | 身份、注册、RPC、Run、Action grant、Agent Session 和数据所有权 |
| [Runtime Box 技术与实施方案](./runtime-box.md) | Local/Remote Runtime Box、Agent Server Tunnel、配对、安全、数据模型和实施任务 |
| [Remote Runtime Box 使用文档](../guides/remote-runtime-box.md) | Remote Access、设备配对、远端安装、验证、排障和解除绑定 |
| [工程交付计划](./delivery-plan.md) | 迁移顺序、工作包、依赖和阶段出口 |
| [质量与发布计划](./quality-release.md) | 跨进程测试、故障恢复、安全、打包和发布门槛 |

## 2. 状态与术语

批准的目标架构包含三个主要**应用角色**：

1. **Electrobun client**：桌面 UI、系统集成和本地 companion 监管。
2. **agents server**：业务状态、Agent runtime、Provider、策略和 Run 协调。
3. **Runtime Box**：可安装在本机或远程设备的执行与扩展资源域；`Runtime Box` 是其内部 Tool/进程执行组件。

“三进程”是这三个应用角色的简称，不表示操作系统中永远只有三个 PID。Electrobun 仍可按框架实现创建 launcher、application worker 和 WebView 等进程。

```text
client  <->  agents server  <->  Runtime Box
                      WebSocket + versioned JSON RPC
```

三应用角色基础架构和 agents-server extraction 已落地：desktop 监管两个 compiled companion，Provider、公开
Pi Ask runtime、产品数据库和 Agent Session 均由 agents server 持有。Runtime Box 当前只完成认证注册与
readiness；Tool、MCP 和 Skill 仍是后续目标。[实施进度](./progress.md)只记录代码已经证明的事实。

## 3. 实施目标

迁移先建立稳定的三角色骨架，再继续扩展产品闭环：

```text
RPC / companion binary POC
  -> agents-server extraction
  -> Runtime Box / Agent registry
  -> Tool Bridge / Action Broker
  -> MCP / Skills
  -> recovery / release hardening
```

产品能力仍以“配置 Provider -> Chat/Project -> Ask/Plan/Agent -> 审批执行 -> Diff/撤销 -> 后台与恢复”为主线。架构迁移不能伪装成功状态，也不能通过临时跨角色直连绕过正式 RPC、策略或持久化边界。

## 4. 关键工程决策

| 编号 | 决策 |
| --- | --- |
| DEC-001 | 使用 Bun workspace 和 `bun.lock` 管理 Electrobun 应用、两个 TypeScript companion 及共享包 |
| DEC-002 | Electrobun CLI 负责 client 构建、签名、公证和应用产物；Vite 只负责 React WebView |
| DEC-003 | WebView 不拥有 Agent runtime、数据库、文件、命令或密钥能力，只通过 client 的最小化 typed RPC 访问应用能力 |
| DEC-004 | **已废止**：不再以“默认 in-process、条件触发 sidecar”为基线 |
| DEC-014 | 目标运行时固定为 Electrobun client、agents server、Runtime Box 三个应用角色；两个 companion 均为 TypeScript + Bun 编译二进制并随桌面应用打包 |
| DEC-015 | 应用 RPC 固定为 `client <-> agents server <-> Runtime Box`，使用 WebSocket 和版本化 JSON RPC；client 不直接调用 Runtime Box |
| DEC-016 | `clientId`、`runtimeBoxId` 为可持久稳定身份；每次进程启动/连接注册使用新的 `instanceId` 和递增 `generation`，迟到连接不得覆盖新实例 |
| DEC-017 | agents server 独占产品 DB、Pi Session JSONL、Provider/model credential、Agent definitions/versions、Session/Run/event、Policy/approval 和 Action intent/result；MCP/Skill 只保存 Agent resource reference 与可替换、非权威、可丢弃 inventory cache |
| DEC-018 | 每个 Runtime Box 独占其 MCP config/credential/OAuth/lifecycle、Skill installation/immutable version/content/hash/resource、Tool execution、取消、进程树和 Runtime Box-private local data |
| DEC-019 | server 先决定并持久化策略/审批，再签发一次性 execution grant；Runtime Box 验证 grant 后才执行 |
| DEC-022 | Provider/model credential 永不发送 Runtime Box；MCP credential 由 Runtime Box 自己的 `ExecutorSecretStore` 持久化和加载，连接已认证仍不代表后续 Tool 已获授权 |
| DEC-023 | client 提供完整 MCP/Skill UI；command 经 server 校验 client/Runtime Box identity 与授权后路由到目标 Runtime Box，由 Runtime Box 持久化并返回 redacted result/inventory epoch/revision |
| DEC-024 | 每次 Runtime Box 注册/重连先 full inventory sync；运行期使用 persisted epoch/revision、hint + 60 秒 ±20% poll、delta/tombstone 和 snapshot fallback，对 server disposable cache 做对账 |
| DEC-020 | 当前开发阶段允许重置现有本地数据，不为本次架构重构实现旧数据迁移 |
| DEC-021 | **已修订**：Remote Runtime Box 进入当前实施范围；Mobile Client、Docker、云 VM 和云端 agents server 仍后置 |
| DEC-025 | Runtime Box 是高于 Runtime Box 的产品层级；Session/Project 永久绑定 `runtimeBoxId`，MCP/Skill recoverable state 归 owning Box |
| DEC-026 | Agent Server 管理持久 Anonymous Dev Tunnel 和独立 Runtime ingress；Desktop 只提供 UI 和进程 supervisor |
| DEC-027 | Remote Box 使用一次性配对码、Ed25519 双向设备身份、Upgrade challenge、防重放和持久 generation fence |
| DEC-028 | active Runtime 是 Agent Server 全局 revisioned 状态；只影响列表和新建默认值，既有 Run 永远按 Session Box 路由 |
| DEC-005 | 不向模型暴露裸 `LocalShellBackend.execute`；文件、命令、Git 和扩展副作用全部经 Tool Bridge / Action Broker |
| DEC-006 | 产品数据库使用 `bun:sqlite`；conversation context 使用公开 Pi `SessionManager` JSONL，两者均由 agents server 管理 |
| DEC-007 | UI 只读取规范化持久事件，不依赖 Pi SDK 内部事件结构 |
| DEC-008 | Ask、Plan、Agent 通过有效工具集和 Policy Engine 强制区分，不只靠系统提示词 |
| DEC-010 | Web Canvas 使用无应用 RPC 的独立 sandbox BrowserView/partition，并通过专项 POC 验证隔离 |
| DEC-011 | Provider、MCP、Skill 和知识库通过稳定 Port 接入，SDK 类型不得穿透角色边界 |
| DEC-012 | Electrobun、Bun、公开 Pi SDK 和 RPC protocol 精确锁版本并成组验证 |
| DEC-013 | server Provider/model `SecretVault` 使用稳定 Port；首发 macOS 使用经审查的 Keychain adapter，不提供明文或弱加密回退 |

## 5. 角色所有权摘要

| 领域 | 唯一所有者 | 其他角色如何访问 |
| --- | --- | --- |
| UI、窗口、菜单、更新、companion 监管 | client | client 内部 Electrobun RPC；业务通过 agents server |
| 产品 DB、Pi Session JSONL、Provider、Agent、Session/Run、Policy/Action | agents server | 版本化 RPC；Runtime Box 不直连产品数据 |
| Provider 访问和 Agent runtime | agents server | client 发起 Run；server 调度到已注册 Runtime Box |
| Policy、approval、Action intent/result | agents server | client 展示/提交审批；Runtime Box 接收一次性 grant |
| Tool、命令、文件、Git 实际执行 | Runtime Box 内部 Executor | 仅接受 server 授权的 invocation |
| MCP config、credential/OAuth、连接/进程、Tool inventory | owning Runtime Box | client command 经 server 路由；server 只同步可替换、非权威、可丢弃 inventory cache |
| Skill install、immutable version/content/hash/resources/scripts | owning Runtime Box | Agent 只保存稳定 resource ref；server 按 ref 获取 metadata/`SKILL.md` |
| Provider/model Secret | agents server `SecretVault` | 永不发送 Runtime Box |
| MCP Secret | Runtime Box `ExecutorSecretStore` | 不复制到 server；不通过 query/UI/prompt/log/diagnostic/export 返回 |

当前代码只有一个 host-backed local Runtime Box；目标模型允许一个 Agent Server 管理多个 Local/Remote Runtime
Box。Agent 与 Provider 全局共享，每个 `agentId + runtimeBoxId` 使用独立 Runtime Profile。完整迁移见
[Runtime Box 技术与实施方案](./runtime-box.md)。

Agent 与 Provider 全局共享；每个 `agentId + runtimeBoxId` 的 Runtime Profile 只能引用该 Box 拥有的
MCP/Skill，引用形态为 `runtimeBoxId + stableResourceId + version/hash`。server 构建或恢复 Agent 时按引用从
Runtime Box 获取 Skill metadata/`SKILL.md`；缺失、hash/version 不匹配或 Box offline 都 fail closed。

每次 Runtime Box connection/registration/reconnect 后，server 必须先 full sync redacted inventory，成功前状态为 syncing、Agent 不 runnable。之后 Runtime Box 用 revision/category-only hint 提醒，server 去抖增量拉取，并每 60 秒 ±20% jitter 主动对账；gap、compaction、epoch reset 或 invalid cursor 回退 full snapshot。cache 离线时只标 stale，失败 poll 不代表删除，Run 仍 live 验证 resource/version/hash。

本地 desktop Runtime Box 首个实现可把 MCP/Skill 数据保存在 Runtime Box-private data root：根目录 `0700`，credential file `0600`，原子替换并验证 owner，拒绝 symlink，平台支持时使用 no-follow。这只能防范其他普通本机用户，不能防御同账户 malware、root 或磁盘 snapshot/backup；因此通过 `ExecutorSecretStore` Port 保留 Keychain、Docker Secret、cloud secret manager 等未来 adapter。

## 6. 实施原则

1. **目标与现状分开**：目标文档使用“应/将”；进度文档只写已实现证据。
2. **所有权唯一**：同一持久状态或本机资源只能有一个写入所有者。
3. **协议先行**：先冻结身份、版本、错误、取消和背压，再迁移业务逻辑。
4. **策略先于执行**：任何 Tool 都先完成风险、审批、grant、幂等和审计合同。
5. **持久化先于推送**：server 先落库，再向 client 推送事件。
6. **恢复先于扩容**：单 server/单 Runtime Box 的断线、重启和副作用恢复通过后，再开放更多部署方式。
7. **不夸大隔离**：角色拆分不是完整 OS 沙箱；权限仍由 Policy、grant 校验、路径/命令约束和系统权限共同实现。

## 7. 推荐技术基线

| 领域 | 基线 |
| --- | --- |
| Client | Electrobun `1.18.1`、React 19、React Router、HeroUI、Tailwind CSS v4 |
| Companions | TypeScript strict + Bun，编译为 `agents-server`、`Runtime Box` 二进制并随应用签名打包 |
| Application RPC | WebSocket + versioned JSON RPC + Zod；动态 loopback endpoint；注册握手和连接身份 |
| Agent | `@earendil-works/pi-ai`、`pi-agent-core`、`pi-coding-agent` `0.82.1` 公开 API；只在 agents server 运行 |
| App DB | `bun:sqlite` + Drizzle，仅 agents server 写入 |
| Agent Session | Pi `SessionManager` JSONL，位于 app-owned `agentDataDirectory/sessions` |
| Secret | server `SecretVault` 只保存 Provider/model credential；Runtime Box `ExecutorSecretStore` 保存 MCP credential |
| Execution | Runtime Box Tool Bridge、MCP/Skill manager、Runtime Box-private DB/data root、进程树和取消 |
| Test | `bun test`/Vitest、RPC contract、三角色 integration、packaged desktop E2E |
| Logging | 三角色结构化日志、统一 correlation ID 和中央脱敏规则 |

终端用户不需要安装 Bun。两个 companion 必须作为应用产物的一部分构建、签名、校验和更新，不能在首次运行时从网络下载 runtime。

## 8. 桌面生命周期基线

- client 启动并监管一个本地 agents server 和一个本地 Runtime Box。
- agents server 在桌面模式只绑定 loopback 动态端口；client 通过受控 bootstrap 获得 endpoint 和一次性注册材料。
- client 与 Runtime Box 分别连接 agents server 并注册稳定身份、当前 `instanceId` 和 `generation`。
- companion 异常退出时，client 使用有上限的指数退避重启；达到上限后停止 crash loop，并显示恢复、重试或导出诊断入口。
- client 退出时先阻止新 Run，协作式请求 server/Runtime Box shutdown，等待持久化和进程树清理；超时后才升级终止。
- 未来可独立启动 client/Runtime Box 并向 agents server 注册；当前只实现本地 desktop supervisor 路径。

完整状态机和故障语义见[技术架构](./architecture.md)与[数据契约](./data-contracts.md)。

## 9. 交付阶段摘要

| 阶段 | 工程出口 |
| --- | --- |
| A0 RPC / binary POC | 两个编译 companion 可由 client 启停；动态 loopback、版本握手、注册、request/response/event、取消可验证 |
| A1 agents-server extraction | Provider、Pi Ask runtime、产品 DB/Session JSONL 和现有 Chat contract 迁入 server；client 仅保留 UI/桌面职责（已完成） |
| A2 Runtime Box / Agent registry | 稳定身份、instance/generation、注册 full capability sync、Agent N:1 绑定、syncing/offline Run gate 和列表 UX |
| A3 Tool Bridge / Action Broker | server policy/approval/intent/result、一次性 grant、Runtime Box 实际 Tool/进程树、幂等恢复 |
| A4 MCP / Skills | Runtime Box-owned config/credential/lifecycle/Skill store，epoch/revision inventory reconciliation，routed UI、resource refs 与 fail-closed prompt fetch |
| A5 Recovery / release hardening | capped restart、断线重连、故障注入、协作退出、签名/公证/更新和 packaged E2E |

功能路线图继续使用产品 Phase 0–4；上述 A0–A5 是实现依赖主线，不是新的产品承诺。详见[工程交付计划](./delivery-plan.md)。

## 10. 当前数据处理

本次架构迁移发生在开发阶段。旧 runtime 数据、Provider 开发配置和本地 fixture **不要求迁移**；当前实现使用
产品 DB 与 Pi Session JSONL，可升级 schema 并在不兼容时明确重置开发数据。不得因此弱化未来正式发布后的
migration/backup 纪律。

## 11. 参考资料

- [Electrobun](https://github.com/blackboardsh/electrobun)
- [Electrobun 1.18.1 Architecture](https://github.com/blackboardsh/electrobun/blob/v1.18.1/docs/src/content/docs/electrobun/guides/architecture/overview.mdx)
- [Bun Compile](https://bun.sh/docs/bundler/executables)
- [Bun SQLite](https://bun.com/docs/runtime/sqlite)
- [Pi mono repository](https://github.com/badlogic/pi-mono)
- [Agent Skills Specification](https://agentskills.io/specification)
