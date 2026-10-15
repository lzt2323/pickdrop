import { draftFile, snapshotFiles, removeDraft } from './file-drafts.js';

const terminalStatuses = new Set(['完成', '失败', '已取消']);
const eventStatuses = { completed: '完成', failed: '失败', receiving: '接收中', sending: '发送中', cancelled: '已取消' };
const isTerminalEvent = status => ['completed', 'failed', 'cancelled'].includes(status);

function recordFailure(task, error) {
    const cancelled = task.status === '已取消' || /cancel|已取消/i.test(String(error));
    Object.assign(task, { status: cancelled ? '已取消' : '失败', error: cancelled ? '' : String(error) });
    return cancelled;
}

// Own transfer lifecycles here; rendering and native window protection stay with
// the host. Each send keeps its original group even when the user switches chats.
export function createFileTransfers({
    app, call, setWindowBusy, persistFiles, addFileDrafts,
    renderQueue, renderFileDrafts, renderMessages, refresh, progress,
}) {
    const removedDrafts = new Set();
    const inflightDrafts = new Set();

    async function retryFile(task) {
        const file = draftFile({ path: task.path, name: task.name, transferId: task.id, draftId: task.draftId });
        task.draftId = file.draftId;
        removedDrafts.delete(file.draftId);
        if (!(app.fileDrafts.get(task.groupId) || []).some(draft => draft.draftId === file.draftId)) {
            addFileDrafts([file], task.groupId);
        }
        return sendFiles([file], task.groupId);
    }

    async function sendFiles(paths, groupId = app.groupId) {
        if (!groupId || !app.groups.some(group => group.id === groupId)) {
            throw Error('目标群组不可用，附件已保留');
        }
        const targetState = await call('get_state', { groupId });
        if (targetState?.membershipRevoked) throw Error('请重新加入群组后发送，附件已保留');
        if (groupId === app.groupId && app.state?.membershipRevoked) throw Error('请重新加入群组后发送');

        const failed = [];
        const batchProtection = `transfer:${crypto.randomUUID()}`;
        await setWindowBusy(batchProtection, true);
        try {
            for (const file of snapshotFiles(paths)) {
                if (file.draftId && (removedDrafts.has(file.draftId) || inflightDrafts.has(file.draftId))) continue;
                if (file.draftId) inflightDrafts.add(file.draftId);
                const path = file.path, id = file.transferId || crypto.randomUUID();
                const task = {
                    id, name: file.name || path.split(/[\\/]/).at(-1), status: '发送中',
                    progress: 0, path, groupId, draftId: file.draftId,
                };
                app.transfers.set(id, task);
                renderQueue();
                renderFileDrafts();
                try {
                    await call('send_file', { groupId, path, transferId: id });
                    Object.assign(task, { status: '完成', progress: 1 });
                    const drafts = app.fileDrafts.get(groupId);
                    if (drafts) app.fileDrafts.set(groupId, removeDraft(drafts, file.draftId));
                    persistFiles();
                    if (groupId === app.groupId) renderFileDrafts();
                } catch (error) {
                    failed.push({ ...file, transferId: id });
                    const current = app.fileDrafts.get(groupId) || [];
                    app.fileDrafts.set(groupId, current.map(draft => draft.draftId === file.draftId ? { ...draft, transferId: id } : draft));
                    persistFiles();
                    recordFailure(task, error);
                } finally {
                    if (file.draftId) inflightDrafts.delete(file.draftId);
                }
                progress.flush();
            }
            await refresh();
            return failed;
        } finally {
            await setWindowBusy(batchProtection, false);
            renderFileDrafts();
        }
    }

    async function receive(message, groupId = app.groupId) {
        const id = message.id;
        const task = { id, groupId, message, name: message.fileName, status: '接收中', progress: 0 };
        app.transfers.set(id, task);
        renderQueue();
        try {
            const result = await call('receive_file', { groupId, id, transferId: id });
            app.files.set(id, typeof result === 'string' ? result : result.path || result.localPath);
            Object.assign(task, { status: '完成', progress: 1 });
            renderMessages();
        } catch (error) {
            if (!recordFailure(task, error)) throw error;
        } finally {
            progress.flush();
        }
    }

    function updateProgress(event) {
        const id = event.id || event.messageId;
        let task = app.transfers.get(id);
        if (!task) {
            task = { id, name: event.name || '文件', status: '传输中' };
            app.transfers.set(id, task);
        }
        // Delayed progress must not reopen a completed, failed, or cancelled task.
        if (terminalStatuses.has(task.status) && !isTerminalEvent(event.status)) return;
        task.progress = event.progress ?? (event.total ? event.bytes / event.total : 0);
        if (event.status) task.status = eventStatuses[event.status] || event.status;
        if (isTerminalEvent(event.status)) progress.flush();
        else progress.push();
    }

    return {
        sendFiles, receive, retryFile, updateProgress,
        isDraftInFlight: draftId => inflightDrafts.has(draftId),
        markDraftRemoved: draftId => removedDrafts.add(draftId),
    };
}
