import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { cases, listFiles, materialize } from './parser-cases.mjs';
import { buildEmitDriver, compareEmits, emittable, tsgo } from './emit-cases.mjs';

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
    const units = materialize(sample(), 'tsc-ts-emit-test-').paths.filter((unit) => emittable.test(unit.path));
    const root = dirname(dirname(units[0].path));
    const paths = units.map((unit) => unit.path);
    for (const flags of [
      ['--sourceMap'],
      ['--removeComments'],
      ['--inlineSourceMap', '--inlineSources', '--newLine', 'crlf', '--emitBOM'],
      ['--sourceMap', '--sourceRoot', 'https://example.com/src', '--mapRoot', 'maps'],
    ]) {
      const result = await compareEmits(command, root, paths, flags, 8);
      // Imports of types from other files need the checker to elide.
      assert.ok(result.failures.length <= 4, `emitting with ${flags.join(' ')}: ${result.failures.join(', ')}`);
      assert.ok(result.units - result.unsupported > 400, 'enough units compared');
    }
  },
);
