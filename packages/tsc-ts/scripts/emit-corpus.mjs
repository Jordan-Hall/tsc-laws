// Compares JavaScript emit with tsgo's on TypeScript's test cases, comparing every output file.
// Files are emitted in batches without type checking or resolving other files, targeting
// ESNext, as ES modules, CommonJS or node16/nodenext. Most sets put each file of a test case
// in a directory of its own; the `packages` sets keep a test case's files together at the
// paths it gives them, so package.json `type` and imports between its files apply.
//
// Usage: node scripts/emit-corpus.mjs [--native BINARY] [--jobs N] [--limit N] [--sets A,B] [DIR|FILE ...]
import { writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { cases, listFiles, materialize } from '../tests/parser-cases.mjs';
import { buildEmitDriver, compareEmits, emittable, isCommonJSHang, materializeGrouped } from '../tests/emit-cases.mjs';
import { tempDir } from '../tests/temp.mjs';

const args = process.argv.slice(2);
const option = (name, fallback) => {
  const at = args.indexOf(name);
  return at >= 0 ? args[at + 1] : fallback;
};
const jobs = Number(option('--jobs', 12));
const limit = Number(option('--limit', Infinity));
const sets = option('--sets', undefined);
const valued = new Set(['--native', '--jobs', '--limit', '--sets']);
const inputs = args.filter((a, i) => !a.startsWith('--') && !valued.has(args[i - 1]));
if (inputs.length === 0) inputs.push(join(cases, 'compiler'), join(cases, 'conformance'));

const native = option('--native', undefined);
const command = native !== undefined ? [resolve(native)] : buildEmitDriver();
const testFiles = inputs.flatMap(listFiles);
const { paths } = materialize(testFiles, 'tsc-ts-emit-cases-');
const units = paths.filter((unit) => emittable.test(unit.path)).slice(0, limit);
const unitsRoot = dirname(dirname(units[0].path));
const groupedRoot = tempDir('tsc-ts-emit-packages-');
const groupedUnits = materializeGrouped(testFiles, groupedRoot).slice(0, limit);

// Test cases whose emit depends on what only the checker knows, listed rather than counted.
const checkerDependent = new Map([
  // Type-only-ness of a namespace re-export's members, from the checker's alias links.
  ['conformance/externalModules/typeOnly/exportNamespace8.ts', 'type-only re-export chain'],
  ['conformance/externalModules/typeOnly/importEquals1.ts', 'type-only re-export chain'],
  // The default import of an ES module's `module.exports` export from CommonJS.
  ['conformance/node/esmModuleExports3.ts', 'module.exports export of an ES module'],
]);
const checkerDependentReason = (source) => {
  for (const [name, reason] of checkerDependent) if (source.endsWith('/' + name)) return reason;
  return undefined;
};

let failed = false;
for (const [label, flags] of [
  ['sourceMap', ['--sourceMap']],
  ['removeComments', ['--removeComments']],
  ['inline', ['--inlineSourceMap', '--inlineSources', '--newLine', 'crlf', '--emitBOM']],
  ['roots', ['--sourceMap', '--sourceRoot', 'https://example.com/src', '--mapRoot', 'maps']],
  ['commonjs', ['--module', 'commonjs', '--sourceMap']],
  ['commonjsHelpers', ['--module', 'commonjs', '--importHelpers', '--removeComments']],
  ['node16', ['--module', 'node16']],
  ['nodenext', ['--module', 'nodenext', '--sourceMap']],
  ['preserve', ['--module', 'preserve']],
  ['commonjsPackages', ['--module', 'commonjs']],
  ['node16Packages', ['--module', 'node16']],
  ['nodenextPackages', ['--module', 'nodenext', '--sourceMap']],
]) {
  if (sets !== undefined && !sets.split(',').includes(label)) continue;
  const commonJS = flags.includes('--module');
  const grouped = label.endsWith('Packages');
  const root = grouped ? groupedRoot : unitsRoot;
  const setUnits = (grouped ? groupedUnits : units).filter((u) => !commonJS || !isCommonJSHang(u));
  const result = await compareEmits(
    command,
    root,
    setUnits.map((u) => u.path),
    flags,
    jobs,
  );
  const byUnit = new Map(setUnits.map((u) => [u.path.slice(root.length + 1).split('/')[0], u.source]));
  const failures = result.failures.filter((unit) => checkerDependentReason(byUnit.get(unit)) === undefined);
  const dependent = result.failures.filter((unit) => checkerDependentReason(byUnit.get(unit)) !== undefined);
  const compared = result.units - result.unsupported - dependent.length;
  console.log(
    `${label}: ${compared - failures.length}/${compared} match (${result.unsupported} units use unsupported syntax, ${dependent.length} need the checker)`,
  );
  for (const unit of dependent)
    console.log(`  needs the checker (${checkerDependentReason(byUnit.get(unit))}): ${byUnit.get(unit)}`);
  if (process.env.EMIT_FAILURES !== undefined)
    writeFileSync(process.env.EMIT_FAILURES + '.' + label, failures.map((unit) => byUnit.get(unit)).join('\n') + '\n');
  for (const unit of failures.slice(0, 15)) console.log(`  ${byUnit.get(unit)} > ${join(root, unit)}`);
  if (failures.length > 0) failed = true;
}
process.exitCode = failed ? 1 : 0;
