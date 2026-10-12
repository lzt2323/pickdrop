import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { mkdtemp, rm, readFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createGroupManager } from '../server/groups.js';
import { randomUUID, randomBytes, createHash } from 'node:crypto';
import { createMobileClient } from '../apps/mobile/src/client.js';
import { createDiscoveryController } from '../apps/mobile/src/discovery-core.js';

const memory = () => { const values = new Map(); return { values, async getItemAsync(key) { return values.get(key) || null; }, async setItemAsync(key, value) { values.set(key, value); }, async deleteItemAsync(key) { values.delete(key); } }; };
async function phone(t, name, saved = {}) {
  const storage = saved.storage || memory(), records = saved.records || memory(), blobs = saved.blobs || new Map();
  let server, baseUrl;
  const transport = {
    async start(handler) {
      if (!server) {
        server = http.createServer(async (req, res) => {
          try {
            const chunks = []; for await (const chunk of req) chunks.push(chunk);
            const value = await handler({ method: req.method, path: req.url, headers: req.headers, body: Buffer.concat(chunks).toString() });
            if (value.file) { const bytes = blobs.get(value.file); res.writeHead(200, { 'Content-Length': bytes.length }); res.end(bytes); }
            else { res.writeHead(value.status || 200, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(value.body)); }
          } catch (error) { res.writeHead(error.status || 500, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ error: error.message })); }
        });
        await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
        baseUrl = `http://127.0.0.1:${server.address().port}`;
      }
      return { baseUrl, port: server.address().port };
    },
    async stop() { if (server) { const previous = server; server = null; previous.closeAllConnections(); await new Promise(resolve => previous.close(resolve)); } },
    async importFile(uri) { const bytes = Buffer.from(uri); const sha256 = createHash('sha256').update(bytes).digest('hex'); blobs.set(sha256, bytes); return { uri: sha256, sha256, size: bytes.length }; },
    async hasFile(hash) { return blobs.has(hash) ? { uri: hash, size: blobs.get(hash).length } : null; },
  };
  const client = createMobileClient({ storage, randomUUID, deviceName: name, kind: 'android', peerOptions: { records, transport, randomBytes } });
  await client.init(); await client.setPeerActive(true);
  t.after(async () => { client.close(); await transport.stop(); });
  return { client, storage, records, blobs, transport, get baseUrl() { return baseUrl; } };
}
async function join(host, guest, id) {
  const invite = await host.client.createInvite(id);
  const ticket = await guest.client.requestJoin(invite.link);
  assert.equal((await guest.client.checkJoin(ticket)).status, 'pending');
  await host.client.respondJoin(id, ticket.requestId, true);
  return (await guest.client.checkJoin(ticket)).group;
}

test('three mobile peers retain the same group and exchange messages with creator fully offline', async t => {
  const a = await phone(t, 'A'), b = await phone(t, 'B'), c = await phone(t, 'C');
  const group = await a.client.createGroup('不依赖创建者', 'sheep');
  assert.equal(group.animalId, 'sheep');
  await join(a, b, group.id); await b.client.resolveGroup(group.id);
  await join(b, c, group.id); await c.client.resolveGroup(group.id);
  assert.equal(b.client.getGroup(group.id).animalId, 'sheep');
  assert.equal(c.client.getGroup(group.id).animalId, 'sheep');
  const invitation = await b.client.createInvite(group.id);
  assert.equal(invitation.baseUrl, new URL(invitation.link).origin);
  assert.notEqual(invitation.baseUrl, group.baseUrl);
  await a.client.setPeerActive(false);
  await b.client.api(group.id, '/api/messages', { method: 'POST', body: { text: 'A 已退出，B 继续发送' } });
  await c.client.resolveGroup(group.id);
  const state = await c.client.api(group.id, '/api/state');
  assert.equal(state.messages.at(-1).text, 'A 已退出，B 继续发送');
  assert.equal(c.client.getGroup(group.id).id, group.id);
  // No event log or unbounded roster is written to SecureStore.
  for (const [key, value] of c.storage.values) assert.ok(!value.includes('A 已退出'), key);
  assert.ok([...c.records.values.values()].some(value => value.includes('A 已退出')));
  await c.client.setPeerActive(false);
  const restarted = await phone(t, 'C restart', c);
  assert.equal((await restarted.client.api(group.id, '/api/state')).messages.at(-1).text, 'A 已退出，B 继续发送');
});

test('a background peer group updates its name and animal without a group watcher', async t => {
  const host = await phone(t, 'Host'), guest = await phone(t, 'Guest');
  const foreground = await host.client.createGroup('前台群', 'cat');
  const background = await host.client.createGroup('后台群', 'sheep');
  assert.deepEqual(host.client.listGroups().map(group => group.id), [foreground.id, background.id]);
  await join(host, guest, foreground.id); await guest.client.resolveGroup(foreground.id);
  await join(host, guest, background.id); await guest.client.resolveGroup(background.id);
  await guest.client.setActiveGroup(foreground.id);

  const metadata = [];
  const unsubscribe = guest.client.subscribeGroupMetadata(group => metadata.push(group));
  t.after(unsubscribe);
  const watcher = guest.client.watchGroup(foreground.id, { onState() {} });
  t.after(() => watcher.close());

  await host.client.renameGroup(background.id, '已更新的后台群', 'alpaca');
  guest.client.updateDiscovery([{ groupId: background.id, hostDeviceId: host.client.device.id, baseUrl: host.baseUrl }]);
  for (let attempt = 0; attempt < 100 && metadata.length === 0; attempt++) await new Promise(resolve => setTimeout(resolve, 20));
  assert.deepEqual(metadata.map(group => [group.id, group.name, group.animalId]), [[background.id, '已更新的后台群', 'alpaca']]);
  assert.equal(guest.client.listGroups().find(group => group.id === background.id).animalId, 'alpaca');
  assert.equal(guest.client.listGroups().find(group => group.id === foreground.id).animalId, 'cat');
});

