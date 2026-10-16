<div align="center">
  <img src="assets/brand/app-icon.png" width="80" height="80" alt="拾传 Logo">
  <h1>拾传 · PickDrop</h1>
  <p>在你的设备之间，像聊天一样传文件。</p>
  <p>macOS · Windows · Android · Linux 终端</p>
  <p><a href="#下载安装">下载安装</a> · <a href="#开始使用">开始使用</a> · <a href="#常见问题">常见问题</a></p>
</div>

拾传是一款局域网文件传输工具，支持在电脑、手机和 Linux 终端之间发送文件、图片与文字。

[![Mac 发送文件，Windows、Android 和 Linux 接收，手机回复文字。](assets/readme/demo.gif)](assets/readme/demo.mp4)

<p align="center"><a href="assets/readme/demo.mp4">观看视频</a></p>

## 主要功能

- **群组互传**：把常用设备加入同一个群，集中收发资料与消息。
- **确认发送**：拖入文件或粘贴图片后，先检查附件和目标群组，再发送。
- **按需接收**：在需要的设备上下载文件，接收后可打开、另存或分享。
- **随手使用**：桌面窗口可固定或贴边收起，手机全屏操作，Linux 通过终端使用。

## 下载安装

在需要互传的设备上分别安装 **v0.6.0**。

| 平台 | 下载 | 安装方式 |
| --- | --- | --- |
| macOS · Apple 芯片 | [下载 Mac 版](https://github.com/lzt2323/pickdrop/releases/download/v0.6.0/PickDrop-0.6.0-macOS-arm64.zip) | 解压，将“拾传.app”拖到“应用程序”后打开 |
| Windows · x64 | [下载安装程序](https://github.com/lzt2323/pickdrop/releases/download/v0.6.0/PickDrop-0.6.0-Windows-x64-setup.exe) | 打开安装程序，按向导完成安装 |
| Android · ARM64 | [下载 APK](https://github.com/lzt2323/pickdrop/releases/download/v0.6.0/PickDrop-0.6.0-Android-arm64.apk) | 在手机上打开 APK，按系统提示允许该来源安装 |
| Linux · x64 | [下载终端版](https://github.com/lzt2323/pickdrop/releases/download/v0.6.0/PickDrop-0.6.0-Linux-x64-tui.tar.gz) | 解压，在该目录打开终端并运行 `./pickdrop` |

Android 需要 7.0 或更新版本；Linux 包已在 Ubuntu 22.04 x64 验证。暂不提供 iPhone、Intel Mac 和 Linux ARM64 安装包。[发布说明与文件校验值](https://github.com/lzt2323/pickdrop/releases/tag/v0.6.0)

<details>
<summary>首次安装遇到系统提示？</summary>

Mac 包尚未经过 Apple 公证，Windows 包没有可信发布者签名，系统可能阻止打开。确认文件来自本项目的 Release 后，Mac 可在“系统设置 → 隐私与安全性”查看打开选项，Windows 可在提示中查看“更多信息”。Android 按系统提示允许安装即可，无需开启开发者调试。

</details>

<details>
<summary>之前安装过“拾传 Preview”？</summary>

Mac、Windows 和 Android 正式版与 Preview 可以同时安装。首次打开正式版需要重新入群，旧聊天记录仍在旧应用中，不会自动迁移。请保留旧应用和数据，先保存需要的文件。

</details>

### Linux：一键安装或手动下载

**方式一 · 一键安装**（Linux x64，glibc 2.35+，如 Ubuntu 22.04）：

```sh
curl -fsSL https://raw.githubusercontent.com/lzt2323/pickdrop/main/scripts/install-linux.sh | sh
```

需要 `curl`、`tar` 和 `sha256sum`。脚本下载并校验 v0.6.0，安装到 `~/.local/bin/pickdrop`，无需 `sudo`，不会修改聊天记录或文件。安装后运行 `pickdrop`；若提示找不到命令，可运行 `~/.local/bin/pickdrop`。重复执行会重装脚本指定的正式版本；后续发布升级版时会同步更新脚本。

**方式二 · 手动安装**：下载上表中的 Linux 压缩包，解压后在该目录运行 `./pickdrop`。适合离线传入安装包或自行选择存放位置；可对照 [SHA256SUMS.txt](https://github.com/lzt2323/pickdrop/releases/download/v0.6.0/SHA256SUMS.txt) 检查下载文件。

## 开始使用

让两台设备连接同一个可信 Wi-Fi 或彼此可访问的局域网，并打开拾传。首次出现局域网访问提示时允许访问；手机在传输期间保持前台运行。

### 1. 连接另一台设备

<a href="assets/readme/onboarding.mp4"><picture><source media="(prefers-reduced-motion: reduce)" srcset="assets/readme/onboarding-poster.png"><img src="assets/readme/onboarding.gif" alt="实际界面操作：电脑创建群组并邀请，手机申请加入，电脑在成员页允许，手机收到消息。"></picture></a>

[观看操作视频 · 24 秒](assets/readme/onboarding.mp4)

1. 在第一台设备点击 **创建群组**，填写群名并创建。
2. 点击群内右上角的 **邀请 +**，在“邀请设备”页面查看二维码或点击 **复制邀请链接**。
3. 在第二台设备点击 **加入群组**，粘贴链接；Android 也可选择 **扫描二维码**。
4. 点击 **申请加入**，回到第一台设备，点击群名下方的设备在线数量，在“成员与加入申请”中点击 **允许**。

两台设备进入同一个群后，就可以互发文字和文件。使用邀请码加入时，需要同时填写邀请页面提供的设备地址与端口。

### 2. 发送第一个文件

1. 将一个小文件拖入电脑上的群聊，也可以使用文件选择入口。
2. 检查待发附件和当前群组，点击 **发送**。
3. 在另一台设备点击文件卡片上的 **接收文件**，等待接收完成。
4. 点击 **保存** 选择位置，再打开保存的文件。

**另一台设备能打开收到的文件，就完成了第一次传输。** 接收完成前，请保持持有文件的设备在线。

<details>
<summary>Linux 终端怎么操作？</summary>

运行 `./pickdrop` 后，用 **↑ / ↓** 选择菜单，**Enter** 确认，**Esc** 返回，**i** 输入文字，**Ctrl+C** 退出。

从「邀请 / 加入」加入群组。发送文件时先在「发送文件」中暂存，再到「传输 / 草稿」确认发送；接收时在「群内文件」选择文件并确认保存路径。通过 SSH 操作时，文件位于运行拾传的服务器上。

</details>

## 常见问题

**设备连不上怎么办？** 先确认两端应用都在运行、已批准入群，并允许应用在可信网络中通过防火墙。访客 Wi-Fi 的设备隔离或 VPN 可能阻止连接；已加入同群时，可在设备连接入口尝试填写对方地址。

**为什么看到文件消息，却不能下载？** 文件不会上传到云端。至少需要一台持有文件副本的设备在线且可连接。让该设备重新打开拾传、恢复网络后再试；如果文件副本已被清理，需要重新发送。

**手机锁屏后还能继续传吗？** 不保证后台持续传输。请保持应用在前台，接收完成后再离开。

**能传敏感文件吗？** 当前传输未加密，仅适合可信局域网，不建议发送敏感内容。拾传也不提供云备份或断点续传。

## 反馈与许可

遇到问题，请在 [Issues](https://github.com/lzt2323/pickdrop/issues) 提供系统、应用版本、操作步骤和错误提示，注意去除个人信息。版本更新见 [Releases](https://github.com/lzt2323/pickdrop/releases)。

拾传采用 [MIT 许可证](LICENSE)。
