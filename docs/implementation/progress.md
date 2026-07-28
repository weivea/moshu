# 实施进度

> 更新日期：2026-07-28
> 当前产品阶段：Phase 0
> 当前架构里程碑：A3 executor-only 七工具桥接（部分完成）
> 当前代码基线：三应用角色、公开 Pi Agent runtime、可信本机 executor Tool gateway

本文只记录代码或自动化测试已经证明的能力。批准的目标见[技术架构](./architecture.md)，后续顺序见[工程交付计划](./delivery-plan.md)。

## 1. 当前架构状态

| 口径 | 状态 |
| --- | --- |
| 批准的应用角色 | Electrobun client、agents server、executor |
| 当前仓库实现 | client 监管两个 compiled companion；Provider、Agent、产品 DB 和 Agent Session 位于 agents server；七工具只在 executor 执行 |

```text
React WebView
  -> typed Electrobun RPC
  -> authenticated client/agents-server JSON RPC
  -> ChatApplicationService
  -> public Pi ModelRuntime + headless AgentSession
  -> Product DB RunJournal + Pi SessionManager JSONL

executor
  -> authenticated registration/readiness + invocation gateway
  -> read/bash/edit/write/grep/find/ls
  -> MCP/Skill execution（尚未实现）
```

“三进程”表示三个应用角色；Electrobun framework 仍会创建 launcher、application worker 和 WebView 等额外进程。

## 2. 已完成的基础

- 两个 TypeScript + Bun compiled companion 由 desktop supervisor 启动、认证、监管和协作关闭。
- 动态 loopback bootstrap、stable identity、instance/generation fencing、请求 allowlist、取消和 event replay 已有合同与测试。
- packaged canary、standalone binary、three-process、parent-death 和 companion smoke 构成当前发布门槛。
- 产品数据库只有 agents server 写入，保存 SessionCatalog、RunJournal、durable events、retirement tombstone 和
  agent-session cleanup outbox。
- 每个 Chat Session 拥有稳定 Pi session ID；conversation context 由显式
  `agentDataDirectory/sessions` 下的 `SessionManager` JSONL 保存和恢复。
- 删除 Session 先建立持久 cleanup job，再经 lease/dispose、路径 containment 和 targeted unlink 清理 Pi 文件；
  失败按有界 backoff 重试。

## 3. 当前 Agent 与 Provider 实现

- `@earendil-works/pi-ai`、`pi-agent-core`、`pi-coding-agent` 固定为 `0.82.1`，生产代码只使用公开导出。
- `ModelRuntime` 动态枚举内置 Provider；不保存静态 Provider 清单。
- 自定义 Provider 仅支持 `openai-completions`、`openai-responses`、`anthropic-messages` 和
  `google-generative-ai`，可使用稳定的多个实例 ID。
- builtin/custom 启用状态、模型勾选和默认模型由 app-owned Provider registry 保存；刷新只针对选中的
  public Pi Provider。
- Provider credential 由 `SecretVaultCredentialStore` 保存：目录 `0700`、文件 `0600`、provider lock、
  whole-file commit lock、fresh read/apply、atomic rename 和 fsync。
- API Key/OAuth 通过 `Models.login/logout` 和异步 auth attempt 驱动。UI 轮询 attempt，支持
  text/secret/select/manual code、info/auth URL/device code/progress；secret 回答不回显、不持久化。
- 默认 Chat Session/Run 使用 `agent` mode。`PiAgentRuntime` 使用 `createAgentSession`、
  `DefaultResourceLoader`、`SettingsManager` 和 `SessionManager`。
- runtime 固定 `noTools: "builtin"`，禁用 extensions、skills、prompt templates、themes、context files 和
  TUI，只注册 `read`、`bash`、`edit`、`write`、`grep`、`find`、`ls` 七个 SDK custom proxy；启动时验证
  active/configured Tool 集合及来源，不能回退到 Pi built-in。
- proxy 只做 Zod/TypeBox 校验和 executor RPC 映射；标准 tool-call/tool-result 循环、progress、abort、
  executor unavailable 和 gateway error 已有自动化覆盖。
- executor 文件变更按稳定 canonical pathname 串行化并使用 atomic rename，覆盖 inode 替换和 dangling
  symlink；`edit` 在读取前执行 16 MiB 上限并先验证有界 diff/result 再提交。
- `read` 流式读取文本；图片在 Photon 解码前执行 32 MiB 输入、32,768 单维和 25M 像素上限。`grep`
  有界收集 context，避免大文件整文件 materialize。
