# Canvas 产品需求

## 1. 定位

Canvas 是消息流之外的版本化工作区，用于承载需要持续编辑、预览和导出的成果。它不是一次性代码块，也不是任意网页直接获得本机能力的容器。

首版支持四种 Canvas：

| 类型 | 主要用途 | 编辑 | 预览/运行 |
| --- | --- | --- | --- |
| Markdown | 需求、报告、笔记、方案 | Markdown 编辑器 | 富文本、表格、Mermaid |
| Code | 单文件代码、配置、数据 | 代码编辑器 | 语法、Diff；按语言决定是否可运行 |
| Web | HTML/CSS/JavaScript 小页面 | 多文件编辑 | sandbox `BrowserView` 实时预览 |
| Diagram | 流程、架构、数据图表 | Mermaid/Vega-Lite 源码 | 图形预览 |

## 2. 用户入口

- Agent 在回答中创建或更新 Canvas。
- 用户从导航栏创建空白 Canvas。
- 将消息代码块、Markdown 或文件“在 Canvas 中打开”。
- 从 Project 文件创建“关联 Canvas”。
- 在 `/canvas/:canvasId` 独立编辑，或在 Chat 右侧面板打开。

## 3. Canvas 数据模型

每个 Canvas 至少包含：

- `id`、名称、类型、创建者和时间。
- 来源 Session、Run、Project 和 Agent，可为空。
- 当前工作草稿。
- 已保存版本列表。
- 文件集合及其 MIME/语言。
- 预览设置、网络策略和导出配置。
- 当前 revision，用于并发冲突检测。

Canvas 默认存储在应用数据目录。只有用户明确导出或创建文件关联时，才写入 Project。

## 4. 编辑体验

### 4.1 通用能力

- 用户和 Agent 均可编辑。
- 自动保存工作草稿。
- 撤销/重做、查找替换和基本快捷键。
- 文件树适用于多文件 Web Canvas。
- 显示保存状态、当前版本和最后修改者。
- Agent 修改到达时展示摘要和 Diff，不打断用户未保存输入。

### 4.2 双向协作

- Agent 读取 Canvas 时使用确定 revision。
- Agent 更新使用 Patch，而不是无条件覆盖完整内容。
- revision 不一致时停止自动应用，展示用户版本、Agent Patch 和冲突。
- 用户可接受全部、接受部分、拒绝或手工合并。
- Agent 修改前自动建立可恢复版本。

### 4.3 Markdown

- 编辑与预览可分栏或切换。
- 支持 GFM、表格、任务列表和安全的 Mermaid。
- 外部链接需要明确打开；不允许 Markdown 内嵌脚本。
- 可导出 `.md`、HTML 和 PDF；PDF 属于阶段 2 的正式验收项。

### 4.4 Code

- 语法高亮、行号、格式化接口和 Diff。
- 首版聚焦单文件或少量关联文件，不替代完整 IDE。
- 非 Web 代码默认不在主 WebView 直接执行。
- 需要执行时复用 Agent 命令审批与隔离环境，而不是 Canvas 自行获得终端权限。

### 4.5 Web

- 支持 HTML、CSS、JavaScript 和静态资源。
- 实时预览错误显示在 Canvas 控制台。
- 首版不承诺任意 npm 依赖安装；内置依赖白名单或打包策略在阶段 2 冻结前确定。
- 预览运行在与应用主界面分离的 Electrobun `BrowserView`，使用独立 partition、origin 和 `sandbox: true`。
- `sandbox: true` 时不注册应用 RPC，只允许受控的单向预览事件。
- Web Canvas 任意脚本和远程资源能力只有在子资源默认断网 POC 通过后开放；否则只支持清理后的静态 HTML/CSS 预览。

### 4.6 Diagram

- 首版支持 Mermaid 和 Vega-Lite 两种声明式格式。
- 解析错误定位到源代码。
- 支持 SVG/PNG 导出；保留源文件。

## 5. 版本与差异

### 5.1 版本产生时机

- 用户点击“创建版本”。
- Agent 每次成功应用修改前后。
- 从历史版本恢复前。
- 导出前可选创建版本。

