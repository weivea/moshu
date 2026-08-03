# 核心体验与信息架构

> 本文描述完整产品体验目标。当前已实现范围和明确缺口以
> [实现状态](../implementation/progress.md)为准；Tasks、Plan、自定义 Agent、Diff/撤销等目标页面或流程不能据此
> 视为已经交付。

## 1. 设计目标

核心体验围绕三个问题设计：

1. **我正在和谁对话？** 当前 Agent、模型、Project 和上下文必须明确。
2. **Agent 正在做什么？** 计划、待办、子 Agent、工具、审批和错误必须可观察。
3. **它对我的电脑做了什么？** 文件和命令副作用必须可追溯、可审阅、尽可能可撤销。

## 2. 应用信息架构

### 2.1 一级导航

| 导航 | 目的 |
| --- | --- |
| New Chat | 快速创建普通 Chat |
| Chats | 查看、搜索和管理普通会话 |
| Projects | 添加项目、进入项目和查看项目会话 |
| Tasks | 查看运行中、排队、待审批、失败和已完成任务 |
| Agents | 创建和管理自定义 Agent |
| Canvas | 查看跨会话的 Canvas 成果 |
| Settings | Provider、MCP、Skills、使用量、安全和应用设置 |

### 2.2 React Router 路由基线

| 路由 | 页面 |
| --- | --- |
| `/chat/new` | 新建普通 Chat |
| `/chat/:sessionId` | 普通 Chat |
| `/projects` | Project 列表 |
| `/projects/:projectId` | Project 概览 |
| `/projects/:projectId/chat/new` | 新建 Project Chat |
| `/projects/:projectId/chat/:sessionId` | Project Chat |
| `/tasks` | 全局任务中心 |
| `/agents` | Agent 列表 |
| `/agents/new` | 创建 Agent |
| `/agents/:agentId` | Agent 详情与编辑 |
| `/canvas` | Canvas 列表 |
| `/canvas/:canvasId` | Canvas 独立页面 |
| `/settings/general` | 通用、语言、外观和通知 |
| `/settings/providers` | Provider 与模型 |
| `/settings/mcp` | MCP |
| `/settings/skills` | Skills |
| `/settings/usage` | Token、费用和预算 |
| `/settings/security` | 权限、数据和隐私 |

Canvas、Diff 和文件预览也可作为 Chat 的右侧面板打开；URL 仍需反映当前选中对象，以支持刷新恢复和深链。

### 2.3 桌面布局

- **左栏**：一级导航、Project/会话列表、搜索和运行状态。
- **中栏**：消息流、执行轨迹与输入框。
- **右栏**：按需显示文件、Diff、审批详情、引用、任务详情或 Canvas。
- 窄窗口下右栏切换为覆盖面板；左栏可收起。
- macOS 遵循安全区、窗口拖拽区、原生全屏和键盘操作习惯。

## 3. 普通 Chat

### 3.1 定义

普通 Chat 不绑定本地目录，用于问答、附件分析、联网研究、MCP 工具和 Canvas 创作。

### 3.2 能力边界

- 可选择模型和 Agent。
- 可附加本地文件；附件以只读副本进入会话工作区，不因此授权原目录。
- 可使用已启用且被当前 Agent 允许的内置联网工具与 MCP。
- 可创建和编辑 Canvas。
- 不提供任意本地文件浏览或宿主机终端。
- 如任务需要本地目录，提示“创建/选择 Project”，不在后台自动扩大权限。

## 4. Project Chat

### 4.1 定义

Project Chat 属于一个 Project。Project 指向一个本地文件夹，可以是 Git 仓库，也可以是文档、研究或内容目录。

### 4.2 添加 Project

用户选择本地目录后：

1. 显示规范化路径、目录名称、Git 状态和可访问性。
2. 说明 Agent 将获得的默认文件范围。
3. 检测 `.gitignore`、常见敏感文件和超大目录。
4. 用户确认后创建 Project 记录，不复制整个目录。
5. 可设置默认 Agent、模型、项目说明、排除规则和环境变量。

### 4.3 Project 上下文

- 默认读取 Project 根目录内文件。
- 文件搜索默认尊重 `.gitignore` 和应用排除列表；用户可显式包含。
- Agent 仅按需读取内容，不在每轮将整个目录塞入模型上下文。
- 显示本轮已使用的文件、知识引用和工具。
- 项目目录移动或不可用时进入“路径失效”状态，不静默创建新目录。
- 同一个 Project 可包含多个独立 Session。

### 4.4 非 Git 项目

非 Git 目录也必须提供变更追踪：

