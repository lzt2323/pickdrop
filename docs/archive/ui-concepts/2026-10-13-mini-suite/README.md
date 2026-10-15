# 拾传 mini 整套设计 · 2026-10-13

用户修正：首页保持传输助手风格，设计必须覆盖现有完整业务，不改造成独立投递箱。这套先统一使用浅色蓝色强调的视觉体系，供检查页面结构；不是运行截图，也不是已实施版本。

由流程核对 agent、美术总监 agent 协作，主 agent 使用内置 image_gen 出图。三组共18页/状态，目标320×420逻辑尺寸；采用固定标题、固定主操作、中部滚动。移动端沿用同一信息层级，但保留其已有导航和扫码能力。

## 整套图片

- [01 传输与建群](01-transfer-create-invite.png)：传输助手、我的群组、创建、空名称错误、邀请设备、文件操作。
- [02 加入与审核](02-join-review.png)：加入、附近发现、等待、被拒绝、成员与申请、移除确认。
- [03 设置与维护](03-settings-cache.png)：缓存统计、清理确认、设备设置、群组设置、连接失败、传输队列。

## 与当前实现的对应

|页面|当前入口/函数|保留内容|
|---|---|---|
|首页|selectGroup / renderMessages|群切换、成员状态、全部/文件、邀请、文字和文件消息、底部附件/输入/发送|
|我的群组|groupsPanel|群列表、创建、加入；桌面没有扫码|
|创建及校验|createPanel|名称、10种动物、空名称提示、创建后进入群|
|邀请|invitePanel|二维码、设备地址、邀请码、复制链接|
|加入/附近|joinPanel|链接解析、邀请码、地址、端口、附近群、申请加入|
|等待/拒绝|joinWaiting|每2秒轮询，批准进群，拒绝显示提示；关闭不等于撤回申请|
|审核与成员|membersPanel|本机收到的请求、允许/拒绝、本机/在线/离线成员、连接已有设备|
|移除确认|confirmPanel + remove_member|创建者可移除其他设备|
|缓存与确认|storagePanel + clear_cache|全部本机files缓存、文件数；确认清理，聊天记录保留，原始文件不受影响|
|设置|settingsPanel|设备名、缓存、成员、群设置、桌面贴边|
|群设置|groupSettingsPanel|创建者可改名，退出及移除本地记录；不是删除全群|
|连接已有设备|connectPeerPanel|地址、连接、错误；不等同加入新群|
|传输|renderQueue|进度、状态、取消、失败重试、清除任务记录|
|文件操作|fileActionsPanel|打开、另存为、分享、桌面拖出|

核对代码：apps/tauri/src/main.js、crates/pickdrop-core/src/lib.rs、crates/pickdrop-core/src/protocol.rs。

## 功能边界及施工约束

- 邀请码6位，有效5分钟且申请提交后消耗。当前UI未展示倒计时，本稿不添加倒计时或刷新按钮。
- 有效群成员可邀请并批准普通设备。申请保存在生成邀请的设备上，不是全群同步审批中心；不能称为“仅管理员审批”。
- 缓存清理涵盖发送与接收的本机缓存副本。现有UI“已接收文件”文案偏窄，施工应据Rust实际行为修正文案。没有分类、时间段、按群清理。
- 动物必须复用现有资源：小猫、绵羊、小猴、小狗、小鸡、小蜥蜴、羊驼、小兔、水獭、卡皮巴拉；不新增头像上传。
- 图中QR和地址/文件/申请设备均为示例，不可用于真实配对。
- 生成器多画的红黄绿系统按钮不落地，沿用当前无边框窗口。不同图的外框装饰需统一为一套标题栏。
- 图中“我的群组”及“附近群组”附带在线人数没有对应已接入数据，不照搬；只在当前群成员状态确有数据处显示。
- 页15及16按现有权限显示；普通成员看群名但不显示改名操作。
- 手机有扫码；桌面没有扫码。系统分享、文件保存及拖出仍调用现有原生桥接。
- 此轮是用户要求的整套图片预览，尚未修改生产UI或窗口尺寸；后续按用户对整套页面的反馈施工。

## 提示词

以下为内置 image_gen 的完整生成提示词（不使用CLI/API备用路径）。

### 组图 1

