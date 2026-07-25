# 墨枢实施计划

> 文档版本：v0.1  
> 对应产品需求：[`docs/product`](../product/README.md)  
> 状态：建议实施基线  
> 更新日期：2026-07-24

## 1. 文档导航

| 文档 | 内容 |
| --- | --- |
| [技术架构](./architecture.md) | 技术选型、进程模型、模块边界、仓库结构和关键实现策略 |
| [数据与接口契约](./data-contracts.md) | 领域模型、状态机、事件、RPC、checkpoint、幂等和迁移 |
| [工程交付计划](./delivery-plan.md) | 工作包、依赖关系、关键路径、参考排期、人员配置和阶段出口 |
| [质量与发布计划](./quality-release.md) | 测试体系、安全验证、性能预算、CI/CD、签名、公证、更新和运维 |

## 2. 实施目标

实施计划首先保证 Phase 1 的端到端闭环：

```text
配置 Provider
  → 普通 Chat / Project Chat
  → Ask / Plan / Agent
  → 流式执行轨迹
  → 文件/命令审批
  → Diff 与撤销
  → 后台并发
  → 崩溃后恢复
```

Phase 2 在同一套运行时、权限和事件模型上增加自定义 Agent、MCP、Skills、知识库和 Canvas，不能为每项扩展另造一套执行框架。

## 3. 关键工程决策

| 编号 | 决策 |
| --- | --- |
| DEC-001 | 使用 Bun workspace 和 `bun.lock` 管理 Electrobun 应用及共享 TypeScript 包 |
| DEC-002 | Electrobun CLI 负责 Application Host 构建、打包、签名、公证和更新产物；Vite 负责 React WebView 的开发与构建 |
| DEC-003 | WebView UI、Electrobun Application Host、DeepAgentService、Canvas Preview 按模块分层；WebView 永远不直接拥有应用 runtime、文件、命令或密钥能力 |
| DEC-004 | 首选在锁定 Electrobun 的 application worker 内直接运行 Deep Agents JS；只有兼容性、硬崩溃隔离、资源限制或独立生命周期 POC 明确要求时才引入 sidecar |
| DEC-005 | 不向模型暴露 `LocalShellBackend.execute`；文件、命令和 Git 全部经 Action Broker |
| DEC-006 | 业务数据库使用 `bun:sqlite` + Drizzle；checkpoint 使用独立 SQLite 文件和基于 `BaseCheckpointSaver` 的项目适配器，不使用依赖 `better-sqlite3` 的官方 SQLite saver |
| DEC-007 | UI 轨迹读取规范化的持久事件，不直接依赖 Deep Agents 内部事件结构 |
| DEC-008 | Ask、Plan、Agent 通过有效工具集和 Policy Engine 强制区分，不只靠系统提示词 |
| DEC-009 | 本地 Run Scheduler 管理 1–5 个并发 Session；Phase 1 不依赖远程 Agent Protocol |
| DEC-010 | Web Canvas 使用 `sandbox: true` 的独立 Electrobun `BrowserView`/partition；严格 CSP、导航规则和子资源网络隔离必须通过 POC |
| DEC-011 | Provider、MCP、Skill、知识库均通过稳定 Port 接口接入，具体 SDK 被封装在 Adapter 内 |
| DEC-012 | Electrobun、其实际 application runtime、Deep Agents/LangChain 和 Provider SDK 精确锁版本，通过 runtime 兼容与打包验证后再更新 |
| DEC-013 | Secret Vault 使用稳定 Port；首发 macOS 由经审查的 Bun FFI/native adapter 接入 Keychain，不使用明文或弱加密回退 |

## 4. 实施原则

