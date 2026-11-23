// Directory imports (`./Dir` -> `./Dir/index.ts`), barrel re-exports, and graceful handling of unreadable modules
// in the symbolic executor and coverage analyzer (issue #105).
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { after, describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';
import { check } from '../dist/check.js';
import { readManifest } from '../dist/compile.js';
import { writeLock } from '../dist/lock.js';
import { Executor, resolveRelativeJs, Unsupported } from '../dist/symbolic.js';
import type { CheckOptions, LawResult } from '../dist/types.js';

const here = dirname(fileURLToPath(import.meta.url));
const root = mkdtempSync(join(here, '..', '.tmp-dir-imports-'));

after(() => {
  rmSync(root, { recursive: true, force: true });
});

function project(name: string, files: Record<string, string>): CheckOptions {
  const cwd = join(root, name);
  for (const [file, text] of Object.entries(files)) {
    mkdirSync(dirname(join(cwd, file)), { recursive: true });
    writeFileSync(join(cwd, file), text);
  }
  const options: CheckOptions = {
    files: ['src/f.laws.ts'],
    cwd,
    runs: 100,
    compiler: 'builtin',
    lockFile: join(cwd, 'tsc-laws.lock'),
    noProve: false,
    bound: 4,
    proofTimeoutMs: 10000,
  };
  writeLock(options.lockFile, readManifest('builtin', options.files, cwd));
  return options;
}

function byName(results: LawResult[], name: string): LawResult {
  const found = results.find((r) => r.name === name);
  assert.ok(found, `no result for ${name}: ${JSON.stringify(results)}`);
  return found;
}

describe('directory imports in symbolic executor and coverage (#105)', () => {
  it('resolves ./Dir to Dir/index.js when Dir.js does not exist', () => {
    const dir = join(root, 'resolve-check');
    mkdirSync(join(dir, 'StatTile'), { recursive: true });
    writeFileSync(join(dir, 'StatTile', 'index.js'), 'exports.x = 1;\n');
    writeFileSync(join(dir, 'plain.js'), 'exports.y = 2;\n');
    const from = join(dir, 'main.js');
    assert.equal(resolveRelativeJs(from, './StatTile'), join(dir, 'StatTile', 'index.js'));
    assert.equal(resolveRelativeJs(from, './plain'), join(dir, 'plain.js'));
  });

  it('throws Unsupported instead of ENOENT when a referenced module cannot be read', () => {
    const executor = new Executor(4);
    assert.throws(() => executor.index(join(root, 'does-not-exist.js')), Unsupported);
  });

  it('proves laws that import from a directory index and barrel re-exports without crashing', async () => {
    const opts = project('barrel', {
      'src/StatTile/math.ts': [
        "import type { int } from 'tslaws';",
        'export const SCALE = 2;',
        'export function double(x: int): int { return (x * SCALE) as int; }',
        '',
      ].join('\n'),
      'src/StatTile/extra.ts': [
        "import type { int } from 'tslaws';",
        'export function inc(x: int): int { return (x + 1) as int; }',
        '',
      ].join('\n'),
      'src/StatTile/index.ts': [
        "import type { int } from 'tslaws';",
        "export { double, SCALE } from './math';",
        "export * from './extra';",
        'export function clampZero(x: int): int { return (x < 0 ? 0 : x) as int; }',
        '',
      ].join('\n'),
      'src/f.laws.ts': [
        "import { assume, law } from 'tslaws';",
        "import type { int } from 'tslaws';",
        "import { clampZero, double, inc, SCALE } from './StatTile';",
        "law.proved('clampZero is non-negative', (x: int) => clampZero(x) >= 0);",
        "law.proved('double uses scale', (x: int) => { assume(x >= -1000 && x <= 1000); return double(x) === x * SCALE; });",
        "law.proved('inc adds one', (x: int) => { assume(x >= -1000 && x <= 1000); return inc(x) === x + 1; });",
        '',
      ].join('\n'),
    });
    const report = await check(opts, true);
    assert.equal(report.compileDiagnostics, '');
    assert.equal(byName(report.results, 'clampZero is non-negative').status, 'proved');
    assert.equal(byName(report.results, 'double uses scale').status, 'proved');
    assert.equal(byName(report.results, 'inc adds one').status, 'proved');
    assert.equal(
      report.results.filter((r) => r.status === 'uncovered').length,
      0,
      `no exported functions should be uncovered: ${JSON.stringify(report.results)}`,
    );
    assert.equal(report.ok, true);
  });

  it('proves laws through a module under test that imports a directory index', async () => {
    const opts = project('nested-dir', {
      'src/StatTile/index.ts': [
        "import type { int } from 'tslaws';",
        'export function pad(x: int): int { return (x < 0 ? 0 : x) as int; }',
        '',
      ].join('\n'),
      'src/card.ts': [
        "import type { int } from 'tslaws';",
        "import { pad } from './StatTile';",
        'export function cardValue(x: int): int { return pad(x); }',
        '',
      ].join('\n'),
      'src/f.laws.ts': [
        "import { law } from 'tslaws';",
        "import type { int } from 'tslaws';",
        "import { cardValue } from './card';",
        "law.proved('cardValue is non-negative', (x: int) => cardValue(x) >= 0);",
        '',
      ].join('\n'),
    });
    const report = await check(opts, true);
    assert.equal(byName(report.results, 'cardValue is non-negative').status, 'proved');
    assert.equal(report.ok, true);
  });
});
