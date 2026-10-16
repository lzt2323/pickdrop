# 拾传应用图标

白底、蓝色前页、浅蓝后页和白色交接箭头。应用图标不包含动物；动物仅用于群身份。

`app-icon-source.svg` 是可编辑源。运行 `node scripts/generate-brand-assets.js` 生成 desktop、mobile 与此目录的 PNG/SVG。

- `app-icon`：圆角白底，1024 至 16 像素导出。
- `mac-icon`：1024 画布中保留 Dock 透明边距。
- `mobile-icon`：1024 不透明白底，系统负责裁切。
- `adaptive-foreground` / `monochrome-icon`：1024 透明中央图形，保留 Android 安全区。
- `trayTemplate`：18 / 36 像素黑色透明线条，供 macOS 系统着色。
- `manifest.json`：尺寸与实际 alpha 边界检查结果。

桌面打包继续由既有打包工具从 icon.png / mac-icon.png 生成系统格式。未改动启动逻辑或群动物资源。
