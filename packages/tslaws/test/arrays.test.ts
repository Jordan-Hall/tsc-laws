// Arrays that are parameters are SMT arrays with a length, so a law about them is proved for every length.
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
const root = mkdtempSync(join(here, '..', '.tmp-arrays-'));

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
    proofTimeoutMs: 20000,
  };
  writeLock(options.lockFile, readManifest(compiler!, options.files, cwd));
  return options;
}

function byName(results: LawResult[], name: string): LawResult {
  const found = results.find((r) => r.name === name);
  assert.ok(found, `no result for ${name}: ${JSON.stringify(results)}`);
  return found;
}

const lib = [
  "import type { int } from 'tslaws';",
  'export function zeroed(xs: int[]): int[] {',
  '  const ys = [...xs];',
  '  let i = 0;',
  '  while (i < ys.length) {',
  '    ys[i] = 0;',
  '    i += 1;',
  '  }',
  '  return ys;',
  '}',
  'export function largest(xs: int[]): int {',
  '  let m = 0;',
  '  let i = 0;',
  '  while (i < xs.length) {',
  '    if (xs[i] > m) m = xs[i];',
  '    i += 1;',
  '  }',
  '  return m as int;',
  '}',
  'export function firstOr(xs: int[], d: int): int {',
  '  return xs.length > 0 ? xs[0] : d;',
  '}',
  'export function withLast(xs: int[], v: int): int[] {',
  '  const ys = xs.slice();',
  '  ys.push(v);',
  '  return ys;',
  '}',
  'export function lastOf(xs: int[]): int {',
  '  const ys = [...xs];',
  '  return ys.pop() as int;',
  '}',
  'export function head(xs: int[]): int {',
  '  return xs[0];',
  '}',
  '',
].join('\n');

const header = ["import { assume } from 'tslaws';", "import type { int } from 'tslaws';"];

describe('arrays of any length', { skip: compiler === undefined ? 'set TSC_LAWS_BIN' : false }, () => {
  it('proves laws about length, reads and a copied array for every length', async () => {
    const opts = project('lengths', {
      'src/f.ts': lib,
      'src/f.laws.ts': [
        ...header,
        "import { firstOr, lastOf, withLast, zeroed, largest } from './f';",
        'export law proved pushAddsOne(xs: int[], v: int) { return withLast(xs, v).length === xs.length + 1; }',
        'export law proved firstOrIsFirst(xs: int[], d: int) { assume(xs.length > 0); return firstOr(xs, d) === xs[0]; }',
        'export law proved popsTheLast(xs: int[]) { assume(xs.length > 0); return lastOf(xs) === xs[xs.length - 1]; }',
        'export law proved zeroedKeepsLength(xs: int[]) { return zeroed(xs).length === xs.length; }',
        'export law proved largestNeverNegative(xs: int[]) { return largest(xs) >= 0; }',
        '',
      ].join('\n'),
    });
    const { results } = await check(opts, true);
    for (const name of ['pushAddsOne', 'firstOrIsFirst', 'popsTheLast', 'zeroedKeepsLength', 'largestNeverNegative'])
      assert.equal(byName(results, name).status, 'proved', JSON.stringify(byName(results, name)));
  });

  it('proves a loop over an array without a bound on its length', async () => {
    const opts = project('loop', {
      'src/f.ts': lib,
      'src/f.laws.ts': [
        ...header,
        "import { largest } from './f';",
        'export law proved atLeastFirst(xs: int[]) {',
        '  assume(xs.length > 0);',
        '  return largest(xs) >= xs[0];',
        '}',
        '',
      ].join('\n'),
    });
    const { results } = await check(opts, true);
    const r = byName(results, 'atLeastFirst');
    assert.equal(r.status, 'proved', JSON.stringify(r));
    assert.ok(!JSON.stringify(r).includes('at most'), 'no length bound is reported');
  });

  it('does not prove a false claim about every length', async () => {
    const opts = project('false', {
      'src/f.ts': lib,
      'src/f.laws.ts': [
        ...header,
        "import { withLast } from './f';",
        'export law proved pushAddsTwo(xs: int[], v: int) { return withLast(xs, v).length === xs.length + 2; }',
        '',
      ].join('\n'),
    });
    const { results } = await check(opts, true);
    assert.equal(byName(results, 'pushAddsTwo').status, 'failed', JSON.stringify(results));
  });

  it('does not prove a read that may be out of bounds', async () => {
    const opts = project('oob', {
      'src/f.ts': lib,
      'src/f.laws.ts': [
        ...header,
        "import { head } from './f';",
        'export law proved headIsHead(xs: int[]) { return head(xs) === xs[0]; }',
        '',
      ].join('\n'),
    });
    const { results } = await check(opts, true);
    // Reading an empty array gives undefined: that is outside what is modelled, so it is not called proved.
    assert.notEqual(byName(results, 'headIsHead').status, 'proved', JSON.stringify(results));
  });
});
