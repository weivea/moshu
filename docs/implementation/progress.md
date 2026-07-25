# 实施进度

> 更新日期：2026-07-25
> 当前阶段：Phase 0 进行中
> 当前里程碑：W1 普通 Chat + Deep Agents Ask 首个可运行切片
> 对应基线提交：`dac37bd`

本文只记录已经落地并可由代码或自动化测试证明的能力。目标、依赖和完整工作包仍以[工程交付计划](./delivery-plan.md)为准。

## 1. 状态口径

| 状态 | 含义 |
| --- | --- |
| 已完成 | 工作包范围已落地，当前阶段不再依赖临时实现 |
| 部分完成 | 已有可运行切片，但仍缺少工作包中的关键合同或出口验证 |
| 未开始 | 尚无可作为该工作包验收依据的实现 |
| 延后 | 已明确需要，但按当前产品优先级推迟到后续里程碑 |
| 未触发 | 条件工作包的触发条件尚未成立 |

POC 完成不等于对应 Phase 工作包或阶段出口完成。

## 2. 当前已完成：Ask Chat POC 与 W1 核心切片

当前代码已经打通以下链路：

```text
React Chat UI
  → typed Electrobun RPC
  → Application Host ChatService
  → Deep Agents Ask runtime
  → OpenAI-compatible Provider
  → SQLite SessionCatalog / RunJournal + 独立 LangGraph conversation checkpoint
  → RPC event stream
  → UI reconciliation
```

已验证能力：

- Provider 设置页：`/settings/providers` 支持单个 OpenAI-compatible 配置的保存、保留/替换 Key、连接测试和删除。
- Provider 开发期持久化：配置写入 app-data JSON，使用原子替换和 `0600` 权限；WebView 只读取 Key 掩码。
- 普通 Chat：配置 Provider 后可发送消息、接收流式回复、停止当前 Run，并继续已有 Session。
- Session 管理：支持新建、选择、搜索、首条消息标题、重命名、归档/恢复和永久删除。
- 路由恢复：`/chat/new` 与 `/chat/:sessionId` 是选择事实来源；启动时会验证并恢复最近 Session 提示。
- 真实 Provider Adapter：通过 LangChain `ChatOpenAI` 接入 OpenAI-compatible HTTP/SSE，不只依赖前端模拟。
- 默认 Ask 路径实际通过 Deep Agents `createDeepAgent` 执行，不再调用 LangChain `createAgent`；Provider、Session、RPC 和 Renderer 边界保持不变。
- Deep Agents 运行实现已迁入私有 workspace 包 `@moshu/deepagents`，固定上游 revision `1225a7ff8673686c2a3c0411636a9511b7d8d0d0` 并保留 MIT 许可证；runtime 不再解析 npm `deepagents` 包。
- `BunSqliteSaver` 实现锁定版本的 `BaseCheckpointSaver` 合同，使用独立 `moshu-checkpoints.db`、WAL 和当前 schema；已覆盖 checkpoint/pending writes/list/filter/delete、关闭后重开和未知 schema 拒绝。
- Ask graph 当前不暴露 Tool；默认 filesystem、todo 和 subagent middleware 已替换，模型请求会清空 Tool 列表，任何模型主动产生的 Tool call 会在执行边界失败，不会绕过 Action Broker 写文件或执行命令。
- 每个 Ask Session 使用稳定 checkpoint thread，每次 Run 仅提交当前用户 turn；Deep Agents 从 checkpoint 恢复并提供 conversation transcript，应用数据库不再包含 Message 表。ChatService 只把 checkpoint messages 与 RunJournal 的运行中/失败/取消投影合并。已覆盖同 Session 多轮恢复、跨 Session 并发隔离，以及 model/stream callback 的 `AsyncLocalStorage` 上下文隔离。
- 删除 Session 会先通过 runtime 调用 saver 的 `deleteThread`，再删除产品 Session；`store` 保留给跨 thread 长期记忆，不用于标题、搜索、归档等产品 Session 管理。
- Deep Agents fake model 和 OpenAI-compatible 本地 SSE 均已在锁定 Bun runtime 中完成 stream/complete/cancel 验证；desktop Application Host 包也有默认 graph 执行 smoke，graph checkpoint 已验证关闭数据库后重新打开可读。
- typed RPC 与 Zod 边界：Chat command、query、snapshot 和 event 使用共享契约。
- SQLite 持久化：SessionCatalog 和 RunJournal 具备当前 schema、WAL、Repository 与状态转换；旧应用数据按当前产品决策直接重置，不做兼容迁移。
- 事件先持久化再发布；UI 可使用 snapshot、event cursor 和 message reconciliation 处理重放与竞态。
- 取消链路覆盖 UI、RPC、Application Host、`AbortController` 和持久化 Run 状态。
- 应用重启后遗留的 `queued` / `running` / `cancelling` Run 会收敛为已取消，不会永久阻塞 Session 归档或删除。
- Provider/网络/协议错误保留失败语义，并对已知敏感字段做清理。
- Provider 页面切换语言不会覆盖未保存草稿；延迟完成的 Session 操作不会按旧选择错误跳转。
- Runtime、Repository、ChatService、RPC transport、controller 和页面均有自动化测试。

