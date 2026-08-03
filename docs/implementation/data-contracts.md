# 数据与接口契约

> 状态：Provider、Session/Run、Tool/Action、Runtime Box inventory、MCP/Skill 与 Runtime Profile 合同已实现
> 当前实现边界见[实现状态](./progress.md)
> 代码事实源：`packages/contracts/src/` 与 `packages/database/src/schema.ts`
> 更新日期：2026-08-03

## 1. 目标

- Electrobun client、agents server 和 Runtime Box 可按稳定协议独立演进。
- 每个持久实体、连接实例、Run、Tool、Action 和 invocation 可明确关联。
- server 决策与持久化授权，Runtime Box 在实际执行前验证一次性 grant。
- 断线、重连、进程重启和迟到消息不会覆盖新实例状态。
- Pi、Provider、MCP 和 Skill SDK 类型不进入公共 RPC 或 UI 契约。
- 本次开发期重构可重置旧数据，不把迁移工作误写为已实现。

## 2. 通用约定

| 项目 | 约定 |
| --- | --- |
| 业务 ID | UUIDv7 字符串；跨角色不得使用数据库自增 ID |
| 稳定角色 ID | `clientId`、`mobileClientId`、`runtimeBoxId` 跨重连/重启保留 |
| 实例 ID | 每次进程启动/连接注册生成新的 `instanceId` |
| Generation | 稳定身份下单调递增；server 只接受最高有效 generation |
| Connection ID | 每条 WebSocket 唯一；只用于连接观测和背压 |
| 时间 | 数据库使用 UTC epoch milliseconds；RPC 返回 ISO 8601 |
| JSON | 写入或发送前由共享 Zod schema 校验，并包含版本 |
| Revision | 从 1 开始单调递增；更新使用 compare-and-swap |
| Secret | 公共 RPC 只返回掩码；Provider 与 MCP credential 分别只在其 owner 的 SecretStore 中持久化 |
| Path | server 保存产品范围；Runtime Box 执行前解析 canonical path 并验证 scope |
| Error | 失败使用 error response/result，不包装成 success |

`instanceId`、`generation` 和 `connectionId` 不能替代业务 ID。Run、Action 或 Tool 结果必须同时匹配业务 identity 和当前角色实例。

## 3. 错误契约

```ts
interface AppError {
  code: string;
  category:
    | "validation"
    | "permission"
    | "authentication"
    | "availability"
    | "rate_limit"
    | "network"
    | "provider"
    | "tool"
    | "conflict"
    | "storage"
    | "protocol"
    | "runtime"
    | "unknown";
  messageKey: string;
  safeMessage: string;
  retryable: boolean;
  details?: Record<string, JsonValue>;
  causeId?: string;
}
```

稳定错误至少包含：

- `PROTOCOL_VERSION_UNSUPPORTED`
- `ROLE_NOT_ALLOWED`
- `INSTANCE_SUPERSEDED`
- `RUNTIME_BOX_OFFLINE`
- `RUNTIME_BOX_CAPABILITY_MISSING`
- `EXECUTION_GRANT_INVALID`
- `EXECUTION_GRANT_EXPIRED`
- `EXECUTION_GRANT_ALREADY_USED`
- `INVOCATION_OUTCOME_UNKNOWN`
- `INVENTORY_SYNC_REQUIRED`
- `INVENTORY_CURSOR_INVALID`
- `INVENTORY_RESYNC_REQUIRED`

原始 Header、凭证、堆栈和未脱敏 Tool 输出只能进入受控本地日志。UI 不解析 SDK 错误文本。

## 4. 数据所有权

### 4.1 角色边界

| 数据/资源 | 唯一所有者 | 禁止 |
| --- | --- | --- |
| 产品 DB、Pi Session JSONL、migration、backup | agents server | client/Runtime Box 直接打开或写入 |
| Provider/model config/credential、Agent definitions/versions | agents server | Runtime Box 读取 Provider secret 或自行修改 Agent |
| Session/Run/event、Provider access、Agent runtime | agents server | client/Runtime Box 直接调用 Provider/Pi runtime |
| Policy、approval、Action intent/result、grant audit | agents server | Runtime Box 自行批准 Action |
| Agent Server-owned MCP config/credential/lifecycle | agents server | client 绕过 server API 或 credential 进入普通 query/event |
| Agent Server-owned prompt-only Skill install/version/`SKILL.md` | agents server | executable/bundle file、Agent Tool mutation 或正文进入普通事件 |
| Runtime Box-owned MCP config/credential/OAuth/lifecycle、完整 Skill package/version/content/resource | owning Runtime Box | server 保存 recoverable copy 或 client 绕过 server 路由 |
| redacted Runtime Box inventory cache | agents server projection | 当作 MCP/Skill 恢复源、授权依据或权威状态 |
| 七个内置 Tool、Box-owned MCP invocation、进程树 | Runtime Box | server/client 直接执行；Git Tool/Skill script 尚未接入 |
| Server-owned MCP invocation/进程树 | agents server MCP dispatcher | Agent runtime/Product RPC 绕过 Action dispatcher |
| UI state、窗口、Updater、companion supervisor | client | server/Runtime Box 操作桌面框架 |
| Provider/model Secret | agents server `SecretVault` | client/WebView/Runtime Box 读取 |
| MCP Secret | 显式 owner 的 MCP SecretStore | 跨 owner 复制或进入 Pi Session/snapshot/query/log |

### 4.2 当前 Product DB 表

| 领域 | 当前表 | 说明 |
| --- | --- | --- |
| Runtime catalog | `runtime_boxes`、`runtime_box_generation_fences`、`runtime_box_device_keys`、`runtime_box_pairing_sessions` | Box identity、配对、吊销与跨 Server 重启 generation fence |
| Runtime projection | `runtime_box_inventory_state`、`runtime_box_inventory_cache` | redacted、可丢弃、非权威 inventory |
| Runtime selection | `app_settings`、`client_runtime_box_preferences`、`remote_access_settings` | 全局默认、Client preference 与 Tunnel 状态 |
| Agent resources | `agent_runtime_profiles`、`agent_global_profiles` | Box-owned 与 Server-owned stable refs |
| Server MCP/Skill | `agent_server_mcp_*`、`agent_server_skill_*` | Server authority、幂等 command 与延迟清理；Secret/Skill 正文用 locator 指向 private store |
| Project/Chat | `projects`、`chat_sessions`、`chat_session_create_requests`、`chat_runs`、`chat_run_events` | Project、Session、Run/event 与 Box placement |
| Session cleanup | `project_deletion_jobs`、`retired_chat_sessions`、`agent_session_cleanup_outbox` | durable retire/delete 与 Pi 文件清理 |
| Action/Approval | `action_intents`、`execution_grants`、`action_approval_requests`、`session_approval_policies` | intent/result、grant 消费、审批 CAS 与 Session Allow all |
| Mobile identity | `mobile_devices`、`mobile_device_keys`、`mobile_device_generation_fences`、`mobile_pairing_sessions` | 与 Runtime Box 完全分离的 Mobile 身份域 |
| Mobile attention | `mobile_attention_outbox`、`mobile_attention_events`、`mobile_attention_ack_cursors`、`mobile_attention_feed_meta` | transactional outbox、durable feed、ack 与 retention 水位 |

Provider metadata/preference 当前保存在 app-owned Provider registry，credential 保存在独立 vault；Pi conversation
context 保存在 `SessionManager` JSONL。它们不是 Product DB 表。Agent Server 不保存 recoverable
**Runtime Box-owned** MCP/Skill config、credential/OAuth state、Skill content/resource 或 Runtime Box secret handle。

### 4.3 Runtime Box-owned local data

每个 Runtime Box 是自身 Box-owned MCP/Skill 数据的唯一 source of truth。local desktop Runtime Box 建议使用：

