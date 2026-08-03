# Run Aloud 工具调用时间线技术设计

> 状态：已实现
> 更新日期：2026-08-03
> 首期范围：Desktop 完整交付；Agent Server、公共契约和持久化采用最终模型；Mobile 已接入合同与恢复链路，暂保留文本展示
> 兼容策略：产品尚未发布，不兼容旧数据库、旧 Session、旧事件或旧 Client 协议

## 1. 决策摘要

Run Aloud 将一次 Run 建模为一条可持久化的有序时间线，而不是“一条用户消息 + 一条最终
Assistant 文本”。时间线同时包含 Agent 文本段和工具调用，因此能够稳定表达：

```text
文本 A -> 并行工具 1/2 -> 文本 B -> 工具 3 -> 文本 C
```

本设计采用以下决策：

1. Agent Server Product DB 是 Session UI 的唯一事实来源。
2. Pi Session JSONL 只保存模型 conversation context，不作为 UI 历史读取源。
3. Runtime Box invocation journal 只服务执行恢复，不作为 UI 历史读取源。
4. `chat_run_events` 保存 durable 变更流，新的 `chat_run_parts` 保存历史快照投影。
5. 每个已发布给 UI 的事件都必须先持久化，再通过 Session subscription 发布。
6. UI 顺序由模型声明时分配的 `position` 决定，不由工具开始或完成时间决定。
7. 原始工具参数和结果不进入 timeline；只持久化经过服务端脱敏与限长的 public projection。
8. 不保留旧消息合同、旧事件双写、历史回填、fallback 或 capability negotiation。

## 2. 改造前实现与根因

当前基础设施已经具备：

- Run 级单调递增 `seq`。
- `chat_run_events` durable append-only event log。
- 先落库再 publish。
- Session subscription、断线 replay、按 `(runId, seq)` 去重和补洞。
- Action、Approval、execution grant 和 Runtime Box invocation recovery。
- Pi 原生 `message_*`、`tool_execution_*` 生命周期事件。

当前无法展示和恢复工具轨迹的根因是：

1. `PiAgentRuntime` 只转发 `text_delta`，忽略工具事件。
2. 一个 Run 只投影成一条 Assistant 文本，无法表达多个 Assistant turn。
3. 中间文本 delta 被追加到同一 UI message，Run 完成时又被最终文本覆盖。
4. 完成态 Run 的历史读取主要依赖 `assistantContent`，不会加载完整工具事件。
5. Desktop 和 Mobile 的消息 reducer 只认识文本，未知工具事件被丢弃。
6. Approval、Action intent 和 invocation journal 虽然包含部分工具事实，但没有统一的 UI 顺序和安全展示结构。

因此不能只增加 ToolCard 组件；必须同时修改 Runtime 事件适配、公共合同、产品投影、历史读取和 Client reducer。

## 3. 目标与非目标

### 3.1 目标

- 实时显示每一次内置 Tool 和 MCP Tool 调用。
- 支持 Agent 文本与工具调用任意交错。
- 显示 queued、审批、运行、完成、失败、拒绝、取消和结果不确定状态。
- 支持工具参数、进度、结构化结果、错误、耗时和截断提示。
- renderer 重载、断线重连和应用重启后恢复相同的可见时间线。
- 保持 Product DB、Pi JSONL 和 Runtime Box journal 的所有权边界。
- 不持久化或展示隐藏思维链。

### 3.2 非目标

- 不恢复重构前的旧 Session 或旧工具历史。
- 不保存无限长度的原始 stdout、文件内容、命令或 MCP payload。
- 不使用 Pi JSONL 或 Runtime Box journal 临时拼装 UI。
- 不改变 Action、Approval、grant 和 Runtime Box 的授权边界。
- 首期不实现 Mobile ToolCard UI，但公共数据模型不包含 Desktop 专用字段。

## 4. 领域模型

### 4.1 Run 是 UI 聚合根

