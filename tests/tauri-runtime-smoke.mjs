// Exercise the production frontend against two real Rust nodes. Native dialogs
// are replaced only at the OS boundary; pairing, history, signatures and file
// transfer all use pickdrop-core and the real HTTP peer transport.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdtemp, mkdir, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { chromium } from 'playwright';

const root = process.cwd();
const temp = await mkdtemp(path.join(tmpdir(), 'pickdrop-tauri-smoke-'));
const processes = [], connections = [];
let browser, vite;
async function node(name) {
  const child = spawn(path.join(root,'target/debug/examples/ui_bridge'), [path.join(temp,name),'0'], {stdio:['ignore','pipe','pipe']});
  processes.push(child);
  let output = '', errors = '';
  child.stderr.on('data',chunk=>errors+=chunk);
  const address = await new Promise((resolve,reject)=>{
    const timer=setTimeout(()=>reject(Error(`Rust node did not start: ${errors}`)),20000);
    child.once('exit',code=>{clearTimeout(timer);reject(Error(`Rust node exited ${code}: ${errors}`));});
    child.stdout.on('data',chunk=>{output+=chunk;const match=output.match(/127\.0\.0\.1:\d+/);if(match){clearTimeout(timer);resolve(`http://${match[0]}`);}});
  });
  const rpc = async (method,params={})=>{
    const response=await fetch(`${address}/call`,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({method,params})});
    const result=await response.json();if(!result.ok)throw Error(result.error);return result.value;
  };
  rpc.address=address;
  return rpc;
}
async function waitFor(test,message,timeout=20000){const end=Date.now()+timeout;while(Date.now()<end){if(await test())return;await new Promise(resolve=>setTimeout(resolve,100));}throw Error(message);}
async function attach(page,rpc) {
  await page.exposeFunction('__rustCall',rpc);
  await page.addInitScript(()=>{
    window.__PICKDROP_TEST_BRIDGE__={call:(method,params)=>window.__rustCall(method,params),native:async command=>{
      if(['window_action','window_animal','window_context','window_protection'].includes(command))return{};if(command==='native_consume_incoming')return{items:[]};
      if(command==='native_pick_files')return window.__nativePicked||[];
      throw Error(`OS capability ${command} is not mocked by the runtime test`);
    },subscribe:async handler=>{window.__rustEvent=handler;return()=>{};}};
  });
  const abort=new AbortController();connections.push(abort);
  // The same broadcast payloads forwarded by the Tauri host reach the actual UI.
  void (async()=>{
    try {
      const response=await fetch(`${rpc.address}/events`,{signal:abort.signal});
      const reader=response.body.getReader(),decoder=new TextDecoder();let pending='';
      while(!abort.signal.aborted){const {done,value}=await reader.read();if(done)break;pending+=decoder.decode(value,{stream:true});let index;while((index=pending.indexOf('\n\n'))>=0){const block=pending.slice(0,index);pending=pending.slice(index+2);const data=block.split('\n').filter(line=>line.startsWith('data:')).map(line=>line.slice(5).trimStart()).join('\n');if(data)await page.evaluate(event=>window.__rustEvent?.(event),JSON.parse(data));}}
    } catch(error){if(!abort.signal.aborted)console.error('Rust UI event stream:',error.message);}
  })();
}
try {
  const first=await node('desktop'),second=await node('phone');
  const version=JSON.parse(await readFile('package.json','utf8')).version;
  let ui=process.env.PICKDROP_UI_URL;
  if(!ui){
    const server=path.join(root,'apps/tauri/node_modules/vite/bin/vite.js');
    vite=spawn(process.execPath,[server,'--host','127.0.0.1','--port','1429','--strictPort'],{cwd:path.join(root,'apps/tauri'),stdio:['ignore','pipe','pipe']});
    processes.push(vite);ui='http://127.0.0.1:1429';
    await waitFor(async()=>{try{return(await fetch(ui)).ok;}catch{return false;}},'Vite did not start');
  }
  browser=await chromium.launch({headless:true});
  const desktop=await browser.newPage({viewport:{width:320,height:420}}),phone=await browser.newPage({viewport:{width:390,height:844},userAgent:'Mozilla/5.0 (Linux; Android 14) AppleWebKit/537.36 Chrome/130 Mobile Safari/537.36'});
  const pageErrors=[];for(const p of[desktop,phone])p.on('pageerror',error=>pageErrors.push(error.message));
  await attach(desktop,first);await attach(phone,second);
  await desktop.goto(ui);await phone.goto(ui);
  await desktop.locator('#groups-button').click();
  await desktop.locator('#panel').getByRole('button',{name:'创建群组',exact:true}).click();
  await desktop.getByLabel('群组名称',{exact:true}).fill('Rust 互通验收');
  await desktop.getByRole('button',{name:'创建',exact:true}).click();
  await desktop.locator('#group-name').filter({hasText:'Rust 互通验收'}).waitFor();
  const boot=await first('bootstrap'),groupId=boot.activeGroupId;
  const invite=await first('create_invite',{groupId});
  await phone.getByRole('button',{name:'加入群组',exact:true}).click();
  await phone.getByLabel('设备地址',{exact:true}).fill(boot.endpoint.baseUrl);
  await phone.getByLabel('邀请码',{exact:true}).fill(invite.code);
  await phone.getByRole('button',{name:'申请加入',exact:true}).click();
  await phone.getByRole('heading',{name:'等待加入确认'}).waitFor();
  await waitFor(async()=>(await first('list_join_requests',{groupId})).length>0,'Join request missing');
  await desktop.locator('#members-button').click();
  await desktop.getByRole('button',{name:'允许',exact:true}).click();
  await desktop.locator('#close-panel').click();
  try { await phone.locator('#group-name').filter({hasText:'Rust 互通验收'}).waitFor({timeout:20000}); }
  catch(error) { console.error(await phone.evaluate(()=>({view:document.body.dataset.view,panel:document.querySelector('#panel').open,text:document.body.innerText})));throw error; }
  await phone.locator('#message-input').fill('手机通过 Tauri 共用界面发送');
  await phone.locator('#send-text').click();
  await phone.getByText('手机通过 Tauri 共用界面发送',{exact:true}).waitFor();
  await waitFor(async()=>(await first('get_state',{groupId})).messages.some(m=>m.text==='手机通过 Tauri 共用界面发送'),'Phone text not synchronized');
  await desktop.evaluate(state=>window.__rustEvent({type:'state',groupId:state.id,state}),await first('get_state',{groupId}));
  await desktop.getByText('手机通过 Tauri 共用界面发送',{exact:true}).waitFor();
  await desktop.evaluate(()=>window.__firstRow=document.querySelector('.message'));
  await desktop.locator('#message-input').fill('电脑回复');
  assert.equal(await desktop.evaluate(()=>window.__firstRow===document.querySelector('.message')),true,'Typing changed existing message DOM');
  await desktop.locator('#send-text').click();
  await waitFor(async()=>(await second('get_state',{groupId})).messages.some(m=>m.text==='电脑回复'),'Desktop text not synchronized');
  const content=Buffer.alloc(512*1024,0x5a),source=path.join(temp,'验收文件.bin');await writeFile(source,content);
  const message=await first('send_file',{groupId,path:source});
  await waitFor(async()=>(await second('get_state',{groupId})).messages.some(m=>m.type==='file'),'File event not synchronized');
  const state=await second('get_state',{groupId});
  const fileMessage=state.messages.find(m=>m.type==='file');
  await phone.evaluate(state=>window.__rustEvent({type:'state',groupId:state.id,state}),state);
  await phone.getByRole('button',{name:'接收文件',exact:true}).click();
  await phone.getByRole('button',{name:'保存',exact:true}).waitFor({timeout:20000});
  const received=await second('receive_file',{groupId,id:fileMessage.id});
  const saved=await readFile(received.path||received.localPath);
  assert.equal(createHash('sha256').update(saved).digest('hex'),createHash('sha256').update(content).digest('hex'));
  // run() deliberately catches UI exceptions and displays a toast, so pageerror
  // alone cannot detect a failed keyed row replacement after receiving a file.
  assert.doesNotMatch(await phone.locator('#queue').innerText(), /NotFoundError|insertBefore|失败|错误/);
  assert.doesNotMatch(await phone.locator('#toast').innerText(), /NotFoundError|insertBefore|Failed to execute/);
  assert.equal(await phone.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),true,'Phone horizontal overflow');
  for (const width of [300, 380, 320]) {
    await desktop.setViewportSize({width,height:720});
    assert.equal(await desktop.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),true,`Desktop horizontal overflow at ${width}px`);
    await desktop.locator('#message-input').fill('调整窗口后保留的草稿');
    assert.equal(await desktop.locator('#send-text').isVisible(),true,'Send stays visible after desktop resize');
  }
  await mkdir('artifacts/tauri-runtime',{recursive:true});
  await desktop.screenshot({path:'artifacts/tauri-runtime/desktop.png',fullPage:true});
  await phone.screenshot({path:'artifacts/tauri-runtime/phone.png',fullPage:true});
  assert.deepEqual(pageErrors,[]);for(const page of [desktop,phone])assert.equal(await page.locator('#toast').isVisible(),false,'caught UI errors must not be hidden in toast');assert.equal(await phone.locator(`[data-message-id="${fileMessage.id}"]`).getByRole('button',{name:'保存',exact:true}).count(),1,'received file row must finish rendering');
  const click = (page, name) => page.locator('#panel').getByRole('button',{name,exact:true}).click();
  const settings = async page => { if(await page.locator('#panel').evaluate(n=>n.open))await page.keyboard.press('Escape');await page.locator('#settings-button').click(); };
  await settings(desktop);await click(desktop,'本机名称');
  assert.equal(await desktop.getByRole('button',{name:'保存设备名称',exact:true}).isDisabled(),true);
  await desktop.getByLabel('本机名称',{exact:true}).fill('桌面验收设备');await click(desktop,'保存设备名称');
  await waitFor(async()=>(await first('bootstrap')).device.name==='桌面验收设备','Device name was not persisted');
  await desktop.getByRole('heading',{name:'设置',exact:true}).waitFor();await click(desktop,'群组设置');
  assert.equal(await desktop.getByRole('button',{name:'保存群组名称',exact:true}).isDisabled(),true);
  assert.equal(await desktop.getByRole('button',{name:'移除本地群组记录',exact:true}).count(),0);
  await desktop.getByLabel('群组名称',{exact:true}).fill('全页面交互验收');await click(desktop,'保存群组名称');
  await waitFor(async()=>(await first('get_state',{groupId})).name==='全页面交互验收','Group name was not persisted');
  const cacheBytes = stats => stats.cacheBytes ?? stats.bytes ?? 0;
  const originalCache=cacheBytes(await second('storage_stats'));assert.ok(originalCache>0,'received file populates cache');
  await settings(phone);await click(phone,'存储与缓存');await click(phone,'清理缓存');await click(phone,'取消');
  assert.equal(cacheBytes(await second('storage_stats')),originalCache,'cancel does not clear cache');
  await settings(phone);await click(phone,'存储与缓存');await click(phone,'清理缓存');await click(phone,'清理缓存');
  await waitFor(async()=>cacheBytes(await second('storage_stats'))===0,'Cache clear did not finish');
  await phone.keyboard.press('Escape');await settings(desktop);await desktop.keyboard.press('Escape');
  await desktop.locator('#members-button').click();await click(desktop,'移除');await click(desktop,'取消');
  assert.equal((await first('get_state',{groupId})).devices.length,2,'cancel preserves membership');
  await desktop.locator('#members-button').click();await click(desktop,'移除');await click(desktop,'移除成员');
  await waitFor(async()=>(await second('get_state',{groupId})).membershipRevoked,'Member removal did not revoke remote membership');
  await phone.locator('#membership-notice').waitFor({state:'visible'});await settings(phone);await click(phone,'群组设置');
  await click(phone,'移除本地群组记录');await click(phone,'移除记录');
  await waitFor(async()=>(await second('bootstrap')).groups.length===0,'Exited group record was not removed');
  await settings(desktop);await click(desktop,'群组设置');await click(desktop,'退出群组');await click(desktop,'退出群组');
  await waitFor(async()=>(await first('bootstrap')).groups.length===0,'Owner leave did not finish');
  assert.deepEqual(pageErrors,[]);
  const report={version,realRustNodes:2,joinApproval:true,bidirectionalText:true,fileBytes:saved.length,fileSha256:createHash('sha256').update(saved).digest('hex'),typingPreservesRows:true,receiveRowRendered:true,deviceNamePersisted:true,groupNamePersisted:true,clearCacheCancelAndCommit:true,memberRemovalCancelAndCommit:true,revokedGroupForget:true,ownerLeave:true,uiErrorToasts:[],desktopResizeWidths:[300,380,320],phoneViewport:390,pageErrors};
  await writeFile('artifacts/tauri-runtime/report.json',JSON.stringify(report,null,2)+'\n');
  console.log(JSON.stringify(report));
} finally {
  for(const abort of connections)abort.abort();
  await browser?.close();
  for(const child of processes)child.kill('SIGTERM');
  await rm(temp,{recursive:true,force:true});
}
