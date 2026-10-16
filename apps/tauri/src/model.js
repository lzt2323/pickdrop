export const PAGE_SIZE = 60;
export const MAX_VISIBLE = 180;
export function messageOrder(message) { if (Number.isFinite(message.sequence))
    return message.sequence; const time = message.createdAt ?? message.timestamp; return typeof time === 'number' ? time : (Date.parse(time) || 0); }
export function mergeMessages(existing, incoming, limit = MAX_VISIBLE) {
    const byId = new Map(existing.map(message => [message.id, message]));
    for (const message of incoming)
        byId.set(message.id, message);
    return [...byId.values()].sort((a, b) => messageOrder(a) - messageOrder(b) || String(a.id).localeCompare(String(b.id))).slice(-limit);
}
export function formatBytes(bytes = 0) {
    if (bytes < 1024)
        return `${bytes} B`;
    if (bytes < 1048576)
        return `${(bytes / 1024).toFixed(1)} KB`;
    return `${(bytes / 1048576).toFixed(1)} MB`;
}
export function progressScheduler(render, interval = 150) {
    let timer, latest;
    return { push(value) { latest = value; if (!timer)
            timer = setTimeout(() => { timer = undefined; render(latest); }, interval); }, flush(value) { clearTimeout(timer); timer = undefined; render(value); }, dispose() { clearTimeout(timer); } };
}
export function parseInvite(value) {
    const raw = value.trim();
    try {
        const url = new URL(raw);
        const fragment = new URLSearchParams(url.hash.slice(1));
        return { address: url.searchParams.get('address') || url.searchParams.get('endpoint') || (/^https?:$/.test(url.protocol) ? url.origin : ''), code: url.searchParams.get('code') || fragment.get('invite') || '' };
    }
    catch {
        return null;
    }
}
