import { invoke, addPluginListener } from '@tauri-apps/api/core';
import { getCurrentWindow } from '@tauri-apps/api/window';
import { listen } from '@tauri-apps/api/event';
// Test injection is explicit and never supplies fallback demo data in production.
export const call = (method, params = {}) => window.__PICKDROP_TEST_BRIDGE__ ? window.__PICKDROP_TEST_BRIDGE__.call(method, params) : invoke('core_call', { method, params });
export const native = (command, args = {}) => window.__PICKDROP_TEST_BRIDGE__ ? window.__PICKDROP_TEST_BRIDGE__.native(command, args) : invoke(command, args);
export const subscribe = handler => window.__PICKDROP_TEST_BRIDGE__ ? window.__PICKDROP_TEST_BRIDGE__.subscribe(handler) : listen('pickdrop:event', event => handler(event.payload));
export async function copyText(text) { if (window.__PICKDROP_TEST_BRIDGE__)
    return navigator.clipboard.writeText(text); const { writeText } = await import('@tauri-apps/plugin-clipboard-manager'); return writeText(text); }
let invitationScan;
export const isScanningInvite = () => !!invitationScan;
export async function cancelInviteScan() {
    const current = invitationScan;
    if (!current) return;
    current.cancelled = true;
    if (window.__PICKDROP_TEST_BRIDGE__?.cancelInviteScan) await window.__PICKDROP_TEST_BRIDGE__.cancelInviteScan();
    else if (current.plugin) await current.plugin.cancel();
}
export async function scanInvite() {
    if (invitationScan) return null;
    const current = { cancelled:false, plugin:null }; invitationScan = current;
    try {
        if (window.__PICKDROP_TEST_BRIDGE__?.scanInvite) return await window.__PICKDROP_TEST_BRIDGE__.scanInvite();
        current.plugin = await import('@tauri-apps/plugin-barcode-scanner');
        let permission = await current.plugin.checkPermissions();
        if (permission !== 'granted') permission = await current.plugin.requestPermissions();
        if (current.cancelled) return null;
        if (permission !== 'granted') throw Error('需要相机权限才能扫码，请在系统设置中允许相机访问。');
        const result = await current.plugin.scan({ windowed:false, formats:[current.plugin.Format.QRCode] });
        return current.cancelled ? null : result.content;
    } catch (error) {
        if (current.cancelled || /^(scan )?cancelled?$/i.test(String(error?.message || error))) return null;
        throw error;
    } finally { if (invitationScan === current) invitationScan = null; }
}
export async function subscribeWindow(handler) {
    if (window.__PICKDROP_TEST_BRIDGE__) return window.__PICKDROP_TEST_BRIDGE__.subscribeWindow?.(handler) || (() => {});
    const current = getCurrentWindow();
    const unlisten = await current.listen('pickdrop:window', event => { if(event.payload.owner === current.label) handler(event.payload); });
    // Restore events can precede webview startup; request a snapshot after listening.
    await invoke('window_action', { action: 'sync' }).catch(() => {});
    return unlisten;
}

export async function subscribeBack(handler) { if(window.__PICKDROP_TEST_BRIDGE__)return()=>{};const listener=await addPluginListener('pickdrop-native','back',handler);return()=>listener.unregister();}

export async function subscribeIncoming(handler) { if(window.__PICKDROP_TEST_BRIDGE__)return()=>{};const listener=await addPluginListener('pickdrop-native','incoming',handler);return()=>listener.unregister();}
