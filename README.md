<div align="center">
  <img src="assets/brand/app-icon.png" width="80" height="80" alt="拾传 Logo">
  <h1>拾传 · PickDrop</h1>
  <p><strong>像聊天一样，在你的设备之间传文字和文件。</strong></p>
  <p>macOS · Windows · Android · Linux 终端</p>
  <p><a href="#快速开始">快速开始</a> · <a href="crates/pickdrop-tui/README.md">Linux TUI</a> · <a href="docs/README.md">文档</a> · <a href="CONTRIBUTING.md">参与开发</a></p>
</div>

把电脑、手机和 Linux 终端加入同一个群：从 Mac 发一份文件，在 Windows 或手机上接收，也可以把服务器上的文件直接发到群里。文字和历史保存在本地，文件由接收端按需下载。

[![四端互联功能示意：Mac 暂存并确认发送文件，Windows、Android 和 Linux 分别接收，Android 回复文字。](assets/readme/demo.gif)](assets/readme/demo.mp4)

<p align="center"><a href="assets/readme/demo.mp4">观看清晰版视频 · 18 秒</a> · <a href="assets/readme/poster.png">查看静态图</a> · <a href="assets/readme/README.md">动画源码与制作说明</a></p>

> **功能示意动画，非实机录屏。** 界面经过简化，时间经过压缩，不代表实测速度。流程为：加入同群 → 文件暂存 → 确认发送 → 各端确认接收、下载并校验 → 手机回复文字。Linux 展示的是终端客户端。

## 可以用它做什么

- **把多台设备当作一个收件箱。** 文字、图片和文件在同一个群里交流；不同场景可以建立不同群组。
- **确认之后再发送。** 选择、拖入或粘贴的附件先进入草稿。确认发送后才发布文件消息，发送期间切群不会改变目标。
- **在需要的设备上接收。** 查看传输状态，下载后校验文件大小与 SHA-256，再打开、另存为或交给系统分享。
- **让窗口适应你的工作。** 桌面支持固定窗口、贴边收起和恢复；手机使用全屏界面；Linux 使用键盘操作，无需图形桌面。

## 平台与版本

当前源码为 **0.6.0-alpha.15**，处于 Rust / Tauri 迁移预览阶段。以下是当前主线的实现范围，具体平台验收记录见 [工程状态](docs/STATUS.md)。

| 平台 | 客户端 | 获取与运行 |
| --- | --- | --- |
| macOS | Tauri 桌面应用 | 从源码运行或构建桌面预览包 |
| Windows | Tauri 桌面应用 | 从源码运行或构建 NSIS 安装包 |
| Android | Tauri 手机应用 | 从源码运行或构建 ARM64 APK |
| Linux | Rust TUI 终端客户端 | Cargo 构建；可通过 SSH 操作 |
| iOS | 保留工程入口 | 构建、签名及真机验收未完成；暂不作为可用版本推荐 |