| 存储 | 权威内容 |
| --- | --- |
| `runtime-box.db:mcp_configs` | stable resource ID、transport、非敏感 config、config version/hash、lifecycle intent |
| `runtime-box.db:mcp_inventory` | connection/Tool descriptor、health 和 Tool schema |
| `runtime-box.db:skill_installations`、`skill_versions` | stable resource ID、immutable version、metadata、content hash 和 local locator |
| `runtime-box.db:inventory_state` | persisted opaque `inventoryEpoch` 和该 epoch 内单调递增的 `inventoryRevision` |
| `runtime-box.db:inventory_changes` | 有界 change log；连续 revision、category、redacted upsert 和 deletion tombstone |
| private `skills/` | immutable `SKILL.md`、resources、scripts 和其他内容 |
| `ExecutorSecretStore` | MCP credential、token、OAuth state；DB 最多保存 Runtime Box-internal opaque locator |

这些数据不属于产品 DB、server backup 或 client export。local private root 必须 `0700`，credential file 必须 `0600`，写入使用 owner check、atomic replacement、symlink rejection 和可用时的 no-follow。其他 Runtime Box 可通过 Port 使用不同 secret backend。

## 5. Agent、Runtime Box 与可用性

### 5.1 Runtime Profile 关系

- Agent definitions/versions 和 Provider 全局共享，不直接绑定 Runtime Box。
- Agent global profile 保存 Server-owned MCP/Skill stable refs，不带 `runtimeBoxId`。
- 每个 `agentId + runtimeBoxId` 最多有一份 active Runtime Profile。
- Session/Project 永久保存 `runtimeBoxId`；启动 Run 时解析该 Agent 在同一 Box 上的 Runtime Profile。
- Profile 的每个 MCP/Skill ref 都必须属于 profile 的 `runtimeBoxId`，并包含 stable resource ID、version 与 hash。
- Run 有效 MCP 集合为 Agent global Server refs 与 Session Box Runtime Profile MCP refs 的并集；两类都 live 校验。
- client 通过 server 查询 registry，不硬编码 Runtime Box 在线。
- Runtime Box 新连接先处于 `syncing`；只有 full inventory sync 原子替换成功后才进入 online/runnable。

### 5.2 启动 Run

`runs.start` 在创建可执行 Run 前验证：

1. Agent version 与 Session 对应的 Runtime Profile 存在且未停用。
2. Session 所属 Runtime Box 已注册、当前 connection 的 full inventory sync 已完成且 online。
3. server 通过 live Runtime Box RPC 验证 capability、所有 resource owner/version/hash 和当前 MCP Tool schema；不能只信 cache。
4. server 从 Runtime Box 按稳定 ref 获取 Skill metadata/`SKILL.md`，version/hash 完全一致。
5. Provider、Policy 和 Session 状态有效。

Runtime Box syncing 时返回 `INVENTORY_SYNC_REQUIRED`；offline、resource missing 或 version/hash mismatch 时 fail closed。不能创建一个看似运行中的 Run、把 inventory polling 当授权，或用 snapshot/旧内容回退。若 Runtime Box 在 Run 中途离线，server 将 Run 转为 `interrupted`/`recovery_required`，并对未完成 Action 做结果对账。

## 6. Run、Tool 与 Action 状态

### 6.1 Run

```text
created -> queued -> preparing -> running
running -> waiting_approval | waiting_user
waiting_approval | waiting_user -> running
preparing | running | waiting_* -> stopping -> cancelled
preparing | running | waiting_* | stopping -> interrupted
interrupted -> recovery_required
recovery_required -> queued | cancelled | failed
running -> completed | failed
```

- `completed`、`failed`、`cancelled` 为终态。
- server/exec connection loss 不直接推断 Tool 成败。
- 状态转换与 `run.status_changed` 在同一 server DB transaction 内提交。
- 新执行记录目标 Runtime Box stable ID、instance ID 和 generation；恢复时不能复用旧 instance lease。

### 6.2 ToolCall

```text
proposed
  -> policy_check
  -> denied
  -> waiting_approval -> rejected | approved
  -> grant_issued
  -> executing
  -> succeeded | failed | cancelled | outcome_unknown
```

### 6.3 ActionExecution

```text
intent_persisted
  -> grant_issued
  -> executing
  -> succeeded | failed | cancelled | outcome_unknown
```

`outcome_unknown` 永远不自动重放 non-idempotent Action。

## 7. 注册与连接契约

### 7.1 Bootstrap

desktop agents server 绑定 `127.0.0.1`/`::1` 的动态端口。client 通过受控父子进程 bootstrap 获取：

下列接口是语义摘要；精确 wire schema 以 `packages/contracts` 为准。

```ts
interface DesktopBootstrap {
  endpoint: string;
  serverInstanceId: string;
  supportedProtocolVersions: number[];
  registrationTokens: {
    client: string;
    runtimeBox: string;
  };
  expiresAt: string;
}
```

两个 token 分别绑定角色、一次性且短时有效，不进入日志或命令行参数。每次重新注册都需要受控
bootstrap/control channel 签发的新 proof；bootstrap 不承载业务调用。

### 7.2 注册请求

```ts
interface RegisterRoleRequest {
  role: "client" | "runtime-box";
  stableId: string;
  instanceId: string;
  generation: number;
  build: {
    appVersion: string;
    binaryVersion: string;
    protocolVersions: number[];
  };
  capabilities: Record<string, JsonValue>;
  registrationProof: string;
}

interface RegisterRoleResult {
  connectionId: string;
  protocolVersion: number;
  serverInstanceId: string;
  acceptedGeneration: number;
  lease: {
    heartbeatIntervalMs: number;
    expiresAfterMs: number;
  };
  inventorySync?: {
    mode: "full";
    requiredBeforeRunnable: true;
  };
}
```

server 拒绝：

- 非 client/Runtime Box 角色。
- 无共同 protocol version。
- 重复或过期 proof。
- generation 低于当前已接受值。
- 同 stable ID、同 generation 但不同 instance ID 的竞争注册。
- 不兼容 build/capability。

每次进程启动和重新注册都使用新 `instanceId` 与新 generation。每条 WebSocket 另有新 `connectionId`。Runtime Box 注册成功只表示连接已认证；server 随即调用 `inventory.getSnapshot()`，原子替换成功前 registry 保持 `syncing`，assigned Agent 不 runnable。每次 reconnect 都重复 full sync，不能因 cached epoch/revision 相同而跳过。

## 8. Versioned JSON RPC

### 8.1 信封

```ts
interface RpcPeerIdentity {
  role: "agents" | "client" | "mobile-client" | "runtime-box";
  peerId: string;
  instanceId: string;
  generation: number;
  deviceKeyId?: string;
}

interface RpcRequestEnvelope<T> {
  schemaVersion: 1;
  protocol: { major: number; minor: number };
  type: "request";
  requestId: string;
  traceId: string;
  method: string;
  deadlineAt: number;
  payload: T;
}
```

### 8.2 Transport 规则

- Desktop 使用 Product RPC，Local/Remote Runtime Box 使用 Runtime ingress，iOS 使用 Mobile ingress。
- 三个 listener 的认证、角色和 method allowlist 相互独立；Product RPC 不进入 Dev Tunnel。
- 所有 method 按角色 allowlist 校验；client 无 Runtime Box method，Runtime Box 无 UI/Provider/DB method。
- frame、payload、in-flight request、event buffer 和 deadline 有上限。
- 长 Run/invocation 快速返回 accepted，进度通过 notification/event 推送。
- 可重试 command 携带 idempotency key；server/Runtime Box 去重。
- 断线重连后 client 按 durable cursor 补事件；Runtime Box 按 invocation reconciliation 合并状态。
- `inventory.changed` 只是 revision/category hint；server 通过 pull RPC 获取 redacted data，hint 不能携带 resource body、credential 或 Skill content。
- 未知 method/version、Schema 失败和超限明确返回错误并计入安全日志。

