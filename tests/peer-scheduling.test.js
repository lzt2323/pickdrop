import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, readFile, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { randomBytes, randomUUID } from 'node:crypto';
import { openPeerStore } from '../server/peer-store.js';
import { createPeerIdentity, createPeerGenesis, createPeerReplica } from '../shared/peer-protocol.js';
const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; };
async function fixture(t, hook = async () => {}, count = 0) {
  const person = name => ({ device: { id: randomUUID(), name, kind: 'desktop' }, identity: createPeerIdentity(randomBytes(32).toString('hex')) });
  const owner = person('owner'), guest = person('guest');
  const genesis = createPeerGenesis({ ...owner, groupId: randomUUID(), name: 'scheduler' });
  const local = createPeerReplica({ ...owner, genesis, randomBytes });
  local.append('member.add', { ...guest.device, publicKey: guest.identity.publicKey });
  const remote = createPeerReplica({ ...guest, genesis, events: local.snapshot().events, randomBytes });
  for (let i = 0; i < count; i++) local.append('rename', { name: `group ${i}` });
  const root = await mkdtemp(path.join(os.tmpdir(), 'peer-schedule-'));
  let clock = 1000;
  const calls = [];
  const store = await openPeerStore({ dataDir: root, ...owner, genesis, events: local.snapshot().events, now: () => clock,
    request: async (url, route, options) => {
      calls.push(url); await hook(url, options);
      const payload = remote.verifyProof(options.body, 'sync', { allowUnknown: true });
      remote.merge(payload.events);
      const snapshot = remote.snapshot(), known = new Set(payload.known), missing = snapshot.events.filter(event => !known.has(event.eventId));
      return remote.proof('sync-result', { genesis, events: missing.slice(0, 128), known: snapshot.events.map(event => event.eventId), hasMore: missing.length > 128 });
    } });
  t.after(async () => { await store.close(); await rm(root, { recursive: true, force: true }); });
  return { store, calls, remote, guest, root, owner, genesis, advance: ms => { clock += ms; }, remember: url => store.remember({ deviceId: guest.device.id, baseUrl: url }) };
}

test('bounded batches rotate past stale addresses and failed peers back off while manual sync retries immediately', async t => {
  let recovered = false;
  const f = await fixture(t, async url => { if (url !== 'http://127.0.0.1:19099' && !recovered) throw new Error('offline'); });
  for (let i = 0; i < 40; i++) f.remember(`http://127.0.0.1:${19000 + i}`);
  f.remember('http://127.0.0.1:19099');
  assert.equal(await f.store.syncAll(), 0);
  assert.equal(new Set(f.calls).size, 16);
  for (let i = 0; i < 4; i++) await f.store.syncAll();
  assert.ok(f.calls.includes('http://127.0.0.1:19099'));
  assert.equal(f.calls.filter(url => url === 'http://127.0.0.1:19000').length, 1);
  recovered = true;
  assert.equal(await f.store.sync('http://127.0.0.1:19000'), true);
  f.advance(60000);
  assert.ok(await f.store.syncAll() > 0);
});

test('one blocked endpoint does not prevent live peers, and endpoint operations are deduplicated', async t => {
  const gate = deferred(), entered = deferred();
  const f = await fixture(t, async url => { if (url.endsWith(':19000')) { entered.resolve(); await gate.promise; throw Error('offline'); } });
  const slow = 'http://127.0.0.1:19000', fast = 'http://127.0.0.1:19001';
  f.remember(slow); f.remember(fast);
  const first = f.store.sync(slow), duplicate = f.store.sync(slow);
  assert.equal(first, duplicate);
  await entered.promise;
  assert.equal(await f.store.sync(fast), true);
  gate.resolve(); assert.equal(await first, false);
  assert.equal(f.calls.filter(url => url === slow).length, 1);
});

test('close aborts active probes and drains queued syncs while reserving live slots', async t => {
  const entered = deferred(); let running = 0, max = 0;
  const f = await fixture(t, async (url, { signal }) => {
    running++; max = Math.max(max, running); if (running === 2) entered.resolve();
    try { await new Promise((resolve, reject) => { if (signal.aborted) reject(signal.reason); else signal.addEventListener('abort', () => reject(signal.reason), { once: true }); }); }
    finally { running--; }
  });
  const work = Array.from({ length: 20 }, (_, i) => f.store.sync(`http://127.0.0.1:${19000 + i}`));
  await entered.promise; await f.store.close();
  assert.deepEqual(await Promise.all(work), Array(20).fill(false));
  assert.equal(max, 2); assert.equal(running, 0); assert.equal(f.calls.length, 2);
  assert.equal(await f.store.syncAll(), 0);
});

test('batch acknowledgement requires the complete log including paginated departure', async t => {
  const f = await fixture(t, undefined, 140);
  f.remember('http://127.0.0.1:19000');
  await f.store.append('member.leave', {});
  assert.equal(await f.store.syncAll(), 1);
  assert.equal(f.remote.snapshot().events.length, f.store.snapshot().events.length);
  assert.ok(f.calls.length >= 3);
});

