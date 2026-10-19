// tsc-ts/api compiled with scriptc: tests/native/api-probe.ts, built natively with the installed scriptc and with
// tsc for Node, prints the same answers for the library fixture project (files, diagnostics, and the symbols, types
// and signatures at every node). api-library.test.mjs compares the Node build's answers with tsc --api's.
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { cpSync, existsSync, realpathSync } from 'node:fs';
import { join, resolve } from 'node:path';
import test from 'node:test';
import { compileOptions, compiledDir, tempDir } from './temp.mjs';
import { typescriptLib } from './toolchain.mjs';

const root = resolve(import.meta.dirname, '..');
const repo = resolve(root, '../..');
const scriptc = join(repo, 'node_modules/.bin/scriptc');
const lib = typescriptLib !== undefined && existsSync(typescriptLib) ? realpathSync(typescriptLib) : '';
const skip = (!existsSync(scriptc) || lib === '') && 'needs the scriptc toolchain';
const probe = 'tests/native/api-probe.ts';

function answers(command, config) {
  const result = spawnSync(command[0], [...command.slice(1), config, lib], { encoding: 'utf8', maxBuffer: 1 << 28 });
  assert.equal(result.status, 0, result.stderr);
  return result.stdout.split('\n');
}

test('a native build of tsc-ts/api answers as the Node build', { skip, timeout: 900_000 }, () => {
  const dir = tempDir('tsc-ts-api-native-');
  cpSync(join(root, 'tests/fixtures/library'), dir, { recursive: true });
  const config = join(dir, 'tsconfig.json');

  const node = compiledDir('tsc-ts-api-probe-');
  execFileSync(join(repo, 'node_modules/.bin/tsc'), [...compileOptions, '--outDir', node, '--rootDir', root, probe], {
    cwd: root,
    stdio: 'inherit',
  });
  const expected = answers([process.execPath, '--stack-size=16000', join(node, probe.replace(/\.ts$/, '.js'))], config);

  const native = join(tempDir('tsc-ts-api-native-build-'), 'api-probe');
  const build = spawnSync(scriptc, ['build', probe, '--optimization=dev', '-o', native], {
    cwd: root,
    encoding: 'utf8',
  });
  assert.ok(build.status === 0 && existsSync(native), build.stdout + build.stderr);
  const actual = answers([native], config);

  assert.ok(expected.length > 4000, `${expected.length} answers`);
  const first = expected.findIndex((line, i) => line !== actual[i]);
  assert.equal(
    first === -1 && actual.length === expected.length,
    true,
    `first difference at line ${first + 1}:
  node:   ${expected[first]}
  native: ${actual[first]}`,
  );
});
