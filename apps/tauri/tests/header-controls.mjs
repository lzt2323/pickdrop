import {chromium} from 'playwright';
import {spawn} from 'node:child_process';
import {mkdir,writeFile} from 'node:fs/promises';
import {fileURLToPath} from 'node:url';
import assert from 'node:assert/strict';
const root=fileURLToPath(new URL('../../../',import.meta.url));
const output=root+'.build/reports/header-controls';await mkdir(output,{recursive:true});
const server=spawn(process.execPath,[root+'apps/tauri/node_modules/vite/bin/vite.js','--host','127.0.0.1','--port','1448','--strictPort'],{cwd:root+'apps/tauri',stdio:'ignore'});
const browser=await chromium.launch({headless:true}),errors=[],checks=[];
try {
  for(let i=0;i<100;i++){try{if((await fetch('http://127.0.0.1:1448')).ok)break;}catch{}await new Promise(r=>setTimeout(r,100));}
  const page=await browser.newPage({viewport:{width:320,height:420},userAgent:'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 Chrome/130 Safari/537.36'});
  page.on('pageerror',e=>errors.push(e.message));
  await page.addInitScript(()=>{
    const group={id:'test',name:'拾传窗口与样式验收',animalId:'cat',creatorDeviceId:'self'};
    const devices=[{id:'self',name:'本机'},{id:'other',name:'测试设备',online:true}];
    const messages=[{id:'short',type:'text',text:'短消息',senderId:'other',senderName:'测试设备',createdAt:Date.now()},
      {id:'own',type:'text',text:'已收到',senderId:'self',senderName:'本机',createdAt:Date.now()},
      {id:'long',type:'text',text:'较长的文字会自然换行，边框跟随内容，不挤占复制按钮的位置。\n第二行仍保留换行。',senderId:'other',senderName:'测试设备',createdAt:Date.now()}];
    Object.defineProperty(navigator,'clipboard',{value:{writeText:async text=>{window.copied=text;}}});
    let listener;const state={owner:'main',edge:'right',collapsed:false,pinned:false,dockingEnabled:true};window.nativeCalls=[];
    window.__PICKDROP_TEST_BRIDGE__={async call(method){if(method==='bootstrap')return{device:devices[0],groups:[group],activeGroupId:group.id};if(method==='get_state')return{...group,devices,messages,revision:1,history:{hasMore:false}};if(method==='list_join_requests')return[];return{};},
      async native(command,args){window.nativeCalls.push({command,args});if(command==='window_action'){if(args.action==='edge-docking'){state.dockingEnabled=args.value;state.edge=args.value?'right':null;localStorage.setItem('header.test.window',JSON.stringify(state));listener?.({...state});}if(args.action==='pin'){state.pinned=args.value;listener?.({...state});}}return[];},
      async subscribe(){return()=>{};},async subscribeWindow(handler){listener=handler;Object.assign(state,JSON.parse(localStorage.getItem('header.test.window')||'{}'));handler({...state});return()=>{};}};
  });
  await page.goto('http://127.0.0.1:1448');await page.locator('[data-message-id=short]').waitFor();
  assert.equal(await page.locator('#dock-window').getAttribute('aria-pressed'),'true');
  await page.locator('#groups-button').focus();assert.equal(await page.locator('#groups-button').evaluate(n=>getComputedStyle(n).outlineStyle),'none','native/programmatic startup focus is quiet');
  await page.keyboard.press('Tab');assert.notEqual(await page.evaluate(()=>getComputedStyle(document.activeElement).outlineStyle),'none','keyboard focus stays visible');
  await page.locator('#members-button').click();assert.equal(await page.locator('body').getAttribute('data-input-mode'),'pointer');
  await page.locator('#close-panel').focus();assert.equal(await page.locator('#close-panel').evaluate(n=>getComputedStyle(n).outlineStyle),'none');
  await page.screenshot({path:output+'/members-pointer.png'});
  await page.keyboard.press('Tab');assert.notEqual(await page.evaluate(()=>getComputedStyle(document.activeElement).outlineStyle),'none');await page.keyboard.press('Escape');
  const short=page.locator('[data-message-id=short]');await short.locator('.bubble').hover();
  const geometry=await short.evaluate(row=>{const b=row.querySelector('.bubble').getBoundingClientRect(),c=row.querySelector('.message-copy').getBoundingClientRect();return{bubbleWidth:b.width,gap:c.left-b.right,copyOpacity:getComputedStyle(row.querySelector('.message-copy')).opacity};});
  assert.ok(geometry.bubbleWidth<100,`short bubble stretched: ${geometry.bubbleWidth}`);assert.ok(geometry.gap>=0&&geometry.gap<=6);assert.equal(geometry.copyOpacity,'1');
  assert.equal(await short.locator('.bubble').getAttribute('title'),null,'no persistent double-click tooltip');
  await short.getByRole('button',{name:'复制消息'}).click();assert.equal(await page.evaluate(()=>window.copied),'短消息');
  await page.locator('#pin-window').click();
  assert.match(await page.locator('#pin-window').getAttribute('title'),/保持展开/);
  assert.match(await page.locator('#dock-window').getAttribute('title'),/长驻期间暂停收缩/);
  await page.locator('#dock-window').click();
  assert.equal(await page.locator('#dock-window').getAttribute('aria-pressed'),'false');assert.equal(await page.locator('#pin-window').getAttribute('aria-pressed'),'true');
  await page.reload();await page.locator('[data-message-id=short]').waitFor();assert.equal(await page.locator('#dock-window').getAttribute('aria-pressed'),'false');
  await page.locator('#dock-window').click();assert.equal(await page.locator('#dock-window').getAttribute('aria-pressed'),'true');
  for(const width of [300,320,380]) {await page.setViewportSize({width,height:420});await short.locator('.bubble').hover();assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth),false);const toolbar=await page.locator('.header-actions').boundingBox();assert.ok(toolbar.x>=0&&toolbar.x+toolbar.width<=width);await page.screenshot({path:output+`/chat-${width}.png`});}
  await page.emulateMedia({reducedMotion:'reduce'});await page.locator('#settings-button').click();await page.locator('#panel').getByRole('heading',{name:'设置',exact:true}).waitFor();await page.screenshot({path:output+'/settings-reduced-motion.png'});
  checks.push('startup and pointer modal focus remain quiet','keyboard Tab focus stays visible','content-sized bubbles and adjacent copy','copy uses mocked clipboard','default-on docking toggle persists independently of pin','300/320/380px toolbar fits','reduced motion settings accessible');
  assert.deepEqual(errors,[]);await writeFile(output+'/results.json',JSON.stringify({passed:true,checks,geometry,errors},null,2));console.log(JSON.stringify({passed:true,checks,geometry,errors},null,2));
}finally{await browser.close();server.kill();}
