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
});
