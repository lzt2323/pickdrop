# 动效复审 — 2026-10-13

基线 `859c4c5`；最终 after gallery 36 个独立场景、4 个视口共 136 张截图，manifest findings 为空。此次只读复审，未修改产品源码。

| Before | After | Why |
| --- | --- | --- |
| 进度更新重建传输按钮，取消焦点落到 body | `main.js` 的 `renderQueue()` 按 ID 保留节点；终态只迁移当前被隐藏按钮的焦点 | 高频更新不中断键盘操作；减少重复 DOM 重建，无 FPS 推断 |
| 独立旧离开计时器可提前收起主窗 | 每窗口 generation；expand/hide 作废旧任务，仍用 800ms/250ms | 快速重触发得到完整等待时间，双窗互不取消 |
| 偶发弹层完全即时，存在小幅空间呈现优化机会 | `dialog-motion.js` 的 `open()` 可信指针首开 160ms、scale(.97)、强 ease-out；退出即时 | 仅少量偶发呈现使用运动，高频与键盘仍即时 |
| sticky 输入方式会让后续系统打开误动画；旧 close 队列会影响新弹层 | 当前 click 任务资格过期；helper 和 main close 均检查 open | 后续程序打开即时；快速关闭重开不被旧事件打断 |

**Interruptibility & timing：** `artifacts/ui-review/dialog-motion.json` 全通过：快速取消、同 click 关闭重开、旧 close 队列、已打开换内容、后续程序打开、键盘、高频例外。main 生命周期 guard 保留新会话，pagehide dispose 清理监听。`artifacts/ui-review/native/debounce-smoke.json` 原生实测通过快速离开重触发、独立窗口计时、expand/hide 失效旧任务。

**Performance：** 新呈现只动画 opacity/transform，使用 WAAPI，不加入尺寸插值；拖动/缩放必要几何更新不计装饰动画。未测量帧率，不宣称不卡顿或 GPU 实际合成结果。

**Accessibility：** 键盘即时；reduced motion 仅 opacity，运行中切换偏好取消运动并落到最终状态。附近发现焦点与 incoming-share footer 迁移已修复，四视口 gallery 无焦点发现。传输终态焦点迁移另有 Playwright 探针通过（UI 测试 agent 提供）。

**Approve** — 当前代码及证据没有阻断性动效问题。此结论不等于原生 WebKit / Android 动画体感、真实 IME、系统分享框或完整可访问性认证。静态 gallery 只证明可达状态和布局，机械测试证明生命周期；不以截图推断时序。无动画的高频界面可得满分。

## 同口径逐场景评分

五列各 0–2：目的频率 / 时长节奏与空间 / 可打断 / 性能 / 减弱动效与键盘。10 分表示当前证据范围内无已证实动效问题，不代表整体产品完美。原生动物/面板单独由 9→10（2/2/2/2/2），证据为上述原生 smoke；未增加动物装饰运动。

