# 文档与仓库导航

## 当前开发入口

- [PROJECT.md](PROJECT.md)：产品范围、架构与模块责任。
- [STATUS.md](STATUS.md)：当前验证、未完成事项及下一步。
- [DECISIONS.md](DECISIONS.md)：结构与产品范围变化的原因。
- [工程规则](../AGENTS.md)、[开发与版本管理](../CONTRIBUTING.md)、[命令导航](../scripts/README.md)。
- [迁移与回退](tauri-migration.md)、[Android 模拟器](android-emulator.md)。
- [Rust TUI](../crates/pickdrop-tui/README.md)、[Rust 核心](../crates/pickdrop-core/README.md)、[Tauri 宿主](../apps/tauri/src-tauri/README.md)。

- [README 动画源码与制作说明](../assets/readme/README.md)。

## 目录职责

| 路径 | 职责 |
| --- | --- |
| `apps/tauri/` | 桌面/移动客户端、原生宿主和前端测试 |
| `crates/pickdrop-tui/` | 轻量终端客户端、终端命令及适配测试 |
| `crates/pickdrop-core/` | Rust 同步核心及集成测试 |
| `tests/` | 开发工具回归、真实双节点前端验收、旧 JS 协议兼容向量 |
| `scripts/`、`.github/` | 主线检查、构建与发布工具 |
| `assets/`、`vendor/` | 品牌与 README 演示资源、原生依赖补丁及来源 |
| `docs/releases/` | 各版本说明；旧说明保持当时事实 |

`apps/desktop/`、`apps/mobile/`、`apps/tui/`、`server/`、`shared/` 已退役，不能重新加入工作区。Node 仅用于网页前端和开发工具，不运行产品服务。旧源码回退提交是 `b30873b`。

根目录保留工作区配置、锁文件、许可证和入口。已失效的设计原型、评审、旧客户端指南及配套截图已删除，需要追溯时查阅 Git 历史。当前迁移边界和发布说明继续保留。

## 本地输出

- `.build/reports/`：所有浏览器验收截图、报告；路径以仓库根解析，不受运行目录影响。
- `.build/release/`：发布输入与汇总安装包。
- `.build/history/`：本轮整理前的安装包、验收输出及备份，不作为当前验证证据。
- `target/`、`apps/tauri/dist/`、原生 `gen/`：工具链默认构建目录。
- `node_modules/`、`.pnpm-store/`：依赖与包缓存。

上述本地输出不提交 Git。不要再创建根目录或客户端目录下的 `artifacts/`、根目录 `dist/`，也不要把截图和临时报告写入 docs。

新任务和验证更新 STATUS；重要决策更新 DECISIONS。`pnpm structure:check` 与 CI 会拒绝旧源码目录重新出现，并检查当前目录和依赖约束。