test('mobile files are supplied by holder, protected by signed proof, and become available again after holder returns', async t => {
  const a = await phone(t, 'A'), b = await phone(t, 'B');
  const group = await a.client.createGroup('附件'); await join(a, b, group.id);
  const message = await a.client.peerUpload(group.id, 'file bytes', 'hello.txt', 'text/plain');
  await b.client.resolveGroup(group.id);
  const source = (await b.client.peerFileSources(group.id, message.id)).sources[0];
  assert.ok(source);
  assert.equal((await fetch(source.url)).status, 401);
  assert.equal(await (await fetch(source.url, { headers: source.headers })).text(), 'file bytes');
  // Signed file proofs are one-use, not reusable bearer URLs.
  assert.equal((await fetch(source.url, { headers: source.headers })).status, 409);
  await a.client.setPeerActive(false);
  const offline = (await b.client.peerFileSources(group.id, message.id)).sources[0];
  await assert.rejects(fetch(offline.url, { headers: offline.headers }));
  await a.client.setPeerActive(true);
  b.client.updateDiscovery([{ groupId: group.id, hostDeviceId: a.client.device.id, baseUrl: a.baseUrl }]);
  await b.client.resolveGroup(group.id);
  const sources = (await b.client.peerFileSources(group.id, message.id)).sources;
  const refreshed = sources.find(source => source.url.startsWith(a.baseUrl));
  assert.ok(refreshed);
  assert.equal(await (await fetch(refreshed.url, { headers: refreshed.headers })).text(), 'file bytes');
});

test('a runtime without native peer support rejects peer invitations explicitly', async () => {
  const client = createMobileClient({ storage: memory(), randomUUID }); await client.init();
  await assert.rejects(client.requestJoin(`http://127.0.0.1:1/#invite=123456&group=${randomUUID()}&protocol=peer`), /Android/);
  assert.equal(client.peerSupported, false);
});

test('a newly joined phone bootstraps a lagging member beyond 128 events after inviter exits', async t => {
  const a = await phone(t, 'A'), b = await phone(t, 'B'), c = await phone(t, 'C');
  const group = await a.client.createGroup('分页'); await join(a, b, group.id);
  await b.client.resolveGroup(group.id); await a.client.setPeerActive(false);
  for (let index = 0; index < 130; index++) await b.client.api(group.id, '/api/messages', { method: 'POST', body: { text: 'page ' + index } });
  await join(b, c, group.id); await c.client.resolveGroup(group.id);
  assert.equal((await c.client.api(group.id, '/api/state')).messages.length, 130);
  await b.client.setPeerActive(false); await a.client.setPeerActive(true);
  c.client.updateDiscovery([{ groupId: group.id, hostDeviceId: a.client.device.id, baseUrl: a.baseUrl }]);
  await c.client.resolveGroup(group.id);
  assert.equal((await a.client.api(group.id, '/api/state')).messages.length, 130);
  await c.client.api(group.id, '/api/messages', { method: 'POST', body: { text: 'new phone independent' } });
  await c.client.resolveGroup(group.id);
  assert.equal((await a.client.api(group.id, '/api/state')).messages.at(-1).text, 'new phone independent');
});

test('failed durable approval rolls back membership and keeps the approval ticket retryable', async t => {
  const a = await phone(t, 'A'), b = await phone(t, 'B'); const group = await a.client.createGroup('原子审批');
  const invite = await a.client.createInvite(group.id), ticket = await b.client.requestJoin(invite.link);
  const write = a.records.setItemAsync; a.records.setItemAsync = async () => { throw new Error('disk full'); };
  await assert.rejects(a.client.respondJoin(group.id, ticket.requestId, true), /disk full/);
  assert.equal((await b.client.checkJoin(ticket)).status, 'pending');
  assert.equal((await a.client.api(group.id, '/api/state')).devices.length, 1);
  a.records.setItemAsync = write; await a.client.respondJoin(group.id, ticket.requestId, true);
  assert.equal((await b.client.checkJoin(ticket)).status, 'approved');
});


test('real desktop group and mobile node sync both directions and desktop downloads phone-owned file', async t => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'pickdrop-mobile-desktop-'));
  const desktop = await createGroupManager({ dataDir: root, device: { id: randomUUID(), name: 'Windows', kind: 'desktop' }, host: '127.0.0.1', peerGroups: true, directoryPort: 0, discoveryFactory: async () => ({ list: () => [], refresh() {}, async close() {} }), monitorIntervalMs: 600000 });
  t.after(async () => { await desktop.close({ force: true }); await rm(root, { recursive: true, force: true }); });
  const mobile = await phone(t, 'Android'), group = await desktop.createGroup('跨平台群');
  const invite = await desktop.createInvite(group.id), ticket = await mobile.client.requestJoin(`${group.baseUrl}/#invite=${invite.code}&group=${group.id}&protocol=peer`);
  await desktop.respondJoin(group.id, ticket.requestId, true); await mobile.client.checkJoin(ticket);
  await mobile.client.resolveGroup(group.id);
  await mobile.client.api(group.id, '/api/messages', { method: 'POST', body: { text: '来自手机' } });
  await mobile.client.resolveGroup(group.id);
  assert.equal((await desktop.authenticated(group.id, '/api/state')).messages.at(-1).text, '来自手机');
  await desktop.authenticated(group.id, '/api/messages', { method: 'POST', body: { text: '来自桌面' } });
  await mobile.client.resolveGroup(group.id);
  assert.equal((await mobile.client.api(group.id, '/api/state')).messages.at(-1).text, '来自桌面');
  const file = await mobile.client.peerUpload(group.id, 'phone-owned bytes', 'phone.txt', 'text/plain');
  await mobile.client.resolveGroup(group.id);
  assert.equal((await readFile(await desktop.preparePeerFile(group.id, file.id))).toString(), 'phone-owned bytes');
});

