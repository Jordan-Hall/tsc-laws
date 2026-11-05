'use strict';

// What the editor knows about the laws: the latest record of each law, when it ran, and the maps built from them (which
// laws reach which function, which law files cover which source file). Pure; `merge` is how a run's results join it.

const { PASSING } = require('./summary.js');

const key = (file, name) => `${file}::${name}`;

/**
 * Join the results of a run with what was known before.
 *
 * A run of every law replaces everything. A run of some laws files (or of named laws in one file) replaces only those:
 * `uncovered` results and `tampered` results for files that were not run come from reading only part of the project (a
 * subset of laws reaches fewer functions, and laws in the other files look removed), so they are dropped and the last
 * full run's stay.
 * @param {object[]} previous
 * @param {object[]} incoming
 * @param {{files: string[] | null, laws?: string[] | null}} ran files run (null: all) and, within one file, law names
 * @returns {object[]}
 */
function merge(previous, incoming, ran) {
  if (ran.files === null) return incoming;
  const files = new Set(ran.files);
  const names = ran.laws !== undefined && ran.laws !== null ? new Set(ran.laws) : null;
  const fresh = incoming.filter(
    (r) =>
      files.has(r.file) && r.status !== 'uncovered' && (names === null || names.has(r.name) || r.status === 'tampered'),
  );
  const replaced = new Set(fresh.map((r) => key(r.file, r.name)));
  const kept = previous.filter((r) => {
    if (replaced.has(key(r.file, r.name))) return false;
    // A law that ran and is no longer reported has been removed from its file.
    if (names === null && files.has(r.file) && r.status !== 'uncovered' && r.method !== 'coverage') return false;
    return true;
  });
  return [...kept, ...fresh];
}

/** Which source functions the laws reach: `file::function` to the laws that reach it. */
function functionIndex(records) {
  const index = new Map();
  for (const r of records) {
    for (const e of r.exercises ?? []) {
      const id = key(e.declaration.file, e.name);
      let entry = index.get(id);
      if (entry === undefined) {
        entry = { file: e.declaration.file, name: e.name, declaration: e.declaration, laws: [] };
        index.set(id, entry);
      }
      entry.laws.push({
        file: r.file,
        name: r.name,
        status: r.status,
        failing: r.status === 'failed',
        blamed: e.failing === true,
      });
    }
  }
  return index;
}

/** Law files that reach each source file: `source file` to a set of law files. */
function coverageMap(records) {
  const map = new Map();
  for (const r of records) {
    for (const e of r.exercises ?? []) {
      const file = e.declaration.file;
      if (file === r.file) continue;
      if (!map.has(file)) map.set(file, new Set());
      map.get(file).add(r.file);
    }
  }
  return map;
}

/** The laws that are not passing, with the function each is blamed on. */
function failing(records) {
  return records.filter((r) => !PASSING.has(r.status));
}

/**
 * The functions to flag for a failed law: the ones the stack named; else the ones the law names itself (one is
 * certain, several are only candidates); else the ones it reaches through them.
 * @returns {{exercise: object, certain: boolean}[]}
 */
function blamedFunctions(record) {
  const all = record.exercises ?? [];
  const named = all.filter((e) => e.failing);
  if (named.length > 0) return named.map((exercise) => ({ exercise, certain: true }));
  const direct = all.filter((e) => e.call !== undefined);
  const pool = direct.length > 0 ? direct : all;
  return pool.map((exercise) => ({ exercise, certain: pool.length === 1 }));
}

module.exports = { merge, functionIndex, coverageMap, failing, blamedFunctions, key };
