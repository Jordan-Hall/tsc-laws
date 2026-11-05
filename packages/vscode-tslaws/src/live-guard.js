'use strict';

// Keeps the background run from hurting the machine: it waits while the processors are busy, stops by itself when the
// last run took longer than the person allows, and never lets two checks run at once. Pure: the clock and the processor
// counters are passed in.

/**
 * A reader of how busy the machine has been since the last read: 0 to 1, from the cumulative counters `os.cpus()` gives.
 * @param {() => {times: {user: number, nice: number, sys: number, idle: number, irq: number}}[]} cpus
 */
function createCpuSampler(cpus) {
  const total = () => {
    let idle = 0;
    let all = 0;
    for (const { times } of cpus()) {
      idle += times.idle;
      all += times.user + times.nice + times.sys + times.idle + times.irq;
    }
    return { idle, all };
  };
  let last = total();
  return {
    /** The busy share since the previous call; 0 when no time has passed. */
    read() {
      const now = total();
      const all = now.all - last.all;
      const idle = now.idle - last.idle;
      last = now;
      return all <= 0 ? 0 : Math.min(1, Math.max(0, 1 - idle / all));
    },
  };
}

/**
 * @param {{
 *   busy: () => number, limit: () => number, maxSeconds: () => number, now?: () => number,
 * }} o `busy` reads the machine's load (0 to 1), `limit` is the load above which a run waits, `maxSeconds` the run
 *   length above which live results stop
 */
function createLiveGuard(o) {
  let paused = false;
  let tooSlow = null;
  let running = false;
  const guard = {
    /** Can a live run start now? `reason` says why not: `paused`, `slow`, `running` or `busy`. */
    check() {
      if (paused) return { ok: false, reason: 'paused' };
      if (tooSlow !== null) return { ok: false, reason: 'slow', seconds: tooSlow };
      if (running) return { ok: false, reason: 'running' };
      if (o.busy() > o.limit()) return { ok: false, reason: 'busy' };
      return { ok: true };
    },
    started() {
      running = true;
    },
    /** A live run ended after `ms`; a run over the limit stops live results until they are resumed. */
    finished(ms) {
      running = false;
      if (ms > o.maxSeconds() * 1000) tooSlow = Math.round(ms / 1000);
    },
    get paused() {
      return paused;
    },
    get stoppedBySpeed() {
      return tooSlow;
    },
    /** Toggle the pause; resuming also clears a stop for slowness. Returns whether live results are paused now. */
    toggle() {
      if (paused || tooSlow !== null) {
        paused = false;
        tooSlow = null;
      } else paused = true;
      return paused;
    },
  };
  return guard;
}

module.exports = { createCpuSampler, createLiveGuard };
