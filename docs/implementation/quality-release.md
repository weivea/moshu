# 质量与发布计划

> 本文验证批准的三应用角色目标架构。
> 当前单进程 Ask 测试是迁移输入，不能替代 client/agents-server/executor 的目标 gate。

## 1. 质量目标

| 目标 | 发布要求 |
| --- | --- |
| 所有权 | server 产品状态与 executor-owned MCP/Skill config/secret/content 没有双 owner 或 recoverable shadow copy |
| 协议 | 版本、角色、身份、Schema、错误、取消、背压和重连行为确定 |
| 可恢复 | client、server、executor 或 Tool 异常后不盲目重复副作用 |
| 授权 | server 先持久化 Policy/approval；executor 只执行有效一次性 grant |
| Secret | Provider/model credential 不进入 executor；MCP credential 只在 executor private store 与目标 connection/process 可达 |
| 性能 | 三个应用角色和 3 个并发 Run 下 UI、RPC、取消保持可交互 |
| 可发布 | 两个 Bun companion 随 Electrobun client 正确构建、签名、公证和更新 |

## 2. 测试分层

| 层 | 运行频率 | 重点 |
| --- | --- | --- |
| Unit | 每次提交 | 状态机、Policy、grant、identity、路径、脱敏 |
| Protocol contract | 每个 PR | JSON RPC、Schema、版本、role allowlist、错误、背压 |
| Role integration | 每个 PR | server DB/runtime、executor Tool/MCP/Skill、client adapter |
| Three-role E2E | 每个 PR 核心集，nightly 全集 | 启动、注册、Run、Action、重连、退出 |
| Package smoke | 主分支/nightly/release | compiled companions、权限、签名、无系统 Bun |
| Security/chaos | nightly/发布前 | 未授权连接、旧实例、grant、kill points、Secret |
| Live compatibility | nightly/发布前 | Provider API 和发布支持的远程 MCP |

测试必须区分：

- **当前实现测试**：证明现有 Ask slice 没有回归。
- **目标架构测试**：必须真的启动独立 agents server/executor，并经 WebSocket RPC 通过。

禁止用 in-memory adapter 或同进程 service call 给跨角色 gate 记为通过。

## 3. A0–A5 质量门

| Gate | 必须通过 |
| --- | --- |
| QG-A0 RPC/binary | 两 companion compile/package、dynamic loopback、registration、version、role allowlist、shutdown/restart cap |
| QG-A1 server extraction | Ask parity、server 单写 DB/checkpoint、Provider/graph 不在 client、event replay |
| QG-A2 registry | stable ID、instance/generation、Agent N:1、注册 full capability sync、syncing/offline Run gate |
| QG-A3 execution | policy/approval/intent/grant 顺序、grant negative suite、Tool process tree、Action recovery |
| QG-A4 MCP/Skills | executor-owned persistence、epoch/revision delta reconciliation、routed UI、stable resource ref、private secret store、逐 Tool grant、fail-closed restore |
| QG-A5 release | kill matrix、capped recovery UX、cooperative quit、signed/notarized package、Updater atomicity |

前一 gate 未通过时，后一阶段可以做 isolated spike，但不得把产品能力默认开启。

## 4. Unit 测试

### 4.1 Identity 与 registry

- stable `clientId`/`executorId` 序列化和恢复。
- 每次启动/注册生成新 `instanceId` 与递增 generation。
- 低 generation、同 generation 不同 instance、旧 connection event 被拒绝。
- heartbeat/lease 的 online、offline、superseded 转换。
- persisted `inventoryEpoch`/monotonic revision 的 restart 保留和 store reset 换 epoch。
- syncing -> online、offline -> stale，以及 full snapshot 未完成时 Agent 不 runnable。
- 多 Agent 绑定同 executor；删除/停用 executor 的引用规则。
- offline executor 的 `runs.start` 返回 `EXECUTOR_OFFLINE`。

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
- duplicate/tampered/expired/revoked/wrong-executor grant 全部拒绝。
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
- token 过期、重放、client/executor 互换和未知 binary 被拒绝。
- 未注册连接不能调用业务 method。
- client/executor 注册返回协商版本、server instance 和 lease。
- executor 注册/重连后 server 立即 `inventory.getSnapshot`；原子 cache replace 前 registry 保持 syncing。

