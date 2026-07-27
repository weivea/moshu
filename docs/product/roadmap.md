# 阶段路线图与验收

## 1. 路线图原则

- 每个阶段以可验证能力门槛结束，不以页面数量或日历时间结束。
- P0/P1/P2 是需求在其所属阶段内的优先级，不代表产品阶段编号。
- 阶段 1 优先完成用户确认的首个可用闭环。
- 自定义 Agent、MCP、Skills、知识库和 Canvas 可并行开发，但必须复用同一套权限和事件模型，并遵守 server/executor 各自唯一持久化所有者。
- 架构交付固定按 RPC/binary POC -> agents-server extraction -> Executor/Agent registry -> Tool Bridge/Action Broker -> MCP/Skills -> recovery/release hardening 推进。
- 团队规模、目标日期和发布渠道未确定，本路线图不提供工期承诺。

## 2. 阶段 0：技术底座与高风险验证

**目标：** 建立 Electrobun client、agents server、executor 三应用角色的可打包基础，并把 no-tools Ask
迁移到正确所有者。A0/A1 已完成，A2 只完成 executor 注册/readiness 基础。

### 2.1 架构交付主线

| 阶段 | 出口 |
| --- | --- |
| A0 RPC / binary POC | 两个 TypeScript + Bun compiled companion 可由 client 启停、注册、RPC、关闭和打包 |
| A1 agents-server extraction | dynamic Provider/auth、public Pi Ask、产品 DB/Pi Session JSONL 和 Run 状态迁入 server（已完成） |
| A2 Executor / Agent registry | 一个 local executor、多个 Agent、stable identity、注册 full capability sync、syncing/offline Run gate |
| A3 Tool Bridge / Action Broker | server Policy/approval/intent/grant，executor Tool/process tree，result 回到 server |
| A4 MCP / Skills | executor-owned persistence/secret/lifecycle，epoch/revision inventory reconciliation、routed UI、resource refs/prompt fetch |
| A5 recovery/release hardening | capped restart、重连对账、协作退出、故障矩阵和签名 package |

旧的 in-process/conditional-sidecar Go/No-Go 与 F0-16 不再适用。三角色是批准基线；compiled companion、
authenticated RPC 和 Provider registry 已实现，Agent/executor inventory registry 尚未实现。

### 2.2 范围

- Electrobun `1.18.1` + React + React Router + Vite 应用骨架；开发期使用 Bun，发行包使用框架内置 runtime。
- HeroUI 主题、浅色/深色、中英文框架和 Gravity Icon 包装层。
- Electrobun client、agents server、executor companion skeleton；WebSocket + versioned JSON RPC。
- 动态 loopback bootstrap、client/executor registration、stable ID、instance ID/generation 和注册后 full inventory sync。
- client 对两个 companion 的 cooperative shutdown、capped backoff 和 recovery UX。
- agents server 单写产品数据库/event，并用 public `SessionManager` 保存 Pi Session JSONL。
- Pi/Provider/Run 位于 agents server；Policy/Tool/进程树是后续 server/executor 边界。
- current host-backed local executor 已可注册和报告 readiness；Agent N:1 binding 尚未实现。
- runtime 动态 builtin/custom Provider、异步 auth attempt、模型刷新和 no-network test gate。
- server Policy/approval/Action intent -> one-time execution grant -> executor 文件/命令 Tool -> typed result POC。
- server Provider `SecretVaultCredentialStore` 的 app-owned permission-safe file adapter；Keychain 与 local
  executor `ExecutorSecretStore` 仍待 POC。
- sandbox `BrowserView` 的 RPC、本地文件和子资源默认断网 POC。
- 两个 Bun compiled companion 随 desktop 的签名、公证、Updater 和 packaged E2E POC。

### 2.3 出口条件

- package 可启动 client、agents server、executor；终端用户无需安装 Bun/Node。
- server 只绑定动态 loopback；未认证本机进程不能注册。
- `client <-> server <-> executor` 是唯一应用 RPC 拓扑，旧 generation 的消息被拒绝。
- Provider/Pi runtime 错误不影响其他 Run；server/executor 分别强退后状态可对账。
- WebView/client 无法直接读取 API Key、业务 DB、任意文件或 executor API。
- 未经 server Policy/approval/intent 和一次性 grant，executor 不执行。
- 一个带文件修改与审批的 Run 可完整持久化和回放，命令进程树可取消/清理。
- `SessionManager` 通过当前 schema、WAL、关闭重开和 server restart 测试。
- executor offline 时绑定 Agent 不能启动新 Run。
- executor 注册/重连后 full snapshot 原子替换完成前保持 syncing，绑定 Agent 不 runnable。
- MCP/Skill command 只有 owning executor 持久化后成功；server 产品数据无 recoverable config/content/credential copy。
- persisted epoch/revision、hint、60 秒 ±20% poll、delta/tombstone 和 gap/compaction/epoch/cursor snapshot fallback 可收敛；failed poll 不误删。
- local executor root/credential file 的 `0700`/`0600`、owner、atomic replace、symlink/no-follow gate 通过。
- Web Canvas 无法访问 Electrobun RPC、Bun/Node、任意本地文件或默认网络。
- 外部 E2E harness 可验证签名 package 中的两个 companion、Provider、Keychain 和 BrowserView；stable 产物不包含 test driver。
- 当前开发数据可明确 reset；本阶段不声称迁移旧 runtime 数据。

