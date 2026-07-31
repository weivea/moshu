# 质量与发布计划

> 本文验证批准的三应用角色目标架构。
> 当前 Pi Ask、compiled companion 与三进程 smoke 已形成 A0/A1 gate；Tool/MCP/Skill gate 尚未实现。

## 1. 质量目标

| 目标 | 发布要求 |
| --- | --- |
| 所有权 | server 产品状态与 Runtime Box-owned MCP/Skill config/secret/content 没有双 owner 或 recoverable shadow copy |
| 协议 | 版本、角色、身份、Schema、错误、取消、背压和重连行为确定 |
| 可恢复 | client、server、Runtime Box 或 Tool 异常后不盲目重复副作用 |
| 授权 | server 先持久化 Policy/approval；Runtime Box 只执行有效一次性 grant |
| Secret | Provider/model credential 不进入 Runtime Box；MCP credential 只在显式 owner private store 与目标 connection/process 可达 |
| 性能 | 三个应用角色和 3 个并发 Run 下 UI、RPC、取消保持可交互 |
| 可发布 | 两个 Bun companion 随 Electrobun client 正确构建、签名、公证和更新 |

## 2. 测试分层

| 层 | 运行频率 | 重点 |
| --- | --- | --- |
| Unit | 每次提交 | 状态机、Policy、grant、identity、路径、脱敏 |
| Protocol contract | 每个 PR | JSON RPC、Schema、版本、role allowlist、错误、背压 |
| Role integration | 每个 PR | server DB/runtime、Runtime Box Tool/MCP/Skill、client adapter |
| Three-role E2E | 每个 PR 核心集，nightly 全集 | 启动、注册、Run、Action、重连、退出 |
| Package smoke | 主分支/nightly/release | compiled companions、权限、签名、无系统 Bun |
| Security/chaos | nightly/发布前 | 未授权连接、旧实例、grant、kill points、Secret |
| Live compatibility | nightly/发布前 | Provider API 和发布支持的远程 MCP |

测试必须区分：

- **当前实现测试**：证明现有 Ask slice 没有回归。
- **目标架构测试**：必须真的启动独立 agents server/Runtime Box，并经 WebSocket RPC 通过。

禁止用 in-memory adapter 或同进程 service call 给跨角色 gate 记为通过。

## 3. A0–A5 质量门

| Gate | 必须通过 |
| --- | --- |
| QG-A0 RPC/binary | 两 companion compile/package、dynamic loopback、registration、version、role allowlist、shutdown/restart cap |
| QG-A1 server extraction | Pi Ask parity、server 单写产品 DB/Pi Session JSONL、Provider/runtime 不在 client、event replay |
| QG-A2 registry | stable ID、instance/generation、Agent N:1、注册 full capability sync、syncing/offline Run gate |
| QG-A3 execution | policy/approval/intent/grant 顺序、grant negative suite、Tool process tree、Action recovery |
| QG-A4 MCP/Skills | Runtime Box-owned persistence、epoch/revision delta reconciliation、routed UI、stable resource ref、private secret store、逐 Tool grant、fail-closed restore |
| QG-A5 release | kill matrix、capped recovery UX、cooperative quit、signed/notarized package、Updater atomicity |

前一 gate 未通过时，后一阶段可以做 isolated spike，但不得把产品能力默认开启。

## 4. Unit 测试

### 4.1 Identity 与 registry

- stable `clientId`/`runtimeBoxId` 序列化和恢复。
- 每次启动/注册生成新 `instanceId` 与递增 generation。
- 低 generation、同 generation 不同 instance、旧 connection event 被拒绝。
- heartbeat/lease 的 online、offline、superseded 转换。
- persisted `inventoryEpoch`/monotonic revision 的 restart 保留和 store reset 换 epoch。
- syncing -> online、offline -> stale，以及 full snapshot 未完成时 Agent 不 runnable。
- 多 Agent 绑定同 Runtime Box；删除/停用 Runtime Box 的引用规则。
- offline Runtime Box 的 `runs.start` 返回 `RUNTIME_BOX_OFFLINE`。

### 4.2 Protocol

