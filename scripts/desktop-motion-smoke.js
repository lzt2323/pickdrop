import assert from 'node:assert/strict';
import { _electron as electron } from 'playwright';
import { mkdtemp, rm, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
const dir = await mkdtemp(path.join(tmpdir(), 'pickdrop-motion-'));
const app = await electron.launch({ args: ['.'], env: { ...process.env, PICKDROP_USER_DATA: dir } });
const pause = ms => new Promise(r => setTimeout(r, ms));
const errors = [], alphaChecks = {}, reversals = [];
app.process().stderr?.on('data', chunk => { const line = chunk.toString(); if (/Error|Exception/.test(line)) console.log('Electron stderr:', line); });
try {
  async function firstContentWindow(){for(let n=0;n<150;n++){for(const candidate of app.windows()){if(candidate.url().includes('/native-anchor.html'))continue;try{if(await candidate.locator('#connection-status').count())return candidate;}catch{}}await pause(100);}throw Error('Content renderer did not open');}
  const page = await firstContentWindow(); page.on('pageerror', e => errors.push(e.message));
  page.on('console', message => { if (message.type() === 'error') errors.push(message.text()); });
  await page.waitForFunction(() => document.querySelector('#connection-status')?.dataset.connected === 'true');
  await mkdir('artifacts', { recursive: true });
  const state = async () => (await page.evaluate(() => window.pickdrop.bootstrap())).window;
  const initial = await state();
  assert.equal(initial.separateAnchor, true, 'native anchor must be a separate surface');
  assert.notEqual(initial.tabWindowId, initial.contentWindowId);
  const contentId = initial.contentWindowId, tabId = initial.tabWindowId;
  const anchor = await app.waitForEvent('window', { predicate:p=>p.url().includes('/native-anchor.html'),timeout:1500 }).catch(()=>app.windows().find(p=>p.url().includes('/native-anchor.html')));
  assert.ok(anchor, 'separate anchor renderer exists'); anchor.on('pageerror', e=>errors.push(e.message));
  const bounds = () => app.evaluate(({ BrowserWindow },id) => BrowserWindow.fromId(id).getBounds(),contentId);
  const native = id => app.evaluate(({ BrowserWindow },id)=>{const w=BrowserWindow.fromId(id);return {id:w.id,bounds:w.getBounds(),visible:w.isVisible(),focused:w.isFocused(),opacity:w.getOpacity(),handle:w.getNativeWindowHandle().toString('hex'),resizable:w.isResizable()};},id);
  const nativeStart = await native(contentId), anchorStart = await native(tabId);
  assert.ok(nativeStart.handle);assert.ok(anchorStart.handle);assert.notEqual(nativeStart.handle,anchorStart.handle,'distinct OS-native handles');
  // Observe native hit-test commands without replacing their behavior.
  await app.evaluate(({ BrowserWindow },ids)=>{globalThis.__hitTests={};for(const id of ids){const win=BrowserWindow.fromId(id),original=win.setIgnoreMouseEvents.bind(win);win.setIgnoreMouseEvents=(ignore,options)=>{globalThis.__hitTests[id]=ignore;return original(ignore,options);};}},[contentId,tabId]);
  const point = p => app.evaluate((_electron,p)=>{globalThis.__cursor={x:Math.round(p.x),y:Math.round(p.y)};},p);
  await app.evaluate(({screen})=>{globalThis.__cursor={x:-10000,y:-10000};screen.getCursorScreenPoint=()=>({...globalThis.__cursor});});
  const area = await app.evaluate(({screen,BrowserWindow},id)=>screen.getDisplayMatching(BrowserWindow.fromId(id).getBounds()).workArea,contentId);
  async function settled(collapsed){for(let i=0;i<140;i++){const s=await state();if(!s.transition&&(collapsed===undefined||s.collapsed===collapsed)){await pause(30);if(!s.collapsed){const layout=await page.locator('.app').evaluate(node=>{const b=node.getBoundingClientRect();return {x:b.x,y:b.y,width:b.width,height:b.height,viewportWidth:innerWidth,viewportHeight:innerHeight};});assert.ok(Math.abs(layout.x)<1&&Math.abs(layout.y)<1,'settled panel must not retain legacy top-edge translation');assert.equal(layout.width,layout.viewportWidth);assert.equal(layout.height,layout.viewportHeight);}return s;}await pause(25);}throw Error('Window motion did not settle');}
  async function headerDrag(target,expectedEdge){
    await page.evaluate(()=>window.pickdrop.expand());await settled(false);
    const before=await bounds(),grip=await page.locator('.window-grip').boundingBox();assert.ok(grip);
    const local={x:grip.x+grip.width/2,y:grip.y+grip.height/2};
    await point({x:before.x+local.x,y:before.y+local.y});await page.mouse.move(local.x,local.y);await page.mouse.down();await pause(40);
    await point({x:target.x+local.x,y:target.y+local.y});await pause(350);
    const held=await state();assert.equal(held.moving,true);assert.equal(held.candidateEdge,expectedEdge);assert.equal(held.edge,null,'holding must not commit a dock');
    await page.mouse.up();await settled(false);assert.equal((await state()).edge,expectedEdge);
  }
  async function collapse(edge){
    await point({x:-10000,y:-10000});await page.evaluate(()=>{document.activeElement?.blur();return window.pickdrop.dock();});await settled(true);
    const s=await state(),content=await native(contentId),tab=await native(tabId);
    assert.equal(s.edge,edge);assert.equal(tab.bounds.width,56);assert.equal(tab.bounds.height,56);
    assert.equal(content.bounds.width,s.contentWidth,'content native frame must never shrink to icon');assert.equal(content.bounds.height,s.contentHeight);
    assert.equal(content.visible,false,'collapsed content must be hidden, not a transparent click shield');assert.equal(tab.visible,true);
    assert.equal(await app.evaluate((_e,id)=>globalThis.__hitTests[id],contentId),true,'collapsed content disables mouse interception');
    if(edge==='top')assert.equal(tab.bounds.y,area.y);if(edge==='left')assert.equal(tab.bounds.x,area.x);if(edge==='right')assert.equal(tab.bounds.x+tab.bounds.width,area.x+area.width);
    const capture=await anchor.screenshot({path:`artifacts/native-anchor-${edge}.png`,omitBackground:true,timeout:10000});
    alphaChecks[edge]=await app.evaluate(({nativeImage},encoded)=>{const image=nativeImage.createFromBuffer(Buffer.from(encoded,'base64')),bitmap=image.toBitmap(),size=image.getSize();let transparent=0,painted=0,minX=size.width,minY=size.height,maxX=-1,maxY=-1;for(let y=0;y<size.height;y++)for(let x=0;x<size.width;x++){const a=bitmap[(y*size.width+x)*4+3];if(a<30)transparent++;if(a>220){painted++;minX=Math.min(minX,x);minY=Math.min(minY,y);maxX=Math.max(maxX,x);maxY=Math.max(maxY,y);}}return {transparent,painted,pixels:size.width*size.height,size,paintBounds:{minX,minY,maxX,maxY}};},capture.toString('base64'));
    const pixels=alphaChecks[edge];assert.ok(pixels.transparent>0);assert.ok(pixels.painted>pixels.pixels/5);
    assert.ok(pixels.paintBounds.minX>0&&pixels.paintBounds.minY>0&&pixels.paintBounds.maxX<pixels.size.width-1&&pixels.paintBounds.maxY<pixels.size.height-1,'complete icon retains padding on all sides');
    const images=await anchor.locator('img').evaluateAll(nodes=>nodes.map(n=>({loaded:n.complete&&n.naturalWidth>0,width:n.getBoundingClientRect().width,height:n.getBoundingClientRect().height})));
    assert.ok(images.some(n=>n.loaded&&n.width===48&&n.height===48),'full 48px animal image');
  }
  async function pullOut(dx,dy){
    await app.evaluate(({BrowserWindow},id)=>{const w=BrowserWindow.fromId(id);w.show();w.focus();},tabId);
    const b=(await native(tabId)).bounds,local={x:b.width/2,y:b.height/2};
    await point({x:b.x+local.x,y:b.y+local.y});await anchor.mouse.move(local.x,local.y);await anchor.mouse.down();await pause(40);
    await point({x:b.x+local.x+dx,y:b.y+local.y+dy});await pause(80);
    assert.equal((await state()).moving,true);assert.equal((await native(contentId)).visible,false,'anchor drag must not create a giant invisible panel');
    await anchor.mouse.up();await settled(false);assert.equal((await state()).edge,null);assert.equal((await bounds()).width,400);assert.equal((await bounds()).height,600);
    assert.equal((await native(contentId)).visible,true);assert.equal((await native(tabId)).visible,false);
  }
  for(const [edge,target,dx,dy] of [['right',{x:area.x+area.width-410,y:area.y+150},-220,40],['top',{x:area.x+Math.round(area.width/2)-200,y:area.y+8},80,150],['left',{x:area.x+8,y:area.y+150},200,20]]){
    await headerDrag(target,edge);await collapse(edge);await pullOut(dx,dy);
  }
  // Companion-only cross-edge drag: no panel follows until release/reveal.
  await headerDrag({x:area.x+area.width-410,y:area.y+180},'right');await collapse('right');
  for(const [nextEdge,target] of [['top',{x:area.x+Math.round(area.width/2),y:area.y+16}],['left',{x:area.x+16,y:area.y+240}]]){
    const b=(await native(tabId)).bounds;await point({x:b.x+28,y:b.y+28});await anchor.mouse.move(28,28);await anchor.mouse.down();await pause(35);await point(target);await pause(90);
    assert.equal((await state()).candidateEdge,nextEdge);assert.equal((await native(contentId)).visible,false);await anchor.mouse.up();await settled(true);
    assert.equal((await state()).edge,nextEdge);assert.equal((await native(tabId)).visible,true);assert.equal((await native(tabId)).bounds.width,56);
  }
  await anchor.getByRole('button').click();await settled(false);const attached=await bounds();assert.equal(attached.x,area.x+64);
  await collapse('left');await pullOut(220,60);
  await headerDrag({x:area.x+8,y:area.y+200},'left');await collapse('left');
  await anchor.getByRole('button').click();await settled(false);assert.equal((await bounds()).width,400);
  const before=await bounds(),handle=await page.locator('.custom-window-resize-handle').boundingBox(),local={x:handle.x+handle.width/2,y:handle.y+handle.height/2};
  await point({x:before.x+local.x,y:before.y+local.y});await page.mouse.move(local.x,local.y);await page.mouse.down();await pause(40);await point({x:before.x+local.x+30,y:before.y+local.y+20});await pause(60);await page.mouse.up();await settled(false);
  assert.equal((await bounds()).width,430);assert.equal((await bounds()).height,620);assert.equal((await native(contentId)).resizable,false);
  // Repeated reverse commands cannot jump/resize the content's native rectangle.
  for(let i=0;i<3;i++){
    await point({x:-10000,y:-10000});await page.evaluate(()=>window.pickdrop.dock());await pause(32);
    const atReverse=await bounds();await page.evaluate(()=>window.pickdrop.expand());const afterReverse=await bounds();assert.deepEqual(afterReverse,atReverse,'native bounds continuous at reversal');
    await settled(false);assert.equal((await bounds()).width,430);assert.equal((await bounds()).height,620);reversals.push({atReverse,afterReverse});
  }
  await page.emulateMedia({reducedMotion:'reduce'});await anchor.emulateMedia({reducedMotion:'reduce'});await pause(40);await point({x:-10000,y:-10000});await page.evaluate(()=>window.pickdrop.dock());
  assert.equal((await state()).transition,'');assert.equal((await native(tabId)).bounds.width,56);assert.equal((await bounds()).width,430);
  await page.evaluate(()=>window.pickdrop.expand());await settled(false);await page.locator('#message-input').fill('未发送的草稿必须保留');
  await collapse('left');
  const focusedBefore=(await native(contentId)).focused;
  await anchor.getByRole('button').dispatchEvent('dragenter',{dataTransfer:await anchor.evaluateHandle(()=>{const dt=new DataTransfer();dt.items.add(new File(['courier'],'hello.txt'));return dt;})});
  await pause(35);await anchor.screenshot({path:'artifacts/courier-cat-receiving.png',omitBackground:true});await settled(false);
  assert.equal((await native(contentId)).focused,focusedBefore,'incoming drag must not steal focus');
  await page.screenshot({path:'artifacts/courier-drop-expanded.png',omitBackground:true});
  await page.evaluate(()=>{const dt=new DataTransfer();dt.items.add(new File(['courier'],'hello.txt'));window.dispatchEvent(new DragEvent('drop',{dataTransfer:dt}));});
  await page.getByText('hello.txt',{exact:true}).waitFor();assert.equal(await page.locator('#message-input').inputValue(),'未发送的草稿必须保留');
  await page.screenshot({path:'artifacts/courier-file-received.png',omitBackground:true});assert.deepEqual(errors,[]);
  await writeFile('artifacts/desktop-motion-smoke.json',JSON.stringify({capturedHeaderDrag:true,holdWithoutSnap:true,threeEdgeDocking:true,threeEdgePullOut:true,anchorClick:true,fullAnimal48px:true,nativeHandlesDistinct:true,collapsedContentHidden:true,collapsedContentIgnoresMouse:true,transparentCorners:alphaChecks,reversals,customResize:true,reducedMotion:true,dragPreservesDraft:true,dragDoesNotStealFocus:true,physicalMultiDisplayTested:false,errors},null,2));
  console.log('Desktop motion smoke passed: separate native anchor/content, full 48px animal, three edges, reversals, resizing, reduced motion, real file drop, draft preservation. Cursor mocked; physical multi-display not tested.');
} catch(error){console.error('Desktop smoke failed:',error);throw error;}
finally{const closing=app.close();let shutdownTimedOut=false;const timeout=setTimeout(()=>{shutdownTimedOut=true;app.process().kill('SIGKILL');},5000);try{await closing;}finally{clearTimeout(timeout);await rm(dir,{recursive:true,force:true});}assert.equal(shutdownTimedOut,false,'Electron must shut down gracefully');}
