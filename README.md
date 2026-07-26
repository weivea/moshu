# 墨枢

墨枢是一款 Local-first 桌面 Agent 应用，目前处于三应用角色架构迁移阶段，尚未面向外部分发。

当前仓库已经实现：

- Electrobun client 启动并监管两个 Bun compiled companion。
- agents server 独立承载 Provider、Ask runtime、业务数据库和 checkpoint。
- executor 完成独立进程、认证注册和生命周期基线；Tool、MCP 和 Skill 执行能力仍在后续阶段。
- client、agents server 和 executor 通过动态 loopback endpoint 上的版本化 JSON RPC 通信。

```text
React WebView
    <-> typed Electrobun RPC
Electrobun Application Host
    <-> authenticated WebSocket JSON RPC
agents server
    <-> authenticated WebSocket JSON RPC
executor
```

这里的“三角色”描述应用职责和可执行程序。Electrobun 还会创建 launcher、application worker、WebView
等框架进程，因此操作系统中不一定刚好只有三个 PID。

## 环境

- macOS 14+
- Bun 1.3.14（仓库固定版本）
- Electrobun 1.18.1
- Electrobun 内置 application runtime：Bun 1.3.13

安装依赖：

```bash
bun install --frozen-lockfile
```

## 开发

推荐使用带 WebView 热更新的开发入口：

```bash
bun run dev:hmr
```

该命令会：

1. 并行启动 Vite HMR server 和 desktop 开发流程。
2. 构建一次 React WebView，作为 Vite 不可用时的回退资源。
3. Electrobun `preBuild` 依次将 agents server 和 executor 编译成独立可执行文件。
4. `electrobun dev --watch` 构建并启动 desktop，由 supervisor 启动两个 companion 并等待认证注册和 readiness。

React WebView 使用 Vite HMR，通常不重开窗口。agents server 和 executor 使用完整自动重载：修改它们或当前引用的
共享包源码后，Electrobun 会进行 300ms 防抖、停止当前应用、重新编译两个 companion，再构建并启动 desktop。
该过程会重开桌面窗口，不保留 WebView 内存状态；持久化数据库和 checkpoint 不受影响。构建失败时应用保持停止，
修复源码并再次保存后会重新尝试。

当前 companion 自动重载覆盖：

```text
apps/agents-server/src/
apps/executor/src/
packages/agent-runtime/src/
packages/contracts/src/
packages/database/src/
packages/deepagents/src/
packages/process-rpc/src/
```

修改 desktop Application Host 时同样由 Electrobun watch 重建并重启应用。

不需要 Vite HMR 时可以运行：

```bash
bun run dev
```

此模式使用预构建的 WebView 资源并启动 Electrobun watch。
它不提供 React HMR，但 companion 和 Application Host 的完整自动重载仍然有效。

## 构建与打包

| 命令 | 作用 |
| --- | --- |
| `bun run build:companions` | 依次编译 agents server 和 executor standalone binary |
| `bun run build:web` | 使用 Vite 构建 React WebView |
| `bun run build` | 构建两个 companion 和 WebView；不生成桌面安装包 |
| `bun run package:canary` | 重建全部输入并执行 `electrobun build --env=canary` |

主要中间产物：

```text
apps/agents-server/dist/moshu-agents-server
apps/executor/dist/moshu-executor
apps/desktop/dist/mainview/
apps/desktop/build/
apps/desktop/artifacts/
```

开发运行时，desktop 直接使用 workspace 中的 companion binary。打包时，Electrobun 将它们复制到应用的
`Resources/app/companions` 目录，并检查执行权限、签名、entitlement 和实际启动能力。

Companion binary 按当前构建主机编译，因此暂不支持交叉平台打包。当前 canary 配置也仍使用开发 Bundle ID、
关闭 notarization 和增量 patch，不能视为正式发布配置。

## 质量检查

| 命令 | 作用 |
| --- | --- |
| `bun run format` | 使用 Biome 写入格式化结果 |
| `bun run lint` | 运行 Biome lint |
| `bun run typecheck` | 生成 Deep Agents 类型并检查所有 `@moshu/*` workspace |
| `bun run test:packages` | 运行 `packages/*` 测试 |
| `bun run test:companions` | 运行 agents server 和 executor 测试 |
| `bun run test:web` | 运行 desktop Bun/Vitest 测试 |
| `bun run test` | 运行上述全部测试 |
| `bun run check` | 运行格式检查、lint、类型检查和测试 |
| `bun run smoke:companions` | 验证两个 compiled companion 可启动并正常退出 |
| `bun run smoke:three-process` | 验证三角色认证、Chat、恢复、取消和数据所有权 |
| `bun run smoke:parent-death` | 验证 desktop parent 异常退出后 companion 不残留 |

`bun run check` 不包含 smoke test 或桌面打包；发布流水线需要单独执行相应命令。

## 文档

- [技术架构](./docs/implementation/architecture.md)
- [数据与接口契约](./docs/implementation/data-contracts.md)
- [工程交付计划](./docs/implementation/delivery-plan.md)
- [质量与发布计划](./docs/implementation/quality-release.md)
- [产品需求](./docs/product/README.md)

“墨枢”为正式产品名称，项目采用 [MIT License](./LICENSE)。当前 Bundle ID `dev.moshu.app` 仅用于开发，
正式发布前必须替换为发布方的永久标识。
