// How --checkers spreads work: the order parse threads load files in (libraries first, so a large
// one such as lib.dom.d.ts does not finish last), the estimated cost of checking a file (a small file
// that alone imports a large library is expensive), and the ranges of files checkers take, with
// idle checkers taking the cheap end of another's range.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { compiledDir, tempDir } from './temp.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, '../../..');
const bundledLibs = join(root, 'upstream/typescript-go/internal/bundled/libs');

const out = compiledDir('tsc-ts-parallel-schedule-');
execFileSync(
  join(root, 'node_modules/.bin/tsc'),
  [
    '--outDir',
    out,
    '--rootDir',
    resolve(here, '../src'),
    '--target',
    'es2024',
    '--module',
    'nodenext',
    '--moduleResolution',
    'nodenext',
    '--strict',
    '--skipLibCheck',
    '--types',
    'node',
    resolve(here, '../src/main.ts'),
  ],
  { stdio: 'inherit', cwd: root },
);
const load = (path) => import(pathToFileURL(join(out, path)).href);
const { createNodeSystem } = await load('drivers/node-system.js');
const { executeCommandLine } = await load('compiler/tsc-cli.js');
const { CheckedProgram } = await load('compiler/program-checker.js');
const { ParseQueue } = await load('compiler/parallel-parse.js');
const { checkOrder, newSchedule, planSchedule, takePosition } = await load('compiler/parallel-check.js');

const Root = 0;
const File = 1;
const Library = 2;

test('parse threads get library files first, one per chunk, also libraries queued later', () => {
  const queue = new ParseQueue();
  queue.push(Root, '/p/a.ts', 0);
  queue.push(Root, '/p/b.ts', 0);
  queue.push(Library, 'lib.es5.d.ts', 0);
  queue.push(Library, 'lib.es5.d.ts', 0);
  assert.deepEqual(queue.next(2).names, ['lib.es5.d.ts']);
  queue.push(File, '/p/c.ts', 0);
  queue.push(Library, 'lib.dom.d.ts', 0);
  assert.deepEqual(queue.next(2).names, ['lib.dom.d.ts']);
  assert.equal(queue.queued(), 5);
  assert.equal(queue.left(), 3);
  assert.deepEqual(queue.next(2).names, ['/p/a.ts']);
  assert.deepEqual(queue.next(1).names, ['/p/b.ts', '/p/c.ts']);
  assert.equal(queue.next(1), undefined);
});

function project() {
  const dir = tempDir('tsc-ts-parallel-schedule-project-');
  const files = {
    'tsconfig.json': JSON.stringify({
      compilerOptions: { strict: true, noEmit: true, types: [], skipLibCheck: true, module: 'nodenext' },
      include: ['src'],
    }),
    'node_modules/heavy/package.json': JSON.stringify({ name: 'heavy', types: 'index.d.ts' }),
    'node_modules/heavy/index.d.ts': "export * from './more';\n" + 'export declare const a0: number;\n'.repeat(500),
    'node_modules/heavy/more.d.ts': 'export declare const b0: string;\n'.repeat(500),
    'src/adapter.ts': "import { a0 } from 'heavy';\nexport const x = a0;\n",
    'src/big.ts': 'export const big = 1;\n'.repeat(200),
    'src/small.ts': 'export const small = 1;\n',
  };
  for (const [name, text] of Object.entries(files)) {
    mkdirSync(dirname(join(dir, name)), { recursive: true });
    writeFileSync(join(dir, name), text);
  }
  return dir;
}

function checked() {
  const work = executeCommandLine(createNodeSystem(bundledLibs, ''), ['-p', project()]);
  assert.equal(work.kind, 'compile');
  return new CheckedProgram(work.program);
}

const baseName = (program, i) => program.getSourceFiles()[i].fileName.split('/').pop();

test('a small file that alone imports a large library is checked before larger files', () => {
  const c = checked();
  assert.deepEqual(
    checkOrder(c).map((i) => baseName(c.program, i)),
    ['adapter.ts', 'big.ts', 'small.ts'],
  );
});

test('checkers take every file once: the costliest first, then their ranges, then the end of others', () => {
  const c = checked();
  const buffer = newSchedule(2);
  const schedule = new Int32Array(buffer);
  const order = planSchedule(c, schedule, 2);
  assert.equal(order.length, 3);
  // Checker 1 takes the two costliest files from the shared queue, then the whole range of checker 0.
  const taken = [];
  for (let k; (k = takePosition(schedule, order.length, 1)) >= 0;) taken.push(baseName(c.program, order[k]));
  assert.deepEqual(taken.slice(0, 2), ['adapter.ts', 'big.ts']);
  assert.deepEqual(taken.sort(), ['adapter.ts', 'big.ts', 'small.ts']);
  assert.equal(takePosition(schedule, order.length, 0), -1);
});

test('an idle checker takes the back half of the largest remaining range', () => {
  const schedule = new Int32Array(newSchedule(2));
  schedule[2] = 0; // no shared prefix
  schedule[3] = 2;
  // Checker 0 owns positions 0..9, checker 1 none.
  schedule[4] = 0;
  schedule[5] = 10;
  schedule[6] = 10;
  schedule[7] = 10;
  assert.equal(takePosition(schedule, 10, 0), 0);
  assert.equal(takePosition(schedule, 10, 1), 5);
  assert.deepEqual([...schedule.slice(4, 8)], [1, 5, 6, 10]);
});
