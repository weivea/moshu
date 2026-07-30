# Projects 管理与 Project Chat 技术设计

> 文档版本：v1.0  
> 状态：已实现并通过仓库质量门  
> 更新日期：2026-07-30  
> 范围：基础 Project 管理、Project Session 管理、Project Chat 运行上下文

## 1. 背景与目标

设计启动时，仓库已经具备 Runtime Box scoped Project 的基础骨架：

- Project Zod contract、SQLite repository 和 Product RPC 已存在。
- Runtime Box 可以规范化目录路径，并探测 Git root 与 branch。
- Desktop 已有 Project 列表、添加、归档、恢复、删除和占位详情页。

当时 Project 仍是孤立记录：

- Project 更新 RPC 只支持名称，Desktop 尚未接入。
- Project Chat 路由仍是占位页；`ChatSession` 没有 `projectId`。
- 全局 Chats 无法区分普通 Session 和 Project Session。
- Agent runtime 对所有线程使用 Agent Server 私有 workspace；Project 路径不是 Tool cwd。
- Run 没有 Project 路径快照，重新关联后无法解释历史执行位置。
- Remote Runtime Box 会把 Tool cwd 覆盖为 daemon fixed workspace，不能执行任意已登记 Project。
- Project 和 Session 元数据修改错误地依赖 Runtime Box ready。

本次建立以下闭环：

1. 用户可以在当前 Runtime Box 下添加、查看、编辑、归档、恢复、重新关联和永久移除 Project。
2. Project 拥有多个不可迁移的 Session；普通 Chats 与 Project Sessions 严格分离。
3. Project Chat 复用现有 Chat 页面和 controller，但 Run 使用 Project 路径、Runtime Box 和根
   `AGENTS.md` 上下文。
4. 文件类 Tool 严格限制在 Project 根目录；`bash` 以 Project 为默认 cwd，但本轮不实现 shell sandbox。
5. 路径失效、Runtime Box 离线、Project 归档和级联删除具有明确、可恢复且不删除宿主文件的语义。

上述闭环现已落地。实现覆盖 contracts、产品数据库、Agent Server Project application service、
Project Session/Run、Runtime Box path inspector 与 `project-root` Tool 边界、Desktop Projects/Project Chat，
并由 `bun run check` 统一验证。

## 2. 已确认的产品决策

