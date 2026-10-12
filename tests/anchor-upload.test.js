import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
const { sendAnchorFile } = createRequire(import.meta.url)('../apps/desktop/anchor-upload.cjs');
test('anchor streams exact file bytes, preserves MIME and waits for acknowledgement', async () => {
  const blob = new Blob(['hello animal']),
    updates = [],
    controller = new AbortController();
  let acknowledged = false;
  await sendAnchorFile({
    blob,
    url: 'http://localhost/files',
    headers: { 'Content-Type': 'text/plain' },
    signal: controller.signal,
    progress: (n) => updates.push(n),
    fetch: async (url, options) => {
      assert.equal(options.headers['Content-Type'], 'text/plain');
      assert.equal(options.signal, controller.signal);
      assert.equal(await new Response(options.body).text(), 'hello animal');
      acknowledged = true;
      return { ok: true };
    },
  });
  assert.equal(acknowledged, true);
  assert.equal(updates.at(-1), blob.size);
});
test('anchor cancellation during stream cannot complete', async () => {
  const controller = new AbortController();
  await assert.rejects(
    sendAnchorFile({
      blob: new Blob(['abc']),
      url: 'local',
      headers: {},
      signal: controller.signal,
      progress: () => controller.abort(),
      fetch: async (_url, options) => {
        await new Response(options.body).text();
        return { ok: true };
      },
    }),
    { name: 'AbortError' },
  );
});
test('anchor rejects server failure and pre-cancelled requests', async () => {
  const controller = new AbortController();
  await assert.rejects(
    sendAnchorFile({
      blob: new Blob([]),
      url: 'local',
      headers: {},
      signal: controller.signal,
      progress: () => {},
      fetch: async () => ({ ok: false, status: 503 }),
    }),
    /503/,
  );
  controller.abort();
  await assert.rejects(
    sendAnchorFile({
      blob: new Blob([]),
      signal: controller.signal,
      fetch: () => {
        throw Error('must not fetch');
      },
    }),
    { name: 'AbortError' },
  );
});