Session 历史由多个 `ChatRunSnapshot` 组成。每个 Run 保存用户输入和有序 timeline：

```ts
interface ChatRunSnapshot {
  runId: string;
  sessionId: string;
  status: ChatRunStatus;
  userMessage: ChatUserMessage;
  timeline: ChatRunPart[];
  lastEventSeq: number;
  createdAt: string;
  completedAt?: string;
}
```

不再创建一条会在完成时被覆盖的 Assistant message。最终回答只是最后一个或最后几个 TextPart。

### 4.2 Timeline Part

```ts
interface ChatRunPartBase {
  id: string;
  runId: string;
  position: number;
  assistantTurnId: string;
  revision: number;
  createdAt: string;
  updatedAt: string;
}

interface ChatRunTextPart extends ChatRunPartBase {
  kind: "text";
  status: "streaming" | "completed" | "interrupted";
  content: string;
}

type ChatRunToolStatus =
  | "queued"
  | "waiting_approval"
  | "running"
  | "completed"
  | "failed"
  | "denied"
  | "cancelled"
  | "outcome_unknown";

interface ChatRunToolPart extends ChatRunPartBase {
  kind: "tool";
  toolCallId: string;
  tool: ChatToolIdentity;
  status: ChatRunToolStatus;
  summary: string;
  input?: ToolPublicPayload;
  progress?: ToolPublicPayload;
  output?: ToolPublicPayload;
  payloadsTruncated?: boolean;
  error?: AppError;
  approvalId?: string;
  startedAt?: string;
  completedAt?: string;
  durationMs?: number;
}

type ChatRunPart = ChatRunTextPart | ChatRunToolPart;
```

`assistantTurnId` 标识一次 Pi AssistantMessage。来自同一个 AssistantMessage 的多个工具可以在 UI
中视觉分组，但仍保持独立状态和结果。

### 4.3 两种顺序

- `position`：Run 内可见内容的稳定顺序，只在 Part 创建时分配。
- `seq`：Run 内状态变化和事件发布的顺序，每次 durable event 递增。

并行工具可能按 `tool 2 -> tool 1` 的顺序完成，但其 `position` 始终保持 `tool 1 -> tool 2`。完成事件仍按真实发生顺序获得不同 `seq`。

### 4.4 Tool identity

公共合同不得泄露 Pi、Runtime Box 或 MCP SDK 类型：

```ts
type ChatToolIdentity =
  | {
      kind: "builtin";
      name: "read" | "bash" | "edit" | "write" | "grep" | "find" | "ls";
    }
  | {
      kind: "mcp";
      name: string;
      mcpServerId: string;
      stableToolId: string;
    };
```

`toolCallId` 由模型 Provider/Pi 提供，是最多 512 UTF-8 bytes 的不透明值，只要求在一个 Run
内唯一。Runtime 调用、ToolPart、Action 和 Approval 必须复用同一个校验约束，不能在下游缩小
长度上限。`part.id` 使用应用生成的 UUIDv7，作为数据库和 UI 的稳定业务 ID。

## 5. Pi Agent 事件适配

### 5.1 标准化映射

`PiAgentRuntime` 将 Pi 事件转换为与 Pi SDK 解耦的内部 Run timeline 事件：

| Pi 事件 | Timeline 行为 |
| --- | --- |
| Assistant `message_start` | 创建新的 `assistantTurnId`，暂不创建可见 Part |
| `text_start` | 分配 `partId` 和 `position`，创建 streaming TextPart |
| `text_delta` | 追加到当前 TextPart |
| `text_end` | 完成 TextPart，并以最终 content 对账 |
| `toolcall_end` | 按 Assistant content 顺序创建 queued ToolPart |
| `tool_execution_start` | Pi 已调度该调用；flush queued ToolPart，但不据此声称主机操作已开始 |
| `tool_execution_update` | 更新经过安全投影的进度 |
| `tool_execution_end` | 写入结果或错误，并进入终态 |
| Assistant `message_end` | 对账本轮所有 text/tool content，终结遗漏的 Part |
| `agent_end` | flush 全部事件后终结 Run |
| thinking 事件 | 忽略，不进入 Product DB、RPC、日志或 UI |