| 主题 | 决策 |
| --- | --- |
| 功能边界 | 同时交付 Projects 管理和 Project Chat |
| Session 归属 | Project Session 仅显示在所属 Project；全局 Chats 只显示普通 Session |
| Session 迁移 | 创建后不可在普通 Chat、不同 Project 间移动 |
| Session 管理 | 搜索、重命名、归档/恢复、删除、新建和进入能力与普通 Session 一致 |
| 本地添加 | 使用 Electrobun 系统目录选择器 |
| 远程添加 | 输入远端绝对路径，由目标 Runtime Box 校验 |
| 创建流程 | “校验预览 -> 用户确认 -> 创建”两步流程 |
| 创建检查 | 可访问性、规范化路径、Git 信息；不做敏感文件识别、递归扫描或索引 |
| 路径失效 | 保留 Project 与历史 Session，标记不可用，并允许在同一 Runtime Box 重新关联 |
| 路径刷新 | 进入详情和启动新 Session/Run 前实时校验；列表显示最近结果并支持手动刷新 |
| 重叠路径 | 允许父子 Project；只禁止同一 Runtime Box 下规范化后完全相同的路径 |
| 归档路径冲突 | archived Project 仍占用路径；提示恢复，不创建重复记录 |
| Project 字段 | 本轮只管理名称和路径；Runtime Box、Git 信息只读 |
| Runtime Box 视图 | 只显示 active Runtime Box 的 Projects；深链按 Project 固有归属解析 |
| Project 归档 | Project 整体隐藏，但不改写所属 Session 的归档状态 |
| 归档后能力 | 可查看历史并管理 Session 元数据；不可新建 Session、发送消息或修改 Project |
| 永久删除 | 输入 Project 名称确认并显示 Session 数；删除产品记录与会话数据，不碰目录文件 |
| 活跃 Run | 存在非终态 Run 时禁止重新关联、归档和永久删除 |
| 离线能力 | 可查看历史、修改 Server-owned 元数据；阻止路径操作、新建 Session 和发送消息 |
| 重新关联 | 全部 Session 的后续 Run 使用新路径；历史 Run 保留原路径快照 |
| Project Chat | 复用普通 Chat 页面/controller，增加 Project 标识、返回入口和上下文状态 |
| 不可运行状态 | 历史消息可读；composer 禁用并显示原因与修复入口 |
| Project 上下文 | 注入 Project/Runtime/Git/权限元数据，自动加载根 `AGENTS.md`，文件按需读取 |
| `AGENTS.md` | 本轮只处理 Project 根文件；不可读、类型错误或超限时警告并跳过 |
| Tool 边界 | 文件类 Tool 严格限制 Project 根；`bash` 默认 cwd 为 Project，但可离开目录 |
| Session 默认值 | 与普通 Chat 一致，沿用当前 Agent mode 和全局默认模型 |
| Project 排序 | 按创建时间倒序 |
| 数据升级 | 沿用现有 DB 版本机制，协调 reset 开发数据，不建设增量 migration |
| 左侧栏 | Project 可展开，显示最近 8 个 active Sessions 和“查看全部” |
| 展开状态 | 按 Runtime Box 持久化 |
| Project 点击 | 有 active Session 时打开最近使用者；否则新建；archived Project 进入概览 |
| Project 菜单 | 提供编辑、归档/恢复和删除 |
| 页面路由 | `/projects/:id` 为概览；`/projects/:id/settings` 为统一编辑页 |
| 编辑页 | 名称、路径状态/重新关联、Runtime/Git 只读信息、归档和危险删除区 |

## 3. 信息架构与交互

### 3.1 路由

| 路由 | 页面与行为 |
| --- | --- |
| `/projects` | 当前 Runtime Box 的 active Projects，可切换 archived 视图 |
| `/projects/:projectId` | Project 概览、路径状态、完整 Session 管理和新建入口 |
| `/projects/:projectId/settings` | 统一 Project 编辑页 |
| `/projects/:projectId/chat/new` | 新建 Project Session，复用现有新 Chat 流程 |
| `/projects/:projectId/chat/:sessionId` | Project Chat，校验 URL Project 与 Session 归属一致 |

深链不依赖当前 active Runtime Box。Server 先按 `projectId` 读取 Project，再使用其固有 Runtime Box。深链不会
静默切换全局 active Runtime Box，也不会把 Session 路由到当前 Box。

### 3.2 左侧栏

- 只查询 active Runtime Box 的 active Projects，按 `createdAt DESC, id DESC` 排序。
- 每个 Project 有展开按钮、名称点击区和右上角菜单。
- 展开后显示最近 8 个 active Sessions，按最近消息/更新时间倒序，并提供“查看全部”。
- 点击 Project：
  - 有 active Session：打开最近使用的 Session。
  - 无 active Session：进入 `/projects/:projectId/chat/new`。
  - Project 已归档：进入 Project 概览。
- 展开集合按 `runtimeBoxId` 存入 Desktop local storage。
- archived Project 不出现在常规侧栏，只在 archived Projects 页面和直接深链中出现。

### 3.3 添加 Project

本地 Runtime Box：

1. WebView 调用最小 Desktop RPC。
2. Electrobun Bun 侧使用 `Utils.openFileDialog`，设置 `canChooseFiles: false`、
   `canChooseDirectory: true`、`allowsMultipleSelection: false`。
3. 取消选择返回显式 `cancelled`，不显示错误。
4. 选中路径送往 Agent Server Project preview RPC。

远程 Runtime Box：