### 8.3 Client <-> agents server API

精确 method 名称与 schema 由 `packages/contracts/src/product-rpc.ts` 导出；文档按权限面描述，避免复制一份会漂移的
method 清单：

| Client | 当前允许的领域 |
| --- | --- |
| Desktop Product RPC | Provider/model、Runtime/Remote/Mobile 管理、Session/Project/Chat、Approval、MCP/Skill、diagnostics |
| Mobile ingress | runtime info/list/switch、Project read、model list、Session list/get/create/setModel、Chat send/cancel/replay/subscribe、Approval 与 Session policy、attention list/ack |

Mobile 明确不能调用 Provider auth/config、Remote Access 控制、Runtime pairing/revoke、MCP/Skill mutation、
Project create/relink/archive/delete/path check、diagnostics、数据库查询或 Desktop native action。

#### 8.3.1 Provider 与模型选择（当前实现）

当前已实现 `moshu.v1.providers.{list,create,update,delete,test,fetchModels,setModelsEnabled}`、
`moshu.v1.models.listAvailable`、`moshu.v1.settings.defaultModel.{get,set}`、`moshu.v1.session.setModel`，
以及 `moshu.v2.providerAuth.{start,get,respond,cancel}` 和 `moshu.v2.provider.logout`。

- builtin Provider 来自 public Pi `ModelRuntime` 的运行时枚举；公共合同不固化 Provider 数量或 SDK 类型。
- custom Provider 只允许 `openai-completions`、`openai-responses`、`anthropic-messages` 和
  `google-generative-ai`，并使用稳定实例 ID。builtin identity/API metadata 只读。
- `ProviderSummary` 只返回 source、启用状态、authentication readiness、auth methods、模型能力和
  `customHeaderNames`；API key、header value、OAuth token 与 secret prompt response 从不返回。
- Provider auth 是异步 attempt：`start` 立即返回；client 用 `get` 单请求轮询，并用 `respond` 回答
  text/secret/select/manual-code prompt。auth URL、device code 和 progress 作为 secret-free notification。
- Provider preference/custom endpoint 存于 app-owned schema v5 registry；credential 只存于
  `SecretVaultCredentialStore`。custom header 的名称可进 registry，值只能进 vault。
- `fetchModels` 只刷新选中的 Provider。builtin/custom enabled 状态和 enabled model IDs 都会持久化；
  disabled Provider/模型不能成为默认或 Session 选择。
- Session 通过 `session.setModel` 记录 `{providerId, modelId, thinkingLevel?}`。`ThinkingLevel` 必须被当前
  model 支持；若刷新后已保存档位失效，运行时安全省略该档位。删除、禁用 Provider/模型会安全清除默认值。
- Run snapshot 通过 Pi-neutral safe projection 落盘，只包含 Provider/model identity 与有效
  `ThinkingLevel`，不含 credential 或 custom header value。

client 只暴露领域方法，不提供通用 method forwarding。MCP/Skill query/command 先由 server 校验 client/Runtime Box identity、Agent binding 和产品授权，再路由到 selected Runtime Box：

- mutation 使用 `commandId` 和 expected resource version；server 可持久化 redacted Action intent/audit，但不能持久化 recoverable config、Skill content 或 credential。
- 只有 Runtime Box 持久化成功后，server 才转发 redacted result 与 `inventoryEpoch + inventoryRevision`。
- server 收到 mutation result 后立即调用 `inventory.getChanges` 拉取到返回的 revision；epoch/gap/cursor 异常时改用 snapshot，实现 read-own-write。
- Runtime Box offline、version conflict 或 storage failure 返回 typed failure；server 不排队伪成功。
- server 可返回明确标记 stale 的 inventory snapshot，但不能用它提供完整 config 编辑、secret query 或恢复。

### 8.4 agents server <-> Runtime Box API

```text
runtimeBox.register / runtimeBox.heartbeat / runtimeBox.describe
inventory.getSnapshot / inventory.getChanges
inventory.changed
resources.validate
invocations.start / invocations.cancel / invocations.reconcile
invocations.events
mcp.list / mcp.get / mcp.create / mcp.update / mcp.remove / mcp.import
mcp.test / mcp.start / mcp.stop / mcp.authorize / mcp.revoke / mcp.tools.list
skills.list / skills.get / skills.install / skills.update / skills.remove / skills.import
skills.readPrompt / skills.readResource
runtimeBox.shutdown
```

Runtime Box 不接受 `policy.allow`、`approval.decide`、`database.query`、`provider.invoke` 等越权方法。
MCP/Skill 方法操作 Runtime Box-owned state，不应用 server 侧配置副本。所有 query/result/inventory 都必须 redacted；secret、OAuth state、Runtime Box secret locator 和完整 Skill content 只能走用途受限的 command/resource RPC，不能进入普通列表或诊断。

`inventory.changed` 是 Runtime Box -> server notification；其余 inventory 方法是 server -> Runtime Box request。server 对 hint 去抖，并独立对每个 online Runtime Box 每 60 秒 ±20% jitter（48–72 秒）调用增量 API。RPC failure 只把 cache 标记 stale，不生成 deletion。

## 9. Run Event

```ts
interface AppRunEvent<T extends RunEventType = RunEventType> {
  schemaVersion: 1;
  id: string;
  runId: string;
  sessionId: string;
  runtimeBoxId?: string;
  seq: number;
  type: T;
  source: {
    role: "agents_server" | "Runtime Box";
    kind: "main_agent" | "subagent" | "tool" | "system" | "user";
    id?: string;
  };
  visibility: "user" | "debug";
  payload: RunEventPayloadMap[T];
  createdAt: string;
}
```

server 分配 durable `seq` 并先落库。Runtime Box notification 只有在 server 验证当前 instance/generation、关联 invocation 和 Schema 后，才转换为 `AppRunEvent`。

### 9.1 多 Client 事件订阅（Mobile 协议基础）

Live delivery 从「单 request-owner」模型演进为 Session/Run/seq scoped 的事件 hub（`ProductEventRouter`，见 `apps/agents-server/src/product-event-hub.ts`），为未来多 Client（Desktop 与 Mobile）观察同一 Session 铺路：

