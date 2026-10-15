# 文档与仓库导航

## 当前开发入口

| 文档 | 用途 |
| --- | --- |
| [PROJECT.md](PROJECT.md) | 产品范围、架构与模块职责 |
| [STATUS.md](STATUS.md) | 当前验证结果、剩余任务和下一步 |
| [DECISIONS.md](DECISIONS.md) | 重要结构决策与取舍 |
| [工程规则](../AGENT.md) / [开发约定](../CONTRIBUTING.md) | 修改、验证、版本和发布规则 |
| [工具命令](../scripts/README.md) | 主线、TUI、兼容工具的明确入口 |
| [迁移与回退](tauri-migration.md) | Tauri 迁移背景及非破坏性回退 |
| [Linux](linux.md) / [TUI 验收](tui-arrow-acceptance.md) | 当前终端客户端使用与验收 |
| [多设备协议](peer-groups.md) / [Android 模拟器](android-emulator.md) | 专项参考，注意文中所属客户端 |

## 资料分区

- [legacy/](legacy/)：仍可运行的旧 Electron/Expo 客户端指南，命令应使用明确的兼容入口。
- [archive/](archive/README.md)：历史原型、评审、验收和素材。保留证据及尚未实现的提议，不是当前计划；执行前回到 PROJECT 与 STATUS 核对。
- [releases/](releases/)：不可用当前验证覆盖的版本发布记录。

## 仓库所有权

| 路径 | 维护状态与职责 |
| --- | --- |
| `apps/tauri/` | 主线桌面与手机客户端、原生宿主、前端测试 |
| `crates/pickdrop-core/` | 主线 Rust 同步核心及集成测试 |
| `apps/tui/` | 当前 Linux Node 客户端 |
| `apps/desktop/`、`apps/mobile/` | 旧 Electron/Expo 兼容维护；不向其中新增主线功能 |
| `server/`、`shared/` | Node 服务和协议/通用逻辑，仍被 TUI 与旧客户端使用；不能整体当废弃代码删除 |
| `tests/` | Node 跨模块回归、结构检查、真实 Rust 节点前端集成 |
| `scripts/`、`.github/` | 开发检查、构建和 CI；按工具导航选入口 |
| `assets/`、`vendor/` | 品牌资源与已有原生依赖补丁；保留来源和许可 |
| `.hallmark/` | 已有设计工具记录，不是产品运行代码 |

根目录仅保留工作区配置、锁文件、许可证和开发入口。`node_modules/`、`target/`、`dist/`、`.build/`、`artifacts/` 为忽略的依赖或本地输出；不会因整理源码而删除本地验收记录或安装包。新增工具输出应放入已有输出目录，避免散落根目录。

新任务与当前结果更新 STATUS，架构决策更新 DECISIONS；无需为每个修改新建计划或交接文件。结构检查由 `pnpm structure:check` 和 CI 执行。
