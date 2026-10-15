# 拾传 · PickDrop

<img src="assets/brand/app-icon.png" width="96" height="96" alt="拾传 Logo">

局域网文件群聊。桌面与手机共用 Tauri 2 客户端和 Rust 核心，支持文字、文件、多群、邀请审批及本地历史。当前开发版本 **0.6.0-alpha.2**，仅维护 Rust/Tauri 实现。

[文档导航](docs/README.md) · [项目范围](docs/PROJECT.md) · [当前进度](docs/STATUS.md) · [开发命令](scripts/README.md) · [版本管理](CONTRIBUTING.md)

## 运行

开发需要 Node.js 24、仓库指定的 pnpm、Rust 和对应系统的 Tauri 依赖。Node 仅用于前端构建及测试，安装后的应用没有 Node 服务或 Electron/Expo 运行时。

```sh
pnpm install --frozen-lockfile
pnpm check
pnpm start
```

Android 使用 JDK 17、SDK 36、NDK 27.2.12479018；iOS 需要完整 Xcode 与签名。

```sh
pnpm tauri:android:init
pnpm mobile:start
pnpm tauri:android:build
pnpm tauri:ios:init
pnpm tauri:ios:build
```

## 使用与边界

设备接入可互通的可信局域网，创建群组，通过邀请和成员审批加入。选择、拖入或系统分享的文件先进入草稿，确认发送后传输；发送期间切群不会改变目标。接收文件校验后可打开、另存为或分享。

应用标识仍为 `app.pickdrop.tauri.preview`，使用隔离数据目录。旧桌面数据可以通过 Rust 工具显式导入，源数据不改写。迁移与回退见 [迁移说明](docs/tauri-migration.md)。

保留 `pickdrop-peer-v1` 签名协议；当前没有 TLS、端到端加密、云中继或断点续传，不保证手机后台长期在线。iOS 外部分享接收扩展仍未迁移，需另行开发与验收。

Electron、Expo、Node 服务和 Node Linux TUI 源码及发布入口已从当前分支退役。没有提供替代的 Rust TUI，也不再生成旧 Linux TUI 安装包；旧源码可从回退提交读取，现有发布资产和用户数据不受影响。

## 验证与发布

```sh
pnpm test
cargo test -p pickdrop-core --locked
cargo test -p pickdrop-tauri --lib --locked
cargo check -p pickdrop-tauri --locked
pnpm --dir apps/tauri build
pnpm --dir apps/tauri test:browser
pnpm tauri:test:runtime
```

协议兼容由保留的旧 JS 签名向量和 Rust 测试验证；真实双节点测试验证邀请、双向消息和文件 SHA-256。浏览器与编译不能代替手机扫码、文件提供商、相册、分享及桌面原生窗口验收。

CI 构建 macOS、Windows、Android ARM64 预览包。iOS 构建签名、真机及 Linux Rust 产品交付不在本次验证范围内。源码提交不会自动创建 Release；发布需单独审批和版本标签。

MIT 许可证。[本次版本说明](docs/releases/v0.6.0-alpha.2.md)
