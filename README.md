# 拾传 · PickDrop

<img src="assets/brand/app-icon.png" width="96" height="96" alt="拾传 Logo">

局域网文件群聊。桌面与手机共享 Tauri 2 客户端、Rust 同步核心和轻量网页界面，支持文字、文件、多群、邀请审批和本地历史。

当前源码版本 **0.6.0-alpha.1**，是独立安装的迁移预览。原 0.5.x 发布包仍可使用，新版没有覆盖旧版用户数据或替换已有 Release。旧客户端说明见 [0.5.x 使用指南](docs/legacy/legacy-client.md)，迁移与回退见 [Tauri 迁移记录](docs/tauri-migration.md)。

## 仓库入口

[文档导航与目录职责](docs/README.md) · [项目边界](docs/PROJECT.md) · [当前进度](docs/STATUS.md) · [开发命令](scripts/README.md)

主线源码在 `apps/tauri/` 和 `crates/pickdrop-core/`；`apps/tui/` 是仍维护的 Linux 客户端。`apps/desktop/`、`apps/mobile/` 为兼容维护的旧客户端，依赖的 `server/`、`shared/` 仍服务于 TUI。历史原型和评审统一在 `docs/archive/`，不作为当前任务入口。

## 运行

开发环境为 Node.js 24、pnpm 11、Rust（版本锁定于 rust-toolchain.toml）及对应系统的 Tauri 构建依赖。安装完成的应用不需要 Node.js、Expo Go 或开发服务器。

```sh
pnpm install --frozen-lockfile
pnpm version:check
pnpm start
```

Android 开发需要 JDK17、SDK36、NDK27.2.12479018；iOS 需要完整 Xcode 和签名。

```sh
pnpm tauri:android:init
pnpm mobile:start
pnpm tauri:android:build
pnpm tauri:ios:init
pnpm tauri:ios:build
```

原 Electron 入口为 `pnpm legacy:start`。旧桌面打包命令、手机启动与预览命令保留 `:legacy` 后缀，不会被打入 Tauri 安装包。

## 使用

1. 设备接入可以互相访问的局域网，创建群组或打开已保存群组。
2. 在「邀请」中复制地址和邀请码；手机可扫描邀请二维码。另一台设备申请后，由已有成员确认加入。
3. 输入文字并发送；选择或拖入文件后保留为待发草稿，点击发送才传送。发送期间切群不会改变目标。
4. 文件接收完成后可以打开、另存为或分享。Android 图片可保存到相册；手机系统分享进入应用后也需确认发送。
5. 桌面支持固定、隐藏恢复、多个窗口和贴边收起；手机使用全屏布局。

新应用采用 `app.pickdrop.tauri.preview` 标识和独立数据目录。保留旧版群组身份的桌面导入是显式、非破坏性操作，详见迁移文档；手机原 SecureStore 凭据需要重新加入或显式导出，不自动读取。

## 检查与构建

```sh
cargo test -p pickdrop-core --locked
pnpm --dir apps/tauri test
pnpm --dir apps/tauri build
pnpm --dir apps/tauri test:browser
pnpm tauri:test:runtime
pnpm tauri:build
```

`tauri:test:runtime` 使用两个真实 Rust 节点验证前端入群审批、双向消息和 SHA256 文件传输。浏览器测试不能替代手机原生扫码、键盘、文件提供商、相册和分享实测。Tauri Preview CI 构建 macOS、Windows 与 Android ARM64 安装包；iOS 源码已有原生壳，IPA 需要相应签名与构建环境。

新界面只更新变化的消息行，输入框不刷新聊天记录；历史分窗口读取，缩略图在原生后台生成。Rust 复用已验证事件，空同步不重验整个历史、不重写历史文件，文件传输使用流式校验。

## 协议与边界

延续设备签名的 `pickdrop-peer-v1`，通过局域网 HTTP 和 mDNS 发现、同步和文件传输。尚无 TLS 或端到端加密，面向可信局域网，不应开放公网。后台在线能力受手机系统限制；不保证离线投递、后台长时间传输或断点续传。

Linux TUI 暂保留 Node 实现。iOS 外部分享接收扩展尚未迁入；原生功能与构建验收情况分别记录于迁移文档，不把支持配置视为已经通过真机验证。

项目采用 MIT 许可证。[项目架构](docs/PROJECT.md) · [当前进度](docs/STATUS.md) · [版本管理](CONTRIBUTING.md) · [迁移记录](docs/tauri-migration.md) · [发布说明](docs/releases/v0.6.0-alpha.1.md)
