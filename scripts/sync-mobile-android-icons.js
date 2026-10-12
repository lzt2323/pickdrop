// Regenerate only launcher assets; full Expo prebuild would touch native customizations.
import { createRequire } from 'node:module';
import { readFile, access } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export async function syncMobileAndroidIcons() {
  const project = path.join(root, 'apps/mobile');
  try { await access(path.join(project, 'android/app/src/main/res')); } catch { return; }
  const mobileRequire = createRequire(path.join(project, 'package.json'));
  const expoRequire = createRequire(mobileRequire.resolve('expo/package.json'));
  const cliRequire = createRequire(expoRequire.resolve('@expo/cli/package.json'));
  const prebuildRoot = path.dirname(cliRequire.resolve('@expo/prebuild-config'));
  const { setIconAsync, getIcon, getAdaptiveIcon } = cliRequire(path.join(prebuildRoot, 'plugins/icons/withAndroidIcons.js'));
  const { expo: config } = JSON.parse(await readFile(path.join(project, 'app.json'), 'utf8'));
  const options = { icon: getIcon(config), ...getAdaptiveIcon(config), isAdaptive: Boolean(config.android?.adaptiveIcon) };
  for (const key of ['icon', 'foregroundImage', 'backgroundImage', 'monochromeImage']) if (options[key]) options[key] = path.resolve(project, options[key]);
  await setIconAsync(project, options);
  console.log('Android launcher, round, adaptive and monochrome resources synchronized.');
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await syncMobileAndroidIcons();