test('discovery endpoint gets no history or peer addresses before fresh signed authentication', async t => {
  const a = await phone(t, 'A'); const group = await a.client.createGroup('秘密');
  await a.client.api(group.id, '/api/messages', { method: 'POST', body: { text: '必须留在已授权成员之间' } });
  const requests = [];
  const impostor = http.createServer(async (req, res) => { const chunks = []; for await (const chunk of req) chunks.push(chunk); requests.push(JSON.parse(Buffer.concat(chunks))); res.writeHead(200, { 'Content-Type': 'application/json' }); res.end('{}'); });
  await new Promise(resolve => impostor.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => { impostor.closeAllConnections(); impostor.close(resolve); }));
  const baseUrl = `http://127.0.0.1:${impostor.address().port}`;
  a.client.updateDiscovery([{ groupId: group.id, hostDeviceId: randomUUID(), baseUrl }]);
  await a.client.resolveGroup(group.id);
  await assert.rejects(a.client.reconnectAt(group.id, baseUrl), error => error.status === 503);
  assert.ok(requests.length);
  for (const proof of requests) {
    assert.deepEqual(proof.payload.events, []); assert.deepEqual(proof.payload.known, []);
    assert.equal(proof.payload.peers, undefined); assert.equal(proof.payload.endpoint, undefined);
    assert.ok(!JSON.stringify(proof).includes('必须留在已授权成员之间'));
  }
});

test('offline leave disappears locally, survives restart and synchronizes before rejoining', async t => {
  const a = await phone(t, 'A'), b = await phone(t, 'B');
  const group = await a.client.createGroup('退出持久化'); await join(a, b, group.id); await b.client.resolveGroup(group.id);
  await a.client.setPeerActive(false);
  await b.client.leaveGroup(group.id);
  await b.client.leaveGroup(group.id);
  await assert.rejects(b.client.api(group.id, '/api/messages', { method: 'POST', body: { text: 'forbidden' } }), error => error.status === 403);
  await b.client.removeGroup(group.id);
  assert.equal(b.client.listGroups().length, 0);
  const record = () => JSON.parse(b.records.values.get('peer_' + group.id));
  assert.equal(record().events.filter(event => event.type === 'member.leave').length, 1);
  assert.equal(record().pendingDeparture.acknowledged, false);
  await b.client.setPeerActive(false);
  const restarted = await phone(t, 'B restart', b);
  assert.equal(restarted.client.listGroups().length, 0);
  await a.client.setPeerActive(true);
  restarted.client.updateDiscovery([{ groupId: group.id, hostDeviceId: a.client.device.id, baseUrl: a.baseUrl }]);
  for (let attempt = 0; attempt < 350 && !record().pendingDeparture.acknowledged; attempt++) await new Promise(resolve => setTimeout(resolve, 20));
  assert.equal(record().pendingDeparture.acknowledged, true);
  assert.ok(!(await a.client.api(group.id, '/api/state')).devices.some(member => member.id === b.client.device.id));
  await join(a, restarted, group.id);
  await restarted.client.api(group.id, '/api/messages', { method: 'POST', body: { text: 'new authorization' } });
  assert.equal(record().pendingDeparture, undefined);
  assert.equal(restarted.client.listGroups().length, 1);
  assert.deepEqual(JSON.parse(b.records.values.get('peer-departures-v1')), []);
});

