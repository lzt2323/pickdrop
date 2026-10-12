import './style.css';
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
function button(text, action, className) { const node = el('button', className, text); node.type = 'button'; node.addEventListener('click', () => run(action, node)); return node; }
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
async function run(action, control) { if (control)
    control.disabled = true; try {
    return await action();
}
catch (e) {
    error(e);
}
finally {
    if (control)
        control.disabled = !!app.state?.membershipRevoked&&['send-text','choose-file','invite-button'].includes(control.id);
} }
function panel(title) { if (document.body.dataset.desktop === 'true')
    run(() => native('window_action', { action: 'busy', value: true })); $('panel-title').textContent = title; $('panel-body').replaceChildren(); if (!$('panel').open)
    $('panel').showModal(); return $('panel-body'); }
function field(body, title, value = '', type = 'text') { const label = el('label', null, title), input = el('input'); input.type = type; input.value = value; label.append(input); body.append(label); return input; }
function note(body, text) { body.append(el('p', 'muted', text)); }
function closePanel() { $('panel').close(); }
$('close-panel').onclick = closePanel;
$('panel').addEventListener('click', e => { if (e.target === $('panel')) {
    const r = $('panel').getBoundingClientRect();
    if (e.clientX < r.left || e.clientX > r.right || e.clientY < r.top || e.clientY > r.bottom)
        closePanel();
} });
function asset(id) { return `/assets/group-animals/${animals.includes(id) ? id : 'cat'}.png`; }
function updateHeader() {const revoked=!!app.state?.membershipRevoked;$('membership-notice').hidden=!revoked;for(const id of ['send-text','choose-file','invite-button'])$(id).disabled=revoked; const group = app.groups.find(g => g.id === app.groupId) || app.state; $('group-name').textContent = group?.name || '拾传'; $('group-animal').src = group ? asset(group.animalId) : '/assets/app-icon.svg'; $('composer').hidden = !app.groupId; const devices = app.state?.devices || []; $('device-summary').textContent = app.groupId ? `${devices.length} 台设备 · ${devices.filter(d => d.online).length} 台在线` : '创建或加入群组，开始传送'; }
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
    row.append(bubble);
}
else {
    const card = el('div', 'file-card');
    const name = m.fileName || m.name || m.file?.name || '文件';
    card.append(el('div', 'file-name', name), el('div', 'file-size', formatBytes(m.size || m.fileSize || m.file?.size)));
    const actions = el('div', 'file-actions');
    const local = app.files.get(m.id) || m.localPath || m.path;
    if (local) {
        if (document.body.dataset.desktop === 'true') {
            card.draggable = true;
            card.addEventListener('dragstart', event => { event.preventDefault(); run(() => native('native_drag_file', { path: local, suggestedName: name })); });
            actions.append(button('拖出文件', () => native('native_drag_file', { path: local, suggestedName: name })));
        }
        actions.append(button('打开', () => native('native_open_file', { path: local, suggestedName: name })), button('另存为', () => native('native_save_file', { sourcePath: local, suggestedName: name })), button('分享', () => native('native_share_file', { path: local, suggestedName: name })));
        if (/\.(png|jpg|jpeg|webp|gif)$/i.test(name)) {
            const img = el('img', 'thumbnail');
            img.alt = name;
            img.loading = 'lazy';
            img.dataset.path = local;
            card.append(img);
            thumbnails.observe(img);
            if (/Android|iPhone|iPad/i.test(navigator.userAgent))
                actions.append(button('保存到相册', () => native('native_save_gallery', { path: local, suggestedName: name })));
        }
    }
    else
        actions.append(button('接收文件', () => receive(m)));
    card.append(actions);
    row.append(card);
} return row; }
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
} $('empty').hidden = visible.length > 0; $('empty').textContent = app.groupId ? (app.filter === 'files' ? '这里还没有文件' : '发一句话，或选择文件传到这个群') : '点击左上角，创建或加入群组'; $('load-history').hidden = !app.state?.history?.hasMore; $('newer-history').hidden = !app.historical; $('latest-history').hidden = !app.historical; if (nearBottom)
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
    return; if (!older && !newer && !latest && app.state?.revision === state.revision && app.state?.presenceRevision === state.presenceRevision && state.revision != null)
    return; if (!older && !newer && !latest && app.state?.revision === state.revision) {
    app.state = state;
    updateHeader();
    return;
} app.currentBefore = params.before ?? null; app.historical = params.before != null; app.state = state; app.messages = (older || newer || latest) ? mergeMessages([], state.messages || []) : mergeMessages(app.messages, state.messages || []); renderMessages(); updateHeader(); }
async function loadBootstrap() { const boot = await call('bootstrap'); app.device = boot.device || {}; app.groups = boot.groups || []; app.endpoint = boot.endpoint; return boot; }
async function selectGroup(id) { if (app.groupId)
    app.drafts.set(app.groupId, $('message-input').value); app.generation++; app.groupId = id; app.state = null; app.historyCursors = []; app.currentBefore = null; app.historical = false; app.messages = []; app.rows.clear(); $('messages').replaceChildren(); $('message-input').value = app.drafts.get(id) || ''; updateHeader(); renderMessages(); renderFileDrafts(); if (id) {
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
} body.append(button('＋ 创建群组', createPanel, 'primary'), button('加入群组', joinPanel), ...(/Android|iPhone|iPad/i.test(navigator.userAgent) ? [button('扫描邀请二维码', async () => joinPanel(await scanInvite()))] : [])); }
function createPanel() { const body = panel('创建群组'), name = field(body, '群组名称', '拾传群'); let animalId = animals[app.groups.length % animals.length]; const grid = el('div', 'animal-picker'); animals.forEach((id, i) => { const b = button('', () => { animalId = id; grid.querySelectorAll('button').forEach(x => x.setAttribute('aria-pressed', String(x === b))); }); b.setAttribute('aria-label', names[i]); b.setAttribute('aria-pressed', String(id === animalId)); const img = el('img'); img.src = asset(id); img.alt = ''; b.append(img); grid.append(b); }); body.append(grid, button('创建', async () => { if (!name.value.trim())
    throw Error('请输入群组名称'); const group = await call('create_group', { name: name.value.trim(), animalId }); await loadBootstrap(); await selectGroup(group.id); }, 'primary')); }
