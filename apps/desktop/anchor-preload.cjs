const { contextBridge, ipcRenderer, webUtils } = require('electron');
const activity = (type, value) => ipcRenderer.send('anchor:activity', type, value);
contextBridge.exposeInMainWorld('pickdropAnchor', {
  expand: () => ipcRenderer.invoke('anchor:expand'),
});
let button,
  img,
  held = null,
  moved = false,
  state = {};
function render(next) {
  state = next;
  if (!button) return;
  button.dataset.accepting = String(!!next.accepting);
  button.setAttribute('aria-expanded', String(!next.collapsed));
  button.title = next.error || `${next.name || '拾传'} · 展开群窗口`;
  button.setAttribute('aria-label', `${next.name || '拾传'} · 展开群窗口`);
  if (next.animalId) img.src = `/assets/group-animals/${encodeURIComponent(next.animalId)}.png`;
  if (next.moving) moved = true;
}
ipcRenderer.on('anchor:state', (_event, next) => render({ ...state, ...next }));
window.addEventListener('DOMContentLoaded', async () => {
  button = document.querySelector('#pickdrop-native-tab');
  img = button.querySelector('img'); img.decoding = 'async'; img.draggable = false;
  render(await ipcRenderer.invoke('anchor:bootstrap'));
  button.addEventListener('click', (event) => {
    if (event.detail === 0) ipcRenderer.invoke('anchor:expand');
  });
});
window.addEventListener(
  'pointerdown',
  (e) => {
    if (e.button !== 0 || !button?.contains(e.target)) return;
    e.preventDefault();
    held = e.pointerId;
    moved = false;
    button.setPointerCapture(held);
    activity('drag-start');
  },
  true,
);
function release(cancel = false) {
  if (held === null) return;
  const id = held;
  held = null;
  activity('drag-end', cancel);
  if (button.hasPointerCapture(id)) button.releasePointerCapture(id);
  if (!cancel && !moved) ipcRenderer.invoke('anchor:expand');
}
window.addEventListener('pointerup', () => release(), true);
window.addEventListener(
  'mouseup',
  (e) => {
    if (e.button === 0) release();
  },
  true,
);
window.addEventListener('pointercancel', () => release(true), true);
window.addEventListener(
  'lostpointercapture',
  () => {
    if (held !== null) {
      try {
        button.setPointerCapture(held);
      } catch {
        /* Native movement can briefly reject recapture. */
      }
    }
  },
  true,
);
window.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') release(true);
});
window.addEventListener('blur', () =>
  setTimeout(() => {
    if (!document.hasFocus()) release(true);
  }, 60),
);
window.addEventListener('mouseenter', () => activity('pointer', true));
window.addEventListener('mouseleave', () => activity('pointer', false));
for (const type of ['dragenter', 'dragover'])
  window.addEventListener(type, (e) => {
    if (e.dataTransfer?.types.includes('Files')) {
      e.preventDefault();
      activity('files', true);
    }
  });
window.addEventListener('dragleave', (e) => {
  if (!e.relatedTarget) activity('files', false);
});
window.addEventListener('drop', async (e) => {
  if (!e.dataTransfer?.files.length) return;
  e.preventDefault();
  activity('files', false);
  const files = [];
  try {
    const incoming = Array.from(e.dataTransfer.files).slice(0, 100);
    const allowed = ipcRenderer.sendSync('file:drop-filter', incoming.map(file => webUtils.getPathForFile(file)));
    for (const index of allowed) {
      const file = incoming[index];
      const diskPath = webUtils.getPathForFile(file);
      if (diskPath) files.push({ path: diskPath, name: file.name, type: file.type });
      else if (file.size <= 1024 * 1024)
        files.push({
          name: file.name,
          type: file.type,
          bytes: new Uint8Array(await file.arrayBuffer()),
        });
      else throw new Error('请从文件管理器拖入这个文件');
    }
    if (files.length) await ipcRenderer.invoke('anchor:drop', files);
  } catch (error) {
    button.title = error.message;
    button.dataset.error = 'true';
  }
});
const preference = matchMedia('(prefers-reduced-motion: reduce)');
const motion = () => activity('reduced-motion', preference.matches);
preference.addEventListener('change', motion);
window.addEventListener('DOMContentLoaded', motion);
