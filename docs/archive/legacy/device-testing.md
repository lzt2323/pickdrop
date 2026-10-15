# 三台真机联调，不必先发布

> 历史资料：以下是 Electron / Expo 阶段的设备验证流程，不是当前 Tauri 入口。文中的 `pnpm start`、`pnpm mobile:start` 为当时命令；现在分别使用 `pnpm start:legacy`、`pnpm mobile:start:legacy`。当前开发与验收以仓库根目录 CONTRIBUTING.md 为准。

发布构建通过不等于跨设备网络验收通过。日常使用源码和 Android 调试包；发布前再使用内置 JS 的独立包，关闭开发服务完成验收。记录每端提交 SHA、系统、Wi-Fi IP/掩码、群模式以及实际群服务地址。邀请链接、授权码和设备私钥不要贴入公开日志。

## Mac 和 Windows

安装 Node.js 24 及仓库指定的 pnpm，检出同一提交后运行 `pnpm install --frozen-lockfile`。使用独立数据目录，避免测试改变日常群资料。

Mac 在仓库根目录：

```sh
PICKDROP_USER_DATA="$PWD/.build/device-test/mac" pnpm start
```

Windows PowerShell 在仓库根目录：

```powershell
$env:PICKDROP_USER_DATA = "$PWD\.build\device-test\windows"
pnpm start
```

修改主进程或服务代码后退出并重新运行；双方保持同一提交。Windows 首次运行 Electron 时，仅按需要允许可信私有网络的入站连接，不关闭整个防火墙。每个群有自己的 TCP 端口，只开放发现目录端口 47321 并不足够。

Windows 不方便配置源码时：使用 Actions → PickDrop Unified Release → Run workflow，选择测试分支，下载该次运行的 Windows artifact。手动分支构建不创建 Release，不需要打标签。

## Android：USB 调试 + 本地 JS

手机开启开发者选项和 USB 调试，连接 Mac，并在手机上确认这台电脑。`adb devices -l` 必须显示 `device`；空列表或 `unauthorized` 时不能继续安装。多台手机使用 `adb -s <序列号>` 指定目标。

项目有自定义局域网原生模块，Expo Go 不能代替这个应用。准备 JDK 17、Android SDK 36 后，在项目根目录运行：

```sh
adb reverse tcp:8081 tcp:8081
PICKDROP_ANDROID_DEBUG=1 pnpm --dir apps/mobile exec expo prebuild --platform android --no-install --clean
PICKDROP_ANDROID_DEBUG=1 pnpm --dir apps/mobile exec expo run:android --device
```

该命令构建安装原生 debug 应用并启动开发服务。`PICKDROP_ANDROID_DEBUG=1` 使用独立名称「拾传调试」及包名 `app.pickdrop.mobile.dev`，与已安装内测包并存。已有 `android` 目录的包名由生成时配置决定；不要假设修改环境变量能更新旧原生工程。需要切换配置时重新 prebuild（会重新生成原生目录，先保存原生改动）。

首次安装完成后，通常只需启动 `PICKDROP_ANDROID_DEBUG=1 pnpm --dir apps/mobile exec expo start --localhost` 并从手机调试应用加载本地开发服务；若未安装 expo-dev-client，使用原生 debug 应用自己的开发菜单/Reload，不扫描 Expo Go 二维码。JS 修改可刷新，原生 Kotlin、依赖或配置修改仍需重新编译。USB 的 8081 转发只提供开发 JS，**不代理群消息或文件流量**。

手机测试期间保持应用前台；当前后台会停止 peer 服务。先测试退出 Mac 上的 PickDrop 应用，保留 Metro。测试“Mac 整机断网/关机”时，换用下一节独立包，以免把 JS 开发服务断开误判为群连接失败。

## 独立包验收也不需要 Release

Actions → Android APK → Run workflow → 选择测试分支，下载 `installer-android` 中的 APK。该包内置 JS，不依赖 Metro；全平台测试可使用上面的统一手动工作流。记录工作流运行号和提交 SHA，避免同版本号的测试包混淆。测试修改需先提交并推送分支，未推送的本地改动不会进入 Actions 包。

Linux 可从同一提交运行 `pnpm tui`（前台退出会停止自己启动的服务），或使用统一构建产生的 Linux artifact。后台服务须显式 `pickdrop stop` 才算节点离线。

