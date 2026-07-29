# 安全、权限与本地数据

## 1. 安全目标

1. 模型、网页、Project 内容、MCP、Skills 和 Canvas 均按不可信输入处理。
2. 权限由应用和工具层执行，不依赖模型遵守提示词。
3. 用户在副作用发生前知道动作、目标和风险。
4. API Key、Token 和本机秘密不进入 WebView、日志、导出或模型上下文。
5. Agent 的每项副作用都可追溯；可撤销的动作提供撤销路径。

## 2. 威胁模型

| 来源 | 示例风险 |
| --- | --- |
| 模型输出 | 生成破坏性命令、错误路径或重复工具调用 |
| Prompt injection | 项目文件或网页诱导 Agent 泄露秘密、扩大权限 |
| MCP | Tool 描述欺骗、远程副作用、恶意返回内容 |
| Skill | 脚本执行、依赖安装、隐藏网络请求 |
| Canvas | XSS、资源滥用、通过 Electrobun RPC 或 URL Scheme 访问本地能力 |
| Provider/Embedding | 内容发送到错误 Endpoint 或不符合用户预期的数据区域 |
| WebView | XSS 后调用高权限 RPC |
| 本机 RPC | 其他本机进程扫描动态端口、伪造 client/Runtime Box、重放注册材料或旧 generation 消息 |
| agents server | Prompt/Tool 输入绕过 Policy、错误签发 grant、产品 DB 或 Pi Session JSONL 损坏 |
| Runtime Box | 伪造/重放 grant、越权路径/命令、临时凭证泄漏、进程树或扩展资源泄漏 |
| 崩溃恢复 | 不确定的工具调用被重复执行 |

## 3. 三应用角色安全基线

- Electrobun client、agents server、Runtime Box 都是受信应用代码；角色拆分提供职责和故障隔离，不等于完整 OS sandbox。
- 主 React WebView 只注册最小 Electrobun RPC；client 校验 View ID、窗口角色、origin、参数和 capability。
- 应用协议只有 `client <-> agents server <-> Runtime Box`。client 不直连 Runtime Box，Runtime Box 不提供 DB、Provider、Policy 或 approval API。
- desktop agents server 只绑定动态 loopback，但 loopback 本身不可信；连接仍需一次性 bootstrap、角色认证、版本和 method allowlist。
- `clientId`/`runtimeBoxId` 是稳定身份；每次启动/注册使用新的 `instanceId` 和 `generation`。旧实例的消息、result 和 grant 必须被拒绝。
- agents server 独占产品 DB/Pi Session JSONL、Provider、Agent runtime；未来也独占 Policy/approval 和
  Action intent/result。
- Runtime Box 独占实际 Tool、MCP/Skill、取消和进程树；它不能打开业务 DB 或自行授予权限。
- WebSocket/RPC 的传输保护不代替身份、Schema、capability、参数摘要、状态和授权校验。
- Canvas 使用 `sandbox: true` 的独立 `BrowserView`/partition，不注册应用 RPC；sandbox 只减少应用桥接面，不保证子资源断网。
- 两个 TypeScript + Bun companion 必须随 desktop 同一 release 打包、签名和更新，不能运行时下载未知 binary。

## 4. 模式、授权与动作权限

server 先根据 Agent mode、持久 Policy、Session grant 和 Action 参数做决定；需要时让 client 展示审批并持久化用户决定。随后 server 写入 Action intent，签发绑定 action、参数摘要、scope、目标 Runtime Box instance/generation、短 TTL 和 single-use nonce 的 execution grant。

Runtime Box 在实际执行前验证 grant。Allow all 只改变 server 的审批决定，不能跳过 grant，也不能让 Runtime Box自行放宽路径、命令或网络约束。