test('an authenticated inbound caller cannot declare its advertised endpoint reachable', async t => {
  const f = await fixture(t);
  const address = 'http://127.0.0.1:19055';
  const proof = f.remote.proof('sync', { genesis: f.remote.snapshot().genesis, events: [], known: [], endpoint: { deviceId: f.guest.device.id, baseUrl: address } });
  const req = { method: 'POST', socket: { remoteAddress: '127.0.0.1' }, async *[Symbol.asyncIterator]() { yield Buffer.from(JSON.stringify(proof)); } };
  let status;
  await f.store.handle(req, { writeHead(value) { status = value; }, end() {} }, new URL('http://localhost/api/peer/sync'));
  assert.equal(status, 200);
  assert.equal(f.store.peers().find(peer => peer.baseUrl === address).online, false);
  assert.equal(await f.store.sync(address), true);
  assert.equal(f.store.peers().find(peer => peer.baseUrl === address).online, true);
});


test('restart treats persisted endpoints as hints without trusting old online flags', async t => {
  const f = await fixture(t);
  f.remember('http://127.0.0.1:19000');
  await f.store.initialize(); await f.store.close();
  const file = path.join(f.root, 'peer.json');
  const saved = JSON.parse(await readFile(file, 'utf8'));
  saved.peers[0].online = true;
  await writeFile(file, JSON.stringify(saved));
  const restarted = await openPeerStore({ dataDir: f.root, ...f.owner, genesis: f.genesis, request: async () => { throw Error('offline'); } });
  try { assert.equal(restarted.peers()[0].online, false); }
  finally { await restarted.close(); }
});

test('desktop presence uses a direct signed request even when the return route fails, and expires without gossip renewal', async t => {
  const f = await fixture(t, async () => { throw Error('one-way route unavailable'); });
  const address = 'http://127.0.0.1:19056', published = [];
  f.store.bindInbox({ refreshPeerState() { published.push(f.store.isDeviceOnline(f.guest.device.id)); } });
  const incoming = async () => {
    const proof = f.remote.proof('sync', { genesis: f.genesis, events: [], known: [], endpoint: { deviceId: f.guest.device.id, baseUrl: address }, peers: [{ deviceId: randomUUID(), baseUrl: 'http://127.0.0.1:19057', online: true }] });
    const req = { method: 'POST', socket: { remoteAddress: '127.0.0.1' }, async *[Symbol.asyncIterator]() { yield Buffer.from(JSON.stringify(proof)); } };
    await f.store.handle(req, { writeHead() {}, end() {} }, new URL('http://localhost/api/peer/sync'));
  };
  await incoming();
  assert.equal(f.store.isDeviceOnline(f.guest.device.id), true);
  assert.equal(f.store.peers().find(peer => peer.baseUrl === address).online, false, 'endpoint trust stays separate');
  assert.equal(await f.store.sync(address), false);
  assert.equal(f.store.isDeviceOnline(f.guest.device.id), true, 'failed outgoing route cannot erase actual incoming activity');
  f.advance(14000); await incoming();
  assert.equal(f.store.isDeviceOnline(f.guest.device.id), true, 'only a fresh direct signature renews presence');
  f.advance(15001); f.store.remember({ deviceId: f.guest.device.id, baseUrl: address, online: true });
  await f.store.syncAll();
  assert.equal(f.store.isDeviceOnline(f.guest.device.id), false);
  assert.equal(published.at(-1), false, 'expiry reaches existing connected UIs without waiting for a successful peer');
  const disk = await readFile(path.join(f.root, 'peer.json'), 'utf8');
  assert.equal(disk.includes('incomingActivity'), false, 'runtime presence is never persisted as address gossip');
});


test('local append reaches a live peer while several discovery routes remain blocked', async t => {
  const gate = deferred(), entered = deferred(); let probes = 0;
  const fast = 'http://127.0.0.1:19099';
  const f = await fixture(t, async url => {
    if (url !== fast) { if (++probes === 2) entered.resolve(); await gate.promise; throw Error('offline'); }
  });
  f.remember(fast); await f.store.sync(fast);
  const work = Array.from({ length: 8 }, (_, index) => f.store.sync(`http://127.0.0.1:${19000 + index}`));
  try {
    await entered.promise;
    await f.store.append('rename', { name: 'immediate-live-change' });
    const deadline = Date.now() + 1000;
    while (f.remote.state().name !== 'immediate-live-change') {
      assert.ok(Date.now() < deadline, 'live push must not wait for blocked probe requests');
      await new Promise(resolve => setTimeout(resolve, 5));
    }
    assert.equal(probes, 2, 'probe lanes remain blocked while live delivery succeeds');
  } finally { gate.resolve(); await Promise.all(work); }
});

test('append during an in-flight shared sync is delivered without another poll', async t => {
  const gate = deferred(), entered = deferred(); let hold = false;
  const address = 'http://127.0.0.1:19099';
  const f = await fixture(t, async () => { if (hold) { hold = false; entered.resolve(); await gate.promise; } });
  f.remember(address); await f.store.sync(address); hold = true;
  const syncing = f.store.sync(address);
  await entered.promise;
  await f.store.append('rename', { name: 'arrived-during-sync' });
  const joined = f.store.sync(address); assert.equal(syncing, joined);
  gate.resolve(); assert.equal(await syncing, true);
  assert.equal(f.remote.state().name, 'arrived-during-sync');
});
