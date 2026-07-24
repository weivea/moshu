# Agent Desktop 产品需求文档

> 产品暂名：Agent Desktop  
> 文档版本：v0.1  
> 状态：需求基线已确认  
> 更新日期：2026-07-24

## 1. 文档导航

| 文档 | 内容 |
| --- | --- |
| [产品总需求](./product-requirements.md) | 产品定位、用户、目标、范围、原则、指标与非目标 |
| [核心体验与信息架构](./core-experience.md) | 路由、普通 Chat、Project Chat、执行模式、会话、任务、项目与 Git |
| [Agent 与扩展生态](./agents-integrations.md) | 自定义 Agent、模型 Provider、MCP、Skills、知识库与联网工具 |
| [Canvas](./canvas.md) | Canvas 类型、编辑/预览、版本、导出、Agent 协作与隔离运行 |
| [安全、权限与本地数据](./security-data.md) | 权限模型、Allow all、命令与文件安全、密钥、隐私和 Electrobun 安全 |
| [阶段路线图与验收](./roadmap.md) | 分阶段交付范围、依赖、验收场景、质量门槛和待决策事项 |
| [工程实施计划](../implementation/README.md) | 技术架构、数据契约、工作包、测试和发布计划 |

文档中的 P0/P1/P2 表示某项能力在其**所属交付阶段内**的优先级：P0 为阶段发布阻塞项，P1 为应交付项，P2 为可后置项；它不等同于全产品阶段编号。

## 2. 一句话定义

一款面向泛技术用户的、Local-first 的开源桌面 Agent 应用：用户可以自由选择国内外模型，在普通会话或本地项目中，以可观察、可审批、可恢复的方式让 Agent 完成编程、文档、研究和内容任务，并通过 Canvas 共同产出可编辑成果。

## 3. 已确认的产品决策

| 主题 | 决策 |
| --- | --- |
| 目标用户 | 会使用 AI 工具的泛技术用户，兼顾编程与通用任务 |
| 产品形态 | Electrobun + React 桌面应用，首发 macOS 14+ |
| 数据策略 | Local-first，首版无需账号，数据和配置默认保存在本机 |
| Project | 一个本地文件夹或 Git 仓库，可用于代码、文档或通用任务 |
| Chat 类型 | 普通 Chat 不绑定目录；Project Chat 绑定项目并可操作项目环境 |
| Agent 模式 | Ask、Plan、Agent |
| 本机能力 | 可读写项目文件、执行终端命令；敏感操作需要审批 |
| Allow all | 输入框可开启，仅当前会话生效；重启后关闭；系统级高风险操作仍需确认 |
| 并发 | 默认最多 3 个活跃会话，可配置为 1–5 个，超出后排队 |
| Deep Agents | 展示任务计划、待办、子 Agent、上下文压缩、中断与恢复的执行轨迹 |
| Git | 首版提供状态、Diff、变更审阅和单项撤销；分支、提交、Worktree 后置 |
| 自定义 Agent | 可视化配置提示词、模型、工具/MCP、Skills、权限、知识文件，并可导入导出 |
| Provider | OpenAI、Anthropic、Gemini、DeepSeek、Kimi、智谱；自定义 OpenAI-compatible 与 Claude-compatible Endpoint |
| 模型体验 | 连接测试、模型切换、参数、能力标签、Token/费用统计和预算提醒 |
| 本地模型 | 第二阶段支持 Ollama；LM Studio 通过兼容 Endpoint 接入 |
| MCP | stdio、Streamable HTTP、兼容 SSE；Bearer/API Key 与 OAuth 2.1；支持配置导入 |
| Skills | 兼容 Agent Skills 规范，支持安装、校验、启停、导入导出 |
| 知识库 | 本地索引、按需检索、来源引用；首版使用可配置云端 Embedding，后续支持本地 Embedding |
| 联网工具 | 内置可开关的网页搜索与 URL 读取；浏览器自动化后置 |
| Canvas | Markdown、代码、网页/图表；人和 Agent 双向编辑、实时预览、版本/差异、导出和隔离运行 |
| 会话 | 自动保存、标题、搜索、重命名、归档、删除、Markdown/JSON 导出和中断恢复 |
| 后台运行 | 多会话并行，完成或待审批时发送桌面通知 |
| 国际化 | 中英双语，默认跟随系统语言 |
| 发布模式 | 应用开源，用户自备 API Key；后续可增加付费增值服务 |

