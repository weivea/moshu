# Agent 与扩展生态

## 1. 能力模型

一个可运行 Agent 由以下配置组合而成：

```text
Agent
├── Identity：名称、图标、描述
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
- 权限是否与工具能力冲突。
- 固定模型不可用时，不得静默切换到其他模型。
- Agent 在普通 Chat 中不能通过配置获得任意宿主机文件或终端权限。

### 2.4 生命周期

- 创建、复制、编辑、启用、停用和删除。
- Session 保存使用时的 Agent 配置快照；之后编辑 Agent 不改变历史 Run。
- 新 Run 默认使用最新已保存版本，并在消息头显示版本。
- 删除仍被 Session 引用的 Agent 时保留只读快照。

### 2.5 导入导出

- 支持“仅配置”和“连同 Skills/可嵌入资源”的两种导出。
- 导出包包含 `schemaVersion`、Agent 配置和依赖清单。
- API Key、OAuth Token、MCP Secret、本地绝对路径和知识索引不得进入导出包。
- 导入时展示将新增/覆盖的 Agent、Skills 和权限；冲突由用户决定。
- 缺失的本地文件、MCP 或 Provider 显示为待修复依赖，不伪造成功状态。

## 3. LLM Provider

### 3.1 数据模型

Provider 配置分为三层：

1. **Provider preset**：协议、默认 Endpoint、认证方式和能力规则。
2. **Connection profile**：用户的一组凭证、Endpoint、代理和自定义 Header。
3. **Model profile**：模型 ID、能力、上下文、参数、费率和连接选择。

同一 Provider 允许创建多个 Connection profile，例如个人与公司账号。

### 3.2 首版 Provider 矩阵

| 用户可见 Provider | 接入策略 | 首版 |
| --- | --- | --- |
| OpenAI | LangChain OpenAI Provider | 是 |
| Anthropic | LangChain Anthropic Provider | 是 |
| Google Gemini | LangChain Google GenAI Provider | 是 |
| DeepSeek | LangChain DeepSeek Provider | 是 |
| Kimi / Moonshot | OpenAI-compatible 品牌预设 | 是 |
| 智谱 / Z.ai | OpenAI-compatible 品牌预设 | 是 |
| Custom OpenAI-compatible | 自定义 Base URL、Key、Header | 是 |
| Custom Claude-compatible | 自定义 Anthropic API URL、Key、Header | 是 |
| Ollama | LangChain Ollama Provider | 阶段 2 |
| LM Studio | OpenAI-compatible 本地 Endpoint | 阶段 2 |
| OpenRouter、xAI、Groq、Mistral、AWS、Azure 等 | 按 LangChain Provider 扩展 | 阶段 3 候选 |

Kimi 和智谱必须作为独立品牌入口提供默认值和帮助文案，而不是要求用户理解“兼容协议”后手工填写全部字段。

### 3.3 Provider 设置页

每个连接支持：

- 名称、Provider 类型、API Key/Token。
- Base URL 和必要版本字段。
- 自定义 Header；敏感值使用密钥存储。
- 代理、超时、重试上限等高级项。
- “测试连接”：验证认证、流式回复和最小工具调用能力。
- 获取模型列表；无法自动获取时可手工添加模型 ID。
- 连接状态、最近成功时间和可操作错误信息。

测试不得产生不可预期高额费用；界面需说明将发起最小模型请求。

### 3.4 模型能力注册表

每个模型显示并供运行时校验：

- 文本、图片、音频、视频、PDF 等输入能力。
- Tool calling。
- Structured output。
- Streaming。
- Reasoning/思考参数。
- 上下文窗口和最大输出。
- Prompt caching。
- Embedding 能力。
- 已知限制与数据区域。

能力来源可为内置目录、Provider API 或用户覆盖。用户覆盖需要标记，模型调用失败后给出纠正入口。

### 3.5 模型参数

- 通用参数：temperature、top-p、max output tokens、stop。
- Provider 专属参数：reasoning effort、thinking budget、缓存等。
- UI 仅展示当前模型支持的参数。
- Agent 可定义推荐值；Session 可临时覆盖。
- 原始高级参数以结构化 JSON 编辑时必须进行 Schema 校验。

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

### 4.3 认证

- stdio 凭证通过受控环境变量注入，不使用远程 OAuth 流程。
- 远程连接支持静态 Header、Bearer/API Key。
- 支持符合 MCP 规范的 OAuth 2.1、PKCE、资源服务器发现和浏览器授权。
- 动态客户端注册不可用时，允许用户填写 Client ID；Client Secret 安全存储。
- Access/Refresh Token 写入系统安全存储，不进入 MCP JSON、日志或 WebView。
- 撤销连接时同时提供清理本地 Token 的选项。

### 4.4 作用域

MCP Server 可设为：

- 全局可用。
- 仅指定 Project 可用。
- 仅指定 Agent 可用。

最终 Tool 集合取以上范围的交集，并叠加权限策略。Agent 选择某 Tool 不代表该 Tool 已预授权执行。

### 4.5 运行与错误

- 每次 Tool 调用显示 Server、Tool、参数、状态、耗时和安全截断结果。
- 连接断开、Schema 变化或 Tool 被移除时明确报错并允许重连。
- stdio 进程退出后按配置重启，连续失败进入停用状态，避免无限重启。
- MCP 返回 `isError` 或协议错误时按失败处理，不包装为成功结果。

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

### 5.3 渐进加载

- Agent 启动时只加载 Skill 名称和描述。
- 任务匹配时读取 `SKILL.md`。
- 脚本、引用和资源仅在需要时读取或执行。
- UI 在执行轨迹中显示“激活了哪个 Skill”，但不把全部 Skill 内容塞入消息流。

### 5.4 作用域与冲突

作用域从低到高为：

`全局 → Project → Agent`

同名 Skill 由更具体作用域覆盖；同作用域冲突要求用户处理。有效来源顺序在 Agent 详情中可见。

### 5.5 安全

- Skill 是不可信扩展，安装不等于授权其脚本执行。
- `allowed-tools` 仅作为建议，不能越过应用权限与审批策略。
- 脚本执行展示实际命令、工作目录、环境和风险。
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
