// Syntax-only checks: never launch a client or execute application modules.
import { readdirSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url));
const legacyFiles = [
  "server/index.js",
  "server/groups.js",
  "server/pairing.js",
  "server/discovery.js",
  "server/discovery-directory.js",
  "apps/desktop/main.cjs",
  "apps/desktop/preload.cjs",
  "apps/desktop/clipboard-image.cjs",
  "apps/desktop/public/clipboard-images.js",
  "apps/desktop/window-controller.cjs",
  "apps/desktop/split-window-controller.cjs",
  "apps/desktop/anchor-preload.cjs",
  "apps/desktop/anchor-upload.cjs",
  "apps/desktop/public/app.js",
  "server/network.js",
  "server/desktop-proxy.js",
  "apps/tui/cli.js",
  "apps/tui/daemon.js",
  "apps/tui/ui.js",
  "apps/tui/transfers.js",
  "scripts/package-linux.js",
  "apps/tui/layout.js",
  "apps/tui/view.js",
  "apps/tui/navigation-view.js",
  "apps/tui/preferences.js",
  "apps/tui/launcher.js",
  "scripts/tui-visual-smoke.js",
  "server/cache.js",
  "server/history-store.js",
  "server/persistence.js",
  "shared/download.js",
  "shared/history.js",
  "apps/mobile/plugins/withPickDropStorage.js",
  "scripts/desktop-quit-smoke.js",
  "shared/peer-protocol.js",
  "server/peer-store.js",
  "apps/mobile/src/peer-client.js",
  "apps/desktop/platform-window.cjs"
];

function frontendFiles(directory) {
  return readdirSync(path.join(root, directory), { withFileTypes: true }).flatMap(entry => {
    const file = path.join(directory, entry.name);
    if (entry.isDirectory()) return frontendFiles(file);
    return entry.isFile() && /\.(?:js|mjs|cjs)$/.test(entry.name) ? [file] : [];
  });
}

const scope = process.argv[2];
if (!['frontend', 'legacy'].includes(scope)) {
  console.error('Usage: node scripts/check-syntax.js frontend|legacy');
  process.exit(1);
}
const files = scope === 'frontend' ? frontendFiles('apps/tauri/src') : legacyFiles;
for (const file of files.sort()) {
  const result = spawnSync(process.execPath, ['--check', path.join(root, file)], { stdio: 'inherit' });
  if (result.error) throw result.error;
  if (result.status !== 0) process.exit(result.status ?? 1);
}
console.log(`Syntax check (${scope}): ${files.length} files passed.`);