## 必须在真机上完成的验收

1. 新建测试 peer 群；两端只扫描 Mac 邀请加入，不先手工连接幸存者。旧托管群需先升级或新建，旧协议不能通过客户端版本自动变成 peer 群。
2. 三端前台运行，确认 Windows 与 Android 直接收发文字、文件。记录实际群地址和端口，而非仅记录 IP。
3. 完全退出 Mac 的 PickDrop，确认它的群服务端口不可达；Windows ↔ Android 双向发送新的文字和文件，核对内容。
4. Android 保持前台，重启 Windows 后重复；再重启 Android 后重复，检查地址恢复。
5. Mac 离线时尝试仅存于 Mac 的旧文件：应提示等待持有者；Mac 回归后可下载。新文件必须能在幸存者之间传输。
6. 使用独立 Android APK，停止 Metro、拔 USB、关闭 Mac 网络后重做第 3 项。Linux 加入同一测试矩阵，轮流退出任意一端。

失败时先区分：没有对方地址、地址存在但 TCP 不通、HTTP 可达但群授权失败。Windows 可用 `Test-NetConnection <对方IP> -Port <实际群端口>`；HTTP 探测可访问 `http://<IP>:<群端口>/api/peer/info`。从 Mac 探测两端都成功，不能证明 Windows 与 Android 相互可达；必须从实际通信端测试。

`172.29.9.5` 与 `172.29.5.94` 在 `/16` 下属于同一地址范围，仍可能被校园网/企业 Wi-Fi 的客户端隔离或 ACL 阻断。不能仅凭 IP 第三段判断，也不能仅凭 ping 失败判断 TCP 不通。广播发现失败可用地址补连；若 TCP 也被隔离，需要网络调整或额外的可达中继。当前程序没有通用 NAT 穿透或云中继，手动输入 IP 并不能绕过隔离。

