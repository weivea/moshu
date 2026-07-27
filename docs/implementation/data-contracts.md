# 数据与接口契约

> 状态：Provider、Ask、Session/Run 已实现；Tool/MCP/Skill 合同仍是目标
> 当前实现边界见[实施进度](./progress.md)

## 1. 目标

- Electrobun client、agents server 和 executor 可按稳定协议独立演进。
- 每个持久实体、连接实例、Run、Tool、Action 和 invocation 可明确关联。
- server 决策与持久化授权，executor 在实际执行前验证一次性 grant。
- 断线、重连、进程重启和迟到消息不会覆盖新实例状态。
- Pi、Provider、MCP 和 Skill SDK 类型不进入公共 RPC 或 UI 契约。
- 本次开发期重构可重置旧数据，不把迁移工作误写为已实现。

## 2. 通用约定

| 项目 | 约定 |
| --- | --- |
| 业务 ID | UUIDv7 字符串；跨角色不得使用数据库自增 ID |
| 稳定角色 ID | `clientId`、`executorId` 跨重连/重启保留 |
| 实例 ID | 每次进程启动/连接注册生成新的 `instanceId` |
| Generation | 稳定身份下单调递增；server 只接受最高有效 generation |
| Connection ID | 每条 WebSocket 唯一；只用于连接观测和背压 |
| 时间 | 数据库使用 UTC epoch milliseconds；RPC 返回 ISO 8601 |
| JSON | 写入或发送前由共享 Zod schema 校验，并包含版本 |
| Revision | 从 1 开始单调递增；更新使用 compare-and-swap |
| Secret | 公共 RPC 只返回掩码；server DB 只保存 Provider/model `secretRef`，executor 私有 store 持有 MCP credential/OAuth state |
| Path | server 保存产品范围；executor 执行前解析 canonical path 并验证 scope |
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
- `EXECUTOR_OFFLINE`
- `EXECUTOR_CAPABILITY_MISSING`
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
| 产品 DB、Pi Session JSONL、migration、backup | agents server | client/executor 直接打开或写入 |
| Provider/model config/credential、Agent definitions/versions | agents server | executor 读取 Provider secret 或自行修改 Agent |
| Session/Run/event、Provider access、Agent runtime | agents server | client/executor 直接调用 Provider/Pi runtime |
| Policy、approval、Action intent/result、grant audit | agents server | executor 自行批准 Action |
| MCP config/credential/OAuth/lifecycle、Skill install/version/content/resource | owning executor | server 保存 recoverable copy 或 client 绕过 server 路由 |
| redacted executor inventory cache | agents server projection | 当作 MCP/Skill 恢复源、授权依据或权威状态 |
| Tool/MCP invocation、Skill scripts、进程树 | executor | server/client 直接执行 |
| UI state、窗口、Updater、companion supervisor | client | server/executor 操作桌面框架 |
| Provider/model Secret | agents server `SecretVault` | client/WebView/executor 读取 |
| MCP Secret | executor `ExecutorSecretStore` | server DB/Pi Session JSONL/snapshot/backup 保存副本 |

### 4.2 业务表

