import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { cpSync, existsSync, mkdtempSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative, resolve } from 'node:path';
import test from 'node:test';

const tsgo = resolve('dist/tsgo');
const project = resolve('tests/fixtures/tsc-project');
const libs = resolve('../../upstream/typescript-go/internal/bundled/libs');

// Every file under dir, keyed by relative path.
const files = (dir, root = dir, out = {}) => {
  if (!existsSync(dir)) return out;
  for (const name of readdirSync(dir)) {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) files(path, root, out);
    else out[relative(root, path)] = readFileSync(path, 'utf8');
  }
  return out;
};

const run = (command, args) => {
  const cwd = mkdtempSync(join(tmpdir(), 'tsc-ts-tsc-'));
  cpSync(project, cwd, { recursive: true });
  const result = spawnSync(command[0], [...command.slice(1), ...args], {
    cwd,
    encoding: 'utf8',
    env: { ...process.env, TSC_TS_LIB_DIR: libs },
  });
  return { status: result.status, stdout: result.stdout, stderr: result.stderr, emitted: files(join(cwd, 'dist')) };
};

test(
  'translated tsc matches tsgo on a project',
  { skip: !existsSync(tsgo) && 'run npm run build:oracle', timeout: 600_000 },
  () => {
    const out = mkdtempSync(join(tmpdir(), 'tsc-ts-tsc-build-'));
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
        'src/drivers/tsc.ts',
      ],
      { stdio: 'inherit' },
    );
    const translated = [process.execPath, '--stack-size=16000', join(out, 'drivers/tsc.js')];
    for (const args of [
      ['-p', '.'],
      ['-p', '.', '--noEmit'],
      ['-p', '.', '--strict', 'false'],
    ]) {
      const expected = run([tsgo], args);
      const actual = run(translated, args);
      assert.equal(actual.stderr, '', args.join(' '));
      assert.equal(actual.stdout, expected.stdout, args.join(' '));
      assert.equal(actual.status, expected.status, args.join(' '));
      assert.deepEqual(actual.emitted, expected.emitted, args.join(' '));
    }
  },
);