### 5.2 Client <-> agents server

- 每个领域 method 的请求/响应 Schema。
- client 无通用 request forwarder、executor method、文件、Shell、Secret 或 DB API。
- Run start 快速 accepted；event 可按 `afterSeq` 补齐和去重。
- WebView reload/client reconnect 不影响 server Run 所有权。
- registry list 只返回允许 client 查看且已脱敏的信息。

### 5.3 agents server <-> executor

- executor 只暴露 register/heartbeat/inventory/resource-validation/invocation/MCP/Skill/shutdown 方法。
- server 不能用 RPC 执行未建 Action/grant 的任意 Shell。
- invocation event/result 必须匹配当前 executor instance/generation 和 invocation ID。
- executor reconnect 使用 reconcile，不重复报告或执行已终态 invocation。
- `inventory.changed` Schema 只允许 epoch/revision/category；snapshot/change page/cursor 有大小、epoch、连续性和分页上限。
- 慢/恶意 executor 不能无限占用 server memory 或 event queue。

## 6. Role Integration

### 6.1 agents server

- 新业务 DB/checkpoint 建库、当前 schema、WAL、关闭重开和 backup。
- SessionCatalog/RunJournal、Provider 设置、stream、cancel 和 error parity。
- `BunSqliteSaver` 的 `getTuple/list/put/putWrites/deleteThread` contract。
- event 先落库再发布；checkpoint/Event 偏差可识别。
- server 不导入 client UI 或 executor implementation。
- 当前开发期不兼容 schema 进入明确 reset，不运行伪迁移。

### 6.2 executor

- 不打开业务 DB/checkpoint，不持有 Provider adapter。
- 文件路径、软链接、TOCTOU、hash CAS、原子替换和撤销。
- 命令 cwd、最小 env、timeout、输出截断、进程组和取消。
- executor shutdown 清理所有受管进程树。
- invocation registry 在终态/取消/断线对账后回收。

### 6.3 client

- companion 启动顺序、健康状态和 cooperative shutdown。
- 两个角色各自独立 restart budget 与 capped backoff。
- 达到 cap 后停止重启并展示 recovery UX。
- client 不打开业务 DB/checkpoint，不调用 Provider/Deep Agents。
- WebView 只通过 client adapter 访问 server。

## 7. Action Broker 与 Tool Bridge

### 7.1 正向场景

1. Agent 提议 Action。
2. server 持久化 Policy decision。
3. 需要时持久化 approval request/decision。
4. server 持久化 intent。
5. server 签发 grant。
6. executor 验证并执行。
7. server 持久化 result，才向 Agent 返回 Tool result。

测试对每一步断言 DB、event、RPC 和角色日志的 correlation ID。

### 7.2 Kill points

对文件、命令、Git、MCP 和 Skill script 自动注入：

1. Policy 决定前后。
2. Approval 决定前后。
3. Action intent 前后。
4. grant 签发前后。
5. executor 消费 grant 前后。
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

- executor DB 是 config/lifecycle/inventory 的 source of truth；restart 后从自身数据恢复，不依赖 server snapshot。
- client command 经 server identity/auth 校验并路由；offline、expected-version conflict、disk failure 不返回 success，成功带 redacted result 与 inventory epoch/revision。
- mutation result 触发 server 立即拉取到该 revision；失败时 cache 明确 stale，不伪造 read-own-write descriptor。
- server 产品 DB、checkpoint、backup 和 inventory snapshot 不含 recoverable config、credential/OAuth state 或 executor secret locator。
- stdio start/stop/restart cap、进程树和最小 env；credential 只注入目标 MCP child，不进入 executor 全局环境或无关 child。
- HTTP/SSE disconnect、Schema hash 变化和 typed error。
- Tool invocation 必须持有效 grant；MCP ready 不等于预授权。
- Provider/model credential 从不发送 executor。
- MCP credential/token/OAuth state 由 executor `ExecutorSecretStore` 持久化；query/result/UI/prompt/log/diagnostic/export 都不能读取原值或 locator。
- revocation、expiry 或 MCP shutdown 会关闭对应资源并释放 runtime reference；不宣称 JavaScript 可可靠清零 string memory。
- HTTP MCP 可按 request 注入 credential，但 suite 不把它设为所有 transport 的统一要求。

