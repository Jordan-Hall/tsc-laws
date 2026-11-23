// Built-in-law language features (Phase 4): refinement types (`nat`, `posInt`, `nonZeroInt`, `intRange`, `nonEmpty`,
// `asciiString`), intermediate proof steps (`lemma`), modular contracts (`requires`, `ensures`), and termination
// measures (`decreases`) for loops and recursion.
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { after, describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';
import { check } from '../dist/check.js';
import { readManifest } from '../dist/compile.js';
import { writeLock } from '../dist/lock.js';
import type { CheckOptions, LawResult } from '../dist/types.js';

const here = dirname(fileURLToPath(import.meta.url));
const root = mkdtempSync(join(here, '..', '.tmp-lang-'));

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
    proofTimeoutMs: 15000,
  };
  writeLock(options.lockFile, readManifest('builtin', options.files, cwd));
  return options;
}

function byName(results: LawResult[], name: string): LawResult {
  const found = results.find((r) => r.name === name);
  assert.ok(found, `no result for ${name}: ${JSON.stringify(results)}`);
  return found;
}

describe('refinement types', () => {
  it('proves laws over nat, posInt, nonZeroInt, intRange, nonEmpty and asciiString without assume()', async () => {
    const opts = project('refinements', {
      'src/f.laws.ts': [
        "import { law, type asciiString, type int, type intRange, type nat, type nonEmpty, type nonZeroInt, type posInt } from 'tslaws';",
        "law.proved('nat is non-negative', (n: nat) => n >= 0);",
        "law.proved('posInt is at least one', (n: posInt) => n >= 1);",
        "law.proved('nonZeroInt avoids zero divisor', (a: intRange<0, 1000>, b: nonZeroInt) => b !== 0 && a % b >= 0);",
        "law.proved('intRange stays in bounds', (x: intRange<10, 50>, y: intRange<5, 20>) => x + y >= 15 && x + y <= 70);",
        "law.proved('nonEmpty array always has a first element', (xs: nonEmpty<int>) => xs.length >= 1 && xs[0] === xs[0]);",
        "law.proved('asciiString length is non-negative', (s: asciiString) => s.length >= 0);",
        '',
      ].join('\n'),
    });
    const report = await check(opts, true);
    assert.equal(report.compileDiagnostics, '');
    for (const name of [
      'nat is non-negative',
      'posInt is at least one',
      'nonZeroInt avoids zero divisor',
      'intRange stays in bounds',
      'nonEmpty array always has a first element',
      'asciiString length is non-negative',
    ]) {
      const r = byName(report.results, name);
      assert.equal(r.status, 'proved', `${name}: ${JSON.stringify(r)}`);
    }
    assert.equal(report.ok, true);
  });

  it('still refutes false claims over refined types', async () => {
    const opts = project('refinements-false', {
      'src/f.laws.ts': [
        "import { law, type intRange, type nat } from 'tslaws';",
        "law.proved('nat is always positive (false)', (n: nat) => n >= 1);",
        "law.proved('intRange upper bound wrong (false)', (x: intRange<10, 20>) => x < 20);",
        '',
      ].join('\n'),
    });
    const report = await check(opts, true);
    assert.equal(byName(report.results, 'nat is always positive (false)').status, 'failed');
    assert.equal(byName(report.results, 'intRange upper bound wrong (false)').status, 'failed');
  });
});