- Agent 修改前记录文件哈希和必要的原始内容/反向 Patch。
- “本次 Run 的变更”与用户已有文件区分。
- 支持按文件撤销本次 Agent 变更。
- 若文件已被外部程序再次修改，禁止直接覆盖式撤销，改为展示冲突和 Diff。

## 5. Ask、Plan、Agent 模式

| 能力 | Ask | Plan | Agent |
| --- | --- | --- | --- |
| 回答与生成内容 | 是 | 是 | 是 |
| 读取附件/项目文件 | 是，按授权 | 是，按授权 | 是，按授权 |
| 搜索网页/读取 URL | 可选 | 可选 | 可选 |
| 生成计划和待办 | 可选 | 必须 | 按任务需要 |
| 修改项目文件 | 否 | 计划批准前否 | 是，受审批策略控制 |
| 执行命令 | 否 | 计划批准前否 | 是，受审批策略控制 |
| 调用有副作用 MCP | 否 | 计划批准前否 | 是，受审批策略控制 |
| 子 Agent | 只读分析型 | 可用于调研计划 | 可用于执行 |

### 5.1 Ask

- 面向解释、问答和只读分析。
- 即使打开 Allow all，也不能产生文件、命令或外部副作用。
- 如用户明确要求执行，提示切换 Agent 模式。

### 5.2 Plan

- Agent 可读取上下文、提问和调研，但先输出可编辑计划。
- 计划至少包含目标、步骤、预期文件/工具、风险和验证方法。
- 用户可“批准并执行”“修改后执行”“拒绝”。
- 批准后当前 Run 转为 Agent 执行；批准计划不等于批准所有高风险工具。

### 5.3 Agent

- 直接进入执行循环，可规划、更新待办、调用工具和委派子 Agent。
- 文件、命令和 MCP 操作由工具层执行权限判断。
- 用户可停止 Run；停止后显示已完成动作和未完成待办。

## 6. 输入框

输入框固定提供：

- Agent 选择器。
- Provider/模型选择器。
- Ask/Plan/Agent 模式切换。
- 当前上下文入口：附件、Project 文件、知识引用。
- Tools/MCP 状态入口。
- `Allow all` 开关，仅在 Agent 模式显示。
- 发送/停止按钮。

交互要求：

- 切换模型时保留草稿，并提示不兼容能力。
- 打开 Allow all 前展示风险确认；状态在输入框持续高亮。
- `Enter` 发送、`Shift+Enter` 换行，快捷键可配置。
- Run 进行中仍可输入后续消息：默认排入同一 Session，或明确选择“中断并发送”。

## 7. 消息与执行轨迹

### 7.1 消息内容

- GitHub Flavored Markdown。
- 代码块语法高亮、复制和保存。
- 表格、任务列表、图片和文件卡片。
- 网页、知识库和项目文件引用。
- 模型、Token、估算费用和耗时摘要。

### 7.2 执行事件

每个 Run 按时间展示可折叠事件：

- 计划和待办更新。
- 主 Agent/子 Agent 状态。
- 文件读取、搜索和修改。
- 命令与输出。
- MCP 工具调用。
- 审批请求与用户决定。
- 上下文压缩事件。
- 重试、错误、中断与恢复。
- 最终回答和产物。

默认展示可理解的摘要，展开后展示参数、结构化结果和截断日志。不得展示或声称展示模型隐藏思维链。

### 7.3 事件状态

统一状态为：

`queued` → `running` → `waiting_approval` / `waiting_user` → `completed` / `failed` / `cancelled` / `interrupted`

每个状态变化必须持久化，并能定位到 Session、Run、Agent 和工具调用。

## 8. 审批体验

审批卡必须包含：

- 动作类型和来源 Agent。
- 将访问或改变的目标。
- 完整或安全截断后的参数。
- 风险等级和触发原因。
- 可预览内容，如文件 Diff 或命令。
- 允许一次、编辑后允许、拒绝及反馈。

多个同时到达的动作可以批量展示，但每项保留独立决定。审批详情见[安全与数据](./security-data.md)。

## 9. 会话管理

### 9.1 基础能力

- 首条有效消息后自动生成标题，可手动修改。
- 自动保存草稿、消息、执行事件、审批、产物和用量。
- 按标题、消息、Project、Agent 和时间搜索。
- 支持重命名、归档、取消归档和删除。
- 导出 Markdown（适合阅读）和 JSON（保留结构化事件）。
- 导出默认移除密钥、Token 和敏感环境变量。

### 9.2 中断与恢复

- 关闭页面或窗口不自动停止 Run；只要 desktop client 仍运行，任务可在 agents server/Runtime Box 中继续。
- 用户退出应用时，client 先停止接受新 Run，再协作式要求 agents server flush 产品状态并 dispose Pi Session、
  Runtime Box 取消/清理 invocation 和进程树；不留下孤儿 companion。
