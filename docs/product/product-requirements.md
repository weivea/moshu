# 产品总需求

## 1. 背景与机会

现有通用聊天产品擅长回答问题，但难以稳定完成需要本地文件、终端、长任务、多工具和人工确认的工作；编码 Agent 又往往过度聚焦代码，对文档、研究和内容项目支持不足。

本产品希望填补两者之间的空白：

- 保留聊天产品的低门槛和多模型自由度。
- 提供桌面 Agent 对本地项目的实际执行能力。
- 让用户清楚知道 Agent 正在做什么、为什么被阻塞、会修改什么。
- 用权限、审批、Diff、版本和恢复机制建立信任。
- 用自定义 Agent、MCP、Skills、知识库和 Canvas 支持更广泛任务。

## 2. 目标用户

### 2.1 核心用户：泛技术型 AI 高阶用户

典型特征：

- 会使用 ChatGPT、Claude、Cursor、Codex 等 AI 工具。
- 可能是开发者、产品经理、设计技术人员、数据分析师、研究者或独立创作者。
- 日常任务同时包含代码、Markdown、网页、图表、资料研究和文件处理。
- 愿意自行配置 API Key，重视模型选择、成本和隐私。
- 希望 Agent 能真正执行，但不愿失去对本机的控制。

### 2.2 次级用户

- 需要可复用内部流程的技术团队成员。
- 希望基于 MCP 和 Skills 扩展个人工作台的工具爱好者。
- 希望在本地知识资料上使用 AI 的专业用户。

## 3. 用户任务（Jobs to be Done）

| 场景 | 用户任务 |
| --- | --- |
| 快速问答 | 不创建项目，使用任意模型进行问答、分析附件或生成 Canvas |
| 项目执行 | 将本地代码库或资料目录交给 Agent，完成可检查、可撤销的任务 |
| 复杂任务 | 让 Agent 先规划，再拆分待办并委派子 Agent 并行处理 |
| 可控自动化 | 对文件、命令和外部工具逐项审批，或临时放宽当前会话权限 |
| 专用助手 | 将模型、提示词、工具、知识和权限组合成可复用 Agent |
| 工具连接 | 通过 MCP 使用本地脚本、数据库、SaaS 或远程服务 |
| 流程复用 | 安装符合开放规范的 Skills，让多个 Agent 复用方法和脚本 |
| 成果共创 | 与 Agent 在 Canvas 中共同编辑文档、代码、网页或图表 |
| 成本控制 | 在多个 Provider 间切换，理解能力差异并掌握 Token 和费用 |

## 4. 价值主张

1. **本地优先**：无需账号即可使用，项目与会话默认留在本机。
2. **模型自由**：统一接入国内外 Provider 和兼容协议端点。
3. **行动透明**：计划、待办、子 Agent、工具调用、审批和变更均可见。
4. **安全可控**：最小权限、会话级 Allow all、高风险强制确认、Diff 与撤销。
5. **可恢复**：长任务可后台运行，可暂停、停止，并在异常后继续。
6. **可扩展**：自定义 Agent、MCP、Agent Skills、知识库和 Canvas 形成统一能力系统。

## 5. 产品目标

### G1：建立可信的本地 Agent 执行闭环

用户能在一个 Project Chat 内完成“描述任务 → 规划 → 执行 → 审批 → 查看结果 → 审阅/撤销变更”。

### G2：降低多 Provider 使用门槛

用户无需理解各 SDK 差异，即可完成连接、模型选择、能力判断、参数配置和费用查看。

### G3：支持跨任务类型的统一体验

代码、文档、研究、网页和图表任务共享同一套会话、执行轨迹、权限与成果管理模型。

### G4：形成开放的本地扩展生态

Agent、MCP 和 Skills 可组合、可移植、可按范围启停，且扩展权限受应用策略控制。

### G5：支持长任务和并行工作

多个会话可以后台执行、排队、恢复，并在完成或需要人工操作时通知用户。

## 6. 非目标

以下内容不属于首个正式版本目标：

- 训练或托管自有基础模型。
- 向用户转售模型额度。
- 云端存储全部聊天内容。
- 多人实时编辑、组织管理和企业审计后台。
- 替代 VS Code、JetBrains 或专业 Git 客户端。
- 默认允许 Agent 无边界访问整个操作系统。
- 展示模型隐藏思维链；仅展示可验证的计划、动作、输入输出和简要说明。

## 7. 产品原则

### 7.1 默认安全，按需放权

默认只给任务所需权限；方便用户一次放行，但不让便利开关绕过系统级红线。

### 7.2 展示事实，不伪装确定性

明确区分模型输出、工具执行结果、费用估算、未验证结论和错误状态。

### 7.3 能恢复比“看起来自主”更重要

任务状态必须持久化。应用崩溃、Provider 超时或工具失败后，应知道已完成和未完成的动作，避免重复副作用。

### 7.4 协议优先，避免生态锁定

当前模型层采用 public Pi API；custom endpoint 限四种公开 API family。未来 Tool/MCP/Agent Skills 使用
Moshu-owned、可版本化合同，SDK 类型不进入产品 RPC。

### 7.5 渐进披露复杂度

首次使用只需要 Provider 和聊天；高级模型参数、权限规则、MCP Schema 和执行日志按需展开。

### 7.6 WebView 不可信

网页内容、模型输出和 Canvas 均视为不可信输入；密钥、本机文件与命令能力不进入 WebView。

### 7.7 决策与执行分离

agents server 拥有 Agent、Run、Policy、审批和持久状态；Runtime Box 内部 Executor 只执行经过一次性授权的
设备动作。角色拆分不等于完整沙箱，但任何 Local/Remote Box 或扩展都不得绕过这条边界。

