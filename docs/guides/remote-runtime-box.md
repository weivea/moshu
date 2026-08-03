# 连接 Remote Runtime Box

本文说明如何把另一台设备上的 Remote Runtime Box 连接到墨枢 Desktop 内运行的 Agent Server，并将它安装为当前用户的后台服务。

## 1. 连接关系

```text
Remote Runtime Box
  -> HTTPS / WebSocket
  -> Anonymous Microsoft Dev Tunnel
  -> Agent Server Runtime ingress
```

- Tunnel 由 Agent Server 管理，Desktop 只提供操作界面。
- Tunnel 虽然允许匿名访问，但 Runtime Box 必须经过一次性配对、Ed25519 设备签名、Server 身份固定和 generation 防重放认证。
- 同一个 Tunnel 可同时公开彼此隔离的 Runtime 与 Mobile 端口；Remote Runtime Box 只连接 Runtime ingress。
  Product RPC、Provider 和数据库接口不进入 Tunnel。
- Desktop 退出后 Agent Server 和 Tunnel Host 会停止；Remote Runtime Box 会等待下次连接。

> 用户级 Tool/Action 审批已实现；Remote Runtime Box 只执行 Agent Server 签发的有效一次性 grant。所有
> `bash` 仍需单独审批且不可被 Session Allow all 绕过，但当前没有 shell sandbox，批准后仍以远程设备用户权限执行。

## 2. 准备工作

需要：

1. 一台运行墨枢 Desktop 的 Agent Server 设备。
2. 一个可使用 Microsoft Dev Tunnels 的 Microsoft 账号。
3. 一台 macOS、Linux 或 Windows 远程设备。
4. 与远程设备操作系统和 CPU 架构匹配的 `moshu-runtime-box` 二进制。

正式发布时应使用 Moshu 提供的已签名二进制。当前 POC 也可以在**远程设备所属平台上**从源码构建：

```bash
bun install --frozen-lockfile
bun run --cwd apps/runtime-box build:binary
```

产物位于：

```text
apps/runtime-box/dist/moshu-runtime-box
apps/runtime-box/dist/moshu-runtime-box.exe
```

当前不支持交叉平台构建。远程设备运行已编译二进制时不需要安装 Bun 或 Node。

在 Linux/macOS 上先赋予执行权限，并把二进制放到不会再移动的永久位置：

```bash
chmod 755 ./moshu-runtime-box
```

`install` 会把二进制的当前绝对路径写入用户服务定义；安装后不要移动或删除该文件。

## 3. 在 Agent Server 启用 Remote Access

在墨枢 Desktop 中打开 **设置 → Runtime Boxes**。

1. 在 **Remote Access** 区域点击 **Microsoft 登录**。
2. 根据界面显示的地址和 device code 完成 Microsoft 登录。
3. 登录成功后点击 **启用**。
4. 等待状态变为 `online`。
5. 记录界面显示的 `https://...devtunnels.ms` URL。

如果状态为：

| 状态 | 含义 |
| --- | --- |
| `auth_required` | 尚未完成 Microsoft 登录，或登录状态已失效 |
| `starting` | Agent Server 正在创建或恢复 Tunnel Host |
| `online` | Remote Runtime Box 可以开始配对或重连 |
| `repair_required` | Runtime ingress 端口冲突；点击 **重建 Tunnel** 迁移到可用端口 |
| `error` | Tunnel Host 启动失败；查看同一区域的错误信息 |

## 4. 创建一次性配对码

Remote Access 处于 `online` 后：

1. 在 **添加 Remote Runtime Box** 区域点击 **创建配对码**。
2. 复制以下两项：
   - 一次性配对码；
   - Runtime URL。
3. 在 5 分钟内完成下一步。

配对码只能使用一次。不要把配对码或 Remote Runtime Box 的私有数据目录发送给其他人。

## 5. 在远程设备发起配对

### Linux/macOS

推荐通过标准输入传递配对码，避免写入 shell history：