- method/role allowlist。
- protocol version negotiation、无交集和 downgrade 拒绝。
- request ID/idempotency key 去重。
- frame/payload/in-flight/event buffer 上限。
- timeout、cancel、late response 和 disconnect。
- `AppError` 保持失败语义。

### 4.3 Policy 与 grant

- Ask/Plan/Agent 有效 Tool 集。
- Allow all 可放行与不可放行矩阵。
- Policy、approval、Action intent 的合法状态转换。
- grant target、TTL、nonce、args digest、scope digest、capability 和 generation。
- duplicate/tampered/expired/revoked/wrong-Runtime Box grant 全部拒绝。
- grant consumed 与 Tool start 的原子边界。

### 4.4 数据与恢复

- Run、Tool、Action、invocation 状态机。
- event sequence、duplicate 和缺口识别。
- bounded inventory change log、连续 revision、deletion tombstone、compaction 和 invalid cursor。
- pure/idempotent/conditional/non-idempotent 恢复分类。
- Secret、Header、路径、命令输出和诊断脱敏。

## 5. Protocol Contract Suite

### 5.1 Bootstrap 与注册

- server 绑定 `127.0.0.1`/`::1` 动态端口，不监听公网接口。
- role-bound bootstrap token 不出现在 argv、普通日志或固定配置。
- token 过期、重放、client/Runtime Box 互换和未知 binary 被拒绝。
- 未注册连接不能调用业务 method。
- client/Runtime Box 注册返回协商版本、server instance 和 lease。
- Runtime Box 注册/重连后 server 立即 `inventory.getSnapshot`；原子 cache replace 前 registry 保持 syncing。

### 5.2 Client <-> agents server

- 每个领域 method 的请求/响应 Schema。
- client 无通用 request forwarder、Runtime Box method、文件、Shell、Secret 或 DB API。
- Run start 快速 accepted；event 可按 `afterSeq` 补齐和去重。
- WebView reload/client reconnect 不影响 server Run 所有权。
- registry list 只返回允许 client 查看且已脱敏的信息。

### 5.3 agents server <-> Runtime Box

- Runtime Box 只暴露 register/heartbeat/inventory/resource-validation/invocation/MCP/Skill/shutdown 方法。
- server 不能用 RPC 执行未建 Action/grant 的任意 Shell。
- invocation event/result 必须匹配当前 Runtime Box instance/generation 和 invocation ID。
- Runtime Box reconnect 使用 reconcile，不重复报告或执行已终态 invocation。
- `inventory.changed` Schema 只允许 epoch/revision/category；snapshot/change page/cursor 有大小、epoch、连续性和分页上限。
- 慢/恶意 Runtime Box 不能无限占用 server memory 或 event queue。

## 6. Role Integration

### 6.1 agents server

- 新产品 DB 建库、当前 schema、WAL、关闭重开和 backup；Pi Session JSONL restore。
- SessionCatalog/RunJournal、Provider 设置、stream、cancel 和 error parity。
- public `SessionManager.create`、稳定 ID、restore、dispose 和 app-owned path contract。
- event 先落库再发布；RunJournal 与 Pi conversation context 的职责清晰。
- server 不导入 client UI 或 Runtime Box implementation。
- 当前开发期不兼容 schema 进入明确 reset，不运行伪迁移。

### 6.2 Runtime Box

- 不打开产品 DB/Pi Session JSONL，不持有 Provider adapter。
- 文件路径、软链接、TOCTOU、hash CAS、原子替换和撤销。
- 命令 cwd、最小 env、timeout、输出截断、进程组和取消。
- Runtime Box shutdown 清理所有受管进程树。
- invocation registry 在终态/取消/断线对账后回收。

### 6.3 client

- companion 启动顺序、健康状态和 cooperative shutdown。
- 两个角色各自独立 restart budget 与 capped backoff。
- 达到 cap 后停止重启并展示 recovery UX。
- client 不打开产品 DB/Pi Session JSONL，不调用 Provider/Pi。
- WebView 只通过 client adapter 访问 server。

## 7. Action Broker 与 Tool Bridge

### 7.1 正向场景

