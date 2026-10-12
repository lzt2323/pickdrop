import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { createGroupManager } from '../server/groups.js';

test('native desktop transport sends signed sync with UTF-8 Content-Length accepted by Android framing', async t => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'pickdrop-android-http-'));
  const managers = [];
  let strict;
  t.after(async () => {
    if (strict) { strict.closeAllConnections(); await new Promise(resolve => strict.close(resolve)); }
    await Promise.all(managers.map(manager => manager.close({ force: true })));
    await rm(root, { recursive: true, force: true });
  });
  const make = async name => {
    // Deliberately omit fetchImpl: production's node:http path must be exercised.
    const manager = await createGroupManager({
      dataDir: path.join(root, name), device: { id: randomUUID(), name, kind: 'desktop' },
      host: '127.0.0.1', peerGroups: true, directoryPort: 0,
      discoveryFactory: async () => ({ list: () => [], refresh() {}, async close() {} }),
      monitorIntervalMs: 600000, networkPollMs: 600000,
    });
    managers.push(manager); return manager;
  };
  const desktop = await make('桌面'), phone = await make('安卓');
  const group = await desktop.createGroup('中文同步验收');
  const invite = await desktop.createInvite(group.id);
  const ticket = await phone.joinAt(group.baseUrl, invite.code, group.id);
  await desktop.respondJoin(group.id, ticket.requestId, true);
  const joined = (await phone.checkJoin(ticket)).group;
  const text = '桌面发给安卓：你好，世界！🐶';
  const message = await desktop.authenticated(group.id, '/api/messages', { method: 'POST', body: { text } });
  const captured = [];
  strict = http.createServer(async (req, res) => {
    try {
      const chunks = []; for await (const chunk of req) chunks.push(chunk);
      const bytes = Buffer.concat(chunks), raw = bytes.toString('utf8');
      captured.push({ headers: req.headers, bytes: bytes.length, raw });
      // Match PickDropPeerModule.kt: no transfer-encoding; read exactly Content-Length bytes.
      if (req.headers['transfer-encoding'] || Number(req.headers['content-length']) !== bytes.length) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Unsupported Android request framing' })); return;
      }
      const forwarded = await fetch(joined.baseUrl + req.url, {
        method: req.method, headers: { 'Content-Type': 'application/json' }, body: bytes,
      });
      res.writeHead(forwarded.status, { 'Content-Type': 'application/json' }); res.end(await forwarded.text());
    } catch (error) {
      res.writeHead(500, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ error: error.message }));
    }
  });
  await new Promise(resolve => strict.listen(0, '127.0.0.1', resolve));
  const address = `http://127.0.0.1:${strict.address().port}`;
  const rejected = await new Promise((resolve, reject) => {
    const req = http.request(address + '/api/peer/sync', { method: 'POST' }, res => { res.resume(); res.on('end', () => resolve(res.statusCode)); });
    req.on('error', reject); req.write('{}'); req.end();
  });
  assert.equal(rejected, 400, 'The fixture must reject Node chunked requests just like Android');
  captured.length = 0;
  assert.equal(await desktop.getPeerStore(group.id).sync(address), true, 'Native signed POST must pass Android framing and finish synchronization');
  assert.ok(captured.length >= 2, 'Check both initial signed authentication and history synchronization');
  for (const request of captured) {
    assert.equal(request.headers['transfer-encoding'], undefined);
    assert.equal(Number(request.headers['content-length']), request.bytes);
    assert.equal(request.bytes, Buffer.byteLength(request.raw, 'utf8'));
    assert.equal(JSON.parse(request.raw).operation, 'sync');
  }
  const historyRequest = captured.find(request => request.raw.includes(text));
  assert.ok(historyRequest, 'Signed history must carry the Chinese message');
  assert.ok(historyRequest.bytes > historyRequest.raw.length, 'Length must measure UTF-8 bytes, not JS characters');
  assert.equal(phone.getPeerStore(group.id).state().messages.find(item => item.id === message.id)?.text, text);
});