自动保存草稿不为每次键入生成永久版本，避免版本噪声。

### 5.2 版本能力

- 版本名称、说明、来源 Run 和修改者。
- 文本、代码和多文件 Diff。
- 预览任一历史版本。
- 恢复历史版本时创建新版本，不删除后续历史。
- 删除 Canvas 时按本地数据策略处理版本。

## 6. Agent 工具边界

Canvas 向 Agent 暴露结构化工具：

- 列出和读取 Canvas 元数据/文件。
- 创建指定类型 Canvas。
- 基于 revision 应用 Patch。
- 请求渲染并读取结构化错误。
- 创建命名版本。
- 建议导出，但不能未经用户确认写入任意本地路径。

工具结果必须关联 Run，Canvas UI 可跳回发起修改的消息和工具事件。

## 7. 预览安全

Web/Diagram 渲染必须满足：

- 独立 Electrobun `BrowserView`、partition 和 `sandbox: true`，不与主 WebView 共用应用 RPC。
- 禁用 Bun/Node、Electrobun RPC、应用特权 `views://` 页面和同源主应用访问。
- 默认禁用网络；真实测试必须覆盖 iframe、fetch、WebSocket、EventSource、图片、字体、CSS、媒体、service worker、localhost、私网和 DNS rebinding。
- Electrobun 当前没有已文档化的 `webRequest` 等价子资源拦截能力。默认断网门未通过时，不执行任意用户 HTML/JavaScript；网络临时授权必须由 agents server 持久化决定，并由 client Preview 的显式 capability 与受控代理执行，不能只靠导航规则。
- 禁止直接访问 `file://`、Project 路径、剪贴板、摄像头、麦克风和位置。
- 通过受控 `views://` wrapper 设置不可被用户内容覆盖的严格 CSP，限制脚本、连接、字体、图片和 frame。
- 限制 CPU、内存、日志、存储和渲染时间；失控时可终止预览。
- HTML、SVG、Markdown 和 Mermaid 输出经过适合上下文的清理。
- Canvas 内链接不能在 BrowserView 内导航到应用特权页面。

## 8. Project 文件关联

Canvas 可与一个 Project 文件建立关联：

- 初次关联展示路径和写权限。
- 外部文件变化时提示重新加载、对比或保留 Canvas 版本。
- Canvas 保存回文件前展示 Diff。
- Agent 对关联文件的修改同时进入 Project 变更追踪。
- 解除关联不删除源文件。

## 9. 导出

| Canvas | 导出格式 |
| --- | --- |
| Markdown | Markdown、HTML、PDF |
| Code | 原文件、ZIP |
| Web | 静态站点 ZIP、单文件 HTML（可合并时） |
| Diagram | 源文件、SVG、PNG |

导出前展示包含的远程资源、潜在密钥和本地路径；默认进行敏感信息扫描，但不承诺自动发现所有秘密。

## 10. 空状态与错误

- 无内容时提供模板，不自动调用模型产生费用。
- 渲染错误保留最后一次成功预览。
- Agent Patch 失败不修改当前内容，并提供重试或手工应用。
- 应用崩溃后恢复最后草稿和已持久化版本。
- 不支持的文件类型提供下载/外部打开，不尝试不安全执行。

## 11. 功能需求索引

| ID | 需求 | 优先级 |
| --- | --- | --- |
| CAN-001 | Canvas 可由用户或 Agent 创建并关联 Session/Run | P0 |
| CAN-002 | 用户与 Agent 双向编辑并使用 revision 防覆盖 | P0 |
| CAN-003 | Markdown、Code、Web、Diagram 四类 Canvas | P0 |
| CAN-004 | 实时预览与结构化错误 | P0 |
| CAN-005 | 自动草稿、命名版本、Diff、恢复和导出 | P0 |
| CAN-006 | Web Canvas 在无 Electrobun RPC/Bun/Node 权限且默认断网的 BrowserView 运行 | P0 |
| CAN-007 | Canvas 写入 Project 前展示 Diff 并遵守审批 | P0 |
| CAN-008 | 多文件 Web Canvas 支持受控依赖 | P1 |
| CAN-009 | Canvas 插件类型注册机制 | P2 |