1. 用户输入目标主机的绝对路径。
2. Agent Server 将 preview 请求路由到目标 Runtime Box。

预览展示：

- Runtime Box 名称和平台。
- 输入路径与规范化路径。
- 默认 Project 名称。
- Git root、branch 或 detached/non-Git 状态。
- Agent 默认获得的 Project 根文件范围。
- 根 `AGENTS.md` 状态：可加载、缺失或警告；preview 不返回正文。

确认创建时必须重新校验。若规范化路径、Git root 或 `AGENTS.md` 状态发生影响决策的变化，返回
`PROJECT_PREVIEW_STALE`，要求重新确认，不能静默按新结果创建。

### 3.4 Project 概览与设置

概览页：

- Project 名称、路径状态、Runtime Box 和 Git 信息。
- active/archived Session 切换、搜索、完整列表和 Session 管理菜单。
- 新建 Session 入口。
- 路径不可用、Box 离线、Project archived 时显示状态横幅和修复入口。
- 手动刷新路径状态。

设置页：

- active Project 可修改名称。
- 路径区展示最后检查状态、时间与安全错误码。
- 重新关联复用添加时的 picker/input + preview 流程。
- Runtime Box 不可修改。
- Git 信息只读，并随成功路径检查刷新。
- archived Project 只能恢复或永久删除，其他 Project 字段只读。
- 危险区显示 Session 统计；永久删除要求输入当前 Project 名称。

### 3.5 Project Chat

- 复用现有 Chat 页面、消息流、composer、模型选择、Session 恢复和事件订阅。
- Header 增加 Project 名称、路径状态、Runtime Box 状态和返回 Project 入口。
- 下列任一条件成立时 composer 禁用，历史保持可读：
  - Project archived。
  - Runtime Box 非 ready。
  - Project path unavailable，或实时检查失败。
  - Project 正在删除。
- Session 重命名、归档/恢复、删除等 Server-owned 元数据操作不依赖 Runtime Box ready；
  Project archived 时也允许。

## 4. 领域模型与数据库

### 4.1 Project

```ts
type ProjectPathStatus = "unknown" | "available" | "unavailable";

interface Project {
  id: ProjectId;
  runtimeBoxId: RuntimeBoxId;
  name: string;
  path: string;
  pathRevision: number;
  pathStatus: ProjectPathStatus;
  pathCheckedAt?: string;
  pathIssueCode?: ProjectPathIssueCode;
  gitRootPath?: string;
  gitBranch?: string;
  createdAt: string;
  updatedAt: string;
  archivedAt?: string;
  deletionRequestedAt?: string;
}
```

`pathIssueCode` 使用有限枚举，例如 `not_found`、`not_directory`、`permission_denied`、
`canonical_path_changed`、`unknown`。不持久化或向 UI 透传原始系统错误、用户名、环境变量或任意 host
诊断。

Runtime Box 离线不等于 path unavailable。离线是 connection state；path status 保留最后结果并标记 stale。

### 4.2 Session

`chat_sessions` 增加 nullable `project_id`：

- `NULL` 表示普通 Session。
- 非空表示 Project Session。
- `projectId` 创建后不可修改，不提供 move RPC。
- Project Session 的 `runtimeBoxId` 由 Server 从 Project 复制；客户端不能指定冲突值。
- 增加 `(project_id, archived_at_ms, last_message_at_ms, updated_at_ms)` 索引。
- 删除 Project 必须通过 durable deletion workflow retire Sessions，不依赖简单 FK cascade。

`chat_session_create_requests` 同步保存 `project_id`，并将其纳入 idempotency 参数比较。

### 4.3 Run 路径快照

Project Run 创建时持久化不可变快照：

```ts
interface ProjectRunContext {
  projectId: ProjectId;
  runtimeBoxId: RuntimeBoxId;
  projectPath: string;
  projectPathRevision: number;
  gitRootPath?: string;
  gitBranch?: string;
  rootAgentsHash?: string;
}
```

