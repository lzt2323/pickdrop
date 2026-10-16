# 开发工具入口

仓库只维护 Tauri 客户端与 Rust 核心。Node.js 仅用于前端开发、测试及发布工具，不作为安装后应用的运行服务。

| 任务 | 入口 |
| --- | --- |
| 结构与前端语法检查 | `pnpm check` |
| 工程及发布工具测试 | `pnpm test:node` |
| 前端单元测试 | `pnpm test:frontend` |
| 上述两类测试 | `pnpm test` |
| 浏览器交互验收 | `pnpm --dir apps/tauri test:browser` |
| 入群轮询、重试与关闭竞态验收 | `pnpm --dir apps/tauri test:join` |
| 真实 Rust 节点联调 | `pnpm tauri:test:runtime` |
| 包、Rust、原生版本与发布说明检查 | `pnpm version:check` |
| Android release 扫码反射入口检查 | `ANDROID_HOME=<sdk> node scripts/verify-android-scanner.js <release.apk>` |

`check-structure.js` 管理目录与模块边界；`check-syntax.js frontend` 递归检查前端源文件。Rust 验证使用 Cargo，浏览器测试不能替代真机验收。

`tauri-release-manifest.js` 汇总 macOS、Windows、Android 安装包及 Linux x64 Rust TUI 归档，生成 SHA-256 清单。`sign-tauri-preview-apk.js` 使用 [公开预览测试证书](fixtures/README.md)，保持既有预览安装的签名身份，不依赖 Expo。`run-android-emulator.sh` 在已有 ARM64 模拟器或显式指定设备上构建、覆盖安装并启动 Tauri 预览，属于主动开发操作。

Electron、Expo、Node TUI 的构建、验收与旧资源生成脚本已退役；品牌素材本身保留。CI 与发布只调用当前工具。`test-rust-tui.py` 通过真实 PTY 和两个生产 Rust 进程验证终端、审批、消息、文件哈希及重启，输出到 .build/reports/rust-tui。

浏览器截图与报告统一保存到仓库根 `.build/reports/`，发布流水线输入与安装包汇总使用 `.build/release/`。既有输出备份位于 `.build/history/`，不作为当前验收结果。

## 0.6.0 直接下载发行

稳定版使用独立 `app.pickdrop` 标识。`sign-android-release.js unsigned.apk release.apk` 要求 `ANDROID_HOME`、`PICKDROP_KEYSTORE`、`PICKDROP_KEYSTORE_PASSWORD_FILE`，别名 `pickdrop-release`。私钥及密码仅保存在仓库外，密码通过文件传给签名工具；签名后校验 APK，拒绝公开预览证书。不要上传 keystore 或密码文件，保留安全备份才能持续更新 APK。

`sign-tauri-preview-apk.js` 仅允许隔离预览包。旧自动 Release 工作流仅处理含预发布后缀的标签，不能用公开测试密钥自动发布稳定版。0.6.0 的四端包在本地/远程原生构建与校验后手动上传；Mac 为 ad-hoc 签名、未公证，Windows 无可信签名，不能声称已取得操作系统发行者认证。

## README 示意动画

`node scripts/render-readme-demo.mjs` 从 `assets/readme/demo.html` 的固定时间轴生成 GIF、MP4 和静态图。需要仓库 Playwright Chromium 与 FFmpeg（可用 `FFMPEG` 指定路径）；中间帧放在忽略的 `.build/reports/readme-demo/frames/`。分镜、尺寸与重现步骤见 [制作说明](../assets/readme/README.md)。此脚本不连接真实设备。
