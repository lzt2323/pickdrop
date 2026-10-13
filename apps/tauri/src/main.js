import { icon } from './icons.js';
import './style.css';
import packageInfo from '../package.json';
import { createDialogMotion } from './dialog-motion.js';
import { call, native, subscribe, subscribeWindow, subscribeBack, subscribeIncoming, copyText, scanInvite } from './bridge.js';
import { PAGE_SIZE, MAX_VISIBLE, mergeMessages, formatBytes, progressScheduler, parseInvite } from './model.js';
import QRCode from 'qrcode';
const $ = id => document.getElementById(id);
const animals = ['cat', 'sheep', 'monkey', 'dog', 'chick', 'lizard', 'alpaca', 'rabbit', 'otter', 'capybara'];
const names = ['小猫', '绵羊', '小猴', '小狗', '小鸡', '小蜥蜴', '羊驼', '小兔', '水獭', '卡皮巴拉'];
const app = { groups: [], device: {}, groupId: null, state: null, messages: [], rows: new Map(), drafts: new Map(), transfers: new Map(), files: new Map(), filter: 'all', historyCursors: [], historical: false, fileDrafts: new Map(), generation: 0, refreshTimer: null, disposed: false };
const el = (tag, className, text) => { const node = document.createElement(tag); if (className)
    node.className = className; if (text != null)
    node.textContent = text; return node; };
function button(text, action, className) { const node = el('button', className, text); node.type = 'button'; if (text) node.setAttribute('aria-label', text); node.addEventListener('click', () => run(action, node)); return node; }
try {
    for (const [id, text] of Object.entries(JSON.parse(localStorage.getItem('pickdrop.drafts.v1') || '{}')))
        app.drafts.set(id, text);
}
catch { }
try {
    app.pendingIncoming = JSON.parse(localStorage.getItem('pickdrop.incoming.v1') || '[]');
    for (const [id, files] of Object.entries(JSON.parse(localStorage.getItem('pickdrop.file-drafts.v1') || '{}')))
        app.fileDrafts.set(id, files);
}
catch { }
function persistFiles() { try {
    localStorage.setItem('pickdrop.file-drafts.v1', JSON.stringify(Object.fromEntries(app.fileDrafts)));
    localStorage.setItem('pickdrop.incoming.v1', JSON.stringify(app.pendingIncoming || []));
}
catch { } }
let draftTimer;
function persistDrafts() { try {
    localStorage.setItem('pickdrop.drafts.v1', JSON.stringify(Object.fromEntries(app.drafts)));
}
catch { } }
let toastTimer;
function toast(text) { $('toast').textContent = text; $('toast').hidden = false; clearTimeout(toastTimer); toastTimer = setTimeout(() => $('toast').hidden = true, 4000); }
function error(error) { toast(typeof error === 'string' ? error : error?.message || String(error)); }
async function run(action, control) { const restoreFocus = control === document.activeElement; if (control)
    control.disabled = true; try {
    return await action();
}
catch (e) {
    if ($('panel').open) { const invalid = $('panel-body').querySelector('[aria-invalid=true]'); const host = invalid?.closest('label') || $('panel-body'); let problem = host.querySelector('.panel-error'); if (!problem) { problem = el('p', invalid ? 'panel-error field-error' : 'panel-error'); problem.id = `panel-error-${panelGeneration}`; problem.setAttribute('role','alert'); host.append(problem); } problem.textContent = e?.message || String(e); if (invalid) invalid.setAttribute('aria-describedby', problem.id); }
    else error(e);
}
finally {
    if (control)
        control.disabled = !!app.state?.membershipRevoked&&['send-text','choose-file','invite-button'].includes(control.id);
    if (restoreFocus && control?.isConnected && !control.disabled && document.activeElement === document.body && (!$('panel').open || $('panel').contains(control))) control.focus();
} }
let panelReturnFocus, panelGeneration = 0;
const dialogMotion = createDialogMotion($('panel'));
// Primary actions stay outside the scrolling content, including async QR content.
new MutationObserver(() => {
    const focused = document.activeElement;
    for (const action of $('panel-body').querySelectorAll(':scope > button.primary')) $('panel-actions').append(action);
    $('panel-actions').hidden = !$('panel-actions').childElementCount;
    if ($('panel').open && focused?.isConnected && $('panel-actions').contains(focused) && document.activeElement === document.body) focused.focus();
}).observe($('panel-body'), { childList:true });
function panelActions(...actions) { $('panel-actions').append(...actions); $('panel-actions').hidden = false; }

function panel(title) { panelGeneration++; if (!$('panel').open) panelReturnFocus = document.activeElement; $('panel').dataset.kind = title.includes('文件') ? 'files' : 'settings'; $('panel').setAttribute('aria-labelledby','panel-title'); if (document.body.dataset.desktop === 'true')
    run(() => native('window_action', { action: 'busy', value: true })); $('panel-title').textContent = title; parkQueue(); $('panel-body').replaceChildren(); $('panel-actions').replaceChildren(); $('panel-actions').hidden = true; dialogMotion.open({animate: !['我的群组','传输'].includes(title)}); queueMicrotask(() => { if($('panel').open) ($('panel-body').querySelector('input,textarea,button') || $('close-panel')).focus(); }); return $('panel-body'); }
