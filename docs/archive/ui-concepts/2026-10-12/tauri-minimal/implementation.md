# Tauri UI implementation — 2026-10-13

The approved compact desktop and mobile concepts are now implemented in `apps/tauri` on `codex/tauri-migration`.

- Desktop defaults to 440×720, with a single content column and single-row attachment/message/transfer/send composer. Expanded docked windows retain the 360×480 minimum.
- Mobile uses Groups / Transfers / Profile navigation, an independent chat screen, safe-area padding and bottom-sheet dialogs.
- Shared SVG icons, compact file cards, Save / More actions, image preview with native full-image opening, device join/address forms, owner-aware group controls, storage and transfer panels.
- Retains keyed message rendering, lazy native thumbnails, bounded history, throttled progress and native file operations. No new runtime dependencies.
- The preview's dissolve-group action is not exposed because the current Rust core has no dissolve operation. Existing supported leave/remove-local-record actions remain available.

Validation: five frontend unit tests; production Vite build; Rust host check; browser interaction tests at 320, 360, 390 and 1024 pixels; two real Rust nodes with approved joining, bidirectional text, 512 KiB file SHA verification and stable message DOM while typing. Browser tests also cover mobile navigation and draft retention, history paging, transfer target locking/cancel/retry, revoked membership, local validation, modal focus and file menus.

Native mobile performance and iOS device behavior have not been remeasured as part of this UI change. Prior migration validation remains documented separately.

## Android device verification — 2026-10-13

Upgraded the existing Preview installation on Xiaomi 2211133C without clearing data. Verified retained group/history, automatic reconnection to Mac (two online), phone-to-Mac text, native 1 MiB file receive/save with matching SHA-256, image preview, and MediaStore gallery save with matching SHA-256. Verified Groups/Transfers/Profile navigation and drafts across cold restart.

Physical testing found and fixed Android edge-to-edge keyboard panning: the activity now consumes system/IME insets and resizes the WebView container. Header coordinates remain fixed with the keyboard open; Back hides IME first and returns to groups only on the next press. The activity template and adjustResize manifest setting are reapplied by the Android preparation script.

A short two-swipe graphics sample recorded 182 frames with zero reported janky frames (95th percentile 6 ms); this is a narrow UI smoke sample, not a sustained performance benchmark.

Cold-start testing also exposed missing local cache paths in message projections. Core now attaches existing cache paths only to local state (never to signed/synced records), and exposes cacheRevision so the frontend refreshes when availability changes. A two-node transfer/reopen/clear-cache regression passes, alongside the four-width UI suite.
