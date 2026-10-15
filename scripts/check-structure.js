import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const rootFiles = new Set([
  'AGENTS.md', 'README.md', 'CONTRIBUTING.md', 'LICENSE', 'Cargo.toml', 'Cargo.lock',
  'package.json', 'pnpm-lock.yaml', 'pnpm-workspace.yaml', 'rust-toolchain.toml',
  '.gitignore', '.gitattributes',
]);
const rootDirectories = new Set([
  '.github', '.hallmark', 'apps', 'assets', 'crates', 'docs', 'scripts',
  'tests', 'vendor',
]);
const documentEntries = new Set([
  'README.md', 'PROJECT.md', 'STATUS.md', 'DECISIONS.md', 'tauri-migration.md',
  'android-emulator.md',
]);
const documentDirectories = new Set(['releases']);
const frontend = 'apps/tauri/src/';
const domainModules = new Set(['model', 'file-drafts', 'file-transfers', 'join-request']);

// This checks literal JS dependencies, not computed imports or a security boundary.
// Build/runtime tests remain responsible for language semantics and resolution.
function imports(source) {
  // Keep quoted values as single tokens so examples in comments/strings cannot
  // become dependencies. Template-computed specifiers remain outside this check.
  const tokens = [...source.matchAll(/\/\*[\s\S]*?\*\/|\/\/[^\r\n]*|"(?:\\[\s\S]|[^"\\])*"|'(?:\\[\s\S]|[^'\\])*'|`(?:\\[\s\S]|[^`\\])*`|[\w$]+|[^\s]/g)]
    .map(match => match[0]).filter(token => !token.startsWith('//') && !token.startsWith('/*'));
  const quoted = token => token && /^['"]/.test(token);
  const result = [];
  for (let index = 0; index < tokens.length; index++) {
    const keyword = tokens[index];
    if (!['import', 'export', 'require'].includes(keyword) || tokens[index - 1] === '.') continue;
    if (keyword !== 'export' && tokens[index + 1] === '(' && quoted(tokens[index + 2])) {
      result.push(tokens[index + 2].slice(1, -1));
    } else if (keyword === 'import' && quoted(tokens[index + 1])) {
      result.push(tokens[index + 1].slice(1, -1));
    } else if ((keyword !== 'require' && ['{', '*'].includes(tokens[index + 1])) ||
               (keyword === 'import' && /^[\w$]+$/.test(tokens[index + 1] || ''))) {
      for (let cursor = index + 1; cursor < tokens.length && tokens[cursor] !== ';'; cursor++) {
        if (tokens[cursor] === 'from' && quoted(tokens[cursor + 1])) {
          result.push(tokens[cursor + 1].slice(1, -1));
          break;
        }
        if (cursor > index + 1 && ['import', 'export'].includes(tokens[cursor])) break;
      }
    }
  }
  return result;
}

export function checkStructure(files, read, exists) {
  const errors = [];
  const graph = new Map();
  for (const file of files) {
    const parts = file.split('/');
    if (parts.includes('artifacts')) {
      errors.push(`${file}: generated reports belong in ignored .build/reports, not source directories`);
    }
    if (/^(?:apps\/(?:desktop|mobile|tui)|server|shared)(?:\/|$)/.test(file)) {
      errors.push(`${file}: retired Node implementation must not return to the Rust-only workspace`);
    }
    if (parts.length === 1 ? !rootFiles.has(file) : !rootDirectories.has(parts[0])) {
      errors.push(`${file}: unexpected repository root entry; assign an existing owner or update the documented structure`);
    }
    if (parts[0] === 'docs' && (parts.length === 2 ? !documentEntries.has(parts[1]) : !documentDirectories.has(parts[1]))) {
      errors.push(`${file}: document belongs in a maintained guide, releases/; obsolete archives must remain in Git history`);
    }
    if (file.startsWith(frontend) && /\.(?:js|mjs|cjs)$/.test(file)) {
      const dependencies = [];
      for (const specifier of imports(read(file))) {
        const target = specifier.startsWith('.') ? path.posix.normalize(path.posix.join(path.posix.dirname(file), specifier)) : specifier;
        if (/^(apps\/(desktop|mobile|tui)\/|server\/|shared\/|crates\/|apps\/tauri\/src-tauri\/)/.test(target)) {
          errors.push(`${file}: frontend must use its bridge, not ${specifier}`);
        }
        if (domainModules.has(file.slice(frontend.length).replace(/\.(?:js|mjs|cjs)$/, '')) &&
            (specifier.startsWith('@tauri-apps/') || /\/(main|anchor|bridge)\.(?:js|mjs|cjs)$/.test(target))) {
          errors.push(`${file}: domain logic must not import the page or native bridge (${specifier})`);
        }
        if (specifier.startsWith('.') && !exists(target)) errors.push(`${file}: missing dependency ${specifier}`);
        if (target.startsWith(frontend) && /\.(?:js|mjs|cjs)$/.test(target)) dependencies.push(target);
      }
      graph.set(file, dependencies);
    }
    // Release notes preserve historical references; maintained guides must resolve.
    const maintained = file === 'README.md' || file === 'CONTRIBUTING.md' ||
      (file.startsWith('docs/') && !file.startsWith('docs/releases/'));
    if (maintained && file.endsWith('.md')) {
      const prose = read(file).replace(/```[\s\S]*?```/g, '');
      for (const match of prose.matchAll(/\]\(([^\s)]+)(?:\s+"[^"]*")?\)/g)) {
        const link = match[1];
        if (/^(?:[a-z][a-z\d+.-]*:|#|\/)/i.test(link)) continue;
        const target = path.posix.normalize(path.posix.join(path.posix.dirname(file), link.split(/[?#]/)[0]));
        if (!exists(target)) errors.push(`${file}: broken local documentation link ${link}`);
      }
    }
  }
  const visited = new Set(), active = new Set();
  function visit(file, chain = []) {
    if (active.has(file)) { errors.push(`frontend dependency cycle: ${[...chain, file].join(' -> ')}`); return; }
    if (visited.has(file)) return;
    active.add(file);
    for (const dependency of graph.get(file) || []) visit(dependency, [...chain, file]);
    active.delete(file);
    visited.add(file);
  }
  for (const file of graph.keys()) visit(file);
  return errors;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const root = fileURLToPath(new URL('..', import.meta.url));
  const files = [...new Set(execFileSync('git', ['ls-files', '--cached', '--others', '--exclude-standard', '-z'], { cwd: root, encoding: 'utf8' }).split('\0'))]
    .filter(file => file && existsSync(path.join(root, file)));
  const errors = checkStructure(files, file => readFileSync(path.join(root, file), 'utf8'), file => existsSync(path.join(root, file)));
  if (errors.length) {
    console.error(errors.join('\n'));
    process.exitCode = 1;
  } else console.log(`Structure checks passed (${files.length} source/document files; root ownership, maintained links, literal frontend boundaries and cycles).`);
}