- 重新关联只影响未来 Run。
- active Run 始终使用开始时的 `projectPath`。
- 历史 UI 可以解释 Run 当时使用的路径。
- 普通 Session 的 Run 不包含 Project context。

### 4.4 数据库版本与 reset

仓库当前没有 incremental migration runner。Schema 由单一 fresh-create migration 管理；`user_version` 不匹配
时，由 coordinated reset 删除并重建开发数据库。项目尚未首次外部发布，现有数据策略允许明确 reset。

本轮沿用该机制：

1. 提升 `currentAppDatabaseVersion` 并更新完整 fresh-create schema。
2. coordinated reset 同时处理 DB、WAL/SHM，并只递归删除 Agent Server 数据目录下经校验为普通目录的
   `sessions` 子目录；credentials、providers、MCP、Skills、diagnostics 与其他文件保持不变。目标为符号链接
   或非目录、或删除失败时启动必须停止，避免 DB 已重建但旧 JSONL 仍可恢复。
3. reset 前通过现有错误合同明确提示开发数据不兼容；不声称保留现有 Project、Session 或 Run。
4. 测试覆盖旧版本触发 reset-required、新 schema 完整建立和 reset epoch 隔离旧 Runtime Box journal。

首次外部发布冻结 schema 后，再单独建设 incremental migration、backup 和 rollback gate。

## 5. Query 与 RPC

### 5.1 Session scope

Session list 使用显式 discriminated scope：

```ts
type SessionListScope =
  | { kind: "global"; runtimeBoxId?: RuntimeBoxId }
  | { kind: "project"; projectId: ProjectId };
```

- `global` 强制 `project_id IS NULL`。
- `project` 强制 `project_id = :projectId`，不依赖 active Runtime Box。
- 未传 scope 的旧调用按 `global` 解释，防止 Project Session 泄漏到 Chats。

### 5.2 Project RPC

| 方法 | 目的 |
| --- | --- |
| `projects.previewPath` | 路由到目标 Box，返回规范化路径、Git 与根 `AGENTS.md` 状态 |
| `projects.create` | 重新校验 preview 后创建 |
| `projects.list` | 当前/指定 Box 下按 active 或 archived 列表 |
| `projects.get` | 获取 Project 与 Session 统计 |
| `projects.checkPath` | 实时检查并更新最后 path status |
| `projects.updateName` | Server-owned 元数据更新，不要求 Box ready |
| `projects.previewRelink` | 对同一 Box 新路径执行预览 |
| `projects.relink` | 无非终态 Run 时重新校验并递增 `pathRevision` |
| `projects.setArchived` | 无非终态 Run 时归档/恢复，不改 Session archived 状态 |
| `projects.delete` | 名称确认、活跃状态检查、进入 durable 分批 retirement |
| `projects.getSidebar` | 一次查询 Projects、每项最近 8 个 active Sessions 和计数 |

所有 mutation 使用 strict Zod contract。错误映射为稳定业务码，不向 UI 暴露 SQLite、filesystem 或底层 RPC
原始错误：

- `PROJECT_NOT_FOUND`
- `PROJECT_PATH_CONFLICT`，指出冲突 Project 是否 archived
- `PROJECT_PREVIEW_STALE`
- `PROJECT_RUNTIME_UNAVAILABLE`
- `PROJECT_PATH_UNAVAILABLE`
- `PROJECT_ARCHIVED`
- `PROJECT_HAS_ACTIVE_RUNS`
- `PROJECT_NAME_CONFIRMATION_MISMATCH`
- `PROJECT_SESSION_MISMATCH`
- `PROJECT_RELINK_RUNTIME_MISMATCH`

## 6. Path inspection 与健康状态

Runtime Box Project inspector：

- 要求绝对路径。
- 使用 `realpath` 规范化，并验证为可读、可遍历目录。
- 探测包含 `.git` directory 或 gitdir pointer 的最近 Git root 和 branch。
- 只 `lstat` Project 根 `AGENTS.md`；正文由 Run preflight 单独读取。
- 返回结构化安全错误码。