## 4. 产品边界

### 首个可用闭环

用户安装应用后，不登录即可完成以下流程：

1. 配置并测试一个模型 Provider。
2. 创建普通 Chat，或添加本地目录后创建 Project Chat。
3. 选择 Ask、Plan 或 Agent 模式并提交任务。
4. 查看 Agent 的计划、待办、工具调用、子 Agent 和流式输出。
5. 审批文件修改或命令；也可对当前会话开启 Allow all。
6. 查看文件变更和 Git Diff，撤销某项 Agent 变更。
7. 切换到其他会话，让原任务继续在后台运行。
8. 应用退出或异常后，重新打开并继续可恢复的任务。

### 首版不追求

- 云账号、云同步、团队协作或分享链接。
- 完整 IDE、调试器、PR 管理或完整 Git 客户端。
- 无人值守的定时任务。
- Agent、MCP 或 Skill 在线市场。
- 浏览器自动化。
- Windows/Linux 同步首发。

## 5. 技术选型约束

| 层级 | 约束 |
| --- | --- |
| 桌面容器 | 锁定 Electrobun `1.18.1`；Application Host 承载桌面协调、Agent service、策略、文件、命令、密钥和持久化 |
| UI | React + React Router |
| 组件库 | HeroUI；统一主题 Token、浅色/深色模式和无障碍行为 |
| 图标 | `@gravity-ui/icons`；应用提供统一 Icon 包装层处理尺寸、颜色、标签和 tree-shaking |
| Agent | LangChain JavaScript `deepagents`，首选在 Electrobun application worker 内由 `DeepAgentService` 直接运行；必须通过真实 runtime POC |
| 持久化 | `bun:sqlite` 业务库 + 项目维护的 LangGraph `BunSqliteSaver`；数据模型不得绑定云服务 |
| RPC | WebView 只能通过最小化、类型安全且运行时校验的 Electrobun RPC 与 Host 通信 |
| Secret | `SecretVault` Port；首发 macOS 通过经审查的 Bun FFI/native adapter 使用 Keychain |
| Canvas | 不可信 Web Canvas 使用无应用 RPC 的 sandbox `BrowserView`；默认断网能力必须通过阻断性 POC |

## 6. 技术核对结论

基于官方文档及本地 Deep Agents 源码核对：

