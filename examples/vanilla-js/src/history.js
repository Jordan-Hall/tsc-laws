// The conversion history: a small pure store, newest entry first.
import { invariant } from 'tslaws';

/**
 * @typedef {object} Entry
 * @property {number} id
 * @property {string} label
 */

/**
 * Adds an entry at the front and drops the oldest ones beyond `limit`.
 * @param {Entry[]} entries
 * @param {Entry} entry
 * @param {number} limit
 * @returns {Entry[]}
 */
export function pushEntry(entries, entry, limit) {
  return [entry, ...entries].slice(0, Math.max(limit, 0));
}

/**
 * Removes the entry with this id, if there is one.
 * @param {Entry[]} entries
 * @param {number} id
 * @returns {Entry[]}
 */
export function removeEntry(entries, id) {
  return entries.filter((e) => e.id !== id);
}

/**
 * How many of `count` entries fit in `limit` slots. It counts up one at a time, so the invariant is what lets the
 * prover cover every count and limit instead of a few unrolled iterations.
 * @param {import('./convert.js').Int} count
 * @param {import('./convert.js').Int} limit
 * @returns {import('./convert.js').Int}
 */
export function keptCount(count, limit) {
  let kept = 0;
  while (kept < count && kept < limit) {
    invariant(0 <= kept && kept <= count && kept <= limit);
    kept += 1;
  }
  return /** @type {import('./convert.js').Int} */ (kept);
}

/** A history that remembers what was converted. */
export class History {
  /** @param {number} limit how many entries it keeps */
  constructor(limit = 5) {
    this.limit = limit;
    /** @type {Entry[]} */
    this.entries = [];
    this.nextId = 1;
  }

  /**
   * @param {string} label
   * @returns {Entry}
   */
  add(label) {
    const entry = { id: this.nextId, label };
    this.nextId += 1;
    this.entries = pushEntry(this.entries, entry, this.limit);
    return entry;
  }

  /** @param {number} id */
  remove(id) {
    this.entries = removeEntry(this.entries, id);
  }

  clear() {
    this.entries = [];
  }
}
