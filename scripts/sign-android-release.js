// Direct-download APK signing. Credentials stay outside the repository and argv.
import { readFileSync, readdirSync, mkdirSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
const [input, output] = process.argv.slice(2);
if (!input || !output) throw new Error('Usage: node scripts/sign-android-release.js unsigned.apk release.apk');
const required = ['ANDROID_HOME', 'PICKDROP_KEYSTORE', 'PICKDROP_KEYSTORE_PASSWORD_FILE'];
for (const name of required) if (!process.env[name]) throw new Error(`${name} is required`);
const config = JSON.parse(readFileSync(new URL('../apps/tauri/src-tauri/tauri.conf.json', import.meta.url), 'utf8'));
if (config.identifier !== 'app.pickdrop' || config.version.includes('-')) throw new Error('Expected stable app.pickdrop configuration');
const sdk = process.env.ANDROID_HOME;
const version = readdirSync(path.join(sdk, 'build-tools')).sort((a, b) => a.localeCompare(b, undefined, { numeric: true })).at(-1);
const signer = path.join(sdk, 'build-tools', version, process.platform === 'win32' ? 'apksigner.bat' : 'apksigner');
const run = args => {
  const result = spawnSync(signer, args, { encoding: 'utf8', shell: process.platform === 'win32' });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(result.stderr || 'APK signature command failed');
  return result.stdout;
};
mkdirSync(path.dirname(output), { recursive: true });
run(['sign', '--ks', process.env.PICKDROP_KEYSTORE, '--ks-key-alias', 'pickdrop-release', '--ks-pass', `file:${process.env.PICKDROP_KEYSTORE_PASSWORD_FILE}`, '--out', output, input]);
const verification = run(['verify', '--verbose', '--print-certs', output]);
if (verification.toLowerCase().includes('fac61745dc0903786fb9ede62a962b399f7348f0bb6f899b8332667591033b9c')) {
  throw new Error('Public preview certificate is forbidden for production');
}
console.log(verification);
