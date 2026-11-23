// The CPU budget (src/pool.ts): one count of slots for law runs, solves, spawned solvers and law processes, so the pools
// no longer each take every core. Needs the built compiler in TSC_LAWS_BIN and `npm run build` for dist/.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { after, afterEach, describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';
import { check } from '../dist/check.js';
import { parseConfig } from '../dist/coverage.js';
import {
  Budget,
  budget,
  configureJobs,
  jobs,
  lowerPriority,
  resetJobs,
  resolveJobs,
  WorkerPool,
} from '../dist/pool.js';
import { liveSandboxProcesses } from '../dist/sandbox.js';
import { sealedSettings } from '../dist/settings.js';
import { solve } from '../dist/smt.js';
import type { CheckOptions } from '../dist/types.js';

const compiler = process.env.TSC_LAWS_BIN;
const here = dirname(fileURLToPath(import.meta.url));
const root = mkdtempSync(join(here, '..', '.tmp-pool-'));
const gib = 2 ** 30;

after(() => {
  rmSync(root, { recursive: true, force: true });
  // Z3's worker threads keep the test process alive.
  setTimeout(() => process.exit(process.exitCode ?? 0), 100).unref();
});

afterEach(() => {
  resetJobs();
  delete process.env.TSLAWS_JOBS;
});

const later = (ms: number): Promise<void> => new Promise((done) => setTimeout(done, ms));

/** Fails the test instead of hanging it when `work` never settles. */
async function within<T>(ms: number, work: Promise<T>): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  const limit = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`still waiting after ${ms} ms: deadlock`)), ms);
  });
  try {
    return await Promise.race([work, limit]);
  } finally {
    clearTimeout(timer);
  }
}

describe('how many slots there are', () => {
  const machine = { cores: 16, freeBytes: 64 * gib };

  it('is the cores less one, up to 8, by default', () => {
    assert.equal(resolveJobs({ ...machine, cores: 1 }), 1);
    assert.equal(resolveJobs({ ...machine, cores: 2 }), 1);
    assert.equal(resolveJobs({ ...machine, cores: 4 }), 3);
    assert.equal(resolveJobs({ ...machine, cores: 9 }), 8);
    assert.equal(resolveJobs(machine), 8);
  });

  it('is held to about one slot per GiB of free memory, and never below 1', () => {
    assert.equal(resolveJobs({ ...machine, freeBytes: 3.5 * gib }), 3);
    assert.equal(resolveJobs({ ...machine, freeBytes: 0.2 * gib }), 1);
  });

  it('takes the flag over the environment, the environment over tslaws.json, and that over the default', () => {
    assert.equal(resolveJobs({ ...machine, flag: 2, env: '3', config: 4 }), 2);
    assert.equal(resolveJobs({ ...machine, env: '3', config: 4 }), 3);
    assert.equal(resolveJobs({ ...machine, config: 4 }), 4);
    assert.equal(resolveJobs(machine), 8);
  });

  it('uses a number that was given as it is, however little memory is free', () => {
    assert.equal(resolveJobs({ ...machine, freeBytes: 1 * gib, flag: 6 }), 6);
  });

  it('skips a source that is not a whole number above zero', () => {
    assert.equal(resolveJobs({ ...machine, flag: 0, env: 'many', config: 5 }), 5);
    assert.equal(resolveJobs({ ...machine, env: '', config: 2.5 }), 8);
    assert.equal(resolveJobs({ ...machine, env: '-1' }), 8);
  });

  it('follows configureJobs and the environment of the live process', () => {
    process.env.TSLAWS_JOBS = '3';
    configureJobs({ config: 7 });
    assert.equal(jobs(), 3);
    configureJobs({ flag: 2 });
    assert.equal(jobs(), 2);
    resetJobs();
    delete process.env.TSLAWS_JOBS;
    configureJobs({ config: 5 });
    assert.equal(jobs(), 5);
  });

  it('is a key of tslaws.json that is validated and left out of the seal', () => {
    assert.equal(parseConfig({ jobs: 3 }).jobs, 3);
    assert.throws(() => parseConfig({ jobs: 0 }), /"jobs" must be an integer of at least 1/);
    assert.throws(() => parseConfig({ jobs: 'all' }), /"jobs" must be an integer of at least 1/);
    assert.deepEqual(sealedSettings(parseConfig({ jobs: 3 })), sealedSettings(parseConfig({})));
  });

  it('is set on the command line by --jobs, which must be a whole number above zero', () => {
    const bin = join(here, '..', 'bin', 'tslaws.js');
    const run = spawnSync(process.execPath, [bin, 'check', '--jobs', '0'], { cwd: root, encoding: 'utf8' });
    assert.equal(run.status, 1);
    assert.match(run.stderr, /--jobs must be an integer of at least 1/);
  });
});