1. **垂直切片优先**：先打通一个 Provider、一个 Project、一种写操作和一次恢复，再横向扩展。
2. **策略先于工具**：任何新 Tool 在接入 Agent 前，先定义风险、审批、幂等和审计规则。
3. **持久化先于展示**：事件先落库再推送 UI，WebView 断线后可按序号补齐。
4. **恢复先于并发**：单 Run 的 checkpoint、工具幂等和故障恢复通过后，再开放多 Run。
5. **协议隔离变化**：Deep Agents、LangChain Provider 和 MCP 的升级不应改变 UI/数据库契约。
6. **不夸大沙箱**：Electrobun Application Host、可选 sidecar、`BrowserView.sandbox`、目录根路径和命令解析都不是完整 OS 沙箱；产品文案和安全设计必须如实反映。

## 5. 推荐技术基线

以下版本在项目初始化时锁定精确版本；实际版本号以初始化当天的兼容性验证结果为准。

| 领域 | 推荐 |
| --- | --- |
| Runtime | 锁定 Electrobun `1.18.1`；开发期使用 Bun 工具链，发行包内已包含该版本使用的 Bun runtime；TypeScript strict |
| Build | Electrobun CLI、Bun workspace、Vite（React WebView） |
| UI | React 19、React Router、HeroUI v3、Tailwind CSS v4 |
| Icon | `@gravity-ui/icons` + 应用级 Icon 包装组件 |
| Agent | `deepagents`、LangChain、LangGraph；由 in-process `DeepAgentService` 封装 |
| Validation | Zod 4 |
| App DB | `bun:sqlite` + Drizzle ORM |
| Checkpoint | 项目维护的 `BunSqliteSaver`（实现 LangGraph `BaseCheckpointSaver`），独立数据库 |
| Secret | `SecretVault` Port + macOS Keychain adapter；Windows DPAPI/Linux Secret Service 后续实现 |
| UI state | 持久状态经 Electrobun RPC Query/Subscription；仅瞬时 UI 状态使用轻量 store |
| Code editor | CodeMirror 6 |
| Test | `bun test`/Vitest、React Testing Library、自建 RPC 驱动桌面 E2E 与 package smoke |
| Logging | 结构化日志库 + 中央脱敏器 |

Electrobun `1.18.1` 的 launcher 会启动包内 Bun，并由框架创建 application worker 执行 `src/bun/index.ts`；终端用户不需要安装 Bun。开发者仍使用 Bun 完成依赖安装、脚本和 Electrobun CLI 构建。上游 `main` 已出现 Cottontail/JSC runtime 路线，因此不得把“Electrobun 永远使用 Bun”写成框架不变量，也不得在未重跑 Deep Agents runtime 矩阵时跨 runtime 升级。

参考实现 `wind-chasers/oh-your-pi` 在 Electrobun `1.18.1` 中直接 import Pi Agent SDK，没有应用级 sidecar、heartbeat 或 supervisor。这只能证明 Electrobun 支持“Agent SDK in-process + typed RPC”的拓扑，不能证明 Deep Agents JS、LangGraph checkpoint/HITL/subagent 或 Provider SDK 已兼容；本项目必须用 `deepagents` 独立验证，不能引入 Pi SDK 作为替代。

## 6. 交付阶段摘要

| 阶段 | 工程目标 | 参考周期 |
| --- | --- | --- |
| Phase 0 | 高风险技术底座、架构 POC、可恢复垂直切片 | 4–6 周 |
| Phase 1 | 核心 MVP 和 macOS Alpha/Beta | 14–18 周 |
| Phase 2 | 自定义 Agent、MCP、Skills、知识库、Canvas | 16–22 周 |
| Phase 3+ | Git/浏览器/编排/市场/跨平台等增强 | 按独立立项 |

参考周期基于 6 名工程师、1 名设计师和 1 名产品经理的稳定团队，仅用于容量规划，不构成发布日期承诺。团队规模和能力差异需要重新估算。

## 7. Phase 0 必须做出的决策

