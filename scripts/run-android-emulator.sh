#!/usr/bin/env bash
# Build, update (without clearing app data), and launch the Tauri Android preview.
set -euo pipefail
cd "$(dirname "$0")/.."

if ! command -v node >/dev/null 2>&1; then
  runtime_node="$HOME/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/bin"
  if [[ -x "$runtime_node/node" ]]; then export PATH="$runtime_node:$PATH"; fi
fi
export PATH="$HOME/.cargo/bin:$PATH"
native_tools="${PICKDROP_NATIVE_TOOLS:-$HOME/.cache/pickdrop-native-tools}"
sdk="${ANDROID_HOME:-${ANDROID_SDK_ROOT:-$HOME/Library/Android/sdk}}"
if [[ ! -d "$sdk/ndk" && -d "$native_tools/android-sdk/ndk" ]]; then sdk="$native_tools/android-sdk"; fi
export ANDROID_HOME="$sdk" ANDROID_SDK_ROOT="$sdk"
if [[ -z "${JAVA_HOME:-}" ]]; then
  for candidate in "$native_tools"/jdk-*/Contents/Home "/Applications/Android Studio.app/Contents/jbr/Contents/Home"; do
    if [[ -x "$candidate/bin/java" ]]; then export JAVA_HOME="$candidate"; break; fi
  done
fi
if [[ -z "${NDK_HOME:-}" ]]; then
  for candidate in "$sdk"/ndk/*; do
    if [[ -d "$candidate/toolchains" ]]; then export NDK_HOME="$candidate"; fi
  done
fi
for binary in node pnpm cargo; do command -v "$binary" >/dev/null || { echo "Missing $binary" >&2; exit 1; }; done
adb_bin="${ADB:-$sdk/platform-tools/adb}"
[[ -x "$adb_bin" ]] || { echo "Set ADB or ANDROID_HOME to an Android SDK with platform-tools." >&2; exit 1; }
device="${ANDROID_SERIAL:-}"
if [[ -z "$device" ]]; then
  device="$("$adb_bin" devices | awk '$1 ~ /^emulator-/ && $2 == "device" {print $1; exit}')"
fi
[[ -n "$device" ]] || { echo "Start an emulator, or set ANDROID_SERIAL to an existing device." >&2; exit 1; }
abi="$("$adb_bin" -s "$device" shell getprop ro.product.cpu.abi | tr -d '\r')"
[[ "$abi" == arm64-v8a ]] || { echo "This preview currently packages ARM64 only; connected device is $abi." >&2; exit 1; }

pnpm --dir apps/tauri tauri android build --debug --target aarch64 --apk
apk="apps/tauri/src-tauri/gen/android/app/build/outputs/apk/universal/debug/app-universal-debug.apk"
"$adb_bin" -s "$device" install -r "$apk"
"$adb_bin" -s "$device" shell am force-stop app.pickdrop.tauri.preview
"$adb_bin" -s "$device" shell am start -n app.pickdrop.tauri.preview/.MainActivity
echo "Running on $device. APK: $apk"