1. Agent 提议 Action。
2. server 持久化 Policy decision。
3. 需要时持久化 approval request/decision。
4. server 持久化 intent。
5. server 签发 grant。
6. Runtime Box 验证并执行。
7. server 持久化 result，才向 Agent 返回 Tool result。

测试对每一步断言 DB、event、RPC 和角色日志的 correlation ID。

### 7.2 Kill points

对文件、命令、Git、MCP 和 Skill script 自动注入：

1. Policy 决定前后。
2. Approval 决定前后。
3. Action intent 前后。
4. grant 签发前后。
5. Runtime Box 消费 grant 前后。
6. 副作用完成后、result 发送前。
7. result 到达 server 后、持久化前。
8. result 持久化后、Agent 收到前。

### 7.3 预期

| Action | 恢复预期 |
| --- | --- |
| 读文件/搜索 | 可重新签发 grant 后重试 |
| 固定内容写入 | 根据 before/after hash 验证 |
| Patch/move | 状态不匹配进入 conflict |
| 命令 | 无法确认时 `outcome_unknown`，不自动重跑 |
| 远程 MCP 副作用 | `outcome_unknown`，人工验证 |
| Skill script | 按实际命令幂等类别处理，不因“来自 Skill”放宽 |

## 8. MCP 与 Skill

### 8.1 MCP

- Runtime Box DB 是 config/lifecycle/inventory 的 source of truth；restart 后从自身数据恢复，不依赖 server snapshot。
- client command 经 server identity/auth 校验并路由；offline、expected-version conflict、disk failure 不返回 success，成功带 redacted result 与 inventory epoch/revision。
- mutation result 触发 server 立即拉取到该 revision；失败时 cache 明确 stale，不伪造 read-own-write descriptor。
- server 产品 DB、Pi Session JSONL、backup 和 inventory snapshot 不含 recoverable config、credential/OAuth
  state 或 Runtime Box secret locator。
- stdio start/stop/restart cap、进程树和最小 env；credential 只注入目标 MCP child，不进入 Runtime Box 全局环境或无关 child。
- HTTP/SSE disconnect、Schema hash 变化和 typed error。
- Tool invocation 必须持有效 grant；MCP ready 不等于预授权。
- Provider/model credential 从不发送 Runtime Box。
- MCP credential/token/OAuth state 由 Runtime Box `ExecutorSecretStore` 持久化；query/result/UI/prompt/log/diagnostic/export 都不能读取原值或 locator。
- revocation、expiry 或 MCP shutdown 会关闭对应资源并释放 runtime reference；不宣称 JavaScript 可可靠清零 string memory。
- HTTP MCP 可按 request 注入 credential，但 suite 不把它设为所有 transport 的统一要求。

### 8.2 Skills

- Runtime Box 安装、immutable version、压缩包穿越、frontmatter、内容 hash、atomic publish 和卸载。
- Agent resource ref 必须属于 assigned Runtime Box；server 只能按 stable ID/version/hash 获取 metadata/`SKILL.md`，不能直接读 Skill 目录。
- server inventory snapshot 不能恢复 Skill；产品 DB/Pi Session JSONL/Run snapshot/backup/event/diagnostic/export
  不含 fetched `SKILL.md` 或其他 Skill content。
- descriptor missing/hash mismatch/wrong owner 使 Agent build/restore fail closed。
- references/assets/scripts 通过 Runtime Box；script 必须重新经过 Policy/grant。
- Runtime Box offline 或 Skill 缺失时 Agent start 明确失败，不静默省略 Skill。

### 8.3 inventory reconciliation

- 每个 connection/registration/reconnect 都先 full snapshot；即使 cached epoch/revision 相同也不能跳过。
- Runtime Box transaction 同时更新权威数据、递增 persisted revision、追加 change/tombstone；commit 后才发 hint。
- hint debounce 合并 burst，但最终拉到最高 hinted revision；hint 丢失由 60 秒 ±20% jitter（48–72 秒）poll 补齐。
- gap、compacted history、epoch change/reset、invalid/expired cursor 和非连续 page 都触发 full snapshot atomic replacement。
- offline/timeout/malformed response 只把 cache 标 stale；不得删除任何 resource。删除只来自有效 tombstone 或成功 snapshot。
- cache allowlist 只有 stable ID、version/hash、Tool schema、health、capability 和 `credentialConfigured` boolean；禁止 token、sensitive env、recoverable config、完整 `SKILL.md`/resources 和 secret locator。
- reconnect full sync 前 Agent 不 runnable；Run start/restore 仍对 live Runtime Box 验证 resource/version/hash/schema，poll success 不算授权。

