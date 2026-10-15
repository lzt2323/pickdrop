import { existsSync } from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

const apk = process.argv[2];
const sdk = process.env.ANDROID_HOME || process.env.ANDROID_SDK_ROOT;
if (!apk || !existsSync(apk) || !sdk) {
  throw new Error('Usage: ANDROID_HOME=<sdk> node scripts/verify-android-scanner.js release.apk (requires Java and SDK command-line tools)');
}
const analyzer = path.join(sdk, 'cmdline-tools/latest/bin/apkanalyzer');
// Check the actual shrunk APK: debug tests cannot catch removed reflective
// constructors, and keeping the registrar class names alone is insufficient.
for (const registrar of [
  'com.google.mlkit.common.internal.CommonComponentRegistrar',
  'com.google.mlkit.vision.common.internal.VisionCommonRegistrar',
  'com.google.mlkit.vision.barcode.internal.BarcodeRegistrar',
]) {
  const result = spawnSync(analyzer, ['dex', 'code', '--class', registrar, '--method', '<init>()V', apk], { encoding: 'utf8' });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`Scanner release constructor missing: ${registrar}\n${result.stderr}`);
}
console.log('Android APK retains all 3 ML Kit registrar constructors.');
