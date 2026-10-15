import { chromium } from 'playwright';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const url = process.env.PICKDROP_UI_URL || 'http://127.0.0.1:1446';
let server, browser;
try {
    if (!process.env.PICKDROP_UI_URL) {
        server = spawn(process.execPath, [fileURLToPath(new URL('../node_modules/vite/bin/vite.js', import.meta.url)), '--host', '127.0.0.1', '--port', '1446', '--strictPort'], { cwd: fileURLToPath(new URL('..', import.meta.url)), stdio: 'ignore' });
        for (let attempt = 0; attempt < 50; attempt++) {
            try { await fetch(url); break; } catch { await new Promise(resolve => setTimeout(resolve, 100)); }
        }
    }
    browser = await chromium.launch({ headless: true });
    const page = await browser.newPage({ viewport: { width: 390, height: 844 } });
    const errors = [];
    page.on('pageerror', error => errors.push(error.message));
    await page.addInitScript(() => {
        window.checkCount = 0;
        window.selected = [];
        window.checkMode = 'failure';
        window.__PICKDROP_TEST_BRIDGE__ = {
            async call(method, params) {
                if (method === 'bootstrap') {
                    if (window.holdBootstrap) await new Promise(resolve => { window.resolveBootstrap = resolve; });
                    return { device: { id: 'self' }, groups: [{ id: 'g1', name: '测试群' }], activeGroupId: 'g1' };
                }
                if (method === 'get_state') return { id: 'g1', name: '测试群', messages: [], devices: [], history: {} };
                if (method === 'select_group') { window.selected.push(params.id); return {}; }
                if (method === 'join_group') return { ticket: { id: 'ticket' } };
                if (method === 'check_join') {
                    window.checkCount++;
                    if (window.checkMode === 'failure') throw Error('offline');
                    if (window.checkMode === 'approved') return { status: 'approved', group: { id: 'stale' } };
                    if (window.checkMode === 'hold') return new Promise(resolve => { window.resolveCheck = resolve; });
                    return { status: 'denied' };
                }
                return {};
            },
            async native() { return {}; },
            async subscribe() { return () => {}; },
        };
    });
    await page.goto(url);
    await page.waitForFunction(() => window.selected.length === 1);
    const join = async () => {
        await page.locator('#groups-button').click();
        await page.getByRole('button', { name: '加入群组', exact: true }).click();
        await page.getByLabel('设备地址', { exact: true }).fill('127.0.0.1');
        await page.getByLabel('邀请码', { exact: true }).fill('123456');
        await page.getByRole('button', { name: '申请加入', exact: true }).click();
        await page.getByText('申请已发送，请在群内设备上允许加入。', { exact: true }).waitFor();
    };
    await join();
    await page.getByRole('button', { name: '重试检查', exact: true }).waitFor();
    await page.evaluate(() => { window.checkMode = 'denied'; });
    await page.getByRole('button', { name: '重试检查', exact: true }).click();
    await page.getByText('加入申请被拒绝。', { exact: true }).waitFor();
    assert.equal(await page.getByRole('button', { name: '重新填写邀请' }).evaluate(node => node === document.activeElement), true);
    assert.equal(await page.getByRole('button', { name: '重试检查', exact: true }).count(), 0);
    await page.locator('#close-panel').click();

    for (const replace of [false, true]) {
        await page.evaluate(() => { window.checkMode = 'hold'; window.resolveCheck = null; });
        await join();
        await page.waitForFunction(() => !!window.resolveCheck);
        if (replace) await page.locator('#settings-button').evaluate(node => node.click());
        else await page.locator('#close-panel').click();
        await page.evaluate(() => window.resolveCheck({ status: 'approved', group: { id: 'stale' } }));
        await page.waitForTimeout(50);
        assert.deepEqual(await page.evaluate(() => window.selected), ['g1'], 'stale approval cannot select another group');
        if (replace) {
            assert.equal(await page.locator('#panel-title').textContent(), '设置');
            await page.locator('#close-panel').click();
        } else assert.equal(await page.locator('#panel').evaluate(node => node.open), false);
    }
    for (const replace of [false, true]) {
        await page.evaluate(() => { window.checkMode = 'approved'; window.holdBootstrap = true; window.resolveBootstrap = null; });
        await join();
        await page.waitForFunction(() => !!window.resolveBootstrap);
        if (replace) await page.locator('#settings-button').evaluate(node => node.click());
        else await page.locator('#close-panel').click();
        await page.evaluate(() => { window.holdBootstrap = false; window.resolveBootstrap(); });
        await page.waitForTimeout(50);
        assert.deepEqual(await page.evaluate(() => window.selected), ['g1'], 'approval awaiting bootstrap cannot navigate after its panel closes');
        if (replace) {
            assert.equal(await page.locator('#panel-title').textContent(), '设置');
            await page.locator('#close-panel').click();
        } else assert.equal(await page.locator('#panel').evaluate(node => node.open), false);
    }
    assert.deepEqual(errors, []);
    console.log('Join panel retry, denial focus, close and replacement checks passed.');
} finally {
    await browser?.close();
    server?.kill();
}