### 8.4 local Runtime Box storage

- private root 新建/重开权限为 `0700`，credential file 为 `0600`；错误 owner/mode 阻止读取。
- 写入使用同目录临时文件、fsync/适用的 durability step 和 atomic replace。
- symlink 被拒绝；平台支持时 open 使用 no-follow，TOCTOU suite 覆盖交换攻击。
- 测试和产品文案明确：这些措施防其他普通本机用户，不防同账户 malware、root、disk snapshot 或 backup。
- `ExecutorSecretStore` contract suite 可复用于 Keychain、Docker Secret 和 cloud secret manager adapter。

## 9. Secret 泄露验证

测试使用唯一 canary，扫描：

- WebView/client state 和 client-server RPC。
- server-Runtime Box RPC、grant、invocation result、inventory hint/snapshot/change page。
- server 产品 DB、Pi Session JSONL、reset backup 和 inventory cache。
- client/server/Runtime Box 日志、崩溃报告和诊断包。
- server command/audit/event payload、client state 和命令环境快照。
- Session/Agent/Canvas 导出。

Provider/model canary 只允许存在于测试 server `SecretVault`，进入 Runtime Box 即失败。MCP canary 只允许存在于 owning Runtime Box 的测试 `ExecutorSecretStore`、目标 connection/process 内存和最小 child environment；出现在 server 持久化/backup/inventory hint/snapshot/change/cache、普通 Runtime Box DB 字段、日志、模型/UI、query/result、diagnostic/export、全局环境或无关 child 即阻止发布。inventory 只允许 redacted `credentialConfigured` boolean。revocation、expiry 或 MCP shutdown 后验证资源关闭且 runtime reference 不再可用；不声称 JavaScript 能可靠清零 string memory。

## 10. 安全测试

### 10.1 本机 RPC

- 端口扫描后伪造 client/Runtime Box。
- bootstrap token 重放、窃取后延迟使用和角色互换。
- stable ID 冲突、generation 回退、旧 connection 注入。
- request/event 洪泛、超大 JSON、深层对象和慢消费者。
- client 尝试调用 Runtime Box-only method；Runtime Box 尝试调用 DB/Provider/approval method。

### 10.2 Grant

- 修改 action、args、scope、Runtime Box、instance、generation、expiry 或 nonce。
- 同一 grant 并发提交。
- Runtime Box restart 后重放旧 grant。
- server connection 被替换后使用旧 grant。
- approval edit 后复用编辑前 grant。

### 10.3 文件、命令与扩展

- 路径穿越、软链接、TOCTOU、大小写和特殊文件。
- Shell 注入、权限提升、后台 daemon、fork bomb 和大量输出。
- MCP Tool Schema/结果注入、stdio env 泄露和 OAuth scope。
- 伪造/回退 epoch/revision、gap、重复/乱序 tombstone、invalid cursor、超大 change page 和 hint flood。
- MCP credential 不进入 server copy、query/UI/prompt/log/diagnostic/export、Runtime Box 全局环境、无关 child process 或其他 Agent；teardown 条件全部覆盖。
- Runtime Box root/file mode、owner、atomic replacement、symlink/no-follow 和同账户/root/snapshot 威胁边界全部覆盖。
- 已认证 MCP connection 上每次 Tool 缺少/复用/篡改 grant 都被拒绝。
- Skill 压缩包穿越、脚本、资源路径和更新 hash 变化。
- Prompt injection 不能改变 Policy 或 grant。

### 10.4 WebView 与 Canvas

- WebView XSS 后仍无 server bootstrap、Secret 或 Runtime Box API。
- Canvas 无应用 RPC、本地文件、未授权网络、下载或系统权限。
- Canvas 需要本机能力时必须走 client -> server Policy -> Runtime Box grant。

## 11. 故障矩阵

