// The CI test units, their measured durations, and shard packing.
//
// A unit is one test file run with `node --test` in its package, one part of a test file that splits its runs
// (program.test.mjs, command-line.test.mjs and library-checking.test.mjs take an `i/n` shard), or one corpus suite.
// Unit ids are stable strings such as `packages/tsc-ts/tests/program.test.mjs#2/8` and `packages/tsgo/corpus/compiler`.
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');

// Parts the split test files run in. More parts shorten the longest unit; each part repeats the file's setup.
const parts = {
  'packages/tsc-ts/tests/program.test.mjs': { env: 'PROGRAM_SHARD', count: 8 },
  'packages/tsc-ts/tests/command-line.test.mjs': { env: 'CLI_SHARD', count: 4 },
  'packages/tsc-ts/tests/library-checking.test.mjs': { env: 'LIBRARY_SHARD', count: 3 },
};

/** @typedef {{ id: string, file: string, cwd: string, command: string[], env: Record<string, string> }} Unit */

/** Every unit, in a fixed order. */
export function allUnits() {
  /** @type {Unit[]} */
  const units = [];
  for (const pkg of ['tsc-ts', 'relater', 'tsgo']) {
    const dir = join(root, 'packages', pkg, 'tests');
    if (!existsSync(dir)) continue;
    for (const name of readdirSync(dir).sort()) {
      if (!name.endsWith('.test.mjs')) continue;
      const file = `packages/${pkg}/tests/${name}`;
      const base = { file, cwd: `packages/${pkg}`, command: ['node', '--test', `tests/${name}`] };
      const split = parts[file];
      if (split === undefined) units.push({ ...base, id: file, env: {} });
      else
        for (let i = 1; i <= split.count; i++)
          units.push({ ...base, id: `${file}#${i}/${split.count}`, env: { [split.env]: `${i}/${split.count}` } });
    }
  }
  for (const suite of ['compiler', 'conformance'])
    units.push({
      id: `packages/tsgo/corpus/${suite}`,
      file: 'packages/tsgo/scripts/corpus.mjs',
      cwd: 'packages/tsgo',
      command: ['node', 'scripts/corpus.mjs', suite],
      env: {},
    });
  return units;
}

/** Measured seconds per unit id on a GitHub-hosted ubuntu runner (scripts/ci/durations.json). */
export function durations() {
  const path = join(root, 'scripts/ci/durations.json');
  return existsSync(path) ? JSON.parse(readFileSync(path, 'utf8')).seconds : {};
}

// Units without a measurement count as this many seconds.
const unmeasured = 60;

export function durationOf(id, measured = durations()) {
  return measured[id] ?? unmeasured;
}

/**
 * Packs units into `count` shards, longest first onto the least loaded shard. Returns arrays of unit ids; the
 * packing depends only on the ids and the durations file, so every job computes the same shards.
 */
export function pack(ids, count, measured = durations()) {
  const shards = Array.from({ length: count }, () => ({ ids: [], seconds: 0 }));
  const sorted = [...ids].sort((a, b) => durationOf(b, measured) - durationOf(a, measured) || a.localeCompare(b));
  for (const id of sorted) {
    const lightest = shards.reduce((best, shard) => (shard.seconds < best.seconds ? shard : best));
    lightest.ids.push(id);
    lightest.seconds += durationOf(id, measured);
  }
  return shards;
}

/** The number of shards that keeps each at about `target` seconds, between 1 and `max`. */
export function shardCount(ids, target, max, measured = durations()) {
  const total = ids.reduce((sum, id) => sum + durationOf(id, measured), 0);
  const longest = Math.max(0, ...ids.map((id) => durationOf(id, measured)));
  return Math.max(1, Math.min(max, Math.ceil(total / Math.max(target, longest))));
}