`toolcall_end` 已经包含稳定的 `toolCallId`、名称和结构化参数，且发生在工具真正执行之前，因此
ToolPart 可以在调用开始前创建。

### 5.2 多轮交错

目标示例在 Pi 中实际是三轮 AssistantMessage：

```text
Assistant turn 1: [text A, toolCall 1, toolCall 2]
Tool results:      [toolResult 1, toolResult 2]

Assistant turn 2: [text B, toolCall 3]
Tool result:       [toolResult 3]

Assistant turn 3: [text C]
```

投影结果为：

```text
position 1: TextPart A
position 2: ToolPart 1
position 3: ToolPart 2
position 4: TextPart B
position 5: ToolPart 3
position 6: TextPart C
```

工具结果进入 Pi conversation context 后，Pi Agent loop 自动开始下一轮模型调用。新一轮文本创建新的
TextPart，绝不追加到旧 Part，也不会在 Run 完成时覆盖前面的文本。

### 5.3 持久化屏障与背压

当前 `session.subscribe()` 的同步 listener 加 callback tail 只能保证最终等待完成，不能保证工具执行前已落盘。
实现时改为 Pi Agent 可等待的异步订阅路径，并通过 `RunTimelineWriter` 串行处理事件。

规则如下：

1. Text delta 可以先在 writer 内短暂聚合，只有落库后的聚合 delta 才允许发布给 UI。
2. `text_end`、`toolcall_end`、`tool_execution_start/end`、审批和 Run 终态都是结构事件。
3. 处理结构事件前必须 flush 之前的文本和进度。
4. `tool_execution_start` listener 返回前，queued ToolPart 必须已经提交；只有 Action dispatcher
   确认 grant 已消费并开始 invocation 后才能标记 running。
5. 数据库写入失败时中止 Run；尚未执行的工具不得继续执行。
6. 已开始副作用后发生持久化或连接故障时，使用 Action recovery 决定 failed、cancelled 或
   `outcome_unknown`，不得伪装成功。

建议初始聚合阈值为 32 ms 或 4 KiB，以先达到任一条件为准。结构事件永远强制 flush。该聚合发生在
publish 之前，因此不会出现“UI 已看到但数据库没有”的状态。

## 6. Run 事件合同

保留现有 `run.status`、`run.error` 和 `run.warning`，删除旧的单 Assistant message 事件，新增：

```ts
type ChatRunEvent =
  | TimelinePartCreatedEvent
  | TimelineTextDeltaEvent
  | TimelineTextCompletedEvent
  | TimelineToolUpdatedEvent
  | TimelineToolProgressEvent
  | RunStatusEvent
  | RunErrorEvent
  | RunWarningEvent;
```

事件语义：

| Event type | Payload | 投影行为 |
| --- | --- | --- |
| `timeline.part.created` | 完整 TextPart 或 ToolPart | 按 `part.id` 插入 |
| `timeline.text.delta` | `partId`、`revision`、`delta` | 追加文本 |
| `timeline.text.completed` | 完整 TextPart | 对账并终结文本 |
| `timeline.tool.updated` | 完整 ToolPart | 替换为更高 revision 的状态快照 |
| `timeline.tool.progress` | `partId`、`revision`、完整的有界 public progress snapshot | 以更高 revision 替换进度 |
| `run.status` | Run 状态 | 更新 Run，不修改 Part 内容 |
| `run.error` / `run.warning` | `AppError` | 显示 Run 级故障 |

Tool 状态更新使用完整的有界 public ToolPart，progress 使用完整的有界 snapshot，而不是 JSON Patch。
这样 snapshot、replay 和 reducer
具有同一验证路径，丢失或重复事件也不会产生部分字段残留。

所有事件继续携带：

