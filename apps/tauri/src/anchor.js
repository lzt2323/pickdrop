import './anchor.css';
import { invoke } from '@tauri-apps/api/core';
import { getCurrentWebview } from '@tauri-apps/api/webview';
import { getCurrentWindow } from '@tauri-apps/api/window';
const current=getCurrentWindow(),owner=current.label.replace(/^anchor-/,'');
const button = document.querySelector('#animal');
let timer, down, dragging = false, fileHover = false;
const animals = new Set(['cat','sheep','monkey','dog','chick','lizard','alpaca','rabbit','otter','capybara']);
const showAnimal = animal => { button.querySelector('img').src = `/assets/group-animals/${animals.has(animal) ? animal : 'cat'}.png`; };
async function initialize() {
  await current.listen('pickdrop:animal', event => {if(event.payload.owner===owner)showAnimal(event.payload.animal);});
  showAnimal(await invoke('window_animal'));
  await current.listen('pickdrop:window', event => {if(event.payload.owner===owner)button.setAttribute('aria-expanded', String(!event.payload.collapsed));});
  await invoke('window_action', { action: 'sync' });
  await getCurrentWebview().onDragDropEvent(event => {
    const type = event.payload.type;
    fileHover = type === 'enter' || type === 'over';
    // Keep the native drop surface alive until the OS delivers Drop or Leave.
    clearTimeout(timer);
    button.dataset.accepting = String(fileHover);
    // Native drag events own file-hover protection and the captured group.
  });
}
initialize().catch(console.error);
const expand = () => { if (!fileHover) invoke('window_action', { action: 'expand' }).catch(console.error); };
button.addEventListener('pointerenter', event => { if (!event.buttons) { if(dragging) invoke('window_action', {action:'anchor-drag-end'}).catch(console.error); dragging = false; down = null; } if (!fileHover && !event.buttons) timer = setTimeout(() => { if (!down && !dragging) expand(); }, 250); });
button.addEventListener('pointerleave', () => { clearTimeout(timer); invoke('window_action', { action:'pointer-leave' }).catch(console.error); });
button.addEventListener('pointerdown', event => { clearTimeout(timer); down = { x:event.clientX, y:event.clientY }; dragging = false; });
button.addEventListener('pointermove', async event => {
  if(dragging && !event.buttons) { dragging = false; down = null; await invoke('window_action', {action:'anchor-drag-end'}).catch(console.error); return; }
  if (!down || dragging || Math.hypot(event.clientX-down.x,event.clientY-down.y)<4) return;
  dragging = true; down = null;
  try { await getCurrentWindow().startDragging(); await invoke('window_action', {action:'anchor-drag-end'}); } catch (error) { console.error(error); }
});
button.addEventListener('pointerup', () => { down = null; if(dragging) invoke('window_action', {action:'anchor-drag-end'}).catch(console.error); });
button.addEventListener('click', () => { if (!dragging) expand(); dragging = false; });
button.addEventListener('keydown', event => { if(event.key === 'Enter' || event.key === ' ') { event.preventDefault(); expand(); } });

button.addEventListener('pointercancel', () => { down = null; clearTimeout(timer); });
window.addEventListener('blur', () => { down = null; clearTimeout(timer); });
