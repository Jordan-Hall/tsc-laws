// Compares the parser with the reference encode oracle on TypeScript's test cases and
// the bundled libs: parse diagnostics, the tree dump, and the API's binary encoding.
//
// Usage: node scripts/parse-corpus.mjs [--native BINARY] [--jobs N] [--limit N] [--ignore-hash] [DIR|FILE ...]
//
// Multi-file test cases are split at `// @filename:` directives. Without --native, the
// parser runs under Node from a tsc build.
import { availableParallelism } from 'node:os';
import { join, resolve } from 'node:path';
import { buildDriver, cases, compare, libs, listFiles, materialize } from '../tests/parser-cases.mjs';

const args = process.argv.slice(2);
const option = (name, fallback) => {
  const at = args.indexOf(name);
  return at >= 0 ? args[at + 1] : fallback;
};
const jobs = Number(option('--jobs', availableParallelism()));
const limit = Number(option('--limit', Infinity));
const ignoreHash = args.includes('--ignore-hash');
const valued = new Set(['--native', '--jobs', '--limit']);
const inputs = args.filter((a, i) => !a.startsWith('--') && !valued.has(args[i - 1]));
if (inputs.length === 0) inputs.push(join(cases, 'compiler'), join(cases, 'conformance'), libs);

const native = option('--native', undefined);
const command = native !== undefined ? [resolve(native)] : buildDriver();

const { paths, skipped } = materialize(inputs.flatMap(listFiles));
const units = paths.slice(0, limit);
if (skipped > 0) console.log(`skipped ${skipped} non-UTF-8 files`);

const failures = { diagnostics: [], tree: [], bytes: [] };
let next = 0;
async function worker() {
  while (next < units.length) {
    const unit = units[next++];
    const result = await compare(command, unit.path);
    const label = `${unit.source}${unit.source.endsWith(unit.path.slice(unit.path.lastIndexOf('/'))) ? '' : ' > ' + unit.path}`;
    if (!result.diagnostics) failures.diagnostics.push(label);
    if (!result.tree) failures.tree.push(label);
    if (!(ignoreHash ? result.bytesIgnoringHash : result.bytes)) failures.bytes.push(label);
  }
}
await Promise.all(Array.from({ length: jobs }, worker));
for (const [mode, failed] of Object.entries(failures)) {
  console.log(`${mode}: ${units.length - failed.length}/${units.length} match`);
  for (const file of failed.slice(0, 20)) console.log(`  ${file}`);
}
process.exitCode = Object.values(failures).some((failed) => failed.length > 0) ? 1 : 0;
