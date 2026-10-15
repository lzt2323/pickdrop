import assert from 'node:assert/strict';
import { chromium } from 'playwright';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { mkdir, writeFile } from 'node:fs/promises';

const origin = process.env.PICKDROP_UI_URL || 'http://127.0.0.1:1438';
const server = process.env.PICKDROP_UI_URL ? null : spawn(process.execPath, [
  fileURLToPath(new URL('../node_modules/vite/bin/vite.js', import.meta.url)),
  '--host', '127.0.0.1', '--port', '1438', '--strictPort',
], { cwd: fileURLToPath(new URL('..', import.meta.url)), stdio: 'ignore' });
let browser;
try {
  for (let i = 0; i < 100; i++) {
    try { if ((await fetch(origin)).ok) break; } catch {}
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  browser = await chromium.launch({ headless: true });
  const page = await browser.newPage();
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.route('**/__motion_test__', route => route.fulfill({ contentType: 'text/html', body: `
    <button id="open">设置</button><button id="fast">传输</button>
    <dialog id="dialog"><h2>设置</h2><input aria-label="名称"><button id="close">关闭</button></dialog>
    <script type="module">
      import { createDialogMotion } from '/src/dialog-motion.js';
      const dialog=document.querySelector('#dialog');
      window.motion=createDialogMotion(dialog);
      document.querySelector('#open').onclick=()=>{ motion.open(); if(window.rapidReopen){motion.close();motion.open();} };
      document.querySelector('#fast').onclick=()=>motion.open({animate:false});
      document.querySelector('#close').onclick=()=>motion.close();
      window.ready=true;
    </script>` }));
  await page.goto(`${origin}/__motion_test__`);
  await page.waitForFunction(() => window.ready);
  const animations = () => page.locator('#dialog').evaluate(node => node.getAnimations().map(a => ({
    duration: a.effect.getTiming().duration, easing: a.effect.getTiming().easing, frames: a.effect.getKeyframes(),
  })));
  await page.locator('#open').click();
  const entry = await animations();
  assert.equal(entry.length, 1, 'pointer entry animates once');
  assert.equal(entry[0].duration, 160);
  assert.equal(entry[0].easing, 'cubic-bezier(0.23, 1, 0.32, 1)');
  assert.equal(entry[0].frames[0].transform, 'scale(0.97)');
  assert.equal(await page.locator('#dialog').evaluate(node => node.contains(document.activeElement)), true);
  await page.waitForTimeout(30);
  await page.evaluate(() => motion.close());
  assert.equal((await animations()).length, 0, 'close cancels entry immediately');
  await page.evaluate(() => { window.rapidReopen = true; });
  await page.locator('#open').click();
  await page.waitForTimeout(20);
  assert.equal((await animations()).length, 1, 'queued old close does not cancel rapid pointer reopen');
  await page.evaluate(() => { window.rapidReopen = false; motion.open(); });
  assert.equal((await animations()).length, 0, 'open body replacement does not replay animation');
  await page.evaluate(() => motion.close());
  await page.waitForTimeout(20);
  await page.evaluate(() => motion.open());
  assert.equal((await animations()).length, 0, 'later programmatic open does not inherit pointer activation');
  await page.evaluate(() => motion.close());
  await page.locator('#open').focus();
  await page.keyboard.press('Enter');
  assert.equal((await animations()).length, 0, 'keyboard entry stays immediate');
  await page.keyboard.press('Escape');
  assert.equal(await page.locator('#dialog').evaluate(node => node.open), false);
  await page.locator('#fast').click();
  assert.equal((await animations()).length, 0, 'frequent surfaces stay immediate');
  await page.evaluate(() => motion.close());
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await page.locator('#open').click();
  const gentle = await animations();
  assert.equal(gentle.length, 1);
  assert.ok(gentle[0].frames.every(frame => !frame.transform), 'reduced motion has no transform');
  await page.evaluate(() => motion.close());
  await page.emulateMedia({ reducedMotion: 'no-preference' });
  await page.locator('#open').click();
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await page.waitForFunction(() => !document.querySelector('#dialog').getAnimations().length);
  const final = await page.locator('#dialog').evaluate(node => ({ open: node.open, opacity: getComputedStyle(node).opacity, transform: getComputedStyle(node).transform }));
  assert.deepEqual(final, { open: true, opacity: '1', transform: 'none' });
  await page.evaluate(() => motion.dispose());
  assert.deepEqual(errors, []);
  const report = { passed: true, durationMs: 160, pointerEntry: true, rapidCancellation: true, queuedCloseSafe: true, programmaticImmediate: true, bodySwapImmediate: true, keyboardImmediate: true, frequentSurfaceImmediate: true, reducedMotion: true, livePreferenceChange: true, pageErrors: errors };
  const output = new URL('../../../.build/reports/ui-review/', import.meta.url);
  await mkdir(output, { recursive: true });
  await writeFile(new URL('dialog-motion.json', output), JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report));
} finally {
  await browser?.close();
  server?.kill();
}