- 再次打开后，Session 显示“可继续”“需确认状态”或“不可恢复”。
- 恢复前展示已完成动作、待审批动作和下一步。
- 对执行结果不确定的副作用操作，不得自动重放；要求用户确认或重新检查外部状态。
- Provider 临时失败支持从安全点重试，不重复已确认成功的工具调用。

### 9.3 删除

- 删除先进入本地回收状态；默认保留期在阶段 1 设计冻结前确定，用户可立即永久删除。
- 删除 Session 不删除 Project 文件和已显式导出的 Canvas。
- 如 Session 仍有运行中任务，需先停止或取消删除。

## 10. 并行会话与任务中心

### 10.1 并发规则

- 默认最多同时运行 3 个 Session。
- 设置页允许调整为 1–5。
- 达到上限的新 Run 进入 FIFO 队列；用户可调整优先级或取消。
- 同一 Session 同一时刻只允许一个产生副作用的 Run，避免文件竞态。
- 同一 Project 的多个 Run 可并行，但检测到操作同一文件时必须串行或提示冲突。
- Agent/Runtime Profile 设计允许多个 Agent 使用同一 Box；当前代码只有 `moshu.default` Agent。Box offline 时，
  归属该 Box 的 Session 不能启动新 Run。

### 10.2 后台任务

- 切换页面或关闭窗口不自动停止任务。
- macOS 应用仍运行时，任务在后台继续。
- 完成、失败、等待审批或等待用户输入时发送桌面通知。
- 通知内容默认不包含敏感提示词、文件内容或模型输出。

### 10.3 任务中心

展示：

- 运行中、排队、待审批、失败和已完成任务。
- Session、Project、Agent、Runtime Box、模型、开始时间、耗时和费用。
- 暂停/停止、恢复、打开会话和查看错误。
- Runtime Box syncing/online/offline、inventory fresh/stale、重连状态和“当前无法启动新 Run”的原因。

## 11. Pi 运行时映射

| 当前 public Pi 能力 | 产品表现 |
| --- | --- |
| `ModelRuntime` | 动态 builtin/custom Provider、模型、auth method 与 `ThinkingLevel` |
| `createAgentSession` | headless Agent Session；Pi built-in Tool/resource/TUI 禁用，Moshu 七工具与 live MCP Tool 显式装配 |
| `SessionManager` | app-owned JSONL conversation context、restore 和 explicit disposal |
| Agent event stream | 规范化文本 delta、final usage、取消和安全错误 |

Tool、MCP、Skills 和审批不直接采用 SDK 产品合同，而是通过 Moshu-owned Agent/Policy/Action/Runtime Box
contract 实现。Plan、待办、subagent、任务中心和完整 Diff/撤销仍未实现，当前 UI 不应暗示这些能力已经开放。

## 12. 文件变更与 Git

### 12.1 Git 首版能力

- 自动检测仓库与当前分支，只读展示。
- 展示工作区状态、Agent Run 前已有变更和本 Run 新增变更。
- 统一 Diff Viewer，支持文件级和行级查看。
- 支持撤销单个文件或单个变更块，但必须先预览并确认。
- 不自动提交、不自动切分支、不自动 push。

### 12.2 变更归属

- Run 开始时记录基线。
- 每次写操作关联工具调用、Run、时间和前后哈希。
- 用户在外部编辑器产生的变化标记为“外部变更”，不得冒充 Agent 变更。
- 多个 Agent 并发修改同一文件时，后写方必须基于最新版本重新生成 Patch。

## 13. 功能需求索引

| ID | 需求 | 优先级 |
| --- | --- | --- |
| CORE-001 | 普通 Chat 不获得任意本地目录和终端权限 | P0 |
| CORE-002 | Project 下支持多个独立 Session | P0 |
| CORE-003 | Ask/Plan/Agent 的副作用边界由运行时强制执行 | P0 |
| CORE-004 | 执行轨迹流式展示且刷新后可恢复 | P0 |
| CORE-005 | 会话支持保存、搜索、归档、删除和导出 | P0 |
| CORE-006 | Run 可停止、失败后创建新 Run 重试，并读取已持久化 Session context | P0 |
| CORE-007 | 最多 1–5 个并发 Session，默认 3，超出排队 | P0 |
| CORE-008 | 完成和待审批支持桌面通知 | P0 |
| CORE-009 | Git/非 Git 项目都能追踪并撤销 Agent 变更 | P0 |
| CORE-010 | 不展示隐藏思维链，只展示可验证执行事实 | P0 |
| CORE-011 | Phase 1 支持同步子 Agent 可视状态；本地异步子 Agent 在 Phase 2 验证 | P0 |
| CORE-012 | 支持会话内消息分支与对比 | P2 |
