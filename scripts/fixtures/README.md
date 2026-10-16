# Public Android preview certificate

`android-preview-debug.keystore.base64` is the unchanged public debug keystore extracted from `expo@57.0.26/template.tgz`, entry `package/android/app/debug.keystore`, previously used by `sign-tauri-preview-apk.js`. It is retained independently of Expo so installed PickDrop Tauri previews can upgrade with the same signing identity. No new key was generated.

This is a publicly distributed test key, not a production secret. Use only with the isolated `app.pickdrop.tauri.preview` package. Production releases require a separate private signing setup. Alias: `androiddebugkey`; store/key password: `android`.

- Decoded file size: 2257 bytes.
- Keystore SHA-256: `221e0a3106aa4c3ccc154e0a418b55020b3f9ea6e84f92e8749cd9e2f39f5e58`.
- Certificate SHA-256: `FA:C6:17:45:DC:09:03:78:6F:B9:ED:E6:2A:96:2B:39:9F:73:48:F0:BB:6F:89:9B:83:32:66:75:91:03:3B:9C`.
- Certificate SHA-1: `5E:8F:16:06:2E:A3:CD:2C:4A:0D:54:78:76:BA:A6:F3:8C:AB:F6:25`.

The signing script verifies the decoded file hash before use. To inspect the certificate, decode to a temporary file and run `keytool -list -v -keystore FILE -storepass android -alias androiddebugkey`. Preserve the bytes and certificate fingerprint when changing tooling.
