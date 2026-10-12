// Internal preview only: Expo ships this public Android debug key. It is NOT a
// production signing secret, and the Tauri app uses an isolated preview ID.
import { createRequire } from 'node:module';
import { mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
const require = createRequire(import.meta.url);
const [input, output] = process.argv.slice(2);
if (!input || !output) throw new Error('Usage: node scripts/sign-tauri-preview-apk.js unsigned.apk signed-preview.apk');
const sdk = process.env.ANDROID_HOME || process.env.ANDROID_SDK_ROOT;
if (!sdk) throw new Error('ANDROID_HOME is required');
const sdkTools = readdirSync(path.join(sdk, 'build-tools')).sort((a,b) => a.localeCompare(b, undefined, { numeric: true })).at(-1);
const apksigner = path.join(sdk, 'build-tools', sdkTools, process.platform === 'win32' ? 'apksigner.bat' : 'apksigner');
const expo = path.dirname(require.resolve('expo/package.json', { paths: [path.resolve('apps/mobile')] }));
mkdirSync('.build', { recursive: true });
const extracted = spawnSync('tar', ['-xOf', path.join(expo, 'template.tgz'), 'package/android/app/debug.keystore']);
if (extracted.status !== 0) throw new Error('Cannot extract public preview certificate');
const key = path.resolve('.build/tauri-public-debug.keystore');
writeFileSync(key, extracted.stdout, { mode: 0o600 });
mkdirSync(path.dirname(output), { recursive: true });
for (const args of [
  ['sign', '--ks', key, '--ks-key-alias', 'androiddebugkey', '--ks-pass', 'pass:android', '--key-pass', 'pass:android', '--out', output, input],
  ['verify', '--verbose', '--print-certs', output],
]) {
  const result = spawnSync(apksigner, args, { stdio: 'inherit', shell: process.platform === 'win32' });
  if (result.status !== 0) throw new Error('APK signing/verification failed');
}
console.log(`Signed internal preview: ${output} (${readFileSync(output).length} bytes)`);
