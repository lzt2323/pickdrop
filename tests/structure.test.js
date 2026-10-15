import { test } from 'node:test';
import assert from 'node:assert/strict';
import { checkStructure } from '../scripts/check-structure.js';

function check(contents) {
  return checkStructure(Object.keys(contents), file => contents[file], file => Object.hasOwn(contents, file));
}

test('structure accepts domain dependencies and maintained documentation', () => {
  assert.deepEqual(check({
    'README.md': '[Project](docs/PROJECT.md)', 'docs/PROJECT.md': 'Project',
    'apps/tauri/src/main.js': "import { model } from './model.js';",
    'apps/tauri/src/model.js': 'export const model = {};',
  }), []);
});

test('structure rejects loose root files and unclassified document directories', () => {
  const errors = check({ 'scratch.md': '', 'plans/next.md': '', 'docs/random/notes.md': '' });
  assert.equal(errors.length, 3);
});

test('retired Node applications cannot return to the Rust-only workspace', () => {
  for (const directory of ['apps/desktop', 'apps/mobile', 'apps/tui', 'server', 'shared']) {
    assert.ok(check({ [`${directory}/index.js`]: '' }).some(error => error.includes('retired Node implementation')));
  }
});

test('frontend cannot import legacy services or its domain import native bridge', () => {
  const errors = check({
    'apps/tauri/src/main.js': "export { server } from '../../../server/index.js';",
    'server/index.js': 'export const server = {};',
    'apps/tauri/src/file-transfers.js': "const plugin = await import('@tauri-apps/api/core');",
  });
  assert.ok(errors.some(error => error.includes('frontend must use its bridge')));
  assert.ok(errors.some(error => error.includes('domain logic')));
});

test('join request lifecycle cannot depend on page rendering or a native plugin', () => {
  for (const specifier of ['./main.js', './bridge.js', '@tauri-apps/api/core']) {
    const errors = check({ 'apps/tauri/src/join-request.js': `import '${specifier}';` });
    assert.ok(errors.some(error => error.includes('domain logic')));
  }
});

test('structure finds indirect frontend cycles and missing imports', () => {
  const errors = check({
    'apps/tauri/src/a.js': "import './b.js'; import './missing.js';",
    'apps/tauri/src/b.js': "export * from './a.js';",
  });
  assert.ok(errors.some(error => error.includes('dependency cycle')));
  assert.ok(errors.some(error => error.includes('missing dependency')));
});

test('maintained links fail while historical local artifact evidence remains allowed', () => {
  const errors = check({
    'docs/README.md': '[Missing](missing.md)',
    'docs/archive/report.md': '[Evidence](../../artifacts/not-in-git.png)',
  });
  assert.equal(errors.length, 1);
  assert.match(errors[0], /broken local documentation link/);
});

test('comments and strings containing import examples are not dependencies', () => {
  assert.deepEqual(check({
    'apps/tauri/src/model.js': `// import './old.js';
      /* export * from './missing.js'; */
      const example = "import './old.js'";
      const template = \`require('./not-a-module.js')\`;
      export const model = {};`,
  }), []);
});

test('mjs and cjs modules also enforce boundaries and dependency cycles', () => {
  const errors = check({
    'apps/tauri/src/a.mjs': "import './b.cjs'; import '../../../shared/peer-protocol.js';",
    'apps/tauri/src/b.cjs': "require('./a.mjs');",
    'shared/peer-protocol.js': '',
  });
  assert.ok(errors.some(error => error.includes('frontend must use its bridge')));
  assert.ok(errors.some(error => error.includes('dependency cycle')));
});