| 动作 | Ask | Plan（批准前） | Agent 默认 | Agent + Allow all |
| --- | --- | --- | --- | --- |
| 读取会话附件 | 允许 | 允许 | 允许 | 允许 |
| 读取 Project 常规文件 | 允许 | 允许 | 允许 | 允许 |
| 读取敏感文件 | 确认/拒绝 | 确认/拒绝 | 确认/拒绝 | 仍需确认 |
| 修改 Project 文件 | 禁止 | 禁止 | 按策略审批 | 允许低/中风险 |
| 删除/移动大量文件 | 禁止 | 禁止 | 强制确认 | 仍需确认 |
| 运行只读安全命令 | 禁止 | 禁止 | 按策略审批或允许 | 允许 |
| 运行构建/测试 | 禁止 | 禁止 | 默认确认 | 允许 |
| 安装依赖 | 禁止 | 禁止 | 强制确认 | 高风险仍确认 |
| Project 外访问 | 禁止 | 禁止 | 单次强制确认或拒绝 | 仍需确认 |
| 有副作用 MCP | 禁止 | 禁止 | 按 Tool 风险审批 | 高风险仍确认 |
| Git push/发布/发送消息 | 禁止 | 禁止 | 强制确认 | 仍需确认 |

“允许”仅表示无需弹窗，仍受路径、命令、网络和秘密策略限制。

## 5. Allow all

### 5.1 生效范围

- 仅当前 Session。
- 仅对开启后的新动作生效，不追溯批准待处理动作。
- 切换关闭立即恢复默认策略。
- 应用重启、Session 复制或 Project 重新授权后自动关闭。
- 有效性绑定当前 client instance/generation；stable `clientId` 不会让 grant 跨重启延续。
- 状态在输入框和会话头持续可见。

### 5.2 开启确认

确认页说明：

- Agent 可在当前 Project 内修改文件并运行低/中风险命令。
- 可能产生 API、网络和计算费用。
- 不会绕过高风险确认、Project 边界和秘密保护。
- 用户可随时关闭或停止任务。

### 5.3 不能绕过

- 访问 Project 外目录。
- 读取密钥、系统凭证、SSH Key、浏览器 Profile 等敏感目标。
- 权限提升和系统配置。
- 大规模删除、磁盘/分区操作。
- Git push、包发布、部署、付款、发送消息等外部不可逆动作。
- 未授权域名的数据上传。
- 安装或运行未审查 Skill/MCP。

## 6. 文件权限

### 6.1 默认边界

- Project Agent 的普通文件权限限制在 Project 根目录；server 在 grant 中绑定 scope，Runtime Box 在执行时重新校验。
- Runtime Box 使用真实路径解析和符号链接检查，阻止通过 `..`、软链接或路径大小写绕过。
- 内部工作文件、会话附件、Memory 和 Skills 使用独立虚拟路径，不与项目内容混放。
- 默认保护 `.env*`、密钥文件、凭证目录和应用自己的安全存储。
- 文件权限规则采用明确的 allow/deny 顺序，并在 UI 中显示最终结果。

### 6.2 修改与冲突

- 写入前校验基线哈希。
- 使用原子写入，避免半文件状态。
- 外部修改冲突时停止并显示 Diff。
- 大文件、二进制和不可逆格式修改要求额外确认。
- 删除优先进入可恢复区；无法恢复时明确提示。

### 6.3 Pi runtime 边界

当前 Pi `AgentSession` 使用 `noTools: "all"`，extensions、Skills、prompt templates、themes、context files、
default tools 和 TUI 全部禁用；意外 Tool activity 直接失败。未来文件/Shell 能力不会直接开放 Pi 默认 Tool，
而是通过 Moshu-owned Policy、Action、grant 和 Runtime Box 强制执行。

## 7. 命令执行

### 7.1 强制策略层

不得将原始 `LocalShellBackend.execute` 直接暴露给模型。命令由 agents server 形成 Action、完成审批并签发 grant，再由 Runtime Box 的命令执行器：

