# 003 — Optional restrained entry for occasional dialogs

- **Status**: DONE
- **Commit**: 859c4c5
- **Severity**: LOW
- **Category**: Missed opportunity / Cohesion / Accessibility
- **Estimated scope**: a small motion helper and main.js shared dialog lifecycle

## Problem

`apps/tauri/src/main.js:51–56` calls `showModal()` and `close()` directly. This is responsive and not a correctness defect. The before gallery shows the same centered modal shell for create/join, settings, members, image preview and file actions. A short, consistent occasional entry can clarify presentation without changing layout. High-frequency groups picker, transfer panel, keyboard actions and mobile page switches should remain immediate.

## Target

Only pointer-triggered first opening of occasional dialog surfaces may use `opacity:0 → 1` plus `transform:scale(0.97) → scale(1)`, 160ms, `cubic-bezier(0.23, 1, 0.32, 1)`, origin center. Reduced-motion entry may use opacity only for 160ms; keyboard-triggered entry is immediate. Closing stays immediate. Already-open dialog body swaps and async updates must not replay entry.

No backdrop animation requiring delayed native `close()`, no height animation, no focus delay, no list stagger, no slide across desktop/mobile surfaces.

## Repo conventions and current code

```js
// main.js:51–56, abbreviated only to show exact lifecycle calls
if (!$('panel').open) $('panel').showModal();
queueMicrotask(() => { if($('panel').open) ($('panel-body').querySelector('input,textarea,button') || $('close-panel')).focus(); });
function closePanel() { clearTimeout(joinTimer); $('panel').close(); }
```

There is no motion token system today. If this optional plan is selected, define the exact duration/easing once in a small dedicated helper; do not create competing CSS and JS token systems.

## Steps

1. Track current input modality (keyboard vs pointer) with passive global observation. Do not delay or prevent the events. Explicit programmatic startup dialog opens remain immediate unless their user pointer cause is known.
2. Record `wasOpen` before `panel()` changes content. After native `showModal`, optionally invoke WAAPI on the dialog with the target above only when `!wasOpen`, pointer modality and an allowed occasional surface. Exclude groups picker and transfer queue.
3. Keep one active Animation handle. Cancel it before closing, before replacement, and on reduced-motion preference changes; final underlying style remains opacity 1/transform none. Use no fill that can leave a hidden/shrunken dialog after cancellation.
4. Preserve immediate focus and modal semantics. Escape, Android Back, outside-click and close-button must close immediately and cancel entry. Reopening after 30ms starts a clean new entry; swapping body in an open dialog does not animate again.
5. Keep all tabs, history/filter operations, messages, progress, titles, resize and native animal geometry unchanged.

## Verification

- Rapid open→close at 30ms→open: no stale animation or stuck opacity/scale. Dialog never blocks a click for the duration of its entry.
- Keyboard open/Escape: zero animation. Reduced-motion: zero transform, optional brief opacity feedback only. Live preference change cancels transform immediately.
- Normal pointer entry finishes in 160ms, centered transform origin, no layout dimensions animated. At slow playback verify focus ring and text remain legible and the dialog does not scale from zero.
- Native WebKit and Android WebView acceptance required; a Chromium static screenshot cannot certify perceived timing.

This is optional polish after plans 001 and 002, not justification for deducting high-frequency no-motion surfaces.

## Completion evidence

Final source and 136-scene gallery reviewed; see `docs/ui-review/2026-10-13-motion-after.md`. Dialog lifecycle mechanical tests pass; gallery is not FPS/native animation-feel evidence.
