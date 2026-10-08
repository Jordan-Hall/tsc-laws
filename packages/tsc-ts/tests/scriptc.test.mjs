// Builds programs with scriptc using tsc-ts as its type checker, and checks
// they behave like programs built with the tsc scriptc ships.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import {
  chmodSync,
  copyFileSync,
  cpSync,
  existsSync,
  mkdirSync,
  readdirSync,
  realpathSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { join, resolve } from 'node:path';
import test from 'node:test';
import { scriptcDist, tscTs, tscTsMissing } from './toolchain.mjs';
import { tempDir } from './temp.mjs';

const bundled = scriptcDist ?? '';
const skip = !existsSync(bundled) ? 'needs the scriptc toolchain' : tscTsMissing;

// A copy of the scriptc toolchain whose bundled tsc runs tsc-ts.
function toolchain() {
  const source = realpathSync(bundled);
  const root = tempDir('tsc-ts-scriptc-');
  mkdirSync(join(root, 'bin'));
  for (const name of readdirSync(join(source, 'bin'))) copyFileSync(join(source, 'bin', name), join(root, 'bin', name));
  chmodSync(join(root, 'bin/scriptc'), 0o755);
  const link = (from, to, skipName) => {
    mkdirSync(to, { recursive: true });
    for (const name of readdirSync(from)) if (name !== skipName) symlinkSync(join(from, name), join(to, name));
  };
  link(join(source, 'lib'), join(root, 'lib'), 'typescript');
  link(join(source, 'lib/typescript'), join(root, 'lib/typescript'), 'lib');
  const lib = join(root, 'lib/typescript/lib');
  link(join(source, 'lib/typescript/lib'), lib, 'tsc');
  writeFileSync(
    join(lib, 'tsc'),
    `#!/bin/sh\nTSC_TS_LIB_DIR="${lib}" exec ${tscTs.map((arg) => `"${arg}"`).join(' ')} "$@"\n`,
  );
  chmodSync(join(lib, 'tsc'), 0o755);
  return join(root, 'bin/scriptc');
}

function build(scriptc, dir, entry) {
  const out = join(dir, 'out');
  const result = spawnSync(scriptc, ['build', entry, '-o', out], { cwd: dir, encoding: 'utf8' });
  const run = result.status === 0 ? spawnSync(out, [], { cwd: dir, encoding: 'utf8' }) : undefined;
  return {
    status: result.status,
    // Build output names the temporary directory.
    output: (result.stdout + result.stderr).replaceAll(dir, '<dir>'),
    run: run && { status: run.status, stdout: run.stdout, stderr: run.stderr },
  };
}

const programs = [
  ['classes.ts', 'classes.ts'],
  ['generics.ts', 'generics.ts'],
  ['modules', 'main.ts'],
  ['type-error.ts', 'type-error.ts'],
];

test('scriptc builds the same programs with tsc-ts', { skip, timeout: 900_000 }, () => {
  const ours = toolchain();
  const theirs = resolve('../../node_modules/.bin/scriptc');
  const seconds = [0, 0];
  for (const [fixture, entry] of programs) {
    const results = [];
    for (const [i, scriptc] of [theirs, ours].entries()) {
      const dir = tempDir('tsc-ts-program-');
      cpSync(resolve('tests/fixtures/programs', fixture), fixture.endsWith('.ts') ? join(dir, fixture) : dir, {
        recursive: true,
      });
      const start = performance.now();
      results.push(build(scriptc, dir, entry));
      seconds[i] += (performance.now() - start) / 1000;
    }
    assert.deepEqual(results[1], results[0], fixture);
    if (fixture !== 'type-error.ts') assert.equal(results[0].run?.status, 0, `${fixture}: ${results[0].output}`);
  }
  console.log(`builds and runs: ${seconds[0].toFixed(1)} s with tsc, ${seconds[1].toFixed(1)} s with tsc-ts`);
});
