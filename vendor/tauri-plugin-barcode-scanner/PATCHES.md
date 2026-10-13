# Local patch to tauri-plugin-barcode-scanner 2.5.2

Baseline: crates.io release 2.5.2, Tauri plugins-workspace. Original MIT/Apache licenses retained. Cargo.lock selects this workspace patch; generated Gradle/build caches are excluded.

Only Android BarcodeScannerPlugin.kt changes:
- Cancel captures the pending scan invocation before destroy clears it, so the scan Promise is rejected and can settle.
- Camera teardown removes preview/overlay even before the provider is ready.
- A generation check rejects late provider and image-analysis callbacks from a cancelled scan; the shared CameraProvider future is not cancelled.

These fix a reproduced system-Back black overlay and permanently pending scan. Recheck/remove this patch when upgrading the upstream plugin to a version with equivalent fixes. Android early Back, settled Back, and a second scan are acceptance cases.
