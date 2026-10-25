// The prover lowers integer division and %, module constants and Number predicates; wrong claims stay refuted.
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
const root = mkdtempSync(join(here, '..', '.tmp-ints-'));

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

const lines = (...l: string[]): string => `${l.join('\n')}\n`;

async function run(name: string, impl: string, laws: string, extra: Record<string, string> = {}): Promise<LawResult[]> {
  const opts = project(name, { 'src/f.ts': impl, 'src/f.laws.ts': laws, ...extra });
  return (await check(opts, true)).results;
}

function byName(results: LawResult[], name: string): LawResult {
  const found = results.find((r) => r.name === name);
  assert.ok(found, `no result for ${name}: ${JSON.stringify(results)}`);
  return found;
}

const header = lines("import { assume } from 'tslaws';", "import type { int } from 'tslaws';");

describe('prover: integer division', { skip: compiler === undefined ? 'set TSC_LAWS_BIN' : false }, () => {
  it('proves Math.floor of a product quotient, % and round-half-up', async () => {
    const results = await run(
      'div',
      lines(
        "import type { int } from 'tslaws';",
        'export function discountCents(subtotal: int, bps: int): int {',
        '  return Math.floor((subtotal * bps) / 10000) as int;',
        '}',
        'export function roundDiv(a: int, b: int): int {',
        '  return Math.round(a / b) as int;',
        '}',
        'export function cut(a: int, b: int): int {',
        '  return (a / b) | 0;',
        '}',
      ),
      header +
        lines(
          "import { discountCents, roundDiv, cut } from './f';",
          'export law proved discountBounded(subtotal: int, bps: int) {',
          '  assume(subtotal >= 0 && subtotal <= 1000000000 && bps >= 0 && bps <= 10000);',
          '  const d = discountCents(subtotal, bps);',
          '  return d <= subtotal && d >= 0;',
          '}',
          'export law proved modRange(x: int) { assume(x >= 0); return x % 7 >= 0 && x % 7 <= 6; }',
          'export law proved modSign(x: int) { return x % 7 === 0 || x % 7 > 0 === x > 0; }',
          'export law proved roundHalfUp(a: int, b: int) {',
          '  assume(b > 0 && b <= 1000 && a >= -1000000 && a <= 1000000);',
          '  const r = roundDiv(a, b);',
          '  return (2 * r - 1) * b <= 2 * a && 2 * a < (2 * r + 1) * b;',
          '}',
          'export law proved truncates(a: int, b: int) {',
          '  assume(b >= 1 && b <= 1000 && a >= 0 && a <= 1000000);',
          '  const q = cut(a, b);',
          '  return q * b <= a && a < (q + 1) * b;',
          '}',
          'export law proved ceilNegative(a: int, b: int) {',
          '  assume(b >= 1 && b <= 1000 && a >= -1000000 && a <= 1000000);',
          '  const q = Math.ceil(a / b);',
          '  return q * b >= a && q * b < a + b;',
          '}',
          'export law proved truncNegative(a: int, b: int) {',
          '  assume(b >= 1 && b <= 1000 && a >= -1000000 && a <= 0);',
          '  const q = cut(a, b);',
          '  return q * b >= a && (q - 1) * b < a;',
          '}',
          'export law proved negativeDivisor(a: int, b: int) {',
          '  assume(b <= -1 && b >= -1000 && a >= -1000000 && a <= 1000000);',
          '  return Math.floor(a / b) * b >= a && Math.floor(a / b) * b < a - b;',
          '}',
        ),
    );
    for (const name of [
      'discountBounded',
      'modRange',
      'modSign',
      'roundHalfUp',
      'truncates',
      'ceilNegative',
      'truncNegative',
      'negativeDivisor',
    ]) {
      const r = byName(results, name);
      assert.ok(r.status === 'proved' || r.status === 'bounded', `${name}: ${JSON.stringify(r)}`);
    }
    assert.equal(byName(results, 'discountBounded').status, 'proved');
    assert.equal(byName(results, 'modSign').status, 'proved');
  });

  it('refutes wrong claims about division and %', async () => {
    const results = await run(
      'divbad',
      lines('export const unused = 0;'),
      header +
        lines(
          'export law proved exactDivision(a: int, b: int) {',
          '  assume(b >= 1 && b <= 1000 && a >= -1000 && a <= 1000);',
          '  return Math.floor(a / b) * b === a;',
          '}',
          'export law proved modNonNegative(x: int) { return x % 7 >= 0; }',
          'export law proved roundIsFloor(a: int, b: int) {',
          '  assume(b >= 1 && b <= 1000 && a >= 0 && a <= 1000);',
          '  return Math.round(a / b) === Math.floor(a / b);',
          '}',
          'export law proved truncIsFloor(a: int, b: int) {',
          '  assume(b >= 1 && b <= 1000 && a >= -1000 && a <= 1000);',
          '  return Math.trunc(a / b) === Math.floor(a / b);',
          '}',
        ),
    );
    for (const name of ['exactDivision', 'modNonNegative', 'roundIsFloor', 'truncIsFloor']) {
      const r = byName(results, name);
      assert.equal(r.status, 'failed', `${name}: ${JSON.stringify(r)}`);
      assert.ok(r.counterexample !== undefined, name);
    }
  });

  it('does not prove a division by an int that may be 0', async () => {
    const results = await run(
      'zero',
      lines('export const unused = 0;'),
      header +
        lines(
          'export law proved unguarded(a: int, b: int) {',
          "  return typeof Math.floor(a / b) === 'number';",
          '}',
          'export law proved guarded(a: int, b: int) {',
          '  assume(b !== 0 && a >= 0 && a <= 1000 && b >= -1000 && b <= 1000);',
          "  return typeof Math.floor(a / b) === 'number';",
          '}',
        ),
    );
    const bad = byName(results, 'unguarded');
    assert.notEqual(bad.status, 'proved', JSON.stringify(bad));
    assert.notEqual(bad.status, 'bounded', JSON.stringify(bad));
    assert.match(JSON.stringify(bad), /divisor may be 0/);
    assert.equal(byName(results, 'guarded').status, 'proved');
  });
});