## 3. 阶段 1：核心 MVP

**目标：** 在至少完成 A0–A3 的三角色基础上，交付“配置模型 -> Chat/Project -> Ask/Plan/Agent -> 审批执行 -> Diff/撤销 -> 后台与恢复”的完整闭环；外部发布前完成 A5。

### 3.1 基础与设置

- macOS 安装包；无需登录。
- 中英双语、跟随系统、浅色/深色。
- public Pi runtime 动态枚举的 builtin Provider。
- custom endpoint 限 `openai-completions`、`openai-responses`、`anthropic-messages`、
  `google-generative-ai`。
- Provider 连接测试、模型列表/手工 ID、基础能力标签。
- Token 和估算费用；日/月预算提醒。

### 3.2 Chat

- 普通 Chat 与附件。
- Project 添加、Project Chat 和多个 Session。
- Ask、Plan、Agent。
- 流式 Markdown、代码、引用和用量。
- 计划、待办、文件、命令、Tool、子 Agent 和错误事件。
- 停止、重试、Session context restore 和 orphan Run 安全终结。
- 自动标题、搜索、重命名、归档、删除、Markdown/JSON 导出。

### 3.3 执行与安全

- Project 内文件读取、Patch 写入、创建、移动和删除。
- 受控命令执行、风险分类和审批。
- 每个实际 Tool 由 server 签发一次性 grant，executor 验证后执行。
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
- 面向用户的 MCP/Skills 管理页和公开功能；A4 backend gate 可提前完成但保持 feature flag 关闭。
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
- Agent 绑定已注册 executor；当前 desktop 默认一个 local executor，未来可从 registry 选择。
- MCP stdio、Streamable HTTP、SSE。
- MCP Bearer/API Key、OAuth 2.1、连接测试和配置导入。
- MCP Server/Tool 的全局、Project 和 Agent 作用域。
- Agent Skills 本地安装、验证、启停、冲突处理、导入导出。
- MCP config/credential/OAuth/lifecycle 和 Skill installations/immutable content 都由 selected executor 持久化；client UI command 经 server 校验后路由，offline 不伪装成功。
- server 只保存 assigned executor stable resource refs 与 replaceable/disposable redacted inventory cache；registration full sync、hint + jittered poll 和 delta/snapshot fallback 保持对账。
- cache 只含 ID/version/hash、Tool schema、health/capability 和 credential-configured boolean；Run start/restore 仍向 live executor 验证。
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
3. 选择一个模型，经 agents server Provider adapter 完成流式回复。
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
3. 用户允许后，server 持久化决定/intent 并签发一次性 grant；executor 验证后执行，结果回到 server 轨迹。
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
5. local executor 离线后，绑定 Agent 的新 Run 被阻止；恢复注册后才可继续启动。

### E2E-07：崩溃恢复

1. Run 完成部分文件操作后分别强制结束 agents server 与 executor。
2. client 按 capped backoff 监管重启；达到上限时停止 crash loop 并显示恢复 UX。
3. 重连后显示最后已持久化状态、已完成动作和 executor registry 状态。
4. 恢复不重复已成功的副作用工具；旧 instance/generation 的结果被拒绝。
5. 状态不确定的动作要求人工确认。

### E2E-08：自定义 Agent

1. 创建包含固定模型、assigned executor MCP/Skill stable refs、知识、权限和 executor binding 的 Agent。
2. 不兼容模型或缺失依赖在保存/运行前可见。
3. owning executor 生成可选 Skill bundle；导出不含密钥、本地绝对路径或 server-side Skill copy。
4. 在另一安装中先把资源导入 selected executor、再保存 Agent refs，修复依赖后可运行。

### E2E-09：MCP

