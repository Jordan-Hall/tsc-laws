// Loops without a written invariant: the prover finds one by solving constrained Horn clauses (Spacer), checks it with
// plain Z3, and has Eldarica or Golem confirm it when they are installed.
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { after, afterEach, describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';
import { check } from '../dist/check.js';
import {
  certificationProblem,
  hornText,
  runExternalSolvers,
  solveHorn,
  type Engine,
  type HornSystem,
} from '../dist/chc.js';
import { readManifest } from '../dist/compile.js';
import { writeLock } from '../dist/lock.js';
import { solve } from '../dist/smt.js';
import type { CheckOptions, LawResult } from '../dist/types.js';

const compiler = process.env.TSC_LAWS_BIN;
const here = dirname(fileURLToPath(import.meta.url));
const root = mkdtempSync(join(here, '..', '.tmp-chc-'));
const saved = { eld: process.env.TSLAWS_ELDARICA, golem: process.env.TSLAWS_GOLEM };

after(() => {
  rmSync(root, { recursive: true, force: true });
});

afterEach(() => {
  for (const [key, name] of [
    ['eld', 'TSLAWS_ELDARICA'],
    ['golem', 'TSLAWS_GOLEM'],
  ] as const) {
    if (saved[key] === undefined) delete process.env[name];
    else process.env[name] = saved[key];
  }
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

const sources = [
  "import type { int } from 'tslaws';",
  'export function twice(n: int): int {',
  '  let s = 0;',
  '  let i = 0;',
  '  while (i < n) {',
  '    s += 2;',
  '    i += 1;',
  '  }',
  '  return s as int;',
  '}',
  'export function biggest(a: int, b: int, c: int): int {',
  '  let m = a;',
  '  let i = 0;',
  '  while (i < 2) {',
  '    const x = i === 0 ? b : c;',
  '    if (x > m) m = x;',
  '    i += 1;',
  '  }',
  '  return m as int;',
  '}',
  'export function countDown(n: int): int {',
  '  let i = n;',
  '  while (i > 0) i -= 1;',
  '  return i as int;',
  '}',
  '',
].join('\n');

const header = ["import { assume } from 'tslaws';", "import type { int } from 'tslaws';"];

describe(
  'loops proved with an invariant the solver finds',
  { skip: compiler === undefined ? 'set TSC_LAWS_BIN' : false },
  () => {
    it('proves a sum loop for every n and reports the invariant', async () => {
      const opts = project('sum', {
        'src/f.ts': sources,
        'src/f.laws.ts': [
          ...header,
          "import { twice } from './f';",
          'export law proved twiceIsDouble(n: int) { assume(n >= 0 && n <= 1000000); return twice(n) === 2 * n; }',
          '',
        ].join('\n'),
      });
      const { results } = await check(opts, true);
      const r = byName(results, 'twiceIsDouble');
      assert.equal(r.status, 'proved', JSON.stringify(r));
      assert.ok(
        r.assumptions?.some((line) => /loop 1 invariant over \(.*\)/.test(line)),
        `the invariant is reported: ${JSON.stringify(r.assumptions)}`,
      );
    });

    it('certifies a proof by invariant, and "require" fails it only when the tools are missing', async () => {
      const files = {
        'src/f.ts': sources,
        'src/f.laws.ts': [
          ...header,
          "import { twice } from './f';",
          'export law proved twiceIsDouble(n: int) { assume(n >= 0 && n <= 1000000); return twice(n) === 2 * n; }',
          '',
        ].join('\n'),
      };
      // With the tools absent the law stays proved and says the certificate is unavailable; "require" makes that an error.
      const savedTools = { cvc5: process.env.TSLAWS_CVC5, carcara: process.env.TSLAWS_CARCARA };
      try {
        process.env.TSLAWS_CVC5 = join(root, 'missing', 'cvc5');
        process.env.TSLAWS_CARCARA = join(root, 'missing', 'carcara');
        const lenient = byName(
          (await check({ ...project('horn-certify', files), certify: true }, true)).results,
          'twiceIsDouble',
        );
        assert.equal(lenient.status, 'proved', JSON.stringify(lenient));
        assert.equal(lenient.certificate?.status, 'unavailable');
        const required = byName(
          (await check({ ...project('horn-require', files), certify: 'require' }, true)).results,
          'twiceIsDouble',
        );
        assert.equal(required.status, 'error', JSON.stringify(required));
        assert.match(required.message ?? '', /"certify": "require" is set but the proof is unavailable/);
      } finally {
        for (const [name, value] of [
          ['TSLAWS_CVC5', savedTools.cvc5],
          ['TSLAWS_CARCARA', savedTools.carcara],
        ] as const) {
          if (value === undefined) delete process.env[name];
          else process.env[name] = value;
        }
      }
      // Without certification asked for, nothing changes.
      assert.equal(
        byName((await check(project('horn-plain', files), true)).results, 'twiceIsDouble').certificate,
        undefined,
      );
    });

    it('proves a max loop and a countdown', async () => {
      const opts = project('max', {
        'src/f.ts': sources,
        'src/f.laws.ts': [
          ...header,
          "import { biggest, countDown } from './f';",
          'export law proved biggestIsAtLeastA(a: int, b: int, c: int) { return biggest(a, b, c) >= a; }',
          'export law proved biggestIsAtLeastC(a: int, b: int, c: int) { return biggest(a, b, c) >= c; }',
          'export law proved countsDownToZero(n: int) { assume(n >= 0 && n <= 1000); return countDown(n) === 0; }',
          '',
        ].join('\n'),
      });
      const { results } = await check(opts, true);
      for (const name of ['biggestIsAtLeastA', 'biggestIsAtLeastC', 'countsDownToZero'])
        assert.equal(byName(results, name).status, 'proved', JSON.stringify(byName(results, name)));
    });

    it('never proves a false postcondition of a loop', async () => {
      const opts = project('false', {
        'src/f.ts': sources,
        'src/f.laws.ts': [
          ...header,
          "import { twice } from './f';",
          'export law proved wrong(n: int) { assume(n >= 0 && n <= 1000); return twice(n) === 2 * n + 1; }',
          '',
        ].join('\n'),
      });
      const { results } = await check(opts, true);
      const r = byName(results, 'wrong');
      assert.ok(r.status === 'failed' || r.status === 'open', JSON.stringify(r));
    });

    it('does not prove a claim about a loop whose condition changes a variable', async () => {
      const opts = project('condition', {
        'src/f.ts': [
          "import type { int } from 'tslaws';",
          'export function walk(n: int): int {',
          '  let i = 0;',
          '  while (i++ < n) {}',
          '  return i as int;',
          '}',
          '',
        ].join('\n'),
        'src/f.laws.ts': [
          ...header,
          "import { walk } from './f';",
          'export law proved walkIsOne(n: int) { assume(n >= 1 && n <= 1000); return walk(n) === 1; }',
          '',
        ].join('\n'),
      });
      const { results } = await check(opts, true);
      const r = byName(results, 'walkIsOne');
      assert.ok(r.status === 'failed' || r.status === 'open', JSON.stringify(r));
    });
  },
);

describe(
  'obligations of a loop body hold on every iteration, not only on the last',
  { skip: compiler === undefined ? 'set TSC_LAWS_BIN' : false },
  () => {
    const notProved = (r: LawResult): void =>
      assert.ok(
        r.status !== 'proved' && r.status !== 'bounded',
        `a broken obligation was called proved: ${JSON.stringify(r)}`,
      );

    it('does not prove a loop that indexes out of its array on a later iteration', async () => {
      const opts = project('index-later', {
        'src/f.ts': [
          "import type { int } from 'tslaws';",
          'export function scan(a: int[]): int {',
          '  let i = 0;',
          '  let hits = 0;',
          '  while (i < 3) {',
          '    if (a[i] === 7) hits = 1;',
          '    i += 1;',
          '  }',
          '  return i as int;',
          '}',
          '',
        ].join('\n'),
        'src/f.laws.ts': [
          ...header,
          "import { scan } from './f';",
          'export law proved scansThree(a: int[]) { return scan(a) === 3; }',
          '',
        ].join('\n'),
      });
      const { results } = await check(opts, true);
      notProved(byName(results, 'scansThree'));
    });

    it('does not prove a loop that leaves the int range on a later iteration', async () => {
      const opts = project('overflow-later', {
        'src/f.ts': [
          "import type { int } from 'tslaws';",
          'export function grow(n: int): int {',
          '  let s = 1;',
          '  let i = 0;',
          '  while (i < n) {',
          '    s = s * 2;',
          '    i += 1;',
          '  }',
          '  return s as int;',
          '}',
          '',
        ].join('\n'),
        'src/f.laws.ts': [
          ...header,
          "import { grow } from './f';",
          'export law proved growsPositive(n: int) { assume(n >= 0 && n <= 100); return grow(n) >= 1; }',
          '',
        ].join('\n'),
      });
      const { results } = await check(opts, true);
      notProved(byName(results, 'growsPositive'));
    });
  },
);

/** An engine for solveHorn whose Z3 is the real one and whose other solvers say what the test wants. */
function engine(answers: { solver: string; answer: 'sat' | 'unsat' | 'unknown' }[]): Engine {
  return { z3: solve, external: async () => answers };
}

// i counts up to n: Inv(i, n) := i <= n satisfies the system when the claim is i = n, and nothing does for i = n + 1.
const counting = (claim: string): HornSystem => ({
  predicates: [{ name: 'Inv1', sorts: ['Int', 'Int'], names: ['i', 'n'] }],
  constants: [
    { name: 'i', sort: 'Int' },
    { name: 'n', sort: 'Int' },
    { name: 'i2', sort: 'Int' },
  ],
  clauses: [
    '(=> (>= n 0) (Inv1 0 n))',
    '(=> (and (Inv1 i n) (< i n) (= i2 (+ i 1))) (Inv1 i2 n))',
    `(=> (and (Inv1 i n) (not (< i n))) ${claim})`,
  ],
  shared: new Map<string, string>(),
});

describe('the Horn solving path', () => {
  it('finds, verifies and prints an invariant', async () => {
    const verdict = await solveHorn(counting('(= i n)'), engine([]), 20000);
    assert.equal(verdict.kind, 'safe', JSON.stringify(verdict));
    if (verdict.kind === 'safe') assert.match(verdict.invariants[0]!, /^loop 1 invariant over \(i, n\): /);
  });

  it('does not call a false claim safe', async () => {
    const verdict = await solveHorn(counting('(= i (+ n 1))'), engine([]), 20000);
    assert.notEqual(verdict.kind, 'safe', JSON.stringify(verdict));
  });

  it('writes a closed HORN script', () => {
    const text = hornText(counting('(= i n)'));
    assert.match(text, /^\(set-logic HORN\)/);
    assert.match(text, /\(declare-fun Inv1 \(Int Int\) Bool\)/);
    assert.equal((text.match(/\(forall /g) ?? []).length, 3);
  });

  it('turns the found invariants and the clauses into one quantifier-free problem Z3 refutes', async () => {
    const verdict = await solveHorn(counting('(= i n)'), engine([]), 20000);
    assert.equal(verdict.kind, 'safe', JSON.stringify(verdict));
    if (verdict.kind !== 'safe') return;
    assert.equal(verdict.certification.horn, hornText(counting('(= i n)')));
    const problem = certificationProblem(verdict.certification.horn, verdict.certification.invariants)!;
    assert.ok(problem, 'a problem is made');
    assert.doesNotMatch(problem, /forall|define-fun|Inv\d/);
    assert.match(problem, /^\(declare-const /);
    const { out } = await solve(problem, '', 20000);
    assert.match(out, /^unsat/);
  });

  it('makes a satisfiable problem of an invariant that is not inductive, and none of a mismatched one', async () => {
    const horn = hornText(counting('(= i n)'));
    // `false` is not true at entry, so the clauses are broken for some values and the problem has a model.
    const wrong = '(define-fun Inv1 ((x!0 Int) (x!1 Int)) Bool false)';
    const { out } = await solve(certificationProblem(horn, wrong)!, '', 20000);
    assert.match(out, /^sat/);
    assert.equal(certificationProblem(horn, ''), undefined, 'a predicate without a definition');
    assert.equal(
      certificationProblem(
        horn,
        `${wrong}
(define-fun Other ((x!0 Int)) Bool true)`,
      ),
      undefined,
      'a definition for a predicate the clauses do not declare',
    );
    assert.equal(certificationProblem(horn, '(declare-const x Int)'), undefined, 'only define-fun is accepted');
  });

  it('keeps an agreeing second solver as a note', async () => {
    const verdict = await solveHorn(counting('(= i n)'), engine([{ solver: 'Eldarica', answer: 'sat' }]), 20000);
    assert.equal(verdict.kind, 'safe');
    if (verdict.kind === 'safe') assert.deepEqual(verdict.notes, ['Eldarica agrees']);
  });

  it('reports a disagreeing second solver as a disagreement, never as proved', async () => {
    const verdict = await solveHorn(counting('(= i n)'), engine([{ solver: 'Eldarica', answer: 'unsat' }]), 20000);
    assert.equal(verdict.kind, 'disagree', JSON.stringify(verdict));
  });
});

describe('a second CHC solver in a law', { skip: compiler === undefined ? 'set TSC_LAWS_BIN' : false }, () => {
  /** A mock `eld` (a Node script, which TSLAWS_ELDARICA may name) that prints `answer`. */
  function mock(name: string, answer: string): string {
    const path = join(root, `${name}.mjs`);
    writeFileSync(path, `process.stdout.write(${JSON.stringify(`${answer}\n`)});\n`);
    return path;
  }

  const files = {
    'src/f.ts': sources,
    'src/f.laws.ts': [
      ...header,
      "import { twice } from './f';",
      'export law proved twiceIsDouble(n: int) { assume(n >= 0 && n <= 1000000); return twice(n) === 2 * n; }',
      '',
    ].join('\n'),
  };

  it('notes an agreeing solver next to the invariant', async () => {
    process.env.TSLAWS_ELDARICA = mock('eld-sat', 'sat');
    const { results } = await check(project('eld-agrees', files), true);
    const r = byName(results, 'twiceIsDouble');
    assert.equal(r.status, 'proved', JSON.stringify(r));
    assert.ok(r.assumptions?.includes('Eldarica agrees'), JSON.stringify(r.assumptions));
  });

  it('does not prove when the solvers disagree', async () => {
    process.env.TSLAWS_ELDARICA = mock('eld-unsat', 'unsat');
    const { results } = await check(project('eld-disagrees', files), true);
    const r = byName(results, 'twiceIsDouble');
    assert.notEqual(r.status, 'proved', JSON.stringify(r));
    assert.match(JSON.stringify(r), /disagree/);
  });
});

// The certificates workflow installs Eldarica and Golem and sets TSLAWS_REQUIRE_CERT_TOOLS=1; elsewhere these skip.
const requireSolvers = process.env.TSLAWS_REQUIRE_CERT_TOOLS === '1';
const haveSolvers = process.env.TSLAWS_ELDARICA !== undefined && process.env.TSLAWS_GOLEM !== undefined;

describe(
  'with the real Eldarica and Golem',
  { skip: haveSolvers || requireSolvers ? false : 'TSLAWS_ELDARICA and TSLAWS_GOLEM are not set' },
  () => {
    const answers = async (claim: string): Promise<Map<string, string>> => {
      const found = await runExternalSolvers(hornText(counting(claim)), 30000);
      return new Map(found.map((answer) => [answer.solver, answer.answer]));
    };

    it('has both solvers when they are required', async () => {
      if (!requireSolvers) return;
      const found = await answers('(= i n)');
      assert.deepEqual([...found.keys()].sort(), ['Eldarica', 'Golem']);
    });

    it('both agree with the invariant Spacer finds', async () => {
      const found = await answers('(= i n)');
      assert.equal(found.get('Eldarica'), 'sat', JSON.stringify([...found]));
      assert.equal(found.get('Golem'), 'sat', JSON.stringify([...found]));
    });

    it('both refute a claim the loop can break', async () => {
      const found = await answers('(= i (+ n 1))');
      assert.equal(found.get('Eldarica'), 'unsat', JSON.stringify([...found]));
      assert.equal(found.get('Golem'), 'unsat', JSON.stringify([...found]));
    });
  },
);
