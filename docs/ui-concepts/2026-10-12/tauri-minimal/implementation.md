# Tauri UI implementation — 2026-10-13

The approved compact desktop and mobile concepts are now implemented in `apps/tauri` on `codex/tauri-migration`.

- Desktop defaults to 440×720, with a single content column and single-row attachment/message/transfer/send composer. Expanded docked windows retain the 360×480 minimum.
- Mobile uses Groups / Transfers / Profile navigation, an independent chat screen, safe-area padding and bottom-sheet dialogs.
- Shared SVG icons, compact file cards, Save / More actions, image preview with native full-image opening, device join/address forms, owner-aware group controls, storage and transfer panels.
- Retains keyed message rendering, lazy native thumbnails, bounded history, throttled progress and native file operations. No new runtime dependencies.
- The preview's dissolve-group action is not exposed because the current Rust core has no dissolve operation. Existing supported leave/remove-local-record actions remain available.

Validation: five frontend unit tests; production Vite build; Rust host check; browser interaction tests at 320, 360, 390 and 1024 pixels; two real Rust nodes with approved joining, bidirectional text, 512 KiB file SHA verification and stable message DOM while typing. Browser tests also cover mobile navigation and draft retention, history paging, transfer target locking/cancel/retry, revoked membership, local validation, modal focus and file menus.

Native mobile performance and iOS device behavior have not been remeasured as part of this UI change. Prior migration validation remains documented separately.
