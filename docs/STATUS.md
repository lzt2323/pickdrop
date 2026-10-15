# 当前工程状态

更新日期：2026-10-15。版本：0.6.0-alpha.1。目标与模块约束见 [PROJECT.md](PROJECT.md)，开发检查见 [CONTRIBUTING.md](../CONTRIBUTING.md)。

## 已完成：仓库目录治理

- 增加 [文档导航](README.md)、[目录治理决策](DECISIONS.md) 和 [工具命令导航](../scripts/README.md)，根 README 与 CONTRIBUTING 明确主线/TUI/旧客户端的维护边界。
- `docs/ui-review/` 与 `docs/ui-concepts/` 整体迁入 `docs/archive/`；旧设备验证与动物邀请说明迁入 `docs/archive/legacy/`，旧客户端指南迁入 `docs/legacy/`。共迁移 488 个资料文件，保留素材和历史证据。
- `plans/motion-before.json` 移到 `docs/archive/ui-review/motion-before.json`，移除空 `plans/`。今后的待办写入本文件，不再建立平行计划目录。
- 旧 Electron/Expo 命令提供 `legacy:` 前缀；原有 37 个脚本名称全部保留为原入口或兼容别名。提供 `test:node`、`test:frontend`、`check:frontend`、`check:legacy`。
- `pnpm structure:check` 检查根目录和文档分区、维护文档本地链接、前端字面量依赖边界及循环。根 `pnpm check` 和独立 Tauri CI 已接入检查；新增 7 项结构回归，覆盖违规目录、循环、越界导入、断链、注释/字符串误报和不同 JS 扩展名。
- 未移动运行中的源码包，未删除本地构建产物、安装包、用户数据或验收截图。依赖与锁文件不变。

本轮目录治理验证：`pnpm check`、`pnpm version:check`、前端 12 项单测、Vite production build 通过；原有效的 1112 条归档本地资源引用无新增断链，18 个归档生成脚本语法通过，实际重新生成 66 屏图册且结果与迁移前逐字节一致。命令别名无循环，CI 中直接引用的 pnpm 命令均存在。`pnpm test:node` 全量 325/325 通过（原 320 项加初版 5 项结构回归）；随后审查修复检查器的注释/字符串误报并覆盖 MJS/CJS，定向重跑最终 7 项结构回归全部通过，`git diff --check` 通过。本轮未修改业务源码，因此未重复上一阶段已通过的 Rust 和真机相关检查；未新做 GUI 或手机真机验收。

## 已完成：主线职责重构

- 前端传输流程抽入 `apps/tauri/src/file-transfers.js`，统一发送、接收、重试、草稿并发保护及终态进度；入口保留页面渲染和交互绑定。新增 5 项传输回归测试。
- Rust 核心按文件/缓存、网络、HTTP、旧数据导入拆分为 `files.rs`、`network.rs`、`http.rs`、`migration.rs`；`lib.rs` 从 1856 行降至 1221 行。
- 原生宿主拆分为 `host.rs`、`native_files.rs`、`window_commands.rs`；`lib.rs` 保留启动、命令注册、核心转发和生命周期，缩至 258 行。已有权限和图片测试随领域迁移。
- 修正 PROJECT.md 的相对链接，明确模块归属和开发约束；README 增加架构与进度入口。

## 文档清理

删除 8 份已由最终记录覆盖的旧稿：`plans/001-preserve-transfer-controls.md`、`002-debounce-native-collapse.md`、`003-optional-dialog-entry.md`、`README.md`、`motion-recon.md`、`motion-review-before.md`，以及 `docs/ui-review/2026-10-13-visual-before.md`、`2026-10-13-auto-edge-research.md`。保留报告内相关引用已更新；维护文档中的链接已更新；旧路径仅用于记录删除和迁移历史。

保留发布与回退记录、工程约定、当前客户端说明、仍使用的设计索引/素材来源、独有真机证据和包含未完成要求的交接稿。历史评分数据现为 `docs/archive/ui-review/motion-before.json`，仍被最终动效报告使用。

## 决策与边界

采用现有架构内的渐进拆分，避免整体重写、引入框架或新增依赖。公开 Core API、Tauri 命令、平台条件、持久化格式、签名协议与发送确认流程保持不变。旧 Electron/Expo、Node 服务和 Linux TUI 仍承担兼容与实际运行职责，本轮保留。

本轮属于可维护性改进，没有做性能基准测试，不宣称运行速度或内存占用提升。新增模块没有以公开 API 暴露 Rust 内部实现。

## 上一阶段代码职责重构验证

| 检查 | 结果 |
| --- | --- |
| 版本一致性 `node scripts/verify-versions.js` | 通过 |
| Node 回归 `node --test --test-concurrency=1 tests/*.test.js` | 320/320 通过 |
| Rust 核心 `cargo test -p pickdrop-core --locked --offline` | 25/25 通过，含协议兼容与真实节点 |
| 原生宿主 `cargo test -p pickdrop-tauri --lib --locked --offline` | 15/15 通过 |
| 原生宿主 `cargo check -p pickdrop-tauri --locked --offline` | 通过 |
| 前端 `pnpm --dir apps/tauri test` | 12/12 通过 |
| 前端 `pnpm --dir apps/tauri build` | 通过 |
| 浏览器 `apps/tauri/tests/browser-smoke.mjs` | 通过 |
| 文件/窗口 `apps/tauri/tests/file-window-regression.mjs` | 8 组通过，页面错误为空 |
| 真实节点 `tests/tauri-runtime-smoke.mjs` | 双节点邀请审批、双向文字、512 KiB 文件 SHA-256、名称持久化、成员移除与界面状态通过，页面错误为空 |
| `git diff --check` | 通过 |

网络测试首次在沙箱中无法监听端口；获准在沙箱外重跑后通过。浏览器证据是自动化交互，不能替代本轮未执行的 macOS GUI、Windows、Android、iOS 真机验收。历史原生证据见迁移和保留的 UI 验收记录，不能当作本轮新结果。

## 剩余任务与下一步

1. `main.js` 仍包含群组面板、消息展示与窗口交互；核心 `lib.rs` 仍包含群组/同步协调。后续按明确维护需求逐项拆分，避免纯粹按行数切文件。
2. 动物胶囊交接中的悬停焦点、碰撞排布及松手吸附等需求须结合现有窗口状态机单独评估和验收，不能因代码拆分标为完成。
3. 网络切换、大文件压力、摄像头扫码、前后台及持续帧率继续做真机验证；iOS 构建签名和外部分享扩展仍未完成。
4. 下一步优先在 macOS 和 Android 对原生文件选择、打开/另存为、窗口隐藏恢复及传输中切群做一次实机回归；不把编译通过作为平台验收。

本轮未提交、合并或发布。
