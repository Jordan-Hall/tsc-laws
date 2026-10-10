import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import { existsSync, readdirSync } from 'node:fs';
import { availableParallelism } from 'node:os';
import { join, resolve } from 'node:path';
import { compiledDir } from './temp.mjs';

const root = resolve(import.meta.dirname, '..');
const repo = resolve(root, '../..');
const oracle = resolve(repo, 'packages/tsgo/dist/scan-oracle');
const cases = resolve(repo, 'upstream/TypeScript/tests/cases');
const libs = resolve(repo, 'upstream/typescript-go/internal/bundled/libs');

// Every 25th test case, plus the fixtures and the bundled libs.
function sample() {
  const files = [];
  const visit = (dir) => {
    for (const entry of readdirSync(dir, { withFileTypes: true }).sort((a, b) => (a.name < b.name ? -1 : 1))) {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) visit(path);
      else if (/\.[cm]?[jt]sx?$/.test(entry.name)) files.push(path);
    }
  };
  visit(join(cases, 'compiler'));
  visit(join(cases, 'conformance'));
  const picked = files.filter((_, i) => i % 25 === 0);
  const fixtures = readdirSync(join(root, 'tests/fixtures')).map((f) => join(root, 'tests/fixtures', f));
  const bundled = readdirSync(libs).map((f) => join(libs, f));
  return [...fixtures, ...bundled, ...picked];
}

const modes = [[], ['--full', '--trivia'], ['--rescan'], ['--jsdoc'], ['--rescan', '--target', '1']];

function run(argv) {
  return new Promise((done) => {
    const child = spawn(argv[0], argv.slice(1), { stdio: ['ignore', 'pipe', 'inherit'] });
    const chunks = [];
    child.stdout.on('data', (d) => chunks.push(d));
    child.on('close', () => done(Buffer.concat(chunks)));
  });
}

test(
  'scanner matches tsgo on test cases and libs',
  { skip: (!existsSync(oracle) || !existsSync(cases)) && 'needs upstream sources and the scan oracle' },
  async () => {
    const out = compiledDir('tsc-ts-scan-');
    execFileSync(
      resolve(repo, 'node_modules/.bin/tsc'),
      [
        '--outDir',
        out,
        '--strict',
        '--target',
        'es2024',
        '--module',
        'nodenext',
        '--moduleResolution',
        'nodenext',
        '--types',
        'node',
        '--skipLibCheck',
        join(root, 'src/drivers/scan.ts'),
      ],
      { stdio: 'inherit' },
    );
    const driver = join(out, 'drivers/scan.js');
    const tasks = [];
    for (const file of sample())
      for (const mode of modes) {
        const flags = file.endsWith('x') && mode[0] === '--rescan' ? [...mode, '--jsx'] : mode;
        tasks.push({ file, flags });
      }
    const failures = [];
    let next = 0;
    const worker = async () => {
      while (next < tasks.length) {
        const { file, flags } = tasks[next++];
        const [expected, actual] = await Promise.all([
          run([oracle, file, ...flags]),
          run([process.execPath, driver, file, ...flags]),
        ]);
        if (!expected.equals(actual)) failures.push(`${file} ${flags.join(' ')}`);
      }
    };
    await Promise.all(Array.from({ length: availableParallelism() }, worker));
    assert.deepEqual(failures, []);
  },
);