### 8.2 Skills

- executor 安装、immutable version、压缩包穿越、frontmatter、内容 hash、atomic publish 和卸载。
- Agent resource ref 必须属于 assigned executor；server 只能按 stable ID/version/hash 获取 metadata/`SKILL.md`，不能直接读 Skill 目录。
- server inventory snapshot 不能恢复 Skill；产品 DB/checkpoint/Run snapshot/backup/event/diagnostic/export 不含 fetched `SKILL.md` 或其他 Skill content。
- descriptor missing/hash mismatch/wrong owner 使 Agent build/restore fail closed。
- references/assets/scripts 通过 executor；script 必须重新经过 Policy/grant。
- executor offline 或 Skill 缺失时 Agent start 明确失败，不静默省略 Skill。

### 8.3 inventory reconciliation

- 每个 connection/registration/reconnect 都先 full snapshot；即使 cached epoch/revision 相同也不能跳过。
- executor transaction 同时更新权威数据、递增 persisted revision、追加 change/tombstone；commit 后才发 hint。
- hint debounce 合并 burst，但最终拉到最高 hinted revision；hint 丢失由 60 秒 ±20% jitter（48–72 秒）poll 补齐。
- gap、compacted history、epoch change/reset、invalid/expired cursor 和非连续 page 都触发 full snapshot atomic replacement。
- offline/timeout/malformed response 只把 cache 标 stale；不得删除任何 resource。删除只来自有效 tombstone 或成功 snapshot。
- cache allowlist 只有 stable ID、version/hash、Tool schema、health、capability 和 `credentialConfigured` boolean；禁止 token、sensitive env、recoverable config、完整 `SKILL.md`/resources 和 secret locator。
- reconnect full sync 前 Agent 不 runnable；Run start/restore 仍对 live executor 验证 resource/version/hash/schema，poll success 不算授权。

### 8.4 local executor storage

- private root 新建/重开权限为 `0700`，credential file 为 `0600`；错误 owner/mode 阻止读取。
- 写入使用同目录临时文件、fsync/适用的 durability step 和 atomic replace。
- symlink 被拒绝；平台支持时 open 使用 no-follow，TOCTOU suite 覆盖交换攻击。
- 测试和产品文案明确：这些措施防其他普通本机用户，不防同账户 malware、root、disk snapshot 或 backup。
- `ExecutorSecretStore` contract suite 可复用于 Keychain、Docker Secret 和 cloud secret manager adapter。

## 9. Secret 泄露验证

测试使用唯一 canary，扫描：

- WebView/client state 和 client-server RPC。
- server-executor RPC、grant、invocation result、inventory hint/snapshot/change page。
- server business DB、checkpoint、reset backup 和 inventory cache。
- client/server/executor 日志、崩溃报告和诊断包。
- server command/audit/event payload、client state 和命令环境快照。
- Session/Agent/Canvas 导出。

Provider/model canary 只允许存在于测试 server `SecretVault`，进入 executor 即失败。MCP canary 只允许存在于 owning executor 的测试 `ExecutorSecretStore`、目标 connection/process 内存和最小 child environment；出现在 server 持久化/backup/inventory hint/snapshot/change/cache、普通 executor DB 字段、日志、模型/UI、query/result、diagnostic/export、全局环境或无关 child 即阻止发布。inventory 只允许 redacted `credentialConfigured` boolean。revocation、expiry 或 MCP shutdown 后验证资源关闭且 runtime reference 不再可用；不声称 JavaScript 能可靠清零 string memory。

## 10. 安全测试

### 10.1 本机 RPC

