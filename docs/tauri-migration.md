# Tauri 迁移与版本管理

## 版本边界

- 原 Electron/Expo 开发状态完整保存在提交 `6c4262e`，标签 `migration/tauri-base-20261012`。
- 当前工作分支 `codex/tauri-migration`，版本 `0.6.0-alpha.1`。
- 桌面与手机的新入口位于 `apps/tauri`，共享核心位于 `crates/pickdrop-core`。新客户端运行不依赖 Node.js，Node/pnpm 只用于开发与前端构建。
- 新应用独立标识为 `app.pickdrop.tauri.preview`，存储目录与旧应用隔离。旧代码保留作兼容性参考和回退入口，不打进新安装包。
- root、Tauri、Rust、Expo 参考客户端和 TUI 的版本由 `node scripts/verify-versions.js` 检查。Cargo.lock 和 pnpm-lock.yaml 都纳入 Git。
- 不自动创建发布标签、不覆盖现有 GitHub Release，也不原地改写旧用户数据。

## 开发与构建

环境：Rust（见 rust-toolchain.toml）、Node.js 24、pnpm 11。桌面须具备 Tauri 对应系统依赖；Android 使用 JDK17、SDK36、NDK27.2.12479018；iOS 必须使用完整 Xcode 及合适的签名。

```sh
pnpm install --frozen-lockfile
pnpm version:check
cargo test -p pickdrop-core --locked
pnpm --dir apps/tauri test
pnpm --dir apps/tauri build
pnpm start
pnpm tauri:build
pnpm tauri:android:init
pnpm tauri:android:build
```

Android release APK 使用独立的内测包名。`scripts/sign-tauri-preview-apk.js` 只使用 Expo 提供的公开测试证书，不能用于正式发布；正式发布必须配置私有签名。选择 public key 与测试包名是为了使重复构建的测试 APK 可以升级安装，不能视为正式发布身份保证。

Tauri Preview 工作流对分支/PR 执行 Rust 与前端测试并构建 macOS、Windows 和 ARM64 Android；构建资产只上传到 Actions。iOS 原生壳随源码提供，IPA/真机签名需完整 Xcode 环境，不能从 Android 验证推断 iOS 已通过。

## 验证标准

1. Rust 接受旧 JS 产生的签名、事件 ID 和 Unicode 数据；新事件可被旧实现验证。
2. 无新事件的同步不重验历史、不重写群历史文件；有新事件时仅验证新增事件。
3. 两个真实 Rust 节点执行创建、申请、审批、双向消息、文件传输、重启恢复以及权限撤销。
4. 前端连接真实 Rust 核心验证关键流程；输入不改变已有消息节点，历史可以向前后分页，传输进度合并且结束立即显示。
5. 原生构建与手机真机验收分开记录：扫码、键盘、系统分享、相册、前后台切换、Wi-Fi 地址变化、大文件与取消都要实测。

## 回退

在新分支或独立 checkout 检出 `migration/tauri-base-20261012`。不在未提交工作的目录执行 hard reset，不将新版数据目录交给旧版打开。测试包与旧包可以并存，旧用户数据保持原位置。

## 当前验证记录

迁移前参考实现的 320 项 Node 测试全部通过。新版本的构建、互通与性能验证结果在本次集成完成后补充；仅有源码或配置不代表原生能力已验收。
