# 实施进度

> 更新日期：2026-07-30
> 当前产品阶段：Phase 0
> 当前架构里程碑：RB-09 发布加固
> 当前代码基线：Local/Remote Runtime Box、强认证 ingress、Dev Tunnel、durable Action recovery、双 owner MCP/Skills

本文只记录代码或自动化测试已经证明的能力。批准的目标见[技术架构](./architecture.md)，后续顺序见[工程交付计划](./delivery-plan.md)。

## 1. 当前架构状态

| 口径 | 状态 |
| --- | --- |
| 批准的应用角色 | Client、agents server、Runtime Box；Runtime Box 是 Box 内部执行组件 |
| 当前仓库实现 | client 监管 agents-server 和 Local Runtime Box companion；Provider、Agent、产品 DB 和 Agent Session 位于 agents server；七工具只在 Box 内部 Executor 执行 |

```text
React WebView
  -> typed Electrobun RPC
  -> authenticated client/agents-server JSON RPC
  -> ChatApplicationService
  -> public Pi ModelRuntime + headless AgentSession
  -> Product DB RunJournal + Pi SessionManager JSONL

Local Runtime Box
  -> Runtime Box descriptor registration + keyed registry/invocation gateway
  -> read/bash/edit/write/grep/find/ls
  -> MCP stdio/Streamable HTTP/SSE + immutable Skills

Agent Server
  -> Server-owned MCP stdio/Streamable HTTP/SSE
  -> global Agent MCP refs + local Action dispatcher
```

“三进程”表示三个应用角色；Electrobun framework 仍会创建 launcher、application worker 和 WebView 等额外进程。

## 2. 已完成的基础

- 两个 TypeScript + Bun compiled companion 由 desktop supervisor 启动、认证、监管和协作关闭。
- 动态 loopback bootstrap、stable identity、instance/generation fencing、请求 allowlist、取消和 event replay 已有合同与测试。
- packaged canary、standalone binary、three-process、parent-death 和 companion smoke 构成当前发布门槛。
- Runtime protocol v2 已冻结到独立 min/max/current；v2 增加 MCP config revision，旧 Remote Box 在 Upgrade 前收到 HTTP 426，
  再用设备 key 提交短时防重放兼容性报告；Server 验证 generation 后持久化，registry/UI 跨重启显示
  `upgrade_required`。报告受 lifecycle/5 秒 timeout 约束；Relay TLS 与未来 Noise negotiation 字段均进入签名。
- Runtime RPC 收发字节按月持久估算，设置页显示 5 GiB 的 50/80/100% 告警及公开 Dev Tunnels 数量、
  端口和速率限制；该值不冒充 Microsoft Relay 计费。
- Product RPC 提供严格 Schema 的脱敏 Runtime diagnostics，仅包含版本/identity/protocol、registry、
  inventory 摘要、DB quick-check 和 Remote Access 状态，不包含 Secret、MCP config、Skill body 或 locator。
- desktop、agents-server 和 Runtime Box 共用 release version；最终 package 写入两个 companion 的
  SHA-256/protocol 清单，supervisor 拒绝 READY version mismatch，package smoke 在无系统 Bun/Node PATH 下启动。
- stable package gate 要求永久 app ID、HTTPS release origin 和 Ed25519 更新密钥；macOS 要求 Developer ID、
  notarization/staple/Gatekeeper，Windows 对完整 bundle 执行 Authenticode SHA-256 + RFC 3161。
  最终 `Setup.exe` 也在 installer ZIP 内签名并验证；update metadata/archive/installer 由一个签名清单整体绑定。
- Remote Runtime Box 可作为普通用户服务安装在 Linux/macOS/Windows；单二进制携带校验后的
  rg、fd 和 Photon WASM 资源，并使用私有配置、generation 和 workspace。
- Agent Server 暴露独立 Runtime-only ingress，使用一次性 pairing code、Ed25519 challenge、
  device-key revocation、持久 generation fence、入口限流和 canonical RPC identity。
- Agent Server 管理 Dev Tunnel Microsoft device-code 登录、持久 cluster-qualified Tunnel ID、
  单一 Anonymous HTTP ingress port、Host watchdog、重建/修复、取消和重试；Product RPC 不暴露到 Tunnel。
- Agent Server 在派发前持久化 Action intent，并签发参数、来源、目标 generation 与 execution scope
  绑定的短时单次 grant；Runtime Box 执行前 fsync invocation journal。
- Runtime 断线不会提前终止已开始 Action；执行继续到原 RPC deadline，显式取消、deadline 或 daemon
  shutdown 才立即取消。结果通过 evidence ack、Box receipt、Server confirmation 三阶段幂等收敛，
  非幂等 Action 不自动重放。
