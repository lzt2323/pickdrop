import { chromium } from 'playwright';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { mkdir } from 'node:fs/promises';
let server;
let uiUrl = process.env.PICKDROP_UI_URL;
if (!uiUrl) {
    uiUrl = 'http://127.0.0.1:1431';
    server = spawn(process.execPath, [fileURLToPath(new URL('../node_modules/vite/bin/vite.js', import.meta.url)), '--host', '127.0.0.1', '--port', '1431', '--strictPort'], { cwd: fileURLToPath(new URL('..', import.meta.url)), stdio: 'ignore' });
    for (let attempt = 0; attempt < 100; attempt++) {
        try {
            await fetch(uiUrl);
            break;
        }
        catch {
            await new Promise(r => setTimeout(r, 100));
        }
    }
}
const browser = await chromium.launch({ headless: true });
await mkdir('artifacts/tauri-frontend', { recursive: true });
try {
    for (const viewport of [{ width: 360, height: 720 }, { width: 390, height: 844 }, { width: 1024, height: 768 }]) {
        const page = await browser.newPage({ viewport, ...(viewport.width < 600 ? { userAgent: 'Mozilla/5.0 (Linux; Android 14) AppleWebKit/537.36 Chrome/130 Mobile Safari/537.36' } : {}) });
        const errors = [];
        page.on('pageerror', e => errors.push(e.message));
        await page.addInitScript(() => { let handler; let revision = 1;const cancelled=new Set(); window.__calls = []; const messages = Array.from({ length: 300 }, (_, i) => ({ id: String(i), sequence: i + 1, type: 'text', text: `消息 ${i}`, senderId: i % 2 ? 'self' : 'other', senderName: i % 2 ? '本机' : '电脑', createdAt: Date.now() - 60000 + i * 1000 })); window.__PICKDROP_TEST_BRIDGE__ = { async call(method, p) { window.__calls.push({ method, params: p }); if (method === 'bootstrap')
                return { device: { id: 'self', name: '手机' }, groups: [{ id: 'g1', name: '我的文件', animalId: 'cat' }, { id: 'g2', name: '另一个群', animalId: 'dog' }], activeGroupId: 'g1', endpoint: { baseUrl: 'http://192.168.1.2:9000' } }; if (method === 'get_state')
                return { id: 'g1', name: '我的文件', animalId: 'cat', devices: [{ id: 'self', name: '手机' }], messages: messages.slice(Math.max(0, (p.before ? Number(p.before) - 1 : messages.length) - p.limit), p.before ? Number(p.before) - 1 : messages.length), history: { hasMore: (p.before ? Number(p.before) - 1 : messages.length) > p.limit, before: String(Math.max(0, (p.before ? Number(p.before) - 1 : messages.length) - p.limit) + 1) }, revision }; if (method === 'send_text') {
                messages.push({ id: 'new', sequence: messages.length + 1, type: 'text', text: p.text, senderId: 'self', senderName: '手机', createdAt: Date.now() });
                revision++;
                return {};
            } if (method === 'send_file') {
                cancelled.delete(p.transferId);await new Promise(r => setTimeout(r, 300));if(cancelled.has(p.transferId))throw Error('Transfer cancelled');return {};
            } if(method==='cancel_transfer'){cancelled.add(p.transferId);window.__emit({type:'transfer',id:p.transferId,status:'cancelled'});return{};}if (method === 'create_invite')
                return { code: '123456', baseUrl: 'http://192.168.1.2:9000', link: 'pickdrop://join?address=http%3A%2F%2F192.168.1.2%3A9000&code=123456' }; if (method === 'list_join_requests')
                return []; if(method==='receive_file')return{path:'/tmp/'+p.id+'.png',size:1};if (method === 'storage_stats')
                return { cacheBytes: 1024, fileCount: 1 }; return {}; }, async native(command) { if(command==='native_thumbnail')return 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jv1sAAAAASUVORK5CYII=';if (command === 'native_pick_files')
                return [{ path: '/tmp/first.txt', name: 'first.txt', size: 1 }, { path: '/tmp/second.txt', name: 'second.txt', size: 2 }]; return []; }, async subscribe(fn) { handler = fn; window.__emit = fn; return () => { }; } }; });
        await page.goto(uiUrl);
        await page.locator('.message').first().waitFor();
        assert.equal(await page.locator('.message').count(), 60);
        await page.evaluate(() => { window.__first = document.querySelector('.message'); });
        await page.locator('#message-input').fill('测试草稿');
        assert.equal(await page.evaluate(() => window.__first === document.querySelector('.message')), true, 'typing preserves row identity');
        await page.evaluate(() => window.__emit({ type: 'state', groupId: 'g1' }));
        await page.waitForTimeout(250);
        assert.equal(await page.evaluate(() => window.__first === document.querySelector('.message')), true, 'unchanged state preserves row identity');
        await page.locator('#send-text').click();
        await page.waitForFunction(() => document.querySelector('#message-input').value === '');
        assert.equal(await page.locator('.message').count(), 61);
        await page.locator('#load-history').click();
        await page.waitForFunction(() => document.querySelector('.message').dataset.messageId === '181');
        await page.locator('#load-history').click();
        await page.waitForFunction(() => document.querySelector('.message').dataset.messageId === '121');
        await page.locator('#load-history').click();
        await page.waitForFunction(() => document.querySelector('.message').dataset.messageId === '61');
        await page.evaluate(() => window.__emit({ type: 'state', groupId: 'g1', state: { revision: 999, messages: [{ id: 'incoming', type: 'text', text: '新消息', sequence: 999 }] } }));
        assert.equal(await page.locator('.message').first().getAttribute('data-message-id'), '61', 'new event preserves historical view');
        await page.locator('#newer-history').click();
        await page.waitForFunction(() => document.querySelector('.message').dataset.messageId === '121');
        await page.locator('#latest-history').click();
        await page.waitForFunction(() => document.querySelector('.message').dataset.messageId === '241');
        await page.locator('#choose-file').click();
        await page.locator('.file-draft').first().waitFor();
        assert.equal(await page.evaluate(() => window.__calls.filter(c => c.method === 'send_file').length), 0, 'picked files are drafts until confirmation');
        await page.locator('#send-text').click();
        await page.locator('#groups-button').click();
        await page.getByRole('button', { name: '另一个群', exact: true }).click();
        await page.waitForTimeout(750);
        assert.deepEqual(await page.evaluate(() => window.__calls.filter(c => c.method === 'send_file').map(c => c.params.groupId)), ['g1', 'g1'], 'file batch destination survives group switch');await page.locator('#choose-file').click();await page.locator('.file-draft').first().waitFor();await page.locator('#send-text').click();const cancel=page.getByRole('button',{name:'取消传输'}).first();await cancel.waitFor();const cancelledId=await cancel.locator('..').getAttribute('data-transfer-id');await cancel.click();await page.waitForTimeout(750);const cancelledRow=page.locator(`[data-transfer-id="${cancelledId}"]`);await cancelledRow.getByRole('button',{name:'重试'}).click();await page.waitForTimeout(350);assert.equal(await page.locator(`[data-transfer-id="${cancelledId}"]`).count(),1,'retry reuses transfer queue id');assert.deepEqual(await page.evaluate(id=>window.__calls.filter(c=>c.method==='send_file'&&c.params.transferId===id).map(c=>c.params.groupId),cancelledId),['g2','g2'],'cancelled retry retains target');await page.locator('#message-input').fill('保留草稿');await page.evaluate(()=>window.__emit({type:'state',groupId:'g2',state:{revision:888,membershipRevoked:true,messages:[],devices:[]}}));assert.equal(await page.locator('#send-text').isDisabled(),true);assert.equal(await page.locator('#message-input').inputValue(),'保留草稿');assert.equal(await page.locator('#membership-notice').isVisible(),true);await page.evaluate(()=>window.__emit({type:'state',groupId:'g2',state:{revision:889,membershipRevoked:false,messages:[],devices:[]}}));
        await page.evaluate(()=>{Object.defineProperty(document,'hidden',{configurable:true,get:()=>true});document.dispatchEvent(new Event('visibilitychange'));});await page.waitForTimeout(20);const paused=await page.evaluate(()=>window.__calls.filter(c=>c.method==='set_active'&&c.params.active===false).length);assert.equal(paused,viewport.width<600?1:0,'only mobile visibility pauses service');await page.evaluate(()=>{Object.defineProperty(document,'hidden',{configurable:true,get:()=>false});document.dispatchEvent(new Event('visibilitychange'));});await page.evaluate(()=>window.__emit({type:'state',groupId:'g2',state:{revision:950,messages:[{id:'file-first',type:'file',fileName:'first.png',size:1,sequence:1000},{id:'file-middle',type:'file',fileName:'middle.png',size:1,sequence:1001},{id:'file-last',type:'file',fileName:'last.png',size:1,sequence:1002}],devices:[],history:{hasMore:false}}}));await page.locator('#files-tab').click();for(const id of ['file-first','file-middle','file-last']){const row=page.locator(`[data-message-id="${id}"]`);await row.getByRole('button',{name:'接收文件',exact:true}).click();await row.getByRole('button',{name:'另存为',exact:true}).waitFor();assert.equal(await row.locator('.thumbnail').count(),1);assert.equal(await row.count(),1);}assert.equal(await page.locator('.message').count(),3,'receiving replaces first/middle/last rows without duplicating');assert.equal(await page.locator('#toast').isVisible(),false,'caught UI errors must not be hidden in toast');await page.locator('#all-tab').click();await page.locator('#invite-button').click();
        await page.locator('.qr').waitFor();
        assert.match(await page.locator('.qr').getAttribute('src'), /^data:image\/png/);
        await page.locator('#close-panel').click();
        assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true, 'no horizontal overflow');
        await page.screenshot({ path: `artifacts/tauri-frontend/${viewport.width}.png`, fullPage: true });
        assert.deepEqual(errors, []);
        await page.close();
    }
    console.log('Responsive frontend smoke passed: 360px, 390px, 1024px; history paging, draft confirmation, target locking, cancel/retry, membership revocation, desktop background service, QR.');
}
finally {
    await browser.close();
    server?.kill();
}
