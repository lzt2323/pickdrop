// Syntax-only checks: never launch a client or execute application modules.
import { readdirSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url));
function frontendFiles(directory) {
  return readdirSync(path.join(root, directory), { withFileTypes: true }).flatMap(entry => {
    const file = path.join(directory, entry.name);
    if (entry.isDirectory()) return frontendFiles(file);
    return entry.isFile() && /\.(?:js|mjs|cjs)$/.test(entry.name) ? [file] : [];
  });
}

const scope = process.argv[2];
if (scope !== 'frontend') {
  console.error('Usage: node scripts/check-syntax.js frontend');
  process.exit(1);
}
const files = frontendFiles('apps/tauri/src');
for (const file of files.sort()) {
  const result = spawnSync(process.execPath, ['--check', path.join(root, file)], { stdio: 'inherit' });
  if (result.error) throw result.error;
  if (result.status !== 0) process.exit(result.status ?? 1);
}
console.log(`Syntax check (${scope}): ${files.length} files passed.`);