```bash
RUNTIME_URL='https://example.devtunnels.ms'
read -rsp 'Pairing code: ' PAIRING_CODE
printf '\n'

printf '%s' "$PAIRING_CODE" | ./moshu-runtime-box pair \
  --url "$RUNTIME_URL" \
  --name '我的远程设备'

unset PAIRING_CODE
```

也可以使用 `--code <配对码>`，但配对码可能出现在 shell history 或进程参数中。

### Windows PowerShell

```powershell
$RuntimeUrl = "https://example.devtunnels.ms"
$PairingCode = Read-Host "Pairing code"

$PairingCode | .\moshu-runtime-box.exe pair `
  --url $RuntimeUrl `
  --name "我的远程设备"

Remove-Variable PairingCode
```

配对命令会：

1. 在远程设备生成 Ed25519 设备密钥；
2. 向 Agent Server 提交配对 claim；
3. 等待 Desktop 确认；
4. 固定 `agentServerId` 和 Agent Server 公钥；
5. 把绑定信息写入 Remote Runtime Box 私有数据目录。

此时保持远程终端中的命令运行。

## 6. 在 Desktop 确认设备指纹

远程设备提交 claim 后，Desktop 的 **添加 Remote Runtime Box** 区域会显示：

- 设备名称；
- 操作系统和架构；
- 设备公钥指纹。

确认这些信息与远程设备一致，然后点击 **确认指纹**。如果信息不符，点击 **拒绝**。

确认成功后，远程终端应输出类似结果：

```json
{"status":"paired","runtimeBoxId":"...","agentServerId":"..."}
```

## 7. 检查本地配置

先执行本地自检：

```bash
./moshu-runtime-box status
./moshu-runtime-box doctor
```

Windows：

```powershell
.\moshu-runtime-box.exe status
.\moshu-runtime-box.exe doctor
```

- `status` 检查设备是否已有本地配对配置，并显示绑定 ID、URL 和 generation；它**不代表当前网络连接在线**。
- `doctor` 检查私有配置、设备密钥对和数据目录；它同样不是远程连通性测试。

需要直接观察连接时，可先以前台模式运行：

```bash
./moshu-runtime-box run
```

输出状态通常按以下顺序变化：

```text
connecting -> online
```

网络或 Agent Server 暂时不可用时会显示 `disconnected` 并自动重连。按 `Ctrl+C` 停止前台进程。

## 8. 安装为当前用户后台服务

配对和自检完成后执行：

```bash
./moshu-runtime-box install
```

Windows：

```powershell
.\moshu-runtime-box.exe install
```

该命令按平台安装：

| 平台 | 后台服务 |
| --- | --- |
| Linux | systemd user service：`moshu-runtime-box.service` |
| macOS | LaunchAgent：`dev.moshu.runtime-box` |
| Windows | 计划任务：`Moshu Runtime Box` |

安装完成后不要再同时运行另一个 `moshu-runtime-box run`；同一数据目录只允许一个进程。

### 查看服务状态

Linux：

```bash
systemctl --user status moshu-runtime-box.service
journalctl --user -u moshu-runtime-box.service -f
```

macOS：

```bash
launchctl print "gui/$(id -u)/dev.moshu.runtime-box"
```

Windows PowerShell：

```powershell
schtasks /Query /TN "Moshu Runtime Box" /V /FO LIST
```

Linux 安装流程会调用 `loginctl enable-linger`，使用户退出登录后服务仍可运行。若系统策略拒绝该操作，请联系系统管理员启用 linger。

## 9. 在 Desktop 验证并切换

回到 **设置 → Runtime Boxes**：

1. 等待新设备依次进入 `syncing`、`online`。
2. 确认平台、架构、版本和设备名称正确。
3. 点击该 Runtime Box 的 **切换**。

切换后：

- Session、Project 列表切换到该 Runtime Box 的范围；
- MCP Server 配置和 Skills 切换到该 Runtime Box 拥有的数据；
- 新建 Session 和 Project 默认绑定该 Runtime Box；
- 已存在的 Session、Project 和正在运行的任务不会被迁移到其他 Box。

## 10. 自定义数据目录

默认数据目录：