- 端口扫描后伪造 client/executor。
- bootstrap token 重放、窃取后延迟使用和角色互换。
- stable ID 冲突、generation 回退、旧 connection 注入。
- request/event 洪泛、超大 JSON、深层对象和慢消费者。
- client 尝试调用 executor-only method；executor 尝试调用 DB/Provider/approval method。

### 10.2 Grant

- 修改 action、args、scope、executor、instance、generation、expiry 或 nonce。
- 同一 grant 并发提交。
- executor restart 后重放旧 grant。
- server connection 被替换后使用旧 grant。
- approval edit 后复用编辑前 grant。

### 10.3 文件、命令与扩展

- 路径穿越、软链接、TOCTOU、大小写和特殊文件。
- Shell 注入、权限提升、后台 daemon、fork bomb 和大量输出。
- MCP Tool Schema/结果注入、stdio env 泄露和 OAuth scope。
- 伪造/回退 epoch/revision、gap、重复/乱序 tombstone、invalid cursor、超大 change page 和 hint flood。
- MCP credential 不进入 server copy、query/UI/prompt/log/diagnostic/export、executor 全局环境、无关 child process 或其他 Agent；teardown 条件全部覆盖。
- executor root/file mode、owner、atomic replacement、symlink/no-follow 和同账户/root/snapshot 威胁边界全部覆盖。
- 已认证 MCP connection 上每次 Tool 缺少/复用/篡改 grant 都被拒绝。
- Skill 压缩包穿越、脚本、资源路径和更新 hash 变化。
- Prompt injection 不能改变 Policy 或 grant。

### 10.4 WebView 与 Canvas

- WebView XSS 后仍无 server bootstrap、Secret 或 executor API。
- Canvas 无应用 RPC、本地文件、未授权网络、下载或系统权限。
- Canvas 需要本机能力时必须走 client -> server Policy -> executor grant。

## 11. 故障矩阵

| 故障 | 必须验证 |
| --- | --- |
| WebView reload | 只重建订阅；Run 不丢失 |
| client connection drop | server Run 继续；重连按 cursor 补齐 |
| client process exit | supervisor 执行 cooperative shutdown；超时升级 |
| agents server kill | client capped restart；DB/checkpoint 恢复；executor 重注册并 full inventory sync |
| executor kill | cache stale；新 Run 被拒绝；活动 invocation 对账；重连 full sync 前不 runnable |
| MCP process kill | executor inventory 更新；按 executor-owned config 受限重启 |
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
- registry 显示一个 local executor 和多个 Agent。
- 停止 executor 后 cache 标 stale、相关 Agent 无法启动新 Run；重启 full sync 完成后才恢复可用。
- 一次低风险 Tool 经 intent/grant/executor/result 完成。
- client 正常退出后 companion 和 Tool 子进程均退出。

### 12.2 Nightly

- 3 个并发 Session 和队列。
- 分别 kill server、executor、client/WebView。
- grant 全部 negative cases。
- Action kill-point matrix。
- MCP/Skill fake fixtures、inventory hint/drop/gap/epoch-reset/read-own-write matrix（A4 后）。
- restart cap/recovery UX。
- signed/package artifact 的同一流程。

### 12.3 测试驱动

- 测试构建可启用最小本地 driver，但必须有随机启动凭证和编译时排除。
- stable package 扫描确认无 test method、固定 token、调试 listener。
- release smoke 优先使用正式入口和公开诊断，不依赖测试后门。

## 13. Provider、Checkpoint 与产品回归

- 每个 Provider adapter 继续覆盖认证、stream、Tool call、usage、error、capability 和 redaction。
- Provider 调用只在 server 测试进程中发生；client/executor 测试中出现 Provider Key 即失败。
- checkpoint contract、thread 删除、interrupt 和 transcript 查询继续由 server integration 覆盖。
- 现有 Provider/Chat/Session/WebView 测试在 A1 迁移期间保持；完成后删除永久旧 transport 路径。

## 14. 性能预算

基线设备为 Apple Silicon、16 GB RAM、release build。

