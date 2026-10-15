# 拾传 mini 窗口设计候选

2026-10-13。由三位美术 agent 提案，主 agent 使用内置 image_gen 分别生成三版概念效果图。用户希望先看图片再选方向施工；本阶段不替换生产 UI。

目标逻辑尺寸 320×420（当前440×720面积的约42%）。以下图片为放大概念效果图，不是运行截图或精确尺寸验收。

- A-native.png：原生轻量，投递优先。
- B-warm.png：暖色收件匣，紧凑列表和暖色主操作，推荐布局。
- C-dark.png：深色效率，当前传输优先。

共同约束：当前群组广播、在线成员摘要、文件投递、收发历史、文字快捷输入；管理功能进入二级界面；动物作为小型唤出入口。实际实现保留已有功能。生成图中多出的口号、最大化按钮、清空入口不构成新增功能需求；不会照搬。

待用户选择风格或混合方向后，实施原生窗口尺寸迁移、主界面层级重构、完整功能回归与模拟器测试。

## 最终生成提示词（内置工具，无 CLI）

### A

Use case: ui-mockup. Generate a high fidelity professional desktop application UI concept image for 拾传, a tiny cross-device LAN file transfer utility. Concept A: 原生轻量. Present ONE complete small floating window front-on, logical size 320 by 420 px, rendered crisply at 2x or 3x for inspection, with generous neutral light-gray surrounding canvas. Above the window label "A · 原生轻量" and below "320 × 420". This is NOT a phone screen, dashboard or chat app. Off-white #FAFAF8, graphite #24272B, restrained blue #3478F6, 14px outer radius, precise 12-16px internal gutters, hairline dividers, tiny line icons, native macOS craft. Layout: slim 32px header with tiny cat mark + 拾传 left and pin/minimize/more icons right; compact group row "设计群 ⌄" and green dot "2 台在线" (broadcast to group, not choosing individual recipients); a 96px dashed rounded drop well with modest file icon, "拖入文件，发送到群组", small blue button "选择文件"; thin recent section header "最近传输" / "全部"; two dense file rows "设计稿.fig" "12.4 MB · 发送中" with a 63% thin blue progress line, and "截图.png" "2.1 MB · 已接收" with small open icon; compact single-line bottom composer "文字或链接…" and blue arrow button. Space efficiency and clear hierarchy, legible Chinese, no enormous hero, no sidebar, no chat bubbles, no big illustration, no glossy marketing treatment. Each element must fit real 320x420 proportions; use believable 12-14px-equivalent text. Entire window visible.

### B

Use case: ui-mockup. Generate a high fidelity professional desktop application UI concept image for 拾传, a tiny cross-device LAN file transfer utility. Concept B: 暖色收件匣. ONE complete small floating window front-on, logical size 320 by 420 px, rendered crisply at 2x or 3x for inspection, generous neutral beige surrounding canvas. Above label "B · 暖色收件匣", below "320 × 420". Not a phone, dashboard or chat app. Thoughtful stationery-influenced PRODUCT UI, NOT skeuomorphic paper texture: cream #F6F2EA shell, ivory #FFFCF7 surfaces, ink brown #342B25, terracotta #A7472B action, muted sage success. Distinct architecture: 32px quiet masthead with small cat mark + 拾传 and more; inset 40px destination strip "设计群 ⌄" / green dot "2 台在线"; compact 70px horizontal drop shelf with small tray/file line icon left, "把文件放这里" and subtext "发送到当前群组", small terracotta plus button right; central "近期收发" list prominent, hairline separators rather than cards: "设计稿.fig" / "12.4 MB · 发送中" with 63% terracotta progress, "截图.png" / "2.1 MB · 已接收" with open arrow; tiny "查看全部" text at end; bottom 46px integrated composer "粘贴文字或链接…" and a restrained terracotta arrow. 14px window radius, inner 6-10px radii, 12px gutters, compact 12-14px-equivalent readable Chinese, deliberate typographic hierarchy, tiny monoline icons. No huge whitespace within app, no chat bubbles, no sidebar, no artwork filling the UI, no fake individual-device targeting. Keep all controls plausible and entire window visible.

### C

Use case: ui-mockup. Generate a high fidelity professional desktop application UI concept image for 拾传, a tiny cross-device LAN file transfer utility. Concept C: 深色效率. ONE complete compact floating desktop window front-on, logical size 320 by 420 px, crisp 2x or 3x rendering for inspection, generous neutral charcoal-gray surrounding canvas. Above label "C · 深色效率", below "320 × 420". Not a phone, terminal, dashboard or messenger. Graphite #202326 outer, slightly raised #2A2E32, warm white #F2F3F4 text, subdued #A4ADB5 secondary, muted mint #9ED5BF as ONLY accent, no neon or gradients. 12px external radius, 6px controls, crisp technical yet approachable design. Distinct task-first architecture: slim 32px top bar small cat-outline mark + 拾传 and pin/more; 32px compact "设计群 ⌄" left / green dot "2 台在线" right; dominant current transfer row "设计稿.fig", "12.4 MB · 发送中", "63%" aligned right, thin mint progress, small cancel icon; next small "最近接收" header and "截图.png" / "2.1 MB · 已接收" with open button; below a restrained 68px horizontal drop target "拖入文件到群组" and small outlined "选择文件"; bottom slim dark command-like text composer "文字或链接…" with mint send arrow, never code syntax. Meaningful grouping, high density without tiny text (12-14px equivalent), exact alignment, good contrast, no big device illustrations, no chat bubbles or sidebars or giant whitespace. Entire window visible and realistic enough to implement in CSS.

