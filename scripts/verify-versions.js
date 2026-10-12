import { readFileSync, existsSync } from 'node:fs';
const read = path => JSON.parse(readFileSync(path, 'utf8'));
const version = read('package.json').version;
for (const path of ['apps/tauri/package.json', 'apps/tui/package.json', 'apps/mobile/package.json']) {
  if (read(path).version !== version) throw new Error(`${path}: version differs from ${version}`);
}
if (read('apps/mobile/app.json').expo.version !== version || read('apps/tauri/src-tauri/tauri.conf.json').version !== version) throw new Error('Native configuration version mismatch');
for (const path of ['crates/pickdrop-core/Cargo.toml', 'apps/tauri/src-tauri/Cargo.toml', 'apps/tauri/src-tauri/plugins/native/Cargo.toml']) {
  const actual = readFileSync(path, 'utf8').match(/^version\s*=\s*"([^"]+)"/m)?.[1];
  if (actual !== version) throw new Error(`${path}: ${actual} differs from ${version}`);
}
if (process.env.RELEASE_KIND === 'tag' && process.env.RELEASE_TAG !== `v${version}`) throw new Error('Release tag must match source version');
if (!existsSync(`docs/releases/v${version}.md`)) throw new Error('Release notes missing');
console.log(`All package and native versions match ${version}`);
