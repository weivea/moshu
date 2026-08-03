# Agent 与扩展生态

## 1. 能力模型

当前代码已交付动态 Provider、Moshu 七工具、Policy/Approval/grant，以及 Server/Runtime Box 双归属 MCP/Skill。
自定义 Agent、Knowledge、subagent、MCP OAuth 和 Skill script/resource 执行仍是目标能力；精确边界见
[实现状态](../implementation/progress.md)。本文件同时描述当前基础和后续产品要求，不应把目标条目视为已实现。

一个可运行 Agent 由以下配置组合而成：

```text
Agent
├── Identity：名称、图标、描述
├── Runtime Profile：当前 Runtime Box 上的 Tool/MCP/Skill 组合
├── Instructions：系统提示词与行为规则
├── Model policy：Provider、模型、参数与回退策略
├── Built-in tools：文件、命令、网页、Canvas 等
├── MCP tools：一个或多个 MCP Server 暴露的工具
├── Skills：按需加载的 Agent Skills
├── Knowledge：本地索引的知识源
├── Permissions：文件、命令、网络与工具策略
└── Subagents：默认或专用子 Agent
```

应用必须在运行前将以上配置解析为一份“有效配置”，并展示冲突、缺失凭证、不兼容模型或失效扩展。不得在运行时静默丢弃配置。

### 1.1 三角色映射

- agents server 保存 Provider/model、Agent/Run/Policy/Action、Agent Server-owned MCP、prompt-only Skill 和 Agent global refs；对 Box-owned MCP/Skill 只保存 stable ref 与非权威 inventory cache。
- 每个 Runtime Box 是自身 Box-owned MCP config/credential/OAuth/lifecycle、Skill installation/immutable version/content/hash/resources 和相关 private local data 的唯一 source of truth。
- 每次 Runtime Box 注册/重连时 server 先 full sync redacted inventory；运行期以 revision hint + 60 秒 ±20% jitter poll 拉取 delta，cache 可丢弃且不构成授权。
- Agent global profile 可引用 Server-owned MCP/Skill；Runtime Profile 只可引用 assigned Runtime Box 的资源。server 合并两类 owner，并从各自 authority 获取 Skill metadata 与 `SKILL.md`。
- server 决定并持久化 Policy/approval，随后签发一次性 execution grant；Runtime Box 验证后才执行。
- Desktop 监管一个 host-backed Local Runtime Box；同一 Agent Server registry 还可管理多个独立 Remote Box。
  Agent/Provider 全局共享，并为每个 Box 建立 Runtime Profile。

## 2. 自定义 Agent

### 2.1 内置 Agent

首版至少提供：

- **General Assistant**：用于普通 Chat，默认无本地目录和终端权限。
- **Project Agent**：用于 Project Chat，支持规划、文件、命令、Git 和子 Agent。

内置 Agent 可复制为自定义 Agent，但不能被用户直接破坏性修改。

### 2.2 创建与编辑

可视化表单包含：

| 分组 | 字段 |
| --- | --- |
| 基本信息 | 名称、图标、颜色、描述、适用场景 |
| Runtime Profile | 针对当前 Runtime Box 选择 Tool、MCP、Skills 和 Box-specific 权限 |
| 指令 | 系统提示词、回答风格、输出约束 |
| 模型 | 继承会话模型或固定模型、参数、最低能力要求 |
| 内置工具 | 网页搜索、URL 读取、文件、终端、Git、Canvas |
| MCP | Server 和具体 Tool 的允许列表 |
| Skills | 全局/项目 Skills 选择、加载顺序 |
| 知识 | 文件或目录知识源、Embedding 配置、检索参数 |
| 权限 | 文件范围、命令、网络、外部副作用和默认审批策略 |
| 子 Agent | 使用默认通用子 Agent；专用子 Agent 编排在后续阶段开放 |

### 2.3 校验

保存前必须检查：

- 名称唯一性和必填字段。
- 所选模型是否支持工具调用、流式和需要的输入类型。
- MCP、Skills、知识源和 Provider 是否可用。
- 当前 Runtime Box 是否已完成 full inventory sync 并 online，live capability 是否覆盖所选 Tool/MCP/Skill。
- 所选 MCP/Skill 是否属于 Runtime Profile 对应的 Box，stable resource version/hash 是否仍匹配。
- 权限是否与工具能力冲突。
- 固定模型不可用时，不得静默切换到其他模型。
- Agent 在普通 Chat 中不能通过配置获得任意宿主机文件或终端权限。

### 2.4 生命周期

