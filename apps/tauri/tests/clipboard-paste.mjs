import assert from 'node:assert/strict';
import { chromium } from 'playwright';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../../../', import.meta.url));
const server = spawn(process.execPath, [root + 'apps/tauri/node_modules/vite/bin/vite.js', '--host', '127.0.0.1', '--port', '1450', '--strictPort'], { cwd: root + 'apps/tauri', stdio: 'ignore' });
let browser;
try {
    for (let attempt = 0; attempt < 100; attempt++) {
        try { if ((await fetch('http://127.0.0.1:1450')).ok) break; } catch {}
        await new Promise(resolve => setTimeout(resolve, 100));
    }
    browser = await chromium.launch({ headless: true });
    const page = await browser.newPage({ userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 Chrome/130 Safari/537.36' });
    const errors = [];
    page.on('pageerror', error => errors.push(error.message));
    await page.addInitScript(() => {
        window.calls = []; window.holdPaste = true;
        const groups = [{ id: 'first', name: '第一群' }, { id: 'second', name: '第二群' }];
        window.__PICKDROP_TEST_BRIDGE__ = {
            async call(method, params) {
                window.calls.push({ method, params });
                if (method === 'bootstrap') return { device: { id: 'self' }, groups, activeGroupId: 'first' };
                if (method === 'get_state') return { ...groups.find(group => group.id === params.groupId), messages: [], devices: [], history: {} };
                return {};
            },
            async native(command) {
                if (command === 'native_paste_image') {
                    window.pasteCount = (window.pasteCount || 0) + 1;
                    if (window.holdPaste) return new Promise(resolve => { window.finishPaste = resolve; });
                    return null;
                }
                return {};
            },
            async subscribe() { return () => {}; },
        };
    });
    await page.goto('http://127.0.0.1:1450');
    await page.locator('#group-name').filter({ hasText: '第一群' }).waitFor();
    const paste = async image => page.locator('#message-input').evaluate((input, image) => {
        const clipboardData = new DataTransfer();
        if (image) clipboardData.items.add(new File(['pixels'], 'image.png', { type: 'image/png' }));
        else clipboardData.setData('text/plain', 'ordinary text');
        const event = new ClipboardEvent('paste', { bubbles: true, cancelable: true, clipboardData });
        input.dispatchEvent(event);
        return event.defaultPrevented;
    }, image);
    assert.equal(await paste(true), true);
    await page.waitForFunction(() => !!window.finishPaste);
    await page.locator('#groups-button').click();
    await page.getByRole('button', { name: '第二群', exact: true }).click();
    await page.evaluate(() => window.finishPaste({ path: '/app/clipboard/image.png', name: 'image.png', size: 128 }));
    await page.waitForFunction(() => JSON.parse(localStorage.getItem('pickdrop.file-drafts.v1') || '{}').first?.length === 1);
    assert.equal(await page.locator('#file-drafts').isVisible(), false, 'paste must keep its original target');
    assert.equal(await page.evaluate(() => window.calls.some(call => call.method === 'send_file')), false, 'paste must not send automatically');
    await page.locator('#groups-button').click();
    await page.getByRole('button', { name: '第一群', exact: true }).click();
    await page.locator('.file-draft').filter({ hasText: 'image.png' }).waitFor();
    assert.equal(await page.locator('#send-text').isEnabled(), true);
    await page.evaluate(() => { window.holdPaste = false; });
    assert.equal(await paste(false), false, 'ordinary text keeps the native paste default');
    await page.waitForFunction(() => window.pasteCount === 2);
    assert.equal(await page.locator('.file-draft').count(), 1);
    await page.locator('#settings-button').click();
    await paste(true);
    await page.waitForTimeout(50);
    assert.equal(await page.evaluate(() => window.pasteCount), 2, 'settings dialogs must not read clipboard images');
    assert.deepEqual(errors, []);
    console.log('Clipboard paste keeps its target and confirmation, preserves text paste, and ignores settings dialogs.');
} finally { await browser?.close(); server.kill(); }
