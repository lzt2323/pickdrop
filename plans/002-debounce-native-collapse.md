# 002 — Give the latest pointer exit its full grace period

- **Status**: DONE — implementation and native verification complete
- **Commit**: 859c4c5
- **Severity**: MEDIUM
- **Category**: Interruptibility / Easing & duration (interaction timing)
- **Estimated scope**: docking.rs and targeted native smoke

## Problem

`apps/tauri/src-tauri/src/docking.rs:566–573` starts an independent timer on each leave:

```rust
pub fn blurred(w: WebviewWindow) {
    tauri::async_runtime::spawn(async move {
        tokio::time::sleep(std::time::Duration::from_millis(800)).await;
        if w.is_visible().unwrap_or(false) && !pointer_inside(&w) {
            let _ = collapse(&w);
        }
    });
}
```

Pointer-inside union correctly stops collapse while the cursor is inside either surface. It does not invalidate a prior timeout. Exit at 0ms, return at 500ms, exit again at 750ms can let the old timer collapse at 800ms: only 50ms of the new exit's grace. This is code-confirmed; the preceding native smoke tested a single leave, not this rapid reversal.

## Target

Keep the current 800ms grace, 250ms animal hover intent, 56px animal, 8px gap and instant OS show/hide. Only the newest scheduled exit may collapse a given owner window. A later enter/expand/hide should invalidate obsolete scheduled exits. No spring or geometry tween.

## Repo conventions to follow

Docking already owns per-window state and uses Rust async timers. It also uses `AtomicU64` for save generations. Add a separate, non-persisted per-owner exit generation; never share it with disk-save generation.

## Steps

1. Add an independent `Mutex<HashMap<String, u64>>` exit-generation map to `Docking`, initialized empty in `Docking::new`. Small helper `next_exit_generation(label)` increments under one lock and returns the value; a read helper checks the currently stored value.
2. In `blurred`, synchronously increment/capture the owner's generation before spawning. After exactly the existing 800ms sleep, compare captured/current generation. Return if obsolete, then retain current visible/union-pointer checks and `collapse` pinned/busy/file-hover/upload guards.
3. In explicit `expand` and `hide`, invalidate pending exit generations. Do not change bounds, persistence, cursor union or pinned semantics.
4. Test rapid reversal: schedule an exit; after 500ms schedule another; at 850ms from the first assert panel visible; after the second full 800ms assert collapse only if pointer is outside, unpinned and idle. Capture/restore the original cursor if native smoke moves it. Also verify main→animal movement still prevents collapse.

## Boundaries

Do not rewrite dual-window layout, change the 800/250ms delays, add an animated native window movement, or gate required drag/resize geometry on reduced-motion. No frontend source change is necessary for a generation check on each new leave/expand/hide. Preserve behavior for all owner window labels independently.

## Verification

- Compile desktop and run the opt-in native smoke with isolated data.
- Mechanical test must prove the first scheduled timer cannot win after the second leave. Each owner has an independent counter.
- Feel-check cursor main→animal→outside→main→outside rapidly: no flash and no premature close; panel still closes after the final full grace period.
- Reduced motion and keyboard activation remain immediate and unchanged. This is interaction hysteresis, not an 800ms decorative animation.

## Execution evidence

Implemented per-owner generation map; repeated leave and explicit expand/hide invalidate stale timers. `cargo check -p pickdrop-tauri` passed; `cargo test -p pickdrop-tauri --lib docking::tests` passed. Isolated real-native smoke passed at `artifacts/ui-review/native/debounce-smoke.json`, including two-window interleaving, full latest-leave grace, expand/hide invalidation and existing dual-window/DPI regressions. No product bundle rebuilt or user-data app restarted for this change.
