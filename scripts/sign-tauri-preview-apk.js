// Internal preview only: this checked-in public Android debug key preserves
// preview upgrade compatibility. See fixtures/README.md; never use for production.
import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
const config = JSON.parse(readFileSync(new URL('../apps/tauri/src-tauri/tauri.conf.json', import.meta.url), 'utf8'));
if (config.identifier !== 'app.pickdrop.tauri.preview' || !config.version.includes('-')) {
  throw new Error('Public test signing is restricted to isolated preview builds');
}
const [input, output] = process.argv.slice(2);
if (!input || !output) throw new Error('Usage: node scripts/sign-tauri-preview-apk.js unsigned.apk signed-preview.apk');
const sdk = process.env.ANDROID_HOME || process.env.ANDROID_SDK_ROOT;
if (!sdk) throw new Error('ANDROID_HOME is required');
const sdkTools = readdirSync(path.join(sdk, 'build-tools')).sort((a,b) => a.localeCompare(b, undefined, { numeric: true })).at(-1);
const apksigner = path.join(sdk, 'build-tools', sdkTools, process.platform === 'win32' ? 'apksigner.bat' : 'apksigner');
const certificate = Buffer.from(readFileSync(new URL('./fixtures/android-preview-debug.keystore.base64', import.meta.url), 'utf8'), 'base64');
const expectedHash = '221e0a3106aa4c3ccc154e0a418b55020b3f9ea6e84f92e8749cd9e2f39f5e58';
if (createHash('sha256').update(certificate).digest('hex') !== expectedHash) {
  throw new Error('Public preview certificate changed; refusing to break installed preview upgrades');
}
const key = fileURLToPath(new URL('../.build/release/keys/tauri-public-debug.keystore', import.meta.url));
mkdirSync(path.dirname(key), { recursive: true });
writeFileSync(key, certificate, { mode: 0o600 });
mkdirSync(path.dirname(output), { recursive: true });
for (const args of [
  ['sign', '--ks', key, '--ks-key-alias', 'androiddebugkey', '--ks-pass', 'pass:android', '--key-pass', 'pass:android', '--out', output, input],
  ['verify', '--verbose', '--print-certs', output],
]) {
  const result = spawnSync(apksigner, args, { stdio: 'inherit', shell: process.platform === 'win32' });
  if (result.status !== 0) throw new Error('APK signing/verification failed');
}
console.log(`Signed internal preview: ${output} (${readFileSync(output).length} bytes)`);
