import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, readdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { tempDir } from './temp.mjs';

const oracle = resolve('dist/scan-oracle');
const inputs = [
  'tests/fixtures/tokens.ts',
  ...readdirSync('../relater/src/checker').map((f) => join('../relater/src/checker', f)),
  ...readdirSync('src/go').map((f) => join('src/go', f)),
];

test(
  'translated scanner matches tsgo token streams',
  { skip: !existsSync(oracle) && 'run npm run build:oracle' },
  () => {
    const out = tempDir('tsc-ts-scan-');
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
        'src/drivers/scan.ts',
      ],
      { stdio: 'inherit' },
    );
    for (const input of inputs) {
      const expected = execFileSync(oracle, [input], { encoding: 'utf8', maxBuffer: 1 << 28 });
      const actual = execFileSync(process.execPath, [join(out, 'drivers/scan.js'), input], {
        encoding: 'utf8',
        maxBuffer: 1 << 28,
      });
      assert.equal(actual, expected, input);
    }
  },
);
