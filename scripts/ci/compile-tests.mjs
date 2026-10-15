// Compiles every tsc-ts source file once, with the options the tests compile with (packages/tsc-ts/tests/temp.mjs),
// into the given directory. Tests copy it instead of compiling when TSC_TS_TEST_BUILD names it.
//
// Usage: node scripts/ci/compile-tests.mjs <directory>
import { execFileSync } from 'node:child_process';
import { readdirSync, rmSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { compileOptions } from '../../packages/tsc-ts/tests/temp.mjs';
import { root } from './units.mjs';

const out = resolve(process.argv[2]);
const src = join(root, 'packages/tsc-ts/src');
const sources = [];
const walk = (dir) => {
  for (const name of readdirSync(dir)) {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) walk(path);
    else if (name.endsWith('.ts')) sources.push(path);
  }
};
walk(src);
rmSync(out, { recursive: true, force: true });
execFileSync(join(root, 'node_modules/.bin/tsc'), [...compileOptions, '--outDir', out, '--rootDir', src, ...sources], {
  stdio: 'inherit',
  cwd: root,
});
console.log(`compiled ${sources.length} files into ${out}`);