// Protocol harness deliberately controls reachable addresses and signed hints;
// it does not rely on LAN multicast or the timing of periodic discovery.
async function peerHarness(t, { localCreator = false } = {}) {
  const { createMobilePeer } = await import('../apps/mobile/src/peer-client.js');
  const { createPeerIdentity, createPeerGenesis, createPeerReplica } = await import('../shared/peer-protocol.js');
  const localDevice = { id: randomUUID(), name: 'phone', kind: 'android' };
  const remoteDevice = { id: randomUUID(), name: 'desktop', kind: 'desktop' };
  const localIdentity = createPeerIdentity(randomBytes(32).toString('hex'));
  const remoteIdentity = createPeerIdentity(randomBytes(32).toString('hex'));
  const groupId = randomUUID(), genesis = createPeerGenesis({ groupId, name: 'gossip', identity: localCreator ? localIdentity : remoteIdentity, device: localCreator ? localDevice : remoteDevice });
  const creator = createPeerReplica({ identity: localCreator ? localIdentity : remoteIdentity, device: localCreator ? localDevice : remoteDevice, genesis, randomBytes });
  creator.append('member.add', localCreator ? { ...remoteDevice, publicKey: remoteIdentity.publicKey } : { ...localDevice, publicKey: localIdentity.publicKey });
  const remote = createPeerReplica({ identity: remoteIdentity, device: remoteDevice, ...creator.snapshot(), randomBytes });
  let responder = remote;
  const credentials = memory(), records = memory(), calls = [], reachable = new Set(['http://127.0.0.1:47001']);
  await credentials.setItemAsync('pickdrop-peer-identity-v1', localIdentity.privateKey);
  let networkGate; const addressGates = new Map();
  let handler, advertised = 'http://127.0.0.1:47001', hints = [];
  let localEndpoint = 'http://127.0.0.1:47000', failStart = false, startCount = 0, startGate, nativeRunning = false;
  const advertisements = [];
  const runtime = createMobilePeer({ credentials, records, randomUUID, randomBytes, device: () => localDevice,
    transport: {
      async start(value) { startCount++; if (startGate) await startGate; if (failStart) { failStart = false; throw new Error('IPv4 not ready'); } handler = value; nativeRunning = true; return { baseUrl: localEndpoint, port: Number(new URL(localEndpoint).port) }; },
      async stop() { nativeRunning = false; }, async advertise(groups) { advertisements.push(groups); },
    },
    async fetchImpl(url, options) {
      if (networkGate) await networkGate;
      const address = new URL(url).origin, proof = JSON.parse(options.body); calls.push({ address, proof });
      if (addressGates.has(address)) await addressGates.get(address);
      if (!reachable.has(address)) throw new Error('ECONNREFUSED');
      const payload = remote.verifyProof(proof, 'sync'); remote.merge(payload.events);
      const snapshot = remote.snapshot();
      return { ok: true, async json() { return responder.proof('sync-result', { ...snapshot, known: snapshot.events.map(event => event.eventId), peers: hints, endpoint: { deviceId: remoteDevice.id, baseUrl: advertised } }); } };
    },
  });
  await runtime.accept({ id: groupId, creatorDeviceId: remoteDevice.id, peer: remote.snapshot() });
  await runtime.start(); await runtime.sync(groupId);
  t.after(() => runtime.stop());
  return { runtime, groupId, remote, remoteDevice, calls, reachable, records, advertisements,
    get startCount() { return startCount; },
    get nativeRunning() { return nativeRunning; },
    changeLocalEndpoint(value) { localEndpoint = value; },
    failNextStart() { failStart = true; },
    holdAddress(address) { let release; addressGates.set(address, new Promise(resolve => { release = resolve; })); return () => { addressGates.delete(address); release(); }; },
    holdNetwork() { let release; networkGate = new Promise(resolve => { release = resolve; }); return () => { networkGate = undefined; release(); }; },
    holdNativeStart() { let release; startGate = new Promise(resolve => { release = resolve; }); return () => { startGate = undefined; release(); }; },
    impersonate() { responder = createPeerReplica({ identity: createPeerIdentity(randomBytes(32).toString('hex')), device: remoteDevice, ...remote.snapshot(), randomBytes }); },
    replaceEndpointOwner() {
      const nextDevice = { id: randomUUID(), name: 'replacement member', kind: 'desktop' };
      const nextIdentity = createPeerIdentity(randomBytes(32).toString('hex'));
      remote.append('member.add', { ...nextDevice, publicKey: nextIdentity.publicKey });
      responder = createPeerReplica({ identity: nextIdentity, device: nextDevice, ...remote.snapshot(), randomBytes });
      return nextDevice.id;
    },
    record: () => JSON.parse(records.values.get('peer_' + groupId)),
    advertise(value) { advertised = value; }, hints(value) { hints = value; },
    incoming(payload) { return handler({ method: 'POST', path: '/api/peer/sync', body: JSON.stringify(remote.proof('sync', { ...remote.snapshot(), known: [], ...payload })), headers: {} }); },
  };
}

test('mobile gossips addresses both ways only after authentication and keeps locally verified presence', async t => {
  const h = await peerHarness(t), target = 'http://127.0.0.1:47001';
  const third = { deviceId: randomUUID(), baseUrl: 'http://127.0.0.1:47002', seenAt: Date.now() + 999999 };
  await h.incoming({ endpoint: { deviceId: h.remoteDevice.id, baseUrl: target }, peers: [third] });
  assert.equal(h.record().peers.find(peer => peer.baseUrl === third.baseUrl).seenAt, 0, 'remote timestamps are never presence evidence');
  await h.runtime.sync(h.groupId);
  const targetCalls = h.calls.filter(call => call.address === target);
  assert.equal(targetCalls[0].proof.payload.peers, undefined);
  assert.equal(targetCalls[0].proof.payload.endpoint, undefined);
  assert.deepEqual(targetCalls[0].proof.payload.events, []);
  assert.ok(targetCalls[1].proof.payload.peers.some(peer => peer.baseUrl === third.baseUrl), 'authenticated outgoing request shares learned third-party addresses');
  assert.ok(targetCalls[1].proof.payload.peers.every(peer => peer.seenAt === undefined));
  const verifiedAt = h.record().peers.find(peer => peer.baseUrl === target).seenAt;
  assert.ok(verifiedAt > 0);
  await h.incoming({ peers: [{ deviceId: h.remoteDevice.id, baseUrl: target, seenAt: 0 }] });
  assert.equal(h.record().peers.find(peer => peer.baseUrl === target).seenAt, verifiedAt, 'gossip cannot clear direct verification');
  h.advertise('http://127.0.0.1:47003');
  h.hints([{ deviceId: h.remoteDevice.id, baseUrl: target, seenAt: 0 }]);
  await h.runtime.sync(h.groupId);
  assert.ok(h.record().peers.find(peer => peer.baseUrl === target).seenAt >= verifiedAt);
  assert.equal(h.record().peers.find(peer => peer.baseUrl === 'http://127.0.0.1:47003').seenAt, 0, 'signed advertised endpoint is learned but remains unprobed');
});

