# Relay Hub 开发说明

## 项目定位

Relay Hub 是一个 Chrome / Edge Manifest V3 浏览器扩展，用于聚合管理多个 CLI Proxy API (CPA) 服务端和 New API / Sub2API 上游渠道账号。

项目保持纯前端、无构建依赖。核心界面运行在 `pages/index.html` sandbox 页面中，popup 和 side panel 只是扩展外壳。

## 当前架构

```text
manifest.json
├── action.default_popup -> pages/popup.html
├── side_panel.default_path -> pages/sidepanel.html
├── sandbox.pages -> pages/index.html
└── background.service_worker -> src/background.js

pages/popup.html / pages/sidepanel.html
└── iframe sandbox app: pages/index.html

src/host.js
└── 共享宿主适配接口，供 src/app.js 调用存储、网络、剪贴板、外链和宿主能力

src/shell.js
├── 实现扩展宿主消息协议
├── 向 sandbox app 同步 localStorage 配置
├── 接收 app 的存储写入请求
├── 接收 app 的复制 / 外链请求
└── 将 app 的网络请求转交 src/background.js

src/background.js
└── 负责 CPA / 渠道请求转发，解决扩展内跨域访问问题
```

## 主要文件

| 文件 | 说明 |
|------|------|
| `manifest.json` | MV3 扩展配置、权限、popup、side panel、sandbox |
| `src/background.js` | 后台请求转发，区分 CPA 请求和渠道请求 |
| `pages/popup.html` | 扩展 popup 外壳 |
| `pages/sidepanel.html` | 浏览器侧边栏外壳 |
| `src/shell.js` | 扩展外壳逻辑，负责存储同步、复制桥接、请求桥接 |
| `src/host.js` | 共享宿主适配接口，屏蔽扩展与客户端差异 |
| `pages/index.html` | 主 UI、CSS、模态框和 SVG 图标 |
| `src/app.js` | 状态、渲染、CPA / 渠道请求、自动刷新和交互逻辑 |
| `assets/relayhub.png` | 扩展图标 |
| `scripts/package-extension.py` | 官方扩展打包脚本，保留 zip 内目录结构 |
| `client/electron/` | Electron 桌面客户端宿主层，复用主 UI，提供桌面端存储、网络和剪贴板能力 |
| `client/tauri/` | Tauri 桌面客户端宿主层，复用主 UI，提供轻量客户端测试路径 |
| `docs/CLIENT.md` | 桌面客户端结构、运行方式和渠道认证策略 |
| `docs/TAURI.md` | Tauri 客户端运行、打包和系统依赖说明 |

## 数据流

### 存储

扩展配置保存在外壳页面的 `localStorage` 中。Electron 配置保存在 `userData/store.json` 中。Tauri 配置保存在 `%APPDATA%/io.github.ender049.relayhub/store.json` 中。

`src/app.js` 只通过 `src/host.js` 读取和写入配置。扩展环境下，`src/shell.js` 会把以下 key 同步给 sandbox app：

- `apm_s`：CPA 服务端配置。
- `apm_ch`：渠道配置。
- `apm_tab`：当前 tab。
- `apm_font`：字体设置。
- `relay_theme`：主题。
- `apm_ar`：自动刷新间隔。

sandbox app 不能直接作为可信配置源。启动时以 shell 同步的数据为准，避免 popup / side panel 多实例互相覆盖配置。

### 网络请求

普通网页直接请求渠道站点会遇到 CORS 限制，所以扩展使用宿主桥接：

```text
src/app.js -> src/host.js -> src/shell.js -> chrome.runtime.sendMessage -> src/background.js -> fetch
```

桌面客户端使用相同的 app/host 调用点：

```text
src/app.js -> src/host.js -> client/electron/renderer.js -> Electron main -> fetch
```

CPA 请求和渠道请求都会经过 background，但处理策略不同：

- CPA 请求只保留必要请求头，避免浏览器受限头和伪装来源导致异常。
- 渠道请求会补充常见 Accept 请求头，并允许携带站点登录态。

### 复制

`pages/index.html` 是 sandbox 页面，不能可靠直接调用 `navigator.clipboard.writeText()`。复制操作统一由 host adapter 转给宿主层。

```text
src/app.js -> src/host.js -> 宿主 shell -> Clipboard API
```

## CPA 模块

CPA 对象表示一个 CLI Proxy API 服务端。

主要能力：

- 获取凭证文件列表。
- 查看凭证状态、账号、提供商、套餐和配额。
- 上传、下载、刷新、启用 / 禁用、删除凭证。
- 管理 CPA 服务端 API Key。
- 管理代理 URL、请求重试次数和路由策略。

主要接口路径：

| 功能 | 方法 | 路径 |
|------|------|------|
| 凭证文件列表 | GET | `/v0/management/auth-files` |
| 上传凭证文件 | POST | `/v0/management/auth-files` |
| 下载凭证文件 | GET | `/v0/management/auth-files/download?name=` |
| 删除凭证文件 | DELETE | `/v0/management/auth-files?name=` |
| 使用统计 | GET | `/v0/management/usage` |
| 完整配置 | GET | `/v0/management/config` |
| 代理请求 | POST | `/v0/management/api-call` |
| API Key 列表 | GET | `/v0/management/api-keys` |
| API Key 更新 | PUT | `/v0/management/api-keys` |
| API Key 删除 | DELETE | `/v0/management/api-keys?index=N` |
| 代理 URL | GET / PUT / DELETE | `/v0/management/proxy-url` |
| 重试次数 | GET / PUT / DELETE | `/v0/management/request-retry` |
| 路由策略 | GET / PUT / DELETE | `/v0/management/routing/strategy` |

## 渠道模块

