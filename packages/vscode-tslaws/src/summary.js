'use strict';

const ORDER = ['proved', 'bounded', 'tested', 'open', 'failed', 'uncovered', 'tampered', 'error'];
const PASSING = new Set(['proved', 'bounded', 'tested']);

/** @param {{status: string}[]} records */
function countStatuses(records) {
  const counts = {};
  for (const r of records) counts[r.status] = (counts[r.status] ?? 0) + 1;
  return counts;
}

function countsText(records) {
  const counts = countStatuses(records);
  const known = ORDER.filter((s) => counts[s] !== undefined);
  const extra = Object.keys(counts).filter((s) => !ORDER.includes(s));
  return [...known, ...extra].map((s) => `${counts[s]} ${s}`).join(', ');
}

/**
 * Status-bar text such as `laws: 3 proved, 1 failed`. `records` is null before the first run. While a run is going,
 * `done` and `total` (laws finished and expected) and the `fresh` results so far give `laws: running 2/5 - 1 proved, 1 failed`.
 * @param {{status: string}[] | null} records
 * @param {{running?: boolean, done?: number, total?: number, fresh?: {status: string}[]}} [state]
 */
function summaryText(records, state = {}) {
  if (state.running === true) {
    const progress = Number.isInteger(state.total) && state.total > 0 ? ` ${state.done ?? 0}/${state.total}` : '';
    const fresh = state.fresh !== undefined && state.fresh.length > 0 ? ` - ${countsText(state.fresh)}` : '';
    return progress === '' && fresh === '' ? 'laws: running...' : `laws: running${progress}${fresh}`;
  }
  if (records === null || records === undefined) return 'laws: not run';
  if (records.length === 0) return 'laws: none';
  return `laws: ${countsText(records)}`;
}

/** True when every record passes. */
function allPass(records) {
  return records !== null && records.every((r) => PASSING.has(r.status));
}

module.exports = { summaryText, countStatuses, allPass, PASSING, ORDER };
