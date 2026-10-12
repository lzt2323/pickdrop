const { contextBridge, ipcRenderer } = require('electron');
const { webUtils } = require('electron');
const subscribe = channel => callback => {
  if (typeof callback !== 'function') throw new TypeError('callback must be a function');
  const listener = (_event, value) => callback(value);
  ipcRenderer.on(channel, listener);
  return () => ipcRenderer.removeListener(channel, listener);
};
let allowedDropIndexes = null;
contextBridge.exposeInMainWorld('pickdrop', {
  allowedDropIndexes: () => allowedDropIndexes,
  bootstrap: () => ipcRenderer.invoke('app:bootstrap'),
  listGroups: () => ipcRenderer.invoke('group:list'),
  createGroup: (name, animalId) => ipcRenderer.invoke('group:create', name, animalId),
  openGroup: id => ipcRenderer.invoke('group:open', id),
  joinGroup: code => ipcRenderer.invoke('group:join', code),
  joinAt: (address, code, groupId) => ipcRenderer.invoke('group:join-at', address, code, groupId),
  listNearby: () => ipcRenderer.invoke('group:nearby'),
  discoveryStatus: () => ipcRenderer.invoke('group:discovery-status'),
  onDiscoveryError: subscribe('discovery:error'),
  renameGroup: (name, animalId) => ipcRenderer.invoke('group:rename', name, animalId),
  upgradeGroup: () => ipcRenderer.invoke('group:upgrade'),
  reconnectGroup: address => ipcRenderer.invoke('group:reconnect', address),
  deleteGroup: () => ipcRenderer.invoke('group:delete'),
  onNearbyChanged: subscribe('nearby:changed'),
  removeMember: id => ipcRenderer.invoke('group:remove-member', id),
  secureMembers: () => ipcRenderer.invoke('group:secure-members'),
  leaveGroup: () => ipcRenderer.invoke('group:leave'),
  forgetGroup: () => ipcRenderer.invoke('group:forget'),
  getStorage: () => ipcRenderer.invoke('storage:get'),
  clearCache: () => ipcRenderer.invoke('storage:clear-cache'),
  listHostFiles: options => ipcRenderer.invoke('storage:host-files', options),
  deleteHostFiles: ids => ipcRenderer.invoke('storage:delete-host-files', ids),
  onCacheCleared: subscribe('storage:cache-cleared'),
  getNetwork: () => ipcRenderer.invoke('network:get'),
  setNetwork: value => ipcRenderer.invoke('network:set', value),
  setTransferBusy: value => ipcRenderer.invoke('transfer:busy', value),
  onNetworkChanged: subscribe('network:changed'),
  checkJoin: ticket => ipcRenderer.invoke('group:check', ticket),
  createInvite: () => ipcRenderer.invoke('group:invite'),
  listJoinRequests: () => ipcRenderer.invoke('group:requests'),
  respondJoin: (id, allow) => ipcRenderer.invoke('group:respond', id, allow),
  rename: name => ipcRenderer.invoke('app:rename', name),
  readClipboardText: () => ipcRenderer.invoke('app:clipboard-text'),
  copy: text => ipcRenderer.invoke('app:copy', text),
  readClipboardImage: () => ipcRenderer.invoke('app:clipboard-image'),
  previewFile: (id, full = false) => ipcRenderer.invoke('file:preview', id, full),
  prepareFile: id => ipcRenderer.invoke('file:prepare', id),
  onNativeDrag: subscribe('file:drag-state'),
  startDrag: id => ipcRenderer.send('file:drag', id),
  revealFile: id => ipcRenderer.invoke('file:reveal', id),
  openFile: id => ipcRenderer.invoke('file:open', id),
  saveFile: id => ipcRenderer.invoke('file:save', id),
  pin: value => ipcRenderer.invoke('window:pin', value),
  dock: () => ipcRenderer.invoke('window:dock'),
  expand: () => ipcRenderer.invoke('window:expand'),
  close: () => ipcRenderer.invoke('window:close'),
  setNativeDialogBusy: value => ipcRenderer.invoke('window:native-busy', value),
  setInteractionBusy: value => ipcRenderer.invoke('window:busy', value),
  onGroupsChanged: subscribe('groups:changed'),
  onJoinRequestsChanged: subscribe('requests:changed'),
  onWindowChanged: subscribe('window:changed'),
});