参考：[React Native 真机运行](https://reactnative.dev/docs/running-on-device)、[Expo 本地构建](https://docs.expo.dev/guides/local-app-overview/)。

## 2026-10-10 通信修复验收

本轮使用独立群与数据目录：Mac 创建群，Windows 运行当前源码的群服务，Android 安装含内置 JS 的 `app.pickdrop.mobile.dev` 原生包。Windows 测试服务通过 SSH 控制，群消息及文件实际经 Wi-Fi 直传；未替换用户原 Windows 应用或迁移旧群。

- 现场发现并修复 Android 默认网络为 VPN 时发布隧道地址的问题。VPN 保持开启，监听及 UDP 发现选择物理 Wi-Fi。
- 现场发现并修复桌面 Node HTTP 的 chunked 请求不被 Android 原生服务接受的问题；请求体显式发送 UTF-8 `Content-Length`。严格原生 framing 回归在旧实现下失败、修复后通过。
- 两个成员仅经 Mac 邀请加入。完全停止 Mac 群服务并确认端口不可达后，Windows 与 Android 双向新文字成功。
- Android → Windows 的 32,789 字节随机文件、Windows → Android 的 1,027 字节随机文件均校验 SHA-256 一致；后者通过手机系统保存面板保存后从手机读取核对。
- Mac 仍离线时重启 Android 进程，原群和 Windows 新消息自动恢复，无需重新加入。
- 完整 Node 回归 277 项通过；Windows 实际系统上的三组源码回归 30 项通过。最终 Mac 安装包的三个真实 Electron 进程通过创建者端口关闭后的双向文字与文件验收。

Mac、Windows 包内关键源码与工作区逐字节核对；手机已安装 APK 与交付 APK 的 SHA-256 一致。测试包及构建清单保存在 `artifacts/peer-fix/`。这不代表已验证 Windows 新 GUI 包安装升级、真实 DHCP 切换、所有 VPN 策略或手机后台常驻；上述场景仍需分别验收。

## 2026-10-10～11 桌面包、整机重启与换址验收

本轮三端使用同一个多设备测试群 `37f0fa2f-4df0-4d1f-9d53-1ed8760d90fa`。Mac 和 Windows 均运行真实打包桌面界面；Android 使用内置 JS 的独立 `app.pickdrop.mobile.dev` 包。仅在初次加入时通过 Mac 邀请批准，后续未重新建群、重新邀请或手工补录成员地址。原用户应用及群未替换。

- 完全退出 Mac 桌面程序，确认群端口 `55739` 连接拒绝后，Windows GUI 与 Android 双向发送新文字。
- Windows 桌面程序重启、替换为修复测试包后，群 ID、设备 ID、历史和端口均保留。Wi-Fi 实际 DHCP 地址从 `172.29.21.2/16` 变为 `172.29.6.14/16`，同一 GUI 进程自动重绑到新地址的 `11726` 端口；换回原网络配置后也自动恢复。
- 现场修复自动选网卡在 Wi-Fi 短暂消失后粘住低优先级以太网的问题。自动模式优先返回恢复的 Wi-Fi；同优先级网卡保持稳定。手动固定 IP 的设置仍保持原语义。
- Android → Windows 的 8,197 字节文件由真实手机文件选择器发送，Windows 从真实 renderer 准备并下载，SHA-256 为 `373df8df65eeb409fd70d955dd0a96e68995edeff0bd3f84efcc441726a4f61a`，逐字节一致。
- Windows GUI 在新 DHCP 地址阶段发布 12,293 字节文件；Android 经原生系统保存界面保存后读取校验，SHA-256 为 `ee9d6bc74b0221fa270736b9322cdde492e5051c6a5252296dd052c88de2cca4`，逐字节一致。
- Android 执行整机重启，开机解锁并打开独立 App 后，原群与历史保留，Mac 仍离线，Windows 与手机双向新文字成功。重启后需要打开 App；本轮不代表手机后台常驻。
- 手机用户切换到 NEU，实际地址变为 `172.26.15.37/16`。手机服务自动绑定新地址，本机 `/api/peer/info` 返回相同设备 ID，原群仍保留。但是 NEU 当时为 `CAPTIVE_PORTAL`、默认网络仍为移动数据；与 NEU-Mobile 上的 Windows 双向 TCP 探测均超时。已排除测试程序显式防火墙阻止规则。这一阶段**未通过跨网互传验收**，不能把群身份保留等同网络可达。
- 按用户选择把手机恢复到 NEU-Mobile 的 `172.29.16.145/16` 后，同一群自动恢复双向新文字，无需重新配对。
- Mac 使用原测试数据重新打开新版包，自动补齐离线期间 14 条历史，并发送新消息到 Windows；再次退出 Mac 后，Windows → Android 新消息继续成功。

同时修复了手机同步状态反复重启扫描的反馈循环、原生网络回调注册重放导致的重复扫描风险，以及暂时无 IPv4 时的周期重绑重试。完整 Node 回归 281 项通过，原生 Kotlin 编译及 APK 构建通过；最终 Mac 包通过三进程的创建者退出后双向消息和文件验收，Windows 包在实体机器 GUI 上完成上述场景。包内关键源码与工作区一致，已安装 Android APK 与交付 APK 的 SHA-256 一致。

为验收设置的临时规则仅作用于测试程序的 TCP 群端口及测试设备/网段，结束后恢复。手机的随机 MAC 尝试在系统重连时回退到设备 MAC，未获得新 DHCP 地址，不能算通过；已恢复原设置。临时 Windows 热点方案未用于验收，已恢复原热点配置并删除相关任务。交付包及最终构建清单位于 `artifacts/peer-recovery/`。

验收边界：自动恢复依赖节点之间 TCP 可达；不提供通用 NAT 穿透或云中继。Android 仍需前台。已有旧托管群需在原创建电脑升级为多设备群并重新授权成员一次，不能仅更新安装包就自动改变旧群协议。

最终清理已核实完成：Windows 本轮测试进程、规则、计划任务、隔离目录和 CDP 通道全部移除，原应用仍在运行，原 Wi-Fi/MAC/热点配置保留；Mac 测试进程和数据移除；手机临时 UI 验收辅助包卸载，独立开发版与原内测版保留。


## 2026-10-11：包体精简与三端回归

本轮只调整 Android 发布裁剪、Windows 语言资源，并修复实测发现的 Android 同 IP 重连监听问题；保留文件、文字、扫码、分享、发现和多设备群协议。

- Android arm64 APK：39,555,583 → 32,436,800 字节，减少 18.00%。在 `app.json` 的 `expo-build-properties` 中启用 `enableMinifyInReleaseBuilds` 和 `enableShrinkResourcesInReleaseBuilds`；保留 R8 映射压缩文件供故障定位。手机安装 APK 的 SHA-256 与交付文件一致。
- Windows portable EXE：99,925,787 → 92,232,911 字节，减少 7.70%。`electron-builder.cjs` 仅在 Windows 保留 en-US、zh-CN、zh-TW；实际语言目录分配空间从 50,761,728 → 1,769,472 字节。整包解包空间 390,270,976 → 347,734,016 字节。测试运行的完整 Windows bundle 的主程序和 ASAR 与打包输出哈希一致。
- Mac 包与业务实现保持原有版本，使用上轮 peer-recovery 的实际 Mac 应用参加回归。
- 开发目录分配空间约 13.171 → 5.819 GiB，净回收约 7.352 GiB。保留最新 peer-recovery 三端交付包、校验信息、验收记录以及本轮新包；清理旧版和重复解包产物、Android 可再生构建目录，没有删除原生源码、工具链或用户群数据。

真机群 `821bebb9-ea15-44f0-8da7-04bd800870a0`（三端瘦身回归验收 20261011）：

1. Mac、Windows、Android 仅通过 Mac 的邀请加入，三端文字同步成功。Mac 完全退出，51854 端口连接拒绝后，Windows 与 Android 双向文字、文件仍可通行。
2. Android → Windows 16,397 字节文件 SHA-256 为 `9737f768f3872ddeca8a1000434948e6ab007430b9de2bbbc0068f41612828b1`；Windows → Android 24,589 字节文件 SHA-256 为 `470994d1ba5ad8c5c2ef6fa97afde757386e501b3b0c5aeca5a310666bcad822`。两端实际下载/保存文件均逐字节一致。保存操作必须等待完成后再停止应用，验收中一次过早停止导致的零字节测试文件已删除并重做。
3. Windows WLAN 真正由 172.29.21.2 变为 172.29.6.14，应用同进程自动切换为新 IP 的 2667 端口，原群和设备身份保留；手机收到新地址下的消息。随后重启 Windows 完整桌面应用，原群恢复。测试结束已恢复 WLAN 原配置和 172.29.21.2。
4. 手机强制停止/重开后仍是设备 `719d0ffa-5749-4f59-9476-b9b8b49efb0f`，原群和历史保留。Wi-Fi 断开再连回同 IP 的额外测试发现旧 APK 与裁剪初版都未恢复原监听；对照旧 APK 等待 60 秒仍无监听，排除了裁剪作为原因。
5. Android 网络撤销会使 accept 循环退出，而 Java ServerSocket 对象可能仍保留且 isClosed 未更新。增加 transportLock，并在 accept 循环 finally 中只清理属于本轮的 listener，防止旧线程关闭新 listener；定时重试能重新绑定相同 IP。最终裁剪 APK 连续两轮 Wi-Fi 重连分别约 2.24、2.44 秒恢复 HTTP，身份不变，无需重启应用或重新邀请。恢复后再由手机发送 32,781 字节新文件，Windows 下载字节一致，SHA-256 为 `1b9b783b453b2cfecb5ba25dbe593c047ea96886f6414fb1ab9c2e7bbb328a02`。
6. Mac 回归原群自动获取离线历史，再次退出后两端继续交换消息；最终 Windows 显示 Mac 离线、Windows 和手机在线，手机实际 UI 收到最终消息。

281 项全量 Node 测试通过；补充移动通信、HTTP framing、发现回归 17 项通过；TypeScript 和语法检查通过；Kotlin 与启用 R8 的 release 构建成功。扫码/分享代码和依赖仍保留，本轮没有做物理摄像头扫码解码测试。Android peer 服务仍要求应用在前台；本轮未重复整机重启验收，上轮记录继续有效。

本轮临时 Windows 程序、防火墙规则、网络变更任务、SSH 调试隧道、Mac 隔离数据和手机 UI 辅助包已清理。Windows 原有应用进程保留，手机内测版与调试版数据保留。交付包、体积与哈希详情见 `artifacts/slim-20261011/size-report.json`、`SHA256SUMS.txt` 和 `cleanup.json`。
