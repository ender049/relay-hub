# Relay Hub Tauri 客户端

## 定位

Tauri 客户端是 Relay Hub 的轻量桌面宿主实现，复用同一套共享 UI：

```text
pages/index.html
src/host.js
src/app.js
```

Tauri 宿主层位于：

```text
client/tauri/
├── index.html
├── tauri-shell.js
└── src-tauri/
    ├── Cargo.toml
    ├── tauri.conf.json
    ├── capabilities/main-capability.json
    └── src/
        ├── lib.rs
        └── main.rs
```

## 已实现能力

- 本地配置存储：Tauri app data 目录下的 `store.json`。Windows 路径为 `%APPDATA%\\io.github.ender049.relayhub\\store.json`。
- CPA / 渠道 HTTP 请求：Rust 后端 `reqwest`，无浏览器 CORS 限制。
- 剪贴板写入：`tauri-plugin-clipboard-manager`。
- 外链打开：`tauri-plugin-opener`。
- 与 `src/host.js` 共享同一套宿主消息协议。

## 认证策略

Tauri 客户端优先复用现有账号密码自动登录逻辑。遇到 Turnstile 或站点登录接口拦截时，可在渠道编辑表单中使用登录接管流程：

1. 填写渠道站点、用户名和密码。
2. 点击“打开登录窗口”，Tauri 会打开独立 WebView 登录窗口。
3. 登录窗口加载完成后会尝试代填当前表单中的用户名和密码；提交登录仍由用户手动完成。
4. 用户在该窗口完成 Turnstile 和真实页面登录。
5. 回到主窗口点击“读取令牌”。
6. 客户端从登录窗口读取 localStorage、sessionStorage 和 cookie。
7. Sub2API 会回填访问令牌和刷新令牌；New API 会回填访问令牌并尽量补齐用户 ID。

New API 请求仍需要访问令牌和 `New-Api-User` 数字用户 ID。若站点没有在登录会话中暴露用户 ID，界面会提示确认用户 ID，用户可手动填写。

## 开发运行

```bash
npm install
npm run client:tauri
```

## 打包

当前平台默认打包：

```bash
npm run build:tauri
```

Linux 仅打 deb/rpm：

```bash
npm run build:tauri:linux
```

Windows 单文件 exe 建议用 GitHub Actions 的 `Build Windows Client` workflow 生成。产物会上传为 `relay-hub-windows` artifact，文件名为 `relay-hub-tauri-windows-x86_64-single.exe`。

Linux 交叉编译 Windows GNU exe 可执行：

```bash
npm run build:tauri:windows-gnu-exe
```

这需要系统已安装 MinGW 交叉链接器，例如 `x86_64-w64-mingw32-gcc`。GNU target 生成的 exe 依赖外置 `WebView2Loader.dll`，测试时把已下载的 DLL 放在 exe 同目录。

在 Windows/MSVC 环境生成单文件 exe 可执行：

```bash
npm run build:tauri:windows-msvc-exe
```

Linux 打包需要 Rust 工具链和 WebKitGTK 开发依赖。Ubuntu 24.04 常见依赖：

```bash
sudo apt-get update
sudo apt-get install -y \
  libwebkit2gtk-4.1-dev \
  libgtk-3-dev \
  libayatana-appindicator3-dev \
  librsvg2-dev \
  patchelf \
  pkg-config \
  build-essential \
  curl \
  wget \
  file
```

安装 Rust：

```bash
curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh -s -- -y --profile minimal
source "$HOME/.cargo/env"
```

打包完成后，可测试产物会统一复制到根目录：

```text
release/
```

Tauri 原始产物仍保留在：

```text
client/tauri/src-tauri/target/release/bundle/
```

桌面端窗口默认使用侧边栏尺寸和侧边栏界面。关闭或最小化窗口会隐藏到系统托盘，点击托盘图标或托盘菜单“打开”会恢复窗口，托盘菜单“退出”会结束进程。

Tauri identifier 为 `io.github.ender049.relayhub`。首次启动时，如果新目录没有配置，会从旧目录 `%APPDATA%\\works.earendil.relayhub\\store.json` 自动复制到 `%APPDATA%\\io.github.ender049.relayhub\\store.json`。

## 当前环境说明

本仓库已包含完整 Tauri 工程。若当前机器没有 Rust、Cargo、pkg-config 或 WebKitGTK 开发包，`npm run build:tauri` 会在系统依赖检查阶段失败。补齐依赖后可直接执行打包命令。
