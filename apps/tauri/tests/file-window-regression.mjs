import { chromium } from 'playwright';
import { spawn } from 'node:child_process';
import { readFile, mkdir, writeFile } from 'node:fs/promises';
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
const root = fileURLToPath(new URL('../../../', import.meta.url));
const output = path.join(root, '.build/reports/file-window');
await mkdir(output, { recursive: true });
const url = 'http://127.0.0.1:1443';
const server = spawn(process.execPath, [path.join(root, 'apps/tauri/node_modules/vite/bin/vite.js'), '--host', '127.0.0.1', '--port', '1443', '--strictPort'], { cwd: path.join(root, 'apps/tauri'), stdio: 'ignore' });
const browser = await chromium.launch({ headless: true });
const findings = [], pageErrors = [];
try {
  for (let i = 0; i < 100; i++) { try { await fetch(url); break; } catch { await new Promise(r => setTimeout(r, 100)); } }
  async function makePage(groupId, anchor = false, ownerLabel = null) {
    const page = await browser.newPage({ viewport: anchor ? { width: 56, height: 56 } : { width: 320, height: 420 }, userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 Chrome/130 Safari/537.36' });
    page.on('pageerror', e => pageErrors.push(e.message));
    // Execute production listeners with mocked native APIs. The sole source
    // change enables the native-listener branch normally skipped by test bridges.
    await page.route('**/src/main.js*', async route => {
      const response = await route.fetch();
      const source = (await response.text()).replace('if (!window.__PICKDROP_TEST_BRIDGE__) {', 'if (true) {');
      await route.fulfill({ response, body: source });
    });
    await page.addInitScript(({ groupId, anchor, ownerLabel }) => {
      let counter = 0;
      const callbacks = new Map(), events = new Map();
      window.reviewCalls = []; window.nativeCalls = []; window.holdSends = false; window.pendingSends = []; window.cancelledTransfers=new Set();
      window.nextPicked = [{ path: '/review/first.txt', name: 'first.txt', size: 1 }];
      const label = ownerLabel || (anchor ? 'anchor-main' : groupId === 'g1' ? 'main' : 'group-review');
      window.emitReview = async (event, payload) => {
        for (const callback of events.get(event) || []) callbacks.get(callback)({ event, payload, id: callback });
        await new Promise(r => setTimeout(r, 20));
      };
      async function native(command, args = {}) {
        window.nativeCalls.push({ command, args });
        if (command === 'native_pick_files') return window.nextPicked;
        if (command === 'window_animal') return 'cat';
        if (command === 'window_context') return {owner:label.replace(/^anchor-/,''),groupId,name:'隔离验收群',animal:'cat',edge:'right',pending:0,failures:0,recent:[]};
        if (command === 'plugin:event|listen') { const handlers = events.get(args.event) || []; handlers.push(args.handler); events.set(args.event, handlers); return ++counter; }
        return null;
      }
      window.__TAURI_INTERNALS__ = { metadata: { currentWindow: { label }, currentWebview: { label } }, transformCallback(fn) { callbacks.set(++counter, fn); return counter; }, invoke: native };
      window.__TAURI_EVENT_PLUGIN_INTERNALS__ = { unregisterListener() {} };
      const groups = groupId==='none' ? [] : [{ id: 'g1', name: '评审群 A', animalId: 'cat' }, { id: 'g2', name: '评审群 B', animalId: 'dog' }];
      window.__PICKDROP_TEST_BRIDGE__ = {
        async call(method, params = {}) {
          window.reviewCalls.push({ method, params });
          if (method === 'bootstrap') return { device: { id: 'self', name: '评审设备' }, groups, activeGroupId:groupId==='none'?null:groupId, endpoint: {} };
          if (method === 'get_state') return { ...groups.find(g => g.id === params.groupId), devices: [], messages: [], membershipRevoked:window.revoked || false, revision: 1, history: { hasMore: false } };
          if(method==='cancel_transfer'){window.cancelledTransfers.add(params.transferId);window.pendingSends.splice(0).forEach(resolve=>resolve());return {ok:true};}
          if (method === 'send_file' && window.holdSends) await new Promise(resolve => window.pendingSends.push(resolve));
          if(method==='send_file' && window.cancelledTransfers.delete(params.transferId))throw Error('已取消');
          if(method==='send_file' && window.failPaths?.includes(params.path))throw Error('隔离发送失败');
          return {};
        }, native, async subscribe(handler) { window.reviewCoreEvent=handler; return () => {}; }, async subscribeWindow(handler) {
          const id = window.__TAURI_INTERNALS__.transformCallback(e => handler(e.payload));
          await native('plugin:event|listen', { event: 'pickdrop:window', handler: id });
          handler({ owner:label, edge: 'right', collapsed: false, pinned: false });
          return () => {};
        }
      };
      window.reviewListenersReady = () => events.has('tauri://drag-leave');
    }, { groupId, anchor, ownerLabel });
    await page.goto(url + (anchor ? '/anchor.html' : '/'));
    await page.waitForFunction(() => window.reviewListenersReady());
    return page;
  }
  const a = await makePage('g1'), b = await makePage('g2'), same = await makePage('g1',false,'group-same');
  // Deliberately model an accidental broadcast as defense-in-depth; B ignores A.
  const drop={owner:'main',groupId:'g1',dropId:'drop-once',paths:['/review/target.txt']};
  await Promise.all([a,b,same].map(p=>p.evaluate(payload=>emitReview('pickdrop:anchor-drop',payload),drop)));
  assert.equal(await a.locator('.file-draft').count(),1); assert.equal(await b.locator('.file-draft').count(),0);
  await a.evaluate(payload=>emitReview('pickdrop:anchor-drop',payload),drop);
  assert.equal(await a.locator('.file-draft').count(),1);
  await a.reload();await a.waitForFunction(()=>reviewListenersReady());
  await a.evaluate(payload=>emitReview('pickdrop:anchor-drop',payload),drop);assert.equal(await a.locator('.file-draft').count(),1);
  // Same-group windows have separate owners. Native emit_to targets just main.
  assert.equal(await same.locator('.file-draft').count(),0);
  for(const p of [a,b,same])assert.equal(await p.evaluate(()=>reviewCalls.filter(c=>c.method==='send_file').length),0);
  await a.locator('#send-text').click(); await a.waitForFunction(()=>document.querySelectorAll('.file-draft').length===0);
  assert.deepEqual(await a.evaluate(()=>reviewCalls.filter(c=>c.method==='send_file').map(c=>c.params.groupId)),['g1']);
  findings.push({id:'F1',passed:true,checks:['owner isolation','same-group independent owners','dropId replay','drop never sends','one explicit submit one send']});
  await Promise.all([a,b].map(p=>p.evaluate(()=>emitReview('pickdrop:window',{owner:'main',edge:'left',collapsed:true,pinned:true}))));
  assert.equal(await a.evaluate(()=>document.body.dataset.dockEdge),'left');
  assert.equal(await b.evaluate(()=>document.body.dataset.dockEdge),'right');
  assert.equal(await b.locator('#pin-window').getAttribute('aria-pressed'),'false');
  findings.push({id:'F2',passed:true,checks:['window owner validation','independent pin and resize edge']});
  await a.evaluate(()=>{reviewCalls.length=0;});
  await a.evaluate(()=>emitReview('tauri://drag-enter',{paths:['/review/main.txt'],position:{x:120,y:100}}));
  await a.evaluate(()=>emitReview('tauri://drag-drop',{paths:['/review/main.txt'],position:{x:120,y:100}}));
  assert.equal(await a.locator('.file-draft').count(),1);
  assert.equal(await a.evaluate(()=>reviewCalls.filter(c=>c.method==='send_file').length),0);
  await a.locator('.file-draft button').click();
  await a.locator('#choose-file').click(); assert.equal(await a.locator('.file-draft').count(),1);
  assert.equal(await a.evaluate(()=>reviewCalls.filter(c=>c.method==='send_file').length),0);
  findings.push({id:'F3',passed:true,checks:['main drop stages','picker stages','target and count visible']});
  await a.evaluate(()=>{holdSends=true;}); await a.locator('#send-text').click();
  await a.waitForFunction(()=>pendingSends.length===1);
  await a.evaluate(()=>{nextPicked=[{path:'/review/second.txt',name:'second.txt'}];});
  await a.locator('#choose-file').click(); assert.equal(await a.locator('.file-draft').count(),2);
  await a.evaluate(()=>{holdSends=false;pendingSends.splice(0).forEach(resolve=>resolve());});
  await a.waitForFunction(()=>document.querySelectorAll('.file-draft').length===1 && !document.querySelector('#send-text').disabled);
  assert.ok(await a.locator('.file-draft').innerText().then(t=>t.includes('second.txt')));
  assert.ok(!(await a.evaluate(()=>reviewCalls.filter(c=>c.method==='send_file').map(c=>c.params.path))).includes('/review/second.txt'));
  await a.reload();await a.waitForFunction(()=>reviewListenersReady());
  assert.ok(await a.locator('.file-draft').innerText().then(t=>t.includes('second.txt')));
  findings.push({id:'F5',passed:true,checks:['new draft retained while A awaits','unsent B not transmitted','B restored after reload']});
  await a.locator('.file-draft button').click();
  await a.evaluate(()=>{nextPicked=[{path:'/review/one.txt'},{path:'/review/two.txt'},{path:'/review/three.txt'}];});
  await a.locator('#choose-file').click();await a.evaluate(()=>{holdSends=true;reviewCalls.length=0;});
  await a.locator('#send-text').click();await a.waitForFunction(()=>pendingSends.length===1);
  await a.locator('.file-draft').nth(1).getByRole('button',{name:'移除'}).click();
  await a.evaluate(()=>{holdSends=false;pendingSends.splice(0).forEach(resolve=>resolve());});
  await a.waitForFunction(()=>document.querySelectorAll('.file-draft').length===0);
  assert.deepEqual(await a.evaluate(()=>reviewCalls.filter(c=>c.method==='send_file').map(c=>c.params.path)),['/review/one.txt','/review/three.txt']);
  await a.evaluate(()=>{nextPicked=[{path:'/review/fail.txt'},{path:'/review/ok.txt'}];failPaths=['/review/fail.txt'];});
  await a.locator('#choose-file').click();await a.locator('#send-text').click();
  await a.waitForFunction(()=>document.querySelectorAll('.file-draft').length===1 && !document.querySelector('#send-text').disabled);
  assert.ok((await a.locator('.file-draft').innerText()).includes('fail.txt'));
  await a.evaluate(()=>{failPaths=[];});await a.locator('#send-text').click();
  await a.waitForFunction(()=>document.querySelectorAll('.file-draft').length===0);
  findings.push({id:'batch',passed:true,checks:['remove queued item without skipping others','active item explicit cancellation control','failure retains ID','retry removes only successful draft']});
  await a.evaluate(()=>{nextPicked=[{path:'/review/cancel.txt'}];holdSends=true;});
  await a.locator('#choose-file').click();await a.locator('#send-text').click();await a.waitForFunction(()=>pendingSends.length===1);
  await a.locator('.file-draft').getByRole('button',{name:'取消传输'}).click();
  await a.waitForFunction(()=>!document.querySelector('#send-text').disabled);
  assert.equal(await a.locator('.file-draft').count(),1);
  await a.evaluate(()=>{holdSends=false;revoked=true;reviewCoreEvent({type:'state',groupId:'g1',state:{id:'g1',name:'评审群 A',revision:9,membershipRevoked:true,messages:[],devices:[]}});});
  assert.equal(await a.locator('#send-text').isDisabled(),true);assert.equal(await a.locator('.file-draft').count(),1);
  await a.reload();await a.waitForFunction(()=>reviewListenersReady());assert.equal(await a.locator('.file-draft').count(),1);
  findings.push({id:'cancel-permission',passed:true,checks:['active cancellation retains draft','revoked target retains contents','cancelled draft reloads']});
  const unassigned=await makePage('none');
  await unassigned.evaluate(()=>emitReview('tauri://drag-enter',{paths:['/review/unassigned.txt'],position:{x:20,y:20}}));
  await unassigned.evaluate(()=>emitReview('tauri://drag-drop',{paths:['/review/unassigned.txt'],position:{x:20,y:20}}));
  assert.equal(await unassigned.locator('.file-draft').count(),1);
  assert.equal(await unassigned.evaluate(()=>reviewCalls.filter(c=>c.method==='send_file').length),0);
  assert.match(await unassigned.locator('#toast').innerText(),/请先选择目标群组/);
  await unassigned.reload();await unassigned.waitForFunction(()=>reviewListenersReady());assert.equal(await unassigned.locator('.file-draft').count(),1);
  findings.push({id:'no-target',passed:true,checks:['no group stages and explains','unassigned content persists','no send invocation']});
  const anchor=await makePage('g1',true);
  await anchor.evaluate(()=>{nativeCalls.length=0;});
  await anchor.evaluate(()=>emitReview('tauri://drag-enter',{paths:['/review/anchor.txt'],position:{x:20,y:20}}));
  await anchor.evaluate(()=>emitReview('tauri://drag-drop',{paths:['/review/anchor.txt'],position:{x:20,y:20}}));
  assert.deepEqual(await anchor.evaluate(()=>nativeCalls.filter(c=>c.command==='window_action'&&c.args.action==='file-hover').map(c=>c.args.value)),[true,false]);
  await anchor.evaluate(()=>emitReview('tauri://drag-enter',{paths:['/review/anchor.txt'],position:{x:20,y:20}}));
  await anchor.evaluate(()=>emitReview('tauri://drag-leave',{}));
  assert.deepEqual(await anchor.evaluate(()=>nativeCalls.filter(c=>c.command==='window_action'&&c.args.action==='file-hover').map(c=>c.args.value)),[true,false,true,false]);
  await anchor.evaluate(()=>emitReview('pickdrop:animal',{owner:'group-other',animal:'dog'}));
  assert.ok((await anchor.locator('img').getAttribute('src')).endsWith('cat.png'));
  findings.push({id:'F6',passed:true,checks:['Enter->Drop release','animal owner validation']});
  await a.screenshot({path:path.join(output,'fixed-panel.png')});
  await anchor.screenshot({path:path.join(output,'fixed-anchor.png'),omitBackground:true});
  await anchor.emulateMedia({colorScheme:'dark',reducedMotion:'reduce'}); await anchor.screenshot({path:path.join(output,'fixed-anchor-dark.png'),omitBackground:true});
  assert.deepEqual(pageErrors,[]);
  await writeFile(path.join(output,'regression.json'),JSON.stringify({date:'2026-10-13',findings,pageErrors,isolation:'Production renderers, mock core/native boundary; separate browser contexts; no real account/clipboard/files'},null,2));
  console.log(JSON.stringify({findings,pageErrors},null,2));
} finally { await browser.close(); server.kill(); }
