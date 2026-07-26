# 墨枢产品需求文档

> 正式名称：墨枢
> 文档版本：v0.2
> 状态：需求基线与三应用角色架构已确认
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
| 应用角色 | Electrobun client、agents server、executor；“三进程”指三种应用角色，不限制 Electrobun framework 的实际 PID 数 |
| Desktop 部署 | client 启动并监管一个本地 agents server 和一个本地 executor；退出时协作关闭，异常时 capped backoff 并显示恢复 UX |
| RPC | `client <-> agents server <-> executor`，WebSocket + versioned JSON RPC；desktop server 只绑定动态 loopback |
| 身份 | `clientId`/`executorId` 跨重连重启稳定；每次启动/连接使用新的 `instanceId` 和 `generation` |
| Agent/Executor | 当前 desktop 一个 host-backed local Executor 承载多个 Agent，Agent N:1 Executor；Executor 离线时相关 Agent 不能启动新 Run |
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
| 远程范围 | 独立启动/注册 client 或 executor 是未来扩展缝；Docker、cloud VM 和 remote-server transport 不属于当前 desktop 范围 |

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
| Client | 锁定 Electrobun `1.18.1`；负责 WebView、窗口、系统集成和两个本地 companion 的监管，不拥有业务 DB、Agent runtime 或 Tool 执行 |
| Companions | agents server 与 executor 都使用 TypeScript + Bun 编译为二进制，并随 desktop 构建、签名和更新；终端用户无需安装 Bun/Node |
| UI | React + React Router |
| 组件库 | HeroUI；统一主题 Token、浅色/深色模式和无障碍行为 |
| 图标 | `@gravity-ui/icons`；应用提供统一 Icon 包装层处理尺寸、颜色、标签和 tree-shaking |
| Agents server | 独占产品 DB/checkpoint、Provider/model credential、Agent definitions/versions、Session/Run/event、Provider access、Agent runtime、Policy/approval 和 Action intent/result；只保存 Agent resource ref 与同步得到的非权威、可丢弃 executor inventory cache |
| Executor | 独占自身 MCP config/credential/OAuth/lifecycle、Skill install/immutable version/content/hash/resources、实际 Tool、取消、进程树和 private local data |
| Agent | LangChain JavaScript `deepagents` 只在 agents server 运行；多个 Agent 可绑定同一个 executor |
| 持久化 | agents server 单写 `bun:sqlite` 业务库和项目维护的 LangGraph `BunSqliteSaver` |
| RPC | 应用协议为 `client <-> agents server <-> executor` 的 WebSocket + versioned JSON RPC；WebView 仍只使用最小 Electrobun RPC |
| Authorization | agents server 决定并持久化 Policy/approval，再签发一次性 execution grant；executor 验证后执行 |
| Secret | Provider/model credential 永远留在 agents server；MCP credential 只在 owning executor 的 `ExecutorSecretStore` 与目标 connection/process 使用，不复制到 server 或暴露给 query/UI/prompt/log/export |
| Canvas | 不可信 Web Canvas 使用无应用 RPC 的 sandbox `BrowserView`；默认断网能力必须通过阻断性 POC |

## 6. 架构落地边界

- 批准的是三个应用角色，不是“Electrobun 永远只有三个 OS 进程”。Electrobun launcher/WebView 等 framework process 不改变职责划分。
- 当前 desktop 只实现本地 supervisor 路径：server 绑定动态 loopback，client/executor 连接并注册。远程配对、TLS、多租户、Docker 和 cloud VM 留待后续 ADR。
- stable ID 用于逻辑绑定；新的 `instanceId`/`generation` 用于拒绝 restart/reconnect 后的迟到消息。
- agents server 是产品业务与授权事实来源；每个 executor 是自身 MCP/Skill 数据和实际 host execution 的事实来源。拆分角色不是完整 OS 沙箱，仍需路径、命令、网络和 grant 校验。
- 每次 executor 注册/重连先 full sync redacted inventory；成功前状态为 syncing。运行期使用 revision hint、60 秒 ±20% jitter poll 和 delta/snapshot fallback；cache stale/failed poll 不代表删除。
- Agent 只保存 assigned executor stable resource ref；server 按 version/hash 获取 Skill metadata 与 `SKILL.md`，resources/scripts 仍通过 executor。
- executor-owned MCP credential 与 execution grant 分离：连接可保持认证，但每次 Tool 仍需 server 的一次性授权；runtime teardown 不宣称 JavaScript 可可靠清零 string memory。
- 两个 companion 必须随 desktop 整体打包、签名和更新，不能要求用户安装 runtime，也不能运行时下载未知 binary。
- 当前代码仍是单 Application Host 内的无 Tool Ask slice。目标 WebSocket、registry、grant 和 companion supervision 尚未实现，详见[实施进度](../implementation/progress.md)。
- 本次开发阶段重构无需迁移现有业务 DB/checkpoint/Provider 开发数据；不兼容时明确 reset。首次外部发布后再冻结正式 migration gate。

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
