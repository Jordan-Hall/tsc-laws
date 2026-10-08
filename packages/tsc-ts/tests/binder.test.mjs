import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readdirSync } from 'node:fs';
import { availableParallelism } from 'node:os';
import { join } from 'node:path';
import { bindOracle, buildBindDriver, compareBinding } from './binder-cases.mjs';
import { cases, libs, listFiles, materialize, root } from './parser-cases.mjs';

// The fixtures, the bundled libs, and every 25th test case.
function sample() {
  const picked = [...listFiles(join(cases, 'compiler')), ...listFiles(join(cases, 'conformance'))].filter(
    (_, i) => i % 25 === 0,
  );
  const fixtures = readdirSync(join(root, 'tests/fixtures'))
    .filter((f) => /\.[cm]?[jt]sx?$/.test(f))
    .map((f) => join(root, 'tests/fixtures', f));
  const bundled = readdirSync(libs).map((f) => join(libs, f));
  return [...fixtures, ...bundled, ...picked];
}

test(
  'binder matches tsgo on test cases and libs',
  {
    skip: (!existsSync(bindOracle) || !existsSync(cases)) && 'needs upstream sources and the bind oracle',
    timeout: 900_000,
  },
  async () => {
    const command = buildBindDriver();
    const { paths } = materialize(sample(), 'tsc-ts-bind-test-');
    const tasks = [];
    for (const unit of paths) {
      tasks.push({ path: unit.path, flags: [] });
      tasks.push({ path: unit.path, flags: ['--named', '--tables', '--flow', '--resolve'] });
    }
    const failures = [];
    let next = 0;
    const worker = async () => {
      while (next < tasks.length) {
        const { path, flags } = tasks[next++];
        const result = await compareBinding(command, path, flags);
        if (!result.match)
          failures.push(`${path} ${flags.join(' ')}: ${JSON.stringify(result.difference ?? result.error)}`);
      }
    };
    await Promise.all(Array.from({ length: Math.min(16, availableParallelism()) }, worker));
    assert.deepEqual(failures.slice(0, 10), []);
  },
);