let anchorErrorTimer;
function anchorTransferToast(message) {
  const toast = document.querySelector('#toast');
  if (!toast) return;
  toast.textContent = String(message); toast.hidden = false;
  clearTimeout(anchorErrorTimer);
  anchorErrorTimer = setTimeout(() => { toast.hidden = true; }, 5000);
}
const anchorUploadRows = new Map();
ipcRenderer.on('anchor:upload-state', (_event, upload) => {
  if (!upload || typeof upload.id !== 'string') return;
  let entry = anchorUploadRows.get(upload.id);
  if (upload.status === 'start' && !entry) {
    const host = document.querySelector('#uploads'); if (!host) return;
    const row = document.createElement('div'); row.className = 'upload'; row.dataset.anchorUpload = upload.id;
    const name = document.createElement('span'); name.className = 'upload-name'; name.textContent = upload.name;
    const progress = document.createElement('progress'); progress.max = 100; progress.value = 0;
    const percent = document.createElement('span'); percent.textContent = '准备中';
    const cancel = document.createElement('button'); cancel.type = 'button'; cancel.textContent = '取消';
    cancel.addEventListener('click', () => { cancel.disabled = true; percent.textContent = '取消中'; ipcRenderer.invoke('anchor:cancel-upload', upload.id).catch(error => anchorTransferToast(error.message)); });
    row.append(name, progress, percent, cancel); host.append(row);
    entry = { row, progress, percent }; anchorUploadRows.set(upload.id, entry);
  }
  if (upload.status === 'progress' && entry) {
    const value = upload.size ? Math.min(100, Math.round(upload.loaded / upload.size * 100)) : 100;
    entry.progress.value = value; entry.percent.textContent = value < 100 ? `${value}%` : '确认中';
  }
  if (['complete', 'cancelled', 'error'].includes(upload.status)) {
    entry?.row.remove(); anchorUploadRows.delete(upload.id);
    if (upload.status === 'cancelled') anchorTransferToast(`已取消发送 ${upload.name}`);
    if (upload.status === 'error') anchorTransferToast(upload.error || '文件发送失败');
  }
});

