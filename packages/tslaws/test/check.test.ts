// End to end: each case writes a small project, compiles it with tsc-laws and checks its laws.
// Needs the built compiler in TSC_LAWS_BIN and `npm run build` for dist/.
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
    numbers: 'real',
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
    assert.equal(byName(report.results, 'revTwice').status, 'tested');
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
});