## 8. 功能域总览

| 功能域 | 核心能力 | 详细文档 |
| --- | --- | --- |
| Chat | 普通 Chat、附件、流式回复、引用、导出 | [核心体验](./core-experience.md) |
| Project | 本地目录、项目上下文、文件操作、终端、Git Diff | [核心体验](./core-experience.md) |
| Agent Runtime | Ask/Plan/Agent、待办、子 Agent、审批、Runtime Box 调度与恢复 | [核心体验](./core-experience.md) |
| Runtime Box | Local/Remote 执行域、Project、MCP、Skills 与设备连接 | [架构与实现](../implementation/runtime-box.md) |
| Custom Agent | 可视化配置、导入导出、范围与权限 | [Agent 与扩展](./agents-integrations.md) |
| Provider | 国内外模型、兼容 Endpoint、能力与成本 | [Agent 与扩展](./agents-integrations.md) |
| MCP | 本地/远程连接、OAuth、工具管理和配置导入 | [Agent 与扩展](./agents-integrations.md) |
| Skills | Agent Skills 安装、验证、作用域与执行 | [Agent 与扩展](./agents-integrations.md) |
| Knowledge | 本地索引、Embedding、检索和引用 | [Agent 与扩展](./agents-integrations.md) |
| Canvas | 文档、代码、网页/图表编辑与预览 | [Canvas](./canvas.md) |
| Security | 文件、命令、扩展、密钥和隐私 | [安全与数据](./security-data.md) |

## 9. 核心概念

| 概念 | 定义 |
| --- | --- |
| Runtime Box | 可安装在本机或远程设备的执行与扩展资源域；拥有该设备上的 MCP、Skills 和实际 host execution |
| Project | 指向某个 Runtime Box 上文件夹的应用实体；该目录可以是 Git 仓库 |
| Session | 一条可持久化的会话线程，永久归属一个 Runtime Box，并可属于某个 Project |
| Run | 用户消息触发的一次 Agent 执行，可包含多个模型和工具步骤 |
| Agent | 全局提示词、模型策略、知识和权限配置；每个 Agent/Runtime Box 的 Runtime Profile 保存稳定资源引用 |
| Executor | Runtime Box 内部的 Tool 与进程执行组件，不是产品级切换单位 |
| Tool | Agent 可调用的原子能力，来源可以是内置工具或 MCP |
| Skill | 符合 Agent Skills 规范的可复用说明、脚本和资源目录 |
| Knowledge Base | 经本地切分和索引、按需检索进入上下文的资料集合 |
| Canvas | 独立于消息流、可由用户和 Agent 共同编辑的版本化成果 |
| Approval | 用户对尚未发生的副作用操作做出的允许、修改或拒绝决定 |
| Pi Session | public `SessionManager` JSONL 保存 conversation context；产品 Run 状态和 event 另存于产品 DB |

## 10. 成功指标

所有遥测默认关闭；指标先在本地聚合，只有用户明确同意后才上传匿名事件。

| 指标 | 定义 | 首发目标 |
| --- | --- | --- |
| Provider 配置成功率 | 使用有效凭证的连接测试成功比例 | ≥ 95% |
| 首次价值达成率 | 新用户首次启动后完成一次有效模型回复 | ≥ 70% |
| Project 闭环成功率 | 创建项目后完成一次包含文件读取或修改的 Run | ≥ 60% |
| 可恢复率 | 模拟退出后可读取已持久化 Session/context，并安全终结 orphan Run 的测试比例 | 100% |
| 变更可追溯率 | Agent 文件修改可关联到 Run、工具调用与 Diff | 100% |
| 审批可解释率 | 审批卡包含动作、目标、风险和参数 | 100% |
| 密钥泄露 | 日志、导出、WebView 状态中出现明文密钥 | 0 |
| 崩溃率 | 无崩溃会话占比 | ≥ 99.5% |

## 11. 关键假设

- 用户自行承担模型与搜索服务费用。
- 首发用户能够理解 API Key 和本地目录授权。
- 模型必须支持可靠的工具调用，才能启用 Agent 模式。
- 项目目录可能包含不可信提示、脚本和依赖，不能因为“本地”而默认可信。
- 团队规模和发布日期尚未确定，因此路线图使用能力门槛，不给出日历承诺。

## 12. 外部依赖与风险

| 风险 | 影响 | 产品应对 |
| --- | --- | --- |
| Provider API 差异 | 工具调用、流式和用量字段不一致 | 建立能力注册表、适配层和兼容性测试 |
| 模型不遵守工具约束 | 越权或重复动作 | 权限在工具层执行，不依赖提示词自律 |
| Pi API 变化 | Provider、Agent Session 或事件能力变化 | 精确锁定 `0.82.1`、只用公开导出并维护 binary compatibility gate |
| 三角色连接或 companion 崩溃 | Runtime Box 离线、Run 中断或旧实例结果污染 | stable identity、instance/generation、capped restart、reconcile 和恢复 UX |
| 本机命令无天然沙箱 | 可能访问项目外资源 | 命令策略、环境隔离、审批和高风险硬限制 |
| MCP/Skill 供应链 | 第三方扩展可带来副作用 | 安装审查、能力清单、作用域和运行审批 |
| Canvas 运行不可信代码 | XSS、本地访问或资源滥用 | sandbox BrowserView、独立 origin、CSP；默认断网 POC 失败时禁用任意脚本 |
| 成本数据不完整 | 费用估算可能错误 | 显示来源与估算标识，允许手工费率 |