- `chat.event` delivery 的 `clientRequestId` 现为**可选 origin echo**（`chatEventDeliverySchema.clientRequestId` optional）。接收 Client 不再需要持有原始 `clientRequestId` 即可观察其订阅的 Session；发起 Client 仍会收到自身 request id 回显用于本地关联。
- 新增 `moshu.v1.chat.subscribe` / `moshu.v1.chat.unsubscribe`（input `{ sessionId }`）。二者是 **authorization-aware** 合同：handler 从 authenticated peer 解析 client identity（`role === "client"`），不信任调用方传入任意身份；非 client 角色被拒绝。
- 发起 Client 通过 `chat.send` 的 request-owner 绑定接收自身 Run 的 live event（保持幂等/恢复与 generation fencing 语义不变）；其他已认证 Client 通过显式 `chat.subscribe` 观察同一 Session。实际投递是「request-owner ∪ 显式 subscriber」的并集，按连接去重。
- 订阅是**连接作用域**的，按稳定 `peerId` 记录并携带 authenticated peer 的精确身份（`instanceId`/generation/deviceKeyId）。**无 gap 的恢复顺序**为 `subscribe → buffer live → replay(durable per-run cursor) → dedupe/merge by (runId, seq) → flush buffer → ready`：Client 在连接建立后**先**按已知 `sessionId` 安装 `chat.subscribe`（先于 replay），使 server 在 replay 仍在进行时即把 live event 路由进 provisional buffer；随后 replay 从持久 per-Run cursor 拉取快照，任何在 subscribe 与 replay 响应之间提交的事件都已进入 buffer，与 replay 的重叠按 `(runId, seq)` cursor 去重合并；在 replay→live 衔接（flush）完成前不标记 ready。因此不会丢失或重复投递两次请求之间提交的事件。恢复末尾用**原子 drain-and-activate fence**：由于投递一个 buffered event 会 await renderer listener（其间可能被 staged 一个新的 session retirement），而 retirement 的 invalidation 又会 await renderer ack（其间可能有新的 live event 入队），两个队列会相互喂给对方，故 fence 是对 **provisional event buffer 与 pending retirement invalidations 两个队列的 drain-until-quiescent 循环**：反复 flush events + retry retirements，直到两队列同时排空，再**同步**切换 `connectionActive=true`；drain 返回后到切换之间没有任何 await，故没有 live event handler 或 retirement 能在「两队列排空」与「切换 `connectionActive=true`」之间穿插，因而在 `connectionActive` 仍为 false 期间（含最后的 retirement retry 或最后一次 event flush）到达的 live event / retirement 只会被本轮 drain 排空或在切换后按 live 投递，绝不会入队后被遗留。旧连接（gen N）迟到的断开清理用精确身份逐 Session 比对，只回收 gen N 自己且未被 gen N+1 重新订阅的条目，不会误删新连接已接管的订阅（transport fence 保证 per-`peerId` 单一 live 连接与单调 generation）。不保留陈旧 socket 订阅。
- 订阅在 handler 层做**存在性/可见性校验**：`chat.subscribe` 先经 Chat Session repository 确认 `sessionId` 存在且未在删除/退休中，否则以稳定 `RpcHandlerError`（`SESSION_NOT_FOUND`）拒绝。容量有 **per-peer（256）与 global（8192）上限**，越界返回稳定 `RpcHandlerError`（`SESSION_SUBSCRIPTION_PEER_LIMIT` / `SESSION_SUBSCRIPTION_LIMIT`）。Session **retirement** 时 hub 主动清理相关订阅（`retireSessions`）。退休通知在 agents-server 内**集中化**（`notifySessionsRetired`）：Project 退休与 product-rpc 直接 `session.delete`（经 `ChatApplicationService.deleteSession` 的 `onSessionsRetired`）都会走同一路径拆除订阅，避免只在单一 handler 打补丁导致其他删除路径遗漏。**发起删除的 Client 拥有该删除自身产生的退休通知**：成功的 `session.delete` 响应是权威的，不会因这次删除同步广播回发起端的退休通知而被误判为 `SESSION_NOT_FOUND`；其余 in-flight 操作仍对并发退休 fail closed。
- 单用户 MVP 下授权边界按 Session **结构化**，不做全局裸 broadcast 调试事件。Desktop 现在在**连接恢复期间先安装 `chat.subscribe`（先于 replay）**以闭合 replay/live 衔接；稳定态下每个事件按连接（request-owner ∪ subscriber 并集）去重投递，逐事件投递内容与既有实现完全一致。
- 本层（Layer 1）不实现 Mobile ingress/pairing 与 approvals。approvals 已由 Layer 2 落地（见 §9.2）；Mobile ingress/pairing/设备认证已由 Layer 3 落地（见 §9.3）。

### 9.2 审批事件与 Product RPC（Layer 2，已实现）

Layer 2 在同一 authorization-aware 事件 hub 上新增了 client-neutral 的审批合同（见 `packages/contracts/src/approval.ts`、`apps/agents-server/src/approval-service.ts`、`product-rpc.ts`、`product-event-hub.ts`）：

- **Product RPC**：`approvals.list` / `approvals.get` / `approvals.decide`、`sessionApprovalPolicy.get` / `sessionApprovalPolicy.update`。`decide` 与 `policy.update` 均带 `expectedRevision` + `idempotencyKey`；`decide` 返回 `outcome ∈ {applied, idempotent, superseded}` 与 authoritative final request。稳定错误码：`APPROVAL_NOT_FOUND`、`APPROVAL_REVISION_CONFLICT`、`APPROVAL_ALREADY_DECIDED`、`SESSION_APPROVAL_POLICY_REVISION_CONFLICT`。
- **事件**：`approval.created` / `approval.updated` 与 `sessionApprovalPolicy.changed` 只投递给该 **Session** 的已认证订阅 client（复用 chat 订阅的可见性/退休语义）；`approvalActivityChanged` 为**无 payload** 的提示，广播给所有已认证 client，供跨 Session 待办面板按 `approvals.list` 拉快照刷新——它不携带任何 session-scoped 或 secret 内容。
- **恢复**：client 重连后依赖 durable `approvals.list`/snapshot 恢复，不依赖纯 live；快照 + 事件按 revision 合并去重。
- **决策来源权威**：`decision.source` 由 server 从 authenticated peer 身份（`{kind:"client", clientId, clientRole}`）派生，绝不信任请求体传入的身份。

### 9.3 Mobile ingress、二维码配对与设备认证（Layer 3，已实现）

Layer 3 在独立的 Mobile 接入面上新增合同（见 `packages/contracts/src/mobile.ts`、`apps/agents-server/src/mobile-ingress-auth.ts`、`mobile-ingress-generation-fence.ts`、`product-rpc.ts`、`packages/database/src/mobile-pairing-repository.ts`、`mobile-device-repository.ts`）：

- **独立 ingress**：固定 loopback listener + `/mobile` 路径，独立 `RpcServer`，与 Product RPC/Runtime ingress 物理隔离，不 fallback。独立 frame/body/inflight/backpressure/handshake timeout、未认证连接与 HTTP 容量、per-source 限流与流量计量。作为 DevTunnel 第二端口按 multi-port 模型逐端口 readiness/public URL 公开。
- **状态方法（版本化）**：Remote Access status **v1 不变**；新增 `moshu.v2.mobileAccess.status`（v2 schema：schemaVersion、remoteAccessEnabled/state、ingressPort、ingressReady、publicUrl?、协议区间、transportSecurity、supportedTransportSecurity）。
- **QR payload（v1）**：`{ v, kind:"moshu-mobile-pairing", mobileUrl, pairingId, code, agentServerId, agentServerPublicKey, agentServerPublicKeyFingerprint, expiresAt, protocolMinVersion, protocolMaxVersion }`，strict。**绝不含 server secret 或长期 token**，也不写日志/持久化 client 存储。
- **Desktop 本地 Product RPC**：`moshu.v2.mobile.pairing.create` / `pairing.listClaims` / `pairing.approve` / `pairing.reject`、`mobile.device.list` / `device.revoke`。`approve` 带 `expectedPublicKeyFingerprint` 做 CAS，防审批错 claim。**仅本地 Desktop 可调用；Mobile ingress 不能自批。**
- **Mobile pre-auth HTTP endpoints**：claim / status / challenge / compatibility，统一小响应，不泄漏 device/key/code 是否存在。配对 code ≥128-bit 熵、5 分钟、server 只存 hash、single-use；claim token 只存 hash；状态 pending/approved/rejected/expired。
- **认证 canonical payload**：challenge 由 `AgentServerIdentity` 用 domain-tag `moshu-mobile-server-challenge-v1` 签名；设备签名的 authentication payload domain-tag `moshu-mobile-authentication-v1`，绑定 agentServerId、mobileClientId、deviceKeyId、instanceId、persisted generation、challengeId/nonce、mobile 协议版本与 transportSecurity。WebSocket upgrade 前验证签名/激活 key/吊销/challenge 单次与过期/server identity/协议，返回 canonical role=`mobile-client` identity，RPC hello 必须 exact match。
- **generation fence**：独立持久 high-water（`mobile_device_generation_fences`）；`acceptGeneration` 幂等接受同 instance、拒绝 `STALE_GENERATION`/`GENERATION_CONFLICT`；吊销即关闭匹配 peer 并阻止新 challenge/upgrade。transportSecurity 预留 negotiation（含 `relay-tls`），Noise 不谎称启用。
- **严格 allowlist**：mobile-client 独立请求/事件 allowlist（见 `mobileClientProductRequestMethods` / `mobileClientProductEventMethods`）。请求仅 MVP：runtime get/runtimeBoxes list/switch、projects list/get/getSidebar、models listAvailable、session list/get/create/setModel、chat send/cancel/replay/subscribe/unsubscribe/retiredSessions.list、approvals list/get/decide + sessionApprovalPolicy get/update；事件仅 chat.event、chat.sessions.retired、approvals.event、approvals.policy.changed、approvals.activity.changed、runtimeBoxes.changed。其余（Provider、Remote Access 控制、Runtime 配对/revoke、MCP/Skills、Project mutation、diagnostics、defaultModel set、agentGlobalProfile 等）**全部 deny**。client preference/decision source 均由 authenticated peer identity 派生，不接受伪造 clientId。
- **设备列表分页（lifetime capacity）**：吊销设备永久保留作审计，设备数量随生命周期无上限增长。`mobile.device.list` 采用 keyset/cursor 分页（`{ cursor?, limit≤128 }` → `{ items≤128, nextCursor? }`），稳定排序 `(active 优先, createdAtMs, id)`；单页 schema 恒有效，Desktop 通过 `nextCursor` 逐页加载（“加载更多”）遍历/管理全部 active 设备。绝不静默丢弃 active 设备。
- **配对 fail-closed（Remote Access 未启用 / ingress 未就绪）**：`pairing.create` 仅在 **Remote Access `enabled===true`** 且 mobile ingress ready 且有 exact public URL 时创建；否则抛稳定 `MOBILE_INGRESS_NOT_READY` 且**不创建/消耗任何 pairing 记录**。注意 `disable()` 会先持久化 `enabled=false`、随后才异步 stop ingress，过渡期 readiness/URL 仍可见——server 因此同时对 enabled 与 URL 双重 gate（`getMobilePublicUrl` + `isRemoteAccessEnabled`），保证过渡期零副作用 fail closed。Desktop 创建按钮 `disabled` 直到 `mobileAccess.status.remoteAccessEnabled && ingressReady && publicUrl`，并对 legacy 无 URL 的 pending 显式 expire/重建，避免产生无 QR 的失效配对。