- `bash` 使用流式 UTF-8 解码、输出 backpressure、64 MiB 单命令上限、256 MiB 保留目录总配额和私有
  `0700`/`0600` 路径；失败保留可诊断路径，取消等不能返回路径的失败释放文件和配额。
- Unix process group 与 Windows Job Object 都纳入命令生命周期；成功、失败、timeout 或 cancel
  都会清理残留进程树。
- streaming text、final usage、Provider 错误、abort/cancel、同 Session 单 owner、跨 Session 并发、restore、
  disposal 和安全删除已有自动化覆盖。
- 模型推理使用 Pi `ThinkingLevel`。设置时拒绝无效档位；运行时若已保存档位不再被刷新后的模型支持，则安全省略，
  不让 Chat 因 capability drift 持久失败。

## 4. 当前产品能力

- Providers 页面区分动态 builtin 与 custom Provider；builtin 身份/Endpoint 只读，custom 可编辑和删除。
- Provider auth、退出、连接测试、按 Provider 刷新模型、模型启停和 authentication readiness 已贯通
  renderer、Electrobun RPC 和 Product RPC。
- 普通 Chat 支持流式回复、停止、继续已有 Session、失败状态、自动标题、搜索、重命名、归档和永久删除。
- `/chat/new` 与 `/chat/:sessionId` 是当前 Session 选择事实来源。
- 事件先持久化再发布；snapshot、cursor、replay、tombstone 和 reconciliation 可处理重连。
- 非终态 orphan Run 在启动时安全终结；当前不宣称可从进程崩溃点继续执行同一个 Run。

## 5. 当前明确未实现

- 尚无 Action Broker、Policy Engine、approval、execution grant、durable intent、outcome recovery 或审计。
- 当前七工具是临时可信本机直连：路径允许绝对路径和 `..`，executor 完整继承 desktop `process.env`，
  `bash` 可读取其中的 credential。该边界不能作为最终授权机制。
- 尚无独立 Git Tool；Agent 可经 `bash` 调用环境中可用的 Git，但没有 Git 专用合同、Diff journal 或 revert。
- MCP lifecycle、MCP credential、Skills 安装/版本/content store 和资源 inventory 尚未实现。
- Plan、自定义 Agent、subagent、任务中心、Diff/撤销和桌面通知仍是后续产品范围。
- 当前 Agent 不暴露 MCP、Skill 或 subagent；文档中的相关合同是未来 Moshu-owned 边界，不是现成功能。
- macOS Provider vault 当前是权限加固的 app-owned 文件；Keychain adapter 仍是外部分发前安全工作。
- remote client/executor、Docker、cloud VM、TLS 配对和多租户不在当前 desktop 范围。

## 6. 架构迁移状态

| 阶段 | 状态 | 下一项可验证结果 |
| --- | --- | --- |
| A0 RPC / binary POC | 已完成 | compiled companion、动态 loopback、认证 RPC、监管、关闭和 package gate |
| A1 agents-server extraction | 已完成 | Pi Agent、Provider/auth、产品 DB、Session JSONL 和 cleanup 全部归 agents server |
| A2 Executor / Agent registry | 部分完成 | executor 注册/readiness 已有；Agent N:1 binding 和 inventory 尚未实现 |
| A3 Tool Bridge / Action Broker | 部分完成 | 七工具 typed RPC、executor-only 执行、progress/cancel 已有；Policy/intent/grant/recovery 尚未实现 |
| A4 MCP / Skills | 未开始 | executor-owned secret/lifecycle/store、inventory reconciliation、resource refs |
| A5 Recovery / release hardening | 部分完成 | restart/package/smoke 已有；签名、公证、Keychain 和完整故障矩阵待完成 |

## 7. 开发数据策略

当前仍处于首次外部分发前。产品 DB 与 Provider registry 使用当前 schema；不兼容的旧开发数据可明确 reset，
不会保留已删除 runtime 的转换 adapter。Pi Session JSONL 是当前 conversation context 格式。
首次外部发布冻结 schema 后，升级必须遵守 backup、migration、rollback 和 fixture gate。

## 8. 下一优先级

1. 用 Moshu-owned Policy/approval/durable intent/single-use grant 替换当前可信直连七工具边界。
2. 冻结 Executor/Agent identity、binding、inventory 和 offline Run gate。
3. 在同一边界上实现 executor-owned MCP 与 Skill storage，不给 Agent runtime 建旁路。
4. 完成 Keychain、签名、公证、故障矩阵和外部 packaged E2E 后再声明可发布。
