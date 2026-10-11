/**
 * With TSC_TS_TIMELINE: a timeline of the run on stderr, one event per line as
 * `@<ms> <thread> <event>`, where `<ms>` is `performance.now()` (in native builds, milliseconds since
 * the executable was loaded, the same clock on every thread) and `<thread>` is `main`, `p<n>` for a
 * parse thread or `c<n>` for a checker thread.
 */
import { readFileSync } from 'node:fs';

export const timeline = process.env.TSC_TS_TIMELINE !== undefined;

let thread = 'main';

/** Names this thread in the timeline. */
export function setTimelineThread(name: string): void {
  thread = name;
}

/** Writes a timeline event at the current time. */
export function mark(event: string): void {
  if (timeline) markAt(performance.now(), event);
}

/** Writes a timeline event at `ms`. */
export function markAt(ms: number, event: string): void {
  if (timeline) process.stderr.write(`@${ms.toFixed(2)} ${thread} ${event}\n`);
}

/** Writes the process's memory summary (Linux `/proc/self/smaps_rollup`, in MB) as a timeline event. */
export function markMemory(): void {
  if (!timeline) return;
  try {
    const text = readFileSync('/proc/self/smaps_rollup', 'utf8');
    let out = 'memory';
    for (const key of ['Rss', 'Anonymous', 'AnonHugePages', 'Private_Dirty']) {
      const m = new RegExp(key + ':\\s+(\\d+)').exec(text);
      if (m !== null) out += ` ${key} ${Math.round(Number(m[1]) / 1024)}`;
    }
    const status = readFileSync('/proc/self/status', 'utf8');
    const pt = /VmPTE:\s+(\d+)/.exec(status);
    if (pt !== null) out += ` VmPTE ${Math.round(Number(pt[1]) / 1024)}`;
    mark(out);
  } catch {
    mark('memory unavailable');
  }
}
