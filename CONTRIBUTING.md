# 开发与版本管理

当前仅开发 Rust/Tauri 版本。`main` 保存已验证版本；较大改动使用职责明确的 `feat/`、`fix/`、`refactor/` 或 `docs/` 分支，验证后以 Conventional Commits 分主题提交并通过 PR 合并。Agent 自有开发分支上的已验证改动按 AGENTS.md 自动提交；已有的无关修改保留在工作区。不要长期积累未提交源码，不强制推送、改写已发布标签或覆盖发布资产。

## 开始与目录

阅读 [工程规则](AGENTS.md)、[项目边界](docs/PROJECT.md)、[当前状态](docs/STATUS.md) 和 [目录导航](docs/README.md)。主线源码为 `apps/tauri/`、`crates/pickdrop-tui/` 与 `crates/pickdrop-core/`；协议夹具在 `tests/fixtures/`。旧运行实现只能从 Git 历史获取，不再增加 Electron/Expo/Node 服务或旧 Node TUI 分支。

`pnpm check` 校验目录、文档链接、前端字面量导入边界及循环和 JS 语法。新增根目录须说明职责并记录到 DECISIONS，再更新检查器。检查器不解析计算导入，不代替编译和行为验证。过期方案和截图从当前分支删除，通过 Git 历史追溯；发布记录放 `docs/releases/`，当前待办更新 STATUS。验收输出统一写入仓库根 `.build/reports/`，发布汇总写入 `.build/release/`，工具链默认输出目录保持不变。

Node 是前端与开发工具依赖，不是产品服务。工具入口见 [scripts/README.md](scripts/README.md)。

## 版本与回退

当前开发版本为 `0.6.0-alpha.15`；预览标识和数据目录不变。版本同时更新根 package.json、apps/tauri/package.json、核心、Rust TUI、Tauri 宿主与内部 native 插件 Cargo.toml、Cargo.lock、tauri.conf.json。Android `bundle.android.versionCode` 必须显式递增：alpha.1 为 6000，alpha.2 为 6001，alpha.3 为 6002，alpha.4 为 6003，alpha.5 为 6004，alpha.6 为 6005，alpha.7 为 6006，alpha.8 为 6007，alpha.9 为 6008，alpha.10 为 6009，alpha.11 为 6010，alpha.12 为 6011，alpha.13 为 6012，alpha.14 为 6013，alpha.15 为 6014，不能仅依靠忽略预发布尾缀的默认换算。

版本变化新增 `docs/releases/v<版本>.md`，不覆盖旧说明。`pnpm version:check` 校验版本及 Android 构建号。依赖变化同步 pnpm-lock.yaml；Rust 包版本/依赖变化同步 Cargo.lock。安装包、target、gen、用户数据、私有证书及工具本地记录不纳入 Git。

旧实现最后完整回退点为 `b30873b`（包含已验证的代码职责重构和目录治理）。需要旧版时使用独立目录：

```sh
git worktree add --detach ../pickdrop-legacy b30873b
```

不在有未提交工作或日常数据的目录执行 hard reset；旧版不能读取新版数据目录。旧桌面导入保持显式、非破坏性。

## 必须检查

```sh
pnpm install --frozen-lockfile
pnpm check
pnpm version:check
pnpm test
cargo test -p pickdrop-core --locked
cargo test -p pickdrop-tauri --lib --locked
cargo check -p pickdrop-tauri --locked
pnpm --dir apps/tauri build
pnpm --dir apps/tauri test:browser
pnpm --dir apps/tauri test:join
pnpm tauri:test:runtime
```

协议改动必须通过保留的旧 JS 签名向量和真实双节点测试。不要为减少依赖删除协议夹具或跳过授权检查。原生窗口、扫码、系统文件和前后台须按平台独立验收。

## 构建与发布

CI 验证主线并构建 macOS、Windows、Android ARM64 和 Linux x64 Rust TUI；不再打包 Node Linux TUI。iOS 需另行签名及验收。手动工作流只产出 artifacts。

Android 预览继续使用同一公开测试证书和独立包名，以保留预览升级能力；测试证书明确标注来源，不能用于正式发布。macOS ad-hoc 签名不等于公证。

发布前完成验证并合并 main，再由发布负责人创建附注 `v<版本>` 标签。Release 汇总上述 Tauri 包与 SHA256；已存在发布时拒绝覆盖。日常提交不打发布标签、不推送或发布，除非用户明确要求。
