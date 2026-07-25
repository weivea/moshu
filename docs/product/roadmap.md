# 阶段路线图与验收

## 1. 路线图原则

- 每个阶段以可验证能力门槛结束，不以页面数量或日历时间结束。
- P0/P1/P2 是需求在其所属阶段内的优先级，不代表产品阶段编号。
- 阶段 1 优先完成用户确认的首个可用闭环。
- 自定义 Agent、MCP、Skills、知识库和 Canvas 可并行开发，但必须复用同一套权限、事件和持久化模型。
- 团队规模、目标日期和发布渠道未确定，本路线图不提供工期承诺。

## 2. 阶段 0：技术底座与高风险验证

**目标：** 在前 2–3 周完成 Electrobun application runtime Go/No-Go，并证明桌面架构能够安全、稳定地承载 Deep Agents 长任务。

### 范围

- Electrobun `1.18.1` + React + React Router + Vite 应用骨架；开发期使用 Bun，发行包使用框架内置 runtime。
- HeroUI 主题、浅色/深色、中英文框架和 Gravity Icon 包装层。
- Application Host/WebView/in-process DeepAgentService 的边界；Electrobun typed RPC 与稳定 service contract。
- `bun:sqlite` 业务数据库、事件模型、`BunSqliteSaver` 和 store 原型。
- Deep Agents 在 Electrobun application worker 内的 import/bundle、真实 Provider 流式、待办、同步子 Agent、审批、取消、`AsyncLocalStorage`、并发和恢复 POC。
- 一个 OpenAI 或 Anthropic Provider 端到端 POC。
- Project 文件读取、受控 Patch 写入和命令策略 POC。
- macOS Keychain FFI/native adapter POC，不允许明文回退。
- sandbox `BrowserView` 的 RPC、本地文件和子资源默认断网 POC。
- macOS 自解压/安装、签名、公证、Updater 和 packaged E2E 流水线 POC。

### 出口条件

- Provider/graph/Tool 错误不影响其他 Run；application 强退后重启可从检查点恢复且命令进程树被清理。
- WebView 无法直接读取 API Key、application runtime 或任意文件。
- 未经策略层的命令无法执行。
- 一个带文件修改与审批的 Run 可完整持久化和回放。
- in-process Deep Agents 的 stream/HITL/subagent/取消/上下文传播和 3 Run 并发 contract 全部通过。
- `BunSqliteSaver` 通过行为、WAL、崩溃恢复和旧 fixture 测试。
- Web Canvas 无法访问 Electrobun RPC、Bun/Node、任意本地文件或默认网络。
- 外部 E2E harness 可验证签名 package 中的 Deep Agents/Provider、packaged runtime、Keychain 和 BrowserView；stable 产物不包含 test driver。

## 3. 阶段 1：核心 MVP

**目标：** 交付“配置模型 → Chat/Project → Ask/Plan/Agent → 审批执行 → Diff/撤销 → 后台与恢复”的完整闭环。

### 3.1 基础与设置

- macOS 安装包；无需登录。
- 中英双语、跟随系统、浅色/深色。
- OpenAI、Anthropic、Gemini、DeepSeek、Kimi、智谱。
- Custom OpenAI-compatible 与 Custom Claude-compatible。
- Provider 连接测试、模型列表/手工 ID、基础能力标签。
- Token 和估算费用；日/月预算提醒。

### 3.2 Chat

- 普通 Chat 与附件。
- Project 添加、Project Chat 和多个 Session。
- Ask、Plan、Agent。
- 流式 Markdown、代码、引用和用量。
- 计划、待办、文件、命令、Tool、子 Agent 和错误事件。
- 停止、重试、安全检查点恢复。
- 自动标题、搜索、重命名、归档、删除、Markdown/JSON 导出。

### 3.3 执行与安全