检查触发：

- 创建 preview 与确认。
- 重新关联 preview 与确认。
- 进入 Project 详情。
- 新建 Project Session 前。
- 每个 Project Run 开始前。
- 用户手动刷新。

Project 列表不逐项实时 RPC，避免 Remote Box N+1 延迟，只显示 persisted last-known status。

如果相同存储路径的 `realpath` 结果变化，不静默覆盖 Project path。记录 `canonical_path_changed`，要求用户通过
重新关联流程确认。

## 7. Project 上下文与根 `AGENTS.md`

每个 Run preflight：

1. 读取 Project 和 Session，验证不可变归属。
2. 验证 Project active、Runtime Box ready、path available。
3. 从 Runtime Box 读取 Project 根 `AGENTS.md`，只接受普通文件，不跟随该文件自身的 symlink。
4. 使用固定 UTF-8 大小上限，初始值 64 KiB。
5. 不可读、类型错误、编码错误或超限时产生可见 warning，跳过内容但不阻止 Run。
6. 计算 content hash，写入 Run context；正文只进入当前 Agent memory，不写产品 DB、事件、诊断或日志。

系统上下文包含：

- Project 名称与 canonical root。
- Runtime Box 标识与平台。
- Git root/branch。
- 文件 Tool 必须限制在 Project root 的规则。
- `bash` 默认 cwd 和本轮没有 shell sandbox 的事实。
- 可用时的根 `AGENTS.md` 正文。

本轮不自动发现或强制加载子目录 `AGENTS.md`。

## 8. Agent runtime 与 Tool 边界

### 8.1 解耦 Pi cwd 与 Executor cwd

Remote Project path 不能作为 Agent Server 上 Pi `SessionManager` 的本地 cwd：

- Pi Session 与 `DefaultResourceLoader` 继续使用 Agent Server private workspace。
- Pi builtin file/command tools 继续禁用。
- `AskChatRunInput` 增加显式 execution context。
- custom Executor Tool definitions 按 thread/Run 使用 `projectPath` 作为发往 Runtime Box 的 cwd。
- `projectPathRevision` 或根 `AGENTS.md` hash 变化时，刷新 thread runtime resource fingerprint 和
  system context，同时复用原 Pi Session history。

### 8.2 `project-root` execution scope

现有 scope 不能准确表达 Project：

- `request-cwd` 在 Local Box 不执行 containment。
- `runtime-box-workspace` 在 Remote Box 忽略请求 cwd，强制使用 daemon fixed workspace。

新增 `project-root`：

- Agent Server grant 将 execution scope、Project cwd、path revision 和调用参数纳入 parameter digest。
- Local/Remote Runtime Box 都接受已验证的 Project cwd。
- Runtime Box 对 cwd 执行 `realpath`。
- `read/edit/write/grep/find/ls` 的显式或默认路径执行 lexical + canonical containment。
- symlink 逃逸和不存在目标的最近存在父目录逃逸均拒绝。
- `bash` 使用 Project cwd 启动，但不执行 cwd containment。
- 普通 Session 继续使用现有 private workspace，不扩大权限。

`project-root` 是 per-invocation policy，不能由 connection 静态 handler options 推断。Tool handler 按已验证授权
逐次选择：

- `runtime-box-workspace`：只允许配置 daemon workspace 的 Remote Box，忽略请求 cwd。
- `request-cwd`：只允许受信任 Local Box 的既有普通 Session。
- `project-root`：Local/Remote 都使用请求的 canonical Project cwd，并开启文件 containment。

Runtime Box 拒绝与 deployment kind 不兼容的 scope。它必须先验证 parameter digest、origin/target identity、
generation、expiry 与 scope compatibility，再选择 cwd policy。

### 8.3 POC 信任边界