**下载前请确认版本：** 截至 2026-10-17，[公开 Releases](https://github.com/lzt2323/shichuan/releases) 最新为历史版本 `v0.5.1`，不对应本页的当前预览实现。体验当前主线请按下面的源码步骤启动；CI 构建产物不等于已经发布的安装包。

## 快速开始

### 1. 启动客户端

**macOS / Windows**：准备 Git、Node.js 24 或更新版本、`pnpm 11.19.0`、仓库指定的 Rust 工具链，以及 [Tauri 对应系统的构建依赖](https://v2.tauri.app/start/prerequisites/)。这些是开发环境依赖，安装后的应用不需要 Node 服务。

```sh
git clone https://github.com/lzt2323/shichuan.git
cd shichuan
pnpm install --frozen-lockfile
pnpm start
```

成功启动后会打开拾传预览窗口。Rust 版本由仓库的 `rust-toolchain.toml` 指定，首次构建需要下载依赖。

**Android**：在同一源码目录完成依赖安装，准备 JDK 17、SDK 36、NDK `27.2.12479018`，连接已授权 USB 调试的手机，然后运行：

```sh
pnpm tauri:android:init
pnpm mobile:start
```

**Linux 终端**：准备 Git 和 Rust 工具链，克隆仓库后在仓库根目录运行；仅构建 TUI 不需要 Node 或图形桌面。

```sh
cargo build --release -p pickdrop-tui --locked
./target/release/pickdrop --data-dir "$HOME/.local/share/pickdrop"
```

成功启动后进入终端菜单。方向键选择，Enter 确认，`i` 输入文字，Ctrl+C 退出。文件路径属于运行 TUI 的机器；通过 SSH 使用时分配 TTY（`ssh -t`）。详见 [TUI 使用说明](crates/pickdrop-tui/README.md)。

### 2. 将两台设备加入同群

1. 让两台设备接入可互通的可信局域网，并保持客户端运行。
2. 在第一台设备创建群组，从邀请入口取得邀请链接或邀请码。
3. 在第二台设备加入该群，回到第一台设备批准加入申请。
4. 在群内发送一条文字，确认另一台设备也能看到。

### 3. 完成第一次文件传输

1. 在发送端选择一个小文件。桌面也可以直接拖入窗口；文件先出现在待发草稿中。
2. 确认当前群组，点击发送。TUI 从「发送文件」暂存，再到「传输 / 草稿」确认发送。
3. 在另一台设备打开文件消息，选择接收或保存位置，等待下载与校验完成。
4. 打开接收后的文件，检查内容。

**完成标志：接收端已经保存并能打开文件。** 发送端显示已发送，表示文件消息已发布，不等于其他设备已下载。下载期间请保持发送端运行，且至少有一个文件副本可达。

## 更多用法

| 你想做的事 | 入口或说明 |
| --- | --- |
| 建立多个传输场景 | 创建不同群组，在群列表中切换；发送前确认目标 |
| 从手机其他应用分享文件 | Android 系统分享中选择拾传，进入草稿后确认发送 |
| 找不到同群设备 | 检查局域网、应用监听地址及防火墙；在设备连接入口尝试手动填写同群设备地址 |
| 在 Linux 上选择文件与保存目录 | [TUI 菜单、按键、监听设置与保存路径](crates/pickdrop-tui/README.md) |
| 导入旧桌面数据或回退 | [显式导入与迁移说明](docs/tauri-migration.md)；源数据不改写 |
| 构建安装包、运行测试 | [开发命令](scripts/README.md)与[贡献指南](CONTRIBUTING.md) |

## 当前边界

拾传面向**可信局域网内的个人多设备和小范围协作**。设备发现使用 mDNS 等本地发现机制；跨网段需要自行保证路由和文件服务可达。能够 SSH 登录不等于文件传输端口可达。

- 当前协议有设备签名，**没有 TLS 或端到端加密**，不适合直接暴露到不可信网络。
- 没有云中继、云备份或断点续传，也不保证离线送达、手机后台长期在线。
- 接收由用户主动触发，不会自动下载群里的全部文件；只有消息同步成功不能证明文件下载方向可达。
- iOS 外部分享接收扩展尚未迁移，构建签名和真机能力仍待验证。
- 当前应用使用预览标识 `app.pickdrop.tauri.preview` 和隔离数据目录。升级、导入旧数据前请阅读迁移说明。

## 开发与贡献

当前主线采用 **共享 Rust 核心 + Tauri 2 客户端 + Rust TUI**。Electron、Expo、Node 服务和旧 Node TUI 已从当前分支退役，历史实现可通过 Git 历史追溯。

| 目录 | 职责 |
| --- | --- |
| [`crates/pickdrop-core/`](crates/pickdrop-core) | 群组、身份、消息同步、文件与协议 |
| [`apps/tauri/`](apps/tauri) | 桌面和手机界面、原生系统适配 |
| [`crates/pickdrop-tui/`](crates/pickdrop-tui) | Linux 终端交互与文件操作 |
| [`assets/readme/`](assets/readme) | 本页示意动画、视频与可复现源码 |

提交改动前请阅读 [贡献指南](CONTRIBUTING.md)，按改动范围运行检查。基础入口：

```sh
pnpm check
pnpm version:check
pnpm test
cargo test -p pickdrop-core -p pickdrop-tui --locked
```

浏览器测试不能代替原生文件提供商、系统分享、手机前后台与桌面窗口的真机验收。完整验证要求见贡献指南。

遇到问题请在 [Issues](https://github.com/lzt2323/shichuan/issues) 提供系统、应用版本、复现步骤和去除隐私的错误信息。项目目标见 [PROJECT.md](docs/PROJECT.md)，待办和验证记录见 [STATUS.md](docs/STATUS.md)，本次开发版本变更见 [alpha.15 说明](docs/releases/v0.6.0-alpha.15.md)。

采用 [MIT 许可证](LICENSE)。
