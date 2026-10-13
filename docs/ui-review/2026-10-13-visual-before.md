# UI 视觉形状初评 · 2026-10-13

主观专业评审，不是客观合格证。基线 `859c4c5`；依据 ui-ux-pro-max Quick Reference，保留既有白色紧凑风格。已实际查看 manifest 全部136张截图（四尺寸联系表），并放大核对窄屏校验、横屏加入/邀请，以及原生桌面 main-window、Android 03-keyboard。源码只用于定位建议。

每项满分2，总分10；分项依次为轮廓/圆角、布局层级、字体密度、控件状态和触达、窄屏/长内容。每scene给同构页面综合分，最后一项按最差已见尺寸，不将四尺寸重复计权。横屏首屏外不等于无法滚动，但缺少持续标题/主操作是布局弱点。动画由另一专家评审。

共36个实际scene，均分 **7.54/10**。

| Scene | 轮廓 | 层级 | 字体 | 状态触达 | 响应 | 总分 | 证据与说明 |
|---|---:|---:|---:|---:|---:|---:|---|
| chat-content | 1.6 | 1.6 | 1.5 | 1.4 | 1.4 | 7.5 | [desktop-chat-content.png](../../artifacts/ui-review/before/desktop-chat-content.png)；白色紧凑体系成立；次要文字偏小，手机顶部三层占高、输入按钮触达偏小。 |
| files | 1.6 | 1.6 | 1.5 | 1.4 | 1.4 | 7.5 | [desktop-files.png](../../artifacts/ui-review/before/desktop-files.png)；白色紧凑体系成立；次要文字偏小，手机顶部三层占高、输入按钮触达偏小。 |
| image-preview | 1.6 | 1.4 | 1.6 | 1.5 | 1.1 | 7.2 | [desktop-image-preview.png](../../artifacts/ui-review/before/desktop-image-preview.png)；标题可换行；三个操作纵向占高，横屏首屏看不到保存/更多。 |
| file-actions | 1.7 | 1.5 | 1.6 | 1.6 | 1.5 | 7.9 | [desktop-file-actions.png](../../artifacts/ui-review/before/desktop-file-actions.png)；操作行可触达但层级同权、纵向略松。 |
| file-draft | 1.3 | 1.6 | 1.6 | 1.4 | 1.5 | 7.4 | [desktop-file-draft.png](../../artifacts/ui-review/before/desktop-file-draft.png)；直角输入焦点框与圆角外壳冲突；草稿可换行，横屏内容剩余高度少。 |
| groups-picker | 1.7 | 1.6 | 1.6 | 1.6 | 1.3 | 7.8 | [desktop-groups-picker.png](../../artifacts/ui-review/before/desktop-groups-picker.png)；选群和创建分明；横屏扫描入口在首屏外。 |
| create-animal | 1.7 | 1.7 | 1.6 | 1.7 | 1.5 | 8.2 | [desktop-create-animal.png](../../artifacts/ui-review/before/desktop-create-animal.png)；动物选中框清晰；横屏底部接近边界。 |
| create-validation | 1.7 | 1.2 | 1.5 | 1.1 | 1.3 | 6.8 | [desktop-create-validation.png](../../artifacts/ui-review/before/desktop-create-validation.png)；错误在创建按钮之后、黑色，无法快速对应字段；横屏提示在折叠区外。 |
| join | 1.7 | 1.3 | 1.6 | 1.5 | 1.0 | 7.1 | [desktop-join.png](../../artifacts/ui-review/before/desktop-join.png)；三种加入路径同屏无分组；横屏主要动作不可见。 |
| join-nearby | 1.7 | 1.2 | 1.6 | 1.2 | 0.8 | 6.5 | [desktop-join-nearby.png](../../artifacts/ui-review/before/desktop-join-nearby.png)；动态结果出现后横屏标题/关闭消失，主要动作仍不完整；manifest另记录焦点丢失。 |
| join-waiting | 1.7 | 1.6 | 1.5 | 1.5 | 1.7 | 8.0 | [desktop-join-waiting.png](../../artifacts/ui-review/before/desktop-join-waiting.png)；等待文案清楚，关闭是唯一操作；无视觉进度但不能据静态图判断动态状态。 |
| invite | 1.7 | 1.6 | 1.6 | 1.6 | 1.0 | 7.5 | [desktop-invite.png](../../artifacts/ui-review/before/desktop-invite.png)；二维码优先合理；横屏地址/邀请码/复制被推到折叠区外。 |
| connect-device | 1.7 | 1.7 | 1.6 | 1.7 | 1.7 | 8.4 | [desktop-connect-device.png](../../artifacts/ui-review/before/desktop-connect-device.png)；单字段单主操作清晰。 |
| connect-error | 1.7 | 1.5 | 1.4 | 1.3 | 1.7 | 7.6 | [desktop-connect-error.png](../../artifacts/ui-review/before/desktop-connect-error.png)；字段下有错误但灰色弱化，和辅助说明近似。 |
| members-approval | 1.7 | 1.3 | 1.4 | 1.2 | 1.2 | 6.8 | [desktop-members-approval.png](../../artifacts/ui-review/before/desktop-members-approval.png)；申请与成员未分标题；允许/拒绝/移除同黑字；窄屏名称和动作拥挤。 |
| remove-member-confirm | 1.7 | 1.4 | 1.6 | 1.0 | 1.7 | 7.4 | [desktop-remove-member-confirm.png](../../artifacts/ui-review/before/desktop-remove-member-confirm.png)；通用蓝色确认缺少动作名和危险层级；取消可见。 |
| settings | 1.7 | 1.3 | 1.6 | 1.5 | 1.0 | 7.1 | [desktop-settings.png](../../artifacts/ui-review/before/desktop-settings.png)；导航行与保存混排；桌面窗口项及横屏后续项需滚动，标题未保留。 |
| group-settings | 1.7 | 1.6 | 1.6 | 1.5 | 1.6 | 8.0 | [desktop-group-settings.png](../../artifacts/ui-review/before/desktop-group-settings.png)；保存主操作与红色退出有区别；危险区缺少独立分隔。 |
| leave-confirm | 1.7 | 1.4 | 1.6 | 1.0 | 1.7 | 7.4 | [desktop-leave-confirm.png](../../artifacts/ui-review/before/desktop-leave-confirm.png)；通用蓝色确认缺少动作名和危险层级；取消可见。 |
| forget-confirm | 1.7 | 1.4 | 1.6 | 1.0 | 1.7 | 7.4 | [desktop-forget-confirm.png](../../artifacts/ui-review/before/desktop-forget-confirm.png)；通用蓝色确认缺少动作名和危险层级；取消可见。 |
| storage | 1.7 | 1.5 | 1.6 | 1.4 | 1.7 | 7.9 | [desktop-storage.png](../../artifacts/ui-review/before/desktop-storage.png)；缓存统计与清理同弱层级，缺少明确操作轮廓。 |
| clear-cache-confirm | 1.7 | 1.4 | 1.6 | 1.0 | 1.7 | 7.4 | [desktop-clear-cache-confirm.png](../../artifacts/ui-review/before/desktop-clear-cache-confirm.png)；通用蓝色确认缺少动作名和危险层级；取消可见。 |
| transfers-mixed | 1.4 | 1.3 | 1.4 | 1.1 | 1.2 | 6.4 | [desktop-transfers-mixed.png](../../artifacts/ui-review/before/desktop-transfers-mixed.png)；状态混在文件名一行、进度细线形状同构；失败/取消缺少状态区分；横屏长列表。 |
| transfers-progress-focus | 1.4 | 1.3 | 1.4 | 1.1 | 1.2 | 6.4 | [desktop-transfers-progress-focus.png](../../artifacts/ui-review/before/desktop-transfers-progress-focus.png)；状态混在文件名一行、进度细线形状同构；失败/取消缺少状态区分；横屏长列表。 |
| membership-revoked | 1.6 | 1.6 | 1.4 | 1.4 | 1.2 | 7.2 | [desktop-membership-revoked.png](../../artifacts/ui-review/before/desktop-membership-revoked.png)；黄色说明有效；窄屏传输摘要与草稿争空间，横屏几乎无消息空间。 |
| chat-empty-long-title | 1.6 | 1.5 | 1.5 | 1.5 | 1.6 | 7.7 | [desktop-chat-empty-long-title.png](../../artifacts/ui-review/before/desktop-chat-empty-long-title.png)；标题省略合理，空状态清楚但缺下一步提示。 |
| files-empty | 1.6 | 1.5 | 1.5 | 1.5 | 1.6 | 7.7 | [desktop-files-empty.png](../../artifacts/ui-review/before/desktop-files-empty.png)；标题省略合理，空状态清楚但缺下一步提示。 |
| group-settings-member | 1.7 | 1.6 | 1.6 | 1.5 | 1.7 | 8.1 | [desktop-group-settings-member.png](../../artifacts/ui-review/before/desktop-group-settings-member.png)；只读名称可换行；危险动作分隔不足。 |
| incoming-share | 1.7 | 1.6 | 1.5 | 1.7 | 1.6 | 8.1 | [desktop-incoming-share.png](../../artifacts/ui-review/before/desktop-incoming-share.png)；发送主操作明确；目标与内容均灰字，分组可加强。 |
| no-groups | 1.7 | 1.5 | 1.6 | 1.6 | 1.7 | 8.1 | [desktop-no-groups.png](../../artifacts/ui-review/before/desktop-no-groups.png)；桌面创建在空状态、移动端在右上角；移动空状态入口分散。 |
| home-groups | 1.7 | 1.7 | 1.6 | 1.7 | 1.7 | 8.4 | [mobile-home-groups.png](../../artifacts/ui-review/before/mobile-home-groups.png)；长群名自然换行；入口层级清楚。 |
| transfers-empty | 1.7 | 1.4 | 1.6 | 1.7 | 1.7 | 8.1 | [mobile-transfers-empty.png](../../artifacts/ui-review/before/mobile-transfers-empty.png)；空状态仅一行，缺少任务来源提示。 |
| profile | 1.7 | 1.7 | 1.7 | 1.6 | 1.7 | 8.4 | [mobile-profile.png](../../artifacts/ui-review/before/mobile-profile.png)；设备卡和设置行层级清楚，入口缺少方向提示。 |
| keyboard-viewport-simulation | 1.3 | 1.6 | 1.6 | 1.4 | 1.5 | 7.4 | [mobile-keyboard-viewport-simulation.png](../../artifacts/ui-review/before/mobile-keyboard-viewport-simulation.png)；直角输入焦点框与圆角外壳冲突；草稿可换行，横屏内容剩余高度少。 |
| transfers-page | 1.4 | 1.3 | 1.4 | 1.1 | 1.2 | 6.4 | [mobile-transfers-page.png](../../artifacts/ui-review/before/mobile-transfers-page.png)；状态混在文件名一行、进度细线形状同构；失败/取消缺少状态区分；横屏长列表。 |
| profile-with-groups | 1.7 | 1.7 | 1.7 | 1.6 | 1.7 | 8.4 | [mobile-profile-with-groups.png](../../artifacts/ui-review/before/mobile-profile-with-groups.png)；设备卡和设置行层级清楚，入口缺少方向提示。 |

