[中文](#中文) | [English](#english)

# Web console artwork

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

- `a2s-icon.png`：服务端控制台默认 A2S 标识，原样复制自仓库根目录 `ICON/icon（白色背景）`。
- `a2s-logo.png`：项目方提供的透明横向 A2S 标识，原样复制自 `ICON/icon（透明背景）`，保留给控制台横向品牌位使用。
- `brands/claude.svg`、`brands/openai.svg`、`brands/deepseek.svg`：Agent 切换时使用的真实品牌图形，来源和许可与 `A2Switch/assets/brands/README.md` 相同。

控制台使用固定方形尺寸和 `contain` 蒙版渲染 Agent 图标，侧栏收缩或文字变长时不会改变图标宽高比。

## English

- `a2s-icon.png`: default server-console mark, copied unchanged from the white-background image in the root `ICON` directory.
- `a2s-logo.png`: transparent horizontal A2S mark supplied by the project owner and reserved for horizontal branding slots.
- `brands/claude.svg`, `brands/openai.svg`, and `brands/deepseek.svg`: Agent switcher marks with the same sources and licenses documented in `A2Switch/assets/brands/README.md`.

The console renders Agent icons in fixed square containers with `contain` sizing, so a narrow sidebar or long label cannot distort their aspect ratios.