- Remote Runtime Box 使用 data-directory 单实例锁；永久认证失败或 daemon shutdown 会先取消并排空所有
  Action，再释放锁。数据库 reset 通过 `actionJournalEpoch` 隔离旧 journal。
- Runtime Box 私有 SQLite/SecretStore/Skill store 保存 MCP config/credential、immutable Skill content、
  inventory epoch/revision/change log；Agent Server 仅保存严格脱敏 projection 和稳定 Runtime Profile ref。
- Agent Server-owned MCP 使用 Product DB metadata、独立 MCP SecretStore 和全局 Agent profile；连接不随 active
  Runtime Box 切换，stdio 运行在 Agent Server host。
- MCP list 给 renderer 的 DTO 不含 command/args/cwd/URL 等 transport config；启停使用 Box 内部
  `setEnabled` mutation，不再把持久 transport round-trip 到 WebView。
- 每次连接先 full inventory sync，连续 delta/hint 和 48–72 秒独立 poll 维持 cache；gap、压缩、epoch reset、
  无前进 cursor 或旧 peer 结果均 fail closed/full snapshot，offline 只标 stale。
- MCP stdio、Streamable HTTP 与兼容 SSE lifecycle 已接入，进程树/session/stream 均可回收；每次 MCP Tool
  仍使用 durable intent、版本/hash/schema 绑定的单次 grant 与 invocation journal。
- Server-owned MCP 与 Box-owned MCP 共用协议/lifecycle package、owner-aware ToolDefinition 和 Action
  语义；Server 本地调用不伪装成 Runtime Box target，Box 调用继续使用 journal/evidence。
- Skills 使用 YAML 规范校验、内容 hash、不可变版本、filesystem-safe 目录和 fsync commit；Run 启动时 live
  验证并只在内存加载 `SKILL.md`，不会写入 Product DB、事件或 Pi Session JSONL。
- Agent Server-owned Skill 使用 Product DB metadata、private immutable content store 和 Agent global profile，
  首期只接受单个非 executable `SKILL.md`；Box-owned Skill 保留完整 package。两类 owner 同名时 Run fail closed。
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
- runtime 固定 `noTools: "builtin"`，禁用 Pi extensions/skills/prompt templates/themes/context files 和
  TUI；注册七个 Executor SDK proxy，并按 live Runtime Profile 增加 MCP SDK ToolDefinition，不能回退到
  Pi built-in 或绕过 Runtime Box grant。
- proxy 只做 Zod/TypeBox 校验和 Runtime Box RPC 映射；标准 tool-call/tool-result 循环、progress、abort、
  Runtime Box unavailable 和 gateway error 已有自动化覆盖。
- Runtime Box 文件变更按稳定 canonical pathname 串行化并使用 atomic rename，覆盖 inode 替换和 dangling
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
- Projects 支持 Local 系统目录选择、Remote 绝对路径输入、规范化/Git/根 `AGENTS.md` 预览确认、路径健康检查、
  重命名、重新关联、归档/恢复和 typed-confirmation durable 删除；删除只清理产品记录与 Pi Session，
  不删除 Runtime Box 上的目录。
- Project Session 使用不可变 `projectId + runtimeBoxId` 归属；全局 Chats 不返回 Project Session。
  `/projects/:projectId` 提供完整 Session 搜索与管理，Project Chat 复用现有 Chat controller，
  archived/offline/path unavailable 状态下历史只读。
- Project Run 在执行前实时验证 owning Box 与 canonical path，只在内存加载根 `AGENTS.md` 正文，
  并持久化 path revision/Git/hash 快照。Local/Remote Project 的文件 Tool 使用签名的 `project-root`
  scope 和 lexical/canonical containment；`bash` 仅以 Project 为默认 cwd，仍不属于 shell sandbox。
- Project 删除按持久 job 分批 retire Session；tombstone 同时提供 TTL 内的 replay 与 Desktop retirement
  recovery，Pi JSONL 由 cleanup outbox 最终清理。
- 事件先持久化再发布；snapshot、cursor、replay、tombstone 和 reconciliation 可处理重连。
- 非终态 orphan Run 在启动时安全终结；当前不宣称可从进程崩溃点继续执行同一个 Run。

## 5. 当前明确未实现

- 当前 POC 的 Policy 默认信任已认证且绑定的 Agent Server，包括 Remote `bash`；用户级命令审批与 shell
  sandbox 明确后置。现有 grant 用于 durable dispatch、单次消费、generation fencing 和恢复，不是交互审批。
