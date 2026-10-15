# Tauri 迁移与版本管理

> 2026-10-15 更新：当前 alpha.2 仅维护 Rust/Tauri，旧 Node 服务、Electron/Expo 和 Node TUI 已退役。下文保留迁移当时的旧入口和验收记录；旧源码请在独立 worktree 检出 `b30873b`，不在当前目录运行 legacy 命令。当前验证以 [STATUS.md](STATUS.md) 为准。


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

2026-10-12，版本 `0.6.0-alpha.1`：

- 旧实现 320 项 Node 回归、新核心 20 项 Rust 测试、前端 5 项单元测试及浏览器验收通过；原生文件范围与安全导出文件名 2 项测试通过。
- 两个真实 Rust 节点通过邀请审批、双向消息、512 KiB 文件 SHA-256 对照；390px 前端连接真实核心，接收行正确更新且没有错误提示，输入保留已有消息节点。
- 1004 条历史事件重复执行 100 次无变化合并，没有重新验证历史签名或写盘。该测试验证同步工作量，不代表手机帧率测量。
- macOS Apple Silicon release 应用约 13.8 MiB，ZIP 约 4.8 MiB；Android ARM64 release 预览 APK 约 19.2 MiB，包含离线二维码识别。与旧包比较须保持相同架构和分发形式。
- Mac 原生窗口固定、隐藏、停靠展开/收起、多窗口、文件选择及重启恢复已验证。实际 Android 手机与 Mac 完成加入、双向文本、二进制和 PNG 文件同步；真机发现的接收行 DOM 更新异常及图片 MIME 问题已修复。Android 升级和冷重启保留记录，PNG 保存到系统相册后 SHA-256 与原文件一致，系统分享面板识别正确文件名。
- 重启验收定位到 Android 把 VPN 的 tun0 地址当作 Wi-Fi 地址；启动与每 4 秒刷新现在优先物理 LAN，已补充 Android 网卡顺序、Mac 虚拟接口和 IPv6 地址格式测试。Android 使用系统 NSD 注册/发现并绑定物理 Wi-Fi 网络，回调直接进入 Rust；发现提示严格校验，只有签名同步能确认成员在线并持久化新地址。发现提示安全边界及换端口重启后文本/文件恢复测试通过。
- 局域网可能跨 AP 过滤组播，即使系统 NSD 正确注册也不能保证自动发现。监听端口单独保存到 `network.json`；成员页可输入同群设备邀请页的地址，完成身份与签名确认后保存连接。实际关闭监听器再重启、端口占用回退、伪签名/错误群身份拒绝测试均通过。真机以成员页完成一次签名地址恢复后，Android 与 Mac 同时冷重启仍恢复两台在线，并继续接收新消息；1 MiB 二进制文件另存为后 SHA-256 与原文件一致。
- iOS 原生壳已有源码，但没有完成 IPA 构建、签名或真机验收；iOS 接收系统分享仍需 Share Extension。网络切换、大文件压力、扫码摄像头和持续帧率需要进一步真机验证。

桌面旧数据可显式导入到新的空目录，源数据不会改写：

```sh
cargo run -p pickdrop-core --example import_legacy -- OLD_DIRECTORY NEW_EMPTY_DIRECTORY
```

导入校验签名和文件，保留设备身份并拒绝覆盖已有目标。旧手机 SecureStore 身份不自动搬迁，需重新加入或走导出流程。