- Project 内文件读取、Patch 写入、创建、移动和删除。
- 受控命令执行、风险分类和审批。
- Session 级 Allow all；高风险仍确认。
- Git status、Diff、文件/变更块撤销。
- 非 Git 项目变更日志和撤销。
- 内置 URL Reader 与至少一个 BYOK Web Search 适配器。

### 3.4 后台任务

- 默认 3、可配置 1–5 个并发 Session。
- 队列、停止、恢复和任务中心。
- 完成、失败、待审批和待用户输入的桌面通知。

### 阶段 1 不包含

- 自定义 Agent 完整编辑器。
- MCP/Skills 管理页。
- 知识库。
- 正式 Canvas 功能。
- 本地模型。
- Git 分支、提交、Worktree 或 PR。

### 出口条件

通过第 7 节中的 E2E-01 至 E2E-07，且满足第 8 节 P0 质量门槛。

## 4. 阶段 2：开放能力与 Canvas

**目标：** 从“可用桌面 Agent”升级为可定制、可扩展、可产出多类型成果的平台。

阶段 2 可拆为两个并行工作流，但公开 Beta 前两者都需达到可用状态。

### 4.1 工作流 A：Agent 与扩展

- 自定义 Agent 可视化配置、版本快照、复制、停用和导入导出。
- MCP stdio、Streamable HTTP、SSE。
- MCP Bearer/API Key、OAuth 2.1、连接测试和配置导入。
- MCP Server/Tool 的全局、Project 和 Agent 作用域。
- Agent Skills 本地安装、验证、启停、冲突处理、导入导出。
- 文件/目录知识库、本地索引、云端 Embedding 和来源引用。
- Ollama Provider 与 LM Studio 兼容 Endpoint。
- 本地 Embedding。
- 更完整的模型能力目录和成本明细。
- 本地异步子 Agent POC：在 Agent Protocol Server 与 Local Task Broker 中择一。

### 4.2 工作流 B：Canvas

- Markdown、Code、Web、Diagram 四类 Canvas。
- 用户/Agent 双向编辑、revision 冲突控制。
- 实时预览、错误、自动草稿。
- 命名版本、Diff、恢复。
- Markdown/HTML/PDF、源码/ZIP、SVG/PNG 导出。
- Project 文件关联。
- Web Canvas 独立 origin、CSP、网络和资源限制。

### 出口条件

- 通过 E2E-08 至 E2E-12。
- 第三方 MCP 或 Skill 无法越过应用权限。
- Canvas 恶意测试页面无法访问本地特权。
- 使用本地 Embedding 时，索引流程不向外发送文档内容。

## 5. 阶段 3：生产力增强

**目标：** 提升复杂项目、自动化和生态使用效率。

候选范围：

- Git 分支、提交、Worktree 和可选 PR 流程。
- 自定义专用子 Agent 与可视化编排。
- 显式配置的模型回退链和失败迁移。
- MCP Resources 与 Prompts。
- Agent/Project 长期记忆，默认关闭并支持查看、编辑、清除。
- Browser automation，使用独立 Profile、逐域授权和敏感动作审批。
- Canvas 受控 npm 依赖、更丰富图表和插件式类型。
- Skill Git URL 安装、更新与差异审查。
- 硬预算上限、成本策略和任务级模型路由。
- 定时任务的受限预览版；不得默认无人值守运行高风险动作。

## 6. 阶段 4：跨平台与生态

**目标：** 扩展平台覆盖和可选服务能力。

- Windows 11 正式支持；补齐 DPAPI、安装/更新、深链/文件关联替代方案和桌面 E2E。
- Ubuntu 22.04+ 正式支持；补齐 Secret Service/libsecret、桌面集成、安装/更新和桌面 E2E。
- Agent/MCP/Skill 发现与市场；签名、信誉和权限审核。
- 可选账号与端到端加密同步。
- 可选团队协作和分享。
- 企业代理、自签名证书、私有化和策略分发。
- 付费增值服务，但本地 BYOK 核心能力继续可用。

## 7. 端到端验收场景

