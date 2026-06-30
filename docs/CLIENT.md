# Relay Hub 客户端形态

## 目标

同一仓库同时交付浏览器插件和桌面客户端。浏览器插件继续保持现有 MV3 结构，桌面客户端复用 `pages/index.html` 和 `src/app.js` 的主 UI / 业务逻辑，通过桌面宿主层提供存储、网络请求、剪贴板和外链能力。

## 首版技术选型

客户端当前提供 Electron 和 Tauri 两个宿主实现。Electron 是保守稳定路径，Tauri 是轻量测试路径。

选择 Electron 的原因：

- 后续认证兜底依赖真实页面登录，Electron 内置 Chromium，和用户日常 Chrome / Edge 登录链路更接近。
- New API / Sub2API 私有部署差异较大，Chromium 对 Turnstile、跳转、localStorage、cookie、WebAuthn/2FA 等页面能力兼容性更可控。
- 现有 UI 是静态 HTML/JS，可以直接作为 iframe 加载，迁移成本低。
- Node 主进程可以直接发起 HTTP 请求，客户端场景没有浏览器页面 CORS 限制。
- 主进程、preload、renderer 边界清晰，适合把系统钥匙串、会话托管、交互式登录窗口逐步接入。

Tauri 已作为轻量客户端工程加入，路径为 `client/tauri/`。你的目标站点限定为 New API / Sub2API，主要卡点是 Turnstile，因此 Tauri 值得直接测试。Windows 上 Tauri 使用 WebView2，内核同属 Chromium 系，预期风险较低；macOS / Linux 仍需按目标站点实测。

## 目录结构

```text
client/electron/
├── index.html      # Electron 客户端外壳，加载共享 UI
├── main.js         # Electron 主进程：窗口、持久化、网络、剪贴板
├── preload.js      # 安全暴露 relayHub API
└── renderer.js     # 复用扩展 shell 消息协议

client/tauri/
├── index.html      # Tauri 客户端外壳，加载共享 UI
├── tauri-shell.js  # Tauri 前端消息桥
└── src-tauri/      # Rust 后端和 Tauri 配置
```

共享部分：

```text
pages/index.html    # 主界面
src/host.js         # 共享宿主适配接口，屏蔽扩展 / 客户端差异
src/app.js          # 状态、渲染、CPA / 渠道逻辑
```

浏览器插件部分保持不变：

```text
pages/popup.html
pages/sidepanel.html
src/shell.js
src/background.js
manifest.json
```

## 宿主接口

`src/app.js` 只依赖 `window.RelayHost`。浏览器扩展和桌面客户端都实现同一组宿主能力：

```text
getStore / setStore
requestStore / requestOpenMode / setOpenMode
fetch
copyText
openExternal
openSidePanel
readSiteTokens
onStoreData / onOpenModeData
```

这层接口让业务代码可以继续复用，同时把存储、网络、剪贴板、外链、交互式登录等平台差异留在宿主层。

## 宿主能力映射

| 能力 | 浏览器插件 | 桌面客户端 |
|------|------------|------------|
| 配置存储 | `src/shell.js` localStorage | Electron userData/store.json；Tauri `%APPDATA%/io.github.ender049.relayhub/store.json` |
| 网络请求 | `src/background.js` fetch | Electron 主进程 fetch；Tauri Rust reqwest |
| 剪贴板 | shell Clipboard API | Electron clipboard；Tauri clipboard-manager |
| 外链打开 | `src/shell.js` -> 浏览器窗口 | Electron shell.openExternal；Tauri opener |
| 侧边栏 | Chrome sidePanel | 客户端单窗口布局 |
| 读取浏览器标签 token / 登录窗口 token | Chrome tabs + scripting | Tauri 内置登录窗口；Electron 当前返回明确占位提示 |

## 渠道认证策略

客户端版默认策略：

1. 用户填写渠道站点、用户名和密码。
2. 客户端优先走后台自动登录。
3. 遇到 Turnstile 或登录接口拦截时，用户在渠道表单点击“打开登录窗口”。
4. Tauri 打开独立 WebView 登录窗口，并尝试代填当前渠道的用户名和密码。
5. 用户手动完成 Turnstile 和登录提交。
6. 回到主窗口点击“读取令牌”。
7. Tauri 从登录窗口读取 localStorage、sessionStorage 和 cookie，并回填到当前渠道表单。
8. 手动 token / 系统访问令牌保留为高级兼容入口。

当前完整登录接管闭环落在 Tauri 客户端。Electron 骨架保留同名宿主接口，返回明确提示。

Sub2API 会回填访问令牌和刷新令牌。New API 会回填访问令牌，并尽量通过登录窗口数据或 `/api/user/self` 补齐 `New-Api-User` 数字用户 ID；若站点没有暴露用户 ID，需要手动填写。

## 运行

安装依赖：

```bash
npm install
```

启动客户端：

```bash
npm run client        # Electron
npm run client:tauri  # Tauri
```

检查语法：

```bash
npm run check
```

Tauri 打包：

```bash
npm run build:tauri
```

浏览器插件打包仍使用：

```bash
npm run package:extension
```

`package-extension.py` 使用固定文件列表，客户端文件不会进入浏览器扩展 zip。
