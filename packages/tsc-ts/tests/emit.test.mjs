import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { cases, listFiles, materialize } from './parser-cases.mjs';
import { buildEmitDriver, compareEmits, emittable, isCommonJSHang, materializeGrouped, tsgo } from './emit-cases.mjs';
import { tempDir } from './temp.mjs';

// Every 25th test case.
function sample() {
  return [...listFiles(join(cases, 'compiler')), ...listFiles(join(cases, 'conformance'))].filter(
    (_, i) => i % 25 === 0,
  );
}

test(
  'emit matches tsgo on test cases',
  { skip: (!existsSync(tsgo) || !existsSync(cases)) && 'needs upstream sources and tsgo' },
  async () => {
    const command = buildEmitDriver();
    const units = materialize(sample(), 'tsc-ts-emit-test-').paths.filter(
      (unit) => emittable.test(unit.path) && !isCommonJSHang(unit),
    );
    const root = dirname(dirname(units[0].path));
    const paths = units.map((unit) => unit.path);
    for (const flags of [
      ['--sourceMap'],
      ['--removeComments'],
      ['--inlineSourceMap', '--inlineSources', '--newLine', 'crlf', '--emitBOM'],
      ['--sourceMap', '--sourceRoot', 'https://example.com/src', '--mapRoot', 'maps'],
      ['--module', 'commonjs', '--sourceMap'],
      ['--module', 'commonjs', '--importHelpers'],
      ['--module', 'nodenext'],
      ['--target', 'es2015'],
      ['--target', 'es2020', '--sourceMap'],
      ['--target', 'es2022', '--useDefineForClassFields', 'false'],
      ['--jsx', 'react'],
      ['--jsx', 'react-jsx', '--module', 'commonjs'],
      ['--experimentalDecorators', '--emitDecoratorMetadata', '--module', 'commonjs', '--sourceMap'],
    ]) {
      const result = await compareEmits(command, root, paths, flags, 8);
      assert.deepEqual(result.failures, [], `emitting with ${flags.join(' ')}`);
      assert.ok(result.units - result.unsupported > 400, 'enough units compared');
    }
  },
);

test(
  'emit matches tsgo on test cases laid out as packages',
  { skip: (!existsSync(tsgo) || !existsSync(cases)) && 'needs upstream sources and tsgo' },
  async () => {
    const command = buildEmitDriver();
    const dir = tempDir('tsc-ts-emit-packages-test-');
    const units = materializeGrouped(sample(), dir).filter((unit) => !isCommonJSHang(unit));
    for (const flags of [
      ['--module', 'commonjs'],
      ['--module', 'node16'],
    ]) {
      const result = await compareEmits(
        command,
        dir,
        units.map((unit) => unit.path),
        flags,
        8,
      );
      assert.deepEqual(result.failures, [], `emitting with ${flags.join(' ')}`);
      assert.ok(result.units > 400, 'enough units compared');
    }
  },
);
