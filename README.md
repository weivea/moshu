# 墨枢

墨枢是一款 Local-first 的桌面 Agent 应用。当前仓库已按
[`docs/implementation`](./docs/implementation/README.md) 初始化 Phase 0 工程基线。

## 环境

- macOS 14+
- 开发工具链：Bun 1.3.14
- Electrobun 1.18.1
- Electrobun 内置 application runtime：Bun 1.3.13

## 开发

```bash
bun install --frozen-lockfile
bun run dev:hmr
```

常用命令：

```bash
bun run check
bun run build
bun run package:canary
```

“墨枢”为正式产品名称，项目采用 [MIT License](./LICENSE)。当前 Bundle ID
`dev.moshu.app` 仅用于开发，需在正式发布前替换为发布方的永久标识。