- 创建、复制、编辑、启用、停用和删除。
- Session 保存使用时的 Agent 配置快照；之后编辑 Agent 不改变历史 Run。
- 新 Run 默认使用最新已保存版本，并在消息头显示版本。
- 删除仍被 Session 引用的 Agent 时保留只读快照。
- Runtime Box syncing/offline 时保留 Agent 配置和历史 Run，但相关 Agent 不能启动新 Run。

### 2.5 导入导出

- 支持“仅配置”和“连同 Skills/可嵌入资源”的两种导出。
- 导出包包含 `schemaVersion`、Agent 配置和依赖清单。
- API Key、OAuth Token、MCP Secret、本地绝对路径和知识索引不得进入导出包。
- 导入时展示将新增/覆盖的 Agent、Skills 和权限；冲突由用户决定。
- 缺失的本地文件、MCP 或 Provider 显示为待修复依赖，不伪造成功状态。
- 导入包不携带本机 `runtimeBoxId`；导入后由用户或当前 desktop default 重新绑定。
- “连同 Skills”导出由 assigned Runtime Box 按 immutable version/hash 生成，server 不缓存内容；Runtime Box offline 时明确失败。
- 导入先由 selected Runtime Box 原子安装资源，再由 server 保存 Agent refs；任一步失败都不能留下成功形状的 Agent 配置。

### 2.6 Runtime Box 注册与选择

- Desktop client 启动并监管一个 Local Runtime Box；Remote Runtime Box 作为远端用户服务主动连接同一 registry，
  不受 Desktop supervisor 管理。
- `runtimeBoxId` 跨重连/重启稳定；每次启动/连接使用新的 `instanceId` 和 `generation`。
- 每次 connection/registration/reconnect 后状态先为 syncing；server full inventory sync 成功后才显示 online/runnable。
- Agent definition/version 全局共享；`agentId + runtimeBoxId` 形成 Runtime Profile。
- Runtime Profile 的 MCP/Skill 项只保存该 Box 的 stable resource ID 与 version/hash，不复制 config、credential 或 Skill content。
- client 只能通过 agents server 列出 Runtime Box，不直接连接或探测 Runtime Box。
- Remote Runtime Box 通过独立 Runtime ingress、设备配对和 Agent Server-owned Dev Tunnel 接入；iOS
  Mobile Client 通过同一 Tunnel 的独立 Mobile ingress 接入。Docker/cloud packaging、团队共享和多租户仍不属于当前范围。

## 3. LLM Provider

### 3.1 数据模型

Provider domain 分为：

1. **Builtin Provider**：由 public Pi `ModelRuntime` 在运行时枚举；ID、display name 和 API metadata 只读，
   每个 Provider 保存一份 credential。
2. **Custom Provider instance**：拥有稳定 instance ID、display name、base URL、API family 和 secret header
   metadata；同一 family 可创建多个实例。
3. **Model profile**：由运行时刷新得到 model ID、capability、`ThinkingLevel`、上下文和用量 metadata。

Provider registry、auth、连接测试、模型调用、用量和长期 Provider Secret 都位于 agents server。Runtime Box
不代替 server 调用模型，也不会收到 Provider Key。

### 3.2 Provider 范围

- builtin 清单完全来自运行时枚举，不在产品代码或文档固化数量；动态 Provider 可在认证并刷新后出现模型。
- custom endpoint 只允许 `openai-completions`、`openai-responses`、`anthropic-messages` 和
  `google-generative-ai`。
- auth action 来自每个 `ProviderSummary.authMethods`，UI 不按 Provider ID 维护 API Key/OAuth 分组。

### 3.3 Provider 设置页

Provider 列表显示 builtin/custom source、enabled 和 authentication readiness。builtin detail 允许启停、认证、
退出、刷新与模型勾选，但不能改 ID/display name/base URL/API/header 或删除。custom detail 可编辑 endpoint/API/
header name 并删除；secret value 只通过创建或公共 auth panel 输入。

auth panel 支持 API Key/OAuth、text/secret/select/manual code prompt，以及 info/auth URL/device code/progress
notification。`start` 立即返回，UI 单请求有界轮询；离开面板或退出时取消 attempt。Provider URL 作为 opaque
外链打开，不解析 callback。认证/配置不足时测试、刷新和模型控件禁用或返回明确安全错误。

### 3.4 模型能力注册表

每个模型显示并供运行时校验：

- 文本、图片、音频、视频、PDF 等输入能力。
- Tool calling。
- Structured output。
- Streaming。
- Pi `ThinkingLevel`。
- 上下文窗口和最大输出。
- Prompt caching。
- Embedding 能力。
- 已知限制与数据区域。

