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

`check-structure.js` 管理目录与模块边界；`check-syntax.js frontend` 递归检查前端源文件。Rust 验证使用 Cargo，浏览器测试不能替代真机验收。

`tauri-release-manifest.js` 汇总 macOS、Windows、Android 安装包并生成 SHA-256 清单；当前未提供 Linux 安装包。`sign-tauri-preview-apk.js` 使用 [公开预览测试证书](fixtures/README.md)，保持既有预览安装的签名身份，不依赖 Expo。`run-android-emulator.sh` 在已有 ARM64 模拟器或显式指定设备上构建、覆盖安装并启动 Tauri 预览，属于主动开发操作。

Electron、Expo、Node TUI 的构建、验收与旧资源生成脚本已退役；品牌素材本身保留。CI 与发布只调用当前工具。
