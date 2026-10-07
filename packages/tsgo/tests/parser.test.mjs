import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const oracle = resolve('dist/parse-oracle');
const inputs = [
  'tests/fixtures/tokens.ts',
  'tests/fixtures/syntax-errors.ts',
  ...readdirSync('../tsts/src/checker').map((f) => join('../tsts/src/checker', f)),
  ...readdirSync('src/go').map((f) => join('src/go', f)),
];

test(
  'translated parser matches tsgo trees and diagnostics',
  { skip: !existsSync(oracle) && 'run npm run build:oracle' },
  () => {
    const out = mkdtempSync(join(tmpdir(), 'tsts-parse-'));
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