test('mobile rotates bounded connection batches past sixteen stale addresses', async t => {
  const h = await peerHarness(t);
  const stale = Array.from({ length: 20 }, (_, index) => ({ deviceId: randomUUID(), baseUrl: `http://127.0.0.1:${48000 + index}` }));
  await h.incoming({ peers: [...stale, { deviceId: h.remoteDevice.id, baseUrl: 'http://127.0.0.1:47001' }] });
  h.calls.length = 0;
  await h.runtime.sync(h.groupId);
  assert.equal(new Set(h.calls.map(call => call.address)).size, 16);
  assert.ok(!h.calls.some(call => call.address === 'http://127.0.0.1:47001'));
  await h.runtime.sync(h.groupId);
  assert.ok(h.calls.some(call => call.address === 'http://127.0.0.1:47001'), 'later viable endpoint is eventually dialed');
  assert.ok(h.record().peers.find(peer => peer.baseUrl === 'http://127.0.0.1:47001').seenAt > 0);
});


test('mobile creator reconnects directly to a member at a new endpoint without a creator hint', async t => {
  const h = await peerHarness(t, { localCreator: true });
  await h.runtime.message(h.groupId, 'private offline history');
  await h.runtime.sync(h.groupId);
  const address = 'http://127.0.0.1:49001';
  h.reachable.clear(); h.reachable.add(address); h.advertise(address);
  await h.runtime.connect(h.groupId, address);
  const calls = h.calls.filter(call => call.address === address);
  assert.deepEqual(calls[0].proof.payload.events, []);
  assert.deepEqual(calls[0].proof.payload.known, []);
  assert.equal(calls[0].proof.payload.peers, undefined);
  assert.equal(calls[0].proof.payload.endpoint, undefined);
  assert.ok(calls.slice(1).some(call => call.proof.payload.events.some(event => event.type === 'message')));
  assert.equal(h.record().peers.find(peer => peer.baseUrl === address).deviceId, h.remoteDevice.id);
  assert.ok(h.record().peers.find(peer => peer.baseUrl === address).seenAt > 0);
  assert.ok(h.remote.state().messages.some(message => message.text === 'private offline history'));
});

test('manual mobile reconnect rejects an endpoint impersonating a member without leaking history', async t => {
  const h = await peerHarness(t, { localCreator: true });
  await h.runtime.message(h.groupId, 'must remain private');
  await h.runtime.sync(h.groupId);
  const address = 'http://127.0.0.1:49002';
  h.reachable.add(address); h.impersonate();
  const before = h.record();
  await assert.rejects(h.runtime.connect(h.groupId, address), error => error.status === 503);
  const calls = h.calls.filter(call => call.address === address);
  assert.equal(calls.length, 1, 'invalid signature stops after the empty handshake');
  assert.deepEqual(calls[0].proof.payload.events, []);
  assert.deepEqual(calls[0].proof.payload.known, []);
  assert.equal(calls[0].proof.payload.peers, undefined);
  assert.equal(calls[0].proof.payload.endpoint, undefined);
  assert.deepEqual(h.record(), before, 'unverified endpoints and snapshots are not persisted');
});

