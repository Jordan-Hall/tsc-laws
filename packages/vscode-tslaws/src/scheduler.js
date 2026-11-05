'use strict';

// Debounces requests to run laws and cancels a run that a newer edit has made stale. Pure: timers and the way a run
// starts are injected, so tests drive it with a fake clock.

/**
 * Combine two requests. `files: null` means every laws file and wins; otherwise the files join. Named laws survive only
 * when both requests name laws in the one same file.
 * @param {{files: string[] | null, laws?: string[], reason?: string, args?: string[]} | null} a
 * @param {{files: string[] | null, laws?: string[], reason?: string, args?: string[]}} b
 */
function mergeRequests(a, b) {
  if (a === null) return b;
  const files = a.files === null || b.files === null ? null : [...new Set([...a.files, ...b.files])];
  const sameFile = files !== null && files.length === 1;
  const laws =
    sameFile && a.laws !== undefined && b.laws !== undefined ? [...new Set([...a.laws, ...b.laws])] : undefined;
  // Extra arguments (such as --no-prove) apply only if every request asked for them.
  const args = (a.args ?? []).filter((x) => (b.args ?? []).includes(x));
  return { files, ...(laws === undefined ? {} : { laws }), args, reason: b.reason ?? a.reason };
}

/**
 * @param {{
 *   delayMs: number | (() => number),
 *   start: (request: object) => {cancel: () => void, done: Promise<unknown>},
 *   setTimer?: typeof setTimeout, clearTimer?: typeof clearTimeout,
 *   onState?: (state: 'idle' | 'waiting' | 'running') => void,
 * }} o
 */
function createScheduler(o) {
  const setTimer = o.setTimer ?? setTimeout;
  const clearTimer = o.clearTimer ?? clearTimeout;
  const onState = o.onState ?? (() => {});
  let pending = null;
  let timer = null;
  let current = null;
  let chain = Promise.resolve();

  const runPending = async () => {
    // A newer request arrived while the stale run was stopping: its own timer will start the run.
    if (pending === null || timer !== null) return;
    const request = pending;
    pending = null;
    const run = o.start(request);
    current = run;
    onState('running');
    try {
      await run.done;
    } finally {
      if (current === run) current = null;
      onState(pending !== null || timer !== null ? 'waiting' : 'idle');
    }
  };

  return {
    /** Ask for a run; waits `delayMs` after the last request, and stops a run already going. */
    request(request) {
      pending = mergeRequests(pending, request);
      if (current !== null) current.cancel();
      if (timer !== null) clearTimer(timer);
      timer = setTimer(
        () => {
          timer = null;
          chain = chain.then(runPending, runPending);
        },
        typeof o.delayMs === 'function' ? o.delayMs() : o.delayMs,
      );
      onState('waiting');
    },
    /** Run now, without waiting out the delay. */
    flush() {
      if (timer !== null) {
        clearTimer(timer);
        timer = null;
        chain = chain.then(runPending, runPending);
      }
      return chain;
    },
    /** Drop the pending request and stop the run going. */
    cancel() {
      pending = null;
      if (timer !== null) clearTimer(timer);
      timer = null;
      if (current !== null) current.cancel();
      onState(current === null ? 'idle' : 'running');
    },
    get running() {
      return current !== null;
    },
    get idle() {
      return chain;
    },
  };
}

module.exports = { createScheduler, mergeRequests };