能力来源可为内置目录、Provider API 或用户覆盖。用户覆盖需要标记，模型调用失败后给出纠正入口。

### 3.5 模型参数

- 当前 Session 只保存 public Pi model 声明支持的 `ThinkingLevel`。
- 新选择在写入时严格验证；Provider/model 被禁用或删除时安全清除默认选择。
- model refresh 后若已保存档位不再被支持，运行时省略该档位，不让 Chat 持久失败。
- temperature、top-p、token limit 和高级参数仍是后续产品范围。

### 3.6 用量、费用和预算

- 按 Run、Session、Project、Agent、模型和 Provider 统计输入、输出、缓存与推理 Token。
- 优先使用 Provider 返回用量；缺失时明确标记为估算。
- 费率目录需记录来源和更新时间；自定义模型允许手工费率。
- 支持日/月预算提醒和达到 50%、80%、100% 时通知。
- 首版预算为软提醒，不自动中断正在执行的 Run；硬上限属于后续能力。
- 子 Agent 和 Embedding 费用计入同一任务成本明细。

### 3.7 错误与回退

- 区分认证、限流、余额、模型不存在、内容限制、超时和网络错误。
- 自动重试只用于明确可重试错误，并使用退避策略。
- 不默认跨 Provider 回退，避免数据和费用意外流向其他服务。
- 后续可由用户显式配置回退链，并在发生时展示事件。

## 4. MCP

### 4.1 支持范围

| 类型 | 配置 |
| --- | --- |
| stdio | command、args、cwd、env、启动超时、重启策略 |
| Streamable HTTP | URL、Header、Bearer/API Key、OAuth、超时 |
| SSE | 用于兼容旧服务，配置同远程连接 |

首个 MCP 版本以 **Tools** 为 P0；MCP Resources 和 Prompts 作为后续兼容能力。

### 4.2 添加与测试

用户可以：

- 手工创建连接。
- 从常见客户端 JSON 配置导入。
- 查看并修复导入冲突、环境变量和不可用命令。
- 启动/停止本地 Server。
- 测试握手并查看 Server 信息、Tool 列表和输入 Schema。
- 启用/停用整个 Server 或单个 Tool。
- 查看经过脱敏的连接日志。

测试连接不得自动调用有副作用 Tool。

client 提供 owner-explicit MCP 配置 UI。Server-owned query/command 由 agents server 本地 authority 处理；Box-owned
query/command 经身份与授权校验后路由到 selected Runtime Box。Agent global profile 保存 Server-owned refs，
Runtime Profile 保存 Box-owned refs；Tool risk override 始终属于 server Policy。

- Runtime Box 只有在原子持久化成功后才返回 redacted result 与新的 inventory epoch/revision；server 随即拉取到该 revision，再向后续 inventory read 展示新状态。
- Runtime Box offline、版本冲突或存储失败时明确失败；server 不排队并伪装成功。
- server 可保存 replaceable、non-authoritative、disposable redacted inventory cache 供 stale 概览，但不能用来恢复或编辑 MCP config。若 mutation 已持久化而 cache 同步暂时失败，UI 显示“已保存，清单同步中”，不能伪造 descriptor。

### 4.3 认证

- stdio credential 由 owner 的 MCP SecretStore 解析；启动 MCP process 时只注入目标 child 的最小环境，不使用远程 OAuth 流程。
- 远程连接支持静态 Header、Bearer/API Key。
- 支持符合 MCP 规范的 OAuth 2.1、PKCE、资源服务器发现和浏览器授权。
- 动态客户端注册不可用时，允许用户填写 Client ID；Client Secret 安全存储。
- Access/Refresh Token 和其他 MCP Secret 只写入显式 owner 的 SecretStore，不进入 Product DB/Pi Session
  JSONL/backup/snapshot、MCP query result、日志或 WebView。
- local desktop 首个 `ExecutorSecretStore` 可使用 private files；future Runtime Box 可改用 Keychain、Docker Secret 或 cloud secret manager。
- owner 可在 connection/process 生命周期内把 credential 加载到内存；不得进入模型/UI/prompt、query RPC、diagnostic/export、进程全局环境或无关 child/Agent。
- revocation、expiry 或 MCP shutdown 会关闭对应连接/进程并释放 runtime reference；JavaScript 不承诺可靠清零 string memory。
- HTTP transport 可在可行时按 request 注入 credential，但这只是优化。
- 撤销连接时同时提供清理本地 Token 的选项。

### 4.4 作用域

MCP Server 先选择 owner：

- Agent Server：连接跨 Runtime Box 保持，stdio 在 Agent Server host 执行。
- Runtime Box：只在 owning Box 生效。

