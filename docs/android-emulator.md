# Tauri Android 模拟器开发

先在 Android Studio 打开 ARM64 模拟器，在仓库根目录运行：

```sh
bash scripts/run-android-emulator.sh
```

脚本构建内置前端资源的 debug APK，使用 `adb install -r` 更新安装，然后重启
`app.pickdrop.tauri.preview`。不会卸载应用或清除群组、历史与草稿。
APK 位于 `apps/tauri/src-tauri/gen/android/app/build/outputs/apk/universal/debug/app-universal-debug.apk`。

需要 Node、pnpm、Rust Android ARM64 target、JDK 和含 NDK 的 Android SDK。
脚本优先使用现有环境变量，兼容本机已缓存的开发工具，并统一 `ANDROID_HOME`
与 `ANDROID_SDK_ROOT`，避免 Gradle 因两者路径不一致而失败。可用
`ANDROID_SERIAL` 指定设备，用 `JAVA_HOME`、`ANDROID_HOME`、`NDK_HOME`、`ADB`
覆盖工具位置；`PICKDROP_NATIVE_TOOLS` 可指定集中存放 SDK/JDK 的目录。

## 2026-10-13 模拟器验收

环境：现有 `emulator-5554`，Android API 36，ARM64，1080×2400，密度 420。

- 创建「安卓模拟器测试」群组，实际 Rust 后端保存成功。
- ADB 输入 `Android-emulator-test-2026-10-13`，点击发送后进入聊天历史。
- 普通 Gboard QWERTY 软键盘弹出时，WebView 高度从 839 缩至 527 CSS px；
  输入栏下边缘为 508 CSS px，发送按钮和输入内容完整可见。
- 系统返回收起键盘，再返回群组列表。
- 输入草稿 `Draft-after-reopen` 后停止并重启进程，重新进入群组，草稿与已发送历史均保留。
- 页面无横向溢出，测试时段 logcat 未发现 fatal exception、native fatal signal 或 Rust panic。

历史截图已随输出整理迁至 `.build/history/artifacts/android-emulator/`；新验收截图应写入 `.build/reports/android-emulator/`。首次唤起输入法遇到 Gboard 手写引导，关闭后
临时启用普通软键盘进行验证，结束后恢复了模拟器的原有键盘系统设置。
本次覆盖单设备本地交互；跨设备文件传输、扫码、系统分享仍需单独验收。