describe('the budget', () => {
  it('never has more slots in use than it has', async () => {
    const slots = new Budget(() => 3);
    let running = 0;
    let most = 0;
    let usedMost = 0;
    await Promise.all(
      Array.from({ length: 24 }, () =>
        slots.run(async () => {
          running += 1;
          most = Math.max(most, running);
          usedMost = Math.max(usedMost, slots.inUse);
          await later(5);
          running -= 1;
        }),
      ),
    );
    assert.equal(most, 3);
    assert.equal(usedMost, 3);
    assert.equal(slots.inUse, 0);
  });

  it('holds the global budget to its size, through every kind of work', async () => {
    configureJobs({ flag: 2 });
    let usedMost = 0;
    const sample = setInterval(() => (usedMost = Math.max(usedMost, budget.inUse)), 1);
    try {
      await Promise.all(
        Array.from({ length: 12 }, (_, i) =>
          i % 3 === 0 ? budget.portfolio([() => later(4), () => later(4), () => later(4)]) : budget.run(() => later(4)),
        ),
      );
    } finally {
      clearInterval(sample);
    }
    assert.ok(usedMost >= 1 && usedMost <= 2, `${usedMost} slots in use at once of 2`);
    assert.equal(budget.inUse, 0);
  });

  it('hands a slot back when the work throws', async () => {
    const slots = new Budget(() => 1);
    await assert.rejects(
      slots.run(() => Promise.reject(new Error('boom'))),
      /boom/,
    );
    assert.equal(slots.inUse, 0);
    assert.equal(await slots.run(() => 'again'), 'again');
  });

  it('lets nested work reuse the slot, so a budget of 1 does not deadlock', async () => {
    const slots = new Budget(() => 1);
    const answer = await within(
      2000,
      slots.run(() => slots.run(() => slots.run(async () => slots.inUse))),
    );
    assert.equal(answer, 1);
    assert.equal(slots.inUse, 0);
  });

  it('runs a portfolio one after another when no slot is free, and together when there are some', async () => {
    const watch = async (slots: Budget): Promise<number> => {
      let running = 0;
      let most = 0;
      const member = async (): Promise<void> => {
        running += 1;
        most = Math.max(most, running);
        await later(15);
        running -= 1;
      };
      await slots.portfolio([member, member, member]);
      assert.equal(slots.inUse, 0);
      return most;
    };
    assert.equal(await within(2000, watch(new Budget(() => 1))), 1);
    assert.equal(await within(2000, watch(new Budget(() => 2))), 2);
    assert.equal(await within(2000, watch(new Budget(() => 8))), 3);
  });

  it('takes a portfolio under a law that holds a slot without waiting for a second one', async () => {
    const slots = new Budget(() => 2);
    const inside = await within(
      2000,
      slots.run(async () => {
        const seen: number[] = [];
        const results = await slots.portfolio([
          async () => (seen.push(slots.inUse), 'a'),
          async () => (seen.push(slots.inUse), 'b'),
          async () => (seen.push(slots.inUse), 'c'),
        ]);
        return { results, most: Math.max(...seen) };
      }),
    );
    assert.deepEqual(inside.results, ['a', 'b', 'c']);
    assert.ok(inside.most <= 2);
    assert.equal(slots.inUse, 0);
  });

  it('reports a failing member of a portfolio after the others have finished', async () => {
    const slots = new Budget(() => 3);
    let finished = false;
    await assert.rejects(
      slots.portfolio([
        () => Promise.reject(new Error('one failed')),
        async () => {
          await later(20);
          finished = true;
        },
      ]),
      /one failed/,
    );
    assert.equal(finished, true);
    assert.equal(slots.inUse, 0);
  });

  it('does not deadlock nested solves at a budget of 1', async () => {
    configureJobs({ flag: 1 });
    const query = '(declare-const x Int)\n(assert (> x 0))\n(check-sat)';
    const answers = await within(
      60_000,
      Promise.all([
        // A solve under a law's slot, a solve of its own, and a second law that waits for the first.
        budget.run(async () => [(await solve(query, '', 5000)).out.trim(), (await solve(query, '', 5000)).out.trim()]),
        solve(query, '', 5000).then((r) => [r.out.trim()]),
        budget.run(async () => [(await solve(query, '', 5000)).out.trim()]),
      ]),
    );
    assert.deepEqual(answers, [['sat', 'sat'], ['sat'], ['sat']]);
    assert.equal(budget.inUse, 0);
  });
});

