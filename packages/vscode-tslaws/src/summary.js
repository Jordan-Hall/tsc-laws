'use strict';

const ORDER = ['proved', 'bounded', 'tested', 'open', 'failed', 'uncovered', 'tampered', 'error'];
const PASSING = new Set(['proved', 'bounded', 'tested']);

/** @param {{status: string}[]} records */
function countStatuses(records) {
  const counts = {};
  for (const r of records) counts[r.status] = (counts[r.status] ?? 0) + 1;
  return counts;
}

/**
 * Status-bar text such as `laws: 3 proved, 1 failed`. `records` is null before the first run.
 * @param {{status: string}[] | null} records
 * @param {{running?: boolean}} [state]
 */
function summaryText(records, state = {}) {
  if (state.running === true) return 'laws: running...';
  if (records === null || records === undefined) return 'laws: not run';
  if (records.length === 0) return 'laws: none';
  const counts = countStatuses(records);
  const known = ORDER.filter((s) => counts[s] !== undefined);
  const extra = Object.keys(counts).filter((s) => !ORDER.includes(s));
  return 'laws: ' + [...known, ...extra].map((s) => `${counts[s]} ${s}`).join(', ');
}

/** True when every record passes. */
function allPass(records) {
  return records !== null && records.every((r) => PASSING.has(r.status));
}

module.exports = { summaryText, countStatuses, allPass, PASSING, ORDER };
