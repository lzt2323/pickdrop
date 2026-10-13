# 001 — Preserve transfer rows during progress updates

- **Status**: DONE
- **Commit**: 859c4c5
- **Severity**: HIGH
- **Category**: Interruptibility / Accessibility / Performance
- **Estimated scope**: main.js transfer renderer and focused regression checks; no motion dependency

## Problem

`apps/tauri/src/main.js:279` starts every render with:

```js
const queue = $('queue'); queue.hidden = !app.transfers.size; queue.replaceChildren();
```

`apps/tauri/src/model.js:18–21` batches active progress at 150ms. Replacing the children removes the currently focused Cancel control. The before gallery actively focused Cancel, emitted another progress event, and checked after 220ms: all four profiles report detached control and focus on body. Evidence: `artifacts/ui-review/before/manifest.json` findings `transfer-focus-loss`, screenshots `*-transfers-progress-focus.png`. This is a demonstrated interaction interruption, not a speculative FPS problem.

## Target

- Progress value, filename, status and summary update immediately at the existing 150ms cadence. Terminal flush remains immediate.
- Keep one DOM record per transfer ID. Updating progress retains the exact row, native `<progress>` and applicable action button nodes.
- Do not add a progress tween, fake progress, list entrance, spinner or stagger. A cancellation must never wait for animation.
- Preserve focus and scrolling during progress; if a terminal transition legitimately removes the focused action, move focus to that same row's relevant remaining action (Clear or Retry) with `preventScroll:true`.

## Repo conventions to follow

`apps/tauri/src/main.js:113–135` already keeps keyed message rows through `app.rows`. Follow keyed identity rather than replacing the queue. `progressScheduler` already offers `push`, `flush`, `dispose`; retain its 150ms interval and terminal flush behavior.

## Steps

1. Create a `transferRows` Map keyed by transfer ID in `main.js`. Each record owns row, label node, progress element, and action controls. Scope it to the existing queue rather than separate desktop/mobile copies.
2. Replace `queue.replaceChildren()` with removal of IDs no longer in `app.transfers`, creation/appending of new IDs only, and in-place updates for existing IDs. Do not reappend every retained row: DOM moves can also disrupt focus.
3. Keep Cancel/Retry/Clear handlers bound to the stable ID and current `app.transfers.get(id)` so retries see current path/message/group. Update text through `textContent` on the label, not the entire row.
4. Retain a focused action whenever still applicable. When the transfer becomes terminal while Cancel is focused, reveal the remaining terminal action, move focus to it without scrolling, then remove/hide Cancel. Do not focus terminal controls for unrelated background transfers.
5. Keep queue parking (`parkQueue`, `attachQueue`) and existing summary/empty-state behavior. Prune keyed records when users clear transfer history.
6. Add the gallery probe as an assertion: focus Cancel; retain its node; emit progress; wait >150ms; assert same node remains connected and active. Repeat for several updates, then complete/cancel and check the intentional next focus target.

## Boundaries

No changes to Rust transport, transfer event contract, progress timing, page navigation or global button treatment. No extra animation library. Do not use `transition:all`, animated width, or a CSS progress overlay. If baseline code has drifted, reconcile the renderer with the current version before applying the plan; do not overwrite another agent's updates.

## Verification

- `pnpm --dir apps/tauri test` and `pnpm --dir apps/tauri test:browser`; run the existing UI gallery script according to its CLI.
- Probe desktop 440×720, mobile 390×844, narrow 320×640 and landscape 844×390.
- Keyboard focus stays on Cancel across 3+ progress events; Space/Enter still cancels once. Terminal result and retry remain correct.
- Feel-check rapid progress and cancellation: values remain truthful, no row flashes, no interaction delay, no scroll jump. Reduced-motion and normal modes behave identically because no decorative movement is introduced.
- Done when before `transfer-focus-loss` findings are absent and DOM identity assertions pass. Do not claim a frame rate from these tests.

## Completion evidence

Final source and 136-scene gallery reviewed; see `docs/ui-review/2026-10-13-motion-after.md`. Dialog lifecycle mechanical tests pass; gallery is not FPS/native animation-feel evidence.