### 9.4 iOS Mobile App 客户端合同消费（Layer 4，已实现）

Layer 4 是 §9.3 server 合同的 **iOS client 侧实现**（见 `apps/mobile/`：`src/native/transport-plugin.ts`、`src/rpc/*`、`native/MoshuMobile/Sources/MoshuMobileCore/*`、`ios/App/App/plugins/*`）。所有 wire 合同均沿用 `packages/contracts/src/mobile.ts`，client 不新增 server 合同。

- **canonical payload byte-parity**：`createMobileServerChallengePayload` / `createMobileAuthenticationPayload`（`JSON.stringify` 固定字段数组）是签名/验签的唯一字节来源。`apps/mobile/scripts/gen-canonical-vectors.ts` 从 TS 合同生成共享 fixture `native/MoshuMobile/Tests/.../Fixtures/mobile-canonical-vectors.json`，Swift `MoshuMobileCore` XCTest 与 Web `test/canonical-vectors.test.ts` 同时消费，证明 Swift/TS **canonical payload 逐字节一致**。注意 CryptoKit Ed25519 签名**随机化**（非 RFC 8032 确定性），故 vectors 只断言**跨实现验签**通过，不断言签名字节相等。
- **设备公钥 canonical SPKI DER**：Ed25519 公钥以 12 字节 SPKI 前缀 `302a300506032b6570032100` + 32 字节 raw = 44 字节 DER，base64url（去 padding）承载于 claim 与设备身份，供 server 校验指纹（`SHA256:base64url`）。
- **WSS upgrade headers**：device 用 Keychain 私钥签 canonical authentication payload，经 `URLSessionWebSocketTask` 以 `x-moshu-mobile-client-id` / `x-moshu-device-key-id` / `x-moshu-instance-id` / `x-moshu-generation` / `x-moshu-protocol-version` / `x-moshu-challenge-id` / `x-moshu-signature`（base64url device 签名）连接 `/mobile`。长期凭据只走 header/签名，**绝不放 query string**。
- **client 侧 allowlist**：Product client 严格只调用 `mobileClientProductRequestMethods` / 订阅 `mobileClientProductEventMethods`，不尝试任何 Desktop-only 方法；连接恢复 subscribe→buffer→replay（durable cursor）→runId/seq dedupe→flush→ready。所有 response/event 严格 Zod。
- **client-side 状态与持久化边界**：`fatalCodeMap`（`connection-controller.ts`）区分致命（`AUTH_REVOKED` / `AUTH_FAILED` / `PROTOCOL_MISMATCH` / `IDENTITY_MISMATCH` / `URL_INVALID` / `PAIRING_REJECTED`，不可盲重试）与网络失败（offline/reconnecting）；Swift `MobileTransportError` rawValue 与之逐一对应。仅 `connected` 态暴露业务数据，断线即清空；业务数据只存 React 内存，binding/private key 只在 native Keychain，仅 appearance/language 可持久化。
- **认证、恢复与幂等消费**：process-rpc hello 的 `peer` 必带 `deviceKeyId`（native `connect()` 结果与 JS hello 一致），与 server authenticated canonical identity `isSameRpcPeerIdentity`（含 `deviceKeyId`）exact match，否则握手被拒。致命关闭按 WS close code / HTTP upgrade 状态**数值**分类（`1008→AUTH_REVOKED`、`401/403→AUTH_FAILED`、`426→PROTOCOL_MISMATCH`，`fatalReason` 透传 native→JS），**不匹配本地化 error 串**；致命即停盲重连、清业务态。Chat 历史消费 `getSessionPage` 的 `nextCursor` 分页到含 active run 的最后一页（server 按 oldest-first 排序、`maxSessionRunsPerPage=2`），受 page/bytes 上界约束、cursor 不前进即 fail-closed。`chat.send` 的 `requestId` 由 `ChatSessionController` reservation 持有：ambiguous（连接断/超时/响应丢失）保留 reservation，重试复用同 id（server 幂等去重成一个 run）；definitive 拒绝（`INVALID_ARGUMENT` / `RUNTIME_BOX_NOT_READY` / `SESSION_NOT_FOUND`）或编辑草稿内容才换新 id。
- **帧限额与关闭码**：native inbound guard / outbound queue / JS pre-bind 帧上限统一为 `@moshu/contracts` 的 `productRpcMaxFrameBytes`＝4 MiB（原 stale 1 MiB 会误拒合法 1–4 MiB 帧），该值写入共享 canonical 测试向量 fixture，Vitest 与 Swift 同时断言防漂移；queued bytes 保守有界且 ≥ 单帧。teardown 将拟发数字关闭码安全映射到 `URLSessionWebSocketTask.CloseCode`（oversize→`messageTooBig`/1009、binary→`unsupportedData`/1003、其余标准码原值发送，保留/本地专用/未知码回退安全可发送码），close reason 按 UTF-8 标量边界截断到 123 字节控制帧预算——不再一律 `.goingAway`(1001)。

### 9.5 Durable mobile attention/unread feed 与 iOS 生命周期/通知（Layer 5，已实现）

Layer 5 在 §9.3/§9.4 之上新增 **Agent Server 持有** 的移动端未读/attention feed 合同与消费（见 `packages/contracts/src/mobile.ts`、`apps/agents-server/src/mobile-attention-drainer.ts` + `mobile-ingress-handlers.ts` + `product-rpc.ts`、`packages/database/src/{mobile-attention-repository.ts,mobile-attention-outbox-repository.ts}`、`apps/mobile/src/rpc/{attention-controller.ts,notification-tap.ts}`）。**无云 Push Relay、无 APNs remote/silent push、无后台伪保活、设备不落业务数据。**