### E2E-01：首次模型配置

1. 新用户首次启动，无需登录。
2. 添加任一首版 Provider，有效凭证测试成功。
3. 选择一个支持工具的模型并完成流式回复。
4. WebView、日志和导出中不存在凭证明文。

### E2E-02：普通 Chat

1. 创建普通 Chat 并上传文件。
2. Ask 模式分析附件并使用网页来源。
3. Agent 尝试访问任意本地目录或终端时被运行时拒绝。
4. 会话可搜索并导出 Markdown/JSON。

### E2E-03：Plan 到 Agent

1. 添加本地 Project。
2. Plan 模式读取项目并生成包含文件、命令和验证步骤的计划。
3. 批准前无写入和命令副作用。
4. 用户修改计划后批准，Run 进入 Agent 执行。

### E2E-04：审批、Diff 与撤销

1. Agent 请求修改文件并运行测试。
2. 审批卡显示 Diff、命令、工作目录和风险。
3. 用户允许后执行，结果进入轨迹。
4. Git 与非 Git 项目都能识别本 Run 变更。
5. 用户撤销一项变更，不覆盖外部并发修改。

### E2E-05：Allow all 边界

1. 用户在当前 Session 开启 Allow all。
2. 项目内低/中风险写入和命令无需重复弹窗。
3. Project 外访问、秘密文件、删除大量文件或 Git push 仍要求确认或被拒绝。
4. 重启应用后开关恢复关闭。

### E2E-06：并行与排队

1. 并行启动 3 个 Session。
2. 第 4 个 Run 进入队列并显示原因。
3. 一个 Run 结束后自动启动队首任务。
4. 等待审批的任务发送不含敏感内容的通知。

### E2E-07：崩溃恢复

1. Run 完成部分文件操作后强制结束 Electrobun application runtime。
2. 重启应用显示最后安全检查点和已完成动作。
3. 恢复不重复已成功的副作用工具。
4. 状态不确定的动作要求人工确认。

### E2E-08：自定义 Agent

1. 创建包含固定模型、MCP、Skill、知识和权限的 Agent。
2. 不兼容模型或缺失依赖在保存/运行前可见。
3. 导出后不含密钥和本地绝对路径。
4. 在另一安装中导入并修复依赖后可运行。

### E2E-09：MCP

1. 导入并连接一个 stdio MCP。
2. 通过 OAuth 连接一个远程 MCP。
3. 查看并按 Tool 启停。
4. 有副作用 Tool 遵守审批；错误不被包装为成功。

### E2E-10：Skill

1. 安装符合 Agent Skills 规范的本地 Skill。
2. 应用展示元数据、脚本和权限声明并通过校验。
3. Agent 在相关任务中按需激活。
4. Skill 脚本仍需遵守命令权限。

### E2E-11：知识库

1. 添加文件目录并选择 Embedding Provider。
2. 云端索引前显示数据目的地。
3. 增量索引完成，回答带文件和页码/段落引用。
4. 切换本地 Embedding 后网络监测不到文档外发。

### E2E-12：Canvas

1. Agent 创建 Web 或 Markdown Canvas。
2. 用户编辑期间 Agent 基于旧 revision 提交 Patch，系统阻止覆盖并显示冲突。
3. 用户合并、创建版本、对比并恢复。
4. 导出结果可用。
5. 恶意 Web Canvas 无法访问 Electrobun RPC、Bun/Node、本地文件或未授权网络。

## 8. P0 质量门槛

### 8.1 正确性

- 消息、Run、Tool、审批和文件变更之间有稳定 ID 关联。
- 完成状态只在所有必需步骤持久化后写入。
- Provider/MCP 错误保持失败语义。
- 文件冲突不静默覆盖。

### 8.2 性能

- UI 消费流式事件时保持可交互。
- 长日志采用虚拟列表与截断，不阻塞 WebView。
- 项目索引和知识索引可暂停，不占满前台交互资源。
- 并发上限对模型、命令和索引分别进行资源控制。

