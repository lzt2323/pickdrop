# 当前工程状态

更新日期：2026-10-15。开发版本：`0.6.0-alpha.2`，Android `versionCode: 6001`。主线仅为 Rust/Tauri；目标与边界见 [PROJECT.md](PROJECT.md)，版本及回退见 [CONTRIBUTING.md](../CONTRIBUTING.md)。

## 已完成

- 前端传输、Rust 文件/网络/HTTP/迁移、宿主文件授权/系统文件/窗口命令按职责拆分；保持协议与数据格式。
- 已失效的历史原型、设计材料、阶段评审与旧客户端指南及配套截图从当前分支删除，通过 Git 历史追溯。目录导航、工程决策、工具入口和结构检查已接入 CI。
- 按用户 Rust-only 指令删除 Electron、Expo、Node 服务、旧共享运行代码、Node TUI，以及专属工具、旧回归测试、依赖和构建/发布任务。
- 保留旧 JS 产生的签名 JSON fixtures，Rust 协议兼容测试和非破坏性旧桌面数据导入继续运行；不依赖旧服务源码。
- Node 仅用于前端和开发工具，pnpm 工作区只包含根与 `apps/tauri`。主线构建不再安装 Electron、Expo 或 Node 服务依赖。
- Android 预览签名从 Expo 解除依赖，沿用原公开测试证书。证书字节 SHA-256 与证书指纹已核对，详见 [证书来源](../scripts/fixtures/README.md)。包名和用户数据目录不变。
- 所有存活包版本统一为 alpha.2，Cargo.lock 与 pnpm-lock.yaml 同步更新；旧发布说明保持历史事实，新增 alpha.2 说明。

## 本轮职责重构

- 核心新增 pairing.rs 与 sync.rs，分别归拢邀请/审批/入群和同步调度/连接/在线状态；HTTP 请求实现归 http.rs，Core 保留公共入口和协调。
- 宿主将窗口坐标、尺寸、缩放和边缘判定移入 docking/geometry.rs；原生窗口操作和持久化仍由 docking.rs 管理。
- 前端拆出 join-request.js 管理入群轮询、并发去重与停止；页面保留 DOM、焦点和导航。修复审批和 bootstrap 迟到结果在面板关闭/替换后触发导航的问题。
- 结构检查约束入群领域模块不能依赖页面或原生桥接；新增浏览器竞态回归并接入 CI。未新增依赖、公开命令或数据格式。
- 清除已退役 apps/mobile、apps/tui 的忽略构建和依赖残留，apps 下只保留 tauri。原有移动端构建备份及 debug.keystore 保存在忽略目录 .build/history/workspace/retired-mobile-backup-20261015。

## 版本管理

当前工作分支为 `refactor/rust-domain-boundaries`。`b30873b` 是退役前完整源码回退点，`8bd412c` 完成 Rust-only 退役与 alpha.2 版本更新。本轮按宿主、核心、前端与文档分别提交，具体提交以 git log 为准。没有推送、合并、创建标签或发布安装包。

工作开始前已有的 AGENTS.md 修改保持原样，未纳入本轮提交。需要旧程序时在独立 worktree 检出回退提交；不要覆盖当前工作区或让旧版读取新版数据。

## 本轮验证

- 结构检查、主线 JS 语法、版本一致性及前端生产构建通过。
- Rust 核心 26 项、宿主 17 项、前端 17 项、工具 12 项测试通过，宿主 cargo check --locked --offline 通过。工具测试包括结构 9 项、发布清单 3 项。
- 完整浏览器 smoke 通过；新增入群浏览器回归通过重试、拒绝焦点、请求和 bootstrap 迟到时关闭/替换面板场景。
- 使用本轮源码重新构建 ui_bridge，真实双 Rust 节点通过邀请审批、双向文字、512 KiB 文件 SHA-256、名称持久化、缓存清理、成员移除及窗口尺寸检查，页面错误为空。
- 子代理环境不能监听核心网络测试；主代理已重跑完整核心及真实双节点验收。
- 上轮冻结锁文件安装已通过，本轮未改依赖或锁文件。本机 pnpm 为 11.25.0，仓库/CI 固定 11.19.0。

本轮没有重新打包/安装 APK，没有验证 Android 实机升级；同签名和构建号检查不能替代实际安装。没有新做 macOS/Windows/iOS GUI 真机验收。历史 Node 测试不计入当前结果。

## 已知范围与下一步

1. Node Linux TUI 尚未迁移，此次退役其源码与安装包，没有 Rust TUI 替代；不能宣称完成其功能迁移。当前 CI 只交付 macOS、Windows、Android 预览包。
2. iOS 外部分享接收扩展仍未迁移，iOS 构建签名和真机验收仍需完成。
3. 继续验证网络切换、大文件、扫码、前后台和原生窗口；优先对 alpha.2 同签名 APK 做安装升级及跨设备文件回归。
4. 前端群组面板仍由 main.js 组装；整体抽取会增加大量回调，当前仅抽取可独立测试的生命周期。后续按具体维护问题继续收敛，不按行数机械拆分。

## 目录清理补充

- 删除 docs/archive 的 493 个历史文件及 docs/mini-group-design.html，共 494 个文件；维护文档不再链接已删除资料。
- 浏览器报告固定到仓库根 .build/reports，发布输入和汇总改为 .build/release；已有散落输出移动至 .build/history。
- 删除旧 Expo 路径忽略配置，禁止历史原型目录及根 artifacts/dist 回归。工具链默认 target、apps/tauri/dist、gen 保留。
- 本轮只改资料、工具输出路径和检查规则，不修改产品行为。结构与链接检查、前端和改动脚本语法、版本检查、13 项工具测试通过；浏览器 smoke 与真实双 Rust 节点验收通过，新截图和报告确实写入 .build/reports，未重建散落 artifacts 目录。CI 发布路径已同步但未运行远端发布或重新签名 APK。
