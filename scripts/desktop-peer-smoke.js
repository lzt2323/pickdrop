import { firstContentWindow, nextContentWindow } from './desktop-test-windows.js';
import assert from 'node:assert/strict';
import { _electron as electron } from 'playwright';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { randomBytes } from 'node:crypto';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url));
const executablePath = process.env.PICKDROP_TEST_EXECUTABLE || createRequire(import.meta.url)('electron');
const packaged = Boolean(process.env.PICKDROP_TEST_EXECUTABLE);

const dir = await mkdtemp(path.join(tmpdir(), 'pickdrop-peer-desktop-'));
const apps = [], errors = [];
const connected = page => page.waitForFunction(() => document.querySelector('#connection-status')?.dataset.connected === 'true', null, { timeout: 20000 });
const bootstrap = page => page.evaluate(() => window.pickdrop.bootstrap());
async function start(name) {
  const app = await electron.launch({ executablePath, args: packaged ? [] : [root], cwd: root, env: { ...process.env, PICKDROP_TEST_LEGACY_GROUPS: '0', PICKDROP_USER_DATA: path.join(dir, name) } });
  apps.push(app);
  const page = await firstContentWindow(app);
  page.on('pageerror', error => errors.push(error.message));
  await connected(page); return { app, page };
}
async function join(owner, peer, groupId) {
  const invitation = await owner.evaluate(() => window.pickdrop.createInvite());
  const ticket = await peer.page.evaluate(value => window.pickdrop.joinAt(value.baseUrl, value.code, value.groupId), { ...invitation, groupId });
  const requests = await owner.evaluate(() => window.pickdrop.listJoinRequests());
  const list = Array.isArray(requests) ? requests : requests.requests;
  const peerId = (await bootstrap(peer.page)).device.id;
  const request = list.find(item => item.device.id === peerId); assert.ok(request);
  await owner.evaluate(id => window.pickdrop.respondJoin(id, true), request.id);
  const opened = nextContentWindow(peer.app);
  await peer.page.evaluate(value => window.pickdrop.checkJoin(value), ticket);
  const page = await opened; page.on('pageerror', error => errors.push(error.message)); await connected(page); return page;
}
async function send(page, text) {
  await page.locator('#message-input').fill(text); await page.locator('#send-text').click();
  await page.getByText(text, { exact: true }).waitFor();
}
try {
  const owner = await start('creator'), b = await start('peer-b'), c = await start('peer-c');
  const initial = await bootstrap(owner.page), groupId = initial.group.id;
  assert.equal(initial.group.mode, 'peer'); assert.equal(initial.group.canManage, true);
  const bGroup = await join(owner.page, b, groupId), cGroup = await join(owner.page, c, groupId);
  assert.equal((await bootstrap(bGroup)).group.canManage, false);
  await send(owner.page, '三台设备同步');
  await bGroup.getByText('三台设备同步', { exact: true }).waitFor({ timeout: 20000 });
  await cGroup.getByText('三台设备同步', { exact: true }).waitFor({ timeout: 20000 });
  // Joining only through the creator must discover the other member through
  // signed address exchange. Do not manually reconnect survivors: that would
  // conceal a broken automatic mesh when multicast is unavailable.
  const bId = (await bootstrap(bGroup)).device.id;
  const cId = (await bootstrap(cGroup)).device.id;
  for (const [page, peerId] of [[bGroup, cId], [cGroup, bId]]) {
    await page.waitForFunction(async id => {
      const { room, device } = await window.pickdrop.bootstrap();
      const response = await fetch(room.baseUrl + '/api/state', {
        headers: { 'X-Room-Key': room.key, 'X-Device-Id': device.id },
      });
      const state = await response.json();
      return state.devices.some(member => member.id === id && member.online);
    }, peerId, { timeout: 30000 });
  }
  await owner.app.close(); apps.splice(apps.indexOf(owner.app), 1);
  await assert.rejects(fetch(initial.room.baseUrl + '/api/peer/info', { signal: AbortSignal.timeout(1000) }),
    'The creator must stop serving, not just hide its window');
  for (const [sender, receiver, label] of [[bGroup, cGroup, 'B到C'], [cGroup, bGroup, 'C到B']]) {
    const text = `创建电脑退出后继续发送：${label}`;
    await send(sender, text);
    await receiver.getByText(text, { exact: true }).waitFor({ timeout: 20000 });
    const bytes = randomBytes(256 * 1024 + 13), fileName = `无主机互传-${label}.bin`;
    await sender.locator('#file-input').setInputFiles({ name: fileName, mimeType: 'application/octet-stream', buffer: bytes });
    await receiver.getByText(fileName, { exact: true }).waitFor({ timeout: 20000 });
    const fileId = await receiver.evaluate(async name => {
      const { room, device } = await window.pickdrop.bootstrap();
      const state = await (await fetch(room.baseUrl + '/api/state', { headers: { 'X-Room-Key': room.key, 'X-Device-Id': device.id } })).json();
      return state.messages.find(item => item.fileName === name).id;
    }, fileName);
    assert.equal(await receiver.evaluate(id => window.pickdrop.prepareFile(id), fileId), true);
    const config = await bootstrap(receiver);
    const downloaded = await fetch(config.room.baseUrl + '/api/files/' + fileId, { headers: { 'X-Room-Key': config.room.key, 'X-Device-Id': config.device.id } });
    assert.equal(downloaded.status, 200); assert.deepEqual(Buffer.from(await downloaded.arrayBuffer()), bytes);
  }
  await bGroup.locator('#members-button').click();
  assert.equal(await bGroup.locator('#delete-group').count(), 0, 'replica is not owner');
  assert.equal(await bGroup.locator('#rename-group').count(), 0, 'replica cannot rename group');
  await bGroup.locator('#close-panel').click();
  assert.deepEqual(errors, []);
  console.log('Desktop peer smoke passed: three real processes, signed pairing, creator port closed, bidirectional survivor messages and verified file transfers, creator-only controls.');
} finally {
  await Promise.allSettled(apps.map(app => app.close()));
  await rm(dir, { recursive: true, force: true });
}