渠道对象表示一个 New API / Sub2API 上游站点账号。

主要原则：

- 余额、今日消费、累计消费只来自接口同步。
- 分组只来自用户可用分组接口。
- 刷新时优先复用已保存 token 或登录会话。
- New API 支持系统访问令牌和用户 ID 作为账号密码登录失败后的兜底，主要用于 Turnstile 拦截登录接口的站点。
- Sub2API 支持访问令牌和刷新令牌作为账号密码登录失败后的兜底；前后端分离站点应填写 API 域名。
- Sub2API 保存刷新令牌后，访问令牌缺失、即将过期或接口返回 `401` 时会调用 `/api/v1/auth/refresh` 换新。
- 只有接口返回 `401` 时才清理运行时 token 并重新登录；配置中的 New API 系统访问令牌和 Sub2API 刷新令牌不自动清理。
- 手动字段只保留充值入口和充值比例。

New API 用户侧接口：

- `/api/user/self`
- `/api/user/self/groups`
- `/api/data/self`
- `/api/user/topup/info`
- `POST /api/user/topup`，请求体 `{ key }`，用于兑换充值码。

Sub2API 用户侧接口：

- 登录优先尝试 `/api/v1/auth/login`，仅在 `404` 类旧站点路径不匹配时继续尝试历史路径。
- 刷新令牌使用 `/api/v1/auth/refresh`。
- `/api/v1/auth/me`
- `/api/v1/usage/dashboard/stats`
- `/api/v1/payment/config`
- `/api/v1/groups/available`
- `POST /api/v1/redeem`，请求体 `{ code }`，用于兑换充值码。

## URL 处理

CPA 和渠道地址都需要先规范化再拼接路径。

注意事项：

- 去掉尾部多余 `/`。
- CPA 地址允许用户输入 `/v0/management` 后缀，但请求前会归一到基础地址。
- 拼接 API 路径时必须避免 `//v0/management/...` 这类双斜杠。
- CPA 管理密钥会清理隐藏字符和所有空白字符。

## UI 约定

- 顶部只保留产品名、主题切换、侧边栏入口、自动刷新和手动刷新。
- 主 tab 只有 `CPA` 和 `渠道`。
- CPA / 渠道卡片保持统一结构：状态点、名称、地址、右侧操作区。
- CPA 操作区为 `凭证` / `API Key` / `设置` / `更多`。
- CPA 设置弹窗优先读取 `/v0/management/config` 的真实配置，再用单项设置端点兜底。
- 渠道操作区固定两行：第一行 `手动刷新` / `自动刷新`，第二行 `密钥` / `更多`。
- 渠道 `更多` 菜单内放充值、兑换、编辑和删除。
- 表单 placeholder 不应包含真实个人信息。

## 客户端形态

桌面客户端加载同一套 `pages/index.html` / `src/host.js` / `src/app.js`。客户端宿主层通过与扩展 shell 相同的消息协议提供存储、网络请求、剪贴板和外链能力。详细设计见 `docs/CLIENT.md`。

当前有两个客户端宿主：

- `client/electron/`：Electron 版骨架，当前保留登录接管接口占位。
- `client/tauri/`：Tauri 版，包体更轻，已接入 New API / Sub2API + Turnstile 登录接管流程。

客户端认证策略是先尝试用户名密码自动登录；遇到 Turnstile 或登录接口拦截时，Tauri 打开内置登录窗口并代填当前渠道的用户名密码，用户完成真实登录后点击“读取令牌”回填配置。Sub2API 回填访问/刷新令牌，New API 回填访问令牌并尽量补齐用户 ID。

运行客户端：

```bash
npm install
npm run client        # Electron
npm run client:tauri  # Tauri
```

打包 Tauri：

```bash
npm run build:tauri
```

Linux 仅打 deb/rpm：

```bash
npm run build:tauri:linux
```

可测试产物统一复制到根目录 `release/`。Windows 单文件 exe 由 GitHub Actions 的 `Build Windows Client` workflow 在 MSVC 环境生成；Linux 交叉编译 Windows GNU 产物需要 MinGW，运行时需要把 `WebView2Loader.dll` 放在 exe 同目录。Linux Tauri 打包需要 Rust、Cargo、pkg-config 和 WebKitGTK 开发包，见 `docs/TAURI.md`。

## 开发命令

验证语法：

```bash
npm run check

# 或逐个检查
node --check src/app.js
node --check src/background.js
node --check src/shell.js
node --check client/electron/main.js
node --check client/electron/preload.js
node --check client/electron/renderer.js
```

官方打包命令：

```bash
python3 scripts/package-extension.py
```

扩展产物为 `release/relay-hub-extension.zip`。压缩包内必须包含 `manifest.json`、`pages/index.html`、`src/app.js`、`assets/relayhub.png` 等原始相对路径。不要使用 `python3 -m zipfile -c ...` 手动打包，因为它可能压平目录结构，导致扩展重新加载后仍不是最新代码。

本地静态预览仅用于查看 UI，渠道跨域和扩展权限相关能力需要在浏览器扩展环境中测试。

```bash
python3 -m http.server 8080
```

## 发布前检查

- `node --check src/app.js src/background.js src/shell.js` 全部通过。
- `manifest.json` 版本号已更新。
- 使用 `python3 scripts/package-extension.py` 生成发布 zip，并确认 zip 内保留 `pages/`、`src/`、`assets/` 目录。
- README 功能说明仍与当前 UI 一致；如添加截图，必须先使用脱敏示例数据。
- 不提交 `dist/`、`.crx`、`.pem`、`.playwright-mcp/` 等本地或打包产物。
- 如需分发 zip，把压缩包作为 GitHub Release asset 上传。
