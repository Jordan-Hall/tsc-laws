import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, readdirSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { tempDir } from './temp.mjs';

const oracle = resolve('dist/check-oracle');
const libs = resolve('../../upstream/typescript-go/internal/bundled/libs');
const cases = resolve('../../upstream/TypeScript/tests/cases/compiler');

// Every 25th compiler test case, when the TypeScript test cases are present.
const sample = existsSync(cases)
  ? readdirSync(cases)
      .filter((f) => f.endsWith('.ts'))
      .sort()
      .filter((_, i) => i % 25 === 0)
      .map((f) => join(cases, f))
  : [];
const inputs = [resolve('tests/fixtures/check-basic.ts'), ...sample];

test(
  'translated checker matches tsgo diagnostics',
  { skip: !existsSync(oracle) && 'run npm run build:oracle', timeout: 1_800_000 },
  () => {
    const out = tempDir('tsc-ts-check-');
    execFileSync(
      resolve('../../node_modules/.bin/tsc'),
      [
        '--outDir',
        out,
        '--target',
        'es2024',
        '--module',
        'nodenext',
        '--moduleResolution',
        'nodenext',
        '--skipLibCheck',
        '--types',
        'node',
        'src/drivers/check.ts',
      ],
      { stdio: 'inherit' },
    );
    const list = join(out, 'inputs.txt');
    writeFileSync(list, inputs.join('\n') + '\n');
    const expected = execFileSync(oracle, [list, libs, '--batch'], { encoding: 'utf8', maxBuffer: 1 << 28 });
    const actual = execFileSync(
      process.execPath,
      ['--stack-size=16000', join(out, 'drivers/check.js'), list, libs, '--batch'],
      {
        encoding: 'utf8',
        maxBuffer: 1 << 28,
      },
    );
    assert.equal(actual, expected);
  },
);