## 3. POC 边界

以下能力不属于本次“已完成”结论：

- 当前只完成无 Tool 的 Deep Agents Ask adapter；todo、同步 subagent 和 HITL 被显式禁用，尚未实现或验证。
- `DeepAgentService` 的完整 `start/resume/disposeSession/shutdown`、execution identity 和 Run Registry 合同尚未接入；当前由既有 ChatService 管理 Ask Run 生命周期。
- 当前只支持一个活动的 OpenAI-compatible Provider；Provider registry、OAuth、启停和多 Provider 默认项尚未实现。
- 浏览器预览使用模拟 transport，不能作为真实 Electrobun RPC、真实 Provider 或 package 验收依据。
- LangGraph checkpoint 已持久化，但尚未把 checkpoint 接入 application 强退后的 graph resume；现有 orphan Run 仍按安全策略收敛为取消，不能宣称崩溃续跑。
- checkpoint 数据库只支持当前 schema；按当前产品决策不迁移或兼容旧 checkpoint 数据。
- 尚无 Project、附件、文件工具、命令、审批、Diff、撤销、任务中心或桌面通知。
- Ask 当前以“无 Tool”而非完整只读工具集运行；Action Broker、Policy Engine、只读文件能力及模式授权尚未实现。
- retryable 错误已有分类，但自动重试、退避、断网重连和安全点重试尚未完成。
- Provider 用量、Tool call、能力标签和多 Provider contract matrix 尚未完成；当前连接测试只验证 OpenAI-compatible `/models` 请求。
- 当前自动化以 package、service 和 WebView 测试为主，尚无 signed/packaged desktop E2E。

## 4. Phase 0 工作包状态

