import test from 'node:test';
import assert from 'node:assert/strict';
import { createJoinRequest } from '../src/join-request.js';

function deferred() {
    let resolve;
    const promise = new Promise(done => { resolve = done; });
    return { promise, resolve };
}
function setup(t, check) {
    t.mock.timers.enable({ apis: ['setTimeout'] });
    const results = [], errors = [];
    let current = true;
    const request = createJoinRequest({
        check, isCurrent: () => current,
        onResult: result => results.push(result),
        onError: error => errors.push(error.message),
    });
    t.after(request.stop);
    return { request, results, errors, replacePanel() { current = false; } };
}

test('waiting polls every two seconds, and approval or denial ends polling', async t => {
    for (const result of [{ status: 'approved' }, { group: { id: 'new' } }, { status: 'denied' }, { status: 'expired' }, { status: 'revoked' }]) {
        let count = 0;
        const { request, results } = setup(t, async () => ++count === 1 ? { status: 'pending' } : result);
        t.mock.timers.tick(1999);
        assert.equal(count, 0);
        t.mock.timers.tick(1);
        await request.retry();
        assert.equal(count, 1);
        t.mock.timers.tick(2000);
        await request.retry();
        assert.deepEqual(results, [{ status: 'pending' }, result]);
        t.mock.timers.tick(10000);
        await request.retry();
        assert.equal(count, 2);
        t.mock.timers.reset();
    }
});

test('manual retry and scheduled checks share a single in-flight request', async t => {
    const response = deferred();
    let count = 0;
    const { request, results } = setup(t, () => { count++; return response.promise; });
    t.mock.timers.tick(2000);
    const first = request.retry(), second = request.retry();
    assert.equal(first, second);
    await Promise.resolve();
    assert.equal(count, 1);
    response.resolve({ status: 'denied' });
    await first;
    assert.equal(results.length, 1);
});

test('closing before a scheduled check cancels it', async t => {
    let count = 0;
    const { request } = setup(t, async () => { count++; return {}; });
    request.stop();
    t.mock.timers.tick(10000);
    await request.retry();
    assert.equal(count, 0);
});

test('closing or replacing a panel discards in-flight responses', async t => {
    for (const action of ['stop', 'replace']) {
        const response = deferred();
        const { request, results, errors, replacePanel } = setup(t, () => response.promise);
        const pending = request.retry();
        await Promise.resolve();
        if (action === 'stop') request.stop(); else replacePanel();
        response.resolve({ status: 'approved', group: { id: 'stale' } });
        await pending;
        assert.deepEqual(results, []);
        assert.deepEqual(errors, []);
        t.mock.timers.reset();
    }
});

test('errors stop automatic polling but allow explicit retry, including synchronous failures', async t => {
    let count = 0;
    const { request, results, errors } = setup(t, () => {
        if (++count === 1) throw Error('offline');
        return { status: 'approved' };
    });
    await request.retry();
    assert.deepEqual(errors, ['offline']);
    t.mock.timers.tick(10000);
    assert.equal(count, 1);
    await request.retry();
    assert.deepEqual(results, [{ status: 'approved' }]);
});
