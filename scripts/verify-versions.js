import { readFileSync, existsSync } from 'node:fs';
const read = path => JSON.parse(readFileSync(path, 'utf8'));
const version = read('package.json').version;
for (const path of ['apps/tauri/package.json']) {
  if (read(path).version !== version) throw new Error(`${path}: version differs from ${version}`);
}
if (read('apps/tauri/src-tauri/tauri.conf.json').version !== version) throw new Error('Native configuration version mismatch');
for (const path of ['crates/pickdrop-core/Cargo.toml', 'apps/tauri/src-tauri/Cargo.toml', 'apps/tauri/src-tauri/plugins/native/Cargo.toml']) {
  const actual = readFileSync(path, 'utf8').match(/^version\s*=\s*"([^"]+)"/m)?.[1];
  if (actual !== version) throw new Error(`${path}: ${actual} differs from ${version}`);
}
const androidVersionCode = read('apps/tauri/src-tauri/tauri.conf.json').bundle?.android?.versionCode;
// Android ignores semver prerelease suffixes; keep the explicit upgrade code increasing.
if (!Number.isInteger(androidVersionCode) || androidVersionCode <= 6000 || androidVersionCode > 2100000000) {
  throw new Error('Android versionCode must be an integer above alpha.1 code 6000 and within the Android limit');
}
if (version === '0.6.0-alpha.2' && androidVersionCode !== 6001) {
  throw new Error('Android alpha.2 versionCode must be 6001');
}
if (version !== '0.6.0-alpha.2' && androidVersionCode <= 6001) {
  throw new Error('Later releases must increase Android versionCode beyond alpha.2 code 6001');
}
if (process.env.RELEASE_KIND === 'tag' && process.env.RELEASE_TAG !== `v${version}`) throw new Error('Release tag must match source version');
if (!existsSync(`docs/releases/v${version}.md`)) throw new Error('Release notes missing');
console.log(`All package and native versions match ${version}`);