| ID | 状态 | 当前证据与剩余工作 |
| --- | --- | --- |
| F0-01 Workspace 与质量基线 | 已完成 | Bun workspace、锁定依赖、strict TS、lint/format/test/build 脚本已落地 |
| F0-02 Electrobun 构建与运行时骨架 | 已完成 | Application Host、React WebView、in-process service、开发/打包与 runtime probe 已落地 |
| F0-03 UI 基线 | 部分完成 | Router、主题、i18n 和 Icon wrapper 已落地；核心交互的 HeroUI/React Aria 语义验收待完成 |
| F0-04 Contracts 与 RPC | 部分完成 | Chat typed RPC 与 Zod 已落地；View capability、通用订阅和 stale callback 边界待完成 |
| F0-05 业务 SQLite | 部分完成 | Chat schema、迁移、WAL 和 Repository 已落地；备份、完整性恢复和完整领域覆盖待完成 |
| F0-06 LangGraph checkpoint | 已完成 | `BunSqliteSaver`、独立 WAL 数据库、当前 schema fixture、thread/delete 和关闭重开合同已落地；不兼容旧 checkpoint 数据 |
| F0-07 Deep Agents in-process POC | 部分完成 | 仓内 `@moshu/deepagents` 已接入默认 Ask；Bun execute、真实 Provider adapter、stream/cancel、`AsyncLocalStorage` 和 3 Run 并发已验证；todo、同步 subagent、HITL 与 packaged application smoke 待完成 |
| F0-08 Provider POC | 部分完成 | 单个 OpenAI-compatible 流式 Adapter、持久化设置页和连接测试已落地；Tool call、用量、能力合同和 live/package smoke 待完成 |
| F0-09 Secret Vault | 延后 | 功能稳定前先使用 Application Host 管理的本地配置；Keychain、Secret Ref 和迁移在外部分发前补齐 |
| F0-10 Action Broker POC | 未开始 | 文件、命令、Policy 和审批合同待实现 |
| F0-11 可恢复垂直切片 | 未开始 | 尚未打通 Project → Agent → 审批 → Diff → checkpoint |
| F0-12 Runtime 生命周期与故障注入 | 部分完成 | 单进程取消、状态持久化和重启后 orphan Run 收敛已落地；WebView reload、强退续跑、故障注入与资源清理待完成 |
| F0-13 Canvas 隔离 POC | 未开始 | sandbox BrowserView、partition、CSP 和默认断网验证待完成 |
| F0-14 打包与签名 POC | 部分完成 | Deep Agents/checkpoint 已接入 Host，canary package 构建通过；packaged execution、Keychain、BrowserView、签名/公证矩阵待完成 |
| F0-15 桌面自动化 POC | 未开始 | packaged test driver、崩溃与更新 harness 待实现 |
| F0-16 条件性 sidecar POC | 未触发 | 等 F0-07/F0-12 的隔离与资源实测后再决定 |

本次 POC 同时提前覆盖了 Phase 1 的 `P1-B01`、`P1-B02` 和 `P1-C02` 的一部分，但这些工作包仍不能标记为完成。

## 5. 当前优先级决策

### 功能优先，Keychain 延后

功能稳定前，Provider Key 先保存在 Application Host 管理的 app-data 本地配置库中，并与聊天业务数据分离。该方案不宣称提供 Keychain 等级的加密保护，只依赖本机账户和文件权限。

开发期仍保留以下最低边界：

- 配置文件权限限制为当前用户可读写。
- Key 不进入 Chat DB、Run Event、日志、诊断包或会话导出。
- WebView 保存后只读取掩码状态，不通过 query/RPC 取回明文。
- 不做云同步，也不把开发期本地存储描述为安全保险库。
- 后续接入 Keychain 时提供一次性迁移并删除旧明文。

`F0-09` 不再阻塞近期功能开发，但仍是外部 Alpha/Beta 分发前的发布门槛。

## 6. 下一里程碑：Provider 设置与普通 Chat

### W1：完成可持续使用的普通 Chat

目标链路：

```text
Provider 设置页
  → 保存并测试 Provider
  → 新建普通 Chat Session
  → 流式对话
  → Session 列表与管理
  → 路由和应用重启恢复
```

本里程碑对应 `P1-A02`、`P1-A05`、`P1-B01`、`P1-B02` 和 `P1-B06` 的首个完整切片。附件、Project Chat 和 Agent 工具不在本轮范围内。

### 6.1 Provider 设置页

- 使用正式路由 `/settings/providers`，不使用嵌套 Dialog 代替设置页面。
- 当前切片管理一个活动的 OpenAI-compatible Provider，展示配置状态、Endpoint、模型和 Key 掩码。
- 支持新增/编辑、保留或替换 Key、删除和单独的“测试连接”操作。
- 保存后只返回 `configured`、Endpoint、模型和掩码，不向 WebView 重新返回完整 Key。
- 保存、测试和删除独立维护 pending/error 状态；测试返回延迟和脱敏错误。
- 未配置可用 Provider 时，在 Chat composer 内直接显示前往设置页的入口。
- 首个 Adapter 继续使用 OpenAI-compatible；多 Provider registry、启停和默认 Provider 留到后续切片。

建议的能力边界：

```text
Provider Query:
  list / get

Provider Command:
  upsert / enable / disable / test / delete
```

保存与连接测试是两个独立命令。测试结果至少包含成功状态、延迟、模型/endpoint 和脱敏错误，不只返回 boolean。

### 6.2 普通 Chat 与 Session 管理