| 故障 | 必须验证 |
| --- | --- |
| WebView reload | 只重建订阅；Run 不丢失 |
| client connection drop | server Run 继续；重连按 cursor 补齐 |
| client process exit | supervisor 执行 cooperative shutdown；超时升级 |
| agents server kill | client capped restart；产品 DB/Pi Session JSONL 恢复；Runtime Box 重注册并 full inventory sync |
| Runtime Box kill | cache stale；新 Run 被拒绝；活动 invocation 对账；重连 full sync 前不 runnable |
| MCP process kill | Runtime Box inventory 更新；按 Runtime Box-owned config 受限重启 |
| hint 丢失/change log compact | 48–72 秒 poll 发现 revision；gap/compaction 改用 full snapshot，不误删 |
| Tool child process hang | cancel/timeout 清理完整进程树 |
| sleep/wake | lease/reconnect/generation 和 timeout 重算 |
| network loss | Provider/MCP 错误保持失败，可重试范围明确 |
| disk full/DB error | server 不发布未持久化成功；进入 recovery UX |

每种 companion 故障都要覆盖一次 crash 和连续 crash 达 cap 两种情况。

## 12. Three-role Desktop E2E

### 12.1 核心 PR 集

- client 启动两个 companion 并显示 online。
- 保存 fake Provider，经 server 完成普通 Chat。
- client reload/reconnect 后恢复同 Session 与 event cursor。
- registry 显示一个 local Runtime Box 和多个 Agent。
- 停止 Runtime Box 后 cache 标 stale、相关 Agent 无法启动新 Run；重启 full sync 完成后才恢复可用。
- 一次低风险 Tool 经 intent/grant/Runtime Box/result 完成。
- client 正常退出后 companion 和 Tool 子进程均退出。

### 12.2 Nightly

- 3 个并发 Session 和队列。
- 分别 kill server、Runtime Box、client/WebView。
- grant 全部 negative cases。
- Action kill-point matrix。
- MCP/Skill fake fixtures、inventory hint/drop/gap/epoch-reset/read-own-write matrix（A4 后）。
- restart cap/recovery UX。
- signed/package artifact 的同一流程。

### 12.3 测试驱动

- 测试构建可启用最小本地 driver，但必须有随机启动凭证和编译时排除。
- stable package 扫描确认无 test method、固定 token、调试 listener。
- release smoke 优先使用正式入口和公开诊断，不依赖测试后门。

## 13. Provider、Pi Session 与产品回归

- public Pi compatibility gate 覆盖 imports、headless no-tools Session、offline fake stream、restore、abort 和
  compiled binary。
- Provider 覆盖动态 builtin 枚举、四种 custom API、选中 Provider 刷新、auth attempt 全部 prompt/event、
  credential redaction、logout 和 invalid `ThinkingLevel`。
- Provider 调用只在 server 测试进程中发生；client/Runtime Box 测试中出现 Provider Key 即失败。
- Pi Ask integration 覆盖 unexpected Tool fail-closed、stream/usage、cancel classification、same-session fence、
  different-session concurrency、restore、dispose 和 deletion containment。
- 产品测试继续覆盖 orphan finalization、event replay、cleanup outbox retry/backoff、Session restart/read/delete
  和 secret-free Run snapshot。

## 14. 性能预算

基线设备为 Apple Silicon、16 GB RAM、release build。

| 指标 | 初始预算 |
| --- | --- |
| 冷启动到窗口可交互 | p95 <= 3 秒 |
| 两 companion 注册 online | p95 <= 2 秒，另记录 DB 恢复耗时 |
| client-server 本地 RPC | p95 <= 50 ms（不含业务处理） |
| server-Runtime Box 本地 RPC | p95 <= 50 ms（不含 Tool） |
| 流式 delta 到 UI | p95 <= 100 ms（不含 Provider 网络） |
| 3 Run 并发 RPC ping | p95 <= 100 ms |
| Runtime Box cancel 到进程树退出 | p95 <= 2 秒；顽固进程有升级终止 |
| 100 次 reconnect | registry/socket/subscription 无线性增长 |
| 空闲内存 | 分角色记录并设置回归预算，不用合计掩盖单角色泄漏 |

