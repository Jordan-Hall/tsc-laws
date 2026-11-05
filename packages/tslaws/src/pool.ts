import { availableParallelism } from 'node:os';
import type { Worker } from 'node:worker_threads';

/** How many laws run at once: the machine's cores, up to 8, or TSLAWS_JOBS. */
export function jobs(): number {
  const given = Number(process.env.TSLAWS_JOBS);
  return Number.isInteger(given) && given > 0 ? given : Math.min(8, availableParallelism());
}

/**
 * A pool of workers where each request holds one exclusively, so a timeout can terminate its worker without
 * disturbing a neighbour. Workers start on demand and are reused.
 */
export class WorkerPool {
  private readonly idle: Worker[] = [];
  private readonly waiting: ((worker: Worker) => void)[] = [];
  private count = 0;

  private readonly start: () => Worker;
  private readonly size: number;

  constructor(start: () => Worker, size: number = jobs()) {
    this.start = start;
    this.size = size;
  }

  acquire(): Promise<Worker> {
    const free = this.idle.pop();
    if (free !== undefined) return Promise.resolve(free);
    if (this.count < this.size) {
      this.count += 1;
      return Promise.resolve(this.start());
    }
    return new Promise((resolve) => this.waiting.push(resolve));
  }

  release(worker: Worker): void {
    const next = this.waiting.shift();
    if (next !== undefined) next(worker);
    else this.idle.push(worker);
  }

  /** Terminates a worker that timed out or crashed; a waiting request gets a fresh one. */
  discard(worker: Worker): void {
    void worker.terminate();
    const next = this.waiting.shift();
    if (next === undefined) this.count -= 1;
    else next(this.start());
  }
}