Use case: ui-mockup. Create a coherent high-fidelity DESIGN SYSTEM CONTACT SHEET for existing Chinese app 拾传, a mini local-network transfer assistant. LANDSCAPE canvas preferably 2400x1800 or larger, THREE COLUMNS and TWO ROWS of six complete desktop mini windows, all same logical 320x420 ratio, evenly spaced, no perspective and no phones. Each window must be fully visible with external numbered small caption. Extremely legible precise simplified Chinese. This sheet is for inspecting an entire implemented app flow, not marketing. Shared style across all six: warm white #FAFBFC surfaces, neutral light gray #F3F5F7 background, graphite #24282F text, secondary #727985, blue #3678E9 primary, subtle red #B93832 destructive; tiny green online dot. Outer radius12, controls7, 12px internal gutters, hairline dividers, native miniature tool quality, no heavy shadows, no huge art, no sidebar, no giant padding. Body text logically12-13px, header15px. Compact full-height SECONDARY VIEWS inside same mini shell, header title and close fixed, footer primary action fixed, middle scrollable when needed (subtle scrollbar). Do not superimpose oversized dialogs over dashboard. Existing feature constraints: real group-based text and file message feed (not redesigned into standalone drop-box homepage), no cloud account or contact network. No invented toolbar actions. No scan-camera action on desktop. Use small consistent outline icons; animals are existing 10 small animal choices only. Demo data consistent: group 设计群, local 电脑, peer Android 手机, pending 小林的手机, file 设计稿.fig 12.4 MB. Entire sheet top small heading specified below. Do not add extra panels beyond the six described. Sheet heading "拾传 mini · 01 传输与建群". Panel1 caption "01 传输助手": header tiny cat, "设计群⌄", pin, hide, settings; slim "2 台在线" member strip; small tabs "全部" "文件" and "邀请"; middle CHAT TIMELINE with peer label Android手机, simple text bubble "把文件发到这里", right-aligned own file card 设计稿.fig /12.4MB with small "保存" "更多", second text "收到了"; fixed bottom compact plus, input "传点什么…", arrow send. No huge upload zone. Panel2 "02 我的群组": two compact selectable rows cat 设计群 and rabbit 我的设备; footer blue "创建群组" and secondary "加入群组"; no desktop scan button. Panel3 "03 创建群组": field label 群组名称, value 拾传群; label 选择动物 with precisely 10 small animals in 5x2 grid (cat sheep monkey dog chick / lizard alpaca rabbit otter capybara), cat subtle blue selected outline; footer 创建. Panel4 "04 名称校验": same create view but empty name red outline, red inline "请输入群组名称", same animal grid and footer 创建. Panel5 "05 邀请设备": title 邀请设备 and context 设计群; centered modest144px-equivalent QR pattern with tiny label "二维码示意"; below readonly 设备地址 value http://192.168.1.24:9000, 邀请码 839271; footer blue 复制邀请链接. Do not imply QR is real, no countdown or refresh button. Panel6 "06 文件操作": title 设计稿.fig, small file metadata12.4MB; four simple action rows 打开 / 另存为 / 分享 / 拖出文件, close header. No deletion action.

### 组图 2

Use case: ui-mockup. Create a coherent high-fidelity DESIGN SYSTEM CONTACT SHEET for existing Chinese app 拾传, a mini local-network transfer assistant. LANDSCAPE canvas preferably 2400x1800 or larger, THREE COLUMNS and TWO ROWS of six complete desktop mini windows, all same logical 320x420 ratio, evenly spaced, no perspective and no phones. Each window must be fully visible with external numbered small caption. Extremely legible precise simplified Chinese. This sheet is for inspecting an entire implemented app flow, not marketing. Shared style across all six: warm white #FAFBFC surfaces, neutral light gray #F3F5F7 background, graphite #24282F text, secondary #727985, blue #3678E9 primary, subtle red #B93832 destructive; tiny green online dot. Outer radius12, controls7, 12px internal gutters, hairline dividers, native miniature tool quality, no heavy shadows, no huge art, no sidebar, no giant padding. Body text logically12-13px, header15px. Compact full-height SECONDARY VIEWS inside same mini shell, header title and close fixed, footer primary action fixed, middle scrollable when needed (subtle scrollbar). Do not superimpose oversized dialogs over dashboard. Existing feature constraints: real group-based text and file message feed (not redesigned into standalone drop-box homepage), no cloud account or contact network. No invented toolbar actions. No scan-camera action on desktop. Use small consistent outline icons; animals are existing 10 small animal choices only. Demo data consistent: group 设计群, local 电脑, peer Android 手机, pending 小林的手机, file 设计稿.fig 12.4 MB. Entire sheet top small heading specified below. Do not add extra panels beyond the six described. Sheet heading "拾传 mini · 02 加入与审核". Panel1 "07 加入群组": title 加入群组, fields 邀请链接 placeholder 粘贴邀请链接, 邀请码 839271, row 设备地址 192.168.1.24 and narrow 端口 9000; secondary 查找附近群组; fixed blue footer 申请加入. All fields fit using tight sane spacing, no desktop scan icon. Panel2 "08 附近群组": same join form, middle scrolled slightly to show address/port and small discovery result "附近的工作群" beneath 查找附近群组; slim visible scroll indicator, fixed header and 申请加入 footer. No assertion that selecting group alone joins; helper “选中后填写邀请码”. Panel3 "09 等待确认": header 等待加入确认 with close X; small simple pending icon, text "申请已发送" then "请在群内设备上允许加入。"; no cancel-request or resend button, no invented timer. Panel4 "10 申请被拒绝": same waiting shell, small muted red status icon, text "加入申请被拒绝。", close X only; no retry API invented. Panel5 "11 成员与加入申请": title 成员与加入申请; section 加入申请, pending 小林的手机 with separate blue 允许 and red-text 拒绝 buttons; next section 群内设备 rows 电脑（本机）, Android 手机（在线） with text 移除 on remote row (this particular view is from the creator); bottom secondary 手动连接已有设备. No global admin dashboard, no timestamps or request notes. Panel6 "12 移除成员确认": title 移除成员; calm concise “移除 Android 手机？”; footer secondary 取消 and red filled 移除成员, no pretend notification settings.

