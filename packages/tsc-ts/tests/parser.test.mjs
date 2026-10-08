import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readdirSync } from 'node:fs';
import { availableParallelism } from 'node:os';
import { join } from 'node:path';
import { buildDriver, cases, compare, libs, listFiles, materialize, root } from './parser-cases.mjs';

// Every 25th test case, plus the fixtures and the bundled libs.
function sample() {
  const picked = [...listFiles(join(cases, 'compiler')), ...listFiles(join(cases, 'conformance'))].filter(
    (_, i) => i % 25 === 0,
  );
  const fixtures = readdirSync(join(root, 'tests/fixtures'))
    .map((f) => join(root, 'tests/fixtures', f))
    .filter((f) => /\.(?:[cm]?[jt]sx?|json)$/.test(f));
  return [...fixtures, ...listFiles(libs), ...picked];
}

test(
  'parser matches tsgo on test cases and libs',
  {
    skip:
      (!existsSync(join(root, '../tsgo/dist/encode-oracle')) || !existsSync(cases)) &&
      'needs upstream sources and the encode oracle',
  },
  async () => {
    const command = buildDriver();
    const { paths } = materialize(sample());
    const failures = [];
    let next = 0;
    const worker = async () => {
      while (next < paths.length) {
        const unit = paths[next++];
        const result = await compare(command, unit.path);
        for (const mode of ['diagnostics', 'tree', 'bytes'])
          if (!result[mode]) failures.push(`${mode}: ${unit.source} (${unit.path})`);
      }
    };
    await Promise.all(Array.from({ length: availableParallelism() }, worker));
    assert.deepEqual(failures, []);
  },
);