test('desktop and phone automatically discover each other through creator gossip and exchange bytes after creator exits', { timeout: 20000 }, async t => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'pickdrop-mixed-gossip-'));
  const desktops = [];
  t.after(async () => {
    await Promise.all(desktops.map(desktop => desktop.close({ force: true })));
    await rm(root, { recursive: true, force: true });
  });
  const makeDesktop = async name => {
    const desktop = await createGroupManager({
      dataDir: path.join(root, name), device: { id: randomUUID(), name, kind: 'desktop' },
      host: '127.0.0.1', peerGroups: true, directoryPort: 0,
      discoveryFactory: async () => ({ list: () => [], refresh() {}, async close() {} }),
      monitorIntervalMs: 150, networkPollMs: 600000,
    });
    desktops.push(desktop); return desktop;
  };
  const waitFor = async (predicate, description) => {
    const deadline = Date.now() + 14000;
    while (!predicate()) {
      assert.ok(Date.now() < deadline, description);
      await new Promise(resolve => setTimeout(resolve, 25));
    }
  };
  const a = await makeDesktop('creator'), b = await makeDesktop('survivor'), c = await phone(t, 'Android');
  const group = await a.createGroup('自动混合端互通');
  const bInvite = await a.createInvite(group.id), bTicket = await b.joinAt(group.baseUrl, bInvite.code);
  await a.respondJoin(group.id, bTicket.requestId, true);
  const bGroup = (await b.checkJoin(bTicket)).group;
  const cInvite = await a.createInvite(group.id);
  const cTicket = await c.client.requestJoin(`${group.baseUrl}/#invite=${cInvite.code}&group=${group.id}&protocol=peer`);
  await a.respondJoin(group.id, cTicket.requestId, true); await c.client.checkJoin(cTicket);
  const phoneRecord = () => JSON.parse(c.records.values.get('peer_' + group.id));
  // Discovery is empty, and neither survivor is manually given the other's
  // address or explicitly synced. These reads only observe background polling.
  await waitFor(() => b.getPeerStore(group.id).peers().some(peer => peer.deviceId === c.client.device.id && peer.baseUrl === c.baseUrl && peer.online)
    && phoneRecord().peers.some(peer => peer.deviceId === b.device.id && peer.baseUrl === bGroup.baseUrl && peer.seenAt > 0), 'background gossip must establish both survivor endpoints');
  await a.close({ force: true });
  await assert.rejects(fetch(group.baseUrl + '/api/peer/info'), 'creator HTTP service is actually gone');

  const desktopMessage = await b.authenticated(group.id, '/api/messages', { method: 'POST', body: { text: 'desktop after creator shutdown' } });
  const phoneMessage = await c.client.api(group.id, '/api/messages', { method: 'POST', body: { text: 'phone after creator shutdown' } });
  await waitFor(() => phoneRecord().events.some(event => event.type === 'message' && event.payload.id === desktopMessage.id)
    && b.getPeerStore(group.id).state().messages.some(message => message.id === phoneMessage.id), 'new messages must propagate in both directions without creator');

  const desktopBytes = randomBytes(8193), phoneBytes = randomBytes(6145);
  const uploaded = await fetch(bGroup.baseUrl + '/api/files?name=desktop.bin', {
    method: 'POST', headers: { 'X-Room-Key': bGroup.key, 'X-Device-Id': b.device.id }, body: desktopBytes,
  });
  assert.equal(uploaded.status, 201);
  const desktopFile = await uploaded.json();
  const phoneFile = await c.client.peerUpload(group.id, phoneBytes, 'phone.bin', 'application/octet-stream');
  await waitFor(() => phoneRecord().events.some(event => event.type === 'message' && event.payload.id === desktopFile.id)
    && b.getPeerStore(group.id).state().messages.some(message => message.id === phoneFile.id), 'file metadata must propagate in both directions without creator');
  // Metadata has already arrived via the background protocol before download
  // APIs run; downloading cannot disguise a missing gossip connection.
  const sources = await c.client.peerFileSources(group.id, desktopFile.id);
  const source = sources.sources.find(value => value.url.startsWith(bGroup.baseUrl + '/'));
  assert.ok(source, 'phone downloads the surviving desktop-owned bytes');
  const downloaded = await fetch(source.url, { headers: source.headers });
  assert.equal(downloaded.status, 200);
  assert.deepEqual(Buffer.from(await downloaded.arrayBuffer()), desktopBytes);
  assert.deepEqual(await readFile(await b.preparePeerFile(group.id, phoneFile.id)), phoneBytes);

  const previousEndpoint = c.baseUrl;
  await c.client.setPeerActive(false); await c.client.setPeerActive(true);
  assert.notEqual(c.baseUrl, previousEndpoint, 'phone transport reopened on a different port');
  await waitFor(() => b.getPeerStore(group.id).peers().some(peer => peer.deviceId === c.client.device.id && peer.baseUrl === c.baseUrl && peer.online), 'phone advertises its changed endpoint through signed sync without discovery');
  const resumed = await b.authenticated(group.id, '/api/messages', { method: 'POST', body: { text: 'after phone endpoint changed' } });
  await waitFor(() => phoneRecord().events.some(event => event.type === 'message' && event.payload.id === resumed.id), 'same group recovers automatically after phone changes port');
});


test('mobile gossip cannot replace a freshly verified address owner but a new member signature can', async t => {
  const h = await peerHarness(t), address = 'http://127.0.0.1:47001';
  await h.runtime.connect(h.groupId, address);
  const verified = h.record().peers.find(peer => peer.baseUrl === address);
  const impostorId = randomUUID();
  await h.incoming({ peers: [{ deviceId: impostorId, baseUrl: address, seenAt: Date.now() + 999999 }] });
  assert.deepEqual(h.record().peers.find(peer => peer.baseUrl === address), verified, 'unverified conflicting gossip cannot overwrite local presence evidence');
  const nextOwner = h.replaceEndpointOwner();
  await h.runtime.connect(h.groupId, address);
  const replaced = h.record().peers.find(peer => peer.baseUrl === address);
  assert.equal(replaced.deviceId, nextOwner, 'fresh signed membership can establish a changed address owner');
  assert.ok(replaced.seenAt >= verified.seenAt);
});


