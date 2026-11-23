import { AsyncLocalStorage } from 'node:async_hooks';
import { availableParallelism, constants, freemem, setPriority } from 'node:os';
import type { Worker } from 'node:worker_threads';

/** Where the number of slots may come from, in the order that wins: the flag, the environment, tslaws.json. */
export interface JobSources {
  flag?: number;
  config?: number;
}

const gibibyte = 2 ** 30;

/**
 * How many things run at once. A given number (flag, then `TSLAWS_JOBS`, then `jobs` in tslaws.json) is used as it is.
 * Without one: the cores less one, so the machine stays usable, up to 8, and no more than one slot per GiB of free memory
 * (a Z3 instance holds a large WebAssembly heap).
 */
export function resolveJobs(input: JobSources & { env?: string; cores: number; freeBytes: number }): number {
  const given = (value: number | undefined): number | undefined =>
    value !== undefined && Number.isInteger(value) && value > 0 ? value : undefined;
  const fromEnv = input.env === undefined || input.env.trim() === '' ? undefined : given(Number(input.env));
  const chosen = given(input.flag) ?? fromEnv ?? given(input.config);
  if (chosen !== undefined) return chosen;
  const byCores = Math.min(8, Math.max(1, input.cores - 1));
  return Math.max(1, Math.min(byCores, Math.floor(input.freeBytes / gibibyte)));
}

let sources: JobSources = {};
let cached: number | undefined;

/**
 * Sets where the number of slots comes from (the command line flag, `jobs` of tslaws.json). An absent `flag` leaves the
 * flag as it was; a `config` key replaces the config source even when it is undefined, so one project's `jobs` never
 * carries over to the next project checked in the same process.
 */
export function configureJobs(next: JobSources = {}): void {
  sources = {
    flag: next.flag ?? sources.flag,
    config: 'config' in next ? next.config : sources.config,
  };
  cached = undefined;
}

/** Forgets every configured source and the number worked out from them; for tests. */
export function resetJobs(): void {
  sources = {};
  cached = undefined;
}

/** The size of the CPU budget. Worked out once per configuration, so free memory does not move it mid-run. */
export function jobs(): number {
  cached ??= resolveJobs({
    ...sources,
    env: process.env.TSLAWS_JOBS,
    cores: availableParallelism(),
    freeBytes: freemem(),
  });
  return cached;
}

/** Runs below normal priority, so a solver does not starve the machine's other work. Failures are ignored. */
export function lowerPriority(pid: number | undefined): void {
  if (pid === undefined) return;
  try {
    setPriority(pid, constants.priority.PRIORITY_BELOW_NORMAL);
  } catch {
    // Not allowed, or the process is already gone: it simply runs at its usual priority.
  }
}

/**
 * Slots of CPU for everything heavy: a law run, a solve, a spawned solver, a property worker task, a sandboxed law
 * process. One budget serves the whole process, so the pools below no longer each take every core.
 *
 * Nesting reuses the slot: work started inside a function that `run` is holding a slot for (a proof under the law that
 * asked for it) takes no second slot, so a waiting law can never be starved by the work it is waiting on, and a budget
 * of 1 cannot deadlock. A race or portfolio asks for one extra slot per additional member with `portfolio`, never
 * waiting for it: with none free the members run one after another on the slot already held.
 */
export class Budget {
  private used = 0;
  private readonly waiting: (() => void)[] = [];
  private readonly held = new AsyncLocalStorage<true>();
  private readonly limit: () => number;

  constructor(limit: () => number = jobs) {
    this.limit = limit;
  }

  /** The slots in use now. */
  get inUse(): number {
    return this.used;
  }

  /** The most slots there may be. */
  get size(): number {
    return this.limit();
  }

  /** Whether this async context already holds a slot. */
  get holding(): boolean {
    return this.held.getStore() === true;
  }

  /** Runs `work` holding one slot, waiting for one when none is free; reuses the slot this context already holds. */
  async run<T>(work: () => Promise<T> | T): Promise<T> {
    if (this.holding) return work();
    await this.take();
    try {
      return await this.held.run(true, work);
    } finally {
      this.give();
    }
  }

  /** Takes a slot if one is free right now; the returned function gives it back. */
  tryHold(): (() => void) | undefined {
    if (this.used >= this.limit()) return undefined;
    this.used += 1;
    let given = false;
    return () => {
      if (given) return;
      given = true;
      this.give();
    };
  }

