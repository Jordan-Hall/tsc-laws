// Compares declaration emit with tsgo's on TypeScript's test cases: every `.d.ts` and `.d.ts.map` file
// and the declaration errors. Units are emitted in batches without type checking
// or module resolution, as ECMAScript modules targeting ESNext.
//
// Reports, per option set, the match rate overall and on units whose declarations all have
// explicit types, and how many mismatched units have types that need checker inference.
//
// Usage: node scripts/declaration-corpus.mjs [--native BINARY] [--jobs N] [--limit N] [--only NAME] [DIR|FILE ...]
import { writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { cases, listFiles, materialize } from '../tests/parser-cases.mjs';
import { buildEmitDriver, emittable } from '../tests/emit-cases.mjs';
import { compareDeclarations, declarationFlagSets, summarize } from '../tests/declaration-cases.mjs';

const args = process.argv.slice(2);
const option = (name, fallback) => {
  const at = args.indexOf(name);
  return at >= 0 ? args[at + 1] : fallback;
};
const jobs = Number(option('--jobs', 12));
const limit = Number(option('--limit', Infinity));
const only = option('--only', undefined);
const valued = new Set(['--native', '--jobs', '--limit', '--only']);
const inputs = args.filter((a, i) => !a.startsWith('--') && !valued.has(args[i - 1]));
if (inputs.length === 0) inputs.push(join(cases, 'compiler'), join(cases, 'conformance'));

const native = option('--native', undefined);
const command = native !== undefined ? [resolve(native)] : buildEmitDriver();
const { paths } = materialize(inputs.flatMap(listFiles), 'tsc-ts-declaration-cases-');
const units = paths.filter((unit) => emittable.test(unit.path)).slice(0, limit);
const unitsRoot = dirname(dirname(units[0].path));
const byUnit = new Map(units.map((u) => [u.path.slice(unitsRoot.length + 1).split('/')[0], u.source]));
const percent = (a, b) => (b === 0 ? '-' : ((100 * a) / b).toFixed(1) + '%');

let failed = false;
for (const [label, flags] of declarationFlagSets) {
  if (only !== undefined && only !== label) continue;
  const result = await compareDeclarations(
    command,
    unitsRoot,
    units.map((u) => u.path),
    flags,
    jobs,
  );
  const s = summarize(result);
  console.log(
    `${label}: ${s.matched}/${s.compared} match (${percent(s.matched, s.compared)}); ` +
      `explicit types ${s.explicitMatched}/${s.explicit} (${percent(s.explicitMatched, s.explicit)}); ` +
      `${s.needsChecker}/${s.failures.length} mismatches need the checker; ` +
      `declaration errors match in ${s.errorsMatched}/${s.compared}; ${s.skipped} units skipped (tsgo crashes)`,
  );
  if (process.env.DECLARATION_FAILURES !== undefined) {
    writeFileSync(
      `${process.env.DECLARATION_FAILURES}.${label}`,
      s.failures.map((u) => byUnit.get(u)).join('\n') + '\n',
    );
    writeFileSync(
      `${process.env.DECLARATION_FAILURES}.${label}.explicit`,
      s.explicitFailures.map((u) => `${byUnit.get(u)} > ${join(unitsRoot, u)}`).join('\n') + '\n',
    );
    writeFileSync(
      `${process.env.DECLARATION_FAILURES}.${label}.errors`,
      s.errorFailures.map((u) => `${byUnit.get(u)} > ${join(unitsRoot, u)}`).join('\n') + '\n',
    );
  }
  for (const unit of s.explicitFailures.slice(0, 15)) console.log(`  ${byUnit.get(unit)} > ${join(unitsRoot, unit)}`);
  if (s.explicitFailures.length > 0) failed = true;
}
process.exitCode = failed ? 1 : 0;
