import { ANIMALS, groupAnimal, nextAnimal } from '/animals.js';
import { invitationAddress, invitationUrl, invitationText, parseInvitation } from '/invitation.js';
import { parseRoomLink, fileSize } from '/protocol.js';
import { mergeState, prependHistory } from '/history.js';
import { ImageDrafts, createImagePasteHandler } from '/clipboard-images.js';

const $ = id => document.getElementById(id);
const bridge = window.pickdrop;
let config, socket, epoch = 0, reconnectTimer, toastTimer, dropDepth = 0, preparing = 0, uploading = 0;
let requestController = new AbortController(), reconnectAttempt = 0, connectionError = '', nearbyRefresh;
let pendingTicket, pendingTimer, requestsLoading = false, groupsLoading = false, groupsDirty = false;
let state = { messages: [], devices: [] }, groups = [], requests = [], online = false, panelKind = '', inviteTimer;
const ready = new Map(), prepareQueue = [];
const imageDrafts = new ImageDrafts();
let sendingComposer = false, historyLoaded = false, readingHistory = false, contentView = 'all';
const observedFiles = new Set();
const AUTO_RECEIVE_BYTES = 8 * 1024 ** 2;
const messageNodes = new Map();
const element = (tag, className, text) => {
  const node = document.createElement(tag); if (className) node.className = className;
  if (text !== undefined) node.textContent = text; return node;
};
function toast(text) { $('toast').textContent = text; $('toast').hidden = false; clearTimeout(toastTimer); toastTimer = setTimeout(() => $('toast').hidden = true, 3500); }
function showError(error) {
  const message = error?.message || '操作失败，请重试';
  if ($('panel').open) { let note = $('panel-body').querySelector('.task-error'); if (!note) { note = element('p', 'task-error'); note.setAttribute('role', 'alert'); $('panel-body').prepend(note); } note.textContent = message; note.scrollIntoView({ block: 'nearest' }); }
  else toast(message);
}
function action(label, callback, className = '', id = '') {
  const button = element('button', className, label); button.type = 'button'; if (id) button.id = id;
  button.addEventListener('click', event => { event.stopPropagation(); $('panel-body').querySelector('.task-error')?.remove(); Promise.resolve().then(callback).catch(showError); }); return button;
}
function fileIcon(kind) {
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  for (const [key, value] of Object.entries({ viewBox: '0 0 24 24', width: '18', height: '18', fill: 'none', stroke: 'currentColor', 'stroke-width': '1.7', 'stroke-linecap': 'round', 'stroke-linejoin': 'round', 'aria-hidden': 'true' })) svg.setAttribute(key, value);
  const path = document.createElementNS(svg.namespaceURI, 'path');
  path.setAttribute('d', kind === 'more' ? 'M5 12h.01M12 12h.01M19 12h.01' : 'M4 5h16v14H4zM4 16l5-5 4 4 3-3 4 4M8 8h.01');
  svg.append(path); return svg;
}
function previewable(message) { return Boolean(bridge?.previewFile && !message.deleted && /^image\/(png|jpeg|webp)$/i.test(message.mime || '') && /\.(png|jpe?g|webp)$/i.test(message.fileName) && message.size > 0 && message.size <= AUTO_RECEIVE_BYTES); }
let previewGeneration = 0, activePreviewId = null;
async function openImage(message) {
  if (state.messages.find(item => item.id === message.id)?.deleted) return;
  const token = ++previewGeneration; activePreviewId = message.id;
  const body = openPanel(message.fileName, 'image-preview');
  body.append(description('正在校验并加载图片…'));
  try {
    const result = await bridge.previewFile(message.id, true);
    if (token !== previewGeneration || panelKind !== 'image-preview' || !$('panel').open) return;
    const image = element('img', 'image-preview-full'); image.src = result.url; image.alt = message.fileName;
    const controls = element('div', 'image-preview-controls');
    controls.append(action('另存为…', () => saveFile(message)), action('用系统应用打开', () => bridge.openFile(message.id)));
    body.replaceChildren(image, description(`${result.width} × ${result.height} · ${fileSize(message.size)}`), controls);
    ready.set(message.id, true); renderMessages();
  } catch (error) {
    if (token === previewGeneration && panelKind === 'image-preview') body.replaceChildren(description(error.message), action('重试预览', () => openImage(message)), action('另存为…', () => saveFile(message)));
  }
}
// Historical image originals enter the verified receive cache only when visible.
const visibleImages = new IntersectionObserver(entries => {
  for (const entry of entries) {
    if (!entry.isIntersecting) continue;
    const button = entry.target;
    const message = state.messages.find(item => item.id === button.dataset.imageId);
    if (!message || !previewable(message)) continue;
    visibleImages.unobserve(button);
    if (ready.get(message.id) === true) loadThumbnail(message, button);
    else if (!ready.has(message.id)) {
      ready.set(message.id, 'loading');
      prepareQueue.push({ id: message.id, generation: epoch });
      hydrate();
    }
  }
}, { root: $('timeline'), threshold: 0.01 });
let thumbnailsActive = 0;
const thumbnailQueue = [];
function loadThumbnail(message, button) {
  if (button.dataset.previewState || !previewable(message)) return;
  button.dataset.previewState = 'loading';
  thumbnailQueue.push({ message, button, generation: epoch }); drainThumbnails();
}
function drainThumbnails() {
  while (thumbnailsActive < 2 && thumbnailQueue.length) {
    const { message, button, generation } = thumbnailQueue.shift();
    if (generation !== epoch || message.deleted) { delete button.dataset.previewState; continue; }
    thumbnailsActive++;
    bridge.previewFile(message.id).then(result => {
      if (generation !== epoch || !button.isConnected || button.disabled) { delete button.dataset.previewState; return; }
      const img = element('img'); img.src = result.url; img.alt = message.fileName; img.draggable = false;
      button.replaceChildren(img); button.dataset.previewState = 'ready';
    }).catch(() => { button.dataset.previewState = 'error'; button.replaceChildren(fileIcon('image'), element('span', '', '点按重试预览')); })
      .finally(() => { thumbnailsActive--; drainThumbnails(); });
  }
}
function busy() {
  const focused = document.hasFocus();
  const inputFocused = focused && ['INPUT', 'TEXTAREA', 'SELECT'].includes(document.activeElement?.tagName);
  bridge?.setInteractionBusy?.(Boolean(dropDepth || focused && ($('panel').open || !$('group-menu').hidden || inputFocused || document.querySelector('.file-more[open]'))));
}
function animalImage(group, className = 'group-animal') { const image = element('img', className); image.src = `/assets/group-animals/${groupAnimal(group)}.png`; image.alt = ''; image.draggable = false; image.decoding = 'async'; return image; }
function renderGroupAnimal() { const mark = document.querySelector('.group-mark'); if (mark && config?.room && !config.room.welcome) mark.replaceChildren(animalImage(config.room)); }
function animalPicker(selected) {
  const picker = element('div', 'animal-picker'); picker.setAttribute('role', 'group'); picker.setAttribute('aria-label', '选择群动物'); picker.dataset.value = selected;
  for (const animal of ANIMALS) { const button = action('', () => { picker.dataset.value = animal.id; for (const item of picker.children) item.setAttribute('aria-pressed', String(item === button)); }, 'animal-choice'); button.dataset.animal = animal.id; button.setAttribute('aria-label', animal.name); button.setAttribute('aria-pressed', String(animal.id === selected)); button.append(animalImage({animalId: animal.id}), element('span', '', animal.name)); picker.append(button); }
  return picker;
}
function fieldLabel(text, field) { const label = element('label', 'form-field'); label.append(element('span', 'field-label', text), field); return label; }
function groupName() { return config?.room?.name || '我的文件'; }
function isHostedGroup() { return Boolean(config?.room && !config.room.welcome && config.room.mode !== 'peer'); }
function renderGroupMode() {
  const notice = $('hosted-group-notice');
  notice.hidden = !isHostedGroup();
  if (notice.hidden) return;
  notice.textContent = config.room.local ? '旧群依赖本机持续在线 · 查看升级' : '旧群依赖托管电脑持续在线 · 查看说明';
}
function appendHostedGroupInfo(body) {
  if (!isHostedGroup()) return;
  body.append(element('p', 'connection-warning', config.room.local
    ? '这是旧版托管群。此电脑关闭拾传后，其他成员也无法互通。可升级为多设备群，让在线成员直接同步。'
    : '这是旧版托管群。托管电脑必须持续运行拾传，其他成员才能互通。请在原托管电脑升级为多设备群，再使用新邀请重新加入。'));
  if (config.room.local && bridge?.upgradeGroup) body.append(action('升级为多设备群', () => confirmOperation('升级为多设备群', '本机的历史消息与文件保留。其他成员需要更新客户端，再使用新邀请重新加入。升级后在线成员可直接同步；文件只有在线设备持有副本时才能下载。确认升级？', async () => {
    await bridge.upgradeGroup(); await groupsChanged(); await join(); toast('已升级为多设备群，请重新邀请其他成员');
  }), 'primary-button', 'upgrade-group'));
}
function connection(value) { online = value; renderConnection(); }
function renderConnection() {
  renderGroupMode();
  $('connection-status').dataset.connected = String(online);
  $('connection-status').classList.toggle('connected-label', online);
  $('connection-status').textContent = online ? '已连接' : connectionError ? '连接失败 · 点击查看' : '连接中';
  $('connection-dot').classList.toggle('offline', !online);
  $('connection-status').title = online ? '已连接，在线状态已同步' : connectionError || '正在重新连接，在线状态待更新';
}
async function api(route, options = {}) {
  const response = await fetch(config.room.baseUrl + route, { ...options, signal: AbortSignal.any([requestController.signal, options.signal || AbortSignal.timeout(8000)]), headers: { 'X-Room-Key': config.room.key, 'X-Device-Id': config.device.id, ...options.headers } });
  const result = await response.json(); if (!response.ok) throw Object.assign(new Error(result.error || '操作失败'), { status: response.status }); return result;
}
function time(date) { return new Date(date).toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' }); }
function statusFor(message) { if (message.deleted) return '文件已清理'; return ready.get(message.id) === true ? '可拖出' : ready.get(message.id) === 'waiting' ? '等待在线副本 · 点按重试' : ready.get(message.id) === 'error' ? '接收失败' : ready.get(message.id) === 'loading' ? '接收中' : '点按接收'; }
function hydrate() {
  while (preparing < 2 && prepareQueue.length) {
    const { id, generation } = prepareQueue.shift(); if (generation !== epoch) continue;
    preparing++;
    Promise.resolve().then(() => bridge.prepareFile(id)).then(() => { if (generation === epoch) ready.set(id, true); }).catch(error => { if (generation === epoch) ready.set(id, /在线副本|离线|持有|unavailable|offline/i.test(error.message) ? 'waiting' : 'error'); }).finally(() => { preparing--; if (generation === epoch) renderMessages(); hydrate(); });
  }
}
function applyState(next) {
  const previouslyOnline = new Set(state.devices.filter(device => device.online).map(device => device.id));
  state = mergeState(state, next);
  if (bridge) for (const message of state.messages) if (message.type === 'file' && !message.deleted) {
    const isNew = historyLoaded && !observedFiles.has(message.id);
    observedFiles.add(message.id);
    if (isNew && Number.isSafeInteger(message.size) && message.size <= AUTO_RECEIVE_BYTES && !ready.has(message.id)) {
      ready.set(message.id, 'loading'); prepareQueue.push({ id: message.id, generation: epoch });
    }
  }
  if (bridge && state.devices.some(device => device.online && device.id !== config.device.id && !previouslyOnline.has(device.id))) for (const message of state.messages) {
    if (!message.deleted && ready.get(message.id) === 'waiting') { ready.set(message.id, 'loading'); prepareQueue.push({ id: message.id, generation: epoch }); }
  }
  while (observedFiles.size > 1000) observedFiles.delete(observedFiles.values().next().value);
  historyLoaded = true;
  hydrate(); renderDevices(); renderMessages();
}
function renderDevices() {
  renderConnection();
  const members = state.devices.slice().sort((a, b) => Number(b.online) - Number(a.online));
  $('member-avatars').replaceChildren();
  const names = members.map(device => device.id === config.device.id ? '我' : device.name);
  const memberNames = names.join('、');
  $('device-summary').textContent = `${members.filter(device => device.online).length} 台设备在线`;
  $('members-button').title = names.join('、') || '本群成员与设备';
  if (panelKind !== 'members' || !$('panel').open) return;
  const list = $('devices'); if (!list) return;
  list.replaceChildren(...state.devices.map(device => {
    const row = element('div', 'device');
    const details = element('div', 'device-details'); details.append(element('strong', '', device.name + (device.id === config.device.id ? ' · 本机' : '')));
    const status = element('small'); status.append(element('i', `online-dot ${device.online ? '' : 'offline-dot'}`), document.createTextNode(device.online ? '在线' : '离线'));
    details.append(status); row.append(details);
    if (bridge?.removeMember && (config.room.mode === 'peer' ? config.room.canManage : config.room.local && Number(config.room.authVersion) === 2) && device.id !== config.room.hostDeviceId && device.id !== config.device.id) {
      const remove = action('移除', () => confirmOperation('移除此设备', `移除「${device.name}」后，其连接和访问授权会被撤销，需要重新申请加入。`, async () => { await bridge.removeMember(device.id); openMembers(); toast('设备已移除，访问授权已撤销'); }), 'member-remove');
      remove.dataset.removeDevice = device.id; row.append(remove);
    }
    return row;
  }));
}
function createMessage(message, animate) {
  const own = message.senderId === config.device.id;
  const row = element('article', `message ${own ? 'own' : ''}`); row.dataset.messageId = message.id;
  if (animate) { row.classList.add('arriving'); row.addEventListener('animationend', () => row.classList.remove('arriving'), { once: true }); }
  row.classList.toggle('file-message', message.type === 'file');
  const body = element('div', 'message-body');
  const meta = element('div', 'message-meta'); meta.append(element('span', '', message.senderName || (own ? config.device.name : '未命名设备')), element('span', '', time(message.createdAt))); body.append(meta);
  if (message.type === 'text') {
    const bubble = element('div', 'bubble text-bubble', message.text);
    bubble.addEventListener('dblclick', () => (bridge ? bridge.copy(message.text) : navigator.clipboard.writeText(message.text)).then(() => toast('文字已复制')).catch(showError)); body.append(bubble);
  } else {
    const bubble = element('div', 'bubble file-bubble'); bubble.dataset.fileId = message.id;
    if (previewable(message)) {
      bubble.classList.add('image-file-bubble');
      const preview = action('', () => openImage(message), 'file-thumbnail');
      preview.setAttribute('aria-label', `预览 ${message.fileName}`); preview.dataset.imageId = message.id;
      preview.append(fileIcon('image'), element('span', '', '点按查看图片')); bubble.append(preview);
    }
    const content = element('div', 'file-main');
    const ext = message.fileName.includes('.') ? message.fileName.split('.').pop().slice(0, 5).toUpperCase() : 'FILE';
    const details = element('div', 'file-info');
    const name = element('div', 'file-name', message.fileName); name.title = message.fileName;
    const metadata = element('div', 'file-size', fileSize(message.size));
    if (bridge && /^image\//i.test(message.mime || '') && message.size > AUTO_RECEIVE_BYTES) metadata.append(element('span', '', ' · 保存后查看图片'));
    if (bridge) metadata.append(element('span', 'drag-label'));
    details.append(name, metadata); content.append(element('div', 'file-icon', ext), details);
    const buttons = element('div', 'file-actions');
    const more = element('details', 'file-more');
    const summary = element('summary'); summary.append(fileIcon('more')); summary.title = '更多文件操作'; summary.setAttribute('aria-label', '更多文件操作');
    const menu = element('div', 'file-action-menu');
    const menuAction = (label, callback, className = '') => action(label, () => { more.open = false; summary.focus({ preventScroll: true }); return callback(); }, className);
    if (bridge) {
      menu.append(menuAction('打开文件', () => bridge.openFile(message.id)));
      menu.append(menuAction('接收到本机', () => { ready.set(message.id, 'loading'); prepareQueue.push({ id: message.id, generation: epoch }); hydrate(); renderMessages(); }, 'receive-action'));
      menu.append(menuAction('在文件夹中显示', () => bridge.revealFile(message.id)));
      const retry = menuAction('重新接收', () => { ready.set(message.id, 'loading'); prepareQueue.push({ id: message.id, generation: epoch }); hydrate(); renderMessages(); }, 'retry-action'); menu.append(retry);
    }
    menu.append(menuAction('另存为…', () => saveFile(message), 'save-action')); more.append(summary, menu); buttons.append(more);
    more.addEventListener('toggle', () => {
      if (more.open) {
        document.querySelectorAll('.file-more[open]').forEach(other => { if (other !== more) other.open = false; });
        more.classList.remove('open-below');
        if (menu.getBoundingClientRect().top < $('timeline').getBoundingClientRect().top + 3) more.classList.add('open-below');
        menu.scrollIntoView({ block: 'nearest' });
      }
      busy();
    });
    more.addEventListener('focusout', () => setTimeout(() => { if (!more.contains(document.activeElement)) more.open = false; }, 0));
    details.tabIndex = 0; details.setAttribute('role', 'button'); details.setAttribute('aria-label', previewable(message) ? `预览 ${message.fileName}` : `打开 ${message.fileName}`);
    const activate = async () => {
      if (row.classList.contains('file-expired')) return;
      try {
        if (previewable(message)) await openImage(message);
        else if (bridge) {
          ready.set(message.id, 'loading'); renderMessages();
          await bridge.prepareFile(message.id); ready.set(message.id, true); renderMessages();
          await bridge.openFile(message.id);
        } else await saveFile(message);
      } catch (error) { if (bridge && ready.get(message.id) !== true) { ready.set(message.id, /在线副本|离线|持有|unavailable|offline/i.test(error.message) ? 'waiting' : 'error'); renderMessages(); } showError(error); }
    };
    details.addEventListener('click', activate);
    details.addEventListener('keydown', event => { if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); activate(); } });
    const footer = element('div', 'file-footer'); const status = element('span', 'file-transfer-state'); const save = action('保存 ↓', () => { if (bridge && ['error', 'waiting'].includes(ready.get(message.id))) { ready.set(message.id, 'loading'); prepareQueue.push({ id: message.id, generation: epoch }); hydrate(); renderMessages(); return; } return saveFile(message); }, 'file-save-button'); footer.append(status, save, buttons); bubble.append(content, footer);
    bubble.addEventListener('dragstart', event => { event.preventDefault(); if (ready.get(message.id) === true) bridge.startDrag(message.id); });
    body.append(bubble);
  }
  row.append(body); return row;
}
function updateFile(message, row) {
  if (message.type !== 'file') return;
  const isReady = ready.get(message.id) === true, bubble = row.querySelector('.file-bubble');
  bubble.draggable = Boolean(bridge && isReady);
  bubble.title = bridge ? (isReady ? '直接拖到桌面、文件夹或其他应用' : statusFor(message)) : message.fileName;
  row.classList.toggle('file-expired', Boolean(message.deleted));
  if (message.deleted && panelKind === 'image-preview' && activePreviewId === message.id) $('panel').close();
  if (message.deleted) { bubble.draggable = false; row.querySelectorAll('.file-actions button').forEach(button => { button.disabled = true; }); }
  const transferState = row.querySelector('.file-transfer-state'); if (transferState) { transferState.textContent = message.deleted ? '文件已清理' : isReady ? '本机已就绪' : statusFor(message); transferState.classList.toggle('has-error', ['error', 'waiting'].includes(ready.get(message.id))); }
  const saveButton = row.querySelector('.file-save-button'); if (saveButton) { saveButton.disabled = Boolean(message.deleted) || ready.get(message.id) === 'loading'; saveButton.textContent = ['error', 'waiting'].includes(ready.get(message.id)) ? '重试 ↻' : '保存 ↓'; }
  const thumbnail = row.querySelector('.file-thumbnail');
  if (thumbnail) {
    thumbnail.disabled = Boolean(message.deleted);
    if (message.deleted) { thumbnail.replaceChildren(fileIcon('image'), element('span', '', '主机文件已清理')); delete thumbnail.dataset.previewState; }
    else if (isReady) loadThumbnail(message, thumbnail);
    else if (!ready.has(message.id)) visibleImages.observe(thumbnail);
  }
  const label = row.querySelector('.drag-label');
  if (label) { label.textContent = statusFor(message); label.classList.toggle('has-error', ready.get(message.id) === 'error'); }
  const receive = row.querySelector('.receive-action'); if (receive) receive.hidden = Boolean(ready.has(message.id) && !['error', 'waiting'].includes(ready.get(message.id)));
  const retry = row.querySelector('.retry-action'); if (retry) retry.hidden = !['error', 'waiting'].includes(ready.get(message.id));
}
const respondingRequests = new Set();
let requestsRevision = 0;
const requestId = request => String(request.id || request.requestId);
const requestName = request => request.device?.name || request.deviceName || request.name || '新设备';
const mayResetDevice = () => config.room.mode === 'peer' ? Boolean(config.room.canManage) : config.room.hostDeviceId === config.device.id;
async function respondToRequest(request, allow, confirmed = false) {
  if (allow && request.reset) {
    if (!mayResetDevice()) throw new Error('只有群创建者可以恢复或重置设备授权');
    if (!confirmed) return confirmOperation('恢复设备授权', `将恢复或重置「${requestName(request)}」的设备授权，原连接将失效。请确认这是你认识的设备。`, () => respondToRequest(request, true, true));
  }
  const id = requestId(request);
  if (respondingRequests.has(id)) return;
  respondingRequests.add(id); renderRequests();
  try {
    await bridge.respondJoin(id, allow);
    requestsRevision++;
    requests = requests.filter(item => requestId(item) !== id);
    toast(allow ? (request.reset ? '已恢复设备授权，原连接已失效' : '已允许设备加入') : '已拒绝这次申请');
  } finally {
    respondingRequests.delete(id); renderRequests();
    // An older in-flight poll must not put a processed request back on screen.
    if (requestsLoading) await requestsLoading.catch(() => {});
    await refreshRequests();
  }
}
function renderRequests() {
  const banner = $('join-request-banner'), first = requests[0];
  const timeline = $('timeline'), bottomGap = timeline.scrollHeight - timeline.scrollTop - timeline.clientHeight;
  const wasVisible = !banner.hidden;
  banner.hidden = !first;
  if (first) {
    const name = requestName(first), pending = respondingRequests.has(requestId(first));
    $('join-request-summary').textContent = `${name} ${first.reset ? '请求恢复设备授权' : '申请加入'}`;
    $('join-request-reset-note').hidden = !first.reset;
    $('join-request-reset-note').textContent = mayResetDevice() ? '恢复授权后原连接将失效，请核实设备身份' : '恢复授权后原连接将失效，仅群创建者可以批准';
    $('approve-join-request').textContent = first.reset ? '恢复授权' : '允许加入';
    $('join-request-summary').title = `${name} 申请加入「${groupName()}」`;
    $('view-join-requests').textContent = requests.length > 1 ? `查看全部（${requests.length}）` : '查看详情';
    for (const [id, allow] of [['deny-join-request', false], ['approve-join-request', true]]) {
      const button = $(id); button.disabled = pending || Boolean(allow && first.reset && !mayResetDevice());
      button.onclick = () => respondToRequest(first, allow).catch(showError);
    }
  }
  // Keep the latest message visible when the fixed strip appears/disappears;
  // readers elsewhere in history retain their scroll position.
  if (wasVisible !== !banner.hidden && bottomGap < 75 && !timeline.contains(document.activeElement) && !timeline.querySelector('.file-more[open]')) timeline.scrollTop = timeline.scrollHeight;
  const memberEntry = $('member-join-requests');
  if (memberEntry) { memberEntry.hidden = false; memberEntry.textContent = requests.length ? `处理加入申请（${requests.length}）` : '加入申请 · 暂无待处理'; memberEntry.classList.toggle('primary-button', requests.length > 0); memberEntry.classList.toggle('secondary-button', requests.length === 0); }
  if (panelKind !== 'requests' || !$('panel').open) return;
  const body = $('panel-body');
  const cards = requests.map(request => {
    const card = element('div', 'request-card'); card.dataset.requestId = requestId(request);
    card.append(element('strong', '', `${requestName(request)} ${request.reset ? '请求恢复设备授权' : '申请加入'}`), description(request.reset ? `恢复或重置此设备授权后，原连接将失效。${mayResetDevice() ? '请核实设备身份。' : '仅群创建者可以批准。'}` : `允许后可查看「${groupName()}」的消息和文件。`));
    const controls = element('div', 'request-actions');
    for (const [label, allow] of [['拒绝', false], ['允许加入', true]]) {
      const button = action(allow && request.reset ? '恢复设备授权' : label, () => respondToRequest(request, allow));
      button.dataset.action = allow ? 'approve-join' : 'deny-join'; button.disabled = respondingRequests.has(requestId(request)) || Boolean(allow && request.reset && !mayResetDevice()); controls.append(button);
    }
    card.append(controls); return card;
  });
  if (cards.length) body.replaceChildren(...cards); else { const empty = element('div', 'panel-empty'); empty.append(element('strong', '', '没有待处理申请'), action('返回设备', openMembers, 'secondary-button')); body.replaceChildren(empty); }
}
function openRequests() {
  openPanel('加入申请', 'requests'); renderRequests();
  refreshRequests().catch(showError);
}
function renderMessages() {
  $('file-count').textContent = String(state.messages.filter(message => message.type === 'file').length);
  $('file-count').title = '当前已加载的文件数';
  $('view-files').setAttribute('aria-label', `文件，已加载 ${$('file-count').textContent} 个`);
  $('timeline').classList.toggle('files-view', contentView === 'files');
  const timeline = $('timeline'), nearBottom = timeline.scrollHeight - timeline.scrollTop - timeline.clientHeight < 75;
  const hadMessages = messageNodes.size > 0, desired = [], kept = new Set();
  // Messages retain their DOM nodes as presence and file readiness change, preserving
  // selection, keyboard focus and an open file menu during background updates.
  if (!state.messages.some(message => contentView === 'all' || message.type === 'file')) {
    let empty = timeline.querySelector('.empty-state');
    if (!empty) {
      empty = element('div', 'empty-state'); empty.append(element('div', 'empty-mark', '⇄'), element('strong', '', '一起，传点东西'), action('选择文件', () => $('file-input').click(), 'secondary-button'));
      if (bridge?.createInvite) empty.append(action('＋ 邀请设备加入', openInvite));
    }
    empty.querySelector('strong').textContent = contentView === 'files' ? (state.history?.hasMore ? '当前记录中没有文件' : '还没有文件') : '一起，传点东西';
    desired.push(empty);
  }
  if (readingHistory) desired.push(action('返回最新记录', loadLatest, 'history-load history-latest'));
  if (state.history?.hasMore) {
    let load = timeline.querySelector('.history-load:not(.history-latest)');
    if (!load) load = action('更早记录', loadHistory, 'history-load');
    desired.push(load);
  }
  let previousDay = '';
  for (const message of state.messages) {
    if (contentView === 'files' && message.type !== 'file') { kept.add(message.id); continue; }
    const day = new Date(message.createdAt).toLocaleDateString('zh-CN');
    if (day !== previousDay) {
      let divider = Array.from(timeline.querySelectorAll('[data-day]')).find(node => node.dataset.day === day);
      if (!divider) { divider = element('div', 'date-divider'); divider.dataset.day = day; }
      divider.textContent = day === new Date().toLocaleDateString('zh-CN') ? '今天' : day; desired.push(divider); previousDay = day;
    }
    let row = messageNodes.get(message.id);
    if (!row) { row = createMessage(message, hadMessages); messageNodes.set(message.id, row); }
    row.classList.toggle('compact-file-row', contentView === 'files');
    updateFile(message, row); desired.push(row); kept.add(message.id);
  }
  for (const key of messageNodes.keys()) if (!kept.has(key)) messageNodes.delete(key);
  const desiredSet = new Set(desired);
  for (const child of Array.from(timeline.children)) if (!desiredSet.has(child)) child.remove();
  desired.forEach((node, index) => { if (timeline.children[index] !== node) timeline.insertBefore(node, timeline.children[index] || null); });
  if (nearBottom && !timeline.querySelector('.file-more[open]') && !timeline.contains(document.activeElement)) timeline.scrollTop = timeline.scrollHeight;
}
async function loadLatest() {
  const generation = epoch, latest = await api('/api/state');
  if (generation !== epoch) return;
  readingHistory = false; historyLoaded = false; applyState(latest);
  $('timeline').scrollTop = $('timeline').scrollHeight;
}
async function loadHistory() {
  if (!state.history?.hasMore || !state.history.before) return;
  const timeline = $('timeline'), before = state.history.before, height = timeline.scrollHeight;
  const button = timeline.querySelector('.history-load:not(.history-latest)'); if (button) button.disabled = true;
  const generation = epoch;
  try {
    const page = await api(`/api/history?before=${encodeURIComponent(before)}&limit=100`);
    if (generation !== epoch) return;
    state = prependHistory(state, page); readingHistory = true;
    for (const message of page.messages || []) if (message.type === 'file') observedFiles.add(message.id);
    renderMessages(); timeline.scrollTop += timeline.scrollHeight - height;
  } finally { if (button) button.disabled = false; }
}
async function saveFile(message) {
  if (bridge) { if (await bridge.saveFile(message.id)) toast('文件已保存'); return; }
  const response = await fetch(`${config.room.baseUrl}/api/files/${message.id}`, { headers: { 'X-Room-Key': config.room.key, 'X-Device-Id': config.device.id } });
  if (!response.ok) throw new Error('文件下载失败');
  const url = URL.createObjectURL(await response.blob()), anchor = document.createElement('a'); anchor.href = url; anchor.download = message.fileName; anchor.click(); setTimeout(() => URL.revokeObjectURL(url), 30000);
}
function retryConnection(generation, error) {
  if (generation !== epoch) return;
  connectionError = error?.message || '群连接未响应，请检查在线设备、网络和防火墙'; connection(false);
  if ([401, 403].includes(error?.status)) { connectionError = '此设备的授权已失效，请联系托管电脑重新批准加入'; renderConnection(); return; }
  const delay = Math.min(30000, 1000 * 2 ** Math.min(reconnectAttempt++, 5)) + Math.floor(Math.random() * 400);
  reconnectTimer = setTimeout(() => join().catch(showError), delay);
}
function cancelConnection(message) {
  ++epoch; clearTimeout(reconnectTimer); requestController.abort(); socket?.close();
  connectionError = message; connection(false);
}
async function join() {
  if (config.room.welcome) { renderWelcome(); return; }
  const generation = ++epoch; visibleImages.disconnect(); thumbnailQueue.length = 0; clearTimeout(reconnectTimer); requestController.abort(); requestController = new AbortController(); socket?.close(); ready.clear(); prepareQueue.length = 0; historyLoaded = false; connection(false);
  if (config.network && (!config.network.available || config.network.switching)) { connectionError = '所选网络已断开或正在切换，请等待连接恢复'; connection(false); return; }
  $('group-name').textContent = groupName(); $('message-input').placeholder = '传点什么…'; $('drop-label').textContent = `松开，发到「${groupName()}」`; document.title = `${groupName()} · 拾传`;
  renderMessages();
  try {
    await api('/api/join', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(config.device) });
    if (generation !== epoch) return;
    const initial = await api('/api/state'); if (generation !== epoch) return; applyState(initial);
  } catch (error) { retryConnection(generation, error); return; }
  if (generation !== epoch) return;
  const url = new URL('/api/events', config.room.baseUrl); url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:'; url.searchParams.set('key', config.room.key); url.searchParams.set('device', config.device.id); url.searchParams.set('stream', '2');
  const current = new WebSocket(url); socket = current;
  const handshake = setTimeout(() => { if (generation === epoch && current.readyState !== WebSocket.OPEN) { connectionError = '实时连接握手超时，请检查网络和托管电脑'; current.close(); } }, 8000);
  current.onopen = () => { clearTimeout(handshake); if (generation === epoch) { reconnectAttempt = 0; connectionError = ''; connection(true); } else current.close(); };
  current.onmessage = event => { if (generation !== epoch) return; try { const data = JSON.parse(event.data); if (data.type === 'state') applyState(data); } catch {} };
  current.onclose = event => { clearTimeout(handshake); if (generation === epoch) retryConnection(generation, Object.assign(new Error(connectionError || '实时连接已断开，正在重新查找在线设备'), { status: event.code === 1008 ? 403 : undefined })); };
  current.onerror = () => { if (generation === epoch) connectionError ||= '无法连接群，请检查网络和防火墙'; current.close(); };
}
async function sendText() {
  const input = $('message-input'), text = input.value.trim(); if (!text) return true; if ($('send-text').disabled || !config) return false;
  $('send-text').disabled = true;
  try { await api('/api/messages', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ text }) }); if (input.value.trim() === text) { input.value = ''; resizeComposer(); } return true; }
  catch (error) { showError(error); return false; } finally { $('send-text').disabled = false; }
}
function upload(file) {
  return new Promise(resolve => {
    if (file.size > (state.maxFileBytes || 8 * 1024 ** 3)) { toast(`${file.name} 超过当前大小上限`); resolve(false); return; }
    const row = element('div', 'upload'); row.append(element('span', 'upload-name', file.name));
    const progress = element('progress'); progress.max = 100; progress.value = 0; const percent = element('span', '', '0%'); row.append(progress, percent); $('uploads').append(row);
    const xhr = new XMLHttpRequest(); xhr.open('POST', `${config.room.baseUrl}/api/files?name=${encodeURIComponent(file.name)}`);
    xhr.setRequestHeader('X-Room-Key', config.room.key); xhr.setRequestHeader('X-Device-Id', config.device.id); xhr.setRequestHeader('Content-Type', file.type || 'application/octet-stream');
    xhr.upload.onprogress = event => { if (event.lengthComputable) { progress.value = Math.round(event.loaded / event.total * 100); percent.textContent = progress.value < 100 ? `${progress.value}%` : '确认中'; } };
    row.append(action('取消', () => xhr.abort()));
    xhr.onload = () => { if (!(xhr.status >= 200 && xhr.status < 300)) { try { toast(JSON.parse(xhr.responseText).error || '文件发送失败'); } catch { toast('文件发送失败'); } } row.remove(); resolve(xhr.status >= 200 && xhr.status < 300); };
    xhr.onerror = () => { toast(`${file.name} 发送失败，请检查连接`); row.remove(); resolve(false); }; xhr.onabort = () => { toast('已取消发送'); row.remove(); resolve(false); }; xhr.send(file);
  });
}
async function sendFiles(files) {
  if (config.room.welcome) { toast('请先创建或加入一个群'); return []; }
  if (!config || !files.length) return [];
  const successful = [];
  let leased = false, counted = false;
  try {
    if (bridge?.setTransferBusy) { await bridge.setTransferBusy(true); leased = true; }
    uploading++; counted = true; busy();
    for (const file of files) if (await upload(file)) successful.push(file);
  } catch (error) { showError(error); }
  finally { if (counted) uploading--; if (leased) await bridge.setTransferBusy(false).catch(() => {}); busy(); }
  return successful;
}
function renderImageDrafts() {
  $('image-drafts').hidden = !imageDrafts.items.length;
  $('image-draft-summary').textContent = `${imageDrafts.items.length} 张图片待发送 · Enter 发送`;
  $('image-draft-list').replaceChildren(...imageDrafts.items.map(item => {
    const card = element('div', 'image-draft'), image = element('img');
    image.src = item.url; image.alt = item.file.name; image.onerror = () => { image.hidden = true; };
    const label = element('span', '', item.file.name); label.title = item.file.name;
    const remove = action('×', () => { imageDrafts.remove(item.id); renderImageDrafts(); $('message-input').focus(); });
    remove.setAttribute('aria-label', `移除图片 ${item.file.name}`); remove.disabled = sendingComposer;
    card.append(image, label, remove); return card;
  }));
  const label = imageDrafts.items.length ? '发送图片和消息' : '发送消息';
  $('send-text').setAttribute('aria-label', label); $('send-text').title = label;
  busy();
}
async function sendComposer() {
  if (sendingComposer || !config) return;
  sendingComposer = true;
  const batch = [...imageDrafts.items];
  renderImageDrafts();
  try {
    if (!await sendText()) return;
    $('send-text').disabled = true; renderImageDrafts();
    const sent = await sendFiles(batch.map(item => item.file));
    for (const item of batch) if (sent.includes(item.file)) imageDrafts.remove(item.id);
    if (sent.length < batch.length) toast('未发送的图片已保留，可重试或移除');
  } finally { sendingComposer = false; $('send-text').disabled = false; renderImageDrafts(); }
}
window.addEventListener('paste', createImagePasteHandler({
  canPaste: event => Boolean(config && !$('panel').open && (event.target === $('message-input') || !event.target?.closest?.('input,textarea,[contenteditable]'))),
  context: () => `${epoch}:${config?.room?.id}`,
  readNative: bridge?.readClipboardImage ? () => bridge.readClipboardImage() : undefined,
  onImages: files => { imageDrafts.add(files); renderImageDrafts(); $('message-input').focus(); },
  onError: showError,
}));
window.addEventListener('beforeunload', () => imageDrafts.clear());
function closeMenu() { $('group-menu').hidden = true; $('group-menu-button').setAttribute('aria-expanded', 'false'); busy(); }
async function refreshGroups() {
  if (bridge?.listGroups) { const result = await bridge.listGroups(); groups = Array.isArray(result) ? result : result.groups || []; }
  $('group-list').replaceChildren(...groups.map(group => {
    const current = group.id === config.room.id;
    const button = action('', async () => { closeMenu(); if (!current) await bridge.openGroup(group.id); }, current ? 'active' : ''); button.dataset.groupId = group.id;
    const label = element('span', 'group-option-label');
    label.append(element('span', '', group.name || '未命名群'), element('span', 'group-origin', `${group.mode === 'peer' ? (group.canManage ? '本机创建 · 多设备群' : '已加入 · 多设备群') : group.local ? '本机托管' : '其他电脑托管'} · ${group.id.slice(0, 6)}${group.online === false ? ' · 离线' : ''}`));
    button.append(animalImage(group), label, element('small', '', current ? '当前群' : '↗')); return button;
  }));
}
function openPanel(title, kind) {
  closeMenu(); clearInterval(inviteTimer); $('panel').classList.toggle('image-preview-panel', kind === 'image-preview'); panelKind = kind; $('panel').dataset.kind = kind; $('panel').dataset.panelKind = kind; $('panel-title').textContent = title; $('panel-body').replaceChildren();
  if (!$('panel').open) $('panel').showModal(); busy(); return $('panel-body');
}
function taskSection(title, ...nodes) {
  const section = element('section', 'task-section'); section.append(element('h3', 'task-heading', title), ...nodes.filter(Boolean)); return section;
}
function taskDisclosure(title, ...nodes) {
  const section = element('details', 'task-disclosure'); section.append(element('summary', '', title), ...nodes.filter(Boolean)); return section;
}
function description(text) { return element('p', 'panel-description', text); }
function input(placeholder, id, value = '') { const field = element('input', 'panel-input'); field.id = id; field.placeholder = placeholder; field.value = value; return field; }
let inviteGeneration = 0;
async function openInvite() {
  if (!bridge?.createInvite) { toast('请在客户端生成邀请码'); return; }
  const generation = ++inviteGeneration;
  const body = openPanel('邀请设备', 'invite');
  body.append(description('正在生成邀请码…'));
  const result = await bridge.createInvite();
  if (generation !== inviteGeneration || panelKind !== 'invite' || !$('panel').open) return;
  renderInvite(result);
}
function renderInvite(result) {
  const body = openPanel('邀请设备', 'invite');
  const code = element('div', 'invite-code', result.code); code.id = 'invite-code';
  const expiry = element('div', 'invite-expiry');
  const { address, port } = invitationAddress(result.baseUrl);
  const endpoint = element('div', 'invite-endpoint');
  for (const [label, value, id] of [['地址', address, 'invite-address'], ['端口', port, 'invite-port']]) { const item = element('div', 'invite-endpoint-field'); const text = element('strong', '', value); text.id = id; item.append(element('span', 'field-label', label), text); endpoint.append(item); }
  const controls = element('div', 'invite-actions');
  const copy = action('复制邀请信息', async () => { await bridge.copy(invitationText(result)); copy.textContent = '已复制'; }, 'primary-button', 'copy-invite');
  const renew = action('重新生成', async () => { renew.disabled = true; try { await openInvite(); } finally { renew.disabled = false; } }, 'secondary-button', 'renew-invite');
  controls.append(copy, renew);
  const expiresAt = Number(result.expiresAt) || new Date(result.expiresAt).getTime();
  const tick = () => { const seconds = Math.max(0, Math.ceil((expiresAt - Date.now()) / 1000)); expiry.textContent = seconds ? `一次有效 · ${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')} 后失效` : '邀请码已过期，请重新生成'; copy.disabled = !seconds; };
  tick(); inviteTimer = setInterval(tick, 1000);
  const identity = element('div', 'invite-identity'); identity.append(animalImage(config.room), element('strong', '', groupName())); body.append(identity, code, expiry, controls, taskDisclosure('连接地址', endpoint));
  if (result.qrDataUrl) body.append(action('扫码加入 ›', () => {
    const qrBody = openPanel('扫码加入', 'invite-qr'); const qr = element('img', 'invite-qr'); qr.src = result.qrDataUrl; qr.alt = '邀请二维码'; qr.width = 152; qr.height = 152;
    const remaining = element('div', 'invite-expiry');
    const qrTick = () => { const seconds = Math.max(0, Math.ceil((expiresAt - Date.now()) / 1000)); remaining.textContent = seconds ? `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')} 后失效` : '邀请码已失效'; qr.classList.toggle('is-expired', !seconds); }; qrTick(); inviteTimer = setInterval(qrTick, 1000);
    qrBody.append(element('strong', 'qr-group-name', groupName()), qr, element('div', 'invite-code compact-code', result.code), remaining, action('返回邀请信息', () => renderInvite(result), 'secondary-button'));
  }, 'invite-scan'));
}
function openCreate() {
  if (!bridge?.createGroup) { toast('请在客户端创建群聊'); return; }
  const body = openPanel('创建群聊', 'create'); let index = 1; while (groups.some(group => group.name === `传输群 ${index}`)) index++;
  const name = input('群名称，例如：工作资料', 'new-group-name', `传输群 ${index}`); name.maxLength = 40;
  const picker = animalPicker(nextAnimal(groups));
  const submit = action('创建群聊', async () => {
    if (!name.value.trim()) { name.focus(); return; } submit.disabled = true;
    try { await bridge.createGroup(name.value.trim(), picker.dataset.value); $('panel').close(); await refreshGroups(); } finally { submit.disabled = false; }
  }, 'primary-button', 'confirm-create-group');
  body.append(fieldLabel('群名称', name), taskSection('选一个群伙伴', picker), submit); name.onkeydown = event => { if (event.key === 'Enter' && !event.isComposing) submit.click(); }; name.focus(); name.select();
}
function openJoin() {
  if (pendingTicket) { openPending(pendingTicket); return; }
  if (!bridge?.joinAt) { toast('请在客户端加入群聊'); return; }
  const body = openPanel('加入群聊', 'join'); let invitedGroupId, invitedFields;
  const code = input('输入 6 位邀请码', 'join-code'); code.classList.add('code-input'); code.maxLength = 6; code.inputMode = 'numeric'; code.autocomplete = 'off'; code.setAttribute('aria-label', '6 位邀请码');
  const address = input('192.168.1.23', 'join-address'); address.autocomplete = 'off'; address.setAttribute('aria-label', '设备地址');
  const port = input('51854', 'join-port'); port.inputMode = 'numeric'; port.maxLength = 5; port.setAttribute('aria-label', '端口');
  const clearInvitationIdentity = () => { invitedGroupId = undefined; invitedFields = undefined; };
  const applyInvitation = text => {
    const parsed = parseInvitation(text); if (!parsed) return false;
    code.value = parsed.code; address.value = parsed.baseUrl.startsWith('https:') ? `https://${parsed.address}` : parsed.address; port.value = parsed.port;
    invitedGroupId = parsed.groupId; invitedFields = { code: parsed.code, origin: new URL(parsed.link).origin };
    return true;
  };
  const parseAddress = () => {
    if (applyInvitation(address.value)) return;
    if (!address.value.includes(':')) return;
    const raw = address.value.trim(), parsed = invitationAddress(raw);
    const authority = raw.replace(/^https?:\/\//i, '').split(/[/?#]/)[0];
    address.value = parsed.baseUrl.startsWith('https:') ? `https://${parsed.address}` : parsed.address;
    if (/:\d+$/.test(authority) || !port.value.trim()) port.value = parsed.port;
  };
  code.oninput = () => { clearInvitationIdentity(); code.value = code.value.replace(/\D/g, '').slice(0, 6); };
  address.addEventListener('change', () => { try { parseAddress(); } catch (error) { showError(error); } });
  address.oninput = clearInvitationIdentity;
  port.oninput = () => { clearInvitationIdentity(); port.value = port.value.replace(/\D/g, '').slice(0, 5); };
  for (const field of [address, port, code]) field.addEventListener('paste', event => { try { if (applyInvitation(event.clipboardData.getData('text'))) event.preventDefault(); } catch (error) { event.preventDefault(); showError(error); } });
  const fields = element('div', 'join-endpoint'); fields.append(fieldLabel('地址', address), fieldLabel('端口', port));
  const submit = action('申请加入', async () => {
    parseAddress(); const link = invitationUrl(address.value.trim(), port.value, code.value); const base = new URL(link).origin;
    const groupId = invitedFields?.code === code.value && invitedFields.origin === base ? invitedGroupId : undefined;
    submit.disabled = true;
    try { openPending(await bridge.joinAt(base, code.value, groupId)); } finally { submit.disabled = false; }
  }, 'primary-button', 'confirm-join-group');
  body.append(action('粘贴邀请信息', async () => { const text = await bridge.readClipboardText(); if (!applyInvitation(text)) throw new Error('剪贴板中没有完整邀请信息'); }, 'join-paste-button'), fieldLabel('邀请码', code), fields, submit);
  nearbyRefresh = null; code.onkeydown = event => { if (event.key === 'Enter' && !event.isComposing) submit.click(); }; code.focus();
}
function openPending(ticket) {
  pendingTicket = ticket; clearTimeout(pendingTimer);
  const body = openPanel('等待对方允许', 'pending'); body.append(element('div', 'pending-icon', '◷'), element('p', 'pending-title', '加入申请已发出'), description(`等待「${ticket.groupName || '对方群'}」批准。`));
  const status = element('p', 'panel-description'); status.id = 'join-status'; body.append(status);
  const poll = async () => {
    if (pendingTicket !== ticket) return;
    try {
      const result = await bridge.checkJoin(ticket);
      if (result.status === 'approved') { pendingTicket = null; if (panelKind === 'pending') $('panel').close(); await refreshGroups(); toast('已加入，新群窗口已打开'); return; }
      if (result.status === 'denied' || result.status === 'expired') { pendingTicket = null; const message = result.status === 'denied' ? '这次申请被拒绝了。' : '申请已过期，请获取新的邀请码。'; status.textContent = message; if (panelKind === 'pending') body.append(action('重新输入邀请码', openJoin, 'primary-button')); else toast(message); return; }
      status.textContent = '等待在线成员回应';
    } catch (error) { status.textContent = '暂时无法连接，正在重试…'; if (ticket.expiresAt && Date.now() > ticket.expiresAt) { pendingTicket = null; status.textContent = '申请已过期，请获取新的邀请码。'; return; } }
    pendingTimer = setTimeout(poll, 1800);
  }; poll();
}

let networkPanelEpoch = 0;
const networkType = type => ({ wifi: 'Wi-Fi', ethernet: '有线网络', vpn: 'VPN', virtual: '虚拟网卡', unknown: '网络' }[type] || '网络');
function networkState(next) {
  if (!config) return; config.network = next;
  if (next && (next.switching || !next.available)) cancelConnection(next.switching ? '正在切换网络，请等待重新连接' : '所选网络已断开，请检查网络设置');
  const label = $('network-offline'), selected = next?.selected;
  label.hidden = !bridge || Boolean(next?.available && !next?.switching);
  label.classList.toggle('is-offline', !next?.available);
  label.textContent = next?.switching ? '正在切换网络…' : next?.available && selected ? `${networkType(selected.type)} · ${selected.address} ▾` : '所选网络已断开 · 选择网络 ▾';
  label.title = selected ? `${networkType(selected.type)} · ${selected.name} · ${selected.cidr || selected.address}` : '选择已连接的 Wi-Fi 或有线网络';
  label.setAttribute('aria-label', `${label.textContent.replace(' ▾', '')}，打开网络设置`);
}
async function openNetwork() {
  if (!bridge?.getNetwork) return;
  const generation = ++networkPanelEpoch, body = openPanel('网络连接', 'network'); body.append(description('正在读取已连接的网卡…'));
  const next = await bridge.getNetwork();
  if (panelKind !== 'network' || generation !== networkPanelEpoch) return;
  networkState(next); body.replaceChildren();
  const selected = next.selected;
  const current = element('div', 'network-current');
  current.append(element('strong', '', selected ? `${networkType(selected.type)} · ${selected.name}` : '尚未选择网络'), element('span', '', selected ? `${selected.cidr || selected.address} · ${next.available ? '已连接' : '已断开'}` : '请连接 Wi-Fi 或有线网络'));
  body.append(current);
  if (next.discoveryError) body.append(element('p', 'connection-warning', `自动发现受限：${next.discoveryError}。可通过邀请链接或电脑地址连接。`));
  const form = element('div', 'network-options');
  const row = (value, label, detail, checked) => {
    const line = element('label', 'network-option'), radio = document.createElement('input'); radio.type = 'radio'; radio.name = 'pickdrop-network'; radio.value = value; radio.checked = checked;
    const words = element('span'); words.append(element('strong', '', label), element('small', '', detail)); line.append(radio, words); return line;
  };
  form.append(row('auto', '自动选择', 'Wi-Fi / 有线网络', next.selection.mode === 'auto'));
  const physical = next.interfaces.filter(item => !item.virtual), virtual = next.interfaces.filter(item => item.virtual);
  const choice = item => row(item.id, `${networkType(item.type)} · ${item.name}`, `${item.cidr || item.address}${!item.cidr && item.netmask ? ` · 子网掩码 ${item.netmask}` : ''}${item.description ? ` · ${item.description}` : ''}`, next.selection.mode === 'manual' && selected?.id === item.id);
  physical.forEach(item => form.append(choice(item)));
  if (virtual.length) { const details = element('details', 'network-virtual'), summary = element('summary', '', `VPN / 虚拟网络（${virtual.length}）`); details.append(summary); virtual.forEach(item => details.append(choice(item))); if (selected?.virtual && next.selection.mode === 'manual') details.open = true; form.append(details); }
  body.append(form);
  const apply = action('应用所选网络', async () => {
    const selectedRadio = form.querySelector('input:checked'); if (!selectedRadio) return;
    if (uploading || next.transferBusy) { toast('有文件正在传输，请完成或取消后再切换'); return; }
    apply.disabled = true;
    try { const result = await bridge.setNetwork(selectedRadio.value === 'auto' ? { mode: 'auto' } : { mode: 'manual', id: selectedRadio.value }); networkState(result); toast(result.available ? `已使用 ${result.selected.name} · ${result.selected.address}` : '暂无可用网络'); if (panelKind === 'network') await openNetwork(); }
    finally { apply.disabled = false; }
  }, 'primary-button', 'apply-network');
  body.append(apply, action('刷新网络列表', openNetwork, 'secondary-button'));
}

function confirmOperation(title, text, callback) {
  const previous = panelKind; const body = openPanel(title, 'confirm'); body.append(element('p', 'task-risk', text));
  const submit = action('确认', async () => { submit.disabled = true; try { await callback(); if (panelKind === 'confirm') $('panel').close(); } finally { submit.disabled = false; } }, 'primary-button', 'confirm-operation');
  body.append(submit, action('取消', () => { if (previous === 'storage') return openStorage(); if (previous === 'requests') return openRequests(); if (previous === 'diagnostic') return openConnectionDiagnostic(); return openMembers(); }, 'secondary-button'));
}
function openConnectionDiagnostic() {
  const body = openPanel('连接诊断', 'diagnostic');
  appendHostedGroupInfo(body);
  const facts = element('dl', 'diagnostic-facts'); for (const [label, value] of [['状态', connectionError || '已连接'], ['群', groupName()], ['地址', config?.room?.baseUrl || '尚未发现']]) { facts.append(element('dt', '', label), element('dd', '', value)); } body.append(facts, action('重新连接', async () => { reconnectAttempt = 0; connectionError = ''; $('panel').close(); await join(); }, 'primary-button', 'retry-connection'));
  if (bridge?.getNetwork) body.append(action('网络连接设置', openNetwork, 'secondary-button'));
  if (bridge?.reconnectGroup && !config.room.welcome) { const address = input('已配对设备地址 IP:端口', 'repair-address'); body.append(taskSection('连接已配对设备', fieldLabel('地址 IP:端口', address)), action('连接此设备', async () => { await bridge.reconnectGroup(address.value.trim()); await groupsChanged(); await join(); toast('连接地址已更新'); }, 'secondary-button', 'repair-connection')); }
}
function openMembers() {
  if (config.room.welcome) return openCreate();
  const body = openPanel(`${groupName()} · 设备`, 'members');
  appendHostedGroupInfo(body);
  body.append(action('连接诊断与手动连接', openConnectionDiagnostic, 'secondary-button', 'connection-diagnostic'));
  if (bridge?.listJoinRequests) body.append(action(`处理加入申请（${requests.length}）`, openRequests, 'primary-button', 'member-join-requests'));
  if (config.room.local && config.room.mode !== 'peer' && Number(config.room.authVersion) !== 2 && !bridge?.upgradeGroup && bridge?.secureMembers) {
    body.append(description('此旧群使用共享授权。先升级为每设备授权，才能真正撤销设备访问。升级会使现有设备离线，需要重新申请并批准加入；历史消息与文件保留。'), action('升级设备授权', () => confirmOperation('升级此群授权', '升级后全部现有成员需要重新申请并由托管电脑批准。历史消息与文件保留。确认后才能移除设备并撤销访问。', async () => { const room = await bridge.secureMembers(); if (room?.id === config.room.id) config.room = room; await groupsChanged(); await join(); openMembers(); }), 'secondary-button', 'secure-members'));
  }
  const devices = element('div'); devices.id = 'devices'; body.append(devices);
  if ((!config.room.local || config.room.mode === 'peer') && bridge?.leaveGroup) {
    body.append(action('退出此群', () => confirmOperation('退出此群', '退出并移除这台设备的本地群关系。已另存文件保留；重新加入需要新的邀请。', () => bridge.leaveGroup()), 'secondary-button', 'leave-group'), action('忘记此群', () => confirmOperation('忘记此群', '仅移除本机连接和接收缓存，不保证撤销其他设备保存的授权。已另存文件不受影响。', () => bridge.forgetGroup()), 'secondary-button', 'forget-group'));
  }
  if (bridge?.renameGroup && (config.room.canManage || config.room.mode !== 'peer' && config.room.local)) {
    const groupInput = input('群名称', 'rename-group-name', groupName()); groupInput.maxLength = 40;
    const picker = animalPicker(groupAnimal(config.room)); body.append(fieldLabel('群名称', groupInput), element('div', 'field-label', '群动物'), picker, action('保存群设置', async () => { await bridge.renameGroup(groupInput.value, picker.dataset.value); await groupsChanged(); $('group-name').textContent = groupName(); toast('群名称已保存'); }, 'secondary-button', 'rename-group'));
    body.append(action('解散此群', () => confirmOperation('解散此群', '此操作会结束整个群，其他成员收到同步后也将无法继续使用。已保存的文件不会自动删除。', () => bridge.deleteGroup()), 'secondary-button', 'delete-group'));
  }
  if (bridge?.createInvite) body.append(action('＋ 邀请设备', openInvite, 'primary-button'));
  const settings = element('div', 'device-settings'); const label = element('label', '', '这台设备的名字'); label.htmlFor = 'device-name'; const name = input('设备名称', 'device-name', config.device.name); name.maxLength = 40;
  settings.append(label, name, action('保存设备名称', async () => {
    if (!name.value.trim()) return;
    if (bridge) { const result = await bridge.rename(name.value.trim()); config.device = result.device || { ...config.device, name: name.value.trim() }; }
    else { config.device.name = name.value.trim(); localStorage.setItem('pickdrop-device', JSON.stringify(config.device)); }
    await api('/api/join', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(config.device) }); toast('设备名称已保存');
  }, 'secondary-button', 'rename-device')); body.append(settings); if (bridge?.getNetwork) body.append(action('网络连接设置', openNetwork, 'secondary-button')); renderDevices(); renderRequests();
  // Devices remain primary; infrequent identity and destructive actions get explicit sections.
  const mainDevices = $('devices'); mainDevices.before(element('h3', 'task-heading', '群内设备'));
  const rename = $('rename-group');
  if (rename) { const picker = rename.previousElementSibling; const animalLabel = picker.previousElementSibling; const field = animalLabel.previousElementSibling; body.append(taskDisclosure('群名称与伙伴', field, animalLabel, picker, rename)); }
  const settingsNode = body.querySelector('.device-settings'); if (settingsNode) body.append(taskDisclosure('本机名称', settingsNode));
  const danger = ['leave-group', 'forget-group', 'delete-group'].map($).filter(Boolean); if (danger.length) { danger.forEach(node => node.classList.add('danger-action')); body.append(taskDisclosure('退出与移除', ...danger)); }
  const diagnostic = $('connection-diagnostic'); if (diagnostic) body.append(diagnostic);
}
async function openStorage() {
  closeMenu();
  if (!bridge?.getStorage) { toast('存储管理需要桌面客户端'); return; }
  const body = openPanel('存储与清理', 'storage'); body.append(description('正在读取存储…'));
  const info = await bridge.getStorage();
  if (panelKind !== 'storage') return; body.replaceChildren();
  const summary = element('div', 'storage-summary');
  const metrics = config.room.mode === 'peer' ? [['接收缓存', info.cache]] : [['接收缓存', info.cache], ['本机托管', info.hosted]];
  summary.classList.toggle('single-stat', metrics.length === 1);
  for (const [label, value] of metrics) {
    const card = element('div', 'storage-stat'); card.append(element('strong', '', fileSize(value?.bytes || 0)), element('small', '', `${label} · ${value?.files || 0} 个文件`)); summary.append(card);
  }
  body.append(summary);

  body.append(action('清理接收缓存', () => confirmOperation('清理接收缓存', '已另存的文件不受影响，正在使用的缓存会保留。', async () => { await bridge.clearCache(); if (!config.room.local) { ready.clear(); prepareQueue.length = 0; } renderMessages(); toast('接收缓存已清理'); await openStorage(); }), 'primary-button'));
  if (info.cache?.maxBytes) body.append(description(`缓存上限 ${fileSize(info.cache.maxBytes)} · 最长 ${info.cache.maxAgeDays || 7} 天`));
  if (config.room.local && config.room.mode !== 'peer' && bridge.listHostFiles) {
    body.append(element('p', 'task-risk', '清理主机原件后，全群将无法再次下载。'));
    const selected = new Set(), list = element('div', 'storage-files');
    let before, loading = false;
    const more = action('更多主机文件', fetchFiles, 'secondary-button');
    async function fetchFiles() {
      if (loading) return; loading = true; more.disabled = true;
      try {
        const page = await bridge.listHostFiles(before ? {before} : {}); if (panelKind !== 'storage') return;
        const files = Array.isArray(page) ? page : page.files || [];
        for (const file of files) {
          const row = element('label', 'storage-file'), checkbox = element('input'); checkbox.type = 'checkbox';
          checkbox.onchange = () => { if (checkbox.checked) selected.add(file.id); else selected.delete(file.id); remove.disabled = !selected.size; };
          const name = element('span', '', file.fileName || file.name); name.title = file.fileName || file.name;
          row.append(checkbox, name, element('small', '', fileSize(file.size || 0))); list.append(row);
        }
        before = page.before || (files.length ? String(files.at(-1).sequence) : undefined);
        more.hidden = !(page.hasMore ?? files.length === 100);
      } finally { loading = false; more.disabled = false; }
    }
    const remove = action('清理所选主机文件', () => confirmOperation('清理主机原文件', `将清理 ${selected.size} 个文件。其他成员将不能从主机下载这些文件，请先确认需要的文件已另存。`, async () => { await bridge.deleteHostFiles([...selected]); toast('所选文件已清理'); await openStorage(); }), 'secondary-button'); remove.disabled = true;
    body.append(list, more, remove); await fetchFiles();
  }
}
async function refreshRequests() {
  if (!bridge?.listJoinRequests || config?.room?.welcome) return;
  if (requestsLoading) return requestsLoading;
  const revision = requestsRevision;
  requestsLoading = (async () => {
    const result = await bridge.listJoinRequests();
    const next = Array.isArray(result) ? result : result.requests || [];
    if (revision === requestsRevision && JSON.stringify(next) !== JSON.stringify(requests)) { requests = next; renderRequests(); }
  })().finally(() => { requestsLoading = false; });
  return requestsLoading;
}
function renderWelcome() {
  renderGroupMode();
  $('group-name').textContent = '拾传'; $('device-summary').textContent = '创建或加入一个群'; $('connection-status').textContent = '尚未加入';
  $('composer').hidden = true; $('content-tabs').hidden = true; for (const id of ['invite-members', 'view-members', 'storage-settings', 'group-settings']) $(id).hidden = true;
  const empty = element('div', 'empty-state welcome-state'); const mark = element('img', 'welcome-animal'); mark.src = '/assets/app-icon.svg'; mark.alt = ''; const choices = element('div', 'welcome-actions'); choices.append(action('创建一个群', openCreate, 'primary-button'), action('加入已有群', openJoin, 'secondary-button')); empty.append(mark, element('strong', '', '文件，见面就传。'), choices); $('timeline').replaceChildren(empty);
}
async function groupsChanged() {
  if (groupsLoading) { groupsDirty = true; return; }
  groupsLoading = true;
  try {
    const next = await bridge.bootstrap(), room = next.group || next.room;
    const reconnect = room.id === config.room.id && (room.baseUrl !== config.room.baseUrl || room.key !== config.room.key || (!online && room.online !== false));
    // The native window owns this group. Never replace it with a newly joined group.
    if (room.id === config.room.id) { config.room = room; config.device = next.device; }
    await refreshGroups(); renderGroupMode();
    renderGroupAnimal(); $('group-name').textContent = groupName(); document.title = `${groupName()} · 拾传`;
    if (reconnect) await join();
  } finally { groupsLoading = false; if (groupsDirty) { groupsDirty = false; void groupsChanged().catch(showError); } }
}
function windowState(next) {
  config.window = { ...config.window, ...next }; $('pin-button').setAttribute('aria-pressed', String(Boolean(config.window.pinned))); $('dock-button').setAttribute('aria-pressed', String(Boolean(config.window.edge || config.window.docked)));
}
async function boot() {
  if (bridge) { config = await bridge.bootstrap(); config.room = config.group || config.room; groups = config.groups || []; }
  else {
    let room; try { room = parseRoomLink(location.href); } catch { $('device-summary').textContent = '请使用桌面端提供的连接地址'; return; }
    let device; try { device = JSON.parse(localStorage.getItem('pickdrop-device') || 'null'); } catch {}
    if (!device) { device = { id: crypto.randomUUID(), name: '浏览器设备', kind: 'web' }; localStorage.setItem('pickdrop-device', JSON.stringify(device)); }
    config = { device, room: { ...room, local: false, name: '我的文件' }, window: {} };
  }
  document.body.dataset.platform = config.platform || 'web'; windowState(config.window || {}); networkState(config.network);
  bridge?.onCacheCleared?.(event => { if (!config.room.local && (!event?.groupId || event.groupId === config.room.id)) { ready.clear(); prepareQueue.length = 0; renderMessages(); } });
  bridge?.onDiscoveryError?.(error => { config.discoveryError = error; if (panelKind === 'join') nearbyRefresh?.()?.catch(showError); });
  bridge?.onNearbyChanged?.(() => { if (panelKind === 'join') nearbyRefresh?.()?.catch(showError); });
  bridge?.onNetworkChanged?.(next => { networkState(next); if (panelKind === 'network') openNetwork().catch(showError); });
  bridge?.onGroupsChanged?.(() => groupsChanged().catch(showError)); bridge?.onJoinRequestsChanged?.(() => refreshRequests().catch(showError)); bridge?.onWindowChanged?.(windowState);
  renderGroupAnimal(); await refreshGroups(); try { await join(); await refreshRequests(); } catch (error) { showError(error); connection(false); }
  // Remote group requests arrive over HTTP; native change events only cover local hosts.
  if (config.inviteOnOpen) await openInvite();
  setInterval(() => { if (document.visibilityState === 'visible' && !config.window?.collapsed) refreshRequests().catch(() => {}); }, 2500);
}
$('hosted-group-notice').onclick = openMembers;
$('connection-status').onclick = event => { if (connectionError) { event.stopPropagation(); openConnectionDiagnostic(); } };
$('group-menu-button').onclick = async () => { if (!config) return; if (!$('group-menu').hidden) { closeMenu(); return; } $('group-menu').hidden = false; $('group-menu-button').setAttribute('aria-expanded', 'true'); busy(); try { await refreshGroups(); } catch (error) { showError(error); } };
$('group-settings').onclick = openMembers;
$('storage-settings').onclick = () => openStorage().catch(showError);
$('composer-storage').onclick = () => openStorage().catch(showError);
$('invite-tab').onclick = () => openInvite().catch(showError);
for (const [id, view] of [['view-all', 'all'], ['view-files', 'files']]) $(id).onclick = () => { contentView = view; for (const [key, value] of [['view-all', 'all'], ['view-files', 'files']]) { $(key).classList.toggle('selected', value === view); $(key).setAttribute('aria-pressed', String(value === view)); } renderMessages(); };
$('network-settings').onclick = () => openNetwork().catch(showError); $('network-offline').onclick = () => openNetwork().catch(showError);
$('create-group').onclick = openCreate; $('join-group').onclick = openJoin; $('invite-members').onclick = () => openInvite().catch(showError); $('view-members').onclick = openMembers; $('members-button').onclick = () => { if (config) openMembers(); };
$('view-join-requests').onclick = openRequests;
$('close-panel').onclick = () => $('panel').close(); $('panel').addEventListener('close', () => { panelKind = ''; activePreviewId = null; previewGeneration++; $('panel-body').replaceChildren(); clearInterval(inviteTimer); busy(); });
$('panel').addEventListener('click', event => { if (event.target === $('panel')) { const rect = $('panel').getBoundingClientRect(); if (event.clientX < rect.left || event.clientX > rect.right || event.clientY < rect.top || event.clientY > rect.bottom) $('panel').close(); } });
$('choose-file').onclick = async () => {
  try { await bridge?.setNativeDialogBusy?.(true); $('file-input').click(); }
  catch (error) { bridge?.setNativeDialogBusy?.(false); showError(error); }
};
$('file-input').addEventListener('cancel', () => bridge?.setNativeDialogBusy?.(false));
$('file-input').onchange = event => { bridge?.setNativeDialogBusy?.(false); sendFiles(Array.from(event.target.files)); event.target.value = ''; };
function resizeComposer() {
  const input = $('message-input');
  input.style.height = '25px';
  const limit = window.innerHeight <= 380 ? 54 : 90;
  input.style.height = `${Math.min(limit, Math.max(25, input.scrollHeight))}px`;
  input.style.overflowY = input.scrollHeight > limit ? 'auto' : 'hidden';
}
$('message-input').addEventListener('input', resizeComposer);
window.addEventListener('resize', resizeComposer);
$('composer').onsubmit = event => { event.preventDefault(); sendComposer().catch(showError); }; $('message-input').onkeydown = event => { if (event.key === 'Enter' && !event.shiftKey) { event.preventDefault(); if (!event.isComposing) sendComposer().catch(showError); } };
$('pin-button').onclick = async () => { try { const next = await bridge?.pin?.(!config.window.pinned); if (next) windowState(next); } catch (error) { showError(error); } };
$('dock-button').onclick = () => { closeMenu(); document.activeElement?.blur(); bridge?.dock?.(); }; $('close-button').onclick = () => bridge?.close?.();
document.addEventListener('pointerdown', event => { document.querySelectorAll('.file-more[open]').forEach(menu => { if (!menu.contains(event.target)) menu.open = false; }); if (!$('group-menu').contains(event.target) && !$('group-menu-button').contains(event.target)) closeMenu(); });
document.addEventListener('keydown', event => { if (event.key === 'Escape') { closeMenu(); document.querySelectorAll('.file-more[open]').forEach(menu => { menu.open = false; menu.querySelector('summary').focus({ preventScroll: true }); }); } }); document.addEventListener('focusin', busy); document.addEventListener('focusout', () => setTimeout(busy, 0));
// Native file drags can restore Chromium's keyboard focus to the first button.
// Keep that focus accessible, but only paint its ring after keyboard navigation.
const pointerFocus = () => { document.documentElement.dataset.focusInput = 'pointer'; };
window.addEventListener('pointerdown', pointerFocus, true);
window.addEventListener('dragenter', pointerFocus, true);
window.addEventListener('keydown', event => {
  if (event.key === 'Tab' || event.key.startsWith('Arrow')) document.documentElement.dataset.focusInput = 'keyboard';
}, true);
window.addEventListener('dragenter', event => { if (event.dataTransfer?.types.includes('Files')) { event.preventDefault(); dropDepth++; busy(); bridge?.expand?.(); $('drop-overlay').hidden = false; } });
window.addEventListener('dragover', event => { if (event.dataTransfer?.types.includes('Files')) { event.preventDefault(); event.dataTransfer.dropEffect = 'copy'; } });
window.addEventListener('dragleave', () => { dropDepth--; if (dropDepth <= 0) { dropDepth = 0; $('drop-overlay').hidden = true; busy(); } });
window.addEventListener('drop', event => { event.preventDefault(); dropDepth = 0; $('drop-overlay').hidden = true; if (event.dataTransfer?.files.length) { const files = Array.from(event.dataTransfer.files), allowed = bridge?.allowedDropIndexes?.(); sendFiles(Array.isArray(allowed) ? allowed.map(index => files[index]).filter(Boolean) : files); } busy(); });
window.addEventListener('dragend', () => { dropDepth = 0; $('drop-overlay').hidden = true; busy(); });
window.addEventListener('blur', () => { dropDepth = 0; $('drop-overlay').hidden = true; busy(); });
window.addEventListener('focus', busy);
boot().catch(showError);

// Keyboard commands stay immediate; pointer-triggered panels keep spatial feedback.
document.addEventListener('keydown', () => { document.documentElement.dataset.inputModality = 'keyboard'; }, true);
document.addEventListener('pointerdown', () => { document.documentElement.dataset.inputModality = 'pointer'; }, true);

bridge?.onNativeDrag?.(id => { for (const card of document.querySelectorAll('.file-bubble')) card.classList.toggle('native-dragging', Boolean(id && card.dataset.fileId === id)); });
