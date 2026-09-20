[中文](#中文) | [English](#english)

# A2S server-api

## 中文

## A2S 生态（同系列开源仓库）

A2S 按组件拆分为以下同系列仓库，所有者均为 `23J1633`。/ A2S is split into the following sibling repositories, all owned by `23J1633`.

| 仓库 / Repository | 作用 / Role | GitHub |
|---|---|---|
| A2Switch | Windows 桌面控制中心 / Windows desktop control center | [23J1633/A2Switch](https://www.github.com/23J1633/A2Switch) |
| cc2server | Claude Code 桥接器 / Claude Code bridge | [23J1633/cc2server](https://www.github.com/23J1633/cc2server) |
| codex2server | Codex 桥接器 / Codex bridge | [23J1633/codex2server](https://www.github.com/23J1633/codex2server) |
| dsh2server | DeepSeek Harness 插件 / DeepSeek Harness plugin | [23J1633/dsh2server](https://www.github.com/23J1633/dsh2server) |
| server-api | 中转服务与 Web 控制台 / relay server and Web console | [23J1633/server-api](https://www.github.com/23J1633/server-api) |
| a2s_app | Flutter Android 客户端 / Flutter Android client | [23J1633/a2s_app](https://www.github.com/23J1633/a2s_app) |

`server-api` 是 A2S 的统一服务器端：接收本机 Claude Code、Codex、DeepSeek Harness 桥接器的主动连接，为浏览器或其他设备提供同一套控制 API，并附带多 Agent Web 控制台。

默认统一基路径是 `/a2s-api`。为了兼容已有 dsh2server 部署，`/dsh-api` 仍作为完整别名工作。

## 架构

```text
cc2server ───┐
codex2server ├── WSS 或 HTTPS 长轮询 ──► server-api ──► Web 控制台
dsh2server ──┘                               │
                                            └──► REST / SSE 客户端
```

- Agent 始终主动连出，服务器不反向访问本机。
- WebSocket 是首选载体；`/events` + `/inbox` 提供功能等价的 HTTP 回退。
- 一个 `a2sk_` key 可以绑定同设备的多个 Agent 实例。
- 每个实例仍有独立方法目录、能力位、会话、事件序号和订阅。
- 服务器不持久化会话正文，只持久化 key 白名单、服务器配置和控制台归档索引。

## 快速启动

要求 Node.js 20+：

```bash
cd server-api
npm install
```

### 本机明文测试

PowerShell：

```powershell
$env:A2S_SERVER_NO_TLS = '1'
$env:A2S_SERVER_HOST = '127.0.0.1'
$env:A2S_SERVER_PORT = '50443'
$env:A2S_SERVER_DATA_DIR = "$PWD\.runtime-local"
npm start
```

Bash：

```bash
A2S_SERVER_NO_TLS=1 \
A2S_SERVER_HOST=127.0.0.1 \
A2S_SERVER_PORT=50443 \
A2S_SERVER_DATA_DIR="$PWD/.runtime-local" \
npm start
```

启动后：

| 用途 | 地址 |
|---|---|
| Web 控制台 | `http://127.0.0.1:50443/` |
| 健康检查 | `http://127.0.0.1:50443/a2s-api/health` |
| Agent endpoint | `http://127.0.0.1:50443/a2s-api` |
| WebSocket | `ws://127.0.0.1:50443/a2s-api/ws` |

首次访问管理接口或控制台登录时需要数据目录中的 `admin-key.txt`。这是服务器所有者凭据，只保存在服务器本地及所有者的浏览器会话中；A2Switch 不保存也无法读取它。

控制台左上角与中央欢迎区会随当前实例一起切换 Claude Code、Codex、DeepSeek Harness 的真实品牌图形、名称和输入提示；尚未选择实例或等待登录时显示项目方提供的 A2S 图标。所有图标均锁定方形尺寸，不会被侧栏布局挤压变形。

## 生产部署

### Linux 一行部署（推荐）

Ubuntu、Debian、RHEL、Rocky Linux、AlmaLinux 等使用 systemd 的 Linux 服务器可直接执行：

```bash
set -o pipefail; curl -4fL --connect-timeout 15 --max-time 120 --show-error https://raw.githubusercontent.com/23J1633/server-api/main/install.sh | sudo bash
```

该脚本会自动完成 Node.js 22 检查/安装、GitHub 源码下载、生产依赖安装、低权限 `a2s` 账号、systemd 自启、启动健康检查和失败回滚。重复执行同一条命令即可升级；`/var/lib/a2s-server` 中的数据、已登记设备 key 和 `admin-key.txt` 都会保留。成功后终端会显示大型 A2S 字符标识、访问地址、管理员密钥明文、密钥文件位置和维护命令；管理员密钥属于服务器所有者凭据，请勿把终端输出发给不受信任的人。

默认只监听 `127.0.0.1:50443` 明文 HTTP，用于放在 Nginx、Caddy 或 1Panel HTTPS/WSS 反向代理后面。如果需要直接监听内网地址：

```bash
set -o pipefail; curl -4fL --connect-timeout 15 --max-time 120 --show-error https://raw.githubusercontent.com/23J1633/server-api/main/install.sh \
  | sudo env A2S_SERVER_HOST=0.0.0.0 A2S_SERVER_PORT=50443 bash
```

自定义配置与预检：

```bash
# 只输出计划，不修改服务器
set -o pipefail; curl -4fL --connect-timeout 15 --max-time 120 --show-error https://raw.githubusercontent.com/23J1633/server-api/main/install.sh | bash -s -- --dry-run

# 重写已存在的环境文件（普通升级默认保留它）
set -o pipefail; curl -4fL --connect-timeout 15 --max-time 120 --show-error https://raw.githubusercontent.com/23J1633/server-api/main/install.sh \
  | sudo env A2S_RECONFIGURE=1 A2S_SERVER_HOST=127.0.0.1 A2S_SERVER_PORT=50443 bash
```

部署完成后常用命令：

```bash
sudo systemctl status a2s-server
sudo journalctl -u a2s-server -f
sudo cat /var/lib/a2s-server/admin-key.txt
```

如果服务器出口必须经过 HTTP(S) 或 SOCKS5 代理，先把代理地址替换为实际值；`curl` 和安装脚本会继承这些环境变量：

```bash
sudo env \
  HTTPS_PROXY=http://PROXY_HOST:PROXY_PORT \
  HTTP_PROXY=http://PROXY_HOST:PROXY_PORT \
  ALL_PROXY=http://PROXY_HOST:PROXY_PORT \
  bash -c 'set -o pipefail; curl -4fL --connect-timeout 15 --max-time 120 --show-error https://raw.githubusercontent.com/23J1633/server-api/main/install.sh | bash'
```

SOCKS5 代理将三个值改为 `socks5h://PROXY_HOST:PROXY_PORT`。不要把包含用户名或密码的代理命令分享给他人。

卸载服务和程序但保留设备数据、管理员密钥及环境配置：

```bash
set -o pipefail; curl -4fL --connect-timeout 15 --max-time 120 --show-error https://raw.githubusercontent.com/23J1633/server-api/main/install.sh \
  | sudo bash -s -- --uninstall
```

只有确定不再需要任何设备登记、归档和管理员密钥时，才执行完全清理；该模式也会删除由安装器创建的专用系统用户/用户组，但不会删除同名的预存账号：

```bash
set -o pipefail; curl -4fL --connect-timeout 15 --max-time 120 --show-error https://raw.githubusercontent.com/23J1633/server-api/main/install.sh \
  | sudo bash -s -- --uninstall --purge
```

两种卸载模式都可以先追加 `--dry-run` 查看精确目标而不修改服务器。

> 只有在 `server-api` 仓库已公开且 `main` 分支包含 `install.sh` 后，上述 raw GitHub 命令才能被新服务器访问。

### 手工部署

公网必须使用 HTTPS/WSS。两种推荐方式：

1. 在 `config.json` 的 `tls.cert` / `tls.key` 中配置证书，让 Node 直接提供 TLS；
2. Node 只监听受保护的回环/内网 HTTP，由 Nginx、Caddy 或 1Panel 反向代理并终止 TLS。

直接运行：

```bash
cd /opt/a2s/server-api
npm ci --omit=dev
mkdir -p /home/a2s/.a2s-server
cp config.example.json /home/a2s/.a2s-server/config.json
export A2S_SERVER_DATA_DIR=/home/a2s/.a2s-server
./start.sh start
./start.sh status
./start.sh logs
```

`start.sh` 支持 `start`、`stop`、`restart`、`status`、`logs`，PID 与日志都写入 `A2S_SERVER_DATA_DIR`。旧 `DSH_RELAY_*` 环境变量仍可使用，但新部署应使用 `A2S_SERVER_*`。

systemd 示例：

```ini
[Unit]
Description=A2S unified agent relay
After=network-online.target

[Service]
Type=simple
User=a2s
WorkingDirectory=/opt/a2s/server-api
Environment=A2S_SERVER_DATA_DIR=/home/a2s/.a2s-server
ExecStart=/usr/bin/node /opt/a2s/server-api/server.js
Restart=always
RestartSec=3

[Install]
WantedBy=multi-user.target
```

反向代理必须允许 WebSocket upgrade，并关闭 SSE/长轮询响应缓冲。至少代理 `/` 和 `/a2s-api/`；如需旧客户端，再代理 `/dsh-api/`。

## 配置

加载顺序：内置默认值 → 数据目录的 `config.json` → 环境变量覆盖。模板见 [`config.example.json`](config.example.json)。

| 字段 | 默认值 | 说明 |
|---|---|---|
| `host` | `0.0.0.0` | 监听地址 |
| `port` | `50443` | 监听端口 |
| `basePath` | `/a2s-api` | 统一 API 基路径 |
| `legacyBasePaths` | `[/dsh-api]` | 完整兼容别名 |
| `tls.cert` / `tls.key` | 1Panel 示例路径 | 证书与私钥；不可读时退回 HTTP |
| `tls.watchMs` | `600000` | 证书热重载检查周期；0 关闭 |
| `dataDir` | `~/.a2s-server` | key、配置、日志与归档索引目录 |
| `eventBufferSize` | `2000` | 每实例内存事件窗口 |
| `maxPayloadBytes` | `1048576` | 服务器单帧负载上限 |
| `heartbeatMs` | `30000` | 建议心跳周期 |
| `offlineAfterMs` | `90000` | 无入站帧后判离线 |
| `helloTimeoutMs` | `20000` | 半开连接握手超时 |
| `requestTimeoutMs` | `120000` | 默认远程方法超时 |
| `methodTimeoutMs` | 见模板 | 慢方法单独超时 |
| `autoSubscribe` | 运行中会话 + 流式输出 | 新实例握手后的服务端订阅 |
| `consoleBacklogLimit` | `500` | 控制台单次事件窗口 |

环境变量：

| 新变量 | 旧兼容变量 | 说明 |
|---|---|---|
| `A2S_SERVER_CONFIG` | `DSH_RELAY_CONFIG` | 配置文件完整路径 |
| `A2S_SERVER_DATA_DIR` | `DSH_RELAY_DATA_DIR` | 数据目录 |
| `A2S_SERVER_HOST` | `DSH_RELAY_HOST` | 监听地址 |
| `A2S_SERVER_PORT` | `DSH_RELAY_PORT` | 监听端口 |
| `A2S_SERVER_NO_TLS=1` | `DSH_RELAY_NO_TLS=1` | 强制明文启动 |
| `A2S_SERVER_LOG_LEVEL` | `DSH_RELAY_LOG_LEVEL` | 日志级别 |

### 数据目录

```text
~/.a2s-server/
├─ admin-key.txt    管理密钥，0600
├─ keys.json        设备 key 白名单，0600
├─ archives.json    控制台归档索引，不含会话正文
├─ config.json      生效配置
├─ relay.log        运行日志
└─ relay.pid        start.sh 的 PID 文件
```

数据目录必须位于 Web 静态目录之外，且只允许服务账号读取。

## 配对与统一设备 key

### 使用 A2Switch

在 A2Switch 中填写 endpoint 并复制“本机设备 key”。服务器所有者使用 `admin-key.txt` 登录云端控制台，在“机器与密钥”页粘贴该本机 key 完成登记。其底层管理请求等价于：

```http
POST /a2s-api/keys
x-admin-key: <admin-key>
content-type: application/json

{
  "key": "a2sk_...",
  "label": "workstation",
  "deviceId": "a2s-0123456789ab"
}
```

### 使用 curl

```bash
curl -X POST https://example.com/a2s-api/keys \
  -H 'content-type: application/json' \
  -H 'x-admin-key: YOUR_ADMIN_KEY' \
  -d '{"key":"a2sk_...","label":"workstation","deviceId":"a2s-0123456789ab"}'
```

Claude、Codex 与 DSH 随后用相同 key、相同 `deviceId`、不同 `instanceId` 连接。KeyStore 会把新实例 ID 追加到同一条 key 记录，而不是覆盖已有实例。

旧 `dshk_` key 仍可登记。管理接口永远只返回 key 指纹，不返回完整 key。

## 管理 API

除健康检查外，管理端点需要：

```http
x-admin-key: <admin-key>
```

### 服务与设备

| 方法 | 路径 | 说明 |
|---|---|---|
| `GET` | `/a2s-api/health` | 免鉴权健康状态、协议与统计 |
| `GET` | `/a2s-api/stats` | 服务统计和近期日志 |
| `GET` | `/a2s-api/devices` | 按 key/deviceId 聚合的设备及 Agent |
| `GET` | `/a2s-api/instances` | 全部 Agent 实例摘要 |
| `GET` | `/a2s-api/instances/:id` | 实例详情、会话、工作区、任务 |

### 控制与事件

| 方法 | 路径 | 说明 |
|---|---|---|
| `POST` | `/instances/:id/request` | 下发统一方法 `{method, params, timeoutMs?}` |
| `POST` | `/instances/:id/subscribe` | 调整 topic、session、assistant stream 订阅 |
| `POST` | `/instances/:id/unsubscribe` | 取消订阅 |
| `GET` | `/instances/:id/events?since=&limit=` | 读取实例事件窗口 |
| `GET` | `/instances/:id/sessions` | 读取缓存会话状态和待决交互 |
| `GET` | `/instances/:id/session-events/:sid` | 会话事件、流、目标、todo 与快照 |
| `GET` | `/instances/:id/snapshot/:sid` | 会话快照 |
| `GET` | `/console/stream` | 控制台 SSE：实例和原始帧 |

表中省略的路径均以 `/a2s-api` 开头。

远程调用示例：

```bash
curl -X POST 'https://example.com/a2s-api/instances/a2s-xxx%3Acodex/request' \
  -H 'x-admin-key: YOUR_ADMIN_KEY' \
  -H 'content-type: application/json' \
  -d '{"method":"session.list","params":{"limit":50}}'
```

服务器不硬编码所有 Agent 方法；它把请求发给目标实例，实例按能力返回结果或稳定错误码。常见错误状态会映射为合理 HTTP 状态，例如 `instance_offline`→503、`timeout`→504、`invalid_params`→400。

### 归档

| 方法 | 路径 | 说明 |
|---|---|---|
| `GET` | `/instances/:id/archives` | 控制台归档索引 |
| `POST` | `/instances/:id/sessions/:sid/archive` | 归档；`scope=server` 或 `host` |
| `DELETE` | `/instances/:id/sessions/:sid/archive` | 从控制台归档恢复 |

`scope=server` 只隐藏控制台条目；`scope=host` 还会调用 Agent 的 `session.archive`（目标支持时）。

### key 管理

| 方法 | 路径 | 说明 |
|---|---|---|
| `GET` | `/keys` | 脱敏 key 列表 |
| `POST` | `/keys` | 登记/幂等更新一个 key |
| `PATCH` | `/keys/:id` | 改备注、绑定 ID 或替换 key |
| `DELETE` | `/keys/:id` | 吊销并立即关闭关联 Agent 链路 |
| `POST` | `/instances/:id/rotate-key` | 让单实例执行远程 key 轮换 |

共享 key 同时服务三个 Agent 时，不应从某一个实例单独远程轮换，否则其他实例仍持有旧 key。A2Switch 的统一轮换会协调服务器与本机配置，是推荐方式。

## Agent 传输协议

### WebSocket

连接 `/a2s-api/ws?v=1`，随后发送 `hello`，其中包含 `instanceId`、`deviceId`、`agentType`、能力位、插件版本与设备 key。也支持 Bearer header 或 query key 的预鉴权模式。

### HTTP 回退

- `POST /a2s-api/events`：Agent 上行帧；
- `GET|POST /a2s-api/inbox`：Agent 长轮询下行；
- 两种载体共享同一帧格式和鉴权语义；
- 收到 `bye` 后立即标离线，无需等待超时。

### 关键行为

- `hello.ack` 返回心跳、服务端时间、订阅与恢复水位；
- 每实例保留有限事件窗口，支持断线续传；
- 请求有唯一 ID、超时与稳定错误码；
- 同实例可有多条链路，状态按最近入站活动刷新；
- key 吊销立即断开该 key 关联的所有实例；
- 不同 key 不得抢占已绑定实例 ID。

协议细节可参考 [`../dsh2server/docs/API.md`](../dsh2server/docs/API.md)。

## Web 控制台

浏览器打开服务器根路径，输入管理密钥即可使用。主要功能：

- 机器下拉框按 `deviceId` 聚合，只切换电脑；切到另一台机器时优先保留当前 Agent 类型；
- 点击左上角原有品牌图标/字标，在当前机器的 Claude Code、Codex、DeepSeek Harness 之间切换；品牌区的真实图标、字标和布局保持不变；
- 会话创建、选择、重命名、分叉、归档、搜索；
- 提示词发送、流式回复、中断、模型和权限选择；
- 本地提交回显会由 `requestId`/`clientMessageId`/`source.rpcId` 与持久消息原位替换，不会在回答结束后重复出现；
- 服务器缓存的流式片段只会在会话仍处于运行状态时恢复；已完成会话以持久事件为准，不会把旧流再次追加成一条助手回复；
- 工具调用、diff、token/时延、轨迹时间线；
- 对话输入栏始终把命令、权限、模型和发送按钮保持在同一工具行；轨迹页是独立检查视图，不显示对话输入框；
- 长对话只先取最新窗口，持续向上滚动会提前并连续加载更早页，同时保持当前阅读锚点；
- 审批与结构化问题就地应答；
- 文件、任务、目标等面板按实例能力位动态出现；
- key 登记、编辑、吊销及调试方法调用；
- 浅色/深色主题、字体和刷新间隔。
- 首次访问时自动识别浏览器/系统语言；可在“设置 → 通用设置 → 语言”中选择自动跟随、简体中文或 English，选择按浏览器保存。

控制台使用 `/api-config.js` 获取运行时 `basePath`，部署到自定义基路径时无需重新构建前端。

## 测试

完整服务器回归：

```bash
npm test
```

包含：

- 5 项 Node relay/key/机器与 Agent 两级选择单元测试；
- 30 项对话转录与 UI 模型回归（包括隐藏 DSH 插件注入的运行上下文和隐藏工作区过滤）；
- 46 项真实 HTTP/WebSocket 自检，包括鉴权、订阅、流式输出、审批、重连、HTTP 回退、多机器、key 编辑和吊销。

单独运行：

```bash
npm run test:transcript
npm run selftest
```

对正在运行的本机服务验证手机登录、设备解锁、幂等健康请求、心跳、一次性配对、重复兑换、移动客户端改名和撤销：

```powershell
$env:A2S_SERVER_DATA_DIR = Join-Path $env:LOCALAPPDATA 'A2S\server'
npm run test:mobile-smoke
```

脚本读取数据目录中的管理密钥，但不会把完整密钥或 Bearer token 写入报告。不要省略 `A2S_SERVER_DATA_DIR`，否则脚本可能读取到另一个开发实例的数据目录。

真实浏览器 UI 验收脚本：

```powershell
$env:A2S_ADMIN_KEY = (Get-Content "$env:LOCALAPPDATA\A2S\server\admin-key.txt" -Raw).Trim()
$env:A2S_INSTANCE = 'a2s-xxxxxxxxxxxx:codex'
$env:A2S_AGENT_TYPE = 'codex'
..\A2Switch\node_modules\.bin\electron.cmd .\scripts\ui-live-smoke.cjs

$env:A2S_SESSION = '<一个具有多页历史的会话 ID>'
..\A2Switch\node_modules\.bin\electron.cmd .\scripts\ui-history-smoke.cjs

# Codex：点击真实“新会话”菜单并确认空白 thread 可打开
..\A2Switch\node_modules\.bin\electron.cmd .\scripts\ui-new-session-smoke.cjs

# Claude：恢复旧历史，并通过真实 UI 新建、重命名、移除工作区
$env:A2S_INSTANCE = 'a2s-xxxxxxxxxxxx:claude'
..\A2Switch\node_modules\.bin\electron.cmd .\scripts\ui-claude-history-workspace-smoke.cjs
```

`ui-live-smoke.cjs` 会真实创建会话、发送提示、等待流式与最终回复，并检查单一用户气泡、同排输入工具栏、轨迹无输入框及提示层销毁；`ui-history-smoke.cjs` 用一次持续向上滚动验证至少连续加载两页历史。其余两个脚本分别覆盖 Codex 空白新会话兼容，以及 Claude 原生历史恢复与工作区完整 UI 操作。所有脚本都使用独立 Electron 分区，不持久化管理员密钥。

跨项目真实闭环在仓库根目录执行：

```powershell
node .\scripts\full-loop-test.mjs
```

## 安全注意事项

- 管理密钥权限高于设备 key，必须单独保护，不应发送给 Agent。
- KeyStore 使用 SHA-256 定长摘要后的恒定时间比较；API 和日志只显示指纹。
- `keys.json` 与 `admin-key.txt` 尝试设置为 0600；还应使用独立低权限系统账号。
- 公网明文 HTTP 会泄露 Agent 内容和密钥，禁止使用。
- 控制台静态文件路径有目录穿越防护；未知扩展名不会被提供。
- 反向代理需要限制请求体大小并保留服务器的 `maxPayloadBytes` 约束。
- server-api 是控制面，不是租户隔离平台；需要多租户时应在外层增加身份、授权、审计和网络隔离。

## 目录结构

```text
server-api/
├─ server.js               HTTP/HTTPS、静态资源和 WebSocket 入口
├─ lib/
│  ├─ admin.js             REST/SSE 管理面
│  ├─ relay.js             实例注册、调用、key 绑定
│  ├─ instance.js          实例状态与缓存窗口
│  ├─ carriers.js          HTTP 长轮询载体
│  ├─ link.js              WebSocket/HTTP 链路抽象
│  ├─ keystore.js          设备 key 与管理密钥
│  ├─ archive-store.js     控制台归档索引
│  └─ config.js            配置加载
├─ public/                 多 Agent Web 控制台
│  └─ js/agent-selection.js 机器聚合与 Agent 选择规则
├─ scripts/                单元、自检和转录回归
├─ sim/                    协议模拟器
├─ config.example.json     生产配置模板
├─ install.sh              Linux 一行安装、升级与卸载
└─ start.sh                Linux 手工后台管理脚本
```

## 许可证

代码采用 MIT License，见 `LICENSE`。第三方名称和品牌图标属于各自权利人，仅用于兼容性标识。

---

## English

`server-api` is the unified A2S relay. Claude Code, Codex, and DeepSeek Harness bridges connect to it outbound; browsers and mobile clients use one REST/SSE/WebSocket API and a multi-Agent Web console. The canonical base path is `/a2s-api`; `/dsh-api` remains a complete compatibility alias.

### Architecture and behavior

- WebSocket is the preferred Agent carrier; `/events` plus `/inbox` provide equivalent HTTP long polling.
- One `a2sk_` device key may authenticate multiple Agent instances on the same physical machine.
- Each instance keeps separate capabilities, methods, sessions, event sequence, subscriptions, and liveness.
- Session bodies are relayed, not stored as a server-side transcript. Persistent data includes the key allowlist, configuration, mobile credentials, and console archive index.
- Heartbeats, server ping, offline detection, bounded event buffers, replay, request timeouts, and idempotency support recovery from temporary disconnections.

### One-line Linux deployment

On a systemd-based Ubuntu, Debian, RHEL, Rocky Linux, or AlmaLinux server:

```bash
set -o pipefail; curl -4fL --connect-timeout 15 --max-time 120 --show-error https://raw.githubusercontent.com/23J1633/server-api/main/install.sh | sudo bash
```

The installer validates/provisions Node.js 22, downloads the GitHub release, installs production dependencies, creates the restricted `a2s` account, installs/enables a restartable systemd unit, performs a health check, and rolls back a failed release. Re-run the same command to upgrade while preserving `/var/lib/a2s-server`.

After success, the terminal prints a large A2S banner, console and Agent endpoints, the complete administrator key, its file path, status/log commands, and upgrade/uninstall commands. Treat that terminal output as sensitive because the administrator key can manage all registered devices.

The default service listens on `127.0.0.1:50443` over HTTP for use behind Nginx, Caddy, or 1Panel TLS termination. Set `A2S_SERVER_HOST=0.0.0.0` only when the network boundary is understood; never expose plaintext control traffic to the public Internet.

If the server must reach GitHub through a proxy, pass the proxy environment to both `curl` and the installer (replace the placeholder with the real endpoint):

```bash
sudo env \
  HTTPS_PROXY=http://PROXY_HOST:PROXY_PORT \
  HTTP_PROXY=http://PROXY_HOST:PROXY_PORT \
  ALL_PROXY=http://PROXY_HOST:PROXY_PORT \
  bash -c 'set -o pipefail; curl -4fL --connect-timeout 15 --max-time 120 --show-error https://raw.githubusercontent.com/23J1633/server-api/main/install.sh | bash'
```

For SOCKS5, use `socks5h://PROXY_HOST:PROXY_PORT` for all three values. Keep proxy credentials private.

```bash
# Preview without changing the server
set -o pipefail; curl -4fL --connect-timeout 15 --max-time 120 --show-error https://raw.githubusercontent.com/23J1633/server-api/main/install.sh | bash -s -- --dry-run

# Remove service/application but preserve data, keys, and environment
set -o pipefail; curl -4fL --connect-timeout 15 --max-time 120 --show-error https://raw.githubusercontent.com/23J1633/server-api/main/install.sh | sudo bash -s -- --uninstall

# Explicitly remove all persistent data, keys, environment, and installer-created service user/group
set -o pipefail; curl -4fL --connect-timeout 15 --max-time 120 --show-error https://raw.githubusercontent.com/23J1633/server-api/main/install.sh | sudo bash -s -- --uninstall --purge
```

Append `--dry-run` to either uninstall command to inspect its targets. The purge form is intentionally explicit and irreversible.

### Local development

Node.js 20+ is supported by the server package.

```bash
npm install
A2S_SERVER_NO_TLS=1 \
A2S_SERVER_HOST=127.0.0.1 \
A2S_SERVER_PORT=50443 \
A2S_SERVER_DATA_DIR="$PWD/.runtime-local" \
npm start
```

The console is at `http://127.0.0.1:50443/`, health at `/a2s-api/health`, the Agent endpoint at `/a2s-api`, and WebSocket at `/a2s-api/ws`. First start creates `admin-key.txt`, `keys.json`, and `config.json` in the data directory.

### Configuration and credentials

Configuration loads in this order: defaults, data-directory `config.json`, then environment overrides. Common variables are `A2S_SERVER_CONFIG`, `A2S_SERVER_DATA_DIR`, `A2S_SERVER_HOST`, `A2S_SERVER_PORT`, `A2S_SERVER_NO_TLS`, and `A2S_SERVER_LOG_LEVEL`. TLS certificate/key paths live in `config.json`; certificates are hot-reloaded when enabled.

The administrator key authorizes server management and must stay on the server or in the server owner's browser session. Device keys authorize one workstation and may be shared by that workstation's three Agents. Mobile pairing issues a distinct, revocable mobile credential; it does not copy the administrator key into the app.

### API and protocol

Public health and runtime configuration endpoints require no administrator key. Management endpoints for instances, keys, archives, logs, mobile devices, and pairing require `x-admin-key`. Agent carriers authenticate with the device key and begin with protocol-v1 `hello`/`hello.ack`. Requests and responses use stable IDs; event frames have monotonic sequence numbers for replay. See the Chinese reference above and the source under `lib/` for the complete route and frame catalog.

### Tests and operations

```bash
npm test
npm run test:mobile-smoke
```

The suite covers relay authentication, three-Agent device-key sharing, Agent selection, installer syntax/dry runs, transcript rendering, WebSocket and HTTP transports, replay, approval response, liveness, key rotation/revocation, and multi-machine isolation. Production deployments should use a TLS reverse proxy, allow WebSocket upgrade, disable buffering for SSE/long polling, protect the data directory, and monitor the systemd journal.

### License

MIT. Third-party names and brand marks are used only for compatibility identification and remain owned by their respective rights holders.