### 组图 3

Use case: ui-mockup. Create a coherent high-fidelity DESIGN SYSTEM CONTACT SHEET for existing Chinese app 拾传, a mini local-network transfer assistant. LANDSCAPE canvas preferably 2400x1800 or larger, THREE COLUMNS and TWO ROWS of six complete desktop mini windows, all same logical 320x420 ratio, evenly spaced, no perspective and no phones. Each window must be fully visible with external numbered small caption. Extremely legible precise simplified Chinese. This sheet is for inspecting an entire implemented app flow, not marketing. Shared style across all six: warm white #FAFBFC surfaces, neutral light gray #F3F5F7 background, graphite #24282F text, secondary #727985, blue #3678E9 primary, subtle red #B93832 destructive; tiny green online dot. Outer radius12, controls7, 12px internal gutters, hairline dividers, native miniature tool quality, no heavy shadows, no huge art, no sidebar, no giant padding. Body text logically12-13px, header15px. Compact full-height SECONDARY VIEWS inside same mini shell, header title and close fixed, footer primary action fixed, middle scrollable when needed (subtle scrollbar). Do not superimpose oversized dialogs over dashboard. Existing feature constraints: real group-based text and file message feed (not redesigned into standalone drop-box homepage), no cloud account or contact network. No invented toolbar actions. No scan-camera action on desktop. Use small consistent outline icons; animals are existing 10 small animal choices only. Demo data consistent: group 设计群, local 电脑, peer Android 手机, pending 小林的手机, file 设计稿.fig 12.4 MB. Entire sheet top small heading specified below. Do not add extra panels beyond the six described. Sheet heading "拾传 mini · 03 设置与维护". Panel1 "13 存储与缓存": title 存储与缓存; readable compact statistic 文件缓存, 272 MB, 24 个文件, NOT giant dashboard number; helper 本机文件缓存; action 清理缓存; do not draw storage quota, pie charts, per-type switches, auto cleanup. Panel2 "14 清理确认": title 清理缓存, exact explanatory text “清理本机文件缓存，聊天记录保留，原始文件不受影响。”; fixed footer neutral 取消 and red 清理缓存; modest cache icon optional, no undo guarantee. Panel3 "15 设置": title 设置; navigation 存储与缓存; field 本机名称 value 电脑; navigation 群组设置 and 成员; compact section 窗口 with 贴到左侧 / 贴到右侧 / 贴到顶部 / 取消贴边 in two rows; quiet version 拾传0.6.0-alpha.1; fixed footer 保存设备名称. Panel4 "16 群组设置": creator view title 群组设置, field 群组名称 value 设计群; divider; red-text 退出群组 and 移除本地群组记录; blue footer 保存群组名称. No delete-whole-group control, no privacy toggles or avatars upload. Panel5 "17 连接已有设备": field 另一台设备地址 value http://192.168.1.8:9000; inline error "连接失败：设备暂时离线。" and helper "请确认对方应用在前台，并检查设备地址。"; footer 连接设备. Panel6 "18 传输": title 传输; three compact rows: 设计稿.fig / 发送中 / 63% blue thin progress / 取消传输; 截图.png / 完成 / 清除; 资料.zip / 失败 / 重试 / 清除. Show textual status with restrained badge, no invented speed graph or queue priority.

