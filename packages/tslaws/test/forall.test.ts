// `forall` and `exists` run as plain loops in property tests and lower over the array model in the prover.
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { after, describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';
import { exists, forall } from '../dist/api.js';
import { check } from '../dist/check.js';
import { readManifest } from '../dist/compile.js';
import { writeLock } from '../dist/lock.js';
import type { CheckOptions, LawResult } from '../dist/types.js';

const compiler = process.env.TSC_LAWS_BIN;
const here = dirname(fileURLToPath(import.meta.url));
const root = mkdtempSync(join(here, '..', '.tmp-forall-'));

after(() => {
  rmSync(root, { recursive: true, force: true });
  setTimeout(() => process.exit(process.exitCode ?? 0), 100).unref();
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

const sum = [
  'export function sum(xs: number[]): number {',
  '  let s = 0;',
  '  for (const x of xs) s += x;',
  '  return s;',
  '}',
  '',
].join('\n');

describe('forall and exists at runtime', () => {
  it('follow the quantifier semantics', () => {
    assert.equal(
      forall([], () => false),
      true,
    );
    assert.equal(
      exists([], () => true),
      false,
    );
    assert.equal(
      forall([1, 2, 3], (x) => x > 0),
      true,
    );
    assert.equal(
      forall([1, -2, 3], (x) => x > 0),
      false,
    );
    assert.equal(
      exists([1, -2, 3], (x) => x < 0),
      true,
    );
    assert.equal(
      exists([1, 2, 3], (x) => x < 0),
      false,
    );
    assert.equal(
      forall([5, 6, 7], (x, i) => x === i + 5),
      true,
    );
  });
});

describe('forall and exists in the prover', { skip: compiler === undefined ? 'set TSC_LAWS_BIN' : false }, () => {
  it('prove a claim under an assumed forall, bounded like the array', async () => {
    const opts = project('assume', {
      'src/f.ts': sum,
      'src/f.laws.ts': [
        "import { assume, forall } from 'tslaws';",
        "import type { int } from 'tslaws';",
        "import { sum } from './f';",
        'export law allPositiveSumPositive(xs: int[]) {',
        '  assume(forall(xs, (x) => x > 0));',
        '  return sum(xs) >= 0;',
        '}',
        '',
      ].join('\n'),
    });
    const { results } = await check(opts, true);
    assert.equal(byName(results, 'allPositiveSumPositive').status, 'bounded', JSON.stringify(results));
  });

  it('use outer variables and the index in the predicate', async () => {
    const opts = project('outer', {
      'src/f.laws.ts': [
        "import { assume, forall } from 'tslaws';",
        "import type { int } from 'tslaws';",
        'export law aboveFloor(xs: int[], lo: int) {',
        '  assume(forall(xs, (x, i) => x >= lo + i));',
        '  return forall(xs, (x) => x >= lo);',
        '}',
        '',
      ].join('\n'),
    });
    const { results } = await check(opts, true);
    assert.equal(byName(results, 'aboveFloor').status, 'bounded', JSON.stringify(results));
  });

  it('fail a wrong exists claim with a counterexample', async () => {
    const opts = project('wrong', {
      'src/f.laws.ts': [
        "import type { int } from 'tslaws';",
        "import { exists } from 'tslaws';",
        'export law someNegative(xs: int[]) {',
        '  return exists(xs, (x) => x < 0);',
        '}',
        '',
      ].join('\n'),
    });
    const { results } = await check(opts, true);
    const r = byName(results, 'someNegative');
    assert.equal(r.status, 'failed', JSON.stringify(r));
  });

  it('range over the arrays an invariant loop changes', async () => {
    const opts = project('loop', {
      'src/f.ts': [
        "import { forall, invariant } from 'tslaws';",
        "import type { int } from 'tslaws';",
        'export function zeroed(xs: int[]): int[] {',
        '  const ys = [...xs];',
        '  let i = 0;',
        '  while (i < ys.length) {',
        '    invariant(0 <= i && i <= ys.length);',
        '    invariant(forall(ys, (y, j) => j >= i || y === 0));',
        '    ys[i] = 0 as int;',
        '    i += 1;',
        '  }',
        '  return ys;',
        '}',
        '',
      ].join('\n'),
      'src/f.laws.ts': [
        "import { forall } from 'tslaws';",
        "import type { int } from 'tslaws';",
        "import { zeroed } from './f';",
        'export law allZero(xs: int[]) { return forall(zeroed(xs), (y) => y === 0); }',
        '',
      ].join('\n'),
    });
    const { results } = await check(opts, true);
    assert.equal(byName(results, 'allZero').status, 'bounded', JSON.stringify(results));
  });

  it('leave a predicate that does not lower tested', async () => {
    const opts = project('opaque', {
      'src/f.laws.ts': [
        "import { forall } from 'tslaws';",
        "import type { int } from 'tslaws';",
        'const positive = (x: int) => x > 0;',
        'export law viaName(xs: int[]) {',
        '  return forall(xs, positive) === xs.every((x) => x > 0);',
        '}',
        '',
      ].join('\n'),
    });
    const { results } = await check(opts, true);
    assert.equal(byName(results, 'viaName').status, 'tested', JSON.stringify(results));
  });
});
