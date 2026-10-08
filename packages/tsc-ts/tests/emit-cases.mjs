// Shared by the emit test and scripts/emit-corpus.mjs: builds the emit driver and compares its
// output with tsgo's on batches of files, every output file byte for byte.
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';
import { repo, root, run } from './parser-cases.mjs';
import { tempDir } from './temp.mjs';

export const tsgo = resolve(repo, 'packages/tsgo/dist/tsgo');

/** Options for both compilers: no type checking or module resolution, ECMAScript module output. */
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
  const out = tempDir('tsc-ts-emit-');
  execFileSync(
    resolve(repo, 'node_modules/.bin/tsc'),
    [
      '--outDir',
      out,
      '--strict',
      '--target',
      'es2024',
      '--module',
      'nodenext',
      '--moduleResolution',
      'nodenext',
      '--types',
      'node',
      '--skipLibCheck',
      join(root, 'src/drivers/emit.ts'),
    ],
    { stdio: 'inherit' },
  );
  return [process.execPath, '--stack-size=16000', join(out, 'drivers/emit.js')];
}

export const emittable = /(?<!\.d)\.(?:[cm]?ts|tsx|[cm]?js|jsx)$/;

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
 * batches. Returns `{ compared, unsupported, failures }`: unit directories whose outputs differ.
 */
export async function compareEmits(command, unitsRoot, paths, flags, jobs, batchSize = 150) {
  const dir = tempDir('tsc-ts-emit-out-');
  const failures = new Set();
  const unsupported = new Set();
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
      for (const line of mine.stdout.toString().split('\n')) {
        const match = /^unsupported (.*?): /.exec(line);
        if (match) skipped.add(unitOf(relative(unitsRoot, match[1])));
      }
      for (const path of batch) units.add(unitOf(relative(unitsRoot, path)));
      for (const unit of skipped) unsupported.add(unit);
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
  return { units: units.size, unsupported: unsupported.size, failures: [...failures].sort() };
}
