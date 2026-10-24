// End to end: each case writes a small project, compiles it with tsc-laws and checks its laws.
// Needs the built compiler in TSC_LAWS_BIN and `npm run build` for dist/.
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { after, describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';
import { check, exemptionsOf } from '../dist/check.js';
import { readManifest } from '../dist/compile.js';
import { writeLock } from '../dist/lock.js';
import type { CheckOptions, LawResult } from '../dist/types.js';

const compiler = process.env.TSC_LAWS_BIN;
const here = dirname(fileURLToPath(import.meta.url));
// Inside the repo so `tslaws` and `fast-check` resolve through its node_modules.
const root = mkdtempSync(join(here, '..', '.tmp-'));

after(async () => {
  rmSync(root, { recursive: true, force: true });
  // Z3's worker threads keep the test process alive.
  setTimeout(() => process.exit(process.exitCode ?? 0), 100).unref();
});

function project(name: string, files: Record<string, string>): string {
  const dir = join(root, name);
  for (const [file, text] of Object.entries(files)) {
    mkdirSync(dirname(join(dir, file)), { recursive: true });
    writeFileSync(join(dir, file), text);
  }
  return dir;
}

function options(cwd: string, lawFiles: string[], extra: Partial<CheckOptions> = {}): CheckOptions {
  return {
    files: lawFiles,
    cwd,
    runs: 100,
    compiler: compiler!,
    lockFile: join(cwd, 'tsc-laws.lock'),
    noProve: false,
    bound: 4,
    proofTimeoutMs: 5000,
    ...extra,
  };
}

function lockNow(opts: CheckOptions): void {
  writeLock(opts.lockFile, readManifest(opts.compiler, opts.files, opts.cwd));
}

function byName(results: LawResult[], name: string): LawResult {
  const found = results.find((r) => r.name === name);
  assert.ok(found, `no result for ${name}: ${JSON.stringify(results)}`);
  return found;
}

describe('tslaws check', { skip: compiler === undefined ? 'set TSC_LAWS_BIN' : false }, () => {
  it('proves a pure law with Z3 and tests the rest', async () => {
    const cwd = project('basic', {
      'src/f.ts': 'export const add = (a: number, b: number): number => a + b;\nexport const rev = (xs: number[]): number[] => [...xs].reverse();\n',
      'src/f.laws.ts': [
        "import { add, rev } from './f';",
        'export law commutes(a: number, b: number) => add(a, b) === add(b, a);',
        'export law revTwice(xs: number[]) { const ys = rev(rev(xs)); return ys.length === xs.length && ys.every((y, i) => y === xs[i]); }',
        '',
      ].join('\n'),
    });
    const opts = options(cwd, ['src/f.laws.ts']);
    lockNow(opts);
    const report = await check(opts, true);
    assert.equal(byName(report.results, 'commutes').status, 'proved');
    assert.equal(byName(report.results, 'revTwice').status, 'bounded');
    assert.equal(report.ok, true);
  });

  it('fails a false law with a shrunk counterexample', async () => {
    const cwd = project('false-law', {
      'src/f.ts': 'export const dedupe = (xs: number[]): number[] => [...new Set(xs)];\n',
      'src/f.laws.ts': "import { dedupe } from './f';\nexport law keepsLength(xs: number[]) => dedupe(xs).length === xs.length;\n",
    });
    const opts = options(cwd, ['src/f.laws.ts']);
    lockNow(opts);
    const report = await check(opts, true);
    const result = byName(report.results, 'keepsLength');
    assert.equal(result.status, 'failed');
    assert.match(result.counterexample ?? '', /^\[\[(-?\d+),\1\]\]$/);
    assert.equal(report.ok, false);
  });

  it('refutes with a model that fails in JavaScript', async () => {
    const cwd = project('refuted', {
      'src/f.ts': 'export const dbl = (a: number): number => a * 2;\n',
      'src/f.laws.ts': "import { dbl } from './f';\nexport law dblGrows(a: number) => dbl(a) > a;\n",
    });
    const opts = options(cwd, ['src/f.laws.ts']);
    lockNow(opts);
    const result = byName((await check(opts, true)).results, 'dblGrows');
    assert.equal(result.status, 'failed');
  });

  it('leaves a proved law open when it cannot be proved', async () => {
    const cwd = project('open', {
      'src/f.ts': 'export const rev = (xs: number[]): number[] => [...xs].reverse();\n',
      'src/f.laws.ts': "import { rev } from './f';\nexport law proved revLen(xs: number[]) => rev(xs).length === xs.length;\n",
    });
    const opts = options(cwd, ['src/f.laws.ts']);
    lockNow(opts);
    const report = await check(opts, true);
    const result = byName(report.results, 'revLen');
    assert.equal(result.status, 'open');
    assert.equal(report.ok, false);
  });

  it('inlines called functions, branches and assume', async () => {
    const cwd = project('inline', {
      'src/f.ts': 'export function abs(x: number): number { if (x < 0) { return -x; } return x; }\n',
      'src/f.laws.ts': [
        "import { assume } from 'tslaws';",
        "import { abs } from './f';",
        'export law absNonNegative(x: number) => abs(x) >= 0;',
        'export law absOfSmall(x: number) { assume(x >= 0); const y = abs(x); return y === x; }',
        '',
      ].join('\n'),
    });
    const opts = options(cwd, ['src/f.laws.ts']);
    lockNow(opts);
    const { results } = await check(opts, true);
    assert.equal(byName(results, 'absNonNegative').status, 'proved');
    assert.equal(byName(results, 'absOfSmall').status, 'proved');
  });

  it('proves integer laws exactly and refuses what could round', async () => {
    const cwd = project('ints', {
      'src/f.ts': 'export const inc = (a: number): number => a + 1;\n',
      'src/f.laws.ts': [
        "import type { int } from 'tslaws';",
        "import { inc } from './f';",
        'export law proved zero(a: int) => a + 0 === a;',
        'export law commutes(a: int, b: int) => a * b === b * a;',
        'export law grows(a: int) => inc(a) > a;',
        'export law bigs(a: bigint, b: bigint) => a + b === b + a;',
        '',
      ].join('\n'),
    });
    const opts = options(cwd, ['src/f.laws.ts']);
    lockNow(opts);
    const { results } = await check(opts, true);
    assert.equal(byName(results, 'zero').status, 'proved');
    // A product or a + 1 can leave the safe integers, where JavaScript rounds: Z3 can only show the law within ±2^26.
    assert.equal(byName(results, 'commutes').status, 'bounded');
    assert.equal(byName(results, 'grows').status, 'bounded');
    assert.equal(byName(results, 'bigs').status, 'proved');
  });

  it('proves doubles with IEEE semantics', async () => {
    const cwd = project('doubles', {
      'src/f.laws.ts': [
        'export law addCommutes(a: number, b: number) => a + b === b + a;',
        'export law proved squareNonNegative(a: number) => a * a >= 0;',
        'export law notAssociative(a: number, b: number, c: number) => (a + b) + c === a + (b + c);',
        '',
      ].join('\n'),
    });
    const opts = options(cwd, ['src/f.laws.ts']);
    lockNow(opts);
    const { results } = await check(opts, true);
    assert.equal(byName(results, 'addCommutes').status, 'proved');
    assert.equal(byName(results, 'squareNonNegative').status, 'proved');
    // Real arithmetic would prove this; doubles refute it.
    assert.equal(byName(results, 'notAssociative').status, 'failed');
  });

  it('verifies arrays, loops and strings within a bound', async () => {
    const cwd = project('bounded', {
      'src/f.ts': [
        'export function sum(xs: number[]): number { let t = 0; for (let i = 0; i < xs.length; i++) { t += xs[i]; } return t; }',
        'export const sorted = (xs: number[]): number[] => [...xs].sort((a, b) => a - b);',
        'export const rev = (xs: number[]): number[] => [...xs].reverse();',
        'export const dedupe = (xs: number[]): number[] => [...new Set(xs)];',
        'export const shout = (s: string): string => s + "!";',
        '',
      ].join('\n'),
      'src/f.laws.ts': [
        "import type { int } from 'tslaws';",
        "import { sum, sorted, rev, dedupe, shout } from './f';",
        'export law sortKeepsLength(xs: int[]) => sorted(xs).length === xs.length;',
        'export law sortOrders(xs: int[]) { const s = sorted(xs); for (let i = 1; i < s.length; i++) { if (s[i - 1] > s[i]) return false; } return true; }',
        'export law revTwice(xs: int[]) { const r = rev(rev(xs)); return r.length === xs.length && r.every((v, i) => v === xs[i]); }',
        'export law dedupeKeepsLength(xs: int[]) => dedupe(xs).length === xs.length;',
        'export law sumOfEmpty(xs: int[]) { assume(xs.length === 0); return sum(xs) === 0; }',
        'export law shoutAddsOne(s: string) => shout(s).length === s.length + 1;',
        'export law proved shoutEndsBang(s: string) => shout(s).endsWith("!");',
        "import { assume } from 'tslaws';",
        '',
      ].join('\n'),
    });
    const opts = options(cwd, ['src/f.laws.ts']);
    lockNow(opts);
    const { results } = await check(opts, true);
    assert.equal(byName(results, 'sortKeepsLength').status, 'bounded');
    assert.equal(byName(results, 'sortOrders').status, 'bounded');
    assert.equal(byName(results, 'revTwice').status, 'bounded');
    assert.equal(byName(results, 'dedupeKeepsLength').status, 'failed');
    assert.equal(byName(results, 'sumOfEmpty').status, 'bounded');
    assert.equal(byName(results, 'shoutAddsOne').status, 'proved');
    assert.equal(byName(results, 'shoutEndsBang').status, 'proved');
  });

  it('proves laws over records of numbers', async () => {
    const cwd = project('records', {
      'src/f.ts':
        "import type { int } from 'tslaws';\nexport interface P { x: int; y: int }\nexport const dist = (p: P, q: P): number => Math.abs(p.x - q.x) + Math.abs(p.y - q.y);\n",
      'src/f.laws.ts': [
        "import { dist, type P } from './f';",
        'export law symmetric(p: P, q: P) => dist(p, q) === dist(q, p);',
        'export law nonNegative(p: P, q: P) => dist(p, q) >= 0;',
        'export law wrong(p: P, q: P) => dist(p, q) > 0;',
        '',
      ].join('\n'),
    });
    const opts = options(cwd, ['src/f.laws.ts']);
    lockNow(opts);
    const { results } = await check(opts, true);
    assert.equal(byName(results, 'symmetric').status, 'bounded');
    assert.equal(byName(results, 'nonNegative').status, 'bounded');
    assert.equal(byName(results, 'wrong').status, 'failed');
  });

  it('rejects laws that changed, were added or removed since the lock', async () => {
    const cwd = project('tamper', {
      'src/f.ts': 'export const id = (a: number): number => a;\n',
      'src/f.laws.ts': "import { id } from './f';\nexport law keeps(a: number) => id(a) === a;\n",
    });
    const opts = options(cwd, ['src/f.laws.ts']);
    lockNow(opts);
    assert.equal((await check(opts, true)).ok, true);

    writeFileSync(join(cwd, 'src/f.laws.ts'), "import { id } from './f';\nexport law keeps(a: number) => true;\n");
    const changed = await check(opts, true);
    assert.equal(byName(changed.results, 'keeps').status, 'tampered');
    assert.equal(changed.ok, false);

    writeFileSync(
      join(cwd, 'src/f.laws.ts'),
      "import { id } from './f';\nexport law keeps(a: number) => id(a) === a;\nexport law extra(a: number) => true;\n",
    );
    assert.equal(byName((await check(opts, true)).results, 'extra').status, 'tampered');

    writeFileSync(join(cwd, 'src/f.laws.ts'), "import { id } from './f';\n");
    assert.equal(byName((await check(opts, true)).results, 'keeps').status, 'tampered');
  });

  it('fails exported code no law reaches, counting calls made by what a law calls', async () => {
    const cwd = project('coverage', {
      'src/f.ts': [
        'const twice = (a: number): number => a + a;',
        'export const double = (a: number): number => twice(a);',
        'export const unchecked = (a: number): number => a - 1;',
        'export class Counter { n = 0; }',
        '',
      ].join('\n'),
      'src/f.laws.ts': "import { double } from './f';\nexport law doubles(a: number) => double(a) === a + a;\n",
    });
    const opts = options(cwd, ['src/f.laws.ts']);
    lockNow(opts);
    const report = await check(opts, true);
    const uncovered = report.results.filter((r) => r.status === 'uncovered').map((r) => r.name);
    assert.deepEqual(uncovered, ['Counter', 'unchecked']);
    assert.equal(report.ok, false);
  });

  it('covers modules named by tslaws.json even when no law imports them', async () => {
    const cwd = project('cover-globs', {
      'tslaws.json': JSON.stringify({ cover: ['src/**/*.ts'] }),
      'src/a.ts': 'export const a = (x: number): number => x;\n',
      'src/b.ts': 'export const b = (x: number): number => x;\n',
      'src/a.laws.ts': "import { a } from './a';\nexport law keeps(x: number) => a(x) === x;\n",
    });
    const opts = options(cwd, ['src/a.laws.ts']);
    lockNow(opts);
    const report = await check(opts, true);
    assert.deepEqual(
      report.results.filter((r) => r.status === 'uncovered').map((r) => `${r.file}:${r.name}`),
      ['src/b.ts:b'],
    );
  });

  it('accepts an exemption only once it is in the lock', async () => {
    const cwd = project('exempt', {
      'src/f.ts': [
        'export const checked = (a: number): number => a;',
        '/** Glue code. @tslaws-exempt */',
        'export const glue = (a: number): number => a + 1;',
        '',
      ].join('\n'),
      'src/f.laws.ts': "import { checked } from './f';\nexport law keeps(a: number) => checked(a) === a;\n",
    });
    const opts = options(cwd, ['src/f.laws.ts']);
    lockNow(opts);
    const first = await check(opts, true);
    assert.equal(byName(first.results, 'glue').status, 'tampered');
    assert.equal(first.ok, false);

    writeLock(opts.lockFile, readManifest(opts.compiler, opts.files, opts.cwd), exemptionsOf(opts));
    const second = await check(opts, true);
    assert.equal(second.ok, true);
    assert.equal(second.results.some((r) => r.name === 'glue'), false);
  });

  it('checks proposed laws without a lock', async () => {
    const cwd = project('proposed', {
      'src/f.proposed.laws.ts': 'export law t(a: number) => a === a;\n',
    });
    const opts = options(cwd, ['src/f.proposed.laws.ts']);
    const report = await check(opts, false);
    assert.equal(byName(report.results, 't').status, 'proved');
    assert.equal(report.ok, true);
  });

  it('fails when there is no lock', async () => {
    const cwd = project('nolock', {
      'src/f.laws.ts': 'export law t(a: number) => true;\n',
    });
    const report = await check(options(cwd, ['src/f.laws.ts']), true);
    assert.equal(report.lockMissing, true);
    assert.equal(report.ok, false);
  });

  it('reports type errors and unexported laws', async () => {
    const cwd = project('errors', {
      'src/f.laws.ts': 'law hidden(a: number) => true;\nexport law bad(a: number): string => a;\n',
    });
    const opts = options(cwd, ['src/f.laws.ts'], { noProve: true });
    lockNow(opts);
    const report = await check(opts, true);
    assert.equal(byName(report.results, 'hidden').status, 'error');
    assert.equal(report.compileOk, false);
    assert.equal(report.ok, false);
  });

  it('treats assume that discards everything as open', async () => {
    const cwd = project('discard', {
      'src/f.laws.ts': "import { assume } from 'tslaws';\nexport law never(a: number) { assume(false); return true; }\n",
    });
    const opts = options(cwd, ['src/f.laws.ts'], { noProve: true });
    lockNow(opts);
    assert.equal(byName((await check(opts, true)).results, 'never').status, 'open');
  });

  it('derives generators from interfaces, unions and enums', async () => {
    const cwd = project('types', {
      'src/f.laws.ts': [
        'export interface P { x: number; tag: "a" | "b"; extra?: string }',
        'export enum Color { Red, Green }',
        'export law pointShape(p: P) => typeof p.x === "number" && (p.tag === "a" || p.tag === "b");',
        'export law colorKnown(c: Color) => c === Color.Red || c === Color.Green;',
        'export law tupleLen(t: [number, string]) => t.length === 2;',
        'export law recordKeys(r: Record<string, number>) => Object.values(r).every((v) => typeof v === "number");',
        '',
      ].join('\n'),
    });
    const opts = options(cwd, ['src/f.laws.ts'], { noProve: true });
    lockNow(opts);
    const { results } = await check(opts, true);
    for (const name of ['pointShape', 'colorKnown', 'tupleLen', 'recordKeys']) assert.equal(byName(results, name).status, 'tested', name);
  });

  it('reports a law over non-terminating code instead of hanging', async () => {
    const cwd = project('hang', {
      'src/f.ts': 'export const spin = (n: number): number => { while (true) { n += 1; } };\nexport const fine = (n: number): number => n;\n',
      'src/f.laws.ts': [
        "import { spin, fine } from './f';",
        'export law spins(n: number) { return spin(n) === 0; }',
        'export law finishes(n: number) { return fine(n) === n; }',
      ].join('\n'),
    });
    const opts = options(cwd, ['src/f.laws.ts'], { noProve: true, propertyTimeoutMs: 1500 });
    lockNow(opts);
    const { results, ok } = await check(opts, true);
    assert.equal(byName(results, 'spins').status, 'error');
    assert.match(byName(results, 'spins').message ?? '', /may not terminate/);
    assert.equal(byName(results, 'finishes').status, 'tested');
    assert.equal(ok, false);
  });
});