- Remote 普通 Chat 的 path tools 受 Box workspace canonical containment；Project Chat 文件 Tool 受
  Project root containment。`bash` 按当前完全信任决策不受文件 containment 限制。
- 尚无独立 Git Tool；Agent 可经 `bash` 调用环境中可用的 Git，但没有 Git 专用合同、Diff journal 或 revert。
- Plan、自定义 Agent、subagent、任务中心、Diff/撤销和桌面通知仍是后续产品范围。
- MCP OAuth 2.1 浏览器授权/DCR、Git URL Skill 更新和完整目录/压缩包导入 UI 仍是后续产品增强。
- macOS Provider vault 当前是权限加固的 app-owned 文件；Keychain adapter 仍是外部分发前安全工作。
- Remote Runtime Box 的 ingress、设备配对认证、三平台 daemon、Dev Tunnel、durable grant、断线
  outcome reconciliation、MCP/Skill ownership 和发布故障矩阵已实现。真实 Microsoft Tunnel 探针、
  macOS 正式公证和 Windows 正式签名仍是需要外部账号、证书和对应 runner 的 release 执行门。
  Mobile Client、团队共享、Docker/cloud 和多租户仍不在当前范围。

## 6. 架构迁移状态

| 阶段 | 状态 | 下一项可验证结果 |
| --- | --- | --- |
| A0 RPC / binary POC | 已完成 | compiled companion、动态 loopback、认证 RPC、监管、关闭和 package gate |
| A1 agents-server extraction | 已完成 | Pi Agent、Provider/auth、产品 DB、Session JSONL 和 cleanup 全部归 agents server |
| A2 Runtime Box / Agent registry | 部分完成 | Runtime Box 注册/readiness/inventory 已有；自定义 Agent N:1 binding 尚未实现 |
| A3 Tool Bridge / Action Broker | 已完成（POC trust policy） | durable intent、单次 grant、journal、transport-loss lease、evidence/receipt reconciliation |
| A4 MCP / Skills | 已完成（POC） | 双 owner MCP/Skills、global/Runtime Profile、inventory reconciliation 与 live Tool/Skill resolution |
| A5 Recovery / release hardening | 已完成（外部 release gate 待执行） | restart/fault/package/update-signing 自动化完成；正式凭据与三平台 runner 不在仓库内 |
| RB-01 Runtime Box domain/local | 已完成 | Runtime Box contract、注册 descriptor、Local stable ID 和 keyed registry |
| RB-02 Persistence/routing | 已完成 | Box catalog、active CAS、Session/Run 归属、显式 Gateway 路由和 generation fence |
| RB-03 Ingress/pairing | 已完成 | Runtime-only ingress、Ed25519 配对认证、吊销、防重放、持久 generation 和限流 |
| RB-04 Remote service | 已完成 | 三平台普通用户服务、pair/run/status/doctor/unpair/uninstall 和单二进制资源 |
| RB-05 Dev Tunnel | 已完成 | Microsoft device-code、持久 Tunnel、精确端口/ACL、watchdog、修复、取消和重试 |
| RB-06 Switch/Projects/UI | 已完成 | active Box 过滤、Project lifecycle、Project Session/Chat、path health/relink、根 `AGENTS.md`、`project-root` Tool 和离线历史只读 |
| RB-07 Grants/recovery | 已完成 | durable Action/grant、Box journal、deadline lease、三阶段结果确认和 reset epoch |
| RB-08 MCP/Skills | 已完成 | Box private store、SecretStore、inventory sync、Runtime Profile、live validation 与 MCP grant bridge |
| RB-09 Hardening/release | 已完成（外部 release gate 待执行） | protocol/quota/diagnostics/fault matrix/signed package gates；真实 Tunnel 与正式平台签名由 release runner 验证 |

## 7. 开发数据策略

当前仍处于首次外部分发前。产品 DB 与 Provider registry 使用当前 schema；不兼容的旧开发数据可明确 reset，
不会保留已删除 runtime 的转换 adapter。Pi Session JSONL 是当前 conversation context 格式。
首次外部发布冻结 schema 后，升级必须遵守 backup、migration、rollback 和 fixture gate。

## 8. 下一优先级

1. 在有 Microsoft 登录状态的 release 环境执行真实 Dev Tunnel 探针。
2. 在 macOS/Windows/Linux runner 执行 stable package、正式签名/公证和安装级 E2E。
3. 在外部分发前完成 Provider vault Keychain adapter。
4. 后续版本实现 Noise 端到端握手和用户级命令审批。