然后可设为：

- 全局可用。
- 仅指定 Project 可用。
- 仅指定 Agent 可用。

最终 Tool 集合取以上范围的交集，并叠加权限策略。Server-owned refs 保存在 Agent global profile，Box-owned
refs 保存在 Runtime Profile，均不复制 owner config。Agent 选择某 Tool 不代表该 Tool 已预授权执行。

### 4.5 运行与错误

- 每次 Tool 调用显示 Server、Tool、参数、状态、耗时和安全截断结果。
- 连接断开、Schema 变化或 Tool 被移除时明确报错并允许重连。
- stdio 进程退出后按配置重启，连续失败进入停用状态，避免无限重启。
- MCP 返回 `isError` 或协议错误时按失败处理，不包装为成功结果。
- MCP 已连接不代表 Tool 已预授权；每次调用仍由 server Policy/approval/intent 和一次性 grant 约束。

### 4.6 Inventory 同步

- 以下 epoch/revision 同步只适用于 Box-owned MCP；Server-owned MCP 直接读取 Agent Server authority。
- Runtime Box 持久化 `inventoryEpoch`、单调递增 `inventoryRevision` 和带 deletion tombstone 的有界 change log；普通 restart 不换 epoch，inventory reset 才换。
- 每次 MCP/Skill/config/Tool-schema/capability change commit 后发送 `inventory.changed`；hint 只含 epoch/revision/category，不含 credential、config、Tool schema body 或 Skill content。
- server 对 hint 去抖并调用 `inventory.getChanges(sinceRevision, cursor)`；另按每次 48–72 秒的随机间隔主动增量 reconciliation。
- revision gap、compacted history、epoch reset 或 invalid cursor 触发 `inventory.getSnapshot()` 和 atomic cache replacement。
- cache 只含 stable resource ID、version/hash、MCP Tool schema、health/capability 和 redacted credential-configured 状态；不含 token、sensitive env、recoverable MCP config、完整 `SKILL.md`/resources。
- Runtime Box offline 时 cache 标为 stale；failed poll 不解释为删除。reconnect full sync 完成前 assigned Agent 不 runnable。
- Run start/restore 始终向 live Runtime Box 验证 referenced owner/version/hash/schema；polling 只做 discovery/reconciliation，不是 authorization。

## 5. Agent Skills

### 5.1 规范兼容