文件 Tool containment 只减少文件 Tool 的意外越界，不是完整 sandbox。Agent 仍可通过 `bash` 访问 Runtime Box
进程账户能够访问的其他路径。对 Remote Box，`project-root` 也会扩大 `bash` 可选择的 cwd 范围。

添加确认页、Project Chat 状态和安全文档必须明确这一点。真正的 Project 级隔离依赖后续 shell sandbox。

## 9. 生命周期与一致性

### 9.1 归档

- Server 在同一临界区内再次确认没有非终态 Run。
- 只设置 Project `archivedAt`，不改写 Session。
- archived Project 阻止 Project 字段修改、新建 Session 和新 Run。
- Session rename/archive/delete 等 Server-owned 元数据操作仍可执行。
- 恢复后 Session 各自原有 archived 状态不变。

### 9.2 重新关联

- 只允许同一 Runtime Box。
- Project 必须 active、Box ready，且没有非终态 Run。
- preview + confirm 再次校验。
- 冲突检查覆盖 active 和 archived Projects。
- 原子更新 path、Git、health，递增 `pathRevision`。
- 已打开 Session 不迁移 conversation；下一个 Run 使用新 revision。

### 9.3 永久删除

Desktop 显示 active/archived/总 Session 数并要求输入当前 Project 名称。Server 继续校验 `expectedName`，避免
名称变化后的误删。

Server 流程：

1. 串行化同一 Project 的 run start、archive、relink 和 delete。
2. 检查非终态 Run 和未对账 Runtime Box Action；任一存在则拒绝。
3. 在短事务内设置 `deletionRequestedAt` 并写 durable Project deletion job。常规 Project/Session 查询立即
   排除 deleting Project；所有新 Run 和 mutation fail closed。
4. deletion worker 按固定批量选择 Sessions，复用既有 retirement 语义写 tombstone 与 Pi cleanup outbox，
   删除该批 live Session/Run/event/action。
5. 每批提交后发布 Session invalidation；崩溃后从持久 job 和剩余 live Sessions 恢复。
6. 全部 Session retire 后删除 Project row 和 deletion job；Pi JSONL 由现有 cleanup worker 最终删除。

批量流程避免大 Project 耗尽共享 tombstone/cleanup outbox 上限或形成超长 SQLite transaction。每批开始前执行
既有 TTL prune 并检查容量；容量不足时保留 job 为 retryable blocked，等待 cleanup/TTL 释放容量后恢复。非容量型 Session retirement
失败和最终 Project 删除失败也分别持久化稳定错误码、采用有界延迟重新调度，不能依赖 Server 重启恢复或在
进程内忙循环。

UI 可以展示“正在删除”，但不能重新显示或操作该 Project。任何流程都不删除 Project 目录。

### 9.4 离线

不要求 Box ready：

- list/get Project。
- Project rename、archive/restore、delete。
- Session rename、archive/restore、delete。

要求 Box ready：

- preview/create/relink/check path。
- 新建 Project Session。
- 发送 Project 消息和开始 Run。

离线删除仍必须确认没有持久非终态 Run 或未对账 Action，不能用“当前无内存任务”替代 durable 检查。

## 10. UI 与代码组织

将当前单体 `projects-page.tsx` 拆分为：

- Project RPC/query hooks 与显式 invalidation store。
- Projects list/add preview。
- Project sidebar tree。
- Project overview/session list。
- Project settings。
- Project status banners 与 destructive dialogs。

避免当前 module-level listener 与静默 `.catch(() => setProjects([]))`：

- 加载失败保留错误状态，不伪装为空列表。
- 请求使用 request identity/abort，防止 Box 或筛选切换后的 stale response。
- mutation 成功后按 Runtime Box/Project key 精确失效。

Chat 复用当前 controller：

- route adapter 提供 `projectId`。
- controller 从 Session snapshot 读取真实 `projectId`，不信任 URL。
- Project 与 Session 不匹配时显示稳定错误，并阻止订阅/发送。
- composer disabled reason 使用统一模型，不散落 boolean。

## 11. 验证策略

