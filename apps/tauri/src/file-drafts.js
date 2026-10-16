// Draft identity belongs to the composer, never to the mutable send queue.
export const draftFile = item => ({ ...(typeof item === 'string' ? { path:item } : item), draftId:item?.draftId || crypto.randomUUID() });
export const snapshotFiles = files => files.map(file => typeof file === 'string' ? {path:file} : ({ ...file }));
export function removeDraft(files, draftId) { return files.filter(file => file.draftId !== draftId); }
export function acceptDrop(payload, owner, seen) {
    if (!payload || payload.owner !== owner || typeof payload.dropId !== 'string' || !Array.isArray(payload.paths) || seen.has(payload.dropId)) return false;
    seen.add(payload.dropId); return true;
}