```ts
interface ChatRunEventEnvelope {
  sessionId: string;
  runId: string;
  seq: number;
  occurredAt: string;
  event: ChatRunEvent;
}
```

## 7. Product DB

### 7.1 最终表模型

保留：

- `chat_sessions`
- `chat_runs`
- `chat_run_events`

新增 `chat_run_parts`：

```text
id                    UUIDv7 primary key
session_id            owning Session
run_id                owning Run
position              stable display order
kind                  text | tool
assistant_turn_id     Pi turn 的应用内稳定 ID
status                text/tool 状态
revision              Part 单调版本
text_content          聚合后的文本
tool_call_id          Run 内 Tool call identity
tool_kind             builtin | mcp
tool_name             public tool name
mcp_server_id         nullable
mcp_tool_id           nullable
summary               public summary
input_json             sanitized bounded payload
progress_json          sanitized bounded payload
output_json            sanitized bounded payload
payloads_truncated     Run 总预算导致一个或多个 payload 被截断
error_json             safe AppError
approval_id            nullable
started_at             nullable UTC epoch milliseconds
completed_at           nullable UTC epoch milliseconds
last_event_seq         最近一次投影事件
created_at
updated_at
```

约束与索引：

- `UNIQUE(run_id, position)`
- Tool 行使用 `UNIQUE(run_id, tool_call_id)`
- `INDEX(session_id, run_id, position)`
- `INDEX(run_id, last_event_seq)`
- kind 与必填列使用数据库 check constraint 和应用 Zod schema 双重校验

`chat_runs.public_tool_payload_bytes` 原子记录已接受的 public Tool payload 字节数，并由数据库约束在
2 MiB 内。`chat_runs.assistant_content` 以及所有“最终文本覆盖 Assistant message”的 repository 逻辑直接删除。
Session 搜索改为索引 TextPart content 和 ToolPart public summary，不维护第二份 Assistant 正文。

### 7.2 原子写入

Repository 提供单一入口：

```ts
appendEventAndProject(input: {
  runId: string;
  event: ChatRunEvent;
  projectionMutation: TimelineProjectionMutation;
}): Promise<ChatRunEventEnvelope>;
```

一次事务必须：

1. 校验 Run 仍接受该状态转换。
2. 分配下一个 `seq`。
3. 插入 `chat_run_events`。
4. 创建或更新 `chat_run_parts`。
5. 必要时更新 `chat_runs.status`。
6. 提交事务。

事务提交成功后，`ProductEventHub` 才能 publish。不得先发送 WebSocket event，再异步补写数据库。

### 7.3 无兼容切换

产品尚未发布，本次实现直接修改 schema 和公共合同：

- 不增加 `timelineVersion`。
- 不读取或转换旧 `assistant_content`。
- 不为旧 event payload 增加解析分支。
- 不编写历史 backfill。
- 不双写旧消息和新 timeline。
- 不保留旧 Client capability gate。

开发环境在切换时明确 reset Product DB 与对应 Pi Session 开发数据。旧数据可以留在开发者手工备份中，
但新应用不承诺读取。最终 fresh-only Product DB schema 版本为 `30`。

## 8. Public Tool Projection

### 8.1 完整落盘的定义

“完整落盘”表示：

- 每个工具调用都存在稳定 ToolPart。
- 每个用户可见状态变化都先持久化。
- 文本与工具顺序可以完整恢复。
- UI 展示过的安全参数、进度、结果和错误可以完整恢复。
- 截断行为、原始字节数和脱敏发生情况可见。

它不表示把无限长度、未经处理的原始命令、文件内容、stdout 或 MCP payload 复制进 timeline
projection 或 `chat_run_events`。Action intent 等现有 server-only 执行记录仍遵循各自的数据边界。

### 8.2 安全处理流水线

新增 Agent Server-owned `ToolPublicProjectionService`。参数或结果进入 `chat_run_events` 前依次执行：

