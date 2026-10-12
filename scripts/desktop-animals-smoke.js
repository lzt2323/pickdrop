import { firstContentWindow, nextContentWindow, nativeWindowPage } from './desktop-test-windows.js';
import assert from 'node:assert/strict';
import { _electron as electron, chromium } from 'playwright';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { ANIMALS, animalSvg } from '../shared/animals.js';

const root = await mkdtemp(path.join(os.tmpdir(), 'pickdrop-animals-'));
const output = 'artifacts/group-animals'; await mkdir(output, { recursive: true });
const app = await electron.launch({ args: ['.'], env: { ...process.env, PICKDROP_USER_DATA: root } });
const errors = []; app.on('window', page => page.on('pageerror', error => errors.push(error.message)));
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
const bootstrap = page => page.evaluate(() => window.pickdrop.bootstrap());
const windows = [];
try {
  const home = await firstContentWindow(app);
  await home.waitForFunction(() => document.querySelector('#connection-status')?.dataset.connected === 'true');
  for (const animal of ANIMALS.slice(1, 4)) {
    await home.locator('#group-menu-button').click(); await home.locator('#create-group').click();
    await home.locator('#new-group-name').fill(`${animal.name}资料`);
    await home.locator(`.animal-choice[data-animal="${animal.id}"]`).click();
    const opened = nextContentWindow(app); await home.locator('#confirm-create-group').click();
    const page = await opened;
    await page.locator('.task-disclosure > summary').filter({ hasText: '连接地址' }).click();
    await page.locator('#invite-address').waitFor();
    assert.equal((await bootstrap(page)).group.animalId, animal.id);
    // Measure the settled dialog, not two different frames of its entrance scale.
    await page.locator('#panel').evaluate(async panel => { await Promise.all(panel.getAnimations({ subtree: true }).map(animation => animation.finished.catch(() => {}))); });
    const a = await page.locator('#copy-invite').boundingBox(), b = await page.locator('#renew-invite').boundingBox();
    assert.equal(a.x, b.x); assert.equal(a.width, b.width); assert.equal(a.height, b.height);
    assert.equal(await page.locator('.invite-qr').count(), 0, 'QR is secondary');
    await page.screenshot({ path: `${output}/invite-${animal.id}.png`, omitBackground: true });
    await page.locator('#copy-invite').click();
    const copied = await app.evaluate(({ clipboard }) => clipboard.readText());
    assert.match(copied, /邀请码：\d{6}\n地址：.+\n端口：\d+\n邀请链接：http/);
    await page.locator('#renew-invite').click(); await page.locator('.task-disclosure > summary').filter({ hasText: '连接地址' }).click();
    await page.locator('#invite-address').waitFor();
    await page.locator('#close-panel').click();
    windows.push({ page, animal });
  }
  // Force all expanded windows into the same position before docking, so the
  // collision test cannot pass just because their initial offsets differ.
  await app.evaluate(({ BrowserWindow, screen }) => {
    screen.getCursorScreenPoint = () => ({ x: -10000, y: -10000 });
    const area = screen.getPrimaryDisplay().workArea;
    for (const win of BrowserWindow.getAllWindows().filter(win => !win.webContents.getURL().includes('native-anchor.html'))) win.setBounds({ x: area.x + area.width - 350, y: area.y + 240, width: 340, height: 470 });
  });
  await pause(250);
  for (const { page } of windows) { await page.evaluate(() => { document.activeElement?.blur(); return window.pickdrop.dock(); }); await page.waitForFunction(() => document.documentElement.dataset.pickdropCollapsed === 'true'); }
  await pause(400);
  const tabIds = await Promise.all(windows.map(async ({page}) => (await bootstrap(page)).window.tabWindowId));
  const bounds = await app.evaluate(({ BrowserWindow }, ids) => ids.map(id => { const win = BrowserWindow.fromId(id); return { title:win.getTitle(), ...win.getBounds(), visible:win.isVisible() }; }), tabIds);
  assert.equal(bounds.length, 3); assert.ok(bounds.every(item => item.visible && item.width === 56 && item.height === 56));
  for (let i = 0; i < bounds.length; i++) for (let j = i + 1; j < bounds.length; j++) assert.ok(bounds[i].y + bounds[i].height <= bounds[j].y || bounds[j].y + bounds[j].height <= bounds[i].y, 'collapsed groups must not overlap');
  for (const { page, animal } of windows) {
    const anchor = await nativeWindowPage(app, (await bootstrap(page)).window.tabWindowId);
    assert.equal(await anchor.locator('#pickdrop-native-tab').getAttribute('data-animal'), animal.id);
    await anchor.waitForFunction(() => { const img = document.querySelector('#pickdrop-native-tab img'); return img?.complete && img.naturalWidth > 0; });
    await anchor.screenshot({ path: `${output}/collapsed-${animal.id}.png`, omitBackground: true });
  }
  assert.deepEqual(errors, []);
  await writeFile(`${output}/desktop-check.json`, JSON.stringify({ bounds, alignedInviteButtons: true, distinctAnimals: true, errors }, null, 2));
} finally { await app.close(); await rm(root, { recursive: true, force: true }); }

const browser = await chromium.launch({ headless: true });
try {
  const page = await browser.newPage({ viewport: { width: 820, height: 430 } });
  await page.setContent(`<style>body{margin:0;background:#F8FAF7;color:#25453C;font:14px system-ui;padding:24px}h1{font-size:20px;font-weight:600}section{display:grid;grid-template-columns:repeat(5,1fr);gap:18px}article{text-align:center;background:#EEF2E9;border-radius:16px;padding:10px}svg{width:104px;height:104px;display:block;margin:auto}span{display:block;margin-top:4px}</style><h1>拾传 · 十位群聊小信使</h1><section>${ANIMALS.map(animal => `<article>${animalSvg(animal.id)}<span>${animal.name}</span></article>`).join('')}</section>`);
  await page.screenshot({ path: `${output}/animals-preview.png`, fullPage: true });
} finally { await browser.close(); }
console.log('Desktop animal/invitation checks passed: three real collapsed windows, distinct couriers, no overlap, equal button alignment.');
