import { invoke, addPluginListener } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';
// Test injection is explicit and never supplies fallback demo data in production.
export const call = (method, params = {}) => window.__PICKDROP_TEST_BRIDGE__ ? window.__PICKDROP_TEST_BRIDGE__.call(method, params) : invoke('core_call', { method, params });
export const native = (command, args = {}) => window.__PICKDROP_TEST_BRIDGE__ ? window.__PICKDROP_TEST_BRIDGE__.native(command, args) : invoke(command, args);
export const subscribe = handler => window.__PICKDROP_TEST_BRIDGE__ ? window.__PICKDROP_TEST_BRIDGE__.subscribe(handler) : listen('pickdrop:event', event => handler(event.payload));
export async function copyText(text) { if (window.__PICKDROP_TEST_BRIDGE__)
    return navigator.clipboard.writeText(text); const { writeText } = await import('@tauri-apps/plugin-clipboard-manager'); return writeText(text); }
export async function scanInvite() { const { scan, Format } = await import('@tauri-apps/plugin-barcode-scanner'); const result = await scan({ windowed: false, formats: [Format.QRCode] }); return result.content; }
export async function subscribeWindow(handler) {
    if (window.__PICKDROP_TEST_BRIDGE__) return () => {};
    const unlisten = await listen('pickdrop:window', event => handler(event.payload));
    // Restore events can precede webview startup; request a snapshot after listening.
    await invoke('window_action', { action: 'sync' }).catch(() => {});
    return unlisten;
}

export async function subscribeBack(handler) { if(window.__PICKDROP_TEST_BRIDGE__)return()=>{};const listener=await addPluginListener('pickdrop-native','back',handler);return()=>listener.unregister();}

export async function subscribeIncoming(handler) { if(window.__PICKDROP_TEST_BRIDGE__)return()=>{};const listener=await addPluginListener('pickdrop-native','incoming',handler);return()=>listener.unregister();}