### 11.1 Contract

- Project path health、preview、relink、sidebar summary strict schema。
- Session scope discriminated union；默认 global 不返回 Project Session。
- Project Run context 与 `project-root` grant schema/digest。

### 11.2 Database

- DB version bump 触发 reset-required；coordinated reset 后只建立新 schema。
- reset 同步清理 Pi Session，并通过 journal epoch 拒绝旧 Runtime Box evidence。
- `projectId` 不可变、Runtime Box 一致、path 精确唯一。
- active/archived Project 与 Session 组合查询。
- sidebar 最近 8 条与 Project 创建时间排序。
- durable 分批 retirement、容量阻塞、重启恢复、tombstone 和 cleanup outbox。

### 11.3 Runtime Box

- Local/Remote 绝对路径、symlink canonicalization、gitdir、detached HEAD。
- 根 `AGENTS.md` 缺失、可读、symlink、超限和无效 UTF-8。
- `project-root` 相对/绝对路径、symlink 和不存在目标父目录 containment。
- per-invocation scope compatibility。
- Remote 普通 Session 仍强制 daemon workspace；Project Run 使用已验证 cwd。
- scope、cwd、path revision 被修改时 parameter digest 失败。
- `bash` 获得正确 cwd，且测试明确它不受文件 containment。

### 11.4 Agent Server

- preview stale、active/archived duplicate 和 offline error mapping。
- Server-owned metadata mutation 离线可用。
- archived/unavailable/offline Project 禁止 create/send。
- URL/Session Project 不匹配。
- Run preflight、根 `AGENTS.md` 注入和 path revision snapshot。
- active Run 阻止 archive/relink/delete。
- 离线级联删除、容量阻塞和崩溃恢复。

### 11.5 Desktop

- Local picker cancel/success；Remote 绝对路径输入。
- preview/confirm 与 stale preview 回退。
- sidebar 展开持久化、最近 8 条、菜单和点击跳转。
- Project 概览、设置、archived 只读和 typed delete confirmation。
- Project Chat 复用、状态 banner 和 composer disabled reason。
- Runtime Box 切换与 stale response 防护。

### 11.6 Integration

- Local Project：添加 -> 新建 Session -> 文件 Tool cwd/containment -> 重启恢复。
- Remote Project：输入路径 -> Project Chat -> Tool 使用远端 Project cwd，而不是 daemon fixed workspace。
- 路径移动 -> unavailable -> 历史只读 -> 重新关联 -> 新 Run 使用新 revision。
- Project 删除 -> Session 从 UI/RPC 消失 -> Pi JSONL cleanup 完成 -> 宿主目录仍存在。

## 12. 明确不在本轮

- 项目说明、默认 Agent/模型、排除规则、环境变量。
- 敏感文件识别、默认排除与逐文件授权。
- 递归目录扫描、文件统计、索引和知识库。
- 子目录 `AGENTS.md` 自动发现或强制执行。
- shell sandbox 或阻止 `bash` 离开 Project。
- Session 在普通 Chat/Project 或不同 Project 间移动。
- Git status/diff/revert、分支、提交和 Worktree 管理。
- Project scoped MCP/Skill 配置。

## 13. 实施顺序

1. 先落本设计文档并更新实施文档导航。
2. 扩展 contracts、fresh-create schema 与 DB version/reset gate。
3. 新建 Project application service，完成 preview、health、relink、archive 与 durable deletion。
4. 扩展 Session query 与 Chat service，严格分离 global/Project Session。
5. 打通 Run preflight、Project context、根 `AGENTS.md` 与 Run path snapshot。
6. 新增完整性绑定的 `project-root` grant 和 per-invocation Runtime Box cwd policy。
7. 实现 Desktop picker、Projects list/sidebar/overview/settings 与 Project Chat route adapter。
8. 补齐 contract、database、server、Runtime Box、Desktop 和三角色 integration tests。
9. 仅在实现与验证完成后更新[实施进度](./progress.md)。