- 路由使用 `/chat/new` 和 `/chat/:sessionId`，route 是当前 Session 的事实来源。
- 左侧 Session 列表支持新建、选择、搜索，并按 `updatedAt DESC` 排序。
- Session 支持自动标题 fallback、手动重命名、归档、恢复和永久删除。
- 首条消息使用最多 60 字符的本地摘要作为标题；LLM 异步标题生成尚未实现。
- 创建成功后从 `/chat/new` replace 到真实 Session URL；刷新或重启后按 URL 恢复。
- Chat 页面已拆分为 Session sidebar、Header、Transcript 和 Composer；Model Selector 尚未实现。
- Transcript 已支持基本消息与运行状态；Markdown、GFM、代码高亮和复制尚未实现。
- Composer 已支持草稿、发送、停止和失败重试；Provider/模型切换通过设置页完成。
- persisted SessionCatalog/RunJournal 继续通过 typed query/RPC 读取；transcript 由 Host 从 checkpoint state 查询并合并运行投影，独立 query cache 与 active-run reducer/store 尚未引入。
- streaming event 保持 `sessionId + runId + messageId` 身份，settled 后与持久化 snapshot 对账。

基础 Session DTO 至少包含：

```text
id / title / status
createdAt / updatedAt / archivedAt
providerId / modelId
lastMessagePreview / messageCount
activeRunState
```

### 6.3 `oh-your-pi` 参考边界

可借鉴的前端模式：

- `ProviderList` 的 Provider 分组、连接状态和行内操作。
- `ProviderAuthenticationDialog` / `AuthenticationStep` 的异步认证状态机、进度和内联错误。
- `SessionList` 的搜索、最近修改排序、selected state 和空列表 CTA。
- `ChatTranscript`、`ChatComposer`、`ModelThinkingSelector` 的组件边界。
- optimistic user message、streaming assistant projection，以及 settled 后与持久层重新校准。
- Zod DTO → typed RPC client → Bun service 的跨进程边界。

不复制以下实现：

- 只提供登录 Dialog、没有 Provider 配置实体 CRUD 的设置模型。
- 使用 `sessionPath` 和 Pi JSONL 作为 Session 身份与持久化。
- 不使用 URL Router、只把当前 Session 放在 React state 中。
- 单个 controller 同时管理 Provider、Session、主题和 streaming。
- 每次 Run settled 后重新读取完整 transcript。
- Pi SDK 的 `ModelRuntime`、thinking level、steer/follow-up 和 permission 事件语义。

### 6.4 实施顺序

1. 已完成 Provider/Session DTO、RPC 和 SQLite migration。
2. 已完成本地 Provider 配置存储、连接测试和设置页。
3. 已完成 `/chat/new`、`/chat/:sessionId` 路由及 Session sidebar。
4. 已完成重命名、归档/恢复、删除、搜索和首条消息本地标题。
5. 已接回已有流式、取消和失败重试；Model Selector 与富文本 transcript 待完成。
6. 已完成最近 Session 验证恢复、运行中 Session 管理保护、重启 orphan Run 收敛和中英文基础状态；并发/live desktop smoke 待完成。

### 6.5 里程碑出口

- 用户可以在设置页新增、编辑、测试和删除当前 OpenAI-compatible Provider，配置在应用重启后仍然有效。
- 未配置 Provider、凭证失效和连接测试失败均有明确入口与错误状态。
- 用户可以创建多个普通 Chat，在列表中搜索、重命名、归档/恢复和删除。
- 打开 Session URL 或重启应用可恢复相同会话，不依赖仅存在于 React 内存的选择状态。
- 流式消息、停止和失败重试不会串到其他 Session；最终 UI 与 checkpoint transcript + RunJournal 投影一致。
- Session 列表、Chat 空状态、加载、错误和运行状态均完成中英文基本体验。

W1 余下工作是 live/package smoke、富文本 transcript、Model Selector、并发 Session 验收和状态层收敛。完成后再进入附件与 **Project Ask（只读）**。checkpoint 基础已落地，但 graph resume、Policy、Action Broker 与副作用恢复仍必须在开放 Agent 写操作前完成；Keychain 在功能稳定后的发布加固阶段补齐。
