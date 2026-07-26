# 实施进度

> 更新日期：2026-07-25
> 当前产品阶段：Phase 0
> 当前架构里程碑：A0 RPC / companion binary POC（未开始）
> 当前代码基线：单进程 Ask Chat 切片
> 对应基线提交：`dac37bd`

本文只记录代码或自动化测试已经证明的能力。批准的目标见[技术架构](./architecture.md)，工作顺序见[工程交付计划](./delivery-plan.md)。

## 1. 两种状态必须分开

| 口径 | 状态 |
| --- | --- |
| 批准的目标架构 | Electrobun client、agents server、executor 三个应用角色 |
| 当前仓库实现 | 单个 Electrobun Application Host 内的 ChatService、Deep Agents Ask、Provider 和 SQLite/checkpoint |

因此，文档中关于 WebSocket、动态 loopback、companion supervisor、Executor registry、execution grant、MCP/Skill split 的描述都是**待实现目标**，不是当前能力。

“三进程”表示三个应用角色；Electrobun framework 自身仍可能有 launcher、application worker 和 WebView 等额外进程。

## 2. 状态口径

| 状态 | 含义 |
| --- | --- |
| 已完成 | 目标工作包已落地，且对应自动化出口通过 |
| 部分完成 | 有可运行切片，但关键合同或目标角色边界尚未完成 |
| 未开始 | 没有可作为目标工作包验收依据的实现 |
| 延后 | 已明确需要，按当前优先级推迟 |

旧单进程能力可作为迁移输入，但不能让目标三角色工作包标记为部分完成。

## 3. 当前已经实现：单进程 Ask Chat

当前实际链路：

```text
React Chat UI
  -> typed Electrobun RPC
  -> Application Host ChatService
  -> in-process Deep Agents Ask runtime
  -> OpenAI-compatible Provider
  -> SQLite SessionCatalog / RunJournal
  -> independent LangGraph checkpoint DB
  -> Electrobun RPC event stream
  -> UI reconciliation
```

已验证能力：

- `/settings/providers` 支持一个 OpenAI-compatible 配置的保存、保留/替换 Key、连接测试和删除。
- Provider 开发配置写入 app-data JSON，使用原子替换和 `0600` 权限；WebView 只读掩码。
- 普通 Chat 支持流式回复、停止、继续已有 Session 和失败状态。
- Session 支持新建、选择、搜索、标题、重命名、归档/恢复和永久删除。
- `/chat/new` 与 `/chat/:sessionId` 是当前 Session 选择事实来源。
- 默认 Ask 路径通过仓内 `@moshu/deepagents` 的 `createDeepAgent` 执行。
- `BunSqliteSaver` 使用独立 checkpoint DB、WAL 和当前 schema，并覆盖 thread/list/pending writes/delete/重开合同。
- 当前 Ask 不暴露 Tool；filesystem、todo、subagent 和 HITL 被显式禁用。
- Session 映射稳定 checkpoint thread；conversation transcript 来自 checkpoint，业务 DB 保存 SessionCatalog/RunJournal。
- typed RPC 与 Zod 已覆盖当前 Chat command、query、snapshot 和 event。
- 事件先持久化再发布；UI 可用 snapshot、cursor 和 reconciliation 处理重放。
- 取消链路覆盖 UI、RPC、Application Host、`AbortController` 和持久 Run 状态。
- 应用重启后遗留的 `queued/running/cancelling` Run 当前收敛为取消。
- Runtime、Repository、ChatService、RPC adapter/controller 和页面有自动化测试。

这些证据证明 Ask slice 可运行，不证明目标 agents server/executor 已存在。

## 4. 当前明确未实现

- 没有独立 `agents-server` 或 `executor` compiled binary。
- 没有 `client <-> agents server <-> executor` WebSocket/JSON RPC。
- 没有动态 loopback bootstrap、角色认证、stable ID、instance ID 或 generation registry。
- client 尚未监管两个 companion，也没有 capped backoff/recovery UX 或协作式三角色退出。
- Deep Agents、Provider、业务 DB 和 checkpoint 仍在 Electrobun Application Host，而非 agents server。
- 没有 Executor/Agent N:1 registry、executor 列表或 offline Run gate。
- 没有 Tool Bridge、Action Broker、Policy Engine、approval、execution grant 或 invocation reconciliation。
- 没有 Project 文件/命令/Git Tool、Diff/撤销、任务中心或桌面通知。
- 没有 MCP lifecycle 或 Skill storage/prompt/execution split。
- checkpoint 尚未接入 application 强退后的 graph resume；orphan Run 当前只安全收敛为取消。
- Secret Vault/Keychain 尚未接入；开发期 Provider Key 仍在 Host 管理的本地配置。
- 没有 signed/packaged three-role desktop E2E。