1. 使用 Tool 合同完成结构校验和规范化。
2. 应用每种 Tool 的字段 allowlist/denylist。
3. 对敏感键递归脱敏，例如 `password`、`token`、`secret`、`authorization`、`cookie` 和 env。
4. 对本次 invocation 明确注入的所有非空 Secret value 做精确替换，包括短 Secret、JSON key、
   JSON value 和 MCP 异常消息；projection service 只接收短生命周期的
   redaction set，不枚举 SecretStore，也不把 Secret 值写入扫描日志。
5. 对非结构化文本执行 credential/token 高信号模式扫描。
6. 将绝对路径转换成 Project/Runtime scope 下的安全相对展示。
7. 应用单字段、单 payload、单 Tool 和单 Run 大小限制。
8. 生成新的 public payload；原对象不得作为 fallback。

```ts
interface ToolPublicPayload {
  format: "text" | "json" | "content";
  value: string | JsonValue;
  truncated: boolean;
  originalBytes?: number;
  redactionCount: number;
}
```

建议初始限制：

| 内容 | 上限 |
| --- | --- |
| 单次 public input | 64 KiB |
| 单个 progress event | 32 KiB |
| 单次 public final output | 256 KiB |
| public error details | 32 KiB |
| 单 Run public tool payload 总量 | 2 MiB |

达到 Run 总量上限后仍必须持久化后续 ToolPart 及状态，只将其 payload 标记为 truncated。

### 8.3 Tool 特定规则

| Tool | Public input/output |
| --- | --- |
| `read` / `grep` / `find` / `ls` | 安全相对路径、脱敏后的 pattern/options、截断结果 |
| `edit` / `write` | input 仅保留路径和内容字节数/编辑数量，progress/output 仅保留状态摘要、结果字节数、变更行数和首个变更行；不持久化文件正文、edit 内容、diff、patch 或额外字段 |
| `bash` | 经 Secret 替换、模式扫描和限长后的命令；输出使用相同流水线 |
| MCP | 递归保留安全 JSON 结构；敏感字段值替换为 `[redacted]`；保留 Server/Tool identity |

这会替换当前 MCP“只保留参数键名”和 shell 固定 `shell [arguments hidden]` 的最小审批摘要。审批风险分类仍由
Action Broker 独立计算，public projection 不能降低风险或绕过审批。

任意 shell 和非结构化 Tool 输出都可能包含应用未知的自定义 Secret。该剩余风险必须在
[`security-data.md`](../product/security-data.md) 中保持明确；实现不能声称扫描器能证明任意文本无 Secret。
原始参数和结果仍不得进入 timeline event、Product RPC、Desktop WebView 日志或普通诊断。

## 9. Approval、Action 与恢复

### 9.1 Approval 关联

所有系统使用 `(runId, toolCallId)` 关联同一次调用：

```text
ToolPart queued
  -> policy check
  -> waiting_approval
  -> denied
  -> running
  -> completed | failed | cancelled | outcome_unknown
```

Approval request、用户决定、Action intent/grant 和对应 ToolPart 状态必须在同一个 Product DB transaction
内提交。若现有 service 边界不能直接共享事务，则在原业务事务内写入 transactional outbox，由 timeline
projector 幂等消费；不得先提交业务状态，再依赖一次无 outbox 的事后调用补写 timeline。

Action 成功结果的 public projection 与 `action_intents.result_json`、Action 终态在同一事务写入
`run_timeline_outbox.public_output_json`。即使进程在 Action 完成后、Pi `tool_execution_end` 前退出，
重启后的 outbox drain 仍会恢复 ToolPart 终态和安全 output；Pi 后到事件只能对账，不能成为唯一结果来源。

Pi 的 `tool_execution_start` 只表示 Agent loop 准备调用 Tool wrapper，不是主机副作用已经开始。Approval
service 是 waiting/denied 的权威来源，Action dispatcher 或可信 invocation receipt 是 running 和执行终态的
权威来源；Pi `tool_execution_end` 用于补充模型可见结果，但不能把 `outcome_unknown` 降级成普通 failed。