// A real, narrow BrowserWindow receives file drag events. No global drop hooks or
// transparent full-height hit area are installed at the screen edge.
let tab, latestState = { collapsed: false }, groupName = '拾传';
function renderTab() {
  if (!tab) return;
  tab.hidden = latestState.separateAnchor || (!latestState.collapsed && latestState.transition !== 'expand');
  tab.title = `${groupName} · 拖动移位，悬停展开，拖入文件发送`;
  tab.dataset.accepting = String(Boolean(latestState.accepting));
  tab.setAttribute('aria-label', `${groupName} · 展开群窗口`);
  if (latestState.moving) suppressTabClick = true;
  const root = document.documentElement;
  root.dataset.pickdropCollapsed = !latestState.separateAnchor && latestState.collapsed && !latestState.transition ? 'true' : 'false';
  root.dataset.separateAnchor = String(Boolean(latestState.separateAnchor));
  root.dataset.panelVisible = String(!latestState.collapsed || latestState.transition === 'collapse');
  root.dataset.nativeFrame = String(Boolean(latestState.nativeFrame));
  root.dataset.windowEdge = latestState.edge || '';
  root.dataset.snapEdge = latestState.candidateEdge || '';
  root.dataset.windowMoving = latestState.moving ? 'true' : 'false';
  root.dataset.windowTransition = latestState.transition || '';
  root.style.setProperty('--motion-duration', `${latestState.motionDuration || 180}ms`);
  root.style.setProperty('--content-width', `${latestState.contentWidth || 340}px`);
  root.style.setProperty('--content-height', `${latestState.contentHeight || 470}px`);
  if (latestState.transition === 'prepare') {
    const token=latestState.motionSequence;
    void document.querySelector?.('.app')?.offsetWidth;
    window.requestAnimationFrame?.(()=>{if(latestState.transition==='prepare'&&latestState.motionSequence===token)ipcRenderer.send('window:activity','panel-ready',token);});
  }
}
ipcRenderer.on('groups:changed', async () => {
  if (!tab) return;
  try { const data = await ipcRenderer.invoke('app:bootstrap'); groupName = data.group.name; const id = data.group.animalId || 'cat'; tab.querySelector('img').src = `/assets/group-animals/${encodeURIComponent(id)}.png`; tab.dataset.animal = id; renderTab(); } catch {}
});
ipcRenderer.on('window:changed', (_event, state) => { latestState = state; renderTab(); });
window.addEventListener('DOMContentLoaded', async () => {
  tab = document.createElement('button'); tab.id = 'pickdrop-native-tab'; tab.type = 'button';
  tab.setAttribute('aria-label', '展开群窗口');
  const animal = document.createElement('img'); animal.className = 'courier-animal courier-cat'; animal.alt = ''; animal.draggable = false; animal.decoding = 'async'; tab.append(animal);
  tab.addEventListener('click', () => { if (!suppressTabClick) ipcRenderer.invoke('window:expand'); });
  document.body.append(tab); renderTab();
  try { const data = await ipcRenderer.invoke('app:bootstrap'); groupName = data.group.name; animal.src = `/assets/group-animals/${encodeURIComponent(data.group.animalId || 'cat')}.png`; tab.dataset.animal = data.group.animalId || 'cat'; latestState = data.window; renderTab(); } catch { /* Renderer reports bootstrap failures. */ }
});
window.addEventListener('mouseenter', () => ipcRenderer.send('window:activity', 'pointer', true));
window.addEventListener('mouseleave', () => ipcRenderer.send('window:activity', 'pointer', false));
const isInput = node => document.hasFocus() && node instanceof Element && Boolean(node.closest('input,textarea,[contenteditable="true"],[role="dialog"]'));
window.addEventListener('focusin', event => ipcRenderer.send('window:activity', 'input', isInput(event.target)), true);
window.addEventListener('focusout', () => setTimeout(() => ipcRenderer.send('window:activity', 'input', isInput(document.activeElement)), 0), true);
window.addEventListener('dragenter', event => {
  if (event.dataTransfer?.types.includes('Files')) { event.preventDefault(); ipcRenderer.send('window:activity', 'drag', true); }
}, true);
window.addEventListener('dragover', event => {
  if (event.dataTransfer?.types.includes('Files')) { event.preventDefault(); ipcRenderer.send('window:activity', 'drag', true); }
}, true);
window.addEventListener('drop', event => {
  const files = Array.from(event.dataTransfer?.files || []);
  allowedDropIndexes = ipcRenderer.sendSync('file:drop-filter', files.map(file => webUtils.getPathForFile(file)));
  ipcRenderer.send('window:activity', 'drag', false);
}, true);
window.addEventListener('dragend', () => { ipcRenderer.send('window:activity', 'drag', false); ipcRenderer.send('window:activity', 'drag-end'); }, true);
// A released pointer after a native drag also clears the conservative drag lock.
window.addEventListener('pointerup', () => ipcRenderer.send('window:activity', 'drag-end'), true);

