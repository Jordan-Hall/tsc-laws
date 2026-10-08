// Compares the binder with the reference bind oracle on TypeScript's test cases and the
// bundled libs: symbols, bind diagnostics, symbol tables, the flow graph and name resolution.
//
// Usage: node scripts/bind-corpus.mjs [--native BINARY] [--jobs N] [--limit N] [--verbose] [DIR|FILE ...]
//
// Multi-file test cases are split at `// @filename:` directives and parsed under their own
// names. Without --native, the binder runs under Node from a tsc build. Files whose parse
// tree already differs from tsgo's are counted separately from binder differences.
import { availableParallelism } from 'node:os';
import { join, resolve } from 'node:path';
import { buildBindDriver, compareBinding } from '../tests/binder-cases.mjs';
import { cases, libs, listFiles, materialize } from '../tests/parser-cases.mjs';

const args = process.argv.slice(2);
const option = (name, fallback) => {
  const at = args.indexOf(name);
  return at >= 0 ? args[at + 1] : fallback;
};
const jobs = Number(option('--jobs', Math.min(16, availableParallelism())));
const limit = Number(option('--limit', Infinity));
const verbose = args.includes('--verbose');
const valued = new Set(['--native', '--jobs', '--limit']);
const inputs = args.filter((a, i) => !a.startsWith('--') && !valued.has(args[i - 1]));
if (inputs.length === 0) inputs.push(join(cases, 'compiler'), join(cases, 'conformance'), libs);

const native = option('--native', undefined);
const command = native !== undefined ? [resolve(native)] : buildBindDriver();
const flags = ['--named', '--tables', '--flow', '--resolve'];

const { paths, skipped } = materialize(inputs.flatMap(listFiles), 'tsc-ts-bind-cases-');
const units = paths.slice(0, limit);
if (skipped > 0) console.log(`skipped ${skipped} non-UTF-8 files`);

const binder = [];
const parser = [];
let next = 0;
async function worker() {
  while (next < units.length) {
    const unit = units[next++];
    const result = await compareBinding(command, unit.path, flags);
    if (result.match) continue;
    const label = `${unit.source}${unit.source.endsWith(unit.path.slice(unit.path.lastIndexOf('/'))) ? '' : ' > ' + unit.path}`;
    (result.parserDiffers ? parser : binder).push({ label, result });
  }
}
await Promise.all(Array.from({ length: jobs }, worker));
const matched = units.length - binder.length - parser.length;
console.log(`match: ${matched}/${units.length}`);
console.log(`parse tree differs: ${parser.length}`);
console.log(`binder differs: ${binder.length}`);
for (const { label, result } of binder.slice(0, verbose ? binder.length : 30)) {
  console.log(`  ${label}`);
  if (result.difference !== undefined)
    console.log(
      `    line ${result.difference.line}\n    - ${result.difference.expected}\n    + ${result.difference.actual}`,
    );
  if (result.error) console.log(`    ${result.error.split('\n').slice(0, 4).join('\n    ')}`);
}
process.exitCode = binder.length > 0 ? 1 : 0;