  /**
   * Runs the tasks together, each past the first on an extra slot, and the rest one after another on the slot already
   * held. Results come back in the order of the tasks.
   */
  portfolio<T>(tasks: (() => Promise<T>)[]): Promise<T[]> {
    return this.run(async () => {
      const results = Array.from<T>({ length: tasks.length });
      const together: Promise<void>[] = [];
      const inTurn: number[] = [];
      let failure: { error: unknown } | undefined;
      tasks.forEach((task, index) => {
        const release = index === 0 ? undefined : this.tryHold();
        if (release === undefined) {
          inTurn.push(index);
          return;
        }
        together.push(
          this.held
            .run(true, task)
            .then(
              (value) => {
                results[index] = value;
              },
              (error: unknown) => {
                failure ??= { error };
              },
            )
            .finally(release),
        );
      });
      for (const index of inTurn) {
        try {
          results[index] = await tasks[index]!();
        } catch (error) {
          failure ??= { error };
        }
      }
      await Promise.all(together);
      if (failure !== undefined) throw failure.error;
      return results;
    });
  }

  private take(): Promise<void> {
    if (this.used < this.limit()) {
      this.used += 1;
      return Promise.resolve();
    }
    return new Promise((resolve) => this.waiting.push(resolve));
  }

  private give(): void {
    // A slot goes straight to the next one waiting, unless the budget has shrunk below what is in use.
    const next = this.used > this.limit() ? undefined : this.waiting.shift();
    if (next === undefined) this.used -= 1;
    else next();
  }
}

/** The one budget of this process. */
export const budget = new Budget();

/**
 * A pool of workers where each request holds one exclusively, so a timeout can terminate its worker without
 * disturbing a neighbour. Workers start on demand and are reused. `size` is read each time, so it may follow the budget.
 * With `idleMs`, a worker that sits unused that long is terminated.
 */
export class WorkerPool<T extends { terminate(): unknown } = Worker> {
  private readonly idle: T[] = [];
  private readonly timers = new Map<T, NodeJS.Timeout>();
  private readonly waiting: ((worker: T) => void)[] = [];
  private count = 0;

  private readonly start: () => T;
  private readonly size: () => number;
  private readonly idleMs: number | undefined;

  constructor(start: () => T, size: number | (() => number) = jobs, idleMs?: number) {
    this.start = start;
    this.size = typeof size === 'number' ? () => size : size;
    this.idleMs = idleMs;
  }

  /** The workers this pool has started and not yet ended, busy or idle. */
  get live(): number {
    return this.count;
  }

  acquire(): Promise<T> {
    const free = this.idle.pop();
    if (free !== undefined) {
      this.untimed(free);
      return Promise.resolve(free);
    }
    if (this.count < this.size()) {
      this.count += 1;
      return Promise.resolve(this.start());
    }
    return new Promise((resolve) => this.waiting.push(resolve));
  }

  /** Starts up to `n` workers now, so they finish loading while the caller does other work. */
  warm(n: number): void {
    while (this.count < Math.min(n, this.size())) {
      this.count += 1;
      // Not timed: it waits for the first law, which may be a compile away.
      this.idle.push(this.start());
    }
  }

  release(worker: T): void {
    const next = this.waiting.shift();
    if (next !== undefined) next(worker);
    else this.park(worker);
  }

  /** Terminates one idle worker, to make room elsewhere; false when none is idle. */
  evictOne(): boolean {
    const worker = this.idle.shift();
    if (worker === undefined) return false;
    this.untimed(worker);
    void worker.terminate();
    this.count -= 1;
    return true;
  }

  /** Terminates the idle workers, for a project that is done (a scratch copy that is about to be deleted). */
  close(): void {
    while (this.evictOne());
  }

  /** Terminates a worker that timed out or crashed; a waiting request gets a fresh one. */
  discard(worker: T): void {
    void worker.terminate();
    const next = this.waiting.shift();
    if (next === undefined) this.count -= 1;
    else next(this.start());
  }

  private park(worker: T): void {
    this.idle.push(worker);
    if (this.idleMs === undefined) return;
    const timer = setTimeout(() => {
      const at = this.idle.indexOf(worker);
      if (at < 0) return;
      this.idle.splice(at, 1);
      this.timers.delete(worker);
      void worker.terminate();
      this.count -= 1;
    }, this.idleMs);
    timer.unref();
    this.timers.set(worker, timer);
  }

  private untimed(worker: T): void {
    const timer = this.timers.get(worker);
    if (timer === undefined) return;
    clearTimeout(timer);
    this.timers.delete(worker);
  }
}