## 5. 架构迁移状态

| 阶段 | 状态 | 下一项可验证结果 |
| --- | --- | --- |
| A0 RPC / binary POC | 未开始 | client 启动两个 Bun compiled companion，完成动态 loopback 注册、RPC 和关闭 |
| A1 agents-server extraction | 未开始 | 现有 Provider/Ask/DB/checkpoint 经 server RPC 保持行为等价 |
| A2 Executor / Agent registry | 未开始 | 一个 local executor、多 Agent 绑定、注册后 full capability sync 和 offline Run gate |
| A3 Tool Bridge / Action Broker | 未开始 | server policy/approval/intent/grant -> executor Tool -> server result |
| A4 MCP / Skills | 未开始 | executor-owned MCP/Skill data、epoch/revision inventory reconciliation、routed UI 和 resource refs |
| A5 Recovery / release hardening | 未开始 | capped restart、kill matrix、协作退出、签名 package |

旧 `F0-16 条件性 sidecar POC` 已从计划中删除。旧 `DEC-004` 和 `ARC-011` 的“先保持 in-process、实测失败再决定 sidecar”口径已被批准的三角色架构取代。

## 6. 下一里程碑：A0 RPC / Binary POC

本里程碑只证明进程、协议、身份和 package 基线，不迁移完整业务。

目标链路：

```text
Electrobun client supervisor
  -> start agents-server binary
  -> receive dynamic loopback bootstrap
  -> client register
  -> start executor binary
  -> executor register
  -> versioned JSON RPC request/event/cancel
  -> cooperative shutdown
```

出口：

- client、agents-server、executor 三个角色在开发和 package 中都可识别。
- 两个 companion 是 TypeScript + Bun compiled binaries，终端用户无需安装 Bun/Node。
- server 只绑定动态 loopback；未认证本机进程不能注册。
- `clientId`/`executorId` 可稳定恢复；每次启动/注册使用新 `instanceId` 和 generation。
- 旧 generation 的 event/response 被拒绝。
- client 分别监管 server/executor，异常使用 capped backoff；达到上限停止 crash loop。
- 正常退出先协作关闭，超时才升级终止。
- stable package 无固定 token、测试 method 或调试 listener。

完成 A0 后再开始 A1，不在 POC 中提前复制当前业务 DB 或 Agent runtime。

## 7. 迁移约束

- A1 按领域一次切换一个唯一 writer，禁止 client/server 双写业务 DB。
- 当前 Ask UI 和用户行为在 A1 保持等价；transport 变化不应被包装为产品新功能。
- A2 前不在 UI 硬编码“executor 总在线”；registry 是可用性事实来源。
- A3 前继续保持 Ask 无 Tool，不加入可绕过 grant 的临时文件/命令 API。
- A4 复用 A3 Action/grant，不为 MCP/Skill 建旁路。
- A5 前不把架构迁移描述为可外部分发完成。

## 8. 开发数据策略

本次重构不迁移当前 `app.db`、checkpoint、Provider 开发配置或旧 fixture。目标实现可在 schema 不兼容时提供明确 reset；不得静默误读，也不得宣称已完成跨版本迁移。

该例外只适用于开发阶段。首次外部发布后，数据库升级仍必须遵守 backup、migration、rollback 和 fixture gate。

## 9. 当前功能优先级

在 A0/A1 期间：

- 现有 Provider 设置、普通 Chat、Session 和无 Tool Ask 保持可用、可测试。
- 新的 Agent 写操作、命令、MCP 或 Skill 执行不得先于 A3/A4。
- Keychain 仍是外部分发前门槛；迁移期开发配置不宣称是安全保险库。
- graph resume、Policy、Action recovery 和 packaged E2E 仍是发布阻断项。
