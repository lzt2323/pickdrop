import { firstContentWindow, nextContentWindow } from './desktop-test-windows.js';
/** Real Electron page atlas. Run only after other desktop tests are stopped:
 * PICKDROP_CAPTURE_READY=1 node scripts/desktop-pages-preview.js
 * Every image is captured from production HTML/JS with isolated fixture profiles.
 * No DOM replacement, connection mocking, or stylesheet injection is used. */
import { _electron as electron } from 'playwright';
import { mkdtemp, mkdir, rm, writeFile, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

if (process.env.PICKDROP_CAPTURE_READY !== '1') throw new Error('Capture not started. Stop competing desktop tests, then set PICKDROP_CAPTURE_READY=1.');
const root = fileURLToPath(new URL('../', import.meta.url));
const output = path.join(root, 'docs/archive/ui-concepts/2026-10-11/desktop-product');
const dir = await mkdtemp(path.join(tmpdir(), 'pickdrop-pages-'));
const apps = [], pages = [], errors = [], uncovered = [];
const routes = {
 'legacy-storage':['旧托管群 → 存储与清理','独立legacy测试profile有真实上传文件','选择主机文件、清理'],
 'legacy-clean-confirm':['主机文件列表 → 清理所选','真实文件已选中','确认或取消（未删除）'],
 'peer-offline':['群聊天窗口','第二个测试Electron实例已真实退出','继续发送、查看设备'],
 'offline-diagnostic':['成员 → 连接诊断','远端实例已退出，本机服务仍在线','重新连接、手动连接'],
 welcome:['托盘 → 新建或加入群','欢迎窗口','创建群聊、加入群聊'],
 create:['欢迎 → 创建群聊','打开新建面板','编辑群名称、选择动物、创建'],
 empty:['创建群聊 → 关闭邀请','尚无消息','发消息、选择文件、邀请设备'],
 'group-menu':['标题栏群名','点击群名','打开群、创建/加入、网络与存储'],
 invite:['群菜单 → 邀请设备','已有群聊','复制邀请、重新生成、扫码'],
 'invite-qr':['邀请设备 → 扫码加入','邀请码有效','返回邀请信息'],
 join:['群菜单 → 加入群聊','尚未发起申请','填邀请码/地址/端口、粘贴邀请、申请'],
 pending:['加入群聊 → 申请加入','第二个真实测试实例发起申请','关闭后继续等待'],
 'request-banner':['群主聊天窗口','收到第二实例申请','允许、拒绝、查看详情'],
 requests:['申请通知 → 查看详情','申请仍待处理','允许或拒绝'],
 conversation:['群聊天窗口','两个实例交换消息并上传文件','发消息、接收、另存、拖出'],
 'file-menu':['文件气泡 → 更多','文件已发送','接收、重新接收、另存等适用操作'],
 'image-draft':['输入框粘贴图片','真实ClipboardEvent携带测试PNG','移除图片、发送'],
 'image-message':['发送图片草稿','实际文件接口完成上传','点击图片预览'],
 'image-preview':['图片消息 → 缩略图','图片已接收','关闭预览'],
 members:['顶部设备栏','已有成员','邀请、改名、审批、诊断'],
 'members-settings':['设备面板 → 下滚','群创建者','修改群名/动物、解散、设备改名'],
 diagnostic:['设备 → 连接诊断与手动连接','打开诊断','重连、手动连接、网络设置'],
 network:['群菜单 → 网络连接设置','读取本机实际网卡','选择网卡、应用、刷新'],
 storage:['群菜单 → 存储与清理','真实测试文件已写入','清理接收缓存'],
 'storage-confirm':['存储 → 清理接收缓存','用户点击清理','确认或取消（截图未执行删除）'],
 'delete-confirm':['设备 → 解散此群','群创建者点击解散','确认或取消（截图未执行解散）'],
 'join-error':['加入群聊 → 提交不完整内容','输入不足6位邀请码','补全内容后重试'],
};
const escape = value => String(value).replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
await mkdir(path.join(output, 'screenshots'), { recursive: true });
const bootstrap = page => page.evaluate(() => window.pickdrop.bootstrap());
const connected = page => page.waitForFunction(() => document.querySelector('#connection-status')?.dataset.connected === 'true', null, {timeout:20000});
async function launch(name, legacy = false) {
 const packaged = process.env.PICKDROP_TEST_EXECUTABLE;
 const app = await electron.launch({executablePath:packaged || createRequire(import.meta.url)('electron'),args:packaged?[]:[root],cwd:root,env:{...process.env,PICKDROP_TEST_LEGACY_GROUPS:legacy?'1':'0',PICKDROP_USER_DATA:path.join(dir,name)}});
 apps.push(app); app.on('window', p=>p.on('pageerror',e=>errors.push(e.message)));
 const page=await firstContentWindow(app); await page.waitForFunction(()=>Boolean(window.pickdrop)); return {app,page};
}
async function shot(page,id,title,note='') {
 await page.evaluate(()=>document.fonts.ready);
 await page.locator('#toast').waitFor({state:'hidden',timeout:6000});
 await page.screenshot({path:path.join(output,'screenshots',id+'.png'),animations:'disabled',omitBackground:true});
 const size=await page.evaluate(()=>({width:innerWidth,height:innerHeight,overflow:document.documentElement.scrollWidth>innerWidth}));
 const [entry,condition,actions]=routes[id] || []; const panelKind=await page.locator('#panel').evaluate(n=>n.open ? n.dataset.panelKind || n.dataset.kind : null); pages.push({id,title,note,entry,condition,actions,panelKind,...size}); console.log('Captured:',id,title);
}
async function close(page){if(await page.locator('#panel').evaluate(n=>n.open)){await page.keyboard.press('Escape');await page.locator('#panel').waitFor({state:'hidden'});}}
async function menu(page,id){await close(page);if(!(await page.locator('#group-menu').isVisible()))await page.locator('#group-menu-button').click();await page.locator('#'+id).click();}
async function section(label,work){try{await work();}catch(e){uncovered.push({title:label,reason:e.message.split('\n')[0]});console.error('Not captured:',label,e.message);}}
async function findGroup(app,id){for(let n=0;n<100;n++){for(const p of app.windows()){try{if((await bootstrap(p)).group.id===id)return p;}catch{}}await new Promise(r=>setTimeout(r,100));}throw Error('Group window did not open');}
async function send(page,text){await page.locator('#message-input').fill(text);await page.locator('#send-text').click();await page.getByText(text,{exact:true}).waitFor();}
async function atlas(){
 const cards=pages.map(p=>`<article id="${p.id}"><h2>${escape(p.title)}</h2><a href="screenshots/${p.id}.png" target="_blank"><img src="screenshots/${p.id}.png" alt="${escape(p.title)}真实客户端截图" width="${p.width}" height="${p.height}" loading="lazy"></a><p>${p.width} × ${p.height}${p.overflow?' · 检测到横向溢出':''}${p.note?' · '+escape(p.note):''}</p><dl><dt>入口</dt><dd>${escape(p.entry)}</dd><dt>条件</dt><dd>${escape(p.condition)}</dd><dt>操作</dt><dd>${escape(p.actions)}</dd></dl></article>`).join('');
 await writeFile(path.join(output,'index.html'),`<!doctype html><html lang="zh-CN"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>拾传电脑端 · 真实页面图册</title><style>*{box-sizing:border-box}html,body{overflow-x:clip}:root{--paper:#fff9f5;--ink:#43362f;--line:#efd9c9;--surface:#fff3eb;--focus:#ad511e;--body:system-ui,sans-serif}body{margin:0;background:var(--paper);color:var(--ink);font:15px/1.6 var(--body)}main{max-width:1280px;margin:auto;padding:28px}h1{font-size:26px}h2{font-size:17px}header p{max-width:70ch}nav{display:flex;flex-wrap:wrap;gap:8px 20px;margin:24px 0}a{color:inherit;text-underline-offset:4px}nav a{white-space:nowrap}a:focus-visible{outline:3px solid var(--focus);outline-offset:4px}.grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(min(100%,360px),1fr));gap:28px;align-items:start}article{min-width:0}article img{display:block;width:100%;height:auto;max-width:420px;border:1px solid var(--line);border-radius:14px;background:var(--surface)}article p,dl{font-size:13px}dl{display:grid;grid-template-columns:32px minmax(0,1fr);gap:4px 8px}dt{font-weight:600}dd{margin:0}footer{margin-top:40px;border-top:1px solid var(--line);padding-top:20px}li{overflow-wrap:anywhere}</style><main><header><span>正式客户端页面图册</span><h1>电脑端真实页面</h1><p>来自正式客户端的独立测试实例。界面未替换，群聊、邀请、文件与审批均走真实业务流程；内容与设备名为测试数据。点击图片查看原始尺寸。</p><p>已捕获 ${pages.length} 个状态 · ${escape(new Date().toISOString())}</p></header><nav>${pages.map(p=>`<a href="#${p.id}">${escape(p.title)}</a>`).join('')}</nav><div class="grid">${cards}</div><footer><h2>未覆盖与限制</h2><ul>${uncovered.map(p=>`<li>${escape(p.title)}：${escape(p.reason)}</li>`).join('')}<li>原生系统文件选择、另存为、拖出窗口不属于网页面板，本图册不模拟系统对话框。</li><li>未通过覆盖 DOM、注入假状态或改写生产代码制造截图。</li></ul></footer></main></html>`);
 await writeFile(path.join(output,'coverage.json'),JSON.stringify({generatedAt:new Date().toISOString(),fixtureData:true,productionDOM:true,pages,uncovered,errors},null,2));
}
try {
 const owner=await launch('owner'); await connected(owner.page);
 await owner.page.evaluate(()=>window.pickdrop.openGroup('__welcome__'));
 const welcome=await findGroup(owner.app,'__welcome__'); await welcome.getByText('文件，见面就传。',{exact:true}).waitFor();
 await shot(welcome,'welcome','欢迎');
 await welcome.getByRole('button',{name:'创建一个群',exact:true}).click();await shot(welcome,'create','创建群聊');
 await welcome.locator('#new-group-name').fill('设计小屋'); const opened=nextContentWindow(owner.app);await welcome.locator('#confirm-create-group').click();const group=await opened;await connected(group);await group.locator('#invite-code').waitFor();await close(group);
 await shot(group,'empty','群聊空态');const info=await bootstrap(group);
 await group.locator('#group-menu-button').click();await shot(group,'group-menu','群菜单');await group.locator('#group-menu-button').click();
 await section('邀请信息与二维码',async()=>{await menu(group,'invite-members');await group.locator('#invite-code').waitFor();await shot(group,'invite','邀请设备');await group.locator('.invite-scan').click();await group.locator('.invite-qr').waitFor();await shot(group,'invite-qr','扫码加入');await close(group);});
 const peer=await launch('peer');await connected(peer.page);await peer.page.evaluate(()=>window.pickdrop.rename('小兔的电脑'));
 await menu(peer.page,'join-group');await shot(peer.page,'join','加入群聊');
 const invite=await group.evaluate(()=>window.pickdrop.createInvite());const endpoint=new URL(invite.baseUrl);
 await peer.page.locator('#join-code').fill(invite.code);await peer.page.locator('#join-address').fill(endpoint.hostname);await peer.page.locator('#join-port').fill(endpoint.port);await peer.page.locator('#confirm-join-group').click();await peer.page.locator('#join-status').waitFor();await shot(peer.page,'pending','等待批准');
 await group.locator('#join-request-banner').waitFor();await shot(group,'request-banner','加入申请通知');await group.locator('#view-join-requests').click();await shot(group,'requests','审批申请');await group.locator('[data-action="approve-join"]').last().click();await close(group);
 const peerGroup=await findGroup(peer.app,info.group.id);await connected(peerGroup);
 await send(peerGroup,'封面和说明放这里啦');await send(group,'收到，我来整理。');
 await group.locator('#file-input').setInputFiles({name:'项目说明.txt',mimeType:'text/plain',buffer:Buffer.from('拾传真实页面图册测试文件\n')});await group.getByText('项目说明.txt',{exact:true}).waitFor();await shot(group,'conversation','消息与文件');
 routes['files-view']=['顶部 → 文件','真实上传文件','筛选文件、保存、拖出、邀请'];
 await group.locator('#view-files').click();await shot(group,'files-view','文件视图');await group.locator('#view-all').click();
 await section('文件操作菜单',async()=>{await group.locator('.file-more summary').first().click();await shot(group,'file-menu','文件操作');await group.keyboard.press('Escape');});
 await section('图片草稿与预览',async()=>{
 const bytes=await readFile(path.join(root,'apps/desktop/assets/icon.png'));
 await group.evaluate(base64=>{const bytes=Uint8Array.from(atob(base64),c=>c.charCodeAt(0));const data=new DataTransfer();data.items.add(new File([bytes],'图标预览.png',{type:'image/png'}));document.querySelector('#message-input').dispatchEvent(new ClipboardEvent('paste',{bubbles:true,cancelable:true,clipboardData:data}));},bytes.toString('base64'));
 await group.locator('#image-drafts').waitFor({state:'visible'});await shot(group,'image-draft','图片草稿');await group.locator('#send-text').click();await group.locator('.file-thumbnail img').waitFor();await shot(group,'image-message','图片消息');await group.locator('.file-thumbnail').click();await group.locator('.image-preview-full').waitFor();await shot(group,'image-preview','图片预览');await close(group);
 });
 await section('成员与群设置',async()=>{await close(group);await group.locator('#members-button').click();await group.locator('#device-name').waitFor({state:'attached'});await shot(group,'members','成员与群设置');await group.getByText('群名称与伙伴',{exact:true}).click();await group.locator('#rename-group').scrollIntoViewIfNeeded();await shot(group,'members-settings','群设置下半页');await close(group);});
 await section('连接诊断',async()=>{await group.locator('#members-button').click();await group.locator('#connection-diagnostic').click();await shot(group,'diagnostic','连接诊断');await close(group);});
 await section('网络设置',async()=>{await menu(group,'network-settings');await group.locator('#apply-network').waitFor();await shot(group,'network','网络连接');await close(group);});
 await section('缓存与清理确认',async()=>{await menu(group,'storage-settings');await group.locator('.storage-stat').first().waitFor();await shot(group,'storage','存储与清理');await group.getByRole('button',{name:'清理接收缓存',exact:true}).click();await shot(group,'storage-confirm','清理确认');await close(group);});
 await section('解散群确认',async()=>{await group.locator('#members-button').click();await group.getByText('退出与移除',{exact:true}).click();await group.locator('#delete-group').click();await shot(group,'delete-confirm','解散群确认');await close(group);});
 await section('加入输入错误',async()=>{await menu(welcome,'join-group');await welcome.locator('#join-code').fill('123');await welcome.locator('#confirm-join-group').click();await welcome.locator('.task-error').waitFor({state:'visible'});await shot(welcome,'join-error','加入输入错误');await close(welcome);});
 await section('真实远端离线',async()=>{await peer.app.close();apps.splice(apps.indexOf(peer.app),1);await group.waitForFunction(()=>document.querySelector('#device-summary')?.textContent === '1 台设备在线',null,{timeout:5000}).catch(()=>uncovered.push({title:'离线人数收敛',reason:'远端进程退出后5秒内在线计数未变为1，截图保留真实状态。'}));await shot(group,'peer-offline','远端退出后的群聊','关闭另一测试实例，本机服务仍在线');await group.locator('#members-button').click();await group.locator('#connection-diagnostic').click();await shot(group,'offline-diagnostic','远端退出后诊断');await close(group);});
 await section('旧托管群主机文件',async()=>{const legacy=await launch('legacy',true);await connected(legacy.page);await legacy.page.locator('#file-input').setInputFiles({name:'托管测试说明.txt',mimeType:'text/plain',buffer:Buffer.from('独立旧托管模式测试文件')});await legacy.page.getByText('托管测试说明.txt',{exact:true}).waitFor();await menu(legacy.page,'storage-settings');await legacy.page.locator('.storage-file').first().waitFor();await shot(legacy.page,'legacy-storage','旧托管群文件列表');await legacy.page.locator('.storage-file input').first().check();await legacy.page.getByRole('button',{name:'清理所选主机文件',exact:true}).click();await shot(legacy.page,'legacy-clean-confirm','主机原件清理确认');await close(legacy.page);await legacy.page.locator('#members-button').click();if(await legacy.page.locator('#upgrade-group').count()){await legacy.page.locator('#upgrade-group').click();routes['legacy-upgrade-confirm']=['旧托管群设备 → 升级为多设备群','真实旧版托管群','确认或取消（未升级）'];await shot(legacy.page,'legacy-upgrade-confirm','升级为多设备群确认');await close(legacy.page);await legacy.page.locator('#members-button').click();}if(await legacy.page.locator('#secure-members').count()){await legacy.page.locator('#secure-members').click();routes['legacy-auth-confirm']=['旧托管群设备 → 升级设备授权','旧共享授权群','确认或取消（未升级）'];await shot(legacy.page,'legacy-auth-confirm','设备授权升级确认');}else uncovered.push({title:'旧共享授权升级',reason:'新建legacy测试群已使用每设备授权，当前客户端不显示升级入口；未篡改持久数据制造旧授权。'});});
 uncovered.push({title:'本机网卡断开、传输超时失败',reason:'未停用用户网络或注入假状态；远端退出按实际执行结果记录，本机网络中断未实测。'});
} catch(e){uncovered.push({title:'后续流程中断',reason:e.message});process.exitCode=1;}
finally {await atlas();for(const app of apps.reverse()){const timer=setTimeout(()=>app.process().kill('SIGKILL'),6000);try{await app.close();}catch{}finally{clearTimeout(timer);}}await rm(dir,{recursive:true,force:true});}
