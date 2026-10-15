# 开发工具入口

从仓库根目录运行以下命令。主线客户端位于 `apps/tauri`；Electron、Expo 工具保留用于兼容回归，不能作为 Tauri 验收结果。脚本文件保留原路径，避免破坏历史调用。

| 任务 | 推荐入口 | 范围 |
| --- | --- | --- |
| 日常静态检查 | `pnpm check` | 结构检查、主线前端语法、原有 Node/旧客户端语法检查 |
| 目录与模块约束 | `pnpm structure:check` | `check-structure.js`：仓库结构和依赖边界 |
| 主线前端语法 | `pnpm check:frontend` | `check-syntax.js frontend`：递归检查 Tauri `src` 中的 JS/MJS/CJS，新模块自动纳入 |
| 原有语法检查 | `pnpm check:legacy` | `check-syntax.js legacy`：保留原检查文件集合，包含旧客户端、Node 服务、TUI 和共享协议 |
| Node 回归 | `pnpm test:node`（`pnpm test` 兼容） | 根目录 `tests/*.test.js`；串行执行 |
| 主线前端单测 | `pnpm test:frontend` | `apps/tauri/tests/*.test.js` |
| 主线浏览器验收 | `pnpm --dir apps/tauri test:browser` | 浏览器桥接模拟，不替代原生或网络验收 |
| 真实核心联调 | `pnpm tauri:test:runtime` | Rust `ui_bridge` 与前端真实节点验收 |
| 版本一致性 | `pnpm version:check` | `verify-versions.js` |

原生核心和宿主继续使用 `cargo test -p pickdrop-core --locked`、`cargo test -p pickdrop-tauri --lib --locked` 与 `cargo check -p pickdrop-tauri --locked`。根 `check` 不启动 GUI、模拟器或打包。

## 工具归属

| 类别 | 脚本或入口 | 说明 |
| --- | --- | --- |
| Tauri 主线 | `tauri-release-manifest.js`、`sign-tauri-preview-apk.js` | 汇总当前安装包与内部预览 APK 签名；签名工具仍读取 Expo 自带的公开调试证书，不能删除该依赖来源 |
| Linux TUI | `package-linux.js`、`tui-visual-smoke.js` | `pnpm linux:package`、`pnpm tui:visual`；TUI 仍在支持范围内，不归入废弃客户端 |
| Electron 兼容 | `desktop-*-smoke.js`、`desktop-test-windows.js`、`desktop-pages-preview.js`、`prepare-desktop.js`、`archive-mac.js` | 旧桌面验收、演示和打包；可能启动或操作真实窗口 |
| Expo 兼容 | `mobile-ui-smoke.js`、`sync-mobile-android-icons.js`、`generate-mobile-paw-animals.js` | 旧手机 UI 验收及资源同步；演示输出归入 `docs/archive/ui-concepts` |
| 历史发布 | `release-manifest.js` | 旧版安装包清单，不能替代 Tauri 发布清单 |
| 品牌资源 | `generate-brand-assets.js`、`generate-desktop-paw-icons.js` | 历史名称保留；会改写品牌和旧客户端图标，需要外部 `sharp` 工具环境 |
| Android 开发 | `run-android-emulator.sh` | 启动本地模拟器；属于显式开发操作，不由静态检查触发 |

## 旧客户端兼容命令

新文档和 CI 使用 `legacy:` 前缀。旧命令保留别名，行为不变：

| 推荐入口 | 兼容别名 |
| --- | --- |
| `legacy:start` | `start:legacy` |
| `legacy:desktop:prepare` | `desktop:prepare` |
| `legacy:desktop:package` | `desktop:package:legacy` |
| `legacy:desktop:package:windows` | `desktop:package:windows:legacy` |
| `legacy:desktop:smoke/motion/visual/requests/quit/peer/lifecycle` | 对应的 `desktop:smoke/motion/visual/requests/quit/peer/lifecycle`（每个名称是独立命令） |
| `legacy:mobile:start/web/smoke` | 对应的 `mobile:start:legacy`、`mobile:web:legacy`、`mobile:smoke:legacy` |
| `legacy:mobile:check`、`legacy:mobile:export` | `mobile:check`、`mobile:export` |

`start`、`desktop:package`、`desktop:package:windows`、`mobile:start`、`mobile:web`、`mobile:smoke` 继续指向现有 Tauri 主线。不要仅凭命令中出现 desktop/mobile 就将其改成旧客户端命令。

`.github/workflows/ci.yml` 执行根 `check`，独立 Tauri 工作流也执行结构与前端语法检查；旧 Android 工作流显式使用 `legacy:mobile:check`。修改命令时保留这两条独立检查入口。
