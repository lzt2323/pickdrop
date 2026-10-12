import { _electron as electron } from 'playwright';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import assert from 'node:assert/strict';
const dir = await mkdtemp(path.join(tmpdir(), 'anchor-upload-'));
const app = await electron.launch({
  args: ['.'],
  env: { ...process.env, PICKDROP_USER_DATA: dir },
});
try {
  let page, anchor;
  for (let i = 0; i < 100; i++) {
    page = app
      .windows()
      .find((p) => p.url().startsWith('http') && !p.url().includes('native-anchor'));
    anchor = app.windows().find((p) => p.url().includes('native-anchor'));
    if (page && anchor) break;
    await new Promise((r) => setTimeout(r, 100));
  }
  await page.waitForFunction(
    () => document.querySelector('#connection-status')?.dataset.connected === 'true',
  );
  // Observe real queue mutations before dispatch, including very fast localhost uploads.
  await page.evaluate(() => {
    window.__uploadSeen = false;
    new MutationObserver(() => {
      if (document.querySelector('[data-anchor-upload]')) window.__uploadSeen = true;
    }).observe(document.querySelector('#uploads'), { childList: true });
  });
  await anchor.evaluate(() => {
    const dt = new DataTransfer();
    dt.items.add(
      new File(
        [
          Uint8Array.from(
            atob(
              'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jB1sAAAAASUVORK5CYII=',
            ),
            (c) => c.charCodeAt(0),
          ),
        ],
        'anchor-image.png',
        { type: 'image/png' },
      ),
    );
    window.dispatchEvent(new DragEvent('drop', { dataTransfer: dt }));
  });
  await page.waitForFunction(
    () => document.querySelector('#timeline')?.textContent.includes('anchor-image.png'),
    { timeout: 15000 },
  );
  assert.equal(await page.evaluate(() => window.__uploadSeen), true);
  // A real filesystem File supplied by Chromium input exercises webUtils path and disk stream.
  const file = path.join(dir, 'cancel-anchor.bin');
  await writeFile(file, Buffer.alloc(64 * 1024 * 1024, 7));
  await anchor.evaluate(() => {
    const input = document.createElement('input');
    input.type = 'file';
    input.id = 'test-file';
    document.body.append(input);
  });
  await anchor.locator('#test-file').setInputFiles(file);
  await page.evaluate(() => {
    window.__cancelled = false;
    new MutationObserver(() => {
      const b = document.querySelector('[data-anchor-upload] button');
      if (b && !b.disabled) {
        window.__cancelled = true;
        b.click();
      }
    }).observe(document.querySelector('#uploads'), { childList: true, subtree: true });
  });
  await anchor.evaluate(() => {
    const dt = new DataTransfer();
    dt.items.add(document.querySelector('#test-file').files[0]);
    window.dispatchEvent(new DragEvent('drop', { dataTransfer: dt }));
  });
  await page.waitForFunction(() =>
    document.querySelector('#toast')?.textContent.includes('已取消发送'),
  );
  assert.equal(await page.evaluate(() => window.__cancelled), true);
  assert.equal(await page.locator('[data-anchor-upload]').count(), 0);
  console.log(
    'PASS real Electron anchor image stream persisted; visible queue; real 64MiB disk file cancelled via queue button',
  );
} finally {
  await app.close();
  await rm(dir, { recursive: true, force: true });
}