- Electrobun `1.18.1` 的发行包已经包含 Bun runtime，终端用户不需要另装 Bun；开发者仍使用 Bun 进行依赖安装、脚本和 Electrobun 构建。Bun 是该版本内部 runtime，不是本项目额外增加的一层。
- 参考实现 `oh-your-pi` 将 Pi Agent SDK 直接 import 到 Electrobun application worker，没有应用级 sidecar、heartbeat 或 supervisor。这验证了 in-process Agent SDK + typed RPC 的拓扑，但 Pi 的 SessionManager、JSONL、事件和权限 extension 不能用于替代 Deep Agents JS。
- 默认先直接运行 `deepagents`。只有 application runtime 不兼容、硬崩溃/资源隔离不达标、命令进程树无法可靠回收或需要独立 daemon 生命周期时，才立项 sidecar ADR；“任务运行时间长”本身不是理由。
- 若 sidecar 被选中，它必须随应用打包 runtime，并增加协议、监管、Secret、checkpoint ownership、签名和更新矩阵；不能要求终端用户安装 Bun/Node，也不能作为隐式 fallback。
- Electrobun 没有 Electron `utilityProcess`、`safeStorage`、`webRequest`、Fuses 或 Playwright Electron 的等价基线；Keychain、Canvas 子资源隔离、应用生命周期和桌面 E2E 需要项目实现并在 Phase 0 验证。
- `createDeepAgent` 已提供 model、tools、subagents、checkpointer、store、backend、interrupt、memory、skills 和 filesystem permissions 等扩展点。
- 内建待办、文件系统、同步/异步子 Agent、上下文总结、Skills、Memory 与人工审批中间件，可直接映射到执行轨迹 UI。
- Deep Agents 尚未声明 Electrobun application worker 为官方认证 runtime；import/bundle、stream、HITL、同步 subagent、取消、Provider SDK 和 `AsyncLocalStorage` 上下文传播必须用真实负载验证。
- LangGraph checkpointer 可用于线程恢复，但官方 SQLite saver 依赖 `better-sqlite3`，不能作为 Bun 生产基线；产品需实现 `BaseCheckpointSaver` adapter，并补充任务幂等、崩溃恢复和本地数据库生命周期。
- `LocalShellBackend` 明确不提供沙箱，且文件虚拟根目录不能约束 Shell 命令；首版必须在其上增加独立命令策略与审批层，不能直接暴露给模型。
- Electrobun `1.18.1` 是 Bun runtime 基线，而上游 `main` 已出现 Cottontail/JSC 路线；项目必须锁定版本、记录 packaged runtime，跨 runtime 升级时重跑完整 Deep Agents 矩阵。
- Electrobun 当前官方目标为 macOS 14+、Windows 11+ 和 Ubuntu 22.04+；首发仍限定 macOS，跨平台阶段另补 Secret、深链/文件关联、打包和 E2E 的能力差异。
- Electrobun 版本演进快，社区 issue/PR 不保证响应时限；项目必须具备维护最小补丁或停止升级的能力。
- HeroUI 当前采用 React Aria 与 Tailwind CSS v4；Gravity UI Icons 提供 React/SVG 图标数据，不提供应用级 Icon 组件。

因此 Electrobun 迁移在架构上**有条件可行**，且不需要默认增加 Bun sidecar。Phase 0 的 in-process Deep Agents、`BunSqliteSaver`、LangGraph HITL/恢复、Run 生命周期、Keychain、Canvas 默认断网和 packaged E2E 任一核心门失败，都必须让当前基线 No-Go，而不是降低安全或恢复要求；采用 sidecar 时需重新通过同等级门禁。

## 7. 参考资料

- [Deep Agents JavaScript Overview](https://docs.langchain.com/oss/javascript/deepagents/overview)
- [Deep Agents Human-in-the-loop](https://docs.langchain.com/oss/javascript/deepagents/human-in-the-loop)
- [Deep Agents Skills](https://docs.langchain.com/oss/javascript/deepagents/skills)
- [LangChain MCP](https://docs.langchain.com/oss/javascript/langchain/mcp)
- [Agent Skills Specification](https://agentskills.io/specification)
- [LangChain.js Providers](https://github.com/langchain-ai/langchainjs/tree/main/libs/providers)
- [Electrobun](https://github.com/blackboardsh/electrobun)
- [Electrobun 1.18.1 README](https://github.com/blackboardsh/electrobun/blob/v1.18.1/README.md)
- [Electrobun 1.18.1 Architecture](https://github.com/blackboardsh/electrobun/blob/v1.18.1/docs/src/content/docs/electrobun/guides/architecture/overview.mdx)
- [Electrobun main README](https://github.com/blackboardsh/electrobun/blob/main/README.md)
- [Electrobun BrowserView](https://framework.blackboard.sh/electrobun/apis/browser-view/)
- [Bun Node.js Compatibility](https://bun.com/docs/runtime/nodejs-compat)
- [Bun SQLite](https://bun.com/docs/runtime/sqlite)
- [HeroUI](https://github.com/heroui-inc/heroui)
- [Gravity UI Icons](https://github.com/gravity-ui/icons)
