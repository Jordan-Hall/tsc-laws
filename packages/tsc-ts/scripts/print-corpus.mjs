// Compares the printer with the reference print oracle on TypeScript's test cases and the
// bundled libs, with comments kept and removed.
//
// Usage: node scripts/print-corpus.mjs [--native BINARY] [--jobs N] [--limit N] [DIR|FILE ...]
import { resolve } from 'node:path';
import { cases, libs, listFiles, materialize } from '../tests/parser-cases.mjs';
import { buildPrintDriver, comparePrints } from '../tests/printer-cases.mjs';
import { join } from 'node:path';

const args = process.argv.slice(2);
const option = (name, fallback) => {
  const at = args.indexOf(name);
  return at >= 0 ? args[at + 1] : fallback;
};
const jobs = Number(option('--jobs', 12));
const limit = Number(option('--limit', Infinity));
const valued = new Set(['--native', '--jobs', '--limit']);
const inputs = args.filter((a, i) => !a.startsWith('--') && !valued.has(args[i - 1]));
if (inputs.length === 0) inputs.push(join(cases, 'compiler'), join(cases, 'conformance'), libs);

const native = option('--native', undefined);
const command = native !== undefined ? [resolve(native)] : buildPrintDriver();
const { paths, skipped } = materialize(inputs.flatMap(listFiles), 'tsc-ts-print-cases-');
const units = paths.slice(0, limit);
if (skipped > 0) console.log(`skipped ${skipped} non-UTF-8 files`);

let failed = false;
for (const [label, flags] of [
  ['comments', []],
  ['removeComments', ['--remove-comments']],
  ['sourceMap', ['--sourcemap']],
]) {
  const failures = await comparePrints(
    command,
    units.map((u) => u.path),
    flags,
    jobs,
  );
  console.log(`${label}: ${units.length - failures.length}/${units.length} match`);
  for (const i of failures.slice(0, 20)) console.log(`  ${units[i].source} > ${units[i].path}`);
  if (failures.length > 0) failed = true;
}
process.exitCode = failed ? 1 : 0;