- 固定工作目录并记录规范化路径。
- 使用最小环境变量，不继承 client/agents server 全量环境。
- 解析可执行文件、参数、管道、重定向和子命令。
- 执行风险分类和审批。
- 设置超时、输出上限和进程树终止。
- 记录退出码、耗时和安全截断日志。
- 限制并发和后台子进程。
- 拒绝过期、重复、篡改或目标 instance/generation 不匹配的 grant。

### 7.2 风险等级

| 等级 | 示例 | 默认策略 |
| --- | --- | --- |
| 低 | `git status`、`git diff`、项目内只读查询 | 可配置自动允许 |
| 中 | 构建、测试、格式化、项目内生成文件 | 审批；Allow all 可放行 |
| 高 | 安装依赖、网络上传、删除、改权限、启动长期服务 | 始终确认 |
| 禁止/特殊授权 | `sudo`、磁盘工具、系统安全设置、读取系统凭证 | 默认拒绝或专用流程 |

字符串黑名单不能作为唯一判断方式；策略应结合可执行文件、参数、工作目录、文件影响和网络目标。

### 7.3 环境与秘密

- PATH 使用受控值。
- 用户可按 Project 添加环境变量；敏感值写入安全存储。
- 审批卡显示变量名，不显示敏感值。
- 模型只知道可用变量名和用途，不获得值。
- 命令输出进入模型前进行秘密模式扫描和截断。

## 8. MCP 与 Skills 安全

### 8.1 MCP

- 安装/添加时展示 Server 来源、Transport、命令/域名和 Tool 清单。
- selected Runtime Box 是 MCP config、credential/token/OAuth state、lifecycle 和 Tool inventory 的唯一 source of truth。
- client 配置 command 经 agents server 做 client/Runtime Box identity 与授权检查后路由；只有 Runtime Box 持久化成功才返回 redacted result/inventory epoch/revision，offline 或失败不能伪装成功。
- agents server 只可保存 Agent stable resource ref 与 replaceable、non-authoritative、disposable redacted inventory cache，不保存 recoverable config、credential、OAuth state 或 Runtime Box secret locator。
- 每次 Runtime Box 注册/重连先 full snapshot，成功前保持 syncing；运行期由 revision/category-only hint 和 60 秒 ±20% jitter poll 触发增量拉取。
- gap、compaction、epoch reset 或 invalid cursor 回退 full snapshot。offline/failed poll 只把 cache 标 stale，不得解释为 resource deletion。
- inventory allowlist 只有 stable ID、version/hash、MCP Tool schema、health/capability 和 `credentialConfigured` boolean；token、sensitive env、recoverable config、完整 `SKILL.md`/resources 一律禁止。
- 每个 Tool 有只读、写入、外部副作用、未知四类风险标签。
- 用户或应用可覆盖风险标签，但保留来源。
- MCP 返回内容不能授予新 Tool 或改变权限。
- OAuth Scope 在授权前展示；Token 按 Server 隔离。
- MCP credential 可由 owning Runtime Box 从自己的 `ExecutorSecretStore` 加载，并在目标 connection/process 生命周期内保留 runtime reference；不进入全局环境或无关 child/Agent。
- revocation、expiry 或 MCP shutdown 必须关闭对应连接/进程并释放 runtime reference；不宣称 JavaScript 可可靠清零 string memory。
- MCP Tool 仍使用普通 Action/execution grant；连接已建立不等于预授权。

### 8.2 Skills

- 安装前扫描脚本和可执行文件清单。
- Runtime Box 独占 Skill installation、immutable versions/content/hash、metadata、resources 和 scripts；server 只保存 assigned Runtime Box stable resource ref。
- server 构建/恢复 Agent 时按 ref 获取 metadata/`SKILL.md` 并验证 owner/version/hash；offline、missing 或 mismatch 时 fail closed。
- fetched Skill content 只用于内存 prompt assembly，不进入 server DB/Pi Session JSONL/Run snapshot/event/
  backup/diagnostic/export。