ToolCard 内嵌现有审批操作，不再在消息末尾创建一张与工具顺序脱离的重复卡片。

用户从待审批 ToolCard 点击 “Allow all for this Session” 时，服务端必须在同一个事务中启用 Session
策略并批准当前请求，随后立即唤醒等待中的 Action；不能要求用户再点击一次 “Approve once”。策略或
Approval 的 revision 校验失败时两者都不得提交。不可覆盖的关键操作不能使用该组合操作。

### 9.2 Agent Server 重启

启动 reconciliation 扫描非终态 Run 和 ToolPart，并与 `action_intents`、approval 和 invocation receipt 对账：

- Action 已有可信终态：将 ToolPart 更新到相同终态。
- 尚未签发 grant：标记 cancelled。
- 等待审批但 Run 已中断：取消审批并标记 cancelled。
- 已派发副作用但没有可信 receipt：标记 `outcome_unknown`。
- 可以证明失败或取消：分别标记 failed/cancelled。

`outcome_unknown` 不自动重放非幂等 Action。reconciliation 产生的每个变化仍写入
`chat_run_events`，因此重启后的修正也能被 Client replay。

## 10. Snapshot、订阅与回放

### 10.1 初次和历史读取

Session page 查询一页 Run，并用一次批量查询加载该页全部 Part：

```sql
SELECT *
FROM chat_run_parts
WHERE run_id IN (?, ?, ...)
ORDER BY run_id, position;
```

完成态和运行态使用同一种 snapshot，不再为完成态省略事件轨迹。历史读取依赖 materialized parts，不需要回放
全部 text delta 和 progress event。服务端除 Run 数量上限外，还按完整响应的 UTF-8 编码字节分页，并为
Product RPC envelope 预留空间；若第二个 Run 会突破 4 MiB frame，则只返回第一个 Run，并以最后一个已返回
Run 生成下一页 cursor。

### 10.2 实时订阅

1. Client 获取 snapshot 和每个 Run 的 `lastEventSeq`。
2. Client 从 watermark 之后订阅 Session events。
3. Agent Server replay 缺失的 durable events，再切换 live publication。
4. Client 按 `(runId, seq)` 去重。
5. 发现 gap 时停止应用后续事件并请求 replay/resnapshot。

Desktop 将 live delivery 的可选 `clientRequestId` 一直透传到 renderer，用它关联 send response 返回前到达的
新 Run 事件；`runId` 与 client request ID 是两个不同 identity，禁止相互比较。

Mobile 遇到 snapshot 中不存在的 Run 时先排队 live event 并重新读取 Session snapshot，不直接从 `seq = 0`
猜测或 replay。Mobile replay 会循环处理 `hasMore`，并执行 `resnapshotSessionIds` 与
`retiredSessionIds` 指令。Mobile 首期只显示文本，因此 snapshot 中不保留 ToolPart，Tool event 仅推进
`lastEventSeq`，避免在手机内存中保存不展示的 public Tool payload。

renderer 重载只重建 Client 内存状态，不影响 Agent Server 中的 Run。重新打开 Session 得到的 Part ID、
position、状态和 public payload 必须与重载前一致。

## 11. Desktop 状态与 UI

### 11.1 共享 reducer

新增纯 TypeScript timeline reducer，输入只包含公共 snapshot/event：

```ts
interface RunTimelineState {
  runId: string;
  status: ChatRunStatus;
  userMessage: ChatUserMessage;
  partsById: Map<string, ChatRunPart>;
  orderedPartIds: string[];
  lastSeq: number;
}
```

Reducer 规则：

- `part.created` 按 ID 幂等插入。
- text delta 只应用于匹配的 TextPart 和更高 revision。
- Tool update 只接受更高 revision 的完整快照。
- `orderedPartIds` 只按 `position` 排序。
- Run 终态不修改 Part content。
- 重复 event 无副作用；seq gap 触发 resync，不猜测缺失状态。