describe('prover: module constants', { skip: compiler === undefined ? 'set TSC_LAWS_BIN' : false }, () => {
  it('reads constants through imports and exports', async () => {
    const results = await run(
      'consts',
      lines(
        "import type { int } from 'tslaws';",
        "import { TAX_BPS } from './rates';",
        'const LIMIT = 100;',
        'export function tax(net: int): int {',
        '  return Math.floor((net * TAX_BPS) / 10000) as int;',
        '}',
        'export function cap(x: int): int {',
        '  return Math.min(x, LIMIT) as int;',
        '}',
      ),
      lines(
        "import { assume } from 'tslaws';",
        "import type { int } from 'tslaws';",
        "import { TAX_BPS, GROSS_BPS } from './rates';",
        "import { tax, cap } from './f';",
        'const MAX_NET = 1000000;',
        'export law proved rateIsKnown(n: int) { return TAX_BPS === 825 && GROSS_BPS === 10825; }',
        'export law proved taxBelowNet(net: int) {',
        '  assume(net >= 0 && net <= MAX_NET);',
        '  return tax(net) <= net && tax(net) >= 0;',
        '}',
        'export law proved capped(x: int) { return cap(x) <= 100; }',
      ),
      {
        'src/rates.ts': lines('export const TAX_BPS = 825;', 'export const GROSS_BPS = 10000 + TAX_BPS;'),
      },
    );
    for (const name of ['rateIsKnown', 'taxBelowNet', 'capped']) {
      const r = byName(results, name);
      assert.equal(r.status, 'proved', `${name}: ${JSON.stringify(r)}`);
    }
  });

  it('refutes a wrong claim about a constant', async () => {
    const results = await run(
      'constbad',
      lines('export const unused = 0;'),
      lines(
        "import { TAX_BPS } from './rates';",
        'export law proved wrongRate(n: int) { return TAX_BPS === 800; }',
        'export law proved wrongDerived(n: number) { return n * TAX_BPS === n * 800; }',
      ),
      { 'src/rates.ts': lines('export const TAX_BPS = 825;') },
    );
    const wrong = byName(results, 'wrongRate');
    assert.equal(wrong.status, 'failed', JSON.stringify(wrong));
    assert.notEqual(byName(results, 'wrongDerived').status, 'proved');
  });

  it('leaves a mutable or computed export unproved', async () => {
    const results = await run(
      'mutable',
      lines('export let count = 1;', 'export function bump(): void { count += 1; }'),
      header + lines("import { count } from './f';", 'export law proved stays(n: int) { return count === 1; }'),
    );
    assert.notEqual(byName(results, 'stays').status, 'proved');
  });
});

describe(
  'prover: Number predicates, Math.sign and n-ary min/max',
  { skip: compiler === undefined ? 'set TSC_LAWS_BIN' : false },
  () => {
    it('proves them', async () => {
      const results = await run(
        'preds',
        lines('export const unused = 0;'),
        header +
          lines(
            'export law proved intIsInteger(n: int) { return Number.isInteger(n) && Number.isFinite(n) && !Number.isNaN(n); }',
            'export law proved floorIsInteger(x: number) { return Number.isInteger(Math.floor(x)); }',
            'export law proved doubleIsNotNaN(x: number) { return !Number.isNaN(x); }',
            'export law proved signMatches(n: int) { return Math.sign(n) === (n > 0 ? 1 : n < 0 ? -1 : 0); }',
            'export law proved max3(a: int, b: int, c: int) {',
            '  return Math.max(a, b, c) >= a && Math.max(a, b, c) >= b && Math.max(a, b, c) >= c;',
            '}',
            'export law proved min3(a: int, b: int, c: int) { return Math.min(a, b, c) <= a && Math.min(a, b, c) <= c; }',
          ),
      );
      for (const name of ['intIsInteger', 'floorIsInteger', 'doubleIsNotNaN', 'signMatches', 'max3', 'min3']) {
        const r = byName(results, name);
        assert.equal(r.status, 'proved', `${name}: ${JSON.stringify(r)}`);
      }
    });

    it('refutes wrong claims', async () => {
      const results = await run(
        'predsbad',
        lines('export const unused = 0;'),
        header +
          lines(
            'export law proved everyDoubleIsInteger(x: number) { return Number.isInteger(x); }',
            'export law proved max3Wrong(a: int, b: int, c: int) { return Math.max(a, b, c) === a; }',
            'export law proved signWrong(n: int) { return Math.sign(n) === 1; }',
          ),
      );
      for (const name of ['everyDoubleIsInteger', 'max3Wrong', 'signWrong']) {
        const r = byName(results, name);
        assert.equal(r.status, 'failed', `${name}: ${JSON.stringify(r)}`);
      }
    });
  },
);