let fieldSequence = 0;
function field(body, title, value = '', type = 'text') { const label = el('label'), caption = el('span', 'field-label', title), input = el('input'); caption.id = `field-label-${++fieldSequence}`; input.setAttribute('aria-labelledby', caption.id); label.append(caption); input.type = type; input.value = value; input.addEventListener('input', () => { input.removeAttribute('aria-invalid'); input.removeAttribute('aria-describedby'); label.querySelector('.panel-error')?.remove(); }); label.append(input); body.append(label); return input; }
function note(body, text) { body.append(el('p', 'muted', text)); }
function closePanel() { clearTimeout(joinTimer); dialogMotion.close(); }
$('close-panel').onclick = closePanel;
$('panel').addEventListener('click', e => { if (e.target === $('panel')) {
    const r = $('panel').getBoundingClientRect();
    if (e.clientX < r.left || e.clientX > r.right || e.clientY < r.top || e.clientY > r.bottom)
        closePanel();
} });
function asset(id) { return `/assets/group-animals/${animals.includes(id) ? id : 'cat'}.png`; }
let windowAnimal;
function updateHeader() {const revoked=!!app.state?.membershipRevoked;$('membership-notice').hidden=!revoked;for(const id of ['send-text','choose-file','invite-button'])$(id).disabled=revoked; const group = app.groups.find(g => g.id === app.groupId) || app.state; if (document.body.dataset.desktop === 'true' && windowAnimal !== (group?.animalId || 'cat')) { windowAnimal = group?.animalId || 'cat'; native('window_animal', { animalId: windowAnimal }).catch(error); } $('group-name').textContent = group?.name || '拾传'; $('group-animal').src = group ? asset(group.animalId) : '/assets/app-icon.svg'; $('composer').hidden = !app.groupId; document.body.dataset.hasGroup = String(!!app.groupId); const devices = app.state?.devices || []; $('device-summary').textContent = app.groupId ? `${devices.filter(d => d.online || d.id === app.device.id).length} 台设备在线` : '成员'; $('members-button').title = devices.map(d => d.id === app.device.id ? '我' : d.name || '设备').join('、') || '本群成员与设备'; const status = $('connection-status'); if (status) { const online = devices.filter(d => d.online || d.id === app.device.id).length; status.textContent = online > 1 ? '已连接' : '等待连接'; status.classList.toggle('offline', online === 0); } if ($('file-count')) $('file-count').textContent = app.messages.filter(m => m.type === 'file').length; }
function messageVersion(m) { return JSON.stringify([m.type, m.text, m.fileName, m.size, m.deleted, m.available, m.localPath, m.path]); }
const thumbnails = new IntersectionObserver(entries => { for (const entry of entries)
    if (entry.isIntersecting) {
        thumbnails.unobserve(entry.target);
        const img = entry.target, path = img.dataset.path;
        native('native_thumbnail', { path }).then(src => { if (img.isConnected)
            img.src = src; }).catch(() => img.remove());
    } }, { root: $('timeline'), rootMargin: '150px' });
function rowFor(m) { const row = el('article', 'message'); row.dataset.messageId = m.id; row.classList.toggle('mine', m.deviceId === app.device.id || m.senderId === app.device.id); const time = new Date(m.createdAt || m.timestamp || Date.now()); row.append(el('div', 'message-meta', `${m.deviceName || m.senderName || '设备'} · ${time.toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' })}`)); if (m.deleted) {
    row.append(el('div', 'bubble', '消息已删除'));
    return row;
} if (m.type === 'text' || m.text != null) {
    const bubble = el('div', 'bubble', m.text);
    bubble.title = '双击复制文字';
    bubble.ondblclick = () => run(async () => { await copyText(m.text); toast('文字已复制'); });
    row.append(bubble); const copy = button('复制', async () => { await copyText(m.text); toast('文字已复制'); }, 'message-copy'); copy.setAttribute('aria-label', '复制消息'); copy.replaceChildren(icon('copy')); row.append(copy);
}
else {
    const card = el('div', 'file-card');
    const name = m.fileName || m.name || m.file?.name || '文件';
    const heading = el('div', 'file-heading'), glyph = el('div', 'file-icon'), details = el('div', 'file-copy'); glyph.append(icon(/\.(png|jpg|jpeg|webp|gif)$/i.test(name) ? 'image' : 'file')); details.append(el('div', 'file-name', name), el('div', 'file-size', formatBytes(m.size || m.fileSize || m.file?.size))); heading.append(glyph, details); card.append(heading);
    const actions = el('div', 'file-actions');
    const local = app.files.get(m.id) || m.localPath || m.path;
    if (local) {
        if (document.body.dataset.desktop === 'true') {
            card.draggable = true;
            card.addEventListener('dragstart', event => { event.preventDefault(); run(() => native('native_drag_file', { path: local, suggestedName: name })); });

        }
        actions.append(button('保存', () => native('native_save_file', { sourcePath: local, suggestedName: name })), button('更多', () => fileActionsPanel(local, name), 'file-more'));
        if (/\.(png|jpg|jpeg|webp|gif)$/i.test(name)) {
            const img = el('img', 'thumbnail');
            img.alt = name;
            img.loading = 'lazy';
            img.dataset.path = local;
            card.append(img);
            thumbnails.observe(img);
            img.tabIndex = 0; img.setAttribute('role', 'button'); img.onclick = () => imagePanel(local, name, img.src); img.onkeydown = e => { if(e.key === 'Enter' || e.key === ' ') { e.preventDefault(); imagePanel(local, name, img.src); } };
        }
    }
    else
        actions.append(button('接收文件', () => receive(m)));
    card.append(actions);
    row.append(card);
} return row; }
function imagePanel(path, name, source) { const body = panel(name); $('panel').dataset.kind = 'image'; const image = el('img', 'image-preview'); image.alt = name; image.src = source; body.append(image); panelActions(button('打开原图', () => native('native_open_file', { path, suggestedName: name })), button('保存', () => native('native_save_file', { sourcePath: path, suggestedName: name })), button('更多', () => fileActionsPanel(path,name))); }
function fileActionsPanel(path, name) { const body = panel(name); body.append(button('打开', () => native('native_open_file', { path, suggestedName: name })), button('另存为', () => native('native_save_file', { sourcePath: path, suggestedName: name })), button('分享', () => native('native_share_file', { path, suggestedName: name }))); if (!isMobile()) body.append(button('拖出文件', () => native('native_drag_file', { path, suggestedName: name }))); if (isMobile() && /\.(png|jpg|jpeg|webp|gif)$/i.test(name)) body.append(button('保存到相册', () => native('native_save_gallery', { path, suggestedName: name }))); }
function renderMessages() { const timeline = $('timeline'), nearBottom = timeline.scrollHeight - timeline.scrollTop - timeline.clientHeight < 100; const visible = app.messages.filter(m => app.filter !== 'files' || m.type === 'file'); const keep = new Set(visible.map(m => m.id)); for (const [id, record] of app.rows) {
    if (!keep.has(id)) {
        record.node.querySelectorAll('img').forEach(img => thumbnails.unobserve(img));
        record.node.remove();
        app.rows.delete(id);
    }
} let cursor = $('messages').firstChild; for (const m of visible) {
    const version = messageVersion(m) + (app.files.get(m.id) || '');
    let record = app.rows.get(m.id);
    if (!record || record.version !== version) {
        const node = rowFor(m);
        if (record) {
            record.node.querySelectorAll('img').forEach(img => thumbnails.unobserve(img));
            const previous=record.node;previous.replaceWith(node);if(cursor===previous)cursor=node;
        }
        record = { node, version };
        app.rows.set(m.id, record);
    }
    if (record.node !== cursor)
        $('messages').insertBefore(record.node, cursor);
    cursor = record.node.nextSibling;
} $('empty').hidden = visible.length > 0; $('empty').textContent = app.groupId ? (app.filter === 'files' ? '这里还没有文件' : '还没有消息') : '还没有群组'; if (!app.groupId) $('empty').append(button('创建群组',createPanel,'primary'),button('加入群组',joinPanel)); $('load-history').hidden = !app.state?.history?.hasMore; $('newer-history').hidden = !app.historical; $('latest-history').hidden = !app.historical; if (nearBottom)
    timeline.scrollTop = timeline.scrollHeight; }