// Capture on the root so changing a tab into a full window never loses capture.
// Main reads screen coordinates directly; renderer screenX can jump on mixed-DPI displays.
let windowPointer = null, suppressTabClick = false, clickReset;
window.addEventListener('pointerdown', event => {
  if (latestState.nativeFrame) return;
  if (event.button !== 0 || !(event.target instanceof Element)) return;
  const handle = event.target.closest('#pickdrop-native-tab, .titlebar, .custom-window-resize-handle');
  const resizing = handle?.classList.contains('custom-window-resize-handle');
  if (!handle || (!resizing && handle !== tab && event.target.closest('button,input,a'))) return;
  event.preventDefault();
  document.activeElement?.blur();
  windowPointer = { id: event.pointerId, x: event.screenX, y: event.screenY, fromTab: handle === tab, width: innerWidth, height: innerHeight, windowX: window.screenX, windowY: window.screenY };
  suppressTabClick = false; clearTimeout(clickReset);
  document.documentElement.setPointerCapture(event.pointerId);
  ipcRenderer.send('window:activity', resizing ? 'window-resize-start' : 'window-drag-start');
}, true);
window.addEventListener('pointermove', event => {
  if (windowPointer && Math.hypot(event.screenX - windowPointer.x, event.screenY - windowPointer.y) >= 5) suppressTabClick = true;
  // Chromium can accept capture again once the next real held-pointer event arrives.
  if (windowPointer && event.pointerId === windowPointer.id && (event.buttons & 1) && !document.documentElement.hasPointerCapture(event.pointerId)) {
    try { document.documentElement.setPointerCapture(event.pointerId); } catch { /* A native bounds update may still be in progress. */ }
  }
}, true);
function finishWindowPointer(cancel = false) {
  if (!windowPointer) return;
  const { id, fromTab } = windowPointer; windowPointer = null;
  if (fromTab && !suppressTabClick && !cancel) ipcRenderer.invoke('window:expand');
  ipcRenderer.send('window:activity', 'window-drag-end', cancel);
  if (document.documentElement.hasPointerCapture(id)) document.documentElement.releasePointerCapture(id);
  clickReset = setTimeout(() => { suppressTabClick = false; }, 0);
}
window.addEventListener('pointerup', () => finishWindowPointer(), true);
window.addEventListener('pointercancel', () => finishWindowPointer(true), true);
window.addEventListener('lostpointercapture', event => {
  if (!windowPointer || event.pointerId !== windowPointer.id) return;
  // setBounds can invalidate Chromium capture on both a native move and a
  // tab reveal. That event reports buttons=0 even while the button is held.
  // A focused, changing native window is not a release; pointerup/mouseup,
  // pointercancel, Escape and blur remain the authoritative end signals.
  const root = document.documentElement;
  const nativeGeometryChanged = innerWidth !== windowPointer.width || innerHeight !== windowPointer.height || window.screenX !== windowPointer.windowX || window.screenY !== windowPointer.windowY;
  const nativeDragInProgress = document.hasFocus() && (latestState.moving || nativeGeometryChanged);
  try {
    root.setPointerCapture(windowPointer.id);
    if (!root.hasPointerCapture(windowPointer.id) && !nativeDragInProgress) finishWindowPointer(true);
  } catch { if (!nativeDragInProgress) finishWindowPointer(true); }
}, true);
// Also accept the mouse release if a platform loses pointer capture while its
// native window is resizing. Blur, pointercancel and Escape remain hard stops.
window.addEventListener('mouseup', event => { if (event.button === 0) finishWindowPointer(); }, true);
window.addEventListener('blur', () => {
  ipcRenderer.send('window:activity', 'input', false);
  setTimeout(() => { if (!document.hasFocus()) finishWindowPointer(true); }, 60);
});
window.addEventListener('focus', () => ipcRenderer.send('window:activity', 'input', isInput(document.activeElement)));
window.addEventListener('keydown', event => { if (event.key === 'Escape') finishWindowPointer(true); });
const motionPreference = matchMedia('(prefers-reduced-motion: reduce)');
const reportMotion = () => ipcRenderer.send('window:activity', 'reduced-motion', motionPreference.matches);
motionPreference.addEventListener('change', reportMotion);
window.addEventListener('DOMContentLoaded', reportMotion);
