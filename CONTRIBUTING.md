# 开发与版本管理

`main` 保存已验证版本，每项改动使用独立 `codex/` 分支并通过 Pull Request 合并。不要强制推送、改写已发布标签或覆盖旧发布资产。

## 目录与命令约束

开始工作先读 [项目边界](docs/PROJECT.md)、[当前状态](docs/STATUS.md) 和 [目录导航](docs/README.md)。新文件放入现有责任模块；当前规范放 `docs/`，旧客户端指南放 `docs/legacy/`，历史评审/原型/证据放 `docs/archive/`，发布说明放 `docs/releases/`。不再创建根目录 `plans/` 或平行的评审目录。

`pnpm check` 检查目录归属、维护文档链接、前端字面量依赖边界与循环，以及新旧 JS 语法。新增根目录或文档分区须先说明职责与依赖影响，在 `docs/DECISIONS.md` 记录原因，再更新 `scripts/check-structure.js`；不能为消除报错随意扩充允许列表。该检查不解析计算生成的 import，不代替编译和行为测试。

常用命令与工具归属见 [scripts/README.md](scripts/README.md)。默认 `start`、`mobile:start`、`desktop:package` 是 Tauri；旧客户端使用 `legacy:` 前缀。旧命令保留兼容别名。`pnpm test:node` 验证 Node/TUI/兼容逻辑，`pnpm test:frontend` 验证主线前端，二者不能互相替代。

## Tauri 版本

当前迁移分支 `codex/tauri-migration`，测试版本 `0.6.0-alpha.1`。回退基线为 `migration/tauri-base-20261012`（提交 `6c4262e`）。预览采用独立包名与数据目录，不能自动覆盖旧用户数据。

更新版本时同步根 package.json、apps/tauri/package.json、apps/tauri/src-tauri/Cargo.toml 与 tauri.conf.json、crates/pickdrop-core/Cargo.toml、内部 native 插件 Cargo.toml、apps/tui/package.json，以及保留作兼容参考的 apps/mobile/package.json 和 app.json。Android 构建号必须递增，并在 `docs/releases/v<版本>.md` 添加发布说明。

`node scripts/verify-versions.js` 校验版本。依赖更新必须同时提交 pnpm-lock.yaml 和 Cargo.lock，源码纳入 Git，安装包、target、gen、用户数据和私有签名不纳入 Git。

## 必须检查

```sh
pnpm install --frozen-lockfile
pnpm check
pnpm version:check
cargo test -p pickdrop-core --locked
cargo check -p pickdrop-tauri --locked
pnpm --dir apps/tauri test
pnpm --dir apps/tauri build
pnpm --dir apps/tauri test:browser
pnpm tauri:test:runtime
```

协议更改必须通过旧 JS 签名事件交叉测试和两节点真实传输测试；不能通过去掉签名校验来改善性能。桌面原生窗口与手机原生扫码、分享、相册、前后台和网络变化须分开验收。

## 构建与发布

`Tauri Preview` 在分支/PR 上验证 Rust 核心、前端和真实节点 UI，并构建 macOS、Windows、ARM64 Android。构建结果上传 Actions artifacts，不发布 Release。Android 使用独立预览包名及公开测试证书，正式版须另配私有签名；macOS 内测包采用 ad-hoc 签名，验证签名不等于公证。

稳定发布必须完成验证并合并 main 后，再由发布负责人创建附注 `v<版本>` 标签。统一 Release 工作流校验源码版本、构建 Tauri 桌面和 Android、保留 Linux TUI 包，汇总 SHA256 后发布预发布版本；已存在 Release 时拒绝覆盖。日常测试不要创建发布标签。

本次迁移不会自动发布或合并。历史 Electron/Expo 流程保留于 [旧版构建约定](docs/legacy/legacy-contributing.md)，主入口不再使用它们。