function joinPanel(invite = '') { const body = panel('加入群组'), link = field(body, '邀请链接（可选）', invite), address = field(body, '设备地址，例如 http://192.168.1.2:…'), code = field(body, '邀请码'); const parsed = parseInvite(invite); if (parsed) {
    address.value = parsed.address;
    code.value = parsed.code;
} link.addEventListener('input', () => { const p = parseInvite(link.value); if (p) {
    address.value = p.address;
    code.value = p.code;
} }); note(body, '两台设备需要可以互相访问；加入后由群内设备确认。'); const nearby = el('div', 'stack'); body.append(nearby); body.append(button('查找附近群组', async () => { const groups = await call('discover_groups'); nearby.replaceChildren(); for (const group of groups)
    nearby.append(button(`${group.name} · ${group.baseUrl}`, () => { address.value = group.baseUrl; code.focus(); })); if (!groups.length)
    note(nearby, '暂无附近群组，可以粘贴邀请链接。'); })); body.append(button('申请加入', async () => { const result = await call('join_group', { address: address.value.trim(), code: code.value.trim() }); if (result.group || result.status === 'approved') {
    await loadBootstrap();
    return selectGroup(result.group?.id || result.groupId);
} joinWaiting(result.ticket || result); }, 'primary')); }
let joinTimer;
function joinWaiting(ticket) { const body = panel('等待加入确认'); note(body, '申请已发送，请在群内设备上允许加入。'); clearTimeout(joinTimer); const check = async () => { if (!$('panel').open)
    return; try {
    const result = await call('check_join', { ticket });
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
    return groupsPanel(); const body = panel('邀请设备'); note(body, '正在生成邀请…'); const invitation = await call('create_invite', { groupId: app.groupId }); body.replaceChildren(); const link = invitation.url || invitation.link || `pickdrop://join?address=${encodeURIComponent(invitation.address || invitation.baseUrl || app.endpoint?.baseUrl || '')}&code=${encodeURIComponent(invitation.code || '')}`; const img = el('img', 'qr'); img.alt = '加入群组二维码'; img.src = await QRCode.toDataURL(link, { width: 440, margin: 2 }); body.append(img); field(body, '设备地址', invitation.address || invitation.baseUrl || app.endpoint?.baseUrl || '').readOnly = true; field(body, '邀请码', invitation.code || '').readOnly = true; body.append(button('复制邀请链接', async () => { await copyText(link); toast('邀请链接已复制'); }, 'primary')); note(body, '新设备申请加入后，需要在成员页确认。'); }
async function membersPanel() { if (!app.groupId)
    return groupsPanel(); const body = panel('成员与加入申请'); const requests = await call('list_join_requests', { groupId: app.groupId }); for (const request of (Array.isArray(requests) ? requests : requests.requests || [])) {
    const row = el('div', 'member');
    row.append(el('span', null, request.device?.name || request.deviceName || request.name || '新设备'), button('允许', async () => { await call('respond_join', { groupId: app.groupId, id: request.id, allow: true }); await membersPanel(); }), button('拒绝', async () => { await call('respond_join', { groupId: app.groupId, id: request.id, allow: false }); await membersPanel(); }));
    body.append(row);
} for (const device of app.state?.devices || []) {
    const row = el('div', 'member');
    row.append(el('span', null, `${device.name || device.id}${device.id === app.device.id ? '（本机）' : device.online ? '（在线）' : '（离线）'}`));
    if (device.id !== app.device.id)
        row.append(button('移除', async () => { await confirmPanel('移除成员', `移除 ${device.name || '此设备'}？`, async () => { await call('remove_member', { groupId: app.groupId, deviceId: device.id }); await refresh(); await membersPanel(); }); }));
    body.append(row);
} if (!body.childNodes.length)
    note(body, '暂无成员或加入申请。'); }
async function confirmPanel(title, text, action) { const body = panel(title); note(body, text); body.append(button('确认', action, 'primary'), button('取消', closePanel)); }
function settingsPanel() { const body = panel('设置'), deviceName = field(body, '本机名称', app.device.name || ''); body.append(button('保存设备名称', async () => { await call('rename_device', { name: deviceName.value.trim() }); await loadBootstrap(); updateHeader(); toast('已保存'); })); if (app.groupId) {
    const groupName = field(body, '群组名称', app.state?.name || '');
    body.append(button('保存群组名称', async () => { await call('rename_group', { groupId: app.groupId, name: groupName.value.trim() }); await loadBootstrap(); await refresh(); toast('已保存'); }), button('退出群组', () => confirmPanel('退出群组', '退出后将停止接收这个群的消息。', async () => { await call('leave_group', { groupId: app.groupId }); await loadBootstrap(); await selectGroup(app.groups[0]?.id || null); })), button('移除本地群组记录', () => confirmPanel('移除记录', '将移除此设备上的群组记录。', async () => { await call('forget_group', { groupId: app.groupId }); await loadBootstrap(); await selectGroup(app.groups[0]?.id || null); })));
} body.append(button('存储与缓存', storagePanel)); if (document.body.dataset.desktop === 'true') {
    const dock = el('div', 'stack');
    for (const [action, label] of [['dock-left', '贴到左侧'], ['dock-right', '贴到右侧'], ['dock-top', '贴到顶部'], ['undock', '取消贴边']])
        dock.append(button(label, () => native('window_action', { action })));
    body.append(dock);
} note(body, '拾传 0.6.0-alpha.1 · Tauri 迁移预览'); }
async function storagePanel() { const body = panel('存储与缓存'); const stats = await call('storage_stats'); note(body, `文件缓存 ${formatBytes(stats.cacheBytes || stats.bytes || 0)} · ${stats.fileCount || stats.files || 0} 个文件`); body.append(button('清理缓存', () => confirmPanel('清理缓存', '已接收文件的本地缓存将被清理，聊天记录保留。', async () => { await call('clear_cache'); app.files.clear(); await refresh(); await storagePanel(); }))); }
function renderFileDrafts() { persistFiles(); const body = $('file-drafts'), files = app.fileDrafts.get(app.groupId) || []; body.hidden = !files.length; body.replaceChildren(); files.forEach((file, index) => { const row = el('div', 'file-draft'); row.append(el('span', null, file.name || file.path.split(/[\\/]/).at(-1)), button('移除', () => { files.splice(index, 1); renderFileDrafts(); })); body.append(row); }); if (files.length)
    body.append(el('p', 'muted', `${files.length} 个文件待发送，点击发送确认。`)); }
const progress = progressScheduler(renderQueue);
function renderQueue() {
    const queue = $('queue'); queue.hidden = !app.transfers.size; queue.replaceChildren();
    for (const task of app.transfers.values()) {
        const row = el('div', 'transfer', `${task.name || '文件'} · ${task.status || '传输中'}${task.error ? ' · ' + task.error : ''}`);
        row.dataset.transferId = task.id;
        const bar = el('progress'); bar.max = 1; bar.value = task.progress || 0; row.append(bar);
        const terminal = ['完成', '失败', '已取消'].includes(task.status);
        if (!terminal) row.append(button('取消传输', async () => { const result=await call('cancel_transfer', { transferId: task.id }); if(result?.ok!==false&&task.status!=='完成')task.status = '已取消'; progress.flush(); }));
        if (['失败', '已取消'].includes(task.status)) {
            if (task.path) row.append(button('重试', () => sendFiles([{ path: task.path, name: task.name, transferId: task.id }], task.groupId)));
            else if (task.message) row.append(button('重试', () => receive(task.message, task.groupId)));
        }
        if (terminal) row.append(button('清除', () => { app.transfers.delete(task.id); renderQueue(); }));
        queue.append(row);
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
$('pin-window').onclick = () => run(async () => { await native('window_action', { action: 'pin', value: !pinned }); pinned = !pinned; $('pin-window').setAttribute('aria-pressed', String(pinned)); });
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
$('message-input').addEventListener('input', () => { if (app.groupId)
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
    input.value = '';
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
function onEvent(event) {if(event.type==='back'){if($('panel').open)closePanel();else if(app.historical)run(()=>refresh({latest:true}));else{persistDrafts();persistFiles();run(()=>native('native_back_default'));}return;} if (event.type === 'transfer_progress' || event.type === 'transfer') {
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
    updateHeader();
    return;
} if (event.groupId && event.groupId !== app.groupId)
    return; if (event.type === 'state' && event.state) {
    const state = event.state;
    if (app.historical) {
        app.state={...app.state,membershipRevoked:state.membershipRevoked,devices:state.devices,presenceRevision:state.presenceRevision};updateHeader();
        return;
    }
    if (app.state?.revision !== state.revision) {
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
    document.body.dataset.desktop = String(!/Android|iPhone|iPad/i.test(navigator.userAgent));if(document.body.dataset.desktop==='true')await call('set_active',{active:true});
    const boot = await loadBootstrap();
    await selectGroup(boot.activeGroupId || app.groups[0]?.id || null);
    app.unlisten = await subscribe(onEvent);if(/Android/i.test(navigator.userAgent)){app.unlistenBack=await subscribeBack(()=>onEvent({type:'back'}));app.unlistenIncoming=await subscribeIncoming(()=>run(consumeIncoming));}
    app.unlistenWindow = await subscribeWindow(state => { document.body.dataset.collapsed = String(state.collapsed); app.dockEdge = state.edge; pinned = state.pinned; $('pin-window').setAttribute('aria-pressed', String(pinned)); $('collapsed-tab').hidden = !state.collapsed; });
    await consumeIncoming();
    if (!window.__PICKDROP_TEST_BRIDGE__) {
        const { getCurrentWebview } = await import('@tauri-apps/api/webview');
        app.unlistenDrop = await getCurrentWebview().onDragDropEvent(e => { if (e.payload.type === 'drop' && app.groupId)
            run(() => sendFiles(e.payload.paths)); });
    }
}
catch (e) {
    $('empty').textContent = '无法打开收件箱，请确认应用服务已启动。';
    error(e);
} }
$('collapsed-tab').onclick = () => run(() => native('window_action', { action: 'expand' }));
$('collapsed-tab').onpointerenter = () => run(() => native('window_action', { action: 'expand' }));
document.documentElement.addEventListener('pointerleave', () => { if (app.dockEdge && !pinned && !$('panel').open)
    run(() => native('window_action', { action: 'collapse' })); });
$('panel').addEventListener('close', () => { if (document.body.dataset.desktop === 'true')
    run(() => native('window_action', { action: 'busy', value: false })); });
window.addEventListener('pagehide', () => { app.disposed = true; clearTimeout(draftTimer); persistDrafts(); persistFiles(); clearTimeout(app.refreshTimer); clearTimeout(joinTimer); progress.dispose(); app.unlisten?.(); app.unlistenDrop?.(); app.unlistenWindow?.();app.unlistenBack?.();app.unlistenIncoming?.(); thumbnails.disconnect(); });
start();
