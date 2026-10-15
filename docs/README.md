# 文档与仓库导航

## 当前开发入口

- [PROJECT.md](PROJECT.md)：产品范围、架构与模块责任。
- [STATUS.md](STATUS.md)：当前验证、未完成事项及下一步。
- [DECISIONS.md](DECISIONS.md)：结构与产品范围变化的原因。
- [工程规则](../AGENTS.md)、[开发与版本管理](../CONTRIBUTING.md)、[命令导航](../scripts/README.md)。
- [迁移与回退](tauri-migration.md)、[Android 模拟器](android-emulator.md)。
- [Rust 核心](../crates/pickdrop-core/README.md)、[Tauri 宿主](../apps/tauri/src-tauri/README.md)。

## 目录职责

| 路径 | 职责 |
| --- | --- |
| `apps/tauri/` | 唯一客户端、原生宿主和前端测试 |
| `crates/pickdrop-core/` | Rust 同步核心及集成测试 |
| `tests/` | 开发工具回归、真实双节点前端验收、旧 JS 协议兼容向量 |
| `scripts/`、`.github/` | 主线检查、构建与发布工具 |
| `assets/`、`vendor/` | 品牌资源与原生依赖补丁及来源 |
| `docs/archive/` | 历史方案、评审、旧客户端说明与实测证据，不是当前实现入口 |
| `docs/releases/` | 各版本说明；旧说明保持当时事实 |

`apps/desktop/`、`apps/mobile/`、`apps/tui/`、`server/`、`shared/` 已退役，不能重新加入工作区。Node 仅用于网页前端和开发工具，不运行产品服务。旧源码回退提交是 `b30873b`。

根目录保留工作区配置、锁文件、许可证和入口。忽略的 `node_modules/`、`target/`、`dist/`、`.build/`、`artifacts/` 为本地依赖与输出，不随源码整理删除。旧目录中已有的忽略数据和凭据也不由本次源码删除处理。

新任务和验证更新 STATUS；重要决策更新 DECISIONS。`pnpm structure:check` 与 CI 会拒绝旧源码目录重新出现，并检查当前目录和依赖约束。
