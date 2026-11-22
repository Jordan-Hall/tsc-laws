// Loop invariants turn a bounded loop proof into a proof for every number of iterations.
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { after, describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';
import { check } from '../dist/check.js';
import { readManifest } from '../dist/compile.js';
import { writeLock } from '../dist/lock.js';
import type { CheckOptions, LawResult } from '../dist/types.js';

const compiler = process.env.TSC_LAWS_BIN;
const here = dirname(fileURLToPath(import.meta.url));
const root = mkdtempSync(join(here, '..', '.tmp-inv-'));

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
    compiler: compiler!,
    lockFile: join(cwd, 'tsc-laws.lock'),
    noProve: false,
    bound: 4,
    proofTimeoutMs: 10000,
  };
  writeLock(options.lockFile, readManifest(compiler!, options.files, cwd));
  return options;
}

function byName(results: LawResult[], name: string): LawResult {
  const found = results.find((r) => r.name === name);
  assert.ok(found, `no result for ${name}: ${JSON.stringify(results)}`);
  return found;
}

const sumTo = [
  "import { invariant } from 'tslaws';",
  "import type { int } from 'tslaws';",
  'export function sumTo(n: int): int {',
  '  let s = 0;',
  '  let i = 0;',
  '  while (i < n) {',
  '    invariant(0 <= i && i <= n);',
  '    invariant(2 * s === i * (i - 1));',
  '    s += i;',
  '    i += 1;',
  '  }',
  '  return s as int;',
  '}',
  '',
].join('\n');