- **`MobileAttentionEvent`（versioned，脱敏）**：`{ schemaVersion:1, eventId(uuid), seq(正整数、每 feed 单调), type ∈ approval_required|run_completed|run_failed|run_cancelled, visibility:"mobile-clients", sessionId?/runId?/approvalId?（opaque）, createdAt, titleKey/bodyKey（generic 本地化键，如 `attention.approvalRequired.title`）}`，strict。**绝不含** prompt/message/tool raw args/provider secret/path 正文/shell command。
- **transactional outbox（幂等、事务、重启不丢）**：approval 进入 `pending`、Run 达终态时，在**同一 SQLite 事务**内向 `mobile_attention_outbox` append 脱敏 payload（`dedupeKey` 如 `approval:<id>` / `run:<id>` UNIQUE），业务 commit 与 outbox 原子。独立 `MobileAttentionOutboxDrainer` 幂等投影到 `mobile_attention_events` 并 `markProcessed`，startup 与运行期 drain；投影失败**保留重试并记录诊断，绝不吞成成功**。因此 crash/append 失败不会永久丢未读，`attention.changed` hint 丢失也不影响 reconnect list。`mobile-attention-drainer.test.ts` 断言 crash-at-each-boundary / restart / 幂等；DB 层 `mobile-attention-outbox` 用例断言事务原子与去重。
- **每设备 ack cursor（read state，server 侧）**：`mobile.attention.list`（`{ cursor?, limit }` → `{ items, unreadCount, ackSeq, latestSeq, resyncRequired, nextCursor? }`，cursor 分页）与 `mobile.attention.ack`（`{ seq }`，CAS + 幂等 + 单调，旧 ack 不回退 cursor）。**peer identity 由 auth context 决定**，禁止伪造 clientId 或回退。handler 逻辑抽到 pi-free `mobile-ingress-handlers.ts`（`resolveMobileClientId`/`listMobileAttentionForPeer`/`ackMobileAttentionForPeer`/`revokeMobileDevice`），并由 pi-free `mobile-ingress-composition.ts` 的 `createMobileIngressComposition`（strict allowlist + merged attention handler + outbox drainer + revoke 装配）作为**单一生产装配来源**，`create-agents-server.ts` 与 `mobile-ingress-smoke.test.ts` 共同调用（smoke 不自建 RpcServer/handler map，wiring contract test 保证覆盖）。均加入 mobile-client strict allowlist（`mobileClientProductRequestMethods`）。
- **bounded retention + resync（production 执行）**：`MobileAttentionRepository.prune` 严格 age 30 天 + per-client 500，在 **startup（强制）、每次 drain 后（throttle + jitter）与有界 periodic** 路径触发（避免每 event O(n)）；cursor 过旧则 `list` 返回 `resyncRequired:true`（resnapshot），**不伪装无未读**。设备 revoke 后不可读；unpair 后 `deleteAckCursor` 清 read state，旧 feed 不泄漏给新 binding。DB 层用例见 `packages/database` `mobile-attention-repository`（monotonic/idempotent、pagination、retention prune by age/count、malformed cursor 拒绝、revoke 清 cursor）。
- **live hint**：mobile-client 只收最小 `attention.changed`（`mobileClientProductEventMethods`，**不含业务正文**）；Desktop Product RPC 不暴露 mobile device unread。
- **notification 路由（opaque、gated）**：schedule 时只挂 `parseNotificationRoute` 白名单校验过的 `{sessionId?, approvalId?, attentionEventId}` opaque route。`NotificationTapCoordinator` 注册 `localNotificationActionPerformed`（单一 listener、start/dispose 无泄漏）：未配对/fatal 显示安全状态**不导航**；否则等 authenticated connection + attention snapshot 刷新成功后才用 opaque id 导航，绝不直接展示 stale payload。
- **client 消费（无 replay、badge、恢复）**：`AttentionController` 连接后取 recovery snapshot（仅刷 badge，`#seenSeq` baseline **不把历史事件补发为系统通知**）；Activity badge = `max(pendingApprovals, unread)`；重连从 server feed 恢复 missed unread。lifecycle/通知见 §架构 9.0.4。


## 10. Policy、Approval 与 Execution Grant

### 10.1 ActionRequest

```ts
interface ActionRequest<TAction extends ActionType = ActionType> {
  schemaVersion: 1;
  id: string;
  runId: string;
  sessionId: string;
  toolCallId: string;
  runtimeBoxId: string;
  actionType: TAction;
  args: ActionArgsMap[TAction];
  idempotencyKey: string;
  requestedCapabilities: string[];
  agentContext: {
    agentVersionId: string;
    subagentId?: string;
  };
}
```

server 不信任模型、Tool wrapper 或 Runtime Box 提供的 risk/approval 结论；Policy Engine 根据持久配置重新计算并持久化。

### 10.2 ApprovalRequest（Layer 2 已实现，见 `packages/contracts/src/approval.ts`）

真实实现的 versioned、client-neutral wire 合同（server 权威）：

```ts
interface ApprovalRequest {
  schemaVersion: 1;
  id: string;
  sessionId: string;
  runId: string;
  actionId: string;
  toolCallId: string;
  action: {
    tool: string;
    operation: "read" | "search" | "list" | "edit" | "write" | "bash" | "mcp" | "other";
    target: { kind: "runtime-box" | "agent-server"; id: string };
    command?: string; // 脱敏
    path?: string;
    mcpServerId?: string;
    mcpToolId?: string;
    redactedParams: Record<string, Json>; // 仅键名/脱敏值，绝不含内容或 secret
  };
  risk: {
    tier: "low" | "medium" | "high" | "critical";
    overridable: boolean; // false = 不可被 Allow-all 绕过
    reasons: string[];
  };
  state: "pending" | "approved" | "rejected" | "expired" | "cancelled";
  revision: number; // 每次状态转换 +1，作为 CAS token
  createdAt: string;
  expiresAt: string;
  decidedAt?: string;
  decision?: { kind: "approve_once" | "reject"; source: DecisionSource; decidedAt: string };
  policyEvidence?: { allowAllRevision: number }; // Allow-all 自动通过时记录
}
```

- **风险由 server 权威计算**（`@moshu/action-broker`），从 Tool identity + 校验后 normalized 参数得出，不信任模型/Tool wrapper/Runtime Box 自报：read/search → low（不审批）；edit/write → medium 可覆盖；bash → high 或 critical 且始终**不可覆盖**；MCP → high 可覆盖。
- **状态机**：`pending → approved | rejected | expired | cancelled`（终态不可逆）。approve/reject 由 client CAS decision 驱动；expire 由过期扫描或惰性检查驱动；cancel 由 waiter abort（Run/连接结束）驱动。
- **并发**：`approvals.decide(expectedRevision, idempotencyKey)`。两 client 竞争只有一个 `applied`，另一个得到 `superseded` 的 authoritative final state；相同 idempotency key 重试得到 `idempotent`。
- **Session Allow all**：`SessionApprovalPolicy{ sessionId, allowAll, revision, updatedBy?, updatedAt }` session-scoped、revisioned、server-owned。对 `overridable` 的普通 action 自动 `approve_once` 并写入 `policyEvidence`；**`overridable=false` 的 critical action 永不被绕过**。策略在 session retire 时 reset，不跨 Session 泄漏。
- **执行门**：request 处于 `pending` 期间**不签发/消费 execution grant，不调用 Runtime Box**。agents-server 重启对 pending request 保守 expire（无法恢复进程内 waiter），已决定 action 不重复 grant/执行。
- **决策来源**：`decision.source` 由 server 从 authenticated peer 身份派生，不信任请求体。
- 当前 per-request 决策为 `approve_once` / `reject`，另有 Session Allow-all 策略切换；Mobile Client 已通过同一
  CAS/idempotency 合同消费这些能力。修改参数后再批准的 `edit` 决策尚未实现。