- Skill install/update/delete 只以 redacted descriptor/change/tombstone 同步；inventory 不复制 Skill body。
- 依赖、网络和工具要求可见。
- Skill 的 `allowed-tools` 不构成应用授权。
- 更新后内容哈希变化时重新提示权限与脚本差异。
- 未签名或来源不明不等于禁止安装，但必须明确风险。
- Skill resources/scripts 通过 Runtime Box grant 使用，不能形成服务器或 client 的本地执行旁路。

## 9. 密钥与凭证

- agents server 的 `SecretVaultCredentialStore` 只保存 Provider/model credential；当前 app-owned file adapter
  使用 parent `0700`、file `0600`、跨进程 lock、fresh read/apply、atomic rename 和 fsync。
- Provider/model credential 只在 agents server 按 Run scope 读取，永不发送 Runtime Box。
- MCP credential/token/OAuth state 只由 owning Runtime Box 的 `ExecutorSecretStore` 保存和读取；server 无 MCP Secret Ref 或 recoverable copy。
- local desktop 首个 `ExecutorSecretStore` 可使用 Runtime Box-private files；future Runtime Box 可使用 Keychain、Docker Secret 或 cloud secret manager。
- stdio 只把 credential 注入目标 MCP child 的最小环境，不修改 Runtime Box 全局环境。
- HTTP MCP 可在可行时按 request 注入 credential，但不是所有 transport 的统一要求。
- credential 不通过 query RPC、UI、prompt、日志、诊断或 export 暴露，也不传给无关 child process 或 Agent。
- `inventory.changed`、snapshot、delta、cache 和 mutation result 都不能携带 credential value、sensitive env 或 Runtime Box secret locator。
- UI 只显示掩码和最后更新时间，不支持读取回完整值。
- 剪贴板复制凭证需要用户主动操作并提示清理风险。
- 日志、错误、崩溃报告和导出统一经过脱敏。
- 删除 Provider/MCP 时提示是否同时删除关联凭证。
- 当前 file adapter 不防同账户 malware、root 或 disk backup；Keychain adapter 是外部分发前工作，切换时
  必须显式 migration/gate，不能静默降低保护。

## 10. 本地数据

### 10.1 默认存储

| 数据 | 默认位置/策略 |
| --- | --- |
| Session、Run、消息投影、事件 | agents server 产品数据库 |
| Conversation context | `agentDataDirectory/sessions` 下的 Pi `SessionManager` JSONL |
| Provider/model config、Agent definitions/versions、resource refs | agents server 本地业务数据；resource ref 不含 Runtime Box config/content |
| redacted Runtime Box inventory cache | agents server disposable projection；offline 时标 stale，可删除后从 Runtime Box 重建 |
| MCP config/inventory、Skill metadata/versions | Runtime Box-owned DB |
| Skill immutable content/resources/scripts | Runtime Box-private Skills 目录 |
| 密钥与 Token | Provider/model credential 在 server `SecretVaultCredentialStore`；未来 MCP credential/OAuth 在 Runtime Box `ExecutorSecretStore` |
| Canvas 与版本 | 本地应用数据目录 |
| 知识原文元数据、切分和向量 | 本地索引目录 |
| Project 文件 | 保持在原目录，不自动复制 |
| 日志 | 本地轮转、脱敏、有限保留 |

local desktop Runtime Box data root 使用 `0700`，credential file 使用 `0600`；写入做 owner check、atomic replacement，拒绝 symlink，并在平台支持时 no-follow。它能防止其他普通本机用户读取，但不能防止同账户 malware、root、disk snapshot 或 backup。用户应把磁盘加密和备份保护作为独立控制。

### 10.2 数据外发

外发可能包括：

- 聊天与所选上下文发送到模型 Provider。
- 文档片段发送到用户选择的云端 Embedding Provider。
- 搜索词发送到搜索 Provider。
- Tool 参数发送到远程 MCP。
- URL 发送给目标站点。