Desktop 与 Mobile reducer 必须遵循同一公共 snapshot/event 合同、position/revision/seq 规则。公共合同切换
时同步更新两端 parser 和类型使用，使 monorepo 始终可构建；首期 Mobile 仅保留并渲染 TextPart，Tool event
只推进 cursor。后续增加 Mobile ToolCard 时不再修改 Server 合同。

### 11.2 组件结构

```text
MessageList
└── RunTranscript
    ├── UserBubble
    └── RunPartList
        ├── AssistantTextPart
        ├── ToolGroup
        │   ├── ToolCard
        │   └── ToolCard
        ├── AssistantTextPart
        └── ToolCard
```

ToolCard 折叠态展示：

- Tool 图标、名称和安全摘要。
- queued、等待审批、运行、成功、失败等状态。
- elapsed time 或最终 duration。
- 输出截断、脱敏或 outcome unknown 提示。

展开态展示：

- 脱敏后的 Input。
- 流式 Progress。
- 结构化 Output。
- safe error。
- Approval 风险、原因和操作。

交互规则：

- Tool 默认以单行紧凑态折叠展示；hover 或键盘 focus 时显示向右箭头，点击展开后箭头转向下。
- waiting approval 为避免隐藏用户操作而自动展开；running、completed、failed 和 outcome unknown 默认折叠。
- 同一 `assistantTurnId` 下连续 ToolPart 可组成 ToolGroup。
- Agent TextPart 始终保留原位置，工具完成后不得移动到文本末尾。
- 只有用户位于列表底部时自动跟随新内容；用户向上滚动时不抢夺位置。
- streaming 状态使用无障碍 live region，但高频 progress 不逐字符朗读。

## 12. 代码改动范围

| 层 | 主要改动 |
| --- | --- |
| `packages/contracts/src/chat.ts` | 删除旧 Assistant message event，定义 Run snapshot、Part、public payload 和 timeline event |
| `packages/agent-runtime/src/pi-agent-runtime.ts` | 转发完整 Pi text/tool 生命周期，生成 turn/part identity，使用可等待事件路径 |
| `packages/database/src/schema.ts` | 新增 `chat_run_parts`，删除 `assistant_content` 及旧消息约束 |
| `packages/database/src/run-journal-repository.ts` | 原子 append + projection、parts snapshot/history query、reconciliation 写入 |
| `apps/agents-server/src/chat-application-service.ts` | `RunTimelineWriter`、事件映射、terminal flush，删除最终文本覆盖 |
| `apps/agents-server/src/product-event-hub.ts` | 发布新 timeline union，保留现有 replay/watermark 语义 |
| Action/Approval services | 通过 `(runId, toolCallId)` 更新 ToolPart 的审批与结果状态 |
| `packages/action-broker` | 保留风险分类，新增或调用 public projection，不再把审批摘要当 ToolCard 详情 |
| 新共享 timeline package | snapshot/event reducer、排序、revision 和 seq gap 处理 |
| Desktop chat transport/controller | 直接消费 Run snapshot 与 timeline event，不再丢弃 Tool event |
| Desktop message list | RunTranscript、TextPart、ToolGroup 和 ToolCard |
| Mobile | 最终合同、完整 snapshot/replay 恢复和文本时间线；首期不渲染或缓存 ToolPart |

## 13. 实施顺序

### 阶段 1：最终合同与数据库

1. 修改 Chat contracts。
2. 新增 `chat_run_parts` 并删除旧 Assistant content 模型。
3. 实现事务型 timeline repository 和 snapshot 查询。
4. 同步更新 Desktop/Mobile parser 的类型使用，删除旧事件分支。
5. reset 开发 Product DB/Pi Session 数据。

### 阶段 2：Runtime 与 Application Service

