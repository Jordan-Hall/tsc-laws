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
  mkdtempSync,
  readdirSync,
  realpathSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import test from 'node:test';
import { scriptcDist } from './toolchain.mjs';

const bundled = scriptcDist ?? '';
const main = resolve('dist/tsc-ts/src/main.js');
const skip = !existsSync(bundled) ? 'needs the scriptc toolchain' : !existsSync(main) ? 'run npm run build' : false;

// A copy of the scriptc toolchain whose bundled tsc runs tsc-ts.
function toolchain() {
  const source = realpathSync(bundled);
  const root = mkdtempSync(join(tmpdir(), 'tsc-ts-scriptc-'));
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
    `#!/bin/sh\nTSC_TS_LIB_DIR="${lib}" exec "${process.execPath}" --stack-size=16000 "${main}" "$@"\n`,
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
  for (const [fixture, entry] of programs) {
    const results = [];
    for (const scriptc of [theirs, ours]) {
      const dir = mkdtempSync(join(tmpdir(), 'tsc-ts-program-'));
      cpSync(resolve('tests/fixtures/programs', fixture), fixture.endsWith('.ts') ? join(dir, fixture) : dir, {
        recursive: true,
      });
      results.push(build(scriptc, dir, entry));
    }
    assert.deepEqual(results[1], results[0], fixture);
    if (fixture !== 'type-error.ts') assert.equal(results[0].run?.status, 0, `${fixture}: ${results[0].output}`);
  }
});
