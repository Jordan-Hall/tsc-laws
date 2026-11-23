// A crash of the Z3 worker is not a solver that gave up: it is retried on a fresh worker, and when it keeps crashing the
// law is reported as an error that names the crash, never quietly proved only within bounds or left as tested.
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { after, describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';
import { Worker } from 'node:worker_threads';
import { check } from '../dist/check.js';
import { solveHorn, SolverCrash, type Engine, type HornSystem } from '../dist/chc.js';
import { readManifest } from '../dist/compile.js';
import { writeLock } from '../dist/lock.js';
import { solve, startSolverWorkersWith } from '../dist/smt.js';
import type { CheckOptions, LawResult } from '../dist/types.js';

const compiler = process.env.TSC_LAWS_BIN;
const here = dirname(fileURLToPath(import.meta.url));
const root = mkdtempSync(join(here, '..', '.tmp-solver-crash-'));

after(() => {
  rmSync(root, { recursive: true, force: true });
});

/** How an injected worker falls over: it answers with an error, or it ends without a word. */
type Fault = 'error' | 'exit';

/** A worker that crashes on its first query, as a Z3 worker does when WebAssembly cannot allocate. */
class CrashingWorker extends EventEmitter {
  private readonly fault: Fault;
  constructor(fault: Fault) {
    super();
    this.fault = fault;
  }
  postMessage(message: { id: number }): void {
    setImmediate(() => {
      if (this.fault === 'error') this.emit('message', { id: message.id, error: 'injected out of memory' });
      else this.emit('exit', 1);
    });
  }
  terminate(): Promise<number> {
    return Promise.resolve(1);
  }
  unref(): void {}
}

/** Starts the workers the way smt.ts does, except that the first `crashes` of them crash. */
function crashing(crashes: number, fault: Fault = 'error'): { start: () => Worker; started: () => number } {
  let count = 0;
  return {
    start: () => {
      count += 1;
      if (count <= crashes) return new CrashingWorker(fault) as unknown as Worker;
      const real = new Worker(new URL('../dist/smtWorker.js', import.meta.url));
      real.unref();
      return real;
    },
    started: () => count,
  };
}

async function withWorkers<T>(start: () => Worker, work: () => Promise<T>): Promise<T> {
  const restore = startSolverWorkersWith(start);
  try {
    return await work();
  } finally {
    restore();
  }
}

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

const loopFiles = {
  'src/f.ts': [
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
    '',
  ].join('\n'),
  'src/f.laws.ts': [
    "import { assume } from 'tslaws';",
    "import type { int } from 'tslaws';",
    "import { twice } from './f';",
    'export law proved twiceIsDouble(n: int) { assume(n >= 0 && n <= 1000000); return twice(n) === 2 * n; }',
    '',
  ].join('\n'),
};

describe('a crashing solver', { skip: compiler === undefined ? 'set TSC_LAWS_BIN' : false }, () => {
  it('reports a loop law as a solver crash, not as proved only within bounds', async () => {
    const faults = crashing(Infinity);
    const { results } = await withWorkers(faults.start, () => check(project('loop-crash', loopFiles), true));
    const law = byName(results, 'twiceIsDouble');
    assert.equal(law.status, 'error', JSON.stringify(law));
    assert.match(law.message ?? '', /the Z3 solver crashed: injected out of memory/);
    assert.match(law.message ?? '', /3 fresh workers/);
    assert.doesNotMatch(law.message ?? '', /within bounds/);
    assert.equal(faults.started(), 3, 'one first try and two retries, each on a fresh worker');
  });

  it('names a worker that ended without a word', async () => {
    const { results } = await withWorkers(crashing(Infinity, 'exit').start, () =>
      check(project('loop-exit', loopFiles), true),
    );
    const law = byName(results, 'twiceIsDouble');
    assert.equal(law.status, 'error', JSON.stringify(law));
    assert.match(law.message ?? '', /the Z3 solver crashed: its worker exited with code 1/);
  });

  it('proves the loop law when a retry on a fresh worker succeeds', async () => {
    const faults = crashing(1);
    const { results } = await withWorkers(faults.start, () => check(project('loop-retry', loopFiles), true));
    const law = byName(results, 'twiceIsDouble');
    assert.equal(law.status, 'proved', JSON.stringify(law));
    assert.ok(faults.started() >= 2, 'the crashed worker was replaced');
  });

  it('reports a law without loops as a solver crash too', async () => {
    const options = project('plain-crash', {
      'src/f.laws.ts': 'export law proved sumCommutes(a: number, b: number) => a + b === b + a;\n',
    });
    const { results } = await withWorkers(crashing(Infinity).start, () => check(options, true));
    const law = byName(results, 'sumCommutes');
    assert.equal(law.status, 'error', JSON.stringify(law));
    assert.match(law.message ?? '', /the Z3 solver crashed/);
  });
});

describe('solveHorn and a crashing or giving-up Z3', () => {
  const system: HornSystem = {
    predicates: [{ name: 'Inv1', sorts: ['Int'], names: ['i'] }],
    constants: [{ name: 'i', sort: 'Int' }],
    clauses: ['(=> true (Inv1 0))', '(=> (Inv1 i) (>= i 0))'],
    shared: new Map<string, string>(),
  };
  const engineWith = (z3: Engine['z3']): Engine => ({ z3, external: async () => [] });

  it('returns a crash verdict that keeps the reason', async () => {
    const verdict = await solveHorn(
      system,
      engineWith(async () => {
        throw new SolverCrash('the Z3 solver crashed: injected');
      }),
      1000,
    );
    assert.deepEqual(verdict, { kind: 'crash', reason: 'the Z3 solver crashed: injected' });
  });

  it('still takes a genuine unknown or an ordinary failure as no verdict', async () => {
    const unknown = await solveHorn(
      system,
      engineWith(async () => ({ out: 'unknown', vals: '' })),
      1000,
    );
    assert.equal(unknown.kind, 'unknown', JSON.stringify(unknown));
    const failed = await solveHorn(
      system,
      engineWith(async () => {
        throw new Error('the solver did not stop within 1000 ms and was terminated');
      }),
      1000,
    );
    assert.equal(failed.kind, 'unknown', JSON.stringify(failed));
  });

  it('solve retries a crash on a fresh worker and throws SolverCrash when every try crashes', async () => {
    const once = crashing(1);
    const answer = await withWorkers(once.start, () => solve('(check-sat)', '', 20000));
    assert.equal(answer.out, 'sat');
    assert.equal(once.started(), 2);
    await assert.rejects(
      withWorkers(crashing(Infinity).start, () => solve('(check-sat)', '', 20000)),
      (error: unknown) => error instanceof SolverCrash && /injected out of memory/.test(error.message),
    );
  });
});