达到 restart cap、无限 event queue 或未受控子进程均为正确性问题，不能只调整性能阈值。

## 15. CI 流水线

### Pull Request

```text
bun install --frozen-lockfile
  -> format/lint/typecheck
  -> unit
  -> protocol contract
  -> server/Runtime Box/client role integration
  -> provider fake contract
  -> WebView tests
  -> core three-role E2E
  -> dependency/license checks
```

### Default branch / Nightly

```text
all PR checks
  -> full three-role E2E
  -> kill-point and restart-cap chaos
  -> security / secret canary
  -> performance smoke
  -> compile/package companions
  -> package smoke
  -> live Provider/MCP smoke
```

### Release

```text
clean tagged commit
  -> reproducible install and all gates
  -> compile client + agents-server + Runtime Box
  -> verify protocol/build matrix
  -> sign and notarize complete app
  -> install/package three-role smoke
  -> verify cooperative quit and updater atomicity
  -> SBOM/checksums/NOTICE
  -> manual approval
```

## 16. 打包、签名与更新

- 两个 companion 与 client 来自同一 release；不能独立下载或混用未知版本。
- package 必须保留 companion 可执行权限，并验证目标架构、动态库和签名链。
- terminal user 无 Bun/Node 时所有 E2E 仍通过。
- 更新要么整体切换 client/server/Runtime Box，要么保持旧完整版本；不允许部分 binary 更新。
- 有活动 Run/Action 时不强制更新退出。
- stable package 不含源 Secret、bootstrap token、测试 driver 或开发 endpoint。

当前自动化实现：

- `moshuReleaseVersion` 是 desktop/agents-server/Runtime Box 的共同版本源；package 额外保存两个
  companion 的 SHA-256 和 companion/process-RPC/Runtime protocol matrix，READY version 不一致即拒绝。
- packaged launch 使用不可解析系统 Bun/Node 的 PATH，仍须完成启动、readiness 和 cooperative shutdown。
- `bun run package:release` 在 stable 前检查永久 app ID、HTTPS update origin、Ed25519 key pair 和平台凭据。
- macOS stable 开启 Developer ID、notarization、staple、Gatekeeper 和 DMG gate；Windows stable 对 bundle
  内全部 EXE/DLL 执行 Authenticode SHA-256、RFC 3161 timestamp 和 verify，并在最终 ZIP 生成后重新封装
  已签名的 `Setup.exe`。
- stable 产物的 update JSON、完整 archive、patch/installer（存在时）由 Ed25519 signed manifest 统一绑定；
  缺件、hash 变化、错误 key 或 signature 均阻止发布。
- 真实 Tunnel 使用 `MOSHU_LIVE_RUNTIME_BASE_URL=... bun run smoke:live-tunnel`；正式证书、Microsoft 账号和
  三平台 runner 是外部 release 条件，仓库不会保存这些 Secret，也不能把本地 ad-hoc canary 当成通过。

## 17. 数据 reset 与未来 migration

当前重构阶段：

- 不要求旧 runtime 数据或 Provider 开发配置迁移。
- 测试只要求“不兼容时明确 reset、旧数据不被误读、当前 schema 可 backup/restore”。
- 文案必须告诉开发用户 reset 会删除哪些本地数据。

首次外部发布冻结 schema 后，正式 release gate 再要求每个已发布版本的 migration、rollback 和 fixture。不得把当前 reset 例外推广到已发布用户数据。

## 18. 本地可观察性

每条结构化日志包含：

- `role`、binary/app/protocol version。
- stable ID、instance ID、generation、connection ID。
- session/run/tool/action/invocation/grant correlation（存在时）。
- error code 和安全状态，不含 Secret/raw Tool args。

诊断包汇总 client/server/Runtime Box 日志、registry snapshot、restart counters、DB integrity、binary signatures 和 redaction report。用户主动导出，默认不含 prompt、文件内容或凭证。

## 19. 发布阻塞条件

任一项成立即阻止对应阶段发布：

