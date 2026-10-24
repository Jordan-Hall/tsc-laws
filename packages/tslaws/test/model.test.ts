// Stateful laws: runModel semantics, and a shrunk failing operation sequence through check().
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { after, describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';
import { modelFailure, runModel, runModelAsync } from '../dist/api.js';
import { check } from '../dist/check.js';
import { readManifest } from '../dist/compile.js';
import { writeLock } from '../dist/lock.js';
import type { CheckOptions, LawResult } from '../dist/types.js';

const compiler = process.env.TSC_LAWS_BIN;
const here = dirname(fileURLToPath(import.meta.url));
const root = mkdtempSync(join(here, '..', '.tmp-model-'));

after(() => {
  rmSync(root, { recursive: true, force: true });
  setTimeout(() => process.exit(process.exitCode ?? 0), 100).unref();
});

type Op = 'inc' | 'dec' | 'reset';

function counterSpec(ops: Op[], breakAt?: number) {
  const real = { n: 0 };
  const log: string[] = [];
  return {
    log,
    spec: {
      ops,
      real,
      model: 0,
      apply: (r: { n: number }, m: number, op: Op, step: number) => {
        log.push(`${step}:${op}`);
        if (op === 'inc') r.n += 1;
        else if (op === 'dec') r.n -= 1;
        else r.n = 0;
        if (breakAt !== undefined && step === breakAt) r.n += 100;
        return op === 'inc' ? m + 1 : op === 'dec' ? m - 1 : 0;
      },
      agree: (r: { n: number }, m: number) => r.n === m,
    },
  };
}

describe('runModel', () => {
  it('checks agreement before the first op', () => {
    const calls: string[] = [];
    const ok = runModel({
      ops: ['a'],
      real: 0,
      model: 1,
      apply: (_r, m) => {
        calls.push('apply');
        return m;
      },
      agree: (r, m) => r === m,
    });
    assert.equal(ok, false);
    assert.deepEqual(calls, []);
    assert.deepEqual(modelFailure(), { step: -1, op: undefined });
  });

  it('agrees on a correct implementation and clears the failure', () => {
    runModel(counterSpec(['inc'], 0).spec);
    assert.notEqual(modelFailure(), undefined);
    assert.equal(runModel(counterSpec(['inc', 'dec', 'inc', 'reset']).spec), true);
    assert.equal(modelFailure(), undefined);
  });

  it('stops at the first disagreement and reports its step and op', () => {
    const { spec, log } = counterSpec(['inc', 'inc', 'dec', 'reset'], 1);
    assert.equal(runModel(spec), false);
    assert.deepEqual(log, ['0:inc', '1:inc']);
    assert.deepEqual(modelFailure(), { step: 1, op: 'inc' });
  });
});

describe('runModelAsync', () => {
  it('awaits apply and agree, stops early and reports the step', async () => {
    const real = { n: 0 };
    const seen: number[] = [];
    const ok = await runModelAsync({
      ops: [1, 1, 1, 1],
      real,
      model: 0,
      apply: async (r, m, op, step) => {
        await Promise.resolve();
        seen.push(step);
        r.n += step === 2 ? 5 : op;
        return m + op;
      },
      agree: async (r, m) => {
        await Promise.resolve();
        return r.n === m;
      },
    });
    assert.equal(ok, false);
    assert.deepEqual(seen, [0, 1, 2]);
    assert.deepEqual(modelFailure(), { step: 2, op: 1 });
  });

  it('returns true when real and model agree throughout', async () => {
    const ok = await runModelAsync({
      ops: ['x', 'y'],
      real: [] as string[],
      model: 0,
      apply: async (r, m, op) => {
        r.push(op);
        return m + 1;
      },
      agree: (r, m) => r.length === m,
    });
    assert.equal(ok, true);
    assert.equal(modelFailure(), undefined);
  });
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
    runs: 200,
    compiler: compiler!,
    lockFile: join(cwd, 'tsc-laws.lock'),
    noProve: true,
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

function counter(resetCondition: string): string {
  return [
    'export class Counter {',
    '  n = 0;',
    '  inc() { this.n += 1; }',
    '  dec() { this.n -= 1; }',
    `  reset() { if (${resetCondition}) this.n = 0; }`,
    '}',
    '',
  ].join('\n');
}

const law = [
  "import { runModel } from 'tslaws';",
  "import { Counter } from './f';",
  "export law counterAgreesWithModel(ops: ('inc' | 'dec' | 'reset')[]) {",
  '  return runModel({',
  '    ops,',
  '    real: new Counter(),',
  '    model: 0,',
  '    apply: (c, m, op) => {',
  "      if (op === 'inc') { c.inc(); return m + 1; }",
  "      if (op === 'dec') { c.dec(); return m - 1; }",
  '      c.reset();',
  '      return 0;',
  '    },',
  '    agree: (c, m) => c.n === m,',
  '  });',
  '}',
  '',
].join('\n');

describe('stateful laws through check', { skip: compiler === undefined ? 'set TSC_LAWS_BIN' : false }, () => {
  it('shrinks a failing operation sequence to the shortest one', async () => {
    const opts = project('buggy', { 'src/f.ts': counter('this.n !== 3'), 'src/f.laws.ts': law });
    const { results } = await check(opts, true);
    const r = byName(results, 'counterAgreesWithModel');
    assert.equal(r.status, 'failed', JSON.stringify(r));
    assert.equal(r.counterexample, '[["inc","inc","inc","reset"]]');
  });

  it('passes the fixed counter', async () => {
    const opts = project('fixed', { 'src/f.ts': counter('true'), 'src/f.laws.ts': law });
    const { results } = await check(opts, true);
    const r = byName(results, 'counterAgreesWithModel');
    assert.equal(r.status, 'tested', JSON.stringify(r));
  });
});