Skills 必须兼容 [Agent Skills Specification](https://agentskills.io/specification)：

```text
skill-name/
├── SKILL.md
├── scripts/       # optional
├── references/    # optional
└── assets/        # optional
```

`SKILL.md` 使用 YAML frontmatter；至少校验 `name` 和 `description`。应用保留并展示 license、compatibility、metadata 和实验性的 allowed-tools 字段。

### 5.2 管理能力

- 从本地文件夹或压缩包安装。
- 安装前预览元数据、脚本、依赖、网络和工具声明。
- 使用规范校验器检查目录名、frontmatter 和文件引用。
- 启用、停用、更新、卸载、导入和导出。
- 展示来源、版本、内容哈希和最近使用时间。
- 后续支持从 Git URL 安装与更新。

Skill 使用与 MCP 一致的显式双归属管理。Agent Server-owned Skill 只允许单个非 executable `SKILL.md`，
由 Product DB metadata 与 server private content store 管理；Runtime Box-owned Skill 继续拥有完整 package、
immutable versions、资源和脚本。安装/启用与 Agent assignment 分离。

### 5.3 渐进加载

- Agent 构建或恢复前，agents server 从 global profile 与 Session Box Runtime Profile 合并 Skill refs，并从各自 owner 获取 metadata 和 `SKILL.md`。
- server 验证 owner、version 与 hash 后构造有效 Agent prompt；offline、missing 或 mismatch 时 fail closed，不使用 snapshot/旧内容。
- fetched content 只用于当次内存 prompt assembly，不写入 Agent/Run snapshot、Pi Session JSONL、event、
  backup、diagnostic 或 export；恢复时重新按 ref 获取。
- 脚本、引用和资源仅在需要时通过 Runtime Box 读取或执行。
- UI 在执行轨迹中显示“激活了哪个 Skill”，但不把全部 Skill 内容塞入消息流。

### 5.4 作用域与冲突

当前作用域为 Agent global Server-owned Skill 与当前 Runtime Box-owned Skill。任何有效 Skill 集出现相同
`metadata.name` 时 Run fail closed，不进行 owner 优先级覆盖。Project 级覆盖层后置。

### 5.5 安全

- Skill 是不可信扩展，安装不等于授权其脚本执行。
- `allowed-tools` 仅作为建议，不能越过应用权限与审批策略。
- 脚本执行展示实际命令、工作目录、环境和风险。
- scripts/resources 只能通过 Runtime Box invocation 使用；脚本仍需 server 签发 execution grant。
- 导出时默认不包含本地密钥、生成缓存和知识索引。

## 6. 知识库

### 6.1 知识源

自定义 Agent 可添加文件或目录作为知识源。首批建议格式：

- 文本：TXT、Markdown、MDX、HTML。
- 文档：PDF、DOCX。
- 数据：CSV、JSON。
- PPTX、XLSX 和 OCR 在后续增强。

知识源与 Project 文件权限相互独立；用户必须显式添加。

### 6.2 索引

- 文档解析、切分、Embedding 和向量索引在本机调度。
- 原始文档、切分结果、向量和元数据默认保存在本机。
- 首版允许选择云端 Embedding Provider。
- 首次索引前明确说明文档片段会发送到哪个 Provider。
- 支持增量更新、暂停、失败重试、重建和删除索引。
- 文件删除或权限失效后，相关向量必须可清理。

### 6.3 检索与引用

- Agent 按任务检索，而非默认注入整库。
- 结果包含知识库、文件、页码/段落和相关度。
- 回答中的知识引用可点击打开原文位置。
- 用户可查看本轮查询和命中片段。
- 无可靠命中时不得伪造知识库来源。

### 6.4 本地 Embedding

阶段 2 支持本地 Embedding 模型，允许用户在不上传文档内容的情况下建立索引，并清晰展示性能与磁盘占用。

## 7. 内置联网工具

### 7.1 Web Search

- 全局、Project 和 Agent 级开关。
- 使用 BYOK 搜索 Provider，首发至少提供一个适配器。
- 返回标题、URL、摘要、时间和来源。
- 搜索查询和返回来源进入执行轨迹。

### 7.2 URL Reader

- 读取 HTTP/HTTPS 页面正文和基础元数据。
- 限制响应体、重定向、超时和内容类型。
- 防止访问本机、私网、云元数据地址和 `file://`。
- 尊重用户代理标识与站点访问限制。
- 页面内容视为不可信提示，不能改变权限策略。

### 7.3 浏览器自动化

不在首版范围；后续必须使用独立浏览器 Profile、逐域授权和敏感动作审批。

## 8. 功能需求索引

| ID | 需求 | 优先级 |
| --- | --- | --- |
| EXT-001 | 自定义 Agent 支持完整可视化配置和校验 | P0 |
| EXT-002 | Agent 配置支持无密钥导入导出 | P0 |
| EXT-003 | Session 保存 Agent 配置快照 | P0 |
| EXT-004 | 首版内置六类云 Provider 与两种兼容 Endpoint | P0 |
| EXT-005 | 模型能力注册表阻止不兼容 Agent 运行 | P0 |
| EXT-006 | Token、费用和预算提醒可追溯到子 Agent | P0 |
| EXT-007 | MCP 支持 stdio、HTTP、SSE 与 OAuth 2.1 | P0 |
| EXT-008 | MCP 可按 Server/Tool/Project/Agent 启停 | P0 |
| EXT-009 | Skills 兼容开放规范且应用权限优先 | P0 |
| EXT-010 | 知识库本地索引并提供可点击引用 | P0 |
| EXT-011 | 云端 Embedding 前必须提示数据目的地 | P0 |
| EXT-012 | Ollama、LM Studio 和本地 Embedding | P0 |
| EXT-013 | MCP Resources/Prompts | P1 |
| EXT-014 | 自定义子 Agent 编排 | P2 |
| EXT-015 | Agent 绑定已注册 Runtime Box；Runtime Box syncing/offline 时不能启动新 Run | P0 |
| EXT-016 | Runtime Box 独占 MCP config/credential/OAuth/lifecycle；client UI 经 server 校验路由，offline/持久化失败不返回成功，Tool 仍逐次走 grant | P0 |
| EXT-017 | Runtime Box 独占 immutable Skill versions/content；Agent 只保存 assigned Runtime Box stable ref，server 按 version/hash 获取 `SKILL.md`，missing/mismatch fail closed | P0 |
| EXT-018 | server 不保存 recoverable Box-owned MCP/Skill config/content/credential；Box inventory cache 明确为 replaceable、non-authoritative、disposable | P0 |
| EXT-019 | Runtime Box inventory 使用 registration full sync、persisted epoch/revision、hint + jittered poll、delta/tombstone 与 snapshot fallback；Run 仍 live 验证 | P0 |