1. 导入并连接一个 stdio MCP。
2. 通过 OAuth 连接一个远程 MCP。
3. 查看并按 Tool 启停。
4. client command 经 server 校验后由 selected executor 持久化并返回 epoch/revision；server 立即 read-own-write，offline/冲突/写入失败保持失败语义。
5. 丢失 `inventory.changed` 后，48–72 秒 poll 拉到 delta；revision gap/compaction/epoch reset/invalid cursor 自动 full snapshot。
6. executor offline 时 cache 标 stale 且不误删；reconnect full sync 完成前 Agent 不能运行。
7. server DB/backup/cache 无 recoverable config/credential/Skill body；MCP credential 只在 executor private store 与目标 connection/process 可达。
8. Run start live 验证 resource/version/hash/schema；有副作用 Tool 仍逐次使用 execution grant。

### E2E-10：Skill

1. 安装符合 Agent Skills 规范的本地 Skill。
2. 应用展示元数据、脚本和权限声明并通过校验。
3. executor 保存 immutable version/content/hash；Agent 只引用 assigned executor stable resource version。
4. server 按 ref 获取并校验 metadata/`SKILL.md`；missing/mismatch fail closed。
5. install/update/delete 产生 inventory revision/change/tombstone，server cache 收敛但不保存 Skill body。
6. resources/scripts 仍通过 executor，Skill 脚本遵守命令权限和 execution grant。

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
- inventory failed poll 不解释为 deletion；registration full sync 前 Agent 不 runnable，Run 不只信 cache。

### 8.2 性能

- UI 消费流式事件时保持可交互。
- 长日志采用虚拟列表与截断，不阻塞 WebView。
- 项目索引和知识索引可暂停，不占满前台交互资源。
- 并发上限对模型、命令和索引分别进行资源控制。

### 8.3 安全

- API Key、OAuth Token 和敏感环境变量不进入 WebView。
- 所有特权 RPC 有角色、stable ID、instance/generation、参数和权限校验。
- server 持久化 Policy/approval/intent；executor 拒绝过期、重复、篡改或目标不匹配的 grant。
- Provider/model credential 不进入 executor；MCP credential 只在 owning executor private store 与目标 connection/process 可达，不进入 server copy、query/UI/log/export、全局环境或无关 child/Agent。
- inventory hint/snapshot/delta/cache 只允许 redacted allowlist，不能包含 token、sensitive env、recoverable config 或完整 Skill content。
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
| Client/server/executor、RPC、registry、supervisor | A0–A2 | A3 + A5 完整 | A4 扩展 | 远程/跨平台 |
| 普通/Project Chat | POC | 完整 | 增强 | 协作 |
| Ask/Plan/Agent | POC | 完整 | 增强 | 自定义模式候选 |
| 文件/命令/审批/Allow all | POC | 完整 | 扩展到 MCP/Skill | 企业策略 |
| Provider | 1–2 家 | 六家 + 双兼容协议 | 本地模型 | 更多云 Provider |
| 并行/后台/恢复 | POC | 完整 | 子任务增强 | 定时任务 |
| Git | Diff POC | 状态/Diff/撤销 | 优化 | 分支/提交/Worktree/PR |
| 自定义 Agent | 数据模型 | 内置 Agent | 完整编辑与导入导出 | 编排/市场 |
| MCP | executor ownership/RPC/private-secret POC | 无正式 UI | routed UI + epoch/revision reconciliation + executor config/auth/lifecycle | Resources/Prompts/企业 |
| Skills | immutable executor store/ref POC | 无正式 UI | routed UI + inventory delta/tombstone + prompt fetch/resources/scripts | Git 更新/市场 |
| 知识库 | 索引 POC | 无 | 云端 + 本地 Embedding | 高级检索 |
| Canvas | 隔离 POC | 无正式功能 | 四类型完整闭环 | 插件/依赖 |
| Browser automation | 无 | 无 | 无 | 受控支持 |
| Windows/Linux | 无 | 无 | 技术准备 | 正式支持 |

## 10. 阶段冻结前待决策

以下事项不阻塞当前需求基线，但必须在对应阶段设计冻结前确定：

| 事项 | 最晚决策点 |
| --- | --- |
| 品牌视觉和第三方 NOTICE 策略（正式名称“墨枢”、MIT 许可证已确定） | 阶段 1 |
| Product DB / Pi Session JSONL reset、Pi `0.82.1` 升级及首次发布后的 migration 策略 | 阶段 0 |
| Electrobun 版本、实际 packaged runtime 和跨 runtime 升级策略 | 阶段 0 |
| Desktop bootstrap、本机注册认证和 protocol version policy | A0 |
| stable ID、instance/generation 和 executor lease 细节 | A0–A2 |
| execution grant 的 proof、TTL 和 single-use 存储实现 | A3 |
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
| remote/Docker/cloud executor 的配对、TLS、租户和 transport | 当前范围外，独立立项前 |