所有尺寸证据逐项在 `artifacts/ui-review/visual-before.json` 的 evidence 数组。

## 可执行修正

### P1 V1 · 横屏长弹层保持标题、关闭和主要操作可达

位置：`apps/tauri/src/style.css:6,8,23; apps/tauri/src/index.html dialog; src/main.js panel()`。dialog 使用受 dvh/safe-area 约束的 grid/flex；heading 不滚动，panel-body min-height:0; overflow:auto；必要时独立 .panel-actions，主要按钮可见。不要通过整体缩小字体解决。

证据：[landscape-join-nearby.png](../../artifacts/ui-review/before/landscape-join-nearby.png), [landscape-invite.png](../../artifacts/ui-review/before/landscape-invite.png), [landscape-settings.png](../../artifacts/ui-review/before/landscape-settings.png)。

### P1 V2 · 错误信息归属字段且语义清晰

位置：`apps/tauri/src/main.js:43,54,174; style.css .panel-error`。字段错误放到输入下，aria-describedby/aria-invalid 保留；错误色与普通辅助文案区分，保留具体错误文字。

证据：[narrow-create-validation.png](../../artifacts/ui-review/before/narrow-create-validation.png), [mobile-connect-error.png](../../artifacts/ui-review/before/mobile-connect-error.png)。