### 10.3 ExecutionGrant

```ts
interface ExecutionGrant {
  schemaVersion: 1;
  grantId: string;
  actionId: string;
  invocationId: string;
  runId: string;
  toolCallId: string;
  target: {
    runtimeBoxId: string;
    instanceId: string;
    generation: number;
  };
  authorization: {
    actionType: string;
    argsDigest: string;
    capabilities: string[];
    scopeDigest: string;
    policyVersion: string;
    approvalDecisionId?: string;
  };
  issuedAt: string;
  expiresAt: string;
  nonce: string;
  proof: string;
}
```

Runtime Box 验证：

1. grant 来自当前已认证 agents server connection。
2. target stable ID、instance ID、generation 与自身一致。
3. grant 未过期、未使用、未撤销。
4. invocation 的 action/args/scope digest 完全匹配。
5. 所需 capability 在当前 Runtime Box 注册能力内。

grant 单次使用。Runtime Box 先原子标记 nonce 已消费，再执行；旧连接或 restart 后的 grant 不再有效。

### 10.4 Owner-scoped MCP credential

- Provider/model credential 只存在于 agents server `SecretVault`，供 Provider adapter 使用，永不发送 Runtime Box。
- Server-owned MCP credential 只由 Agent Server MCP SecretStore 持久化；Box-owned MCP credential/token/OAuth state 只由 owning Runtime Box 的 `ExecutorSecretStore` 持久化和解析。
- client 的设置 command 经 server 授权后按 owner 本地处理或路由到 selected Runtime Box；secret 只可存在于不落盘、强制脱敏且
  relay 后释放的 command payload，不能进入 server DB/Pi Session JSONL/event/audit payload、snapshot、
  backup 或 log。
- query/result/inventory 永不返回 secret、secret handle 或 recoverable auth config，只返回 redacted 状态。
- owner 可在 connection/process lifetime 将 credential 加载到内存；stdio MCP 只向目标 child 注入最小环境，不修改进程全局环境，也不传给无关 child/Agent。
- HTTP MCP 可在可行时按 request 注入 credential，但不是 universal requirement。
- revocation、expiry 或 MCP shutdown 必须关闭对应 connection/process 并释放 runtime references；不宣称 JavaScript 可可靠清零 string memory。
- credential 只认证 MCP connection；每个 MCP Tool invocation 仍需要新的 `ExecutionGrant`。

## 11. Tool 幂等与恢复

| 分类 | 示例 | 断线后处理 |
| --- | --- | --- |
| pure | 读文件、Git status | 可重新签发 grant 并重试 |
| idempotent | 按目标哈希写固定内容 | 验证状态后重试 |
| conditionally_idempotent | Patch、move | 对照 before/after 状态 |
| non_idempotent | 发送消息、部署、远程创建 | unknown，人工确认 |

顺序固定为：

1. server 持久化 Policy/approval。
2. server 持久化 Action intent。
3. server 签发 grant 并创建 invocation。
4. Runtime Box 验证 grant，执行并返回 typed result。
5. server 持久化 result 或 `outcome_unknown`。
6. server 才向 Agent runtime 返回 Tool result。

Runtime Box 不得自行假设 server 已收到结果；重连时使用 `invocations.reconcile` 按 `invocationId` 对账。

## 12. MCP 与 Skill 契约

### 12.1 stable MCP/Runtime Box resource reference

Agent global profile 的 Server-owned MCP ref 保存：

```ts
interface AgentServerMcpResourceRef {
  owner: { kind: "agent-server" };
  stableResourceId: string;
  version: string;
  contentHash: string;
}
```

Runtime Profile 不复制 Runtime Box config 或 content，只保存：

```ts
interface RuntimeBoxResourceRef {
  runtimeBoxId: string;
  resourceKind: "mcp" | "skill";
  stableResourceId: string;
  version: string;
  contentHash: string;
}
```

Server 构建或恢复 Agent 时先从本地 authority 解析 global refs，再从 Session Box 解析 Runtime Profile refs。
`runtimeBoxId` 必须等于 Runtime Profile 和 Session 所属 Box。Box ref
offline、missing、wrong owner、version/hash mismatch 都 fail closed，不得用 inventory snapshot 或旧 prompt
payload 回退。

### 12.2 Runtime Box inventory projection

```ts
interface RuntimeBoxInventoryResource {
  resourceKind: "mcp" | "skill";
  stableResourceId: string;
  version: string;
  contentHash: string;
  health: "ready" | "stopped" | "error";
  credentialConfigured?: boolean;
  mcpTools?: Array<{
    stableToolId: string;
    name: string;
    schemaHash: string;
    inputSchema: JsonValue;
    outputSchema?: JsonValue;
  }>;
}

interface RuntimeBoxInventorySnapshot {
  runtimeBoxId: string;
  runtimeBoxGeneration: number;
  inventoryEpoch: string;
  inventoryRevision: number;
  generatedAt: string;
  capabilities: string[];
  resources: RuntimeBoxInventoryResource[];
}

interface InventoryChangedHint {
  inventoryEpoch: string;
  inventoryRevision: number;
  categories: Array<"capability" | "mcp" | "mcp_tool_schema" | "skill">;
}

interface RuntimeBoxInventoryChange {
  revision: number;
  category: "capability" | "mcp" | "mcp_tool_schema" | "skill";
  operation: "upsert" | "delete";
  stableResourceId?: string;
  descriptor?: RuntimeBoxInventoryResource;
  capabilities?: string[];
  tombstone?: {
    resourceKind: "mcp" | "skill";
    stableResourceId: string;
    deletedVersion?: string;
  };
}

interface RuntimeBoxInventoryChangesPage {
  inventoryEpoch: string;
  fromRevisionExclusive: number;
  throughRevision: number;
  oldestAvailableRevision: number;
  changes: RuntimeBoxInventoryChange[];
  nextCursor?: string;
}
```

Runtime Box 持久化 opaque `inventoryEpoch`、该 epoch 内严格单调递增的 `inventoryRevision` 和有界 change log。每个权威 MCP/Skill/config/Tool-schema/capability mutation 在同一 transaction 内更新状态、递增 revision 并追加 change；删除追加 tombstone。普通 restart 保留 epoch/revision，inventory store reset/recreate 才更换 epoch。log 可按数量/时间压缩，但必须返回 `oldestAvailableRevision`。

同步规则：

1. 每次 Runtime Box connection/registration/reconnect 后，server 立即调用 `inventory.getSnapshot()`；成功原子替换 cache 前 Runtime Box 保持 `syncing`。
2. commit 后 Runtime Box 发送 `inventory.changed`。hint 只允许 epoch/revision/categories；server 去抖后调用 `inventory.getChanges(sinceRevision, cursor)`。
3. cursor 是 Runtime Box 签发、绑定 epoch/fromRevision/high-water mark 的 opaque pagination token。server 拉完所有 page 后才原子提交一批连续 changes。
4. server 还要独立执行 60 秒 ±20% jitter 的增量 poll；hint 丢失不能让 cache 永久停留。
5. revision gap、`sinceRevision < oldestAvailableRevision`、epoch mismatch/reset、invalid cursor 或任何无法证明连续的 page 都返回/映射为 `INVENTORY_RESYNC_REQUIRED`，随后 full snapshot。
6. offline/RPC failure 只把 cache 标记 stale；失败不能解释为 deletion。删除只接受同 epoch 连续 change 中的 tombstone，或成功 full snapshot 原子替换后的缺失项。

snapshot/change/cache 只允许 stable resource ID、version/hash、MCP Tool schema、health、Runtime Box capability 和 redacted `credentialConfigured` boolean。endpoint/command/args、sensitive env、credential/token/OAuth state、recoverable MCP config、完整 `SKILL.md`/resources 或 Runtime Box secret locator 一律禁止。cache 是 disposable、non-authoritative projection，只用于 discovery/reconciliation/stale UI，不能作为 Runtime Box 恢复输入、Run resource validation 或授权依据。