| 视口 | 场景 | Before→After | 目的 | 时空 | 打断 | 性能 | 减弱/键盘 | 证据 |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| desktop | chat-content | 10→10 | 2 | 2 | 2 | 2 | 2 | [chat-content](../../artifacts/ui-review/after/desktop-chat-content.png)；高频导航/内容更新保持即时；无新增装饰动画；静态检查无动效回归证据。 |
| desktop | files | 10→10 | 2 | 2 | 2 | 2 | 2 | [files](../../artifacts/ui-review/after/desktop-files.png)；高频导航/内容更新保持即时；无新增装饰动画；静态检查无动效回归证据。 |
| desktop | image-preview | 9.5→10 | 2 | 2 | 2 | 2 | 2 | [image-preview](../../artifacts/ui-review/after/desktop-image-preview.png)；共享弹层：偶发可信指针首开 160ms；键盘/程序打开与换页即时；机械测试覆盖取消及减弱动效。 |
| desktop | file-actions | 9.5→10 | 2 | 2 | 2 | 2 | 2 | [file-actions](../../artifacts/ui-review/after/desktop-file-actions.png)；共享弹层：偶发可信指针首开 160ms；键盘/程序打开与换页即时；机械测试覆盖取消及减弱动效。 |
| desktop | file-draft | 10→10 | 2 | 2 | 2 | 2 | 2 | [file-draft](../../artifacts/ui-review/after/desktop-file-draft.png)；高频导航/内容更新保持即时；无新增装饰动画；静态检查无动效回归证据。 |
| desktop | groups-picker | 10→10 | 2 | 2 | 2 | 2 | 2 | [groups-picker](../../artifacts/ui-review/after/desktop-groups-picker.png)；高频导航/内容更新保持即时；无新增装饰动画；静态检查无动效回归证据。 |
| desktop | create-animal | 9.5→10 | 2 | 2 | 2 | 2 | 2 | [create-animal](../../artifacts/ui-review/after/desktop-create-animal.png)；共享弹层：偶发可信指针首开 160ms；键盘/程序打开与换页即时；机械测试覆盖取消及减弱动效。 |
| desktop | create-validation | 9.5→10 | 2 | 2 | 2 | 2 | 2 | [create-validation](../../artifacts/ui-review/after/desktop-create-validation.png)；共享弹层：偶发可信指针首开 160ms；键盘/程序打开与换页即时；机械测试覆盖取消及减弱动效。 |
| desktop | join | 9.5→10 | 2 | 2 | 2 | 2 | 2 | [join](../../artifacts/ui-review/after/desktop-join.png)；共享弹层：偶发可信指针首开 160ms；键盘/程序打开与换页即时；机械测试覆盖取消及减弱动效。 |
| desktop | join-nearby | 8.5→10 | 2 | 2 | 2 | 2 | 2 | [join-nearby](../../artifacts/ui-review/after/desktop-join-nearby.png)；异步控件焦点恢复；最终 gallery 无失焦发现。 |
| desktop | join-waiting | 9.5→10 | 2 | 2 | 2 | 2 | 2 | [join-waiting](../../artifacts/ui-review/after/desktop-join-waiting.png)；共享弹层：偶发可信指针首开 160ms；键盘/程序打开与换页即时；机械测试覆盖取消及减弱动效。 |
| desktop | invite | 9.5→10 | 2 | 2 | 2 | 2 | 2 | [invite](../../artifacts/ui-review/after/desktop-invite.png)；共享弹层：偶发可信指针首开 160ms；键盘/程序打开与换页即时；机械测试覆盖取消及减弱动效。 |
| desktop | connect-device | 9.5→10 | 2 | 2 | 2 | 2 | 2 | [connect-device](../../artifacts/ui-review/after/desktop-connect-device.png)；共享弹层：偶发可信指针首开 160ms；键盘/程序打开与换页即时；机械测试覆盖取消及减弱动效。 |
| desktop | connect-error | 9.5→10 | 2 | 2 | 2 | 2 | 2 | [connect-error](../../artifacts/ui-review/after/desktop-connect-error.png)；共享弹层：偶发可信指针首开 160ms；键盘/程序打开与换页即时；机械测试覆盖取消及减弱动效。 |
| desktop | members-approval | 9.5→10 | 2 | 2 | 2 | 2 | 2 | [members-approval](../../artifacts/ui-review/after/desktop-members-approval.png)；共享弹层：偶发可信指针首开 160ms；键盘/程序打开与换页即时；机械测试覆盖取消及减弱动效。 |
| desktop | remove-member-confirm | 9.5→10 | 2 | 2 | 2 | 2 | 2 | [remove-member-confirm](../../artifacts/ui-review/after/desktop-remove-member-confirm.png)；共享弹层：偶发可信指针首开 160ms；键盘/程序打开与换页即时；机械测试覆盖取消及减弱动效。 |
| desktop | settings | 9.5→10 | 2 | 2 | 2 | 2 | 2 | [settings](../../artifacts/ui-review/after/desktop-settings.png)；共享弹层：偶发可信指针首开 160ms；键盘/程序打开与换页即时；机械测试覆盖取消及减弱动效。 |
| desktop | group-settings | 9.5→10 | 2 | 2 | 2 | 2 | 2 | [group-settings](../../artifacts/ui-review/after/desktop-group-settings.png)；共享弹层：偶发可信指针首开 160ms；键盘/程序打开与换页即时；机械测试覆盖取消及减弱动效。 |
| desktop | leave-confirm | 9.5→10 | 2 | 2 | 2 | 2 | 2 | [leave-confirm](../../artifacts/ui-review/after/desktop-leave-confirm.png)；共享弹层：偶发可信指针首开 160ms；键盘/程序打开与换页即时；机械测试覆盖取消及减弱动效。 |
| desktop | forget-confirm | 9.5→10 | 2 | 2 | 2 | 2 | 2 | [forget-confirm](../../artifacts/ui-review/after/desktop-forget-confirm.png)；共享弹层：偶发可信指针首开 160ms；键盘/程序打开与换页即时；机械测试覆盖取消及减弱动效。 |
| desktop | storage | 9.5→10 | 2 | 2 | 2 | 2 | 2 | [storage](../../artifacts/ui-review/after/desktop-storage.png)；共享弹层：偶发可信指针首开 160ms；键盘/程序打开与换页即时；机械测试覆盖取消及减弱动效。 |
| desktop | clear-cache-confirm | 9.5→10 | 2 | 2 | 2 | 2 | 2 | [clear-cache-confirm](../../artifacts/ui-review/after/desktop-clear-cache-confirm.png)；共享弹层：偶发可信指针首开 160ms；键盘/程序打开与换页即时；机械测试覆盖取消及减弱动效。 |
| desktop | transfers-mixed | 7.0→10 | 2 | 2 | 2 | 2 | 2 | [transfers-mixed](../../artifacts/ui-review/after/desktop-transfers-mixed.png)；稳定传输行与按钮；进度焦点探针通过；终态只迁移本行被隐藏的当前焦点。 |
| desktop | transfers-progress-focus | 7.0→10 | 2 | 2 | 2 | 2 | 2 | [transfers-progress-focus](../../artifacts/ui-review/after/desktop-transfers-progress-focus.png)；稳定传输行与按钮；进度焦点探针通过；终态只迁移本行被隐藏的当前焦点。 |
| desktop | membership-revoked | 10→10 | 2 | 2 | 2 | 2 | 2 | [membership-revoked](../../artifacts/ui-review/after/desktop-membership-revoked.png)；高频导航/内容更新保持即时；无新增装饰动画；静态检查无动效回归证据。 |
| desktop | chat-empty-long-title | 10→10 | 2 | 2 | 2 | 2 | 2 | [chat-empty-long-title](../../artifacts/ui-review/after/desktop-chat-empty-long-title.png)；高频导航/内容更新保持即时；无新增装饰动画；静态检查无动效回归证据。 |
| desktop | files-empty | 10→10 | 2 | 2 | 2 | 2 | 2 | [files-empty](../../artifacts/ui-review/after/desktop-files-empty.png)；高频导航/内容更新保持即时；无新增装饰动画；静态检查无动效回归证据。 |
| desktop | group-settings-member | 9.5→10 | 2 | 2 | 2 | 2 | 2 | [group-settings-member](../../artifacts/ui-review/after/desktop-group-settings-member.png)；共享弹层：偶发可信指针首开 160ms；键盘/程序打开与换页即时；机械测试覆盖取消及减弱动效。 |
| desktop | incoming-share | 9.5→10 | 2 | 2 | 2 | 2 | 2 | [incoming-share](../../artifacts/ui-review/after/desktop-incoming-share.png)；共享弹层：偶发可信指针首开 160ms；键盘/程序打开与换页即时；机械测试覆盖取消及减弱动效。 |
| desktop | no-groups | 10→10 | 2 | 2 | 2 | 2 | 2 | [no-groups](../../artifacts/ui-review/after/desktop-no-groups.png)；高频导航/内容更新保持即时；无新增装饰动画；静态检查无动效回归证据。 |
| mobile | home-groups | 10→10 | 2 | 2 | 2 | 2 | 2 | [home-groups](../../artifacts/ui-review/after/mobile-home-groups.png)；高频导航/内容更新保持即时；无新增装饰动画；静态检查无动效回归证据。 |
| mobile | transfers-empty | 10→10 | 2 | 2 | 2 | 2 | 2 | [transfers-empty](../../artifacts/ui-review/after/mobile-transfers-empty.png)；高频导航/内容更新保持即时；无新增装饰动画；静态检查无动效回归证据。 |
| mobile | profile | 10→10 | 2 | 2 | 2 | 2 | 2 | [profile](../../artifacts/ui-review/after/mobile-profile.png)；高频导航/内容更新保持即时；无新增装饰动画；静态检查无动效回归证据。 |
| mobile | chat-content | 10→10 | 2 | 2 | 2 | 2 | 2 | [chat-content](../../artifacts/ui-review/after/mobile-chat-content.png)；高频导航/内容更新保持即时；无新增装饰动画；静态检查无动效回归证据。 |
| mobile | keyboard-viewport-simulation | 10→10 | 2 | 2 | 2 | 2 | 2 | [keyboard-viewport-simulation](../../artifacts/ui-review/after/mobile-keyboard-viewport-simulation.png)；高频导航/内容更新保持即时；无新增装饰动画；静态检查无动效回归证据。 |
| mobile | files | 10→10 | 2 | 2 | 2 | 2 | 2 | [files](../../artifacts/ui-review/after/mobile-files.png)；高频导航/内容更新保持即时；无新增装饰动画；静态检查无动效回归证据。 |
| mobile | image-preview | 9.5→10 | 2 | 2 | 2 | 2 | 2 | [image-preview](../../artifacts/ui-review/after/mobile-image-preview.png)；共享弹层：偶发可信指针首开 160ms；键盘/程序打开与换页即时；机械测试覆盖取消及减弱动效。 |
| mobile | file-actions | 9.5→10 | 2 | 2 | 2 | 2 | 2 | [file-actions](../../artifacts/ui-review/after/mobile-file-actions.png)；共享弹层：偶发可信指针首开 160ms；键盘/程序打开与换页即时；机械测试覆盖取消及减弱动效。 |
| mobile | file-draft | 10→10 | 2 | 2 | 2 | 2 | 2 | [file-draft](../../artifacts/ui-review/after/mobile-file-draft.png)；高频导航/内容更新保持即时；无新增装饰动画；静态检查无动效回归证据。 |
| mobile | groups-picker | 10→10 | 2 | 2 | 2 | 2 | 2 | [groups-picker](../../artifacts/ui-review/after/mobile-groups-picker.png)；高频导航/内容更新保持即时；无新增装饰动画；静态检查无动效回归证据。 |
| mobile | create-animal | 9.5→10 | 2 | 2 | 2 | 2 | 2 | [create-animal](../../artifacts/ui-review/after/mobile-create-animal.png)；共享弹层：偶发可信指针首开 160ms；键盘/程序打开与换页即时；机械测试覆盖取消及减弱动效。 |
| mobile | create-validation | 9.5→10 | 2 | 2 | 2 | 2 | 2 | [create-validation](../../artifacts/ui-review/after/mobile-create-validation.png)；共享弹层：偶发可信指针首开 160ms；键盘/程序打开与换页即时；机械测试覆盖取消及减弱动效。 |
| mobile | join | 9.5→10 | 2 | 2 | 2 | 2 | 2 | [join](../../artifacts/ui-review/after/mobile-join.png)；共享弹层：偶发可信指针首开 160ms；键盘/程序打开与换页即时；机械测试覆盖取消及减弱动效。 |
| mobile | join-nearby | 8.5→10 | 2 | 2 | 2 | 2 | 2 | [join-nearby](../../artifacts/ui-review/after/mobile-join-nearby.png)；异步控件焦点恢复；最终 gallery 无失焦发现。 |
| mobile | join-waiting | 9.5→10 | 2 | 2 | 2 | 2 | 2 | [join-waiting](../../artifacts/ui-review/after/mobile-join-waiting.png)；共享弹层：偶发可信指针首开 160ms；键盘/程序打开与换页即时；机械测试覆盖取消及减弱动效。 |
| mobile | invite | 9.5→10 | 2 | 2 | 2 | 2 | 2 | [invite](../../artifacts/ui-review/after/mobile-invite.png)；共享弹层：偶发可信指针首开 160ms；键盘/程序打开与换页即时；机械测试覆盖取消及减弱动效。 |
| mobile | connect-device | 9.5→10 | 2 | 2 | 2 | 2 | 2 | [connect-device](../../artifacts/ui-review/after/mobile-connect-device.png)；共享弹层：偶发可信指针首开 160ms；键盘/程序打开与换页即时；机械测试覆盖取消及减弱动效。 |
| mobile | connect-error | 9.5→10 | 2 | 2 | 2 | 2 | 2 | [connect-error](../../artifacts/ui-review/after/mobile-connect-error.png)；共享弹层：偶发可信指针首开 160ms；键盘/程序打开与换页即时；机械测试覆盖取消及减弱动效。 |
| mobile | members-approval | 9.5→10 | 2 | 2 | 2 | 2 | 2 | [members-approval](../../artifacts/ui-review/after/mobile-members-approval.png)；共享弹层：偶发可信指针首开 160ms；键盘/程序打开与换页即时；机械测试覆盖取消及减弱动效。 |
| mobile | remove-member-confirm | 9.5→10 | 2 | 2 | 2 | 2 | 2 | [remove-member-confirm](../../artifacts/ui-review/after/mobile-remove-member-confirm.png)；共享弹层：偶发可信指针首开 160ms；键盘/程序打开与换页即时；机械测试覆盖取消及减弱动效。 |
| mobile | settings | 9.5→10 | 2 | 2 | 2 | 2 | 2 | [settings](../../artifacts/ui-review/after/mobile-settings.png)；共享弹层：偶发可信指针首开 160ms；键盘/程序打开与换页即时；机械测试覆盖取消及减弱动效。 |
| mobile | group-settings | 9.5→10 | 2 | 2 | 2 | 2 | 2 | [group-settings](../../artifacts/ui-review/after/mobile-group-settings.png)；共享弹层：偶发可信指针首开 160ms；键盘/程序打开与换页即时；机械测试覆盖取消及减弱动效。 |
| mobile | leave-confirm | 9.5→10 | 2 | 2 | 2 | 2 | 2 | [leave-confirm](../../artifacts/ui-review/after/mobile-leave-confirm.png)；共享弹层：偶发可信指针首开 160ms；键盘/程序打开与换页即时；机械测试覆盖取消及减弱动效。 |
| mobile | forget-confirm | 9.5→10 | 2 | 2 | 2 | 2 | 2 | [forget-confirm](../../artifacts/ui-review/after/mobile-forget-confirm.png)；共享弹层：偶发可信指针首开 160ms；键盘/程序打开与换页即时；机械测试覆盖取消及减弱动效。 |
| mobile | storage | 9.5→10 | 2 | 2 | 2 | 2 | 2 | [storage](../../artifacts/ui-review/after/mobile-storage.png)；共享弹层：偶发可信指针首开 160ms；键盘/程序打开与换页即时；机械测试覆盖取消及减弱动效。 |
| mobile | clear-cache-confirm | 9.5→10 | 2 | 2 | 2 | 2 | 2 | [clear-cache-confirm](../../artifacts/ui-review/after/mobile-clear-cache-confirm.png)；共享弹层：偶发可信指针首开 160ms；键盘/程序打开与换页即时；机械测试覆盖取消及减弱动效。 |
| mobile | transfers-mixed | 7.0→10 | 2 | 2 | 2 | 2 | 2 | [transfers-mixed](../../artifacts/ui-review/after/mobile-transfers-mixed.png)；稳定传输行与按钮；进度焦点探针通过；终态只迁移本行被隐藏的当前焦点。 |
| mobile | transfers-progress-focus | 7.0→10 | 2 | 2 | 2 | 2 | 2 | [transfers-progress-focus](../../artifacts/ui-review/after/mobile-transfers-progress-focus.png)；稳定传输行与按钮；进度焦点探针通过；终态只迁移本行被隐藏的当前焦点。 |
| mobile | membership-revoked | 10→10 | 2 | 2 | 2 | 2 | 2 | [membership-revoked](../../artifacts/ui-review/after/mobile-membership-revoked.png)；高频导航/内容更新保持即时；无新增装饰动画；静态检查无动效回归证据。 |
| mobile | chat-empty-long-title | 10→10 | 2 | 2 | 2 | 2 | 2 | [chat-empty-long-title](../../artifacts/ui-review/after/mobile-chat-empty-long-title.png)；高频导航/内容更新保持即时；无新增装饰动画；静态检查无动效回归证据。 |
| mobile | files-empty | 10→10 | 2 | 2 | 2 | 2 | 2 | [files-empty](../../artifacts/ui-review/after/mobile-files-empty.png)；高频导航/内容更新保持即时；无新增装饰动画；静态检查无动效回归证据。 |
| mobile | group-settings-member | 9.5→10 | 2 | 2 | 2 | 2 | 2 | [group-settings-member](../../artifacts/ui-review/after/mobile-group-settings-member.png)；共享弹层：偶发可信指针首开 160ms；键盘/程序打开与换页即时；机械测试覆盖取消及减弱动效。 |
| mobile | transfers-page | 7.0→10 | 2 | 2 | 2 | 2 | 2 | [transfers-page](../../artifacts/ui-review/after/mobile-transfers-page.png)；稳定传输行与按钮；进度焦点探针通过；终态只迁移本行被隐藏的当前焦点。 |
| mobile | profile-with-groups | 10→10 | 2 | 2 | 2 | 2 | 2 | [profile-with-groups](../../artifacts/ui-review/after/mobile-profile-with-groups.png)；高频导航/内容更新保持即时；无新增装饰动画；静态检查无动效回归证据。 |
| mobile | incoming-share | 9.5→10 | 2 | 2 | 2 | 2 | 2 | [incoming-share](../../artifacts/ui-review/after/mobile-incoming-share.png)；共享弹层：偶发可信指针首开 160ms；键盘/程序打开与换页即时；机械测试覆盖取消及减弱动效。 |
| mobile | no-groups | 10→10 | 2 | 2 | 2 | 2 | 2 | [no-groups](../../artifacts/ui-review/after/mobile-no-groups.png)；高频导航/内容更新保持即时；无新增装饰动画；静态检查无动效回归证据。 |
| narrow | home-groups | 10→10 | 2 | 2 | 2 | 2 | 2 | [home-groups](../../artifacts/ui-review/after/narrow-home-groups.png)；高频导航/内容更新保持即时；无新增装饰动画；静态检查无动效回归证据。 |
| narrow | transfers-empty | 10→10 | 2 | 2 | 2 | 2 | 2 | [transfers-empty](../../artifacts/ui-review/after/narrow-transfers-empty.png)；高频导航/内容更新保持即时；无新增装饰动画；静态检查无动效回归证据。 |
| narrow | profile | 10→10 | 2 | 2 | 2 | 2 | 2 | [profile](../../artifacts/ui-review/after/narrow-profile.png)；高频导航/内容更新保持即时；无新增装饰动画；静态检查无动效回归证据。 |
| narrow | chat-content | 10→10 | 2 | 2 | 2 | 2 | 2 | [chat-content](../../artifacts/ui-review/after/narrow-chat-content.png)；高频导航/内容更新保持即时；无新增装饰动画；静态检查无动效回归证据。 |
| narrow | files | 10→10 | 2 | 2 | 2 | 2 | 2 | [files](../../artifacts/ui-review/after/narrow-files.png)；高频导航/内容更新保持即时；无新增装饰动画；静态检查无动效回归证据。 |
| narrow | image-preview | 9.5→10 | 2 | 2 | 2 | 2 | 2 | [image-preview](../../artifacts/ui-review/after/narrow-image-preview.png)；共享弹层：偶发可信指针首开 160ms；键盘/程序打开与换页即时；机械测试覆盖取消及减弱动效。 |
| narrow | file-actions | 9.5→10 | 2 | 2 | 2 | 2 | 2 | [file-actions](../../artifacts/ui-review/after/narrow-file-actions.png)；共享弹层：偶发可信指针首开 160ms；键盘/程序打开与换页即时；机械测试覆盖取消及减弱动效。 |
| narrow | file-draft | 10→10 | 2 | 2 | 2 | 2 | 2 | [file-draft](../../artifacts/ui-review/after/narrow-file-draft.png)；高频导航/内容更新保持即时；无新增装饰动画；静态检查无动效回归证据。 |
| narrow | groups-picker | 10→10 | 2 | 2 | 2 | 2 | 2 | [groups-picker](../../artifacts/ui-review/after/narrow-groups-picker.png)；高频导航/内容更新保持即时；无新增装饰动画；静态检查无动效回归证据。 |
| narrow | create-animal | 9.5→10 | 2 | 2 | 2 | 2 | 2 | [create-animal](../../artifacts/ui-review/after/narrow-create-animal.png)；共享弹层：偶发可信指针首开 160ms；键盘/程序打开与换页即时；机械测试覆盖取消及减弱动效。 |
| narrow | create-validation | 9.5→10 | 2 | 2 | 2 | 2 | 2 | [create-validation](../../artifacts/ui-review/after/narrow-create-validation.png)；共享弹层：偶发可信指针首开 160ms；键盘/程序打开与换页即时；机械测试覆盖取消及减弱动效。 |
| narrow | join | 9.5→10 | 2 | 2 | 2 | 2 | 2 | [join](../../artifacts/ui-review/after/narrow-join.png)；共享弹层：偶发可信指针首开 160ms；键盘/程序打开与换页即时；机械测试覆盖取消及减弱动效。 |
| narrow | join-nearby | 8.5→10 | 2 | 2 | 2 | 2 | 2 | [join-nearby](../../artifacts/ui-review/after/narrow-join-nearby.png)；异步控件焦点恢复；最终 gallery 无失焦发现。 |
| narrow | join-waiting | 9.5→10 | 2 | 2 | 2 | 2 | 2 | [join-waiting](../../artifacts/ui-review/after/narrow-join-waiting.png)；共享弹层：偶发可信指针首开 160ms；键盘/程序打开与换页即时；机械测试覆盖取消及减弱动效。 |
| narrow | invite | 9.5→10 | 2 | 2 | 2 | 2 | 2 | [invite](../../artifacts/ui-review/after/narrow-invite.png)；共享弹层：偶发可信指针首开 160ms；键盘/程序打开与换页即时；机械测试覆盖取消及减弱动效。 |
| narrow | connect-device | 9.5→10 | 2 | 2 | 2 | 2 | 2 | [connect-device](../../artifacts/ui-review/after/narrow-connect-device.png)；共享弹层：偶发可信指针首开 160ms；键盘/程序打开与换页即时；机械测试覆盖取消及减弱动效。 |
| narrow | connect-error | 9.5→10 | 2 | 2 | 2 | 2 | 2 | [connect-error](../../artifacts/ui-review/after/narrow-connect-error.png)；共享弹层：偶发可信指针首开 160ms；键盘/程序打开与换页即时；机械测试覆盖取消及减弱动效。 |
| narrow | members-approval | 9.5→10 | 2 | 2 | 2 | 2 | 2 | [members-approval](../../artifacts/ui-review/after/narrow-members-approval.png)；共享弹层：偶发可信指针首开 160ms；键盘/程序打开与换页即时；机械测试覆盖取消及减弱动效。 |
| narrow | remove-member-confirm | 9.5→10 | 2 | 2 | 2 | 2 | 2 | [remove-member-confirm](../../artifacts/ui-review/after/narrow-remove-member-confirm.png)；共享弹层：偶发可信指针首开 160ms；键盘/程序打开与换页即时；机械测试覆盖取消及减弱动效。 |
| narrow | settings | 9.5→10 | 2 | 2 | 2 | 2 | 2 | [settings](../../artifacts/ui-review/after/narrow-settings.png)；共享弹层：偶发可信指针首开 160ms；键盘/程序打开与换页即时；机械测试覆盖取消及减弱动效。 |
| narrow | group-settings | 9.5→10 | 2 | 2 | 2 | 2 | 2 | [group-settings](../../artifacts/ui-review/after/narrow-group-settings.png)；共享弹层：偶发可信指针首开 160ms；键盘/程序打开与换页即时；机械测试覆盖取消及减弱动效。 |
| narrow | leave-confirm | 9.5→10 | 2 | 2 | 2 | 2 | 2 | [leave-confirm](../../artifacts/ui-review/after/narrow-leave-confirm.png)；共享弹层：偶发可信指针首开 160ms；键盘/程序打开与换页即时；机械测试覆盖取消及减弱动效。 |
| narrow | forget-confirm | 9.5→10 | 2 | 2 | 2 | 2 | 2 | [forget-confirm](../../artifacts/ui-review/after/narrow-forget-confirm.png)；共享弹层：偶发可信指针首开 160ms；键盘/程序打开与换页即时；机械测试覆盖取消及减弱动效。 |
| narrow | storage | 9.5→10 | 2 | 2 | 2 | 2 | 2 | [storage](../../artifacts/ui-review/after/narrow-storage.png)；共享弹层：偶发可信指针首开 160ms；键盘/程序打开与换页即时；机械测试覆盖取消及减弱动效。 |
| narrow | clear-cache-confirm | 9.5→10 | 2 | 2 | 2 | 2 | 2 | [clear-cache-confirm](../../artifacts/ui-review/after/narrow-clear-cache-confirm.png)；共享弹层：偶发可信指针首开 160ms；键盘/程序打开与换页即时；机械测试覆盖取消及减弱动效。 |
| narrow | transfers-mixed | 7.0→10 | 2 | 2 | 2 | 2 | 2 | [transfers-mixed](../../artifacts/ui-review/after/narrow-transfers-mixed.png)；稳定传输行与按钮；进度焦点探针通过；终态只迁移本行被隐藏的当前焦点。 |
| narrow | transfers-progress-focus | 7.0→10 | 2 | 2 | 2 | 2 | 2 | [transfers-progress-focus](../../artifacts/ui-review/after/narrow-transfers-progress-focus.png)；稳定传输行与按钮；进度焦点探针通过；终态只迁移本行被隐藏的当前焦点。 |
| narrow | membership-revoked | 10→10 | 2 | 2 | 2 | 2 | 2 | [membership-revoked](../../artifacts/ui-review/after/narrow-membership-revoked.png)；高频导航/内容更新保持即时；无新增装饰动画；静态检查无动效回归证据。 |
| narrow | chat-empty-long-title | 10→10 | 2 | 2 | 2 | 2 | 2 | [chat-empty-long-title](../../artifacts/ui-review/after/narrow-chat-empty-long-title.png)；高频导航/内容更新保持即时；无新增装饰动画；静态检查无动效回归证据。 |
| narrow | files-empty | 10→10 | 2 | 2 | 2 | 2 | 2 | [files-empty](../../artifacts/ui-review/after/narrow-files-empty.png)；高频导航/内容更新保持即时；无新增装饰动画；静态检查无动效回归证据。 |
| narrow | group-settings-member | 9.5→10 | 2 | 2 | 2 | 2 | 2 | [group-settings-member](../../artifacts/ui-review/after/narrow-group-settings-member.png)；共享弹层：偶发可信指针首开 160ms；键盘/程序打开与换页即时；机械测试覆盖取消及减弱动效。 |
| narrow | transfers-page | 7.0→10 | 2 | 2 | 2 | 2 | 2 | [transfers-page](../../artifacts/ui-review/after/narrow-transfers-page.png)；稳定传输行与按钮；进度焦点探针通过；终态只迁移本行被隐藏的当前焦点。 |
| narrow | profile-with-groups | 10→10 | 2 | 2 | 2 | 2 | 2 | [profile-with-groups](../../artifacts/ui-review/after/narrow-profile-with-groups.png)；高频导航/内容更新保持即时；无新增装饰动画；静态检查无动效回归证据。 |
| narrow | incoming-share | 9.5→10 | 2 | 2 | 2 | 2 | 2 | [incoming-share](../../artifacts/ui-review/after/narrow-incoming-share.png)；共享弹层：偶发可信指针首开 160ms；键盘/程序打开与换页即时；机械测试覆盖取消及减弱动效。 |
| narrow | no-groups | 10→10 | 2 | 2 | 2 | 2 | 2 | [no-groups](../../artifacts/ui-review/after/narrow-no-groups.png)；高频导航/内容更新保持即时；无新增装饰动画；静态检查无动效回归证据。 |
| landscape | home-groups | 10→10 | 2 | 2 | 2 | 2 | 2 | [home-groups](../../artifacts/ui-review/after/landscape-home-groups.png)；高频导航/内容更新保持即时；无新增装饰动画；静态检查无动效回归证据。 |
| landscape | transfers-empty | 10→10 | 2 | 2 | 2 | 2 | 2 | [transfers-empty](../../artifacts/ui-review/after/landscape-transfers-empty.png)；高频导航/内容更新保持即时；无新增装饰动画；静态检查无动效回归证据。 |
| landscape | profile | 10→10 | 2 | 2 | 2 | 2 | 2 | [profile](../../artifacts/ui-review/after/landscape-profile.png)；高频导航/内容更新保持即时；无新增装饰动画；静态检查无动效回归证据。 |
| landscape | chat-content | 10→10 | 2 | 2 | 2 | 2 | 2 | [chat-content](../../artifacts/ui-review/after/landscape-chat-content.png)；高频导航/内容更新保持即时；无新增装饰动画；静态检查无动效回归证据。 |
| landscape | files | 10→10 | 2 | 2 | 2 | 2 | 2 | [files](../../artifacts/ui-review/after/landscape-files.png)；高频导航/内容更新保持即时；无新增装饰动画；静态检查无动效回归证据。 |
| landscape | image-preview | 9.5→10 | 2 | 2 | 2 | 2 | 2 | [image-preview](../../artifacts/ui-review/after/landscape-image-preview.png)；共享弹层：偶发可信指针首开 160ms；键盘/程序打开与换页即时；机械测试覆盖取消及减弱动效。 |
| landscape | file-actions | 9.5→10 | 2 | 2 | 2 | 2 | 2 | [file-actions](../../artifacts/ui-review/after/landscape-file-actions.png)；共享弹层：偶发可信指针首开 160ms；键盘/程序打开与换页即时；机械测试覆盖取消及减弱动效。 |
| landscape | file-draft | 10→10 | 2 | 2 | 2 | 2 | 2 | [file-draft](../../artifacts/ui-review/after/landscape-file-draft.png)；高频导航/内容更新保持即时；无新增装饰动画；静态检查无动效回归证据。 |
| landscape | groups-picker | 10→10 | 2 | 2 | 2 | 2 | 2 | [groups-picker](../../artifacts/ui-review/after/landscape-groups-picker.png)；高频导航/内容更新保持即时；无新增装饰动画；静态检查无动效回归证据。 |
| landscape | create-animal | 9.5→10 | 2 | 2 | 2 | 2 | 2 | [create-animal](../../artifacts/ui-review/after/landscape-create-animal.png)；共享弹层：偶发可信指针首开 160ms；键盘/程序打开与换页即时；机械测试覆盖取消及减弱动效。 |
| landscape | create-validation | 9.5→10 | 2 | 2 | 2 | 2 | 2 | [create-validation](../../artifacts/ui-review/after/landscape-create-validation.png)；共享弹层：偶发可信指针首开 160ms；键盘/程序打开与换页即时；机械测试覆盖取消及减弱动效。 |
| landscape | join | 9.5→10 | 2 | 2 | 2 | 2 | 2 | [join](../../artifacts/ui-review/after/landscape-join.png)；共享弹层：偶发可信指针首开 160ms；键盘/程序打开与换页即时；机械测试覆盖取消及减弱动效。 |
| landscape | join-nearby | 8.5→10 | 2 | 2 | 2 | 2 | 2 | [join-nearby](../../artifacts/ui-review/after/landscape-join-nearby.png)；异步控件焦点恢复；最终 gallery 无失焦发现。 |
| landscape | join-waiting | 9.5→10 | 2 | 2 | 2 | 2 | 2 | [join-waiting](../../artifacts/ui-review/after/landscape-join-waiting.png)；共享弹层：偶发可信指针首开 160ms；键盘/程序打开与换页即时；机械测试覆盖取消及减弱动效。 |
| landscape | invite | 9.5→10 | 2 | 2 | 2 | 2 | 2 | [invite](../../artifacts/ui-review/after/landscape-invite.png)；共享弹层：偶发可信指针首开 160ms；键盘/程序打开与换页即时；机械测试覆盖取消及减弱动效。 |
| landscape | connect-device | 9.5→10 | 2 | 2 | 2 | 2 | 2 | [connect-device](../../artifacts/ui-review/after/landscape-connect-device.png)；共享弹层：偶发可信指针首开 160ms；键盘/程序打开与换页即时；机械测试覆盖取消及减弱动效。 |
| landscape | connect-error | 9.5→10 | 2 | 2 | 2 | 2 | 2 | [connect-error](../../artifacts/ui-review/after/landscape-connect-error.png)；共享弹层：偶发可信指针首开 160ms；键盘/程序打开与换页即时；机械测试覆盖取消及减弱动效。 |
| landscape | members-approval | 9.5→10 | 2 | 2 | 2 | 2 | 2 | [members-approval](../../artifacts/ui-review/after/landscape-members-approval.png)；共享弹层：偶发可信指针首开 160ms；键盘/程序打开与换页即时；机械测试覆盖取消及减弱动效。 |
| landscape | remove-member-confirm | 9.5→10 | 2 | 2 | 2 | 2 | 2 | [remove-member-confirm](../../artifacts/ui-review/after/landscape-remove-member-confirm.png)；共享弹层：偶发可信指针首开 160ms；键盘/程序打开与换页即时；机械测试覆盖取消及减弱动效。 |
| landscape | settings | 9.5→10 | 2 | 2 | 2 | 2 | 2 | [settings](../../artifacts/ui-review/after/landscape-settings.png)；共享弹层：偶发可信指针首开 160ms；键盘/程序打开与换页即时；机械测试覆盖取消及减弱动效。 |
| landscape | group-settings | 9.5→10 | 2 | 2 | 2 | 2 | 2 | [group-settings](../../artifacts/ui-review/after/landscape-group-settings.png)；共享弹层：偶发可信指针首开 160ms；键盘/程序打开与换页即时；机械测试覆盖取消及减弱动效。 |
| landscape | leave-confirm | 9.5→10 | 2 | 2 | 2 | 2 | 2 | [leave-confirm](../../artifacts/ui-review/after/landscape-leave-confirm.png)；共享弹层：偶发可信指针首开 160ms；键盘/程序打开与换页即时；机械测试覆盖取消及减弱动效。 |
| landscape | forget-confirm | 9.5→10 | 2 | 2 | 2 | 2 | 2 | [forget-confirm](../../artifacts/ui-review/after/landscape-forget-confirm.png)；共享弹层：偶发可信指针首开 160ms；键盘/程序打开与换页即时；机械测试覆盖取消及减弱动效。 |
| landscape | storage | 9.5→10 | 2 | 2 | 2 | 2 | 2 | [storage](../../artifacts/ui-review/after/landscape-storage.png)；共享弹层：偶发可信指针首开 160ms；键盘/程序打开与换页即时；机械测试覆盖取消及减弱动效。 |
| landscape | clear-cache-confirm | 9.5→10 | 2 | 2 | 2 | 2 | 2 | [clear-cache-confirm](../../artifacts/ui-review/after/landscape-clear-cache-confirm.png)；共享弹层：偶发可信指针首开 160ms；键盘/程序打开与换页即时；机械测试覆盖取消及减弱动效。 |
| landscape | transfers-mixed | 7.0→10 | 2 | 2 | 2 | 2 | 2 | [transfers-mixed](../../artifacts/ui-review/after/landscape-transfers-mixed.png)；稳定传输行与按钮；进度焦点探针通过；终态只迁移本行被隐藏的当前焦点。 |
| landscape | transfers-progress-focus | 7.0→10 | 2 | 2 | 2 | 2 | 2 | [transfers-progress-focus](../../artifacts/ui-review/after/landscape-transfers-progress-focus.png)；稳定传输行与按钮；进度焦点探针通过；终态只迁移本行被隐藏的当前焦点。 |
| landscape | membership-revoked | 10→10 | 2 | 2 | 2 | 2 | 2 | [membership-revoked](../../artifacts/ui-review/after/landscape-membership-revoked.png)；高频导航/内容更新保持即时；无新增装饰动画；静态检查无动效回归证据。 |
| landscape | chat-empty-long-title | 10→10 | 2 | 2 | 2 | 2 | 2 | [chat-empty-long-title](../../artifacts/ui-review/after/landscape-chat-empty-long-title.png)；高频导航/内容更新保持即时；无新增装饰动画；静态检查无动效回归证据。 |
| landscape | files-empty | 10→10 | 2 | 2 | 2 | 2 | 2 | [files-empty](../../artifacts/ui-review/after/landscape-files-empty.png)；高频导航/内容更新保持即时；无新增装饰动画；静态检查无动效回归证据。 |
| landscape | group-settings-member | 9.5→10 | 2 | 2 | 2 | 2 | 2 | [group-settings-member](../../artifacts/ui-review/after/landscape-group-settings-member.png)；共享弹层：偶发可信指针首开 160ms；键盘/程序打开与换页即时；机械测试覆盖取消及减弱动效。 |
| landscape | transfers-page | 7.0→10 | 2 | 2 | 2 | 2 | 2 | [transfers-page](../../artifacts/ui-review/after/landscape-transfers-page.png)；稳定传输行与按钮；进度焦点探针通过；终态只迁移本行被隐藏的当前焦点。 |
| landscape | profile-with-groups | 10→10 | 2 | 2 | 2 | 2 | 2 | [profile-with-groups](../../artifacts/ui-review/after/landscape-profile-with-groups.png)；高频导航/内容更新保持即时；无新增装饰动画；静态检查无动效回归证据。 |
| landscape | incoming-share | 9.5→10 | 2 | 2 | 2 | 2 | 2 | [incoming-share](../../artifacts/ui-review/after/landscape-incoming-share.png)；共享弹层：偶发可信指针首开 160ms；键盘/程序打开与换页即时；机械测试覆盖取消及减弱动效。 |
| landscape | no-groups | 10→10 | 2 | 2 | 2 | 2 | 2 | [no-groups](../../artifacts/ui-review/after/landscape-no-groups.png)；高频导航/内容更新保持即时；无新增装饰动画；静态检查无动效回归证据。 |

逐项源码与机器可读数据见 [motion-after.json](2026-10-13-motion-after.json)。Before 对应 [原评分](../../plans/motion-review-before.md)。
