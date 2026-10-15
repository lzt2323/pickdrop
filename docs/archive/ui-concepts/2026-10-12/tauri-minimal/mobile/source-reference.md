# 手机预览的非 Rust 来源

本文件属于图册资料，不显示在应用界面。只通过 `git show` 读取旧版本，没有切换分支或修改正式客户端。

| 来源 | 实际布局／风格 |
|---|---|
| `codex/pickdrop-design-reliability:apps/mobile/App.tsx:203` | Oct 7 首页品牌＋设置／加入，尚无底部三导航。 |
| `codex/pickdrop-design-reliability:apps/mobile/src/components/ui.tsx:16` | 旧青绿 `#126A5A`、暖白 `#F8FAF7`、圆角按钮与分隔群列表。 |
| `migration/tauri-base-20261012:apps/mobile/App.tsx:273` | 最新非 Rust 首页品牌＋新建，下一行扫码／邀请码加入。 |
| `migration/tauri-base-20261012:apps/mobile/App.tsx:281` | 群组／传输／我的三项底部导航。 |
| `migration/tauri-base-20261012:apps/mobile/App.tsx:283` | 独立聊天页：返回、群名和在线摘要、更多。 |
| `migration/tauri-base-20261012:apps/mobile/App.tsx:288` | 消息／文件过滤和邀请；文件仍沿用会话中的消息卡。 |
| `migration/tauri-base-20261012:apps/mobile/App.tsx:291` | 发送者与时间、左右对话、文件卡共同出现在原会话流。 |
| `migration/tauri-base-20261012:apps/mobile/App.tsx:329` | 我的：本机身份，先缓存／存储，再设备名称编辑。 |
| `migration/tauri-base-20261012:apps/mobile/src/components/ui.tsx:54` | 原三导航图标＋文字，手机单栏布局。 |
| `migration/tauri-base-20261012:apps/mobile/src/components/MessageComposer.tsx:26` | 整体浮动输入框：横向 margin 8、圆角 18、附件与发送包在同一个框内。 |
| `migration/tauri-base-20261012:apps/mobile/src/components/ReceivedFile.tsx:81` | 228 宽、12 圆角文件卡；不是铺满内容区的文件库。 |
| `migration/tauri-base-20261012:apps/mobile/src/theme.ts:3` | 最新非 Rust 已为白表面、`#F2F2F7` 浅灰。 |
| `migration/tauri-base-20261012:apps/mobile/src/theme.ts:6` | 最新非 Rust 已采用操作蓝 `#007AFF`，并非 Oct 7 的青绿主题。 |

本稿沿用最新非 Rust 的信息架构与上述输入区、文件卡和「我的」顺序。依照当前反馈，去除动物装饰、教育／实现提醒小字、行末箭头；保留实际文件大小、时间、在线数量、角色和错误状态。颜色与字体继续使用本图册共享蓝白灰 tokens；触控目标扩展到 48px，元数据保持 13px。
