// Shared by the declaration test and scripts/declaration-corpus.mjs: emits declarations of
// batches of files with tsgo and the emit driver, and compares every output file byte for byte
// and the declaration errors (TS4xxx and TS9xxx) of each unit.
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { run } from './parser-cases.mjs';
import { baseFlags, tsgo } from './emit-cases.mjs';
import { tempDir } from './temp.mjs';

/** Option sets compared by the corpus and the test. */
export const declarationFlagSets = [
  ['declaration', ['--declaration', '--emitDeclarationOnly']],
  ['declarationMap', ['--declaration', '--emitDeclarationOnly', '--declarationMap']],
  ['isolatedDeclarations', ['--declaration', '--emitDeclarationOnly', '--isolatedDeclarations']],
  ['stripInternal', ['--declaration', '--emitDeclarationOnly', '--stripInternal', '--removeComments']],
  ['declarationDir', ['--declaration', '--emitDeclarationOnly', '--declarationDir']],
];

function listOutputs(dir) {
  const out = [];
  const walk = (d) => {
    if (!existsSync(d)) return;
    for (const name of readdirSync(d).sort()) {
      const path = join(d, name);
      if (statSync(path).isDirectory()) walk(path);
      else out.push(relative(dir, path));
    }
  };
  walk(dir);
  return out;
}

const unitOf = (path) => path.split('/')[0];
const declarationError = /^(.*?)\(\d+,\d+\): error TS(?:4\d{3}|9\d{3}): /;

/** Declaration error lines by unit, with paths relative to `unitsRoot`. */
function errorsByUnit(stdout, cwd, unitsRoot) {
  const result = new Map();
  for (const line of stdout.split('\n')) {
    const match = declarationError.exec(line);
    if (!match) continue;
    const unit = unitOf(relative(unitsRoot, join(cwd, match[1])));
    if (!result.has(unit)) result.set(unit, []);
    result.get(unit).push(line);
  }
  return result;
}

/**
 * Emits declarations of `paths` (each in its own unit directory under `unitsRoot`) with tsgo and
 * `command` in batches. `flags` ending in `--declarationDir` get the output directory there
 * instead of `--outDir`. A batch tsgo panics on is split until the unit it panics on is alone;
 * those units are skipped. Returns `{ units, mismatched, errorMismatched, skipped, inferred }`:
 * sets of unit directories, and `inferred` mapping a unit to `{ fallbacks, unresolved }`.
 */
export async function compareDeclarations(command, unitsRoot, paths, flags, jobs, batchSize = 150) {
  const dir = tempDir('tsc-ts-declarations-out-');
  const units = new Set();
  const mismatched = new Set();
  const errorMismatched = new Set();
  const skipped = new Set();
  const inferred = new Map();
  const queue = [];
  for (let start = 0; start < paths.length; start += batchSize) queue.push(paths.slice(start, start + batchSize));
  for (const path of paths) units.add(unitOf(relative(unitsRoot, path)));
  const declarationDir = flags[flags.length - 1] === '--declarationDir';
  const args = [...baseFlags, ...flags.filter((f) => f !== '--declarationDir'), '--rootDir', unitsRoot];
  const output = (out) => [declarationDir ? '--declarationDir' : '--outDir', out];
  let index = 0;
  let running = 0;
  const worker = async () => {
    while (queue.length > 0 || running > 0) {
      const batch = queue.shift();
      if (batch === undefined) {
        // Wait for running batches that may split.
        await new Promise((resolve) => setTimeout(resolve, 20));
        continue;
      }
      running++;
      const n = index++;
      const expected = join(dir, String(n), 'expected');
      const actual = join(dir, String(n), 'actual');
      const [theirs, mine] = await Promise.all([
        run([tsgo, ...args, ...output(expected), ...batch]),
        run([...command, ...args, ...output(actual), ...batch]),
      ]);
      running--;
      if (theirs.stderr.includes('panic:')) {
        if (batch.length === 1) skipped.add(unitOf(relative(unitsRoot, batch[0])));
        else {
          const half = Math.ceil(batch.length / 2);
          queue.push(batch.slice(0, half), batch.slice(half));
        }
        continue;
      }
      if (mine.stderr !== '') console.error(`batch ${n}: ${mine.stderr.slice(0, 2000)}`);
      const unsupported = new Set();
      for (const line of mine.stdout.toString().split('\n')) {
        let match = /^unsupported (.*?): /.exec(line);
        if (match) unsupported.add(unitOf(relative(unitsRoot, match[1])));
        match = /^inferred (.*?): (\d+) (\d+)$/.exec(line);
        if (match) {
          const unit = unitOf(relative(unitsRoot, match[1]));
          const counts = inferred.get(unit) ?? { fallbacks: 0, unresolved: 0 };
          counts.fallbacks += Number(match[2]);
          counts.unresolved += Number(match[3]);
          inferred.set(unit, counts);
        }
      }
      for (const unit of unsupported) skipped.add(unit);
      const all = new Set([...listOutputs(expected), ...listOutputs(actual)]);
      for (const file of all) {
        const unit = unitOf(file);
        if (unsupported.has(unit)) continue;
        const a = join(expected, file);
        const b = join(actual, file);
        if (!existsSync(a) || !existsSync(b) || !readFileSync(a).equals(readFileSync(b))) mismatched.add(unit);
      }
      const theirErrors = errorsByUnit(theirs.stdout.toString(), process.cwd(), unitsRoot);
      const myErrors = errorsByUnit(mine.stdout.toString(), process.cwd(), unitsRoot);
      for (const unit of new Set([...theirErrors.keys(), ...myErrors.keys()])) {
        const a = (theirErrors.get(unit) ?? []).join('\n');
        const b = (myErrors.get(unit) ?? []).join('\n');
        if (a !== b) errorMismatched.add(unit);
      }
    }
  };
  await Promise.all(Array.from({ length: jobs }, worker));
  return { units, mismatched, errorMismatched, skipped, inferred };
}

/** Match rates of a comparison: all units, units needing no inference, and checker-dependent mismatches. */
export function summarize(result) {
  const compared = [...result.units].filter((unit) => !result.skipped.has(unit));
  const explicit = compared.filter((unit) => (result.inferred.get(unit)?.fallbacks ?? 0) === 0);
  const ok = (unit) => !result.mismatched.has(unit);
  const failures = compared.filter((unit) => !ok(unit));
  const needsChecker = failures.filter((unit) => (result.inferred.get(unit)?.unresolved ?? 0) > 0);
  return {
    skipped: result.skipped.size,
    compared: compared.length,
    matched: compared.filter(ok).length,
    explicit: explicit.length,
    explicitMatched: explicit.filter(ok).length,
    failures: failures.sort(),
    needsChecker: needsChecker.length,
    errorsMatched: compared.filter((unit) => !result.errorMismatched.has(unit)).length,
    errorFailures: compared.filter((unit) => result.errorMismatched.has(unit)).sort(),
    explicitFailures: explicit.filter((unit) => !ok(unit)).sort(),
  };
}