async function refresh({ older = false, newer = false, latest = false } = {}) { if (!app.groupId || app.disposed)
    return; const groupId = app.groupId, generation = app.generation; const params = { groupId, limit: PAGE_SIZE }; if (older) {
    const cursor = app.state?.history?.before ?? app.messages[0]?.sequence;
    if (cursor == null)
        return;
    app.historyCursors.push(app.currentBefore ?? null);
    params.before = cursor;
}
else if (newer) {
    const cursor = app.historyCursors.pop();
    if (cursor != null)
        params.before = cursor;
}
else if (!latest && app.historical) {
    params.before = app.currentBefore;
} if (latest)
    app.historyCursors = []; const state = await call('get_state', params); if (generation !== app.generation || groupId !== app.groupId)
    return; if (!older && !newer && !latest && app.state?.revision === state.revision && app.state?.cacheRevision === state.cacheRevision && app.state?.presenceRevision === state.presenceRevision && state.revision != null)
    return; if (!older && !newer && !latest && app.state?.revision === state.revision && app.state?.cacheRevision === state.cacheRevision) {
    app.state = state;
    updateHeader();
    return;
} app.currentBefore = params.before ?? null; app.historical = params.before != null; app.state = state; app.messages = (older || newer || latest) ? mergeMessages([], state.messages || []) : mergeMessages(app.messages, state.messages || []); renderMessages(); updateHeader(); }
async function loadBootstrap() { const boot = await call('bootstrap'); app.device = boot.device || {}; app.groups = boot.groups || []; app.endpoint = boot.endpoint; return boot; }
async function selectGroup(id) { document.body.dataset.view = 'chat'; if ($('mobile-home')) $('mobile-home').hidden = true; if (app.groupId)
    app.drafts.set(app.groupId, $('message-input').value); app.generation++; app.groupId = id; app.state = null; app.historyCursors = []; app.currentBefore = null; app.historical = false; app.messages = []; for(const record of app.rows.values()) record.node.querySelectorAll('img').forEach(img => thumbnails.unobserve(img)); app.rows.clear(); $('messages').replaceChildren(); $('message-input').value = app.drafts.get(id) || ''; updateHeader(); renderMessages(); renderFileDrafts(); syncComposerHeight(); if (id) {
    await call('select_group', { id });
    await refresh();
} closePanel(); if (app.pendingIncoming?.length)
    incomingPanel(); }
function groupsPanel() { const body = panel('我的群组'); for (const group of app.groups) {
    const b = button(group.name, () => selectGroup(group.id), 'group-option');
    const img = el('img');
    img.src = asset(group.animalId);
    img.alt = '';
    b.prepend(img);
    body.append(b);
} body.append(button('创建群组', createPanel, 'primary'), button('加入群组', joinPanel), ...(/Android|iPhone|iPad/i.test(navigator.userAgent) ? [button('扫描邀请二维码', async () => joinPanel(await scanInvite()))] : [])); }
function createPanel() { const body = panel('创建群组'), name = field(body, '群组名称', '拾传群'); let animalId = animals[app.groups.length % animals.length]; const grid = el('div', 'animal-picker'); animals.forEach((id, i) => { const b = button('', () => { animalId = id; grid.querySelectorAll('button').forEach(x => x.setAttribute('aria-pressed', String(x === b))); }); b.setAttribute('aria-label', names[i]); b.setAttribute('aria-pressed', String(id === animalId)); const img = el('img'); img.src = asset(id); img.alt = ''; b.append(img); grid.append(b); }); body.append(grid, button('创建', async () => { if (!name.value.trim())
    { name.setAttribute('aria-invalid','true'); name.focus(); throw Error('请输入群组名称'); } const group = await call('create_group', { name: name.value.trim(), animalId }); await loadBootstrap(); await selectGroup(group.id); }, 'primary')); }
