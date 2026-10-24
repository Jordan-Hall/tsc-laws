// Shared by the emit test and scripts/emit-corpus.mjs: builds the emit driver and compares every
// output file with tsgo's on batches of files.

import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join, normalize, relative, resolve } from 'node:path';
import { repo, run } from './parser-cases.mjs';
import { compileSources, nativeExe, tempDir } from './temp.mjs';

export const tsgo = nativeExe(resolve(repo, 'packages/tsgo/dist/tsgo'));

/** Options for both compilers: no type checking or loading of other files, ECMAScript module output. */
export const baseFlags = [
  '--ignoreConfig',
  '--noCheck',
  '--noResolve',
  '--noLib',
  '--allowJs',
  '--target',
  'esnext',
  '--module',
  'esnext',
  '--jsx',
  'preserve',
];

export function buildEmitDriver() {
  const out = compileSources('tsc-ts-emit-', ['drivers/emit.ts']);
  return [process.execPath, '--stack-size=16000', join(out, 'drivers/emit.js')];
}

export const emittable = /(?<!\.d)\.(?:[cm]?ts|tsx|[cm]?js|jsx)$/;

/** Test cases tsgo doesn't finish emitting as CommonJS. */
const commonJSHangs = ['conformance/salsa/importingExportingTypes.ts'];

/** Whether tsgo doesn't finish emitting the test case of a unit as CommonJS. */
export const isCommonJSHang = (unit) => commonJSHangs.some((name) => unit.source.endsWith('/' + name));

const directive = /^\/\/\s*@(\w+)\s*:\s*([^\r\n]*)/;

/**
 * Writes each test case into its own directory with the paths its `// @filename:` directives
 * give, so package.json files apply and imports between its files resolve. Returns
 * `[{ source, path }]` for its files outside node_modules that emit JavaScript.
 */
export function materializeGrouped(files, dir) {
  const paths = [];
  for (const [index, file] of files.entries()) {
    let text;
    try {
      text = new TextDecoder('utf-8', { fatal: true }).decode(readFileSync(file));
    } catch {
      continue;
    }
    const caseDir = join(dir, String(index));
    const units = [];
    let name = undefined;
    let content = [];
    const flush = () => {
      const body = content.join('\n');
      if (name !== undefined) units.push({ name, text: body });
      else if (body.trim() !== '') units.push({ name: file.split('/').at(-1), text: body });
      content = [];
    };
    for (const line of text.split('\n')) {
      const match = directive.exec(line);
      if (match) {
        if (match[1].toLowerCase() === 'filename') {
          flush();
          name = match[2].trim().replaceAll('\\', '/');
        }
        continue;
      }
      content.push(line);
    }
    flush();
    for (const unit of units) {
      const relativePath = normalize(unit.name.replace(/^[a-zA-Z]:/, '').replace(/^\/+/, '')).replace(/^(\.\.\/)+/, '');
      const path = join(caseDir, relativePath);
      mkdirSync(dirname(path), { recursive: true });
      writeFileSync(path, unit.text);
      if (emittable.test(path) && !relativePath.split('/').includes('node_modules')) paths.push({ source: file, path });
    }
  }
  return paths;
}

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

/** The unit directory (first path segment) of an output path. */
const unitOf = (path) => path.split('/')[0];

/**
 * Emits `paths` (each in its own unit directory under `unitsRoot`) with tsgo and `command` in
 * batches. Returns `{ units, unsupported, crashes, failures }`: counts of units and of units using
 * unsupported syntax, and the unit directories tsgo crashes on or whose outputs differ.
 */
export async function compareEmits(command, unitsRoot, paths, flags, jobs, batchSize = 150) {
  const dir = tempDir('tsc-ts-emit-out-');
  const failures = new Set();
  const unsupported = new Set();
  const crashes = new Set();
  const units = new Set();
  const batches = [];
  for (let start = 0; start < paths.length; start += batchSize) batches.push(paths.slice(start, start + batchSize));
  let next = 0;
  const worker = async () => {
    while (next < batches.length) {
      const index = next++;
      const batch = batches[index];
      const expected = join(dir, String(index), 'expected');
      const actual = join(dir, String(index), 'actual');
      const args = [...baseFlags, ...flags, '--rootDir', unitsRoot];
      const [theirs, mine] = await Promise.all([
        run([tsgo, ...args, '--outDir', expected, ...batch]),
        run([...command, ...args, '--outDir', actual, ...batch]),
      ]);
      console.log(
        index,
        theirs.code,
        mine.code,
        theirs.stdout
          .toString()
          .split('\n')
          .filter((l) => !l.includes('TS2318'))
          .slice(0, 8)
          .join('\n'),
      );
      const skipped = new Set();
      let mineOutput = mine.stdout.toString();
      // tsgo panics on some files, leaving the batch's output incomplete, and tsc-ts throws on
      // them as tsgo does: emit the batch's units one by one with both.
      if (theirs.stderr.includes('panic:')) {
        const byUnit = Map.groupBy(batch, (path) => unitOf(relative(unitsRoot, path)));
        for (const [unit, unitPaths] of byUnit) {
          const [alone, mineAlone] = await Promise.all([
            run([tsgo, ...args, '--outDir', expected, ...unitPaths]),
            mine.code !== 0 ? run([...command, ...args, '--outDir', actual, ...unitPaths]) : undefined,
          ]);
          if (mineAlone !== undefined) mineOutput += mineAlone.stdout.toString();
          if (alone.stderr.includes('panic:')) {
            crashes.add(unit);
            skipped.add(unit);
          }
        }
      }
      for (const line of mineOutput.split('\n')) {
        const match = /^unsupported (.*?): /.exec(line);
        if (match) skipped.add(unitOf(relative(unitsRoot, match[1])));
      }
      for (const path of batch) units.add(unitOf(relative(unitsRoot, path)));
      for (const unit of skipped) if (!crashes.has(unit)) unsupported.add(unit);
      const expectedFiles = listOutputs(expected);
      const actualFiles = listOutputs(actual);
      const all = new Set([...expectedFiles, ...actualFiles]);
      for (const file of all) {
        const unit = unitOf(file);
        if (skipped.has(unit)) continue;
        const a = join(expected, file);
        const b = join(actual, file);
        if (!existsSync(a) || !existsSync(b) || !readFileSync(a).equals(readFileSync(b))) {
          failures.add(unit);
        }
      }
    }
  };
  await Promise.all(Array.from({ length: jobs }, worker));
  return {
    units: units.size,
    unsupported: unsupported.size,
    crashes: [...crashes].sort(),
    failures: [...failures].sort(),
  };
}
