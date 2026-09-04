# Relay Hub

轻量的 Chrome / Edge 浏览器扩展，用于统一管理多个 CLI Proxy API (CPA) 服务端，并查看 New API / Sub2API 上游渠道账号信息。项目同时开始提供桌面客户端骨架，复用同一套主界面。

## 背景

[All API Hub](https://github.com/qixing-jk/all-api-hub) 是功能更完整、覆盖面更广的方案，适合需要一站式管理和更多高级能力的用户。但我个人日常用不上那么多功能，也更偏好简洁、轻便、打开就能看的工具。

所以 Relay Hub 最早是在原 CPA 汇总单 HTML 的基础上扩展而来：<https://github.com/ender049/cpapanel>。后来加入了 New API / Sub2API 渠道登录和同步能力。由于渠道登录后需要请求不同站点的用户侧接口，普通单 HTML 页面会受到浏览器 CORS 限制，因此项目改成了浏览器扩展形态，由扩展后台负责跨域请求转发。

Relay Hub 不是 All API Hub 的替代品，而是一个偏个人自用、轻量、聚合视图优先的工具。

## 相关项目

- [All API Hub](https://github.com/qixing-jk/all-api-hub)：完整功能更多的一站式管理工具。
- [cpapanel](https://github.com/ender049/cpapanel)：Relay Hub 最早扩展自这个 CPA 汇总单 HTML。

## 功能

- 管理多个 CPA 服务端。
- 查看 CPA 凭证文件、状态、提供商和配额信息。
- 管理 CPA 服务端 API Key。
- 配置 CPA 代理 URL、请求重试次数和路由策略。
- 管理 New API / Sub2API 渠道账号。
- 自动同步渠道余额、今日消费、累计消费、充值比例和可用分组。
- 支持 popup 和浏览器侧边栏，两者共用同一套界面。
- 提供 Electron / Tauri 桌面客户端骨架，复用主 UI 和业务逻辑。
- 支持浅色 / 深色主题和自动刷新。

## 安装

### 从源码加载

1. 下载或克隆本仓库。
2. 打开 Chrome / Edge 的扩展管理页。
3. 开启“开发者模式”。
4. 选择“加载已解压的扩展程序”。
5. 选择本项目目录。
6. 点击扩展图标打开 Relay Hub。

### 从压缩包加载

如果 GitHub Release 中提供了 `relay-hub-extension.zip`：

1. 下载并解压 zip。
2. 在浏览器扩展管理页选择“加载已解压的扩展程序”。
3. 选择解压后的目录。

## 使用说明

### CPA

CPA 页面用于管理 CLI Proxy API 服务端和凭证文件。

- `新增 CPA`：填写名称、CPA 地址和管理密钥。
- `凭证`：查看当前 CPA 的凭证文件、提供商、状态和配额。
- `API Key`：查看、复制、新增或删除 CPA 服务端 API Key。
- `设置`：管理代理 URL、请求重试次数和路由策略。
- `更多`：编辑或删除当前 CPA 配置。

CPA 地址支持直接填写主机、端口或完整 URL。面板会自动整理为可请求的管理端点。

### 渠道

渠道页面用于查看 New API / Sub2API 上游账号。

- `新增渠道`：填写名称、系统类型和站点地址。New API 支持账号密码优先同步，也可配置系统访问令牌和用户 ID 作为 Turnstile 兜底；Sub2API 支持账号密码优先同步，也可读取已登录站点的访问令牌和刷新令牌作为 Turnstile 兜底，并在过期时自动刷新。前后端分离站点请填写该站点的 API 域名，例如 `https://api.example.com`。
- `手动刷新`：重新同步当前渠道数据。
- `自动刷新`：控制当前渠道是否参与全局自动刷新。
- `密钥`：查看和管理渠道侧的用户 API Key。
- `监控`：点击渠道地址后的波形图标，直接查看渠道侧提供的只读监控数据。Sub2API V1 仅读取分组列表并展示分组级状态、模型、延迟、可用率和探测时间线；V2 展示按平台/分组聚合的被动指标；New API 展示最近 24 小时模型概览，展开单个模型时读取完整时间线。时间柱支持悬停或键盘聚焦查看详细指标。
- `更多`：打开充值入口、兑换充值码、编辑或删除当前渠道配置。

渠道余额、今日消费、累计消费和分组信息只来自接口同步，不提供手动填写，避免数据失真。手动字段只用于补充充值入口和充值比例。

## 桌面客户端

桌面客户端目前有两个宿主实现：

- `client/electron/`：Electron 版骨架，Chromium 行为一致，当前保留登录接管接口占位。
- `client/tauri/`：Tauri 版，包体更轻，已接入 New API / Sub2API + Turnstile 登录接管流程。

两者都加载同一套 `pages/index.html` / `src/host.js` / `src/app.js`，宿主层分别提供本地存储、网络请求、剪贴板和外链打开能力。

认证策略设计为：先尝试用户名密码自动登录；遇到 Turnstile 或登录接口拦截时，支持该能力的宿主打开登录页并代填已保存的用户名密码，用户完成验证和登录后点击“读取令牌”回填配置。浏览器扩展使用同域标签页，Tauri 使用独立 WebView2 登录窗口，Electron 当前关闭该入口。

运行方式：

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

Windows 单文件 exe 用 GitHub Actions 的 `Build Windows Client` workflow 生成，artifact 名称为 `relay-hub-windows`，文件名为 `relay-hub-tauri-windows-x86_64-single.exe`。Linux 下 GNU 交叉编译会输出 `relay-hub-tauri-windows-x86_64.exe`。

可测试产物统一放在：

```text
release/
```

详细说明见 [docs/CLIENT.md](docs/CLIENT.md) 和 [docs/TAURI.md](docs/TAURI.md)。

## 权限说明

扩展使用以下权限：

- `storage`：保存本地配置。
- `sidePanel`：打开浏览器侧边栏。
- `tabs`：定位当前标签页以打开侧边栏，或从已登录渠道页读取本地令牌。
- `scripting`：在用户当前打开的已登录渠道标签页执行一次性脚本，读取 `auth_token` 和 `refresh_token`。
- `<all_urls>`：由扩展后台请求用户配置的 CPA / New API / Sub2API 地址，绕过普通网页的 CORS 限制。

Relay Hub 不注入网页内容，不做遥测，不把配置上传到第三方服务。请求只会发往你自己配置的 CPA 服务端和渠道站点。

## 数据安全

- CPA 管理密钥、渠道账号、渠道密码、New API 系统访问令牌和 Sub2API 访问/刷新令牌保存在浏览器本地存储中。
- 本地存储只做简单混淆，不等同于加密。
- 不建议在共享电脑或不可信浏览器环境中保存敏感配置。
- 运行时数据通过接口实时获取，刷新后重新同步。

## 项目结构

```text
.
├── manifest.json          # Chrome / Edge MV3 扩展配置
├── src/
│   ├── background.js      # 扩展后台，请求转发和跨域访问
│   ├── shell.js           # 扩展外壳逻辑，存储同步、复制、请求桥接
│   ├── host.js            # 共享宿主适配接口
│   └── app.js             # 主要状态、渲染、请求和交互逻辑
├── scripts/
│   └── package-extension.py # 官方扩展打包脚本
├── client/
│   ├── electron/        # Electron 桌面客户端宿主层
│   └── tauri/           # Tauri 桌面客户端宿主层
├── pages/
│   ├── popup.html         # popup 外壳
│   ├── sidepanel.html     # side panel 外壳
│   └── index.html         # sandbox 应用页面、样式和模态框
├── assets/
│   └── relayhub.png       # 扩展图标
├── docs/
│   ├── CLIENT.md          # 桌面客户端说明
│   ├── DEVELOPMENT.md     # 开发说明
│   ├── PRIVACY.md         # 隐私说明
│   └── TAURI.md           # Tauri 客户端说明
└── LICENSE
```

## 开发

浏览器扩展无构建步骤。桌面客户端需要安装 Electron 依赖。

验证 JS 语法：

```bash
npm run check
```

官方打包命令：

```bash
python3 scripts/package-extension.py
```

扩展产物为 `release/relay-hub-extension.zip`。压缩包必须保留 `pages/`、`src/`、`assets/` 目录结构，不要使用 `python3 -m zipfile -c ...` 手动打包。

更多开发细节见 [docs/DEVELOPMENT.md](docs/DEVELOPMENT.md)。

## License

MIT
