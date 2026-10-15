import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url));
const { version } = JSON.parse(await readFile(path.join(root, 'package.json'), 'utf8'));
const names = [
  `PickDrop-${version}.dmg`,
  `PickDrop-${version}.exe`,
  `PickDrop-${version}-Tauri-Android-arm64-preview.apk`,
];
async function fixture(t, assets = names) {
  const directory = await mkdtemp(path.join(tmpdir(), 'pickdrop-release-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const source = path.join(directory, 'input'), destination = path.join(directory, 'output');
  await mkdir(source);
  for (const name of assets) await writeFile(path.join(source, name), `fixture:${name}`);
  return {
    source, destination,
    run: () => spawnSync(process.execPath, [path.join(root, 'scripts/tauri-release-manifest.js'), source, destination], { cwd: root, encoding: 'utf8' }),
  };
}

test('release requires only Tauri desktop and Android installers and hashes copied bytes', async t => {
  const data = await fixture(t);
  const result = data.run();
  assert.equal(result.status, 0, result.stderr);
  const lines = (await readFile(path.join(data.destination, 'SHA256SUMS.txt'), 'utf8')).trim().split('\n');
  assert.equal(lines.length, 3);
  for (const name of names) {
    const bytes = await readFile(path.join(data.destination, name));
    assert.equal(bytes.toString(), `fixture:${name}`);
    assert.ok(lines.includes(`${createHash('sha256').update(bytes).digest('hex')}  ${name}`));
  }
});

test('release rejects a missing Android installer', async t => {
  const data = await fixture(t, names.slice(0, 2));
  const result = data.run();
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /Missing Android installer/);
});

test('release rejects mismatched versions and duplicate asset names', async t => {
  const wrong = await fixture(t, names.map(name => name.replace(version, '0.0.0')));
  assert.match(wrong.run().stderr, /Unexpected\/duplicate versioned asset/);
  const duplicate = await fixture(t);
  await mkdir(path.join(duplicate.source, 'nested'));
  await writeFile(path.join(duplicate.source, 'nested', names[0]), 'duplicate');
  assert.match(duplicate.run().stderr, /Unexpected\/duplicate versioned asset/);
});
