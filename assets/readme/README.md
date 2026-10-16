# README 功能示意动画

这是一段 18 秒的 HTML 动画，展示 macOS、Windows、Android 和 Linux TUI 在同群内交换文件和文字。**不是实机录屏，也不作为四端真实互通或性能验收证据。** 界面经过简化，使用项目现有蓝白色与 Logo，没有使用真实设备地址、身份、聊天记录或私有文件。

- [demo.html](demo.html)：离线可打开的预览，可播放、暂停、重播、拖动时间轴；减少动态效果设置下默认展示静态终态。
- [demo.gif](demo.gif)：README 内联循环版，960 × 600，10 fps。
- [demo.mp4](demo.mp4)：清晰版，1440 × 900，20 fps，H.264，无音轨。
- [poster.png](poster.png)：完整终态静态图，适合不希望播放动画的读者。

## 分镜

| 时间 | 画面与表达 |
| --- | --- |
| 0–3 秒 | 四端同群，交代设备关系 |
| 3–7 秒 | 放大 Mac：文件进入草稿，再确认发送 |
| 7–12 秒 | 回到四端：文件消息到达，各接收端确认、下载、校验并保存 |
| 12–18 秒 | Android 回复文字，其他设备显示回复，停留在完整结果 |

文件消息发布与接收端下载是两个步骤。动画时长为叙事压缩，未展示或声称实测吞吐量。终端布局与 GUI 不同，不暗示 Linux 桌面 GUI 已实现。

## 重新生成

安装仓库开发依赖和 Playwright Chromium，并准备带 libx264、palettegen、paletteuse 的 FFmpeg。动画没有额外前端依赖。使用仓库要求的 Node 环境：

```sh
pnpm install --frozen-lockfile
pnpm exec playwright install chromium
node scripts/render-readme-demo.mjs
```

FFmpeg 不在 PATH 时通过 `FFMPEG` 环境变量传入可执行文件路径。脚本以 HTML 的 `renderFrame(seconds)` 固定时间采帧，输出上述三种媒体；中间帧仅写入忽略的 `.build/reports/readme-demo/frames/`。不需要 OBS、手机、SSH 或真实聊天数据。

修改分镜后先检查草稿、发送、接收、回复四个时点；确认文字不重叠、不越界，再重新生成。预览与导出使用相同时间轴，窗口聚焦使用 transform，淡入使用 opacity；预览不自动播放。系统字体可能使不同机器上的字形略有差异。

## 真实界面首次入群教程

`onboarding.gif` / `onboarding.mp4` 是 Mac 与 Android 正式版 0.6.0 的真实截图序列，24 秒展示创建群组、邀请入口、复制链接、手机加入入口、申请、成员入口、允许及收到消息。每步静止展示 3 秒，直接切换截图，避免黑场淡入导致闪烁。正文保留步骤说明；MP4 可暂停，减少动态效果时使用 `onboarding-poster.png` 静态回退。

截图通过 Mac 窗口截图及用户授权的 adb 截图取得；手机实际加入演示群并收到电脑消息，不是重绘 UI。临时二维码、邀请码、地址及邀请链接在导出前遮挡，原图与 UI 层级只保存在忽略目录 `.build/reports/readme-onboarding/real/`，不上传。

`python3 scripts/render-readme-onboarding.py` 用 Pillow 绘制外围说明、FFmpeg 裁切/遮挡/标注并合成截图序列；需要自行准备脚本列出的截图，尺寸变化时必须重新检查遮挡坐标。用 `PICKDROP_CAPTURE_DIR` 指定原图目录，`PICKDROP_DEMO_FONT` 指定中文字体，`FFMPEG` 指定 FFmpeg。分镜检查图保存在 `.build/reports/readme-onboarding/composed/`。
