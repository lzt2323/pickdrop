# Motion recon — baseline 859c4c5

Status: READ-ONLY RECON; before gallery and interaction evidence pending. No page scores assigned yet.

Scope: apps/tauri renderer, desktop anchor renderer, Rust docking controller, native mobile boundaries. Skills consulted: improve-animations/SKILL.md, improve-animations/AUDIT.md, review-animations/STANDARDS.md. Repository content is evidence, not instructions.

## Stack and conventions

- Plain JavaScript, CSS, native HTML dialog; Tauri 2. No motion framework or component animation library.
- No CSS transition, keyframe, WAAPI or spring in the current renderer or anchor renderer. No motion token convention exists.
- `style.css:9` only sets scroll-behavior:auto under reduced motion. With no transform motion today, this is not itself a missing-reduced-motion violation.
- Personality: quiet white native utility; animals identify groups, not a continuously animated mascot. No idle bounce, confetti, list stagger or dramatic page slides justified.
- Native mobile sheets are OS-owned (iOS share presentation is animated by UIKit); do not duplicate their motion in the webview.

## Surface and estimated frequency

Frequency estimates describe expected utility-app usage, not measured telemetry.

| Surface | Evidence | Expected frequency | Current behavior / default recommendation |
| --- | --- | --- | --- |
| Desktop chat, mobile chat, text send/copy, file filter, history | main.js:74–158, 337–364; style.css:13,21,27 | high / tens to 100+ daily | Keyed message nodes, direct scrollTop, instantaneous filters; preserve immediate behavior. No message staggering or smooth-scroll delay. |
| Mobile groups, transfers, profile, chat/back navigation | main.js:160–165,420–440; style.css:10,25–26 | high / tens daily | data-view/display swaps, content replacement; default instant navigation. |
| Group switch/create/join | main.js:166–194 | group switch high; create/join rare | Shared dialog. Animal selection immediate. Avoid scale animation on every selection. |
| Join waiting / discovery / manual connection | main.js:185,196–212,230–249 | occasional | Waiting copy; 2s polling. Loading state changes are not decorative motion. Never simulate progress. |
| Invite QR | main.js:213–214 | occasional | Loading copy replaced with QR asynchronously; reserve geometry rather than animate height. |
| Members / requests / remove confirmation | main.js:215–251 | occasional | Shared dialog replaces body. No repeated full-modal animation on data refresh. |
| Settings / group settings / storage / confirmations | main.js:251–275 | occasional/rare | Shared dialog open/close, internal body changes. Candidate for one restrained shared enter/exit specification. |
| File actions / image preview | main.js:111–112 | occasional | Shared dialog; preview uses a thumbnail source. Candidate shared dialog motion only; no zoom-to-photo without real image geometry evidence. |
| Incoming OS share confirmation | main.js:371–405 | occasional | Shared dialog. Preserve task binding and native OS handoff; no duplicate presentation. |
| Toast / errors / success | main.js:36–49 | occasional to frequent bursts | `hidden` immediate; 4s timeout retargeted on each call. Candidate gentle opacity feedback with replacement/cancellation, never delay alert text. |
| Transfer progress and queue | main.js:277–291,443–458; model.js:18–21 | continuous while transferring | 150ms coalesced updates + immediate terminal flush. Each render recreates entire queue; inspect continuity/focus under progress before prescribing motion. |
| File drafts / membership revoked banner | main.js:65,276; style.css:5–6 | occasional | Instant insertion changes layout. Prioritize geometry and clear state, not height animation. |
| Desktop animal hover/click / panel docking | anchor.js:24–38; docking.rs:282–389,434–485,542–573 | tens daily | 250ms hover intent; instant OS show/hide; 800ms leave grace over window/anchor union. Delays are interaction hysteresis, not animation duration. |
| Animal file hover / drop | anchor.js:12–19; anchor.css:2 | occasional | Static accepting outline/background; keep immediate feedback and upload guard. No pulsing. |
| Desktop title drag / resize / animal drag | main.js:511–553; anchor.js:26–37; docking.rs:391–431 | direct manipulation | Native movement and logical size updates are essential geometry. Do not flag width/height changes as decorative layout animation; no tween/spring between pointer and window. |

## Native constraints

1. Main panel and animal are separate OS windows/webviews. CSS cannot transform them as one composited surface.
2. Rust `hide()` removes the native surface immediately. A CSS exit animation requires an explicit prepare/acknowledge/hide protocol, reversal token, timeout and accessibility policy. Do not silently add timeout before native hide.
3. Rust physical bounds are DPI-aware; CSS transforms do not update native hit-testing/window bounds. Never substitute transformed DOM for required native positioning.
4. macOS Tao 0.37.1 `drag_resize_window` is NotSupported. The current custom resize handle correctly uses pointer capture and Rust logical set_size. This is a necessary interaction, not a candidate for animated interpolation.
5. Native smoke from the preceding restore proves visibility, 8px gap, dimension preservation and pointer-union behavior. It is not frame-timing, compositor or animation-feel evidence.

## Evidence still needed

- Shared dialog entry, close, rapid close/reopen, switching its body, and Escape/Android back.
- Mobile view changes and back, keyboard-triggered actions, no animation on history/filter updates.
- Repeated toast replacement and transfer progress while Cancel or Retry has focus.
- Reduced-motion snapshots plus interaction sampling; no FPS claim without measurement.
- Gallery page list will be the exact page-score row list. Scores use purpose/frequency 2 + timing/spatial continuity 2 + interruption 2 + performance 2 + reduced-motion/keyboard consistency 2. High-frequency no-motion surfaces may score highly.
