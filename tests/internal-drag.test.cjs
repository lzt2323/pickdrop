const test = require('node:test');
const assert = require('node:assert/strict');
const { createInternalDragRegistry } = require('../apps/desktop/internal-drag.cjs');
test('native outgoing path is ignored on any target, external files and same names survive', () => {
  const registry = createInternalDragRegistry();
  registry.begin(17, '/cache/group/image.png');
  assert.deepEqual(registry.allowedIndexes(['/cache/group/image.png']), []);
  assert.deepEqual(registry.allowedIndexes(['/Downloads/image.png', '/cache/group/image.png', '']), [0, 2]);
});
test('end/drop IPC ordering retains exact identity without imposing a general drop lock', () => {
  let now = 0; const registry = createInternalDragRegistry({ now: () => now });
  registry.begin(1, '/cache/a'); registry.end(1);
  assert.deepEqual(registry.allowedIndexes(['/cache/a', '/Downloads/a']), [1]);
  registry.end(2); now = 1501;
  assert.deepEqual(registry.allowedIndexes(['/cache/a']), [0]);
});
test('failed drag and a new native session clear former identity', () => {
  const registry = createInternalDragRegistry();
  registry.begin(1, '/cache/a'); registry.cancel(1);
  assert.deepEqual(registry.allowedIndexes(['/cache/a']), [0]);
  registry.begin(1, '/cache/a'); registry.begin(2, '/cache/b');
  assert.deepEqual(registry.allowedIndexes(['/cache/a', '/cache/b']), [0]);
});
test('Windows real paths match despite case and separators, but never just basename', () => {
  const registry = createInternalDragRegistry({ platform: 'win32' });
  registry.begin(1, 'C:\\Cache\\Group\\Photo.PNG');
  assert.deepEqual(registry.allowedIndexes(['c:/cache/group/photo.png', 'C:\\Downloads\\Photo.PNG']), [1]);
});
