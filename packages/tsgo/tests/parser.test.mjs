import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, readdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { tempDir } from './temp.mjs';

const oracle = resolve('dist/parse-oracle');
const inputs = [
  'tests/fixtures/tokens.ts',
  'tests/fixtures/syntax-errors.ts',
  ...readdirSync('../relater/src/checker').map((f) => join('../relater/src/checker', f)),
  ...readdirSync('src/go').map((f) => join('src/go', f)),
];

test(
  'translated parser matches tsgo trees and diagnostics',
  { skip: !existsSync(oracle) && 'run npm run build:oracle' },
  () => {
    const out = tempDir('tsc-ts-parse-');
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
        'src/drivers/parse.ts',
      ],
      { stdio: 'inherit' },
    );
    for (const input of inputs) {
      const expected = execFileSync(oracle, [input], { encoding: 'utf8', maxBuffer: 1 << 28 });
      const actual = execFileSync(process.execPath, [join(out, 'drivers/parse.js'), input], {
        encoding: 'utf8',
        maxBuffer: 1 << 28,
      });
      assert.equal(actual, expected, input);
    }
  },
);