function joinPanel(invite = '') {
    const body = panel('加入群组');
    const link = field(body, '邀请链接', invite); link.placeholder = '粘贴邀请链接';
    const code = field(body, '邀请码'); code.inputMode = 'numeric'; code.autocomplete = 'one-time-code'; code.className = 'invite-code';
    const addressRow = el('div', 'address-row'); body.append(addressRow);
    const address = field(addressRow, '设备地址'), port = field(addressRow, '端口'); port.inputMode = 'numeric';
    const parse = value => { const parsed = parseInvite(value); if (!parsed) return; code.value = parsed.code; try { const u = new URL(parsed.address); address.value = `${u.protocol}//${u.hostname}`; port.value = u.port; } catch { address.value = parsed.address; } };
    parse(invite); link.addEventListener('input', () => parse(link.value));
    const nearby = el('div', 'stack'); body.append(nearby);
    body.append(button('查找附近群组', async () => { const groups = await call('discover_groups'); nearby.replaceChildren(); for (const group of groups) nearby.append(button(group.name, () => { address.value = group.baseUrl; port.value = ''; code.focus(); })); if (!groups.length) note(nearby, '未发现附近群组'); }));
    if (isMobile()) body.append(button('扫描二维码', async () => joinPanel(await scanInvite())));
    body.append(button('申请加入', async () => {
        let endpoint = address.value.trim(); if (!/^https?:\/\//i.test(endpoint)) endpoint = `http://${endpoint}`;
        if (port.value.trim()) { const u = new URL(endpoint); u.port = port.value.trim(); endpoint = u.origin; }
        const result = await call('join_group', { address: endpoint, code: code.value.trim() });
        if (result.group || result.status === 'approved') { await loadBootstrap(); return selectGroup(result.group?.id || result.groupId); }
        joinWaiting(result.ticket || result);
    }, 'primary'));
}
let joinTimer;
function joinWaiting(ticket) { const body = panel('等待加入确认'), generation = panelGeneration; note(body, '申请已发送，请在群内设备上允许加入。'); clearTimeout(joinTimer); const check = async () => { if (generation !== panelGeneration || !$('panel').open)
    return; try {
    const result = await call('check_join', { ticket }); if(generation !== panelGeneration || !$('panel').open)return;
    if (result.group || result.status === 'approved') {
        await loadBootstrap();
        await selectGroup(result.group?.id || app.groups.at(-1)?.id);
        return;
    }
    if (result.status === 'denied') {
        note(body, '加入申请被拒绝。');
        return;
    }
    joinTimer = setTimeout(check, 2000);
}
catch (e) {
    error(e);
} }; joinTimer = setTimeout(check, 2000); }
async function invitePanel() { if (!app.groupId)
    return groupsPanel(); const body = panel('邀请设备'), generation = panelGeneration; note(body, '正在生成邀请…'); const invitation = await call('create_invite', { groupId: app.groupId }); if(generation !== panelGeneration || !$('panel').open) return; body.replaceChildren(); const link = invitation.url || invitation.link || `pickdrop://join?address=${encodeURIComponent(invitation.address || invitation.baseUrl || app.endpoint?.baseUrl || '')}&code=${encodeURIComponent(invitation.code || '')}`; if (!$('panel').open || $('panel-body') !== body || $('panel-title').textContent !== '邀请设备') return; const img = el('img', 'qr'); img.alt = '加入群组二维码'; img.src = await QRCode.toDataURL(link, { width: 440, margin: 2 }); if(generation !== panelGeneration || !$('panel').open) return; body.append(img); field(body, '设备地址', invitation.address || invitation.baseUrl || app.endpoint?.baseUrl || '').readOnly = true; field(body, '邀请码', invitation.code || '').readOnly = true; body.append(button('复制邀请链接', async () => { await copyText(link); toast('邀请链接已复制'); }, 'primary'));  }
async function membersPanel() { if (!app.groupId)
    return groupsPanel(); const body = panel('成员与加入申请'), generation = panelGeneration; const requests = await call('list_join_requests', { groupId: app.groupId }); if (generation !== panelGeneration || !$('panel').open || $('panel-title').textContent !== '成员与加入申请') return; const pending = Array.isArray(requests) ? requests : requests.requests || []; if (pending.length) body.append(el('h3','member-heading','加入申请')); for (const request of pending) {
    const row = el('div', 'member member-request'), actions = el('div','member-actions');
    row.append(el('span', null, request.device?.name || request.deviceName || request.name || '新设备')); actions.append(button('允许', async () => { await call('respond_join', { groupId: app.groupId, id: request.id, allow: true }); await membersPanel(); }, 'primary'), button('拒绝', async () => { await call('respond_join', { groupId: app.groupId, id: request.id, allow: false }); await membersPanel(); }, 'danger')); row.append(actions);
    body.append(row);
} body.append(el('h3','member-heading','群内设备')); for (const device of app.state?.devices || []) {
    const row = el('div', 'member');
    row.append(el('span', null, `${device.name || device.id}${device.id === app.device.id ? '（本机）' : device.online ? '（在线）' : '（离线）'}`));
    if (isOwner() && device.id !== app.device.id)
        row.append(button('移除', async () => { await confirmPanel('移除成员', `移除 ${device.name || '此设备'}？`, async () => { await call('remove_member', { groupId: app.groupId, deviceId: device.id }); await refresh(); await membersPanel(); }); }));
    body.append(row);
} if (!body.childNodes.length)
    note(body, '暂无成员或加入申请。');
    body.append(button('手动连接已有设备', connectPeerPanel));
}
function connectPeerPanel() {
    const groupId = app.groupId;
    if (!groupId) return groupsPanel();
    const body = panel('连接已有设备');

    const address = field(body, '另一台设备地址', '', 'url');
    address.autocapitalize = 'off'; address.spellcheck = false;
    const status = el('p', 'muted'); status.setAttribute('role', 'status');
    body.append(status, button('连接设备', async () => {
        status.classList.remove('panel-error','field-error'); address.removeAttribute('aria-describedby'); status.setAttribute('role', 'status'); status.textContent = '正在连接并验证设备…';
        address.removeAttribute('aria-invalid');
        try {
            await call('connect_peer', { groupId, address: address.value.trim() });
            await refresh(); status.textContent = '设备已连接';
        } catch (e) {
            status.setAttribute('role', 'alert');
            status.textContent = `连接失败：${e?.message || String(e)}。请确认对方应用在前台，并检查设备地址。`;
            address.setAttribute('aria-invalid', 'true'); address.focus();
        }
    }, 'primary'));
}
async function confirmPanel(title, text, action, { confirmLabel = title, destructive = true } = {}) { const body = panel(title); note(body, text); panelActions(button('取消', closePanel), button(confirmLabel, action, destructive ? 'primary destructive' : 'primary')); }
function isMobile() { return document.body.dataset.desktop !== 'true'; }
function isOwner() { return app.groups.find(g => g.id === app.groupId)?.creatorDeviceId === app.device.id; }
function settingsPanel() {
    const body = panel('设置');
    body.append(button('存储与缓存', storagePanel, 'setting-row'));
    const deviceName = field(body, '本机名称', app.device.name || '');
    body.append(button('保存设备名称', async () => { if (!deviceName.value.trim()) throw Error('请输入设备名称'); await call('rename_device', { name: deviceName.value.trim() }); await loadBootstrap(); updateHeader(); toast('已保存'); }, 'primary'));
    if (app.groupId) body.append(button('群组设置', groupSettingsPanel, 'setting-row'), button('成员', membersPanel, 'setting-row'));
    if (!isMobile()) {
        const dock = el('div', 'stack');
        for (const [action, label] of [['dock-left', '贴到左侧'], ['dock-right', '贴到右侧'], ['dock-top', '贴到顶部'], ['undock', '取消贴边']]) dock.append(button(label, () => native('window_action', { action })));
        body.append(el('h3', 'section-title', '窗口'), dock);
    }
    body.append(el('p', 'version', `拾传 ${packageInfo.version}`));
}
function groupSettingsPanel() {
    const body = panel('群组设置');
    if (isOwner()) {
        const groupName = field(body, '群组名称', app.state?.name || '');
        body.append(button('保存群组名称', async () => { if (!groupName.value.trim()) throw Error('请输入群组名称'); await call('rename_group', { groupId: app.groupId, name: groupName.value.trim() }); await loadBootstrap(); await refresh(); toast('已保存'); }, 'primary'));
    } else body.append(el('h3', null, app.state?.name || '群组'));
    body.append(button('退出群组', () => confirmPanel('退出群组', '退出后将停止接收这个群的消息。', async () => { await call('leave_group', { groupId: app.groupId }); await loadBootstrap(); await selectGroup(app.groups[0]?.id || null); }), 'danger'), button('移除本地群组记录', () => confirmPanel('移除记录', '将移除此设备上的群组记录。', async () => { await call('forget_group', { groupId: app.groupId }); await loadBootstrap(); await selectGroup(app.groups[0]?.id || null); }), 'danger')); const dangerZone = el('div','danger-zone'); for (const action of body.querySelectorAll(':scope > .danger')) dangerZone.append(action); body.append(dangerZone);
}
async function storagePanel() { const body = panel('存储与缓存'), generation = panelGeneration; const stats = await call('storage_stats'); if (generation !== panelGeneration || !$('panel').open || $('panel-title').textContent !== '存储与缓存') return; note(body, `文件缓存 ${formatBytes(stats.cacheBytes || stats.bytes || 0)} · ${stats.fileCount || stats.files || 0} 个文件`); body.append(button('清理缓存', () => confirmPanel('清理缓存', '已接收文件的本地缓存将被清理，聊天记录保留。', async () => { await call('clear_cache'); app.files.clear(); app.messages = app.messages.map(({localPath, path, ...message}) => message); renderMessages(); await refresh(); await storagePanel(); }))); }
function renderFileDrafts() { persistFiles(); const body = $('file-drafts'), files = app.fileDrafts.get(app.groupId) || []; body.hidden = !files.length; body.replaceChildren(); files.forEach((file, index) => { const row = el('div', 'file-draft'); row.append(el('span', null, file.name || file.path.split(/[\\/]/).at(-1)), button('移除', () => { files.splice(index, 1); renderFileDrafts(); })); body.append(row); });  }
const progress = progressScheduler(renderQueue);
const transferRows = new Map();
function renderQueue() {
    const queue = $('queue'); queue.hidden = !app.transfers.size;
    const active = [...app.transfers.values()].filter(t => !['完成','失败','已取消'].includes(t.status));
    const summary = $('transfer-summary'); summary.hidden = !app.transfers.size; summary.textContent = active.length ? `${active.length} 传输中` : '传输记录';
    if ($('transfer-empty')) $('transfer-empty').hidden = !!app.transfers.size;
    for (const [id, record] of transferRows) if (!app.transfers.has(id)) { record.row.remove(); transferRows.delete(id); }
    for (const task of app.transfers.values()) {
        let record = transferRows.get(task.id);
        if (!record) {
            const row = el('div','transfer'), name = el('span','transfer-name'), status = el('span','transfer-status'), problem = el('p','transfer-error'), bar = el('progress'), actions = el('div','transfer-actions');
            row.dataset.transferId = task.id; bar.max = 1;
            const cancel = button('取消传输', async () => { const current = app.transfers.get(task.id); if(!current)return; const result = await call('cancel_transfer',{transferId:current.id}); if(result?.ok!==false && current.status!=='完成')current.status='已取消'; progress.flush(); });
            const retry = button('重试', () => { const current = app.transfers.get(task.id); if(current?.path)return sendFiles([{path:current.path,name:current.name,transferId:current.id}],current.groupId); if(current?.message)return receive(current.message,current.groupId); });
            const clear = button('清除', () => { app.transfers.delete(task.id); renderQueue(); });
            actions.append(cancel,retry,clear); row.append(name,status,problem,bar,actions); queue.append(row);
            record = {row,name,status,problem,bar,cancel,retry,clear}; transferRows.set(task.id,record);
        }
        record.name.textContent = task.name || '文件'; record.status.textContent = task.status || '传输中'; record.problem.textContent = task.error || ''; record.problem.hidden = !task.error;
        record.row.dataset.status = ({'发送中':'sending','接收中':'receiving','完成':'completed','失败':'failed','已取消':'cancelled'})[task.status] || 'sending';
        record.bar.value = task.progress || 0; record.bar.setAttribute('aria-label',`${task.name || '文件'}传输进度`);
        const terminal = ['完成','失败','已取消'].includes(task.status);
        const focusedAction = [record.cancel,record.retry,record.clear].find(control => control === document.activeElement);
        record.cancel.hidden = terminal; record.retry.hidden = !(['失败','已取消'].includes(task.status) && (task.path || task.message)); record.clear.hidden = !terminal;
        if (focusedAction?.hidden) [record.retry,record.clear,record.cancel].find(control => !control.hidden && !control.disabled)?.focus({preventScroll:true});
    }
}
async function sendFiles(paths, groupId = app.groupId) {
    if (!groupId) throw Error('请先选择群组');
    if (groupId === app.groupId && app.state?.membershipRevoked) throw Error('请重新加入群组后发送');
    const failed = [];
    for (const item of paths) {
        const file = typeof item === 'string' ? { path: item } : item;
        const path = file.path, id = file.transferId || crypto.randomUUID();
        const task = { id, name: file.name || path.split(/[\\/]/).at(-1), status: '发送中', progress: 0, path, groupId };
        app.transfers.set(id, task); renderQueue();
        try {
            await call('send_file', { groupId, path, transferId: id });
            Object.assign(task, { status: '完成', progress: 1 });
            const drafts = app.fileDrafts.get(groupId);
            if (drafts) app.fileDrafts.set(groupId, drafts.filter(d => d.transferId !== id));
            persistFiles();if(groupId===app.groupId)renderFileDrafts();
        } catch (e) {
            failed.push({ ...file, transferId: id });
            const cancelled = task.status === '已取消' || /cancel|已取消/i.test(String(e));
            Object.assign(task, { status: cancelled ? '已取消' : '失败', error: cancelled ? '' : String(e) });
        }
        progress.flush();
    }
    await refresh(); return failed;
}
async function receive(message, groupId = app.groupId) {
    const id = message.id, task = { id, groupId, message, name: message.fileName, status: '接收中', progress: 0 };
    app.transfers.set(id, task); renderQueue();
    try {
        const result = await call('receive_file', { groupId, id, transferId: id });
        app.files.set(id, typeof result === 'string' ? result : result.path || result.localPath);
        Object.assign(task, { status: '完成', progress: 1 }); renderMessages();
    } catch (e) {
        const cancelled = task.status === '已取消' || /cancel|已取消/i.test(String(e));
        Object.assign(task, { status: cancelled ? '已取消' : '失败', error: cancelled ? '' : String(e) });
        if (!cancelled) throw e;
    } finally { progress.flush(); }
}
let pinned = false;
$('pin-window').onclick = () => run(async () => { const value = !pinned; await native('window_action', { action: 'pin', value }); pinned = value; $('pin-window').setAttribute('aria-pressed', String(pinned)); }, $('pin-window'));
$('hide-window').onclick = () => run(() => native('window_action', { action: 'hide' }));
$('groups-button').onclick = groupsPanel;
$('settings-button').onclick = settingsPanel;
$('invite-button').onclick = () => run(invitePanel);
$('members-button').onclick = () => run(membersPanel);
$('load-history').onclick = () => run(() => refresh({ older: true }), $('load-history'));
$('newer-history').onclick = () => run(() => refresh({ newer: true }), $('newer-history'));
$('latest-history').onclick = () => run(() => refresh({ latest: true }), $('latest-history'));
function filter(value) { app.filter = value; $('all-tab').setAttribute('aria-pressed', String(value === 'all')); $('files-tab').setAttribute('aria-pressed', String(value === 'files')); renderMessages(); }
$('all-tab').onclick = () => filter('all');
$('files-tab').onclick = () => filter('files');
// Grow by complete text lines, reserving conversation space on short screens.
function syncComposerHeight() {
    const input = $('message-input'); if (!input.getClientRects().length) return;
    const style = getComputedStyle(input), line = parseFloat(style.lineHeight), padding = parseFloat(style.paddingTop) + parseFloat(style.paddingBottom);
    const minimum = parseFloat(style.minHeight), maxLines = window.innerHeight <= 500 ? 2 : 3;
    input.style.height = '0px';
    const natural = input.scrollHeight, maximum = Math.max(minimum, padding + line * maxLines);
    const height = Math.max(minimum, Math.min(natural, maximum));
    input.style.height = `${height}px`; input.style.overflowY = natural > height ? 'auto' : 'hidden';
    if (natural <= height) input.scrollTop = 0;
}
let composerWidth = 0;
const composerSize = new ResizeObserver(entries => { const width = entries[0].contentRect.width; if (width !== composerWidth) { composerWidth = width; syncComposerHeight(); } });
composerSize.observe($('message-input'));
window.addEventListener('resize', syncComposerHeight);
$('message-input').addEventListener('input', () => { syncComposerHeight(); if (app.groupId)
    app.drafts.set(app.groupId, $('message-input').value); $('draft-note').textContent = $('message-input').value ? '草稿' : ''; clearTimeout(draftTimer); draftTimer = setTimeout(persistDrafts, 500); });
$('rejoin-button').onclick=()=>joinPanel();
$('composer').addEventListener('submit', e => { e.preventDefault();if(app.state?.membershipRevoked){toast('请重新加入群组后发送');return;} run(async () => { const input = $('message-input'), text = input.value.trim(), groupId = app.groupId, files = app.fileDrafts.get(groupId) || []; if ((!text && !files.length) || !groupId)
    return; if (text)
    await call('send_text', { groupId, text }); if (files.length) {
    const failed = await sendFiles(files, groupId);
    if (failed.length)
        app.fileDrafts.set(groupId, failed);
    else
        app.fileDrafts.delete(groupId);
    renderFileDrafts();
} if (app.groupId === groupId && input.value.trim() === text) {
    input.value = ''; syncComposerHeight();
    app.drafts.delete(groupId);
    persistDrafts();
    $('draft-note').textContent = '';
} await refresh(); }, $('send-text')); });
$('message-input').addEventListener('keydown', e => { if (e.key === 'Enter' && (e.metaKey || e.ctrlKey) && !e.isComposing) {
    e.preventDefault();
    $('composer').requestSubmit();
} });
$('choose-file').onclick = () => run(async () => { const groupId = app.groupId; if (!groupId)
    return; const files = await native('native_pick_files'); if (files?.length) {
    app.fileDrafts.set(groupId, [...(app.fileDrafts.get(groupId) || []), ...files]);
    renderFileDrafts();
} }, $('choose-file'));
async function consumeIncoming() {
    if (app.consumingIncoming) { app.consumeAgain = true; return app.consumingIncoming; }
    app.consumingIncoming = (async () => {
        do {
            app.consumeAgain = false;
            const result = await native('native_consume_incoming');
            if (result?.items?.length) {
                app.pendingIncoming = (app.pendingIncoming || []).concat(result.items);
                persistFiles(); incomingPanel();
            }
        } while (app.consumeAgain);
    })();
    try { await app.consumingIncoming; } finally { app.consumingIncoming = null; }
}
function incomingPanel() { const items = app.pendingIncoming || []; if (!items.length)
    return; if (!app.groupId) {
    toast('选择群组后发送收到的文件');
    return;
} const targetGroupId = app.groupId; const body = panel('发送到当前群组'); note(body, `目标：${app.state?.name || '当前群组'}`); for (const item of items)
    note(body, item.name || item.text || '文件'); body.append(button('发送', async () => { if(targetGroupId===app.groupId&&app.state?.membershipRevoked)throw Error('请重新加入群组后发送');const failed = []; for (const item of items) {
    if (item.text) {
        try {
            await call('send_text', { groupId: targetGroupId, text: item.text });
        }
        catch (e) {
            failed.push(item);
            error(e);
        }
    }
    else
        failed.push(...await sendFiles([item], targetGroupId));
} app.pendingIncoming = failed; persistFiles(); if (failed.length)
    incomingPanel();
else
    closePanel(); await refresh(); }, 'primary'), button('取消', () => { app.pendingIncoming = []; persistFiles(); closePanel(); })); }

const queueParking = el('div'); queueParking.hidden = true; document.body.append(queueParking); queueParking.append($('queue'));
function parkQueue() { if($('queue')) queueParking.append($('queue')); }
for (const [id, name] of [['choose-file','plus'],['send-text','send'],['pin-window','pin'],['hide-window','dock'],['settings-button','settings'],['close-panel','close'],['chat-back','back']]) { const node = $(id); if(node) node.replaceChildren(icon(name)); }
$('groups-button').querySelector('.group-chevron').append(icon('down'));
$('members-button').append(icon('arrow'));
for(const [id,name] of [['mobile-groups','people'],['mobile-transfers','transfer'],['mobile-profile','user']]) $(id)?.prepend(icon(name));
const mobileHome = el('section', 'mobile-home'); mobileHome.id = 'mobile-home'; mobileHome.hidden = true; $('app').append(mobileHome);
function homeView(view) {
    closePanel(); document.body.dataset.view = view; mobileHome.hidden = false; parkQueue(); mobileHome.replaceChildren();
    for (const name of ['groups','transfers','profile']) $('mobile-' + name)?.setAttribute('aria-current', name === view ? 'page' : 'false');
    if (view === 'groups') {
        const heading = el('div','home-heading'); const brand = el('div','home-brand'); const mark = el('img'); mark.src = '/assets/app-icon.svg'; mark.alt = ''; brand.append(mark, el('h1',null,'拾传')); heading.append(brand, button('＋ 新建', createPanel, 'primary')); mobileHome.append(heading, el('p','section-title','我的群组'));
        const list = el('div','group-list');
        for (const group of app.groups) { const row = button(group.name, () => selectGroup(group.id), 'group-option'); row.setAttribute('aria-label', group.name); const img = el('img'); img.src = asset(group.animalId); img.alt = ''; row.prepend(img); list.append(row); }
        if (!app.groups.length) list.append(el('p','empty-state','还没有群组'));
        mobileHome.append(list, button('加入群组', joinPanel,'join-group-link'));
    } else if (view === 'transfers') {
        mobileHome.append(el('h1',null,'传输')); attachQueue(mobileHome);
    } else {
        mobileHome.append(el('h1',null,'我的'), el('h2','profile-card',app.device.name || '此设备'), button('存储与缓存', storagePanel,'setting-row'), button('设备设置',settingsPanel,'setting-row'), el('p','version',`拾传 ${packageInfo.version}`));
    }
}
function attachQueue(body) { const empty = el('p','empty-state','没有传输任务'); empty.id = 'transfer-empty'; body.append(empty, $('queue')); renderQueue(); }
function transfersPanel() { attachQueue(panel('传输')); }
$('mobile-groups')?.addEventListener('click', () => homeView('groups'));
$('mobile-transfers')?.addEventListener('click', () => homeView('transfers'));
$('mobile-profile')?.addEventListener('click', () => homeView('profile'));
$('chat-back')?.addEventListener('click', () => homeView('groups'));
$('transfer-summary')?.addEventListener('click', transfersPanel);

function onEvent(event) {if(event.type==='back'){if($('panel').open)closePanel();else if(app.historical)run(()=>refresh({latest:true}));else if(isMobile() && document.body.dataset.view==='chat')homeView('groups');else{persistDrafts();persistFiles();run(()=>native('native_back_default'));}return;} if (event.type === 'transfer_progress' || event.type === 'transfer') {
    const id = event.id || event.messageId;
    let item = app.transfers.get(id);
    if (!item) {
        item = { id, name: event.name || '文件', status: '传输中' };
        app.transfers.set(id, item);
    }
    if(['完成','失败','已取消'].includes(item.status)&&!['completed','failed','cancelled'].includes(event.status))return;item.progress = event.progress ?? (event.total ? event.bytes / event.total : 0);
    if (event.status)
        item.status = ({ completed: '完成', failed: '失败', receiving: '接收中', sending: '发送中', cancelled:'已取消' })[event.status] || event.status;
    if (['completed', 'failed', 'cancelled'].includes(event.status))
        progress.flush();
    else
        progress.push();
    return;
} if (event.type === 'groups') {
    app.groups = event.groups || app.groups;
    updateHeader(); if(isMobile() && document.body.dataset.view === 'groups' && !$('panel').open)homeView('groups');
    return;
} if (event.groupId && event.groupId !== app.groupId)
    return; if (event.type === 'state' && event.state) {
    const state = event.state;
    if (app.historical) {
        app.state={...app.state,membershipRevoked:state.membershipRevoked,devices:state.devices,presenceRevision:state.presenceRevision};updateHeader();
        return;
    }
    if (app.state?.revision !== state.revision || app.state?.cacheRevision !== state.cacheRevision) {
        app.state = state;
        app.messages = mergeMessages(app.messages, state.messages || []);
        renderMessages();
        updateHeader();
    }
    else if (app.state?.presenceRevision !== state.presenceRevision||app.state?.membershipRevoked!==state.membershipRevoked) {
        app.state = state;
        updateHeader();
    }
    return;
} clearTimeout(app.refreshTimer); app.refreshTimer = setTimeout(() => run(() => refresh()), 100); }
document.addEventListener('visibilitychange', () => { if(document.body.dataset.desktop!=='true')run(() => call('set_active', { active: !document.hidden })); if (!document.hidden) {
    run(() => refresh());
    run(consumeIncoming);
    setTimeout(() => run(consumeIncoming), 800);
} });
async function start() { try {
    document.body.dataset.macos = String(/Macintosh|Mac OS X/.test(navigator.userAgent) && !/iPhone|iPad/.test(navigator.userAgent));
    document.body.dataset.desktop = String(!/Android|iPhone|iPad/i.test(navigator.userAgent));if(document.body.dataset.desktop==='true')await call('set_active',{active:true});
    const boot = await loadBootstrap();
    await selectGroup(boot.activeGroupId || app.groups[0]?.id || null); if(isMobile() && !app.pendingIncoming?.length)homeView('groups');
    app.unlisten = await subscribe(onEvent);if(/Android/i.test(navigator.userAgent)){app.unlistenBack=await subscribeBack(()=>onEvent({type:'back'}));app.unlistenIncoming=await subscribeIncoming(()=>run(consumeIncoming));}
    app.unlistenWindow = await subscribeWindow(state => { document.body.dataset.collapsed = String(state.collapsed); app.dockEdge = state.edge; pinned = state.pinned; $('pin-window').setAttribute('aria-pressed', String(pinned)); });
    await consumeIncoming();
    if (!window.__PICKDROP_TEST_BRIDGE__) {
        const { getCurrentWebview } = await import('@tauri-apps/api/webview');
        const { listen } = await import('@tauri-apps/api/event');
        app.unlistenAnchorDrop = await listen('pickdrop:anchor-drop', event => run(async () => {
            try {
                const failed = await sendFiles(event.payload, app.groupId);
                if (failed.length) { await native('window_action', { action: 'expand' }); toast('部分文件发送失败，请在传输任务中重试'); }
            } catch (e) { await native('window_action', { action: 'expand' }); throw e; } finally { await native('window_action', { action: 'upload-busy', value: false }); }
        }));
        app.unlistenDrop = await getCurrentWebview().onDragDropEvent(e => { if (e.payload.type === 'drop' && app.groupId)
            run(() => sendFiles(e.payload.paths)); });
    }
}
catch (e) {
    $('empty').textContent = '无法打开收件箱，请确认应用服务已启动。';
    error(e);
} }
let headerDrag = null, suppressGroupClick = false;
document.querySelector('header').addEventListener('pointerdown', event => {
    if (document.body.dataset.macos !== 'true' || event.button !== 0 || event.target.closest('.header-actions')) return;
    suppressGroupClick = false; headerDrag = { x:event.clientX, y:event.clientY };
});
document.querySelector('header').addEventListener('pointermove', event => {
    if (!headerDrag || !event.buttons || Math.hypot(event.clientX-headerDrag.x,event.clientY-headerDrag.y)<4) return;
    headerDrag = null; suppressGroupClick = true;
    run(() => native('window_action', { action:'drag' }));
});
document.querySelector('header').addEventListener('click', event => {
    if (suppressGroupClick) { event.preventDefault(); event.stopImmediatePropagation(); suppressGroupClick = false; }
}, true);
window.addEventListener('pointerup', () => { headerDrag = null; });
window.addEventListener('blur', () => { headerDrag = null; });
let resizing = null, resizePending = null, resizeSending = false;
async function flushWindowResize() {
    if(resizeSending) return;
    resizeSending = true;
    try { while(resizePending) { const size = resizePending; resizePending = null; await native('window_resize', size); } }
    finally { resizeSending = false; if(!resizing) await native('window_action', {action:'busy',value:false}); }
}
$('window-resize-handle').addEventListener('pointerdown', event => {
    if(event.button !== 0) return;
    event.preventDefault();
    resizing = { pointer:event.pointerId, x:event.screenX, y:event.screenY, width:window.innerWidth, height:window.innerHeight };
    event.currentTarget.setPointerCapture(event.pointerId);
    run(() => native('window_action', {action:'busy',value:true}));
});
$('window-resize-handle').addEventListener('pointermove', event => {
    if(!resizing) return;
    resizePending = {width:Math.max(360,resizing.width+event.screenX-resizing.x),height:Math.max(480,resizing.height+event.screenY-resizing.y)};
    run(flushWindowResize);
});
function finishWindowResize(event) {
    if(!resizing) return;
    const id = resizing.pointer; resizing = null;
    if($('window-resize-handle').hasPointerCapture(id)) $('window-resize-handle').releasePointerCapture(id);
    run(flushWindowResize);
}
$('window-resize-handle').addEventListener('pointerup', finishWindowResize);
$('window-resize-handle').addEventListener('pointercancel', finishWindowResize);
window.addEventListener('blur', finishWindowResize);
document.documentElement.addEventListener('pointerleave', () => { if (app.dockEdge && !pinned && !$('panel').open)
    run(() => native('window_action', { action: 'pointer-leave' })); });
$('panel').addEventListener('close', () => { if ($('panel').open) return; clearTimeout(joinTimer); if(isMobile() && document.body.dataset.view === 'transfers' && !$('panel').open) { mobileHome.append($('queue')); renderQueue(); } if(panelReturnFocus?.isConnected)panelReturnFocus.focus(); if (document.body.dataset.desktop === 'true')
    run(() => native('window_action', { action: 'busy', value: false })); });
window.addEventListener('pagehide', () => { dialogMotion.dispose(); composerSize.disconnect(); window.removeEventListener('resize', syncComposerHeight); app.disposed = true; clearTimeout(draftTimer); persistDrafts(); persistFiles(); clearTimeout(app.refreshTimer); clearTimeout(joinTimer); progress.dispose(); app.unlisten?.(); app.unlistenDrop?.(); app.unlistenAnchorDrop?.(); app.unlistenWindow?.();app.unlistenBack?.();app.unlistenIncoming?.(); thumbnails.disconnect(); });
start();
