import { readdir, readFile, mkdir, copyFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';
const [source, destination] = process.argv.slice(2);
if (!source || !destination) throw new Error('Usage: node scripts/tauri-release-manifest.js input output');
const version = JSON.parse(await readFile('package.json', 'utf8')).version;
const files = [];
async function walk(dir) {
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const file = path.join(dir, entry.name);
    if (entry.isDirectory()) await walk(file);
    else if (/\.(dmg|exe|msi|apk)$/i.test(entry.name)) files.push(file);
  }
}
await walk(source);
for (const [label, predicate] of [
  ['macOS', f => f.endsWith('.dmg')],
  ['Windows', f => /\.(exe|msi)$/.test(f)],
  ['Android', f => /Android-arm64-preview\.apk$/.test(f)],
]) if (!files.some(predicate)) throw new Error(`Missing ${label} installer`);
await mkdir(destination, { recursive: true });
const sums = [], names = new Set();
for (const file of files.sort()) {
  const name = path.basename(file);
  if (!name.includes(version) || names.has(name)) throw new Error(`Unexpected/duplicate versioned asset ${name}`);
  names.add(name);
  const bytes = await readFile(file);
  sums.push(`${createHash('sha256').update(bytes).digest('hex')}  ${name}`);
  await copyFile(file, path.join(destination, name));
}
await writeFile(path.join(destination, 'SHA256SUMS.txt'), sums.join('\n') + '\n');
console.log(`Verified ${files.length} installers for ${version}`);