test('mobile periodic endpoint refresh recovers a changed LAN address and a failed native start without discovery', async t => {
  t.mock.timers.enable({ apis: ['setInterval'] });
  const h = await peerHarness(t);
  await h.incoming({ endpoint: { deviceId: h.remoteDevice.id, baseUrl: 'http://127.0.0.1:47001' } });
  await h.runtime.sync(h.groupId);
  const genesis = h.record().genesis;
  const settle = async predicate => {
    for (let round = 0; round < 100; round++) {
      if (predicate()) return;
      await new Promise(resolve => setImmediate(resolve));
    }
    assert.ok(predicate(), 'scheduled native refresh and signed sync must finish');
  };
  const nextAddress = 'http://127.0.0.2:47000';
  h.changeLocalEndpoint(nextAddress);
  const previousStarts = h.startCount;
  // No discover, connect, start or app foreground transition after the change.
  t.mock.timers.tick(4000);
  await settle(() => h.calls.some(call => call.proof.payload.endpoint?.baseUrl === nextAddress));
  assert.equal(h.startCount, previousStarts + 1, 'one native refresh per normal cycle');
  assert.equal(h.runtime.endpoint().baseUrl, nextAddress);
  assert.deepEqual(h.record().genesis, genesis, 'address refresh preserves the group and signing identity');
  assert.ok(h.advertisements.at(-1).some(group => group.groupId === h.groupId));

  h.failNextStart();
  t.mock.timers.tick(4000);
  await settle(() => h.runtime.endpoint() === null);
  assert.equal(h.runtime.state(h.groupId).networkWarning, 'IPv4 not ready');
  const recoveredAddress = 'http://127.0.0.3:47000';
  h.changeLocalEndpoint(recoveredAddress);
  t.mock.timers.tick(4000);
  await settle(() => h.calls.some(call => call.proof.payload.endpoint?.baseUrl === recoveredAddress));
  assert.equal(h.runtime.endpoint().baseUrl, recoveredAddress);
  assert.equal(h.runtime.state(h.groupId).networkWarning, null);
  assert.deepEqual(h.record().genesis, genesis);
  const release = h.holdNativeStart(), beforeBlocked = h.startCount;
  t.mock.timers.tick(4000);
  await settle(() => h.startCount === beforeBlocked + 1);
  t.mock.timers.tick(12000);
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(h.startCount, beforeBlocked + 1, 'overlapping timer ticks share one in-flight native start');
  release();
  await new Promise(resolve => setImmediate(resolve));
  await h.runtime.stop();
  const stoppedStarts = h.startCount;
  t.mock.timers.tick(12000);
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(h.startCount, stoppedStarts, 'stopping the node cancels periodic native retries');
});


test('peer status and discovery callbacks settle instead of feeding an online-refresh loop', async t => {
  const mobile = await phone(t, 'feedback regression');
  const group = await mobile.client.createGroup('稳定扫描');
  let scanStarts = 0, statusUpdates = 0, overflow = false, closed = false;
  const controller = createDiscoveryController({
    async start() { scanStarts++; }, async stop() {},
    addListener() { return { remove() {} }; },
  }, { pairedGroups: mobile.client.listGroups(), timeoutMs: 600000 });
  const unsubscribe = controller.subscribe(value => mobile.client.updateDiscovery(value.devices));
  const states = [], statuses = [];
  const watcher = mobile.client.watchGroup(group.id, {
    onState: state => states.push(state),
    onStatus(value) {
      statuses.push(value); statusUpdates++;
      if (statusUpdates > 20) { overflow = true; return; }
      // Reproduce the original UI feedback wiring, using real client and
      // discovery code. Even this old wiring must settle on a stable status.
      if (value === 'online') queueMicrotask(() => {
        if (closed) return;
        controller.setPairedGroups(mobile.client.listGroups());
        void controller.start();
      });
    },
  });
  t.after(() => { closed = true; watcher.close(); unsubscribe(); controller.dispose(); });
  const drain = async () => { for (let round = 0; round < 30; round++) await new Promise(resolve => setImmediate(resolve)); };
  await drain();
  assert.equal(overflow, false);
  assert.deepEqual(statuses, ['online']);
  assert.equal(scanStarts, 1, 'sync state publications must not restart discovery');
  for (let n = 0; n < 3; n++) await mobile.client.api(group.id, '/api/messages', { method: 'POST', body: { text: 'message ' + n } });
  controller.setPairedGroups(mobile.client.listGroups());
  await drain();
  assert.ok(states.at(-1).messages.some(message => message.text === 'message 2'), 'state updates continue while status is deduplicated');
  assert.deepEqual(statuses, ['online']);
  assert.equal(scanStarts, 1);
  watcher.setActive(false); watcher.setActive(false);
  watcher.setActive(true); watcher.setActive(true);
  await drain();
  assert.deepEqual(statuses, ['online', 'paused', 'online'], 'real foreground transitions still notify once');
  assert.equal(scanStarts, 2);
});


test('foreground resume during a pending stop retains the latest native listener', async t => {
  const h = await peerHarness(t);
  const release = h.holdNativeStart();
  const refreshing = h.runtime.start();
  const stopping = h.runtime.stop();
  const resumed = h.runtime.start();
  release();
  await Promise.all([refreshing, stopping, resumed]);
  assert.equal(h.nativeRunning, true, 'old background cleanup must not close the foreground listener');
  assert.equal(h.runtime.isActive(), true, 'resume resolves only after its actual listener is ready');
});

test('fresh authenticated incoming sync is presence evidence, never URL or gossip verification', async t => {
  t.mock.timers.enable({ apis: ['Date'], now: Date.now() });
  const h = await peerHarness(t), target = 'http://127.0.0.1:47001';
  await h.incoming({ endpoint: { deviceId: h.remoteDevice.id, baseUrl: target } });
  await h.runtime.sync(h.groupId);
  const verifiedAt = h.record().peers.find(peer => peer.baseUrl === target).seenAt;
  t.mock.timers.tick(16000);
  assert.equal(h.runtime.state(h.groupId).devices.find(member => member.id === h.remoteDevice.id).online, false);
  const advertised = 'http://127.0.0.1:49991';
  await h.incoming({ endpoint: { deviceId: h.remoteDevice.id, baseUrl: advertised }, peers: [{deviceId:randomUUID(),baseUrl:'http://127.0.0.1:49992',seenAt:Date.now()}] });
  assert.equal(h.runtime.state(h.groupId).devices.find(member => member.id === h.remoteDevice.id).online, true,
    'the directly received valid member signature proves this device is currently online');
  assert.equal(h.record().peers.find(peer => peer.baseUrl === advertised).seenAt, 0, 'claimed return address has not been probed');
  assert.equal(h.record().peers.find(peer => peer.baseUrl === target).seenAt, verifiedAt, 'incoming activity does not invent route reachability');
  t.mock.timers.tick(15001);
  assert.equal(h.runtime.state(h.groupId).devices.find(member => member.id === h.remoteDevice.id).online, false, 'unchanged 15 second expiry still applies');
});

