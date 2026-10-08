// Compares JavaScript emit with tsgo's on TypeScript's test cases, comparing every output file.
// Each test case unit is emitted on its own (in batches), without type checking or module
// resolution, as ECMAScript modules targeting ESNext.
//
// Usage: node scripts/emit-corpus.mjs [--native BINARY] [--jobs N] [--limit N] [DIR|FILE ...]
import { writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { cases, listFiles, materialize } from '../tests/parser-cases.mjs';
import { buildEmitDriver, compareEmits, emittable } from '../tests/emit-cases.mjs';

const args = process.argv.slice(2);
const option = (name, fallback) => {
  const at = args.indexOf(name);
  return at >= 0 ? args[at + 1] : fallback;
};
const jobs = Number(option('--jobs', 12));
const limit = Number(option('--limit', Infinity));
const valued = new Set(['--native', '--jobs', '--limit']);
const inputs = args.filter((a, i) => !a.startsWith('--') && !valued.has(args[i - 1]));
if (inputs.length === 0) inputs.push(join(cases, 'compiler'), join(cases, 'conformance'));

const native = option('--native', undefined);
const command = native !== undefined ? [resolve(native)] : buildEmitDriver();
const { paths } = materialize(inputs.flatMap(listFiles), 'tsc-ts-emit-cases-');
const units = paths.filter((unit) => emittable.test(unit.path)).slice(0, limit);
const unitsRoot = dirname(dirname(units[0].path));

let failed = false;
for (const [label, flags] of [
  ['sourceMap', ['--sourceMap']],
  ['removeComments', ['--removeComments']],
  ['inline', ['--inlineSourceMap', '--inlineSources', '--newLine', 'crlf', '--emitBOM']],
  ['roots', ['--sourceMap', '--sourceRoot', 'https://example.com/src', '--mapRoot', 'maps']],
]) {
  const result = await compareEmits(
    command,
    unitsRoot,
    units.map((u) => u.path),
    flags,
    jobs,
  );
  const compared = result.units - result.unsupported;
  console.log(
    `${label}: ${compared - result.failures.length}/${compared} match (${result.unsupported} units use unsupported syntax)`,
  );
  const byUnit = new Map(units.map((u) => [u.path.slice(unitsRoot.length + 1).split('/')[0], u.source]));
  if (process.env.EMIT_FAILURES !== undefined)
    writeFileSync(
      process.env.EMIT_FAILURES + '.' + label,
      result.failures.map((unit) => byUnit.get(unit)).join('\n') + '\n',
    );
  for (const unit of result.failures.slice(0, 15)) console.log(`  ${byUnit.get(unit)} > ${join(unitsRoot, unit)}`);
  if (result.failures.length > 0) failed = true;
}
process.exitCode = failed ? 1 : 0;