### 12.3 MCP

MCP config、auth state、connection/process 和 Tool inventory 由显式 owner 持久化/管理。Server-owned MCP
使用 Product DB metadata + 独立 MCP SecretStore；Box-owned MCP 使用第 8 节 routed API。mutation 必须带
`commandId` 与 expected config revision；Agent ref 继续绑定独立的 resource version/hash。Box 原子持久化后返回：

```ts
interface RuntimeBoxResourceMutationResult {
  stableResourceId: string;
  version: string;
  contentHash: string;
  inventoryEpoch: string;
  inventoryRevision: number;
  redactedSummary: Record<string, JsonValue>;
}
```

server 收到 mutation result 后立即增量同步到返回的 epoch/revision；若同步暂时失败，已持久化 mutation保持成功，
但 cache 标记 stale，后续 inventory read 不得伪造新 descriptor。server 只把稳定 ref 写入 Runtime Profile，
并把 redacted inventory 作为非权威 cache。Run start/restore 仍用 `resources.validate` 对 live Runtime Box 验证
owner/version/hash/schema；ready/authenticated 或 poll success 都不等于预授权。

### 12.4 Skill

- Runtime Box 保存 Skill installation、immutable version、metadata、`SKILL.md`、references、assets、scripts 和 content hash。
- server 只保存 `RuntimeBoxResourceRef`，构造或恢复 Agent 时按完整 ref 向 assigned Runtime Box 获取 metadata 和 `SKILL.md`。
- Runtime Box 返回的 prompt payload 包含 stable resource ID、version、hash；server 验证后才构造 Agent prompt。
- prompt payload 只在 server memory 中使用，不写入 Agent/Run config snapshot、Pi Session JSONL、event、
  backup、inventory、diagnostic 或 export；恢复时重新获取。
- hash/version 不匹配、Skill missing、wrong Runtime Box 或 Runtime Box offline 时 fail closed；不能使用 snapshot 或过期内容启动。
- server 不把 Runtime Box local path 写入 Agent config 或 client payload。
- `allowed-tools` 只是声明；references/assets/scripts 的读取和执行仍创建 Action 并由 Runtime Box 校验 grant。

## 13. Pi Session 与 Transcript

- 一个产品 Session 保存符合 Pi ID 约束的稳定 `piSessionId`。
- agents server 用 `SessionManager.create(cwd, sessionsDir, { id })` 打开 app-owned JSONL；client/Runtime Box
  不直接读写。
- Pi JSONL 保存 conversation context；Session 标题、搜索、归档、RunJournal、event cursor 和 tombstone
  属于产品 DB。
- 同一 Pi Session 只允许一个 owner；不同 Session 可并发。运行完成、取消或失败后都 dispose。
- Pi 没有 public delete API。产品删除先持久化 `agent_session_cleanup_outbox`，再经 canonical containment、
  lease/dispose 和 targeted unlink；失败保留并按有界 backoff 重试。
- 非终态 orphan Run 在启动 reconciliation 中安全终结；存在 JSONL 不表示可继续崩溃前的同一个 Run。

## 14. Secret Ports

### 14.1 agents server `SecretVaultCredentialStore`

- 只长期保存 Provider/model credential；Provider registry 和产品 DB 均不保存 secret value。
- client/WebView 只读取掩码和配置状态，Provider Key 不发送 Runtime Box。
- Provider secret 不进入 Pi Session JSONL、Run event、grant、日志、诊断或导出。
- 当前 adapter 是 app-owned 文件：parent `0700`、vault `0600`、provider-scoped lock、短 whole-file commit
  lock、fresh read/apply、atomic rename、file/directory fsync。它不防同账户恶意软件、root 或磁盘备份；
  Keychain adapter 是外部分发前工作。

### 14.2 Runtime Box `ExecutorSecretStore`

```ts
interface ExecutorSecretStore {
  putMcpSecret(resourceId: string, kind: string, value: string): Promise<void>;
  resolveMcpSecret(resourceId: string, kind: string): Promise<string>;
  deleteMcpSecret(resourceId: string, kind: string): Promise<void>;
}
```

- Port 只在 Runtime Box process 内可用；secret locator/value 不进入普通 RPC DTO。
- local adapter 可使用 private files：root `0700`、credential file `0600`、owner check、atomic replacement、reject symlink/no-follow where available。
- 这些权限只防其他普通本机用户，不防同账户 malware、root、disk snapshot 或 backup；future Runtime Box 可改用 Keychain、Docker Secret 或 cloud secret manager。
- 删除 MCP、OAuth revoke、expiry 和 local reset 必须定义 credential cleanup 与 connection/process teardown。

## 15. 数据库版本与开发期重置

本次三角色重构发生在开发阶段：

- 不要求把旧 runtime 数据或 Provider 开发配置迁移到当前 schema。
- server 检测不兼容开发 schema 时可提供明确的 reset 流程；不得静默解释旧字段。
- 自动化 fixture 只要求当前目标 schema 的创建、关闭重开、backup 和恢复。
- 首次对外发布冻结 schema 后，才启用正式 expand/backfill/contract migration 和跨版本 gate。

## 16. 契约验收

| ID | 验收 |
| --- | --- |
| CON-001 | 所有跨角色请求、响应和 notification 通过版本化 Schema 与 method/role allowlist |
| CON-002 | client/Runtime Box 稳定 ID 跨重启保留；每次注册产生新 instance/generation，旧实例消息被拒绝 |
| CON-003 | client 无 Runtime Box 直连 API；Runtime Box 无 DB、Provider、Policy 或 approval API |
| CON-004 | Runtime Box syncing/offline 时绑定 Agent 的新 Run 分别返回 `INVENTORY_SYNC_REQUIRED`/`RUNTIME_BOX_OFFLINE` |
| CON-005 | Policy/approval/intent 在 grant 前持久化，Runtime Box 拒绝过期、重复、篡改或错误目标 grant |
| CON-006 | Provider/model credential 从不进入 Runtime Box；server DB/Pi Session JSONL/backup/snapshot 不含 recoverable MCP/Skill config/content/credential/OAuth 或 Runtime Box secret locator |
| CON-007 | Action result 只由 server 持久化；断线后 non-idempotent Action 不自动重放 |
| CON-008 | Agent 只能引用 assigned Runtime Box 的稳定 MCP/Skill version/hash；Skill metadata/`SKILL.md` missing/mismatch 时 fail closed |
| CON-009 | MCP/Skill mutation 只有 owning Runtime Box 原子持久化后才成功；offline/冲突/失败保持 typed failure |
| CON-010 | 产品 DB/Pi Session JSONL 只有 server writer；Runtime Box kill/restart 不造成 SQLite 多写 |
| CON-011 | client 重连可按 event seq 补齐；Runtime Box 重连可按 invocation ID 对账 |
| CON-012 | 当前开发 schema 可明确重置；文档和测试不声称迁移旧 runtime 数据 |
| CON-013 | local Runtime Box root/secret file 权限、owner、atomic replace 和 symlink/no-follow 规则通过测试，产品说明真实披露其威胁边界 |
| CON-014 | 每次 Runtime Box 注册/重连立即 full sync；成功前不 runnable，snapshot 原子替换且 cache 明确 non-authoritative/disposable |
| CON-015 | persisted epoch/revision、bounded delta/tombstone、hint debounce、60 秒 ±20% poll 和 gap/compaction/epoch/cursor snapshot fallback 可确定收敛 |
| CON-016 | failed poll/offline 只标 stale、不生成 deletion；mutation revision 触发 read-own-write，Run start/restore 始终 live 验证且 inventory 不构成授权 |