### P1 V3 · 危险确认写明动作

位置：`apps/tauri/src/main.js:251 confirmPanel`。用退出群组、移除成员、移除记录、清理缓存替代确认；destructive 类使用明确危险色，取消保持次级。

证据：[mobile-remove-member-confirm.png](../../artifacts/ui-review/before/mobile-remove-member-confirm.png), [desktop-forget-confirm.png](../../artifacts/ui-review/before/desktop-forget-confirm.png)。

### P2 V4 · 输入焦点轮廓与外壳统一并扩大手机触达

位置：`apps/tauri/src/style.css:22,26`。composer:focus-within 使用同圆角的2px ring；textarea自身ring去除必须由父容器可见ring替代；手机按钮触达至少44 CSS px，图标可保留原大小。

证据：[narrow-file-draft.png](../../artifacts/ui-review/before/narrow-file-draft.png), [mobile-keyboard-viewport-simulation.png](../../artifacts/ui-review/before/mobile-keyboard-viewport-simulation.png)。

### P2 V5 · 传输和成员列表区分名称、状态、动作

位置：`apps/tauri/src/main.js transfer rendering / membersPanel; style.css .transfer/.member`。文件名独立可换行，状态独立文字/徽记；失败/取消不保留相同进行中视觉；成员申请与已加入分组，窄屏动作行可换行。

证据：[narrow-transfers-mixed.png](../../artifacts/ui-review/before/narrow-transfers-mixed.png), [narrow-members-approval.png](../../artifacts/ui-review/before/narrow-members-approval.png)。

### P2 V6 · 层级微调保持紧凑白色方向

位置：`apps/tauri/src/style.css .setting-row/.panel-heading/.muted`。设置导航加方向提示；危险区加间距或分隔线；手机顶部低高度横屏缩减strip外边距，辅助字号避免继续缩小。

证据：[desktop-settings.png](../../artifacts/ui-review/before/desktop-settings.png), [landscape-chat-content.png](../../artifacts/ui-review/before/landscape-chat-content.png)。

## 复评口径

复用同一scene与四尺寸，再逐项比较，不因修复代码已写就自动加分。P1要有错误位置、危险动作文字和横屏长弹层实图；P2要有输入聚焦、传输混合状态、窄屏成员实图。保留原生Android IME验证；浏览器缩高不等同真实软键盘。没有独立动物编辑页或网络设置页，不新增虚构评分对象。
