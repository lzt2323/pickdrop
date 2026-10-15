import assert from 'node:assert/strict';
import { chromium } from 'playwright';
import { mkdtemp, rm, mkdir, writeFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import os from 'node:os';
import path from 'node:path';
import WebSocket from 'ws';
import { createGroupManager } from '../server/groups.js';

// This renders the production App.tsx with React Native Web. Native file and
// share APIs are covered separately; a browser run is not a device test.
const root = await mkdtemp(path.join(os.tmpdir(), 'pickdrop-mobile-ui-'));
const manager = await createGroupManager({ dataDir: root, host: '127.0.0.1', device: { id: randomUUID(), name: '我的电脑', kind: 'desktop' }, discoveryFactory: async () => ({ list: () => [], refresh() {}, close() {} }) });
const browser = await chromium.launch({ headless: true });
const page = await browser.newPage({ viewport: { width: 390, height: 844 }, reducedMotion: 'reduce' });
const errors = [], peers = [];
const galleryRoot = 'docs/archive/ui-concepts/2026-10-11/mobile-product';
const captures = [];
await mkdir(`${galleryRoot}/shots`, { recursive: true });
async function navigate(label) {
  // React Native Web portals append the active sheet after the home surface.
  await page.getByRole('tab', { name: label, exact: true }).last().click();
  if (label === '传输') await page.getByRole('heading', { name: '传输', exact: true }).waitFor();
  if (label === '我的') await page.getByLabel('设备名称', { exact: true }).waitFor();
  if (label === '群组') await page.getByRole('dialog').waitFor({ state: 'hidden' });
  assert.equal(await page.getByRole('tab', { name: label, exact: true }).last().getAttribute('aria-selected'), 'true', 'bottom navigation exposes its selected destination');
  assert.equal(await page.getByRole('dialog').count(), 0, 'main destinations are inline screens, not modal sheets');
}
async function capture(id, title, detail) {
  await page.screenshot({ path: `${galleryRoot}/shots/${id}.png` });
  if (!captures.some(item => item.id === id)) captures.push({ id, title, detail, viewport: page.viewportSize() });
}
async function writeGallery(report) {
  const escape = value => String(value).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  const limitations = ['运行生产 App.tsx 的 React Native Web，不是重新画的原型。', '连接本机真实测试群，消息、配对与审批经过实际服务端；示例文件用于测试。', '浏览器不支持原生建群、文件选择、相册保存、系统分享、相机权限、Android 图片粘贴和后台行为；这些仍需真机验证。', '传输和缓存的浏览器空态不代表真机能力已验证。'];
  await writeFile(`${galleryRoot}/coverage.json`, JSON.stringify({ ...report, captures, limitations }, null, 2));
  await writeFile(`${galleryRoot}/index.html`, `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>拾传 · 正式手机端页面</title><style>body{margin:0;background:#fff9f5;color:#493329;font:15px/1.6 system-ui,sans-serif}header,main,footer{max-width:1260px;margin:auto;padding:24px}h1{font-size:26px;margin:0 0 8px}p{margin:0;color:#6d5648}.grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(min(100%,280px),1fr));gap:24px}figure{margin:0;min-width:0}figure>a{display:block;border:1px solid #e7cbb5;border-radius:16px;overflow:hidden;background:#fff}img{display:block;width:100%;height:auto}figcaption{padding:12px 2px}h2{font-size:16px;margin:0 0 4px}small{color:#6d5648}a{color:inherit}footer{border-top:1px solid #e7cbb5}ul{padding-left:20px}nav{display:flex;flex-wrap:wrap;gap:14px;margin-top:16px}</style></head><body><header><h1>拾传 · 正式手机端</h1><p>来自真实页面的浏览器截图 · ${captures.length} 个页面与状态 · 自动化断言通过</p><nav><a href="coverage.json">验证记录</a><a href="../paw-desktop/preview.html">已批准原型</a><a href="http://localhost:8082">打开运行中的手机界面</a></nav></header><main class="grid">${captures.map(item => `<figure><a href="shots/${item.id}.png" target="_blank"><img src="shots/${item.id}.png" alt="${escape(item.title)}" loading="lazy"></a><figcaption><h2>${escape(item.title)}</h2><small>${escape(item.detail)} · ${item.viewport.width}×${item.viewport.height}</small></figcaption></figure>`).join('')}</main><footer><strong>覆盖边界</strong><ul>${limitations.map(item => `<li>${escape(item)}</li>`).join('')}</ul></footer></body></html>`);
}
page.on('pageerror', error => errors.push(error.message));
const poll = async predicate => {
  for (let attempt = 0; attempt < 100; attempt++) { const result = await predicate(); if (result) return result; await new Promise(resolve => setTimeout(resolve, 100)); }
  throw new Error('Timed out waiting for backend state');
};
async function api(group, route, options = {}) {
  const response = await fetch(group.baseUrl + route, { ...options, headers: { 'X-Room-Key': group.key, 'X-Device-Id': manager.device.id, ...options.headers } });
  assert.ok(response.ok); return response.json();
}
async function join(group, manual = false) {
  const invite = await manager.createInvite(group.id);
  await page.getByRole('button', { name: '加入群聊', exact: true }).click();
  await page.getByLabel('设备地址', { exact: true }).waitFor();
  assert.equal(await page.getByText('附近的传输群', { exact: true }).count(), 0);
  await page.screenshot({ path: 'artifacts/mobile-join-unified.png' });
  await capture('join-code', '邀请码加入', '真实地址、端口和邀请码表单');
  if (manual) {
    const endpoint = new URL(group.baseUrl);
    await page.getByLabel('设备地址', { exact: true }).fill(endpoint.hostname);
    await page.getByLabel('端口', { exact: true }).fill(endpoint.port);
    await page.getByLabel('6 位邀请码', { exact: true }).fill(invite.code);
  } else {
    await page.getByRole('button', { name: '邀请链接', exact: true }).click();
    await page.getByLabel('完整邀请链接', { exact: true }).fill(`${group.baseUrl}/#invite=${invite.code}&group=${group.id}`);
    await capture('join-link', '邀请链接加入', '填写测试服务端的真实邀请链接');
  }
  await page.getByRole('button', { name: '申请加入', exact: true }).click();
  const pending = await poll(async () => (await manager.listJoinRequests(group.id))[0]);
  await page.getByText('申请已发出', { exact: true }).waitFor();
  await capture('join-pending', '等待允许', '服务端记录待处理配对申请');
  await manager.respondJoin(group.id, pending.id, true);
  await page.getByRole('button', { name: '返回群列表' }).waitFor();
  await page.getByLabel('消息内容', { exact: true }).fill('手机已连接');
  await page.getByRole('button', { name: '发送消息', exact: true }).click();
  await poll(async () => (await api(group, '/api/state')).messages.some(message => message.text === '手机已连接'));
}
try {
  const first = await manager.createGroup('项目传输群'), second = await manager.createGroup('家里的传输群');
  const phonePeer = { id: randomUUID(), name: '小林', kind: 'android' };
  const peerInvite = await manager.createInvite(first.id);
  const peerRequest = await fetch(first.baseUrl + '/api/pair/request', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ code: peerInvite.code, device: phonePeer }) });
  const peerTicket = await peerRequest.json(); assert.ok(peerRequest.ok);
  await manager.respondJoin(first.id, peerTicket.requestId, true);
  const peerApprovalResponse = await fetch(`${first.baseUrl}/api/pair/status/${peerTicket.requestId}`, { headers: { 'X-Poll-Token': peerTicket.pollToken } });
  const peerApproval = await peerApprovalResponse.json(); assert.equal(peerApproval.status, 'approved');
  const peerKey = peerApproval.group.key;
  const peer = new WebSocket(`${first.baseUrl.replace('http:', 'ws:')}/api/events?key=${peerKey}&device=${phonePeer.id}`); peers.push(peer);
  await new Promise((resolve, reject) => { peer.once('open', resolve); peer.once('error', reject); });
  await api(first, '/api/messages', { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Device-Id': phonePeer.id, 'X-Room-Key': peerKey }, body: JSON.stringify({ text: '最新的资料放这里，手机上也能收。' }) });
  await api(first, '/api/files?name=' + encodeURIComponent('项目说明.pdf'), { method: 'POST', headers: { 'Content-Type': 'application/pdf' }, body: Buffer.from('%PDF-1.4\n% mobile UI fixture\n') });
  await api(first, '/api/files?name=' + encodeURIComponent('设计资源.zip'), { method: 'POST', body: Buffer.from('504b0506000000000000000000000000000000000000', 'hex') });
  await api(first, '/api/files?name=' + encodeURIComponent('图片预览.png'), { method: 'POST', headers: { 'Content-Type': 'image/png' }, body: Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAIAAAACCAIAAAD91JpzAAAAE0lEQVR4nGMImJYHRAwpq5qACAAmagXJ+JwBMgAAAABJRU5ErkJggg==', 'base64') });
  await page.goto(process.env.PICKDROP_MOBILE_WEB_URL || 'http://localhost:8082');
  await page.getByText('还没有群组', { exact: true }).waitFor();
  await mkdir('artifacts', { recursive: true });
  await page.screenshot({ path: 'artifacts/mobile-welcome.png' });
  await capture('welcome', '首次打开', '无群组的正式应用空态');
  await page.getByRole('button', { name: '扫码加入', exact: true }).waitFor();
  await page.getByRole('button', { name: '加入群聊', exact: true }).waitFor();
  await navigate('传输');
  await page.getByText('还没有传输记录', { exact: true }).waitFor();
  await capture('transfers-empty', '传输', '全群真实传输队列空态');
  await navigate('我的');
  await page.getByLabel('设备名称', { exact: true }).waitFor();
  assert.equal(await page.getByRole('button', { name: '清理缓存', exact: true }).isDisabled(), true, 'browser must not pretend to clear native storage');
  await capture('profile', '我的与缓存', '设备名称与原生缓存入口，浏览器清理被禁用');
  await navigate('群组');
  await page.getByRole('button', { name: '创建群聊', exact: true }).click();
  await capture('create', '新建群组', '正式创建面板与动物选择');
  await page.getByRole('button', { name: '返回', exact: true }).click();
  await join(first);
  await page.getByText('项目说明.pdf', { exact: true }).waitFor();
  await page.getByText('项目说明.pdf', { exact: true }).scrollIntoViewIfNeeded();
  await page.screenshot({ path: 'artifacts/mobile-group.png' });
  await capture('chat', '群消息', '真实文本与 PDF、ZIP、图片消息');
  await page.getByLabel('消息内容', { exact: true }).fill('文件筛选保留草稿');
  await page.getByTestId('chat-tab-files').click();
  assert.match(await page.getByTestId('chat-tab-files').textContent(), /文件\s*3/);
  assert.equal(await page.getByText('手机已连接', { exact: true }).count(), 0, 'file view filters text');
  assert.equal(await page.getByText('项目说明.pdf', { exact: true }).count(), 1);
  assert.equal(await page.getByText('设计资源.zip', { exact: true }).count(), 1);
  assert.equal(await page.getByText('图片预览.png', { exact: true }).count(), 1);
  assert.equal(await page.getByLabel('消息内容', { exact: true }).inputValue(), '文件筛选保留草稿');
  await page.getByText('项目说明.pdf', { exact: true }).scrollIntoViewIfNeeded();
  await capture('files', '文件页签', '筛选真实 3 个文件，保留未发送文字');
  await page.getByTestId('chat-tab-messages').click();
  await page.getByText('手机已连接', { exact: true }).waitFor();
  await page.getByRole('button', { name: '邀请 +', exact: true }).click();
  await page.getByRole('button', { name: '复制邀请信息', exact: true }).waitFor();
  await page.waitForFunction(() => { const node = document.querySelector('[data-testid="invite-address"]'); return node && node.textContent !== '—'; });
  await capture('invite', '邀请设备', '服务端生成的邀请码与实际地址');
  await page.getByRole('button', { name: '返回', exact: true }).click();
  // Browser previews deliberately expose a native-only placeholder; file menus
  // still exercise the same production component and separate responders.
  await page.getByText('在手机客户端中预览', { exact: true }).waitFor();
  await page.getByRole('button', { name: '图片预览.png，更多操作', exact: true }).click();
  await page.getByRole('button', { name: '保存到相册', exact: true }).waitFor();
  await page.getByRole('button', { name: '保存到文件', exact: true }).waitFor();
  await page.getByRole('button', { name: '分享给其他应用', exact: true }).waitFor();
  await page.screenshot({ path: 'artifacts/mobile-file-menu.png' });
  await capture('image-actions', '图片操作', '相册、文件和分享入口；原生操作未执行');
  await page.getByRole('button', { name: '返回', exact: true }).click();
  await page.getByRole('button', { name: '项目说明.pdf，更多操作', exact: true }).click();
  assert.equal(await page.getByRole('button', { name: '保存到相册', exact: true }).count(), 0);
  await capture('file-actions', '文件操作', 'PDF 操作不提供相册保存');
  await page.getByRole('button', { name: '保存到文件', exact: true }).waitFor();
  await page.getByRole('button', { name: '返回', exact: true }).click();
  await page.getByLabel('消息内容', { exact: true }).fill('这份草稿属于项目群');
  await page.getByRole('button', { name: '返回群列表' }).click();
  await join(second, true);
  await page.getByTestId('chat-tab-files').click();
  await page.getByText('还没有文件', { exact: true }).waitFor();
  await capture('files-empty', '文件空态', '第二个群只有文字消息，没有文件');
  await page.getByTestId('chat-tab-messages').click();
  assert.equal(await page.getByText('项目说明.pdf', { exact: true }).count(), 0);
  await page.getByRole('button', { name: '返回群列表' }).click();
  await page.getByRole('button', { name: '打开项目传输群', exact: true }).click();
  assert.equal(await page.getByLabel('消息内容', { exact: true }).inputValue(), '这份草稿属于项目群');
  await page.getByRole('button', { name: '返回群列表' }).click();
  await capture('groups', '我的群组', '两个已配对群的真实消息摘要');
  await navigate('传输');
  await navigate('我的');
  await navigate('群组');
  await page.getByRole('button', { name: '打开项目传输群', exact: true }).click();
  assert.equal(await page.getByLabel('消息内容', { exact: true }).inputValue(), '这份草稿属于项目群', 'bottom navigation preserves per-group draft');
  // Reusing a consumed invitation to this paired group needs no new approval
  // and must leave the per-group text draft intact.
  await page.getByRole('button', { name: '返回群列表' }).click();
  await page.getByRole('button', { name: '加入群聊', exact: true }).click();
  await page.getByRole('button', { name: '邀请链接', exact: true }).click();
  await page.getByLabel('完整邀请链接', { exact: true }).fill(`${first.baseUrl}/#invite=000000&group=${first.id}`);
  await page.getByRole('button', { name: '申请加入', exact: true }).click();
  await page.getByRole('button', { name: '返回群列表' }).waitFor();
  assert.equal(await page.getByLabel('消息内容', { exact: true }).inputValue(), '这份草稿属于项目群');
  assert.equal((await manager.listJoinRequests(first.id)).length, 0);
  // Approve a new device from the mobile member sheet.
  const invitation = await manager.createInvite(first.id);
  const request = await fetch(first.baseUrl + '/api/pair/request', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ code: invitation.code, device: { id: randomUUID(), name: '小周的手机', kind: 'ios' } }) });
  const ticket = await request.json(); assert.equal(ticket.status, 'pending');
  await page.getByRole('button', { name: '查看群成员' }).click();
  await page.getByText('小周的手机 申请加入', { exact: true }).waitFor();
  await capture('member-approval', '设备与加入申请', '服务端真实待审批设备');
  await page.getByRole('button', { name: '允许加入', exact: true }).click();
  await poll(async () => (await api(first, '/api/state')).devices.some(device => device.name === '小周的手机'));
  await page.getByRole('button', { name: '返回', exact: true }).click();
  await page.setViewportSize({ width: 320, height: 568 });
  const bounds = await page.getByLabel('消息内容', { exact: true }).boundingBox();
  assert.ok(bounds && bounds.width >= 100 && bounds.y + bounds.height <= 568);
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
  await page.screenshot({ path: 'artifacts/mobile-small.png' });
  await capture('chat-small', '窄屏会话', '320px 输入区可见且无横向溢出');
  await page.getByLabel('消息内容', { exact: true }).fill('小屏幕发送成功');
  await page.getByRole('button', { name: '发送消息', exact: true }).click();
  await poll(async () => (await api(first, '/api/state')).messages.some(message => message.text === '小屏幕发送成功'));
  // Resize the same paired conversation: no mock data or additional backend.
  for (const width of [375, 414, 768]) {
    await page.setViewportSize({ width, height: 812 });
    const inputBounds = await page.getByLabel('消息内容', { exact: true }).boundingBox();
    assert.ok(inputBounds && inputBounds.width >= 100 && inputBounds.y + inputBounds.height <= 812, `composer visible at ${width}px`);
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false, `no horizontal overflow at ${width}px`);
    await capture(`chat-${width}`, `${width}px 会话`, '同一真实会话，验证左右对话与输入区');
  }
  // The link field must accept the former #key= invitation just like QR scan.
  await page.getByRole('button', { name: '返回群列表' }).click();
  await page.getByRole('button', { name: '加入群聊', exact: true }).click();
  await page.getByRole('button', { name: '邀请链接', exact: true }).click();
  await page.getByLabel('完整邀请链接', { exact: true }).fill(`${first.baseUrl}/#key=${'0'.repeat(64)}`);
  const legacyProbe = page.waitForRequest(request => request.url() === `${first.baseUrl}/api/group/probe`);
  await page.getByRole('button', { name: '申请加入', exact: true }).click();
  await legacyProbe;
  await page.getByRole('button', { name: '返回', exact: true }).click();
  // Editing a pasted HTTPS invitation must retain its scheme when the
  // three-field form rebuilds the URL after an invitation code change.
  await page.getByRole('button', { name: '加入群聊', exact: true }).click();
  await page.getByLabel('设备地址', { exact: true }).fill('https://127.0.0.1:9/#invite=123456');
  await page.getByLabel('6 位邀请码', { exact: true }).fill('654321');
  const secureRequest = page.waitForRequest(request => request.url() === 'https://127.0.0.1:9/api/peer/info');
  await page.getByRole('button', { name: '申请加入', exact: true }).click();
  await secureRequest;
  await page.getByRole('button', { name: '返回', exact: true }).click();
  await page.getByRole('button', { name: '加入群聊', exact: true }).click();
  await page.getByLabel('设备地址', { exact: true }).fill('https://127.0.0.1:9');
  await page.getByLabel('6 位邀请码', { exact: true }).fill('123456');
  await page.getByLabel('设备地址', { exact: true }).blur();
  assert.equal(await page.getByLabel('设备地址', { exact: true }).inputValue(), 'https://127.0.0.1');
  assert.equal(await page.getByLabel('端口', { exact: true }).inputValue(), '9');
  const manualSecureRequest = page.waitForRequest(request => request.url() === 'https://127.0.0.1:9/api/peer/info');
  await page.getByRole('button', { name: '申请加入', exact: true }).click();
  await manualSecureRequest;
  await page.getByRole('button', { name: '返回', exact: true }).click();
  assert.deepEqual(errors, []);
  const report = { runtime: 'React Native Web, not a physical device', pairing: ['invitation link', 'address and code'], imagePreviewPlaceholder: true, separateFileMenus: true, realServer: true, groupIsolation: true, perGroupTextDraft: true, pairedLinkReconnect: true, memberApproval: true, bottomNavigation: true, realFileFilter: true, fileFilterDraftRetained: true, navigationDraftRetained: true, navigationSelection: true, fileCount: '3 actual loaded files', narrowScreen: '320x568', responsiveWidths: [320, 375, 414, 768], errors };
  await writeFile('artifacts/mobile-ui-smoke.json', JSON.stringify(report, null, 2));
  await writeGallery(report);
  console.log('Mobile UI smoke passed: actual App.tsx, real pairing/approval, two groups, drafts, text, narrow layout.');
} finally {
  for (const peer of peers) peer.terminate();
  await browser.close(); await manager.close(); await rm(root, { recursive: true, force: true });
}
