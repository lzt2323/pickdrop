import test from 'node:test';
import assert from 'node:assert/strict';
import { draftFile } from '../src/file-drafts.js';
import { createFileTransfers, transferSpeedLabel } from '../src/file-transfers.js';

function setup(handleCall = async () => ({}), now) {
    const app = {
        groupId: 'a', groups: [{ id: 'a' }, { id: 'b' }], state: {},
        transfers: new Map(), fileDrafts: new Map(), files: new Map(),
    };
    const calls = [], protection = [], renders = { immediate: 0, deferred: 0, messages: 0 };
    const transfers = createFileTransfers({
        app, now,
        call: async (method, params) => { calls.push({ method, params }); return handleCall(method, params); },
        setWindowBusy: async (reason, value) => { protection.push({ reason, value }); },
        persistFiles() {}, renderQueue() {}, renderFileDrafts() {}, refresh: async () => {},
        renderMessages() { renders.messages++; },
        addFileDrafts(files, groupId) { app.fileDrafts.set(groupId, [...(app.fileDrafts.get(groupId) || []), ...files]); },
        progress: { flush() { renders.immediate++; }, push() { renders.deferred++; } },
    });
    return { app, transfers, calls, protection, renders };
}

function deferred() {
    let resolve;
    const promise = new Promise(done => { resolve = done; });
    return { promise, resolve };
}

test('a send retains its group while later drafts and removed queued files remain independent', async () => {
    const started = deferred(), finish = deferred();
    const context = setup(async method => {
        if (method === 'send_file') { started.resolve(); await finish.promise; }
        return {};
    });
    const { app, transfers, calls, protection } = context;
    const first = draftFile('/first'), removed = draftFile('/removed'), later = draftFile('/later');
    app.fileDrafts.set('a', [first, removed]);
    const sending = transfers.sendFiles([first, removed]);
    await started.promise;
    assert.equal(transfers.isDraftInFlight(first.draftId), true);
    app.groupId = 'b';
    app.fileDrafts.set('a', [first, later]);
    transfers.markDraftRemoved(removed.draftId);
    // A concurrent attempt cannot send a draft already in flight.
    await transfers.sendFiles([first], 'a');
    finish.resolve();
    assert.deepEqual(await sending, []);
    assert.deepEqual(calls.filter(call => call.method === 'send_file').map(call => call.params.groupId), ['a']);
    assert.deepEqual(app.fileDrafts.get('a'), [later]);
    assert.equal(transfers.isDraftInFlight(first.draftId), false);
    for (const { reason } of protection.filter(item => item.value)) {
        assert.deepEqual(protection.filter(item => item.reason === reason).map(item => item.value), [true, false]);
    }
});

test('failed sends retain retry identity and a successful retry removes only its draft', async () => {
    let fail = true;
    const { app, transfers } = setup(async method => {
        if (method === 'send_file' && fail) throw Error('network unavailable');
        return {};
    });
    const file = draftFile('/file');
    app.fileDrafts.set('a', [file]);
    const [failed] = await transfers.sendFiles([file]);
    const task = app.transfers.get(failed.transferId);
    assert.equal(task.status, '失败');
    assert.match(task.error, /network unavailable/);
    assert.equal(app.fileDrafts.get('a')[0].transferId, task.id);
    assert.equal(transfers.isDraftInFlight(file.draftId), false);
    app.fileDrafts.set('a', []);
    transfers.markDraftRemoved(file.draftId);
    app.groupId = 'b';
    fail = false;
    assert.deepEqual(await transfers.retryFile(task), []);
    assert.equal(app.transfers.size, 1);
    assert.equal(app.transfers.get(task.id).status, '完成');
    assert.deepEqual(app.fileDrafts.get('a'), []);
});

test('unavailable or revoked target never sends or discards attachments', async () => {
    const { app, transfers, calls, protection } = setup(async () => ({ membershipRevoked: true }));
    const file = draftFile('/file');
    app.fileDrafts.set('a', [file]);
    await assert.rejects(transfers.sendFiles([file], 'missing'), /目标群组不可用/);
    await assert.rejects(transfers.sendFiles([file]), /请重新加入群组/);
    assert.equal(calls.some(call => call.method === 'send_file'), false);
    assert.deepEqual(app.fileDrafts.get('a'), [file]);
    assert.deepEqual(protection, []);
});

test('progress is coalesced and delayed events cannot reopen terminal transfers', () => {
    const { app, transfers, renders } = setup();
    transfers.updateProgress({ messageId: 'file', status: 'receiving', bytes: 1, total: 2 });
    assert.equal(app.transfers.get('file').progress, 0.5);
    assert.equal(renders.deferred, 1);
    for (const status of ['completed', 'failed', 'cancelled']) {
        transfers.updateProgress({ id: 'file', status, progress: 1 });
        const completed = { ...app.transfers.get('file') };
        transfers.updateProgress({ id: 'file', status: 'receiving', progress: 0.1 });
        assert.deepEqual(app.transfers.get('file'), completed);
    }
    assert.equal(renders.immediate, 3);
    assert.equal(renders.deferred, 1);
});

test('receiving records local files only on success and surfaces failures', async () => {
    let response = { localPath: '/received' };
    const { app, transfers, renders } = setup(async () => {
        if (response instanceof Error) throw response;
        return response;
    });
    await transfers.receive({ id: 'success', fileName: 'file' });
    assert.equal(app.files.get('success'), '/received');
    assert.equal(app.transfers.get('success').status, '完成');
    assert.equal(renders.messages, 1);
    response = Error('connection lost');
    await assert.rejects(transfers.receive({ id: 'failed' }), /connection lost/);
    assert.equal(app.transfers.get('failed').status, '失败');
    assert.equal(app.files.has('failed'), false);
    response = Error('已取消');
    await transfers.receive({ id: 'cancelled' });
    assert.equal(app.transfers.get('cancelled').status, '已取消');
    assert.equal(app.transfers.get('cancelled').error, '');
    assert.equal(renders.immediate, 3);
});

test('speed samples use byte deltas, reset on fallback, and disappear for terminal tasks', () => {
    let time = 0;
    const { app, transfers } = setup(undefined, () => time);
    const update = (bytes, status = 'receiving') => transfers.updateProgress({ id: 'speed', bytes, total: 4096, status });
    update(0);
    assert.equal(transferSpeedLabel(app.transfers.get('speed')), '下载速度：计算中…');
    time = 500; update(1024);
    assert.equal(transferSpeedLabel(app.transfers.get('speed')), '下载速度：2.0 KiB/s');
    time = 1000; update(1536);
    assert.equal(app.transfers.get('speed').bytesPerSecond, 1024);
    time = 1500; update(1536);
    assert.equal(transferSpeedLabel(app.transfers.get('speed')), '下载速度：0 B/s');
    time = 2000; update(0);
    assert.equal(app.transfers.get('speed').bytesPerSecond, undefined);
    time = 2500; update(1024, 'sending');
    assert.equal(transferSpeedLabel(app.transfers.get('speed')), '准备速度：2.0 KiB/s');
    for (const status of ['completed', 'failed', 'cancelled']) {
        update(4096, status);
        assert.equal(transferSpeedLabel(app.transfers.get('speed')), '');
    }
});