| 决策门 | 结论要求 |
| --- | --- |
| DG-01 Build | Electrobun `1.18.1` stable/canary 构建、React/Vite WebView、in-process DeepAgentService、`bun:sqlite` 和 sandbox Preview 在签名产物中均工作 |
| DG-02 Storage | 业务 DB、自研 checkpoint saver、WAL、备份和迁移方案通过 `BaseCheckpointSaver` 行为契约与故障测试 |
| DG-03 Runtime | Deep Agents/Provider 在 Electrobun application worker 内通过 import/bundle、流式、HITL、取消、同步子 Agent、`AsyncLocalStorage` 上下文与 3 个并发 Run 测试 |
| DG-04 Action Broker | 路径、命令、审批和幂等契约冻结 |
| DG-05 Release | Electrobun 签名/公证、自解压产物、Updater 完整性和回滚路径确定 |
| DG-06 Search | Phase 1 首个 BYOK Web Search Provider 确定 |
| DG-07 License | 产品名“墨枢”和 MIT 开源许可证已确定；第三方 NOTICE 策略待确定 |
| DG-08 Security gaps | Keychain、Canvas 子资源断网、RPC capability 校验、桌面 E2E 和 crash diagnostics 均有可执行方案 |
| DG-09 Isolation | 根据 event-loop、崩溃、内存/CPU 和生命周期实测确认保持 in-process；若改用 sidecar，单独完成协议、监管、签名和恢复 ADR |

## 8. 与 Deep Agents 的实现映射

| 产品能力 | Deep Agents 使用方式 | 应用补充 |
| --- | --- | --- |
| 待办/规划 | todo middleware | 规范化事件、Plan revision 和批准状态 |
| 文件工具 | 自定义 Brokered Backend | 路径策略、审批、变更日志、冲突和撤销 |
| 命令 | 不使用裸 `LocalShellBackend.execute` | 结构化 Command Tool + Action Broker |
| 子 Agent | Phase 1 使用同步 subagent | UI 轨迹、配额、取消；本地异步任务后续抽象 |
| 上下文压缩 | summarization middleware | 压缩事件、Token 统计和调试信息 |
| 审批 | LangGraph interrupt/HITL | 动态风险策略、Allow all 和持久审批卡 |
| 恢复 | checkpointer/thread id | Run 状态、工具幂等、不确定副作用处理 |
| Skills/Memory | skills/memory middleware | 安装、作用域、内容哈希、安全与 UI |
| 流式 | typed event projections/stream | 稳定 AppEvent 转换、落库、重连补发 |

Deep Agents 当前的异步 subagent 通过 Agent Protocol Server 工作。Phase 1 的“多会话后台并发”由应用自己的 Run Scheduler 实现；同步 subagent 仍在单个 Run 内工作。是否在 Phase 2 启动本地 Agent Protocol 服务或实现 Local Task Broker，由独立 ADR 和 POC 决定。

## 9. 参考资料

- [Electrobun](https://github.com/blackboardsh/electrobun)
- [Electrobun 1.18.1 README](https://github.com/blackboardsh/electrobun/blob/v1.18.1/README.md)
- [Electrobun 1.18.1 Architecture](https://github.com/blackboardsh/electrobun/blob/v1.18.1/docs/src/content/docs/electrobun/guides/architecture/overview.mdx)
- [Electrobun main README](https://github.com/blackboardsh/electrobun/blob/main/README.md)
- [Electrobun Architecture](https://framework.blackboard.sh/electrobun/guides/architecture/overview/)
- [Electrobun BrowserView](https://framework.blackboard.sh/electrobun/apis/browser-view/)
- [Electrobun Build Configuration](https://framework.blackboard.sh/electrobun/apis/cli/build-configuration/)
- [Bun Node.js Compatibility](https://bun.com/docs/runtime/nodejs-compat)
- [Bun SQLite](https://bun.com/docs/runtime/sqlite)
- [LangGraph SQLite Checkpointer](https://github.com/langchain-ai/langgraphjs/tree/main/libs/checkpoint-sqlite)
- [Deep Agents JavaScript](https://docs.langchain.com/oss/javascript/deepagents/overview)