- client 可直连 Runtime Box，或任一角色存在通用 RPC forwarder。
- server 监听非 loopback，或未认证本机进程可注册。
- 旧 instance/generation 的 event/result/grant 被接受。
- Runtime Box offline 时仍能启动绑定 Agent 的 Run。
- Runtime Box 未验证 grant 即执行，或重复/篡改 grant 成功。
- Runtime Box 写产品 DB/Pi Session JSONL，或 client 持有 Provider/Agent runtime。
- non-idempotent Action 在 unknown outcome 后自动重放。
- Provider/model credential 进入 Runtime Box，或 MCP credential 出现在 server copy、普通 DB 字段、query/UI/prompt/log/diagnostic/export、全局环境或无关 child/Agent。
- server 保存 recoverable MCP/Skill config/content，或 Runtime Box offline/持久化失败时配置 command 返回成功。
- Runtime Box 注册/重连未 full sync 即 runnable，或 inventory gap/compaction/epoch/cursor 异常未回退 snapshot。
- failed poll/offline 被解释为 deletion，或 cache 含 credential/sensitive env/recoverable config/完整 Skill content。
- Run start/restore 仅信 cache、未 live 验证 resource/version/hash/schema，或 inventory 状态被当作 Tool 授权。
- local Runtime Box private root/credential file mode、owner、atomic replacement 或 symlink/no-follow gate 失败。
- companion crash loop 无上限，或正常退出遗留受管进程树。
- package 缺少/无法启动 companion，依赖系统 Bun/Node，或三者版本不兼容。
- 签名、公证、Updater 原子性或 stable test-backdoor scan 失败。
- MCP/Skill 启用阶段存在绕过 Policy/grant 的执行路径。

## 20. 发布检查表

### 架构

- [ ] 对应 A0–A5 gate 通过。
- [ ] 角色 ownership assertion 和依赖扫描通过。
- [ ] stable/instance/generation、registry、full inventory sync 和 syncing/offline UX 验收完成。

### 安全与恢复

- [ ] grant negative suite、Secret canary 和 Action kill matrix 通过。
- [ ] server/Runtime Box kill、restart cap、reconnect/reconcile 通过。
- [ ] hint debounce、60 秒 ±20% poll、delta/tombstone、snapshot fallback 和 mutation read-own-write matrix 通过。
- [ ] cooperative shutdown 无遗留进程树。

### Package

- [ ] client、agents-server、Runtime Box 版本和 protocol matrix 一致。
- [ ] 签名、公证、Gatekeeper、无系统 runtime smoke 通过。
- [ ] 整体更新、失败保留旧版本和回滚 metadata 验证完成。

### 数据

- [ ] 当前开发期 reset 行为明确且已测试；没有迁移旧数据的错误承诺。
- [ ] 当前 schema backup/restore、DB integrity 和 Pi Session contract 通过。

## 21. Mobile stack Layer 5 发布加固（iOS App）

Mobile stack Layer 5（final）交付 iOS 发布加固；**硬边界：无云 Push Relay、无 APNs remote/silent push、无
VoIP/background-processing 伪保活、设备不落业务数据、Desktop 必须在线、suspended/terminated 不保证通知。**

### 21.1 版本一致性（单一来源）

- `apps/mobile/release.config.json` 是版本单一来源（`marketingVersion` / `buildNumber`）。
- `bun run --cwd apps/mobile release:version` 把它 fan-out 到 Xcode `MARKETING_VERSION` /
  `CURRENT_PROJECT_VERSION` 与 `apps/mobile/package.json`；`release:version -- --check` 只校验、drift 即非零退出。
- **不提交** `DEVELOPMENT_TEAM` / 证书 / provisioning profile；签名身份构建期提供。

### 21.2 Release gate（fail-closed 静态门）

`bun run --cwd apps/mobile release:gate`（`scripts/release-gate.ts`）在构建前强制：