test('mobile sync reserves heartbeat slots while exploring a full stale address directory', async t => {
  t.mock.timers.enable({ apis: ['Date'], now: Date.now() });
  const h = await peerHarness(t), target = 'http://127.0.0.1:47001';
  await h.incoming({ endpoint: { deviceId: h.remoteDevice.id, baseUrl: target } });
  await h.runtime.sync(h.groupId);
  await h.incoming({ peers: Array.from({length:60}, (_,index)=>({deviceId:randomUUID(),baseUrl:`http://127.0.0.1:${48000+index}`})) });
  for(let cycle=0;cycle<5;cycle++) {
    t.mock.timers.tick(4000); h.calls.length=0;
    await h.runtime.sync(h.groupId);
    const addresses=new Set(h.calls.map(call=>call.address));
    assert.ok(addresses.has(target), 'a live peer cannot wait behind old unverified endpoints');
    assert.ok(addresses.size<=16 && addresses.size>1, 'bounded batch retains discovery capacity');
  }
});

test('leave and removal do not await an already blocked network sync', async t => {
  const h = await peerHarness(t);
  const release = h.holdNetwork();
  const syncing = h.runtime.sync(h.groupId);
  try {
    await Promise.race([
      (async () => { await h.runtime.depart(h.groupId, 'member.leave'); await h.runtime.forget(h.groupId); })(),
      new Promise((_, reject) => { const timer = setTimeout(() => reject(new Error('Local exit waited for network')), 500); timer.unref(); }),
    ]);
    await assert.rejects(h.runtime.message(h.groupId, 'forbidden'), error => error.status === 403);
  } finally { release(); await syncing; }
});

test('old pending leave without outbox migrates on restart and stays hidden', async t => {
  const a = await phone(t, 'A'), b = await phone(t, 'B');
  const group = await a.client.createGroup('old pending'); await join(a, b, group.id);
  await a.client.setPeerActive(false);
  await b.client.leaveGroup(group.id);
  await b.client.setPeerActive(false);
  // Old versions retained the visible group and only its pendingDeparture record.
  b.records.values.delete('peer-departures-v1');
  const restored = await phone(t, 'B', b);
  assert.equal(restored.client.listGroups().length, 0);
  assert.deepEqual(JSON.parse(b.records.values.get('peer-departures-v1')), [group.id]);
});

test('a slow address cannot delay new messages to a healthy peer', async t => {
  const h = await peerHarness(t);
  await h.runtime.connect(h.groupId, 'http://127.0.0.1:47001');
  const slow = 'http://127.0.0.1:49999', release = h.holdAddress(slow);
  h.runtime.discover([{ groupId: h.groupId, hostDeviceId: h.remoteDevice.id, baseUrl: slow }]);
  try {
    for (let i = 0; i < 30 && !h.calls.some(call => call.address === slow); i++) await new Promise(resolve => setTimeout(resolve, 5));
    await new Promise(resolve => setTimeout(resolve, 30));
    const message = await h.runtime.message(h.groupId, 'send without waiting for stale endpoint');
    for (let i = 0; i < 40 && !h.remote.state().messages.some(item => item.id === message.id); i++) await new Promise(resolve => setTimeout(resolve, 10));
    assert.ok(h.remote.state().messages.some(item => item.id === message.id), 'healthy peer receives before the blocked route finishes or the 4s timer');
  } finally { release(); await h.runtime.sync(h.groupId); }
});

test('dissolved mobile groups hide immediately and relay after restart to an offline member', async t => {
  const a = await phone(t, 'A'), b = await phone(t, 'B'), c = await phone(t, 'C');
  const group = await a.client.createGroup('dissolve relay');
  await join(a, b, group.id); await join(a, c, group.id); await b.client.resolveGroup(group.id);
  await c.client.setPeerActive(false);
  const notices = []; b.client.subscribeGroupMetadata(value => notices.push(value));
  await a.client.dissolveGroup(group.id);
  assert.equal(b.client.listGroups().length, 0);
  assert.ok(notices.some(value => value.dissolved));
  assert.throws(() => b.client.getGroup(group.id), error => error.status === 410);
  await b.client.removeGroup(group.id);
  await a.client.setPeerActive(false); await b.client.setPeerActive(false);
  const restarted = await phone(t, 'B restart', b);
  assert.equal(restarted.client.listGroups().length, 0);
  await c.client.setPeerActive(true);
  restarted.client.updateDiscovery([{ groupId: group.id, hostDeviceId: c.client.device.id, baseUrl: c.baseUrl }]);
  for (let i = 0; i < 350 && c.client.listGroups().length; i++) await new Promise(resolve => setTimeout(resolve, 20));
  assert.equal(c.client.listGroups().length, 0);
  assert.throws(() => c.client.getGroup(group.id), error => error.status === 410);
  assert.ok(JSON.parse(b.records.values.get('peer_' + group.id)).events.some(event => event.type === 'dissolve'));
});