| 表 | 关键字段 | 说明 |
| --- | --- | --- |
| `clients` | id, label, created_at, last_seen_at | 稳定 `clientId` |
| `executors` | id, name, kind, availability, last_seen_at | 稳定 `executorId`；availability 包含 syncing/online/offline |
| `role_instances` | stable_id, role, instance_id, generation, connected_at, disconnected_at | 注册历史；不保存 socket 对象 |
| `agent_definitions` | id, name, executor_id, current_version_id, disabled_at | 多个 Agent 可绑定同一 executor |
| `agent_versions` | id, agent_id, version, config_json, config_hash | 不可变配置快照 |
| `agent_resource_refs` | agent_version_id, executor_id, kind, resource_id, resource_version, content_hash | 只保存 assigned executor 的稳定 MCP/Skill 引用 |
| `provider_connections` | id, type, endpoint, secret_ref, status | 规划中的正式产品表；当前 Provider metadata/preference 存于 app-owned schema v5 registry，secret 独立存入 vault |
| `executor_inventory_snapshots` | executor_id, generation, inventory_epoch, inventory_revision, stale, redacted_json, observed_at | 原子替换、可丢弃、非权威的 capability/inventory cache |
| `sessions` | id, project_id, agent_version_id, mode, title, status, revision | 产品会话目录 |
| `runs` | id, session_id, executor_id, mode, status, config_snapshot_json | 一次 Agent 执行；snapshot 只含 resource refs/hashes，不含 Skill 正文 |
| `run_events` | id, run_id, seq, type, payload_json, created_at | durable append-only 轨迹 |
| `approval_requests` | id, run_id, tool_call_id, state, action_snapshot_json | server 的不可变审批请求 |
| `approval_decisions` | id, approval_request_id, decision, decided_at | server 持久化决定 |
| `action_executions` | id, run_id, tool_call_id, executor_id, state, intent_json, result_json | server 的 Action 事实 |
| `execution_grants` | id, action_id, invocation_id, executor_id, instance_id, generation, digest, state, expires_at | 只存 grant 元数据/使用状态 |
| `invocation_results` | invocation_id, action_id, state, result_json, received_at | executor typed result 的 server 投影 |

agents server 不保存 recoverable MCP/Skill config、MCP credential/OAuth state、Skill content/resource 或 executor secret handle。inventory cache 可随时丢弃并从 executor 重建，不能作为 executor 恢复输入。

### 4.3 executor-owned local data

每个 executor 是自身 MCP/Skill 数据的唯一 source of truth。local desktop executor 建议使用：

| 存储 | 权威内容 |
| --- | --- |
| `executor.db:mcp_configs` | stable resource ID、transport、非敏感 config、config version/hash、lifecycle intent |
| `executor.db:mcp_inventory` | connection/Tool descriptor、health 和 Tool schema |
| `executor.db:skill_installations`、`skill_versions` | stable resource ID、immutable version、metadata、content hash 和 local locator |
| `executor.db:inventory_state` | persisted opaque `inventoryEpoch` 和该 epoch 内单调递增的 `inventoryRevision` |
| `executor.db:inventory_changes` | 有界 change log；连续 revision、category、redacted upsert 和 deletion tombstone |
| private `skills/` | immutable `SKILL.md`、resources、scripts 和其他内容 |
| `ExecutorSecretStore` | MCP credential、token、OAuth state；DB 最多保存 executor-internal opaque locator |

这些数据不属于产品 DB、server backup 或 client export。local private root 必须 `0700`，credential file 必须 `0600`，写入使用 owner check、atomic replacement、symlink rejection 和可用时的 no-follow。其他 executor 可通过 Port 使用不同 secret backend。

## 5. Agent、Executor 与可用性

### 5.1 N:1 关系

- `agent_definitions.executor_id` 必填。
- 当前 desktop 创建一个 `kind=local_host` executor，多个 Agent 绑定它。
- 一个 Agent 同一版本只绑定一个 executor；未来切换 executor 产生新 Agent version 或显式配置 revision。
- Agent version 的每个 MCP/Skill ref 都必须是 `executorId + stableResourceId + version + contentHash`，且 `executorId` 等于 Agent assignment。
- client 通过 server 查询 registry，不硬编码 executor 在线。
- executor 新连接先处于 `syncing`；只有 full inventory sync 原子替换成功后才进入 online/runnable。

### 5.2 启动 Run

`runs.start` 在创建可执行 Run 前验证：

1. Agent version 存在且未停用。
2. 绑定 executor 已注册、当前 connection 的 full inventory sync 已完成且 online。
3. server 通过 live executor RPC 验证 capability、所有 resource owner/version/hash 和当前 MCP Tool schema；不能只信 cache。
4. server 从 executor 按稳定 ref 获取 Skill metadata/`SKILL.md`，version/hash 完全一致。
5. Provider、Policy 和 Session 状态有效。