describe('loop invariants', { skip: compiler === undefined ? 'set TSC_LAWS_BIN' : false }, () => {
  it('prove a loop for every number of iterations', async () => {
    const opts = project('sum', {
      'src/f.ts': sumTo,
      'src/f.laws.ts': [
        "import { assume } from 'tslaws';",
        "import type { int } from 'tslaws';",
        "import { sumTo } from './f';",
        'export law proved sumFormula(n: int) { assume(n >= 0 && n <= 1000000); return 2 * sumTo(n) === n * (n - 1); }',
        '',
      ].join('\n'),
    });
    const { results } = await check(opts, true);
    const r = byName(results, 'sumFormula');
    assert.equal(r.status, 'proved', JSON.stringify(r));
  });

  it('does not prove a claim about a loop whose condition changes a variable', async () => {
    const opts = project('condition', {
      'src/f.ts': [
        "import { invariant } from 'tslaws';",
        "import type { int } from 'tslaws';",
        'export function walk(n: int): int {',
        '  let i = 0;',
        '  while (i++ < n) {',
        '    invariant(i >= 0);',
        '  }',
        '  return i as int;',
        '}',
        '',
      ].join('\n'),
      'src/f.laws.ts': [
        "import { assume } from 'tslaws';",
        "import type { int } from 'tslaws';",
        "import { walk } from './f';",
        'export law proved walkIsOne(n: int) { assume(n >= 1 && n <= 1000000); return walk(n) !== 123457; }',
        '',
      ].join('\n'),
    });
    const { results } = await check(opts, true);
    const r = byName(results, 'walkIsOne');
    assert.notEqual(r.status, 'proved', JSON.stringify(r));
    assert.notEqual(r.status, 'bounded', JSON.stringify(r));
  });

  it('reject an invariant that does not hold on entry or is not preserved', async () => {
    const opts = project('bad', {
      'src/f.ts': [
        "import { invariant } from 'tslaws';",
        "import type { int } from 'tslaws';",
        'export function count(n: int): int {',
        '  let i = 0;',
        '  while (i < n) {',
        '    invariant(i < 3);',
        '    i += 1;',
        '  }',
        '  return i as int;',
        '}',
        '',
      ].join('\n'),
      'src/f.laws.ts': [
        "import { assume } from 'tslaws';",
        "import type { int } from 'tslaws';",
        "import { count } from './f';",
        'export law proved counts(n: int) { assume(n >= 0 && n < 100); return count(n) === n; }',
        '',
      ].join('\n'),
    });
    const { results } = await check(opts, true);
    // i < 3 is not preserved (i reaches 3), and a property run reaches it too: the invariant throws.
    const status = byName(results, 'counts').status;
    assert.ok(status === 'failed' || status === 'open', status);
  });

  it('prove a law that depends on the exit state, not only the invariant', async () => {
    const opts = project('exit', {
      'src/f.ts': [
        "import { invariant } from 'tslaws';",
        "import type { int } from 'tslaws';",
        'export function clampUp(x: int, lo: int): int {',
        '  let y: number = x;',
        '  while (y < lo) {',
        '    invariant(y <= lo);',
        '    y += 1;',
        '  }',
        '  return y as int;',
        '}',
        '',
      ].join('\n'),
      'src/f.laws.ts': [
        "import { assume } from 'tslaws';",
        "import type { int } from 'tslaws';",
        "import { clampUp } from './f';",
        'export law proved atLeastLo(x: int, d: int) { assume(d >= 0 && d <= 1000 && x >= -1000000 && x <= 1000000); return clampUp(x, (x + d) as int) === x + d; }',
        '',
      ].join('\n'),
    });
    const { results } = await check(opts, true);
    assert.equal(byName(results, 'atLeastLo').status, 'proved', JSON.stringify(byName(results, 'atLeastLo')));
  });

  it('prove loops that return or break early', async () => {
    const opts = project('early', {
      'src/f.ts': [
        "import { invariant } from 'tslaws';",
        "import type { int } from 'tslaws';",
        'export function firstSquareAtLeast(n: int, k: int): int {',
        '  let i = 0;',
        '  while (i < n) {',
        '    invariant(0 <= i && i <= n);',
        '    if (i * i >= k) return i;',
        '    i += 1;',
        '  }',
        '  return n;',
        '}',
        'export function stopAtSquare(n: int, k: int): int {',
        '  let i = 0;',
        '  while (i < n) {',
        '    invariant(0 <= i && i <= n);',
        '    if (i * i >= k) break;',
        '    i += 1;',
        '  }',
        '  return i;',
        '}',
        '',
      ].join('\n'),
      'src/f.laws.ts': [
        "import { assume } from 'tslaws';",
        "import type { int } from 'tslaws';",
        "import { firstSquareAtLeast, stopAtSquare } from './f';",
        'export law proved returnsInRange(n: int, k: int) {',
        '  assume(n >= 0 && n <= 1000 && k >= 0 && k <= 1000000);',
        '  const r = firstSquareAtLeast(n, k);',
        '  return r >= 0 && r <= n && (r === n || r * r >= k);',
        '}',
        'export law neverStopsEarly(n: int, k: int) {',
        '  assume(n >= 0 && n <= 1000 && k >= 0 && k <= 1000000);',
        '  return stopAtSquare(n, k) === n;',
        '}',
        'export law proved breaksInRange(n: int, k: int) {',
        '  assume(n >= 0 && n <= 1000 && k >= 0 && k <= 1000000);',
        '  const r = stopAtSquare(n, k);',
        '  return r >= 0 && r <= n && (r === n || r * r >= k);',
        '}',
        '',
      ].join('\n'),
    });
    const { results } = await check(opts, true);
    assert.equal(
      byName(results, 'neverStopsEarly').status,
      'failed',
      JSON.stringify(byName(results, 'neverStopsEarly')),
    );
    for (const name of ['returnsInRange', 'breaksInRange'])
      assert.equal(byName(results, name).status, 'proved', JSON.stringify(byName(results, name)));
  });

  it('reject a loop whose early exit breaks the law', async () => {
    const opts = project('earlybad', {
      'src/f.ts': [
        "import { invariant } from 'tslaws';",
        "import type { int } from 'tslaws';",
        'export function find(n: int, k: int): int {',
        '  let i = 0;',
        '  while (i < n) {',
        '    invariant(0 <= i && i <= n);',
        '    if (i * i >= k) return i + n;',
        '    i += 1;',
        '  }',
        '  return n;',
        '}',
        '',
      ].join('\n'),
      'src/f.laws.ts': [
        "import { assume } from 'tslaws';",
        "import type { int } from 'tslaws';",
        "import { find } from './f';",
        'export law proved inRange(n: int, k: int) {',
        '  assume(n >= 0 && n <= 1000 && k >= 0 && k <= 1000000);',
        '  return find(n, k) <= n;',
        '}',
        '',
      ].join('\n'),
    });
    const { results } = await check(opts, true);
    assert.equal(byName(results, 'inRange').status, 'failed', JSON.stringify(byName(results, 'inRange')));
  });

  it('track arrays changed inside an invariant loop', async () => {
    const opts = project('arrays', {
      'src/f.ts': [
        "import { invariant } from 'tslaws';",
        "import type { int } from 'tslaws';",
        'export function zeroFirst(xs: int[], n: int): int[] {',
        '  const ys = [...xs];',
        '  let i = 0;',
        '  while (i < n) {',
        '    invariant(0 <= i && i <= n);',
        '    invariant(ys.length === xs.length);',
        '    ys[i] = 0 as int;',
        '    i += 1;',
        '  }',
        '  return ys;',
        '}',
        '',
      ].join('\n'),
      'src/f.laws.ts': [
        "import { assume } from 'tslaws';",
        "import type { int } from 'tslaws';",
        "import { zeroFirst } from './f';",
        'export law keepsLength(xs: int[], n: int) {',
        '  assume(n >= 0 && n <= xs.length);',
        '  return zeroFirst(xs, n).length === xs.length;',
        '}',
        '',
      ].join('\n'),
    });
    const { results } = await check(opts, true);
    assert.equal(byName(results, 'keepsLength').status, 'proved', JSON.stringify(byName(results, 'keepsLength')));
  });

  it('does not prove a loop whose body breaks an obligation on a later iteration', async () => {
    const opts = project('obligations', {
      'src/f.ts': [
        "import { invariant } from 'tslaws';",
        "import type { int } from 'tslaws';",
        'export function scan(a: int[]): int {',
        '  let i = 0;',
        '  let hits = 0;',
        '  while (i < 3) {',
        '    invariant(0 <= i && i <= 3);',
        '    if (a[i] === 7) hits = 1;',
        '    i += 1;',
        '  }',
        '  return i as int;',
        '}',
        'export function grow(n: int): int {',
        '  let s = 1;',
        '  let i = 0;',
        '  while (i < n) {',
        '    invariant(0 <= i && i <= n && s >= 1);',
        '    s = s * 2;',
        '    i += 1;',
        '  }',
        '  return s as int;',
        '}',
        '',
      ].join('\n'),
      'src/f.laws.ts': [
        "import { assume } from 'tslaws';",
        "import type { int } from 'tslaws';",
        "import { grow, scan } from './f';",
        'export law proved scansThree(a: int[]) { return scan(a) === 3; }',
        'export law proved growsPositive(n: int) { assume(n >= 0 && n <= 100); return grow(n) >= 1; }',
        '',
      ].join('\n'),
    });
    const { results } = await check(opts, true);
    for (const name of ['scansThree', 'growsPositive']) {
      const status = byName(results, name).status;
      assert.ok(status !== 'proved' && status !== 'bounded', `${name} was called ${status}`);
    }
  });
});