### 8.3 安全

- API Key、OAuth Token 和敏感环境变量不进入 WebView。
- 所有特权 RPC 有 View 身份、参数和权限校验；DeepAgentService callback 有 run/execution/app-instance 校验。
- Allow all 的强制边界有自动化测试。
- Canvas、Markdown、网页内容和 MCP 返回经过对应隔离或清理。

### 8.4 可访问性与国际化

- 核心流程可仅使用键盘完成。
- 焦点、审批 Modal、通知和状态变化对辅助技术可感知。
- HeroUI 组件不因自定义样式破坏 React Aria 语义。
- 中英文不存在布局截断；日期、数字、Token 和货币按 locale 展示。

### 8.5 发布

- macOS 签名、公证和更新签名验证通过。
- 升级数据库前自动备份，迁移失败可回滚。
- 离线时仍可查看本地历史、Canvas 和设置。

## 9. 功能阶段矩阵

| 功能 | 阶段 0 | 阶段 1 | 阶段 2 | 阶段 3+ |
| --- | --- | --- | --- | --- |
| Electrobun/runtime/React/Router/UI 基线 | Go/No-Go POC | 完整 | 优化 | 跨平台 |
| 普通/Project Chat | POC | 完整 | 增强 | 协作 |
| Ask/Plan/Agent | POC | 完整 | 增强 | 自定义模式候选 |
| 文件/命令/审批/Allow all | POC | 完整 | 扩展到 MCP/Skill | 企业策略 |
| Provider | 1–2 家 | 六家 + 双兼容协议 | 本地模型 | 更多云 Provider |
| 并行/后台/恢复 | POC | 完整 | 子任务增强 | 定时任务 |
| Git | Diff POC | 状态/Diff/撤销 | 优化 | 分支/提交/Worktree/PR |
| 自定义 Agent | 数据模型 | 内置 Agent | 完整编辑与导入导出 | 编排/市场 |
| MCP | 连接 POC | 无正式 UI | 完整 | Resources/Prompts/企业 |
| Skills | 加载 POC | 无正式 UI | 完整 | Git 更新/市场 |
| 知识库 | 索引 POC | 无 | 云端 + 本地 Embedding | 高级检索 |
| Canvas | 隔离 POC | 无正式功能 | 四类型完整闭环 | 插件/依赖 |
| Browser automation | 无 | 无 | 无 | 受控支持 |
| Windows/Linux | 无 | 无 | 技术准备 | 正式支持 |

## 10. 阶段冻结前待决策

以下事项不阻塞当前需求基线，但必须在对应阶段设计冻结前确定：

| 事项 | 最晚决策点 |
| --- | --- |
| 品牌视觉和第三方 NOTICE 策略（正式名称“墨枢”、MIT 许可证已确定） | 阶段 1 |
| `BunSqliteSaver` Schema、迁移和 LangGraph 升级策略 | 阶段 0 |
| Electrobun 版本、实际 packaged runtime 和跨 runtime 升级策略 | 阶段 0 |
| in-process/sidecar 隔离 ADR；默认 in-process，只有实测触发才实施 sidecar | 阶段 0 |
| Canvas 默认断网和桌面 E2E 的可行实现 | 阶段 0 |
| 首个 Web Search BYOK Provider | 阶段 1 |
| macOS 发布渠道与自动更新源 | 阶段 1 |
| 费率目录来源和更新策略 | 阶段 1 |
| 调试日志保留时长和本地回收期 | 阶段 1 |
| 知识库首批格式、单文件和总索引上限 | 阶段 2 |
| Web Canvas 的依赖白名单/打包策略 | 阶段 2 |
| Agent 导出包扩展名和最终 Schema | 阶段 2 |
| 是否建立 opt-in 遥测服务 | 阶段 2 |
| 市场签名、审核和信任模型 | 阶段 4 |