executor syncing 时返回 `INVENTORY_SYNC_REQUIRED`；offline、resource missing 或 version/hash mismatch 时 fail closed。不能创建一个看似运行中的 Run、把 inventory polling 当授权，或用 snapshot/旧内容回退。若 executor 在 Run 中途离线，server 将 Run 转为 `interrupted`/`recovery_required`，并对未完成 Action 做结果对账。

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
- 新执行记录目标 executor stable ID、instance ID 和 generation；恢复时不能复用旧 instance lease。

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

```ts
interface DesktopBootstrap {
  endpoint: string;
  serverInstanceId: string;
  supportedProtocolVersions: number[];
  registrationTokens: {
    client: string;
    executor: string;
  };
  expiresAt: string;
}
```

两个 token 分别绑定角色、一次性且短时有效，不进入日志或命令行参数。每次重新注册都需要受控 bootstrap/control channel 签发的新 proof；具体刷新机制在 A0 ADR 冻结。bootstrap 不承载业务调用。

### 7.2 注册请求

```ts
interface RegisterRoleRequest {
  role: "client" | "executor";
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

- 非 client/executor 角色。
- 无共同 protocol version。
- 重复或过期 proof。
- generation 低于当前已接受值。
- 同 stable ID、同 generation 但不同 instance ID 的竞争注册。
- 不兼容 build/capability。

每次进程启动和重新注册都使用新 `instanceId` 与新 generation。每条 WebSocket 另有新 `connectionId`。executor 注册成功只表示连接已认证；server 随即调用 `inventory.getSnapshot()`，原子替换成功前 registry 保持 `syncing`，assigned Agent 不 runnable。每次 reconnect 都重复 full sync，不能因 cached epoch/revision 相同而跳过。

## 8. Versioned JSON RPC

### 8.1 信封

```ts
interface RpcRequest<T> {
  jsonrpc: "2.0";
  protocolVersion: number;
  id: string;
  method: string;
  sender: {
    role: "client" | "agents_server" | "executor";
    stableId: string;
    instanceId: string;
    generation: number;
    connectionId: string;
  };
  correlation?: {
    sessionId?: string;
    runId?: string;
    toolCallId?: string;
    actionId?: string;
    invocationId?: string;
  };
  params: T;
}

type RpcResponse<T> =
  | { jsonrpc: "2.0"; protocolVersion: number; id: string; result: T }
  | { jsonrpc: "2.0"; protocolVersion: number; id: string; error: AppError };