1. 完整适配 Pi text/tool 事件。
2. 实现 `RunTimelineWriter`、flush barrier 和 publish。
3. 接入 Tool public projection。
4. 串联 Approval、Action 和 startup reconciliation。
5. 删除 terminal final text overwrite。

### 阶段 3：Desktop Run Aloud

1. 实现共享 reducer。
2. 重写 Desktop chat transport/controller。
3. 实现 TextPart、ToolCard、ToolGroup 和 inline approval。
4. 接入 reload、replay、gap resync 和虚拟列表滚动行为。

### 阶段 4：Mobile UI

复用相同 snapshot、event 和 reducer，实现适配移动端密度的 ToolCard。Agent Server 不再为 Mobile 修改协议。

## 14. 测试矩阵

### 14.1 Runtime 单元测试

- `text -> tool -> text` 产生三个有序 Part。
- 一个 AssistantMessage 中多个 ToolCall 按 content index 分配 position。
- 并行工具逆序完成不改变显示顺序。
- Tool failure、deny、cancel 和 abort 映射到正确状态。
- thinking event 不产生 timeline event。
- message end 对账 provider 的最终 text/tool content。

### 14.2 Repository 和服务测试

- event 与 Part projection 同事务提交。
- commit 失败时不 publish。
- 并发更新仍获得连续唯一 seq。
- snapshot 对完成态和运行态返回同样完整的 parts。
- replay 后 reducer 状态与直接 snapshot 相同。
- Run terminal 不覆盖或删除已有 TextPart。
- startup reconciliation 正确生成 `outcome_unknown`。
- Action 完成后、Pi end 前退出时，outbox 可以恢复 ToolPart output。
- 两个合法大 Run 会按 UTF-8 响应字节拆页，单帧不超过 Product RPC 预算。

### 14.3 安全测试

- 已知 Secret、认证 Header、token、cookie 和敏感 env 不出现在 event、parts、RPC 或日志。
- shell command 和非结构化输出经过同一 public projection。
- MCP 深层对象、数组、对象 key、短 Secret 和异常消息被递归脱敏，且保留 definitive/unknown 错误分类。
- `edit` / `write` input/progress/output 均不包含文件正文、edit 内容、diff、patch 或额外字段。
- input/output/Run 总量达到限制后状态仍完整、payload 明确 truncated。
- public projection 异常时 fail closed，不回退原始 payload。

### 14.4 Desktop reducer/UI 测试

- snapshot 初始化、重复 event、seq gap 和 replay。
- TextPart/ToolPart 交错渲染。
- Tool progress、审批和终态原位更新。
- renderer reload 前后生成相同语义树。
- 用户向上滚动时不被新 progress 强制拉回底部。

### 14.5 端到端验收

使用确定性的 fake runtime 产生：

```text
文本 A -> 并行工具 1/2 -> 文本 B -> 工具 3 -> 文本 C
```

必须验证：

1. 工具 2 先于工具 1 完成，但 UI 仍按 1、2 排列。
2. 在工具运行中重载 renderer，状态、进度和顺序不变。
3. 在 Run 完成后重启应用，恢复内容与实时结束时一致。
4. 在 Tool start 持久化事务失败时，工具没有开始执行。
5. 在已派发副作用后模拟断线，UI 显示 outcome unknown 而非成功。
6. Product DB、RPC capture 和 Desktop 日志中不存在测试 Secret。
7. 文本 A/B/C 均保留，最终回答没有覆盖中间文本。

## 15. 完成定义

Run Aloud 完成需要同时满足：

- 每个 Agent Tool/MCP 调用都创建 durable ToolPart。
- 所有 UI 可见状态先持久化后发布。
- 文本和工具可以任意交错且位置稳定。
- 完成态历史不依赖事件全量回放。
- reload、reconnect 和 restart 能恢复同一时间线。
- Approval 和 outcome recovery 原位更新同一 ToolPart。
- 原始敏感 payload 不进入产品事件和 UI。
- 不存在旧消息双写、历史 fallback 或兼容分支。
