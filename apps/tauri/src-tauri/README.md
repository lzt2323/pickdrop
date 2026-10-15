# Tauri native host

The desktop and mobile hosts use the same Rust core and frontend. Preview identifier
`app.pickdrop.tauri.preview` gives this build its own application data directory;
0.5.x data is not overwritten. There is no Electron or Node sidecar.

## Native interface

- `core_call({method, params})` runs async core work outside the webview thread.
- `pickdrop:event` broadcasts state changes, group changes and transfer progress.
- `native_pick_files()` streams Android content providers into native app storage,
  returning only metadata and paths; desktop paths are approved by the picker.
- `native_paste_image()` reads desktop clipboard images on a worker and stages PNG
  drafts in app storage; returns metadata/paths only, with a 64 MiB RGBA limit.
- `native_save_file({sourcePath,suggestedName})` streams to a user-selected destination.
- `native_thumbnail({path})` generates a PNG at most 320×320 on a Rust worker;
  encoded input, dimensions and decoded allocation are bounded. Original file bytes
  are never sent across IPC for a preview.
- `native_open_file`, `native_share_file`, `native_save_gallery` accept approved
  picker/drop paths or files inside this preview's data directory.
- `native_consume_incoming()` consumes Android external share intents once.
- `window_action({action,value})` provides desktop pin, hide, show and extra windows.
- QR scanning uses the official barcode scanner plugin, mobile only. Android uses
  the bundled MLKit17.3 model through a tracked Gradle substitution, so scanning
  works offline without Google Play Services. The generated APK restricts native
  libraries to ARM64 to avoid carrying unused model architectures.

The Android bridge streams provider reads and sharesheet cache writes on a dedicated
worker. It publishes images/videos with MediaStore on Android 10 or later without
broad storage permission. On Android 7–9 use the save dialog. The iOS bridge provides
UIActivityViewController and Photos export. An iOS share extension for incoming
external shares is not included; iOS cannot receive those via Android intent filters.
Native desktop file drag in/out is supported. Edge docking snaps near the left,
right or top work-area edge, collapses on blur and expands through the frontend
hover tab. Window pinning keeps the panel expanded and on top, overriding automatic and
manual collapse. Unpinning preserves the existing edge-docking preference. Closing a desktop window hides it and keeps
the Rust peer service available; the tray Quit action exits the application. This implementation uses a single
resized native surface; the prior Electron split-surface animation is not reused.

## Build prerequisites

Run `pnpm --dir apps/tauri build`, then the Tauri CLI from `apps/tauri`.
Desktop requires platform system dependencies; iOS requires full Xcode, not just
Command Line Tools; Android requires JDK 17, Android SDK/NDK and the Rust Android
ARM64 target. Generated projects may be recreated with the CLI. `prepare-android.mjs` runs before
the native release build and reapplies SDK 36 and incoming-share intent filters
idempotently. Run it manually after Android init when using a development build.

A platform build is not evidence of device runtime behavior. Verify scanner,
provider picker, sharesheet, gallery, background/resume and a two-device transfer
on real devices before promoting the preview to the stable identifier.

## Storage accounting in this preview

The storage panel currently reports the Rust core message/file cache. Native
picker/clipboard drafts and named OS exports are separate staging storage and are not part
of its clear-cache action, so drafts or in-flight files cannot be deleted by that
action. Named exports are cleaned after 24 hours on the next native export.
An iOS incoming-share extension remains outside this preview; the iOS entrypoint,
scanner, picker, outgoing sharesheet and gallery source are included but need full
Xcode and real-device validation.

`PICKDROP_NATIVE_SMOKE=/tmp/report.json target/debug/pickdrop-tauri` is an opt-in
desktop debug-only runtime smoke. It uses a separate data directory, checks real
native pinning, edge collapse/expand, hide/show and multiple windows, emits a core
event and exits with a JSON report. The hook is excluded from release builds.

Windows preview releases use NSIS installers via `tauri.windows.conf.json`.
WiX MSI rejects the textual `alpha.1` prerelease identifier; NSIS retains the
shared semantic version without inventing a separate application version.
The native Windows executable compiled successfully in CI before that MSI-only
packaging failure.