```

### 8.2 Transport 规则

- 只有 `client <-> agents server` 和 `agents server <-> executor` 两类连接。
- 所有 method 按角色 allowlist 校验；client 无 executor method，executor 无 UI/Provider/DB method。
- frame、payload、in-flight request、event buffer 和 deadline 有上限。
- 长 Run/invocation 快速返回 accepted，进度通过 notification/event 推送。
- 可重试 command 携带 idempotency key；server/executor 去重。
- 断线重连后 client 按 durable cursor 补事件；executor 按 invocation reconciliation 合并状态。
- `inventory.changed` 只是 revision/category hint；server 通过 pull RPC 获取 redacted data，hint 不能携带 resource body、credential 或 Skill content。
- 未知 method/version、Schema 失败和超限明确返回错误并计入安全日志。

### 8.3 Client <-> agents server API

```text
registry.clients.get
registry.executors.list / registry.executors.get
agents.list / agents.get
settings.get / settings.update
providers.list / providers.create / providers.update / providers.delete
providers.test / providers.fetchModels / providers.setModelsEnabled
models.listAvailable / settings.defaultModel.get / settings.defaultModel.set
projects.list / projects.add / projects.get / projects.update / projects.remove
sessions.list / sessions.create / sessions.get / sessions.update
sessions.setModel
sessions.archive / sessions.restore / sessions.delete / sessions.export
messages.list
runs.start / runs.stop / runs.resume / runs.retry / runs.get
runs.events.list / runs.events.subscribe
approvals.listPending / approvals.decide
tasks.list / tasks.reorder / tasks.subscribe
files.preview / files.diff / files.revert
mcp.list / mcp.get / mcp.create / mcp.update / mcp.remove / mcp.import
mcp.test / mcp.start / mcp.stop / mcp.authorize / mcp.revoke
skills.list / skills.get / skills.install / skills.update / skills.remove / skills.import
usage.summary
diagnostics.export
```

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

client 只暴露领域方法，不提供通用 method forwarding。MCP/Skill query/command 先由 server 校验 client/executor identity、Agent binding 和产品授权，再路由到 selected executor：

- mutation 使用 `commandId` 和 expected resource version；server 可持久化 redacted Action intent/audit，但不能持久化 recoverable config、Skill content 或 credential。
- 只有 executor 持久化成功后，server 才转发 redacted result 与 `inventoryEpoch + inventoryRevision`。
- server 收到 mutation result 后立即调用 `inventory.getChanges` 拉取到返回的 revision；epoch/gap/cursor 异常时改用 snapshot，实现 read-own-write。
- executor offline、version conflict 或 storage failure 返回 typed failure；server 不排队伪成功。
- server 可返回明确标记 stale 的 inventory snapshot，但不能用它提供完整 config 编辑、secret query 或恢复。

### 8.4 agents server <-> executor API

```text
executor.register / executor.heartbeat / executor.describe
inventory.getSnapshot / inventory.getChanges
inventory.changed
resources.validate
invocations.start / invocations.cancel / invocations.reconcile
invocations.events
mcp.list / mcp.get / mcp.create / mcp.update / mcp.remove / mcp.import
mcp.test / mcp.start / mcp.stop / mcp.authorize / mcp.revoke / mcp.tools.list
skills.list / skills.get / skills.install / skills.update / skills.remove / skills.import
skills.readPrompt / skills.readResource
executor.shutdown
```

executor 不接受 `policy.allow`、`approval.decide`、`database.query`、`provider.invoke` 等越权方法。
MCP/Skill 方法操作 executor-owned state，不应用 server 侧配置副本。所有 query/result/inventory 都必须 redacted；secret、OAuth state、executor secret locator 和完整 Skill content 只能走用途受限的 command/resource RPC，不能进入普通列表或诊断。

`inventory.changed` 是 executor -> server notification；其余 inventory 方法是 server -> executor request。server 对 hint 去抖，并独立对每个 online executor 每 60 秒 ±20% jitter（48–72 秒）调用增量 API。RPC failure 只把 cache 标记 stale，不生成 deletion。

## 9. Run Event

```ts
interface AppRunEvent<T extends RunEventType = RunEventType> {
  schemaVersion: 1;
  id: string;
  runId: string;
  sessionId: string;
  executorId?: string;
  seq: number;
  type: T;
  source: {
    role: "agents_server" | "executor";
    kind: "main_agent" | "subagent" | "tool" | "system" | "user";
    id?: string;
  };
  visibility: "user" | "debug";
  payload: RunEventPayloadMap[T];
  createdAt: string;
}
```

server 分配 durable `seq` 并先落库。executor notification 只有在 server 验证当前 instance/generation、关联 invocation 和 Schema 后，才转换为 `AppRunEvent`。

## 10. Policy、Approval 与 Execution Grant

### 10.1 ActionRequest

```ts
interface ActionRequest<TAction extends ActionType = ActionType> {
  schemaVersion: 1;
  id: string;
  runId: string;
  sessionId: string;
  toolCallId: string;
  executorId: string;
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

server 不信任模型、Tool wrapper 或 executor 提供的 risk/approval 结论；Policy Engine 根据持久配置重新计算并持久化。

### 10.2 ApprovalRequest

```ts
interface ApprovalRequest {
  id: string;
  runId: string;
  toolCallId: string;
  executorId: string;
  action: RedactedActionSnapshot;
  risk: "low" | "medium" | "high";
  allowedDecisions: Array<"approve" | "edit" | "reject" | "respond">;
  policyVersion: string;
  createdAt: string;
}
```

编辑后的 Action 重新经过 Schema、Policy 和 intent 持久化，不能复用旧 grant。

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
    executorId: string;
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

executor 验证：

1. grant 来自当前已认证 agents server connection。
2. target stable ID、instance ID、generation 与自身一致。
3. grant 未过期、未使用、未撤销。
4. invocation 的 action/args/scope digest 完全匹配。
5. 所需 capability 在当前 executor 注册能力内。

grant 单次使用。executor 先原子标记 nonce 已消费，再执行；旧连接或 restart 后的 grant 不再有效。

### 10.4 executor-owned MCP credential

- Provider/model credential 只存在于 agents server `SecretVault`，供 Provider adapter 使用，永不发送 executor。
- MCP credential、token 和 OAuth state 只由 owning executor 的 `ExecutorSecretStore` 持久化和解析；server 无 Secret Ref 或 recoverable copy。
- client 的设置 command 经 server 授权后路由到 selected executor；secret 只可存在于不落盘、强制脱敏且
  relay 后释放的 command payload，不能进入 server DB/Pi Session JSONL/event/audit payload、snapshot、
  backup 或 log。
- executor query/result/inventory 永不返回 secret、secret handle 或 recoverable auth config，只返回 redacted 状态。
- executor 可在 connection/process lifetime 将 credential 加载到内存；stdio MCP 只向目标 child 注入最小环境，不修改 executor 全局环境，也不传给无关 child/Agent。
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
4. executor 验证 grant，执行并返回 typed result。
5. server 持久化 result 或 `outcome_unknown`。
6. server 才向 Agent runtime 返回 Tool result。

executor 不得自行假设 server 已收到结果；重连时使用 `invocations.reconcile` 按 `invocationId` 对账。

## 12. MCP 与 Skill 契约

### 12.1 stable executor resource reference

Agent version 不复制 executor config 或 content，只保存：

```ts
interface ExecutorResourceRef {
  executorId: string;
  resourceKind: "mcp" | "skill";
  stableResourceId: string;
  version: string;
  contentHash: string;
}
```

`executorId` 必须等于 Agent assignment。server 构建或恢复 Agent 时向该 executor 解析引用；offline、missing、wrong owner、version/hash mismatch 都 fail closed，不得用 inventory snapshot 或旧 prompt payload 回退。

### 12.2 executor inventory projection

```ts
interface ExecutorInventoryResource {
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

interface ExecutorInventorySnapshot {
  executorId: string;
  executorGeneration: number;
  inventoryEpoch: string;
  inventoryRevision: number;
  generatedAt: string;
  capabilities: string[];
  resources: ExecutorInventoryResource[];
}

interface InventoryChangedHint {
  inventoryEpoch: string;
  inventoryRevision: number;
  categories: Array<"capability" | "mcp" | "mcp_tool_schema" | "skill">;
}

interface ExecutorInventoryChange {
  revision: number;
  category: "capability" | "mcp" | "mcp_tool_schema" | "skill";
  operation: "upsert" | "delete";
  stableResourceId?: string;
  descriptor?: ExecutorInventoryResource;
  capabilities?: string[];
  tombstone?: {
    resourceKind: "mcp" | "skill";
    stableResourceId: string;
    deletedVersion?: string;
  };
}

interface ExecutorInventoryChangesPage {
  inventoryEpoch: string;
  fromRevisionExclusive: number;
  throughRevision: number;
  oldestAvailableRevision: number;
  changes: ExecutorInventoryChange[];
  nextCursor?: string;
}
```

executor 持久化 opaque `inventoryEpoch`、该 epoch 内严格单调递增的 `inventoryRevision` 和有界 change log。每个权威 MCP/Skill/config/Tool-schema/capability mutation 在同一 transaction 内更新状态、递增 revision 并追加 change；删除追加 tombstone。普通 restart 保留 epoch/revision，inventory store reset/recreate 才更换 epoch。log 可按数量/时间压缩，但必须返回 `oldestAvailableRevision`。

同步规则：

1. 每次 executor connection/registration/reconnect 后，server 立即调用 `inventory.getSnapshot()`；成功原子替换 cache 前 executor 保持 `syncing`。
2. commit 后 executor 发送 `inventory.changed`。hint 只允许 epoch/revision/categories；server 去抖后调用 `inventory.getChanges(sinceRevision, cursor)`。
3. cursor 是 executor 签发、绑定 epoch/fromRevision/high-water mark 的 opaque pagination token。server 拉完所有 page 后才原子提交一批连续 changes。
4. server 还要独立执行 60 秒 ±20% jitter 的增量 poll；hint 丢失不能让 cache 永久停留。
5. revision gap、`sinceRevision < oldestAvailableRevision`、epoch mismatch/reset、invalid cursor 或任何无法证明连续的 page 都返回/映射为 `INVENTORY_RESYNC_REQUIRED`，随后 full snapshot。
6. offline/RPC failure 只把 cache 标记 stale；失败不能解释为 deletion。删除只接受同 epoch 连续 change 中的 tombstone，或成功 full snapshot 原子替换后的缺失项。

snapshot/change/cache 只允许 stable resource ID、version/hash、MCP Tool schema、health、executor capability 和 redacted `credentialConfigured` boolean。endpoint/command/args、sensitive env、credential/token/OAuth state、recoverable MCP config、完整 `SKILL.md`/resources 或 executor secret locator 一律禁止。cache 是 disposable、non-authoritative projection，只用于 discovery/reconciliation/stale UI，不能作为 executor 恢复输入、Run resource validation 或授权依据。

### 12.3 MCP

MCP config、auth state、connection/process 和 Tool inventory 都由 executor 持久化/管理。client 的完整配置 UI 使用第 8 节 routed API；mutation 必须带 `commandId` 与 expected version，executor 原子持久化后返回：

```ts
interface ExecutorResourceMutationResult {
  stableResourceId: string;
  version: string;
  contentHash: string;
  inventoryEpoch: string;
  inventoryRevision: number;
  redactedSummary: Record<string, JsonValue>;
}
```

server 收到 mutation result 后立即增量同步到返回的 epoch/revision；若同步暂时失败，已持久化 mutation 保持成功，但 cache 标记 stale，后续 inventory read 不得伪造新 descriptor。server 只把稳定 ref 写入 Agent version，并把 redacted inventory 作为非权威 cache。MCP Tool descriptor 可供 discovery；Run start/restore 仍用 `resources.validate` 对 live executor 验证 owner/version/hash/schema，invocation 仍使用普通 `ActionRequest` + `ExecutionGrant`。ready/authenticated 或 poll success 都不等于预授权。

### 12.4 Skill

- executor 保存 Skill installation、immutable version、metadata、`SKILL.md`、references、assets、scripts 和 content hash。
- server 只保存 `ExecutorResourceRef`，构造或恢复 Agent 时按完整 ref 向 assigned executor 获取 metadata 和 `SKILL.md`。
- executor 返回的 prompt payload 包含 stable resource ID、version、hash；server 验证后才构造 Agent prompt。
- prompt payload 只在 server memory 中使用，不写入 Agent/Run config snapshot、Pi Session JSONL、event、
  backup、inventory、diagnostic 或 export；恢复时重新获取。
- hash/version 不匹配、Skill missing、wrong executor 或 executor offline 时 fail closed；不能使用 snapshot 或过期内容启动。
- server 不把 executor local path 写入 Agent config 或 client payload。
- `allowed-tools` 只是声明；references/assets/scripts 的读取和执行仍创建 Action 并由 executor 校验 grant。

## 13. Pi Session 与 Transcript

- 一个产品 Session 保存符合 Pi ID 约束的稳定 `piSessionId`。
- agents server 用 `SessionManager.create(cwd, sessionsDir, { id })` 打开 app-owned JSONL；client/executor
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
- client/WebView 只读取掩码和配置状态，Provider Key 不发送 executor。
- Provider secret 不进入 Pi Session JSONL、Run event、grant、日志、诊断或导出。
- 当前 adapter 是 app-owned 文件：parent `0700`、vault `0600`、provider-scoped lock、短 whole-file commit
  lock、fresh read/apply、atomic rename、file/directory fsync。它不防同账户恶意软件、root 或磁盘备份；
  Keychain adapter 是外部分发前工作。

### 14.2 executor `ExecutorSecretStore`

```ts
interface ExecutorSecretStore {
  putMcpSecret(resourceId: string, kind: string, value: string): Promise<void>;
  resolveMcpSecret(resourceId: string, kind: string): Promise<string>;
  deleteMcpSecret(resourceId: string, kind: string): Promise<void>;
}
```

- Port 只在 executor process 内可用；secret locator/value 不进入普通 RPC DTO。
- local adapter 可使用 private files：root `0700`、credential file `0600`、owner check、atomic replacement、reject symlink/no-follow where available。
- 这些权限只防其他普通本机用户，不防同账户 malware、root、disk snapshot 或 backup；future executor 可改用 Keychain、Docker Secret 或 cloud secret manager。
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
| CON-002 | client/executor 稳定 ID 跨重启保留；每次注册产生新 instance/generation，旧实例消息被拒绝 |
| CON-003 | client 无 executor 直连 API；executor 无 DB、Provider、Policy 或 approval API |
| CON-004 | executor syncing/offline 时绑定 Agent 的新 Run 分别返回 `INVENTORY_SYNC_REQUIRED`/`EXECUTOR_OFFLINE` |
| CON-005 | Policy/approval/intent 在 grant 前持久化，executor 拒绝过期、重复、篡改或错误目标 grant |
| CON-006 | Provider/model credential 从不进入 executor；server DB/Pi Session JSONL/backup/snapshot 不含 recoverable MCP/Skill config/content/credential/OAuth 或 executor secret locator |
| CON-007 | Action result 只由 server 持久化；断线后 non-idempotent Action 不自动重放 |
| CON-008 | Agent 只能引用 assigned executor 的稳定 MCP/Skill version/hash；Skill metadata/`SKILL.md` missing/mismatch 时 fail closed |
| CON-009 | MCP/Skill mutation 只有 owning executor 原子持久化后才成功；offline/冲突/失败保持 typed failure |
| CON-010 | 产品 DB/Pi Session JSONL 只有 server writer；executor kill/restart 不造成 SQLite 多写 |
| CON-011 | client 重连可按 event seq 补齐；executor 重连可按 invocation ID 对账 |
| CON-012 | 当前开发 schema 可明确重置；文档和测试不声称迁移旧 runtime 数据 |
| CON-013 | local executor root/secret file 权限、owner、atomic replace 和 symlink/no-follow 规则通过测试，产品说明真实披露其威胁边界 |
| CON-014 | 每次 executor 注册/重连立即 full sync；成功前不 runnable，snapshot 原子替换且 cache 明确 non-authoritative/disposable |
| CON-015 | persisted epoch/revision、bounded delta/tombstone、hint debounce、60 秒 ±20% poll 和 gap/compaction/epoch/cursor snapshot fallback 可确定收敛 |
| CON-016 | failed poll/offline 只标 stale、不生成 deletion；mutation revision 触发 read-own-write，Run start/restore 始终 live 验证且 inventory 不构成授权 |