describe('the worker pool', () => {
  const fake = (): { terminate(): void; ended: boolean } => {
    const worker = {
      ended: false,
      terminate(): void {
        worker.ended = true;
      },
    };
    return worker;
  };

  it('ends a worker that sits unused for the idle time, and starts another when asked', async () => {
    const pool = new WorkerPool(fake, 2, 30);
    const first = await pool.acquire();
    pool.release(first);
    assert.equal(pool.live, 1);
    await later(120);
    assert.equal(first.ended, true);
    assert.equal(pool.live, 0);
    const second = await pool.acquire();
    assert.notEqual(second, first);
  });

  it('does not end a worker that was taken again in time', async () => {
    const pool = new WorkerPool(fake, 2, 60);
    const first = await pool.acquire();
    pool.release(first);
    const again = await pool.acquire();
    assert.equal(again, first);
    await later(150);
    assert.equal(first.ended, false);
  });

  it('makes room by ending an idle worker', async () => {
    const pool = new WorkerPool(fake, 2);
    const worker = await pool.acquire();
    pool.release(worker);
    assert.equal(pool.evictOne(), true);
    assert.equal(worker.ended, true);
    assert.equal(pool.live, 0);
    assert.equal(pool.evictOne(), false);
  });

  it('lowers the priority of a process without minding a process that is gone', () => {
    assert.doesNotThrow(() => lowerPriority(undefined));
    assert.doesNotThrow(() => lowerPriority(2 ** 30));
  });
});

describe('the law processes of several projects', () => {
  function project(name: string, laws: number): CheckOptions {
    const cwd = join(root, name);
    mkdirSync(join(cwd, 'src'), { recursive: true });
    writeFileSync(
      join(cwd, 'src', 'a.laws.ts'),
      Array.from(
        { length: laws },
        (_, i) => `export law holds${i}(n: number) => Math.abs(n) >= 0 && ${i} === ${i};`,
      ).join('\n') + '\n',
    );
    return {
      files: ['src/a.laws.ts'],
      cwd,
      runs: 20,
      compiler: compiler!,
      lockFile: join(cwd, 'tsc-laws.lock'),
      noProve: true,
      bound: 4,
      proofTimeoutMs: 5000,
      propertyTimeoutMs: 20000,
    };
  }

  it('share one cap, not one per project', async () => {
    configureJobs({ flag: 2 });
    let live = 0;
    let used = 0;
    const sample = setInterval(() => {
      live = Math.max(live, liveSandboxProcesses());
      used = Math.max(used, budget.inUse);
    }, 1);
    try {
      const reports = await Promise.all([
        check(project('first', 6), false),
        check(project('second', 6), false),
        check(project('third', 6), false),
      ]);
      for (const report of reports) {
        assert.equal(report.results.length, 6);
        assert.ok(
          report.results.every((r) => r.status === 'tested'),
          JSON.stringify(report.results),
        );
      }
    } finally {
      clearInterval(sample);
    }
    assert.ok(live >= 1, 'a law process was started');
    assert.ok(live <= 2, `${live} law processes alive at once under a budget of 2 (three projects)`);
    assert.ok(used <= 2, `${used} slots in use at once under a budget of 2`);
    assert.equal(budget.inUse, 0);
  });
});