- 无 remote UI：Capacitor 无 `server.url`（App 只加载本地 `dist`）。
- 无 desktop/node 泄漏：mobile `src` 无 node builtins / `Buffer` / `ws` import。
- 无 secret 样本：`src`/`ios` 无 PEM 私钥 / GitHub / Slack / AWS token。
- 无宽泛 ATS：Info.plist 无 `NSAllowsArbitraryLoads*`。
- 无违规 background mode：无 `remote-notification` / `voip` / `audio` / `fetch` / `processing`。
- 无 APNs / Local Network：无 `aps-environment` entitlement、无 `NSLocalNetworkUsageDescription` / `NSBonjourServices`。
- 无 baked 签名：pbxproj 无 `DEVELOPMENT_TEAM` / `PROVISIONING_PROFILE_SPECIFIER`。
- version 一致（§21.1）、contracts↔canonical vectors 同步、`dist`↔iOS `public` 同步（需先 `build` + `cap:copy`/`cap:sync`）。

### 21.3 Privacy manifest / required-reason API

- `apps/mobile/ios/App/App/PrivacyInfo.xcprivacy`：`NSPrivacyTracking=false`、`NSPrivacyCollectedDataTypes` 空、
  仅声明实际使用的 required-reason API `NSPrivacyAccessedAPICategoryUserDefaults`（reason `CA92.1`，Capacitor 运行时/
  官方插件读写自身配置）。无其他类别（file timestamp / boot time / disk space / keyboard）。
- Info.plist 仅 `NSCameraUsageDescription`（二维码），无宽泛 ATS、无 Local Network/Bonjour、无未使用的 background modes。

### 21.4 Export compliance（发布方确认）

- App 使用 CryptoKit **Ed25519**（设备认证签名）+ **TLS**（系统 WSS）。这属于标准加密用途。
- App Store 加密问卷 / 可能的豁免需 **发布方确认**；工程 **不武断** 写 `ITSAppUsesNonExemptEncryption`。若填写，必须有
  明确依据并允许构建期 override。不误报“无加密”。

### 21.5 App Store reviewer 路径（Desktop 在线依赖）

- App 需连接**用户自己在线的 Desktop**（无生产云账号/无假成功模式）。
- 审核提交应附**临时 review 流程**：审核期由提交方运行一台在线 Desktop，开启 Remote Access，生成配对二维码给审核设备扫码，
  或提供等价的安全 demo（录屏 + 明确说明 Desktop 在线是硬依赖）。**不引入生产云账号或伪造 connected 模式。**

### 21.6 Dev vs Release bundle id

- 开发 bundle id `dev.moshu.mobile`（committed）。发布 build 期 override `PRODUCT_BUNDLE_IDENTIFIER`
  （xcconfig 或 `xcodebuild PRODUCT_BUNDLE_IDENTIFIER=...`），不把 App Store 身份写进源码。

### 21.7 验证命令（本层）

- `bun run --cwd apps/mobile test`（79 Vitest）、`typecheck`、`build`、`cap:copy`（或 `cap:sync`，best-effort）。
- `swift test`（`apps/mobile/native/MoshuMobile`，67 XCTest）。
- server 侧隔离测试：`bun test packages/contracts packages/database` 与
  `apps/agents-server/src/mobile-attention-projection.test.ts` / `mobile-ingress-smoke.test.ts` /
  `mobile-ingress-auth.test.ts` / `mobile-ingress-generation-fence.test.ts`。
- `bun run --cwd apps/mobile release:gate`。
- iOS simulator `xcodebuild test/build`（禁签名）与真实 Dev Tunnel probe（`scripts/probe-live-dev-tunnel.ts`）为
  **opt-in**、记录命令、不要求 CI secret。

### 21.8 发布检查表（Mobile Layer 5）

- [ ] `release:version -- --check` 通过（版本一致）。
- [ ] `release:gate` 全绿（remote UI / node-leak / secret / ATS / background mode / APNs / signing / vectors / bundle sync）。
- [ ] `PrivacyInfo.xcprivacy` 与实际依赖一致；Info.plist 无多余权限/background mode。
- [ ] Export compliance 问卷由发布方确认；未武断写 `ITSAppUsesNonExemptEncryption`。
- [ ] reviewer 路径（在线 Desktop + 配对二维码或安全 demo）已备妥；无生产云账号/假成功。
- [ ] 79 Vitest + 67 Swift XCTest + server attention smoke + database attention repository 通过。
- [ ] 真机签名、真实 Dev Tunnel probe、App Store 提交为发布方人工步骤（记录在案）。
