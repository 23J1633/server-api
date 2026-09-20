[中文](#中文) | [English](#english)

# server-api UI artifacts

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
| scripts | 跨仓库验收脚本 / cross-repository acceptance scripts | [23J1633/scripts](https://www.github.com/23J1633/scripts) |
| ICON | A2S 品牌源图 / A2S brand source artwork | [23J1633/ICON](https://www.github.com/23J1633/ICON) |
| artifacts | 脱敏交付验证产物 / sanitized delivery evidence | [23J1633/artifacts](https://www.github.com/23J1633/artifacts) |

- `ui-a2s-login.png`：未填写管理密钥时的 A2S 默认品牌标识与登录设置页。
- `ui-claude-brand.png`、`ui-codex-brand.png`、`ui-dsh-brand.png`：真实服务连接下切换三个 Agent 后的动态品牌图标；左上角、中央欢迎区、标题和输入提示会一起切换。
- `ui-machine-switcher.png`：机器下拉框按设备去重，只出现机器，不再把三个 Agent 当成三台机器。
- `ui-agent-switcher.png`：点击左上角原有品牌图标/字标打开当前机器的 Agent 切换菜单。
- `ui-claude-live-complete.png`、`ui-codex-live-complete.png`、`ui-dsh-live-complete.png`：三个真实 Agent 从网页发送唯一标记、收到流式输出并完成落库后的对话截图；每张都由脚本确认只有一个用户气泡和一个输入框。
- `ui-codex-trajectory.png`：真实 Codex 会话的轨迹页截图；验收脚本确认轨迹页没有输入框，并对轨迹提示做悬停、切页与残留清理检查。
- `ui-history-auto-load.png`：长 Codex 会话在一次持续向上滚动中连续拉取两页更早历史后的截图。
- `ui-codex-new-session.png`：从页面真实点击“新会话”后打开的空白 Codex thread；没有 `list_turns` 错误、伪造的更早历史提示或重复输入框。
- `ui-claude-history-restored.png`：全新浏览器分区中恢复的 Claude 原生旧对话；截图时测试工作区已经完成新建和重命名，截图后由同一 UI 流程移除（磁盘目录不变）。

`scripts/ui-smoke.cjs`、`scripts/ui-live-smoke.cjs`、`scripts/ui-history-smoke.cjs`、`scripts/ui-new-session-smoke.cjs` 与 `scripts/ui-claude-history-workspace-smoke.cjs` 使用独立的临时 Electron 分区写入管理密钥，不把密钥输出到日志或截图。它们分别验证品牌切换、真实流式对话、长历史连续加载、Codex 空白 thread，以及 Claude 历史/工作区管理。

## English

This directory contains auditable Web-console screenshots:

- `ui-a2s-login.png`: default A2S identity and login settings before an administrator key is entered.
- `ui-*-brand.png`: dynamic Claude, Codex, and DSH branding against the live service.
- `ui-machine-switcher.png` and `ui-agent-switcher.png`: device grouping and per-device Agent switching.
- `ui-*-live-complete.png`: real prompts, streaming output, and completed persistence for all three Agents.
- `ui-codex-trajectory.png`, `ui-history-auto-load.png`, and `ui-codex-new-session.png`: trajectory, multi-page history, and clean new-thread acceptance evidence.
- `ui-claude-history-restored.png`: restored native Claude history plus workspace create/rename/remove verification.

The `ui-*.cjs` smoke scripts use isolated temporary Electron partitions. Administrator keys are never printed in logs or screenshots. Together the scripts verify branding, real streaming conversations, continuous history loading, blank Codex threads, and Claude history/workspace management.
