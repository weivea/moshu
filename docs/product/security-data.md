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
| DeepAgentService | Prompt/Tool 输入绕过 Policy、过期 callback、资源泄漏或未持久 interrupt |
| 崩溃恢复 | 不确定的工具调用被重复执行 |

## 3. Electrobun 安全基线

- 主 React WebView 仅注册最小、类型化、按 capability 拆分的 Electrobun RPC；安全字段使用 Zod 做运行时校验。
- Host 校验 View ID、窗口角色、origin、参数、Session 和权限，不信任 WebView 传入的路径或授权结论。
- RPC 的加密传输不等于授权；通用 method 转发、文件、Shell、Secret 和任意 URL 打开能力不得暴露给 WebView。
- WebView 不持有 Provider/MCP 凭证明文；应用页面使用严格 CSP，不执行消息或 Markdown 中的脚本。
- 禁止任意导航、新窗口、下载和不受控外部协议。
- Deep Agents JS 默认直接运行于 Electrobun application worker；它与 Host 是同一受信 runtime，不是 OS 沙箱，真正的副作用边界仍是 Policy Engine 和 Action Broker。
- DeepAgentService 使用显式 `threadId/runId/executionId`、Zod、AbortController、durable interrupt 和 dispose 生命周期；不能依赖 WebView 存活或内存 Promise 保持审批。
- sidecar 不是默认安全边界；只有隔离 ADR 通过时才增加进程协议与监管，而且仍不能绕过 Action Broker。
- Canvas 使用 `sandbox: true` 的独立 `BrowserView`/partition，不注册应用 RPC；sandbox 只减少应用桥接面，不保证子资源断网。
- Electrobun 尚无 Electron Fuses、`safeStorage`、`webRequest` 或框架级权限请求处理器的等价基线，相关安全能力必须由应用实现和测试，不能沿用 Electron 假设。

## 4. 模式与动作权限

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

- Project Agent 的普通文件权限限制在 Project 根目录。
- 使用真实路径解析和符号链接检查，阻止通过 `..`、软链接或路径大小写绕过。
- 内部工作文件、会话附件、Memory 和 Skills 使用独立虚拟路径，不与项目内容混放。
- 默认保护 `.env*`、密钥文件、凭证目录和应用自己的安全存储。
- 文件权限规则采用明确的 allow/deny 顺序，并在 UI 中显示最终结果。

### 6.2 修改与冲突

- 写入前校验基线哈希。
- 使用原子写入，避免半文件状态。
- 外部修改冲突时停止并显示 Diff。
- 大文件、二进制和不可逆格式修改要求额外确认。
- 删除优先进入可恢复区；无法恢复时明确提示。

### 6.3 Deep Agents 权限边界

Deep Agents 的 filesystem permissions 可约束内建文件工具，但不能约束任意 Shell 命令。产品不能把文件 permission rules 当作完整沙箱。

## 7. 命令执行

### 7.1 强制策略层

不得将原始 `LocalShellBackend.execute` 直接暴露给模型。命令执行器必须：

- 固定工作目录并记录规范化路径。
- 使用最小环境变量，默认不继承 Application Host 全量环境。
- 解析可执行文件、参数、管道、重定向和子命令。
- 执行风险分类和审批。
- 设置超时、输出上限和进程树终止。
- 记录退出码、耗时和安全截断日志。
- 限制并发和后台子进程。

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
- 每个 Tool 有只读、写入、外部副作用、未知四类风险标签。
- 用户或应用可覆盖风险标签，但保留来源。
- MCP 返回内容不能授予新 Tool 或改变权限。
- OAuth Scope 在授权前展示；Token 按 Server 隔离。

### 8.2 Skills

- 安装前扫描脚本和可执行文件清单。
- 依赖、网络和工具要求可见。
- Skill 的 `allowed-tools` 不构成应用授权。
- 更新后内容哈希变化时重新提示权限与脚本差异。
- 未签名或来源不明不等于禁止安装，但必须明确风险。

## 9. 密钥与凭证

- 使用 `SecretVault` Port 保存 Provider Key、MCP Token、OAuth Token 和敏感环境变量；首发 macOS adapter 通过经审查的 Bun FFI/native bridge 调用 Keychain。
- 本地数据库只保存密钥引用和非敏感元数据。
- 密钥仅在 Application Host/DeepAgentService 内按 Run scope 读取。
- UI 只显示掩码和最后更新时间，不支持读取回完整值。
- 剪贴板复制凭证需要用户主动操作并提示清理风险。
- 日志、错误、崩溃报告和导出统一经过脱敏。
- 删除 Provider/MCP 时提示是否同时删除关联凭证。
- Keychain 或 adapter 不可用时连接进入 blocked 并显示明确错误，不回退到明文或应用自制弱加密。

## 10. 本地数据

### 10.1 默认存储

| 数据 | 默认位置/策略 |
| --- | --- |
| Session、消息、事件 | 本地数据库 |
| Run checkpoint | 本地持久化 checkpointer |
| Agent/MCP/Skill 配置 | 本地应用数据目录 |
| 密钥与 Token | 系统安全存储 |
| Canvas 与版本 | 本地应用数据目录 |
| 知识原文元数据、切分和向量 | 本地索引目录 |
| Project 文件 | 保持在原目录，不自动复制 |
| 日志 | 本地轮转、脱敏、有限保留 |

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
- 卸载应用前无法保证自动清除 Keychain 项，设置页提供“删除全部安全凭证”。

## 11. 日志、审计与遥测

- 本地审计记录包含权限决策、工具调用、目标、结果和来源 Run。
- 日志默认不记录完整提示词和文件内容。
- 调试日志需用户主动开启，并提示可能包含敏感上下文。
- 遥测默认关闭，必须 opt-in。
- 遥测只发送产品事件和性能指标，不发送消息、文件、命令、Canvas 或知识内容。
- 崩溃报告上传前允许用户查看摘要。

## 12. 发布安全

- macOS 包必须签名、公证并验证更新签名。
- Electrobun Host、原生 launcher、packaged application runtime、Deep Agents bundle、Keychain bridge 和更新 metadata 必须来自同一受信 release；未知 runtime 组合时 fail closed。
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
| SEC-008 | 凭证只存于系统安全存储且不进入 WebView | P0 |
| SEC-009 | Canvas、MCP、Skill 和网页内容按不可信处理 | P0 |
| SEC-010 | 遥测默认关闭，日志和导出默认脱敏 | P0 |
| SEC-011 | DeepAgentService 的 execution identity、取消、durable interrupt、dispose 和命令进程树清理可验证 | P0 |
| SEC-012 | Canvas 默认子资源断网在真实网络测试中成立；否则不得执行任意 Web 内容 | P0 |
| SEC-013 | 仅隔离 ADR 触发时才允许 sidecar，且协议、Secret、checkpoint 和签名门禁完整 | P0 |