| 指标 | 初始预算 |
| --- | --- |
| 冷启动到窗口可交互 | p95 <= 3 秒 |
| 两 companion 注册 online | p95 <= 2 秒，另记录 DB 恢复耗时 |
| client-server 本地 RPC | p95 <= 50 ms（不含业务处理） |
| server-executor 本地 RPC | p95 <= 50 ms（不含 Tool） |
| 流式 delta 到 UI | p95 <= 100 ms（不含 Provider 网络） |
| 3 Run 并发 RPC ping | p95 <= 100 ms |
| executor cancel 到进程树退出 | p95 <= 2 秒；顽固进程有升级终止 |
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
  -> server/executor/client role integration
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
  -> compile client + agents-server + executor
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
- 更新要么整体切换 client/server/executor，要么保持旧完整版本；不允许部分 binary 更新。
- 有活动 Run/Action 时不强制更新退出。
- stable package 不含源 Secret、bootstrap token、测试 driver 或开发 endpoint。

## 17. 数据 reset 与未来 migration

当前重构阶段：

- 不要求旧单进程业务 DB/checkpoint/Provider 开发配置迁移。
- 测试只要求“不兼容时明确 reset、旧数据不被误读、当前 schema 可 backup/restore”。
- 文案必须告诉开发用户 reset 会删除哪些本地数据。

首次外部发布冻结 schema 后，正式 release gate 再要求每个已发布版本的 migration、rollback 和 fixture。不得把当前 reset 例外推广到已发布用户数据。

## 18. 本地可观察性

每条结构化日志包含：

- `role`、binary/app/protocol version。
- stable ID、instance ID、generation、connection ID。
- session/run/tool/action/invocation/grant correlation（存在时）。
- error code 和安全状态，不含 Secret/raw Tool args。

诊断包汇总 client/server/executor 日志、registry snapshot、restart counters、DB integrity、binary signatures 和 redaction report。用户主动导出，默认不含 prompt、文件内容或凭证。

## 19. 发布阻塞条件

任一项成立即阻止对应阶段发布：

- client 可直连 executor，或任一角色存在通用 RPC forwarder。
- server 监听非 loopback，或未认证本机进程可注册。
- 旧 instance/generation 的 event/result/grant 被接受。
- executor offline 时仍能启动绑定 Agent 的 Run。
- executor 未验证 grant 即执行，或重复/篡改 grant 成功。
- executor 写业务 DB/checkpoint，或 client 持有 Provider/Agent runtime。
- non-idempotent Action 在 unknown outcome 后自动重放。
- Provider/model credential 进入 executor，或 MCP credential 出现在 server copy、普通 DB 字段、query/UI/prompt/log/diagnostic/export、全局环境或无关 child/Agent。
- server 保存 recoverable MCP/Skill config/content，或 executor offline/持久化失败时配置 command 返回成功。
- executor 注册/重连未 full sync 即 runnable，或 inventory gap/compaction/epoch/cursor 异常未回退 snapshot。
- failed poll/offline 被解释为 deletion，或 cache 含 credential/sensitive env/recoverable config/完整 Skill content。
- Run start/restore 仅信 cache、未 live 验证 resource/version/hash/schema，或 inventory 状态被当作 Tool 授权。
- local executor private root/credential file mode、owner、atomic replacement 或 symlink/no-follow gate 失败。
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
- [ ] server/executor kill、restart cap、reconnect/reconcile 通过。
- [ ] hint debounce、60 秒 ±20% poll、delta/tombstone、snapshot fallback 和 mutation read-own-write matrix 通过。
- [ ] cooperative shutdown 无遗留进程树。

### Package

- [ ] client、agents-server、executor 版本和 protocol matrix 一致。
- [ ] 签名、公证、Gatekeeper、无系统 runtime smoke 通过。
- [ ] 整体更新、失败保留旧版本和回滚 metadata 验证完成。

### 数据

- [ ] 当前开发期 reset 行为明确且已测试；没有迁移旧数据的错误承诺。
- [ ] 当前 schema backup/restore、DB integrity 和 checkpoint contract 通过。