| 平台 | 路径 |
| --- | --- |
| Linux | `$XDG_DATA_HOME/moshu/runtime-box`，未设置时为 `~/.local/share/moshu/runtime-box` |
| macOS | `~/Library/Application Support/Moshu/runtime-box` |
| Windows | `%LOCALAPPDATA%\Moshu\runtime-box` |

可以通过 `--data-dir` 覆盖：

```bash
./moshu-runtime-box pair --data-dir /path/to/runtime-data --url "$RUNTIME_URL" --name '设备名'
./moshu-runtime-box doctor --data-dir /path/to/runtime-data
./moshu-runtime-box install --data-dir /path/to/runtime-data
```

一旦使用自定义目录，所有命令必须使用同一路径。也可以设置 `MOSHU_RUNTIME_BOX_HOME` 作为默认覆盖。

数据目录包含：

- Agent Server 绑定和设备私钥；
- MCP Server 配置与 credential；
- Skills；
- Runtime Box 私有 SQLite；
- workspace、journal、日志和缓存。

不要手工复制 `remote-runtime-box.json` 到另一台设备，也不要把数据目录提交到 Git。

## 11. 常见问题

### 配对命令一直等待

- 确认 Desktop 仍在运行；
- 确认 Remote Access 状态为 `online`；
- 在 Desktop 查看是否出现待确认设备；
- 确认配对码没有超过 5 分钟；
- 如果已拒绝或过期，重新创建配对码。

### `Remote Runtime Box requires HTTPS`

Remote Runtime Box 只接受 HTTPS URL。HTTP 仅允许 `127.0.0.1`、`::1` 或 `localhost` 本机调试。

URL 不能包含用户名、密码、query 或 fragment。请直接使用 Desktop 显示的 Runtime URL。

### 服务已启动，但 Desktop 显示 `offline`

- 确认 Desktop 和 Agent Server 正在运行；
- 检查 Remote Access 是否仍为 `online`；
- 检查远程设备网络、DNS 和 HTTPS 出站访问；
- 查看平台服务状态或以前台 `run` 模式观察错误；
- 确认 Agent Server 中没有吊销该设备。

### 显示 `auth_failed`

常见原因：

- 设备 key 已被吊销；
- 本地绑定文件损坏；
- URL 指向了另一个 Agent Server；
- Agent Server 身份与配对时固定的身份不一致。

不要删除单个密钥字段尝试修复。按“解除绑定并重新配对”操作。

### 显示 `upgrade_required`

Remote Runtime Box 与 Agent Server 的 Runtime protocol 不兼容。安装与当前墨枢版本匹配的 Runtime Box 二进制，然后重新启动服务。不要尝试绕过版本检查。

### 重建 Tunnel 后旧 Box 无法连接

**重建 Tunnel** 可能改变 Runtime URL。若 Desktop 显示的 URL 与 `status` 输出不同，需要解除绑定并使用新 URL 重新配对。

### 提示已有另一个进程占用数据目录

同一数据目录只允许一个 Remote Runtime Box 进程。停止已安装的用户服务后再运行前台调试，不要删除活动进程的 `run.lock`。

## 12. 停用、卸载和解除绑定

仅停止并移除后台服务，保留配对和全部数据：

```bash
./moshu-runtime-box uninstall
```

移除后台服务并删除 Agent Server 绑定，保留 workspace、MCP 和 Skills 数据：

```bash
./moshu-runtime-box unpair
```

重新绑定时创建新的配对码，再执行 `pair`。

如果设备丢失或不再可信，还应在 Desktop 的 **Runtime Boxes** 列表中点击 **吊销**，使 Agent Server 立即拒绝该设备 key。吊销后仅删除远程设备上的本地文件不能恢复访问，必须重新配对。

## 13. 命令速查

```text
pair --url <https-url> [--name <name>] [--code <code>] [--data-dir <path>]
run [--data-dir <path>]
status [--data-dir <path>]
doctor [--data-dir <path>]
install [--data-dir <path>]
uninstall [--data-dir <path>]
unpair [--data-dir <path>]
```

技术细节参见[Runtime Box 架构与实现](../implementation/runtime-box.md)。