describe('lemma, requires, ensures and decreases', () => {
  it('proves a law using intermediate lemma() steps and rejects a false lemma()', async () => {
    const opts = project('lemmas', {
      'src/f.laws.ts': [
        "import { law, lemma, type intRange } from 'tslaws';",
        "law.proved('valid lemma helps prove postcondition', (a: intRange<0, 100>, b: intRange<0, 100>) => {",
        '  const s = a + b;',
        '  lemma(s >= a && s >= b);',
        '  return s + s >= a + b;',
        '});',
        "law.proved('false lemma is rejected', (a: intRange<0, 100>) => {",
        '  lemma(a > 50);',
        '  return a > 50;',
        '});',
        '',
      ].join('\n'),
    });
    const report = await check(opts, true);
    assert.equal(byName(report.results, 'valid lemma helps prove postcondition').status, 'proved');
    assert.equal(byName(report.results, 'false lemma is rejected').status, 'failed');
  });

  it('enforces callee requires() and ensures() contracts across function calls', async () => {
    const opts = project('contracts', {
      'src/f.ts': [
        "import { ensures, requires, type int } from 'tslaws';",
        'export function safeHalf(n: int): int {',
        '  requires(n >= 0 && n <= 10000);',
        '  const out = Math.floor(n / 2) as int;',
        '  ensures(out >= 0 && out <= n);',
        '  return out;',
        '}',
        '',
      ].join('\n'),
      'src/f.laws.ts': [
        "import { law, type intRange } from 'tslaws';",
        "import { safeHalf } from './f';",
        "law.proved('caller satisfies requires and gets ensures', (n: intRange<0, 1000>) => safeHalf(n) <= n);",
        "law.proved('caller breaking requires fails', (n: intRange<-10, 10>) => safeHalf(n) <= 10);",
        '',
      ].join('\n'),
    });
    const report = await check(opts, true);
    assert.equal(byName(report.results, 'caller satisfies requires and gets ensures').status, 'proved');
    assert.equal(byName(report.results, 'caller breaking requires fails').status, 'failed');
  });

  it('proves total correctness (termination) for loops with invariant() + decreases() and rejects non-decreasing measures', async () => {
    const opts = project('decreases-loop', {
      'src/f.ts': [
        "import { decreases, invariant, type int } from 'tslaws';",
        'export function countUp(n: int): int {',
        '  let i = 0;',
        '  while (i < n) {',
        '    invariant(0 <= i && i <= n);',
        '    decreases(n - i);',
        '    i += 1;',
        '  }',
        '  return i as int;',
        '}',
        'export function badMeasure(n: int): int {',
        '  let i = 0;',
        '  while (i < n) {',
        '    invariant(0 <= i && i <= n);',
        '    decreases(i);',
        '    i += 1;',
        '  }',
        '  return i as int;',
        '}',
        '',
      ].join('\n'),
      'src/f.laws.ts': [
        "import { law, type intRange } from 'tslaws';",
        "import { badMeasure, countUp } from './f';",
        "law.proved('countUp terminates and reaches n', (n: intRange<0, 1000>) => countUp(n) === n);",
        "law.proved('badMeasure fails termination check', (n: intRange<1, 100>) => badMeasure(n) === n);",
        '',
      ].join('\n'),
    });
    const report = await check(opts, true);
    assert.equal(byName(report.results, 'countUp terminates and reaches n').status, 'proved');
    const bad = byName(report.results, 'badMeasure fails termination check');
    assert.notEqual(bad.status, 'proved', `non-decreasing measure must not prove: ${JSON.stringify(bad)}`);
    assert.notEqual(bad.status, 'bounded');
  });

  it('proves laws with fixed-width/string/finite types, implies, iff, distinct, unreachable, calc and induct', async () => {
    const opts = project('best-verification', {
      'src/f.laws.ts': [
        "import { calc, distinct, iff, implies, induct, law, unreachable, type finite, type int32, type intRange, type nat, type nonEmptyString, type uint8 } from 'tslaws';",
        'type Port = intRange<1, 65535>;',
        "law.proved('uint8 and int32 stay in fixed-width bounds', (b: uint8, i: int32, p: Port) => b >= 0 && b <= 255 && i >= -2147483648 && i <= 2147483647 && p >= 1 && p <= 65535);",
        "law.proved('nonEmptyString has length >= 1 and finite is finite', (s: nonEmptyString, x: finite) => s.length >= 1 && Number.isFinite(x));",
        "law.proved('implies, iff and distinct lower cleanly to SMT', (a: intRange<0, 100>, b: intRange<0, 100>) => {",
        '  const c1 = implies(a > b, a - b >= 1);',
        '  const c2 = iff(a === b, a - b === 0);',
        '  const c3 = implies(distinct(a, b, a + b + 1), a !== b);',
        '  return c1 && c2 && c3;',
        '});',
        "law.proved('unreachable proves dead branch is impossible', (n: nat) => {",
        '  if (n < 0) unreachable();',
        '  return n >= 0;',
        '});',
        "law.proved('unreachable refutes reachable branch with counterexample', (n: intRange<-5, 5>) => {",
        '  if (n < 0) unreachable();',
        '  return true;',
        '});',
        "law.proved('calc chains equational proof steps', (x: intRange<-100, 100>, y: intRange<-100, 100>) => {",
        '  return calc((x + y) * (x + y), x * x + x * y + y * x + y * y, x * x + 2 * x * y + y * y);',
        '});',
        "law.proved('induct proves arithmetic identity for all bounded nat', (n: intRange<0, 1000000>) => {",
        '  return induct(n, (k) => 2 * k + 2 === 2 * (k + 1));',
        '});',
        "law.proved('induct rejects a false inductive claim', (n: intRange<0, 1000>) => {",
        '  return induct(n, (k) => k === 0);',
        '});',
        '',
      ].join('\n'),
    });
    const report = await check(opts, true);
    assert.equal(report.compileDiagnostics, '');
    assert.equal(byName(report.results, 'uint8 and int32 stay in fixed-width bounds').status, 'proved');
    assert.equal(byName(report.results, 'nonEmptyString has length >= 1 and finite is finite').status, 'proved');
    assert.equal(byName(report.results, 'implies, iff and distinct lower cleanly to SMT').status, 'proved');
    assert.equal(byName(report.results, 'unreachable proves dead branch is impossible').status, 'proved');
    assert.equal(byName(report.results, 'unreachable refutes reachable branch with counterexample').status, 'failed');
    assert.equal(byName(report.results, 'calc chains equational proof steps').status, 'proved');
    assert.equal(byName(report.results, 'induct proves arithmetic identity for all bounded nat').status, 'proved');
    assert.equal(byName(report.results, 'induct rejects a false inductive claim').status, 'failed');
  });

  it('catches vacuous assume() laws instead of falsely reporting proved', async () => {
    const opts = project('vacuity', {
      'src/f.laws.ts': [
        "import { assume, law, type int } from 'tslaws';",
        "law.proved('contradictory assume is caught as open, not proved', (x: int) => {",
        '  assume(x > 10 && x < 5);',
        '  return false;',
        '});',
        '',
      ].join('\n'),
    });
    const report = await check(opts, true);
    const r = byName(report.results, 'contradictory assume is caught as open, not proved');
    assert.equal(r.status, 'open', `vacuous law must not prove: ${JSON.stringify(r)}`);
    assert.match(r.message ?? '', /vacuous|unsatisfiable|discards/i);
  });
});