首次使用相关能力时说明目的地；执行轨迹应能查看本轮涉及的外部服务。

### 10.3 导出与删除

- Markdown 导出面向阅读，JSON 导出保留结构化记录。
- 默认移除密钥、认证 Header、敏感变量值和内部绝对路径。
- 用户可删除单个 Session、Project 记录、Canvas、知识库或全部应用数据。
- 删除 Project 记录不删除 Project 目录。
- 卸载应用前无法保证自动清除所有 server/Runtime Box secret backend 项，设置页提供按 Runtime Box 路由的“删除全部安全凭证”，并明确 offline Runtime Box 无法确认删除。

## 11. 日志、审计与遥测

- 本地审计记录包含权限决策、工具调用、目标、结果和来源 Run。
- 日志默认不记录完整提示词和文件内容。
- 调试日志需用户主动开启，并提示可能包含敏感上下文。
- 遥测默认关闭，必须 opt-in。
- 遥测只发送产品事件和性能指标，不发送消息、文件、命令、Canvas 或知识内容。
- 崩溃报告上传前允许用户查看摘要。

## 12. 发布安全

- macOS 包必须签名、公证并验证更新签名。
- Electrobun client、agents-server binary、Runtime Box binary、public Pi `0.82.1` bundle 和更新 metadata 必须来自
  同一受信 release；未知版本/protocol 组合时 fail closed。
- 更新必须整体切换三个角色，不能留下新 client 配旧 companion 的部分更新。
- 自动更新失败不能阻止用户访问本地数据。
- 依赖锁文件、SBOM 和漏洞扫描纳入发布流程。
- Provider、MCP 和 Skill 的远程内容不得拥有应用更新权限。

## 13. 功能需求索引

| ID | 需求 | 优先级 |
| --- | --- | --- |
| SEC-001 | WebView 无 Bun、文件、命令和密钥直接访问 | P0 |
| SEC-002 | Ask/Plan/Agent 权限在工具层强制执行 | P0 |
| SEC-003 | Allow all 仅当前 Session 且重启关闭 | P0 |
| SEC-004 | 高风险操作不能被 Allow all 绕过 | P0 |
| SEC-005 | Shell 使用独立策略层和最小环境 | P0 |
| SEC-006 | 文件路径防穿越、符号链接绕过和并发覆盖 | P0 |
| SEC-007 | 所有副作用关联 Run、审批和结果 | P0 |
| SEC-008 | Provider credential 只在 server SecretVault；MCP credential 只在 Runtime Box `ExecutorSecretStore`，均不进入 WebView/query/log/export | P0 |
| SEC-009 | Canvas、MCP、Skill 和网页内容按不可信处理 | P0 |
| SEC-010 | 遥测默认关闭，日志和导出默认脱敏 | P0 |
| SEC-011 | stable ID、instance/generation、角色认证、取消、durable interrupt 和进程树清理可验证 | P0 |
| SEC-012 | Canvas 默认子资源断网在真实网络测试中成立；否则不得执行任意 Web 内容 | P0 |
| SEC-013 | server 先持久化 Policy/approval/intent，Runtime Box 只执行有效的一次性 grant | P0 |
| SEC-014 | server 不保存 recoverable MCP/Skill config/content/credential；Runtime Box private root 的 mode/owner/atomic/no-follow 与诚实威胁边界可验证 | P0 |
| SEC-015 | client 对两个 companion 使用 cooperative shutdown、capped backoff 和明确 recovery UX | P0 |
| SEC-016 | MCP/Skill command 只有 owning Runtime Box 持久化后成功；Agent resource missing/mismatch 时 fail closed | P0 |
| SEC-017 | registration full sync、epoch/revision delta/tombstone、hint + jittered poll 和 snapshot fallback 不泄密、不误删；Run 仍 live 验证 | P0 |
