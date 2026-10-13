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
const {
  autoCheckers,
  checkOrder,
  checkersFittingMemory,
  fillScheduleCosts,
  newSchedule,
  planSchedule,
  scheduleOf,
  takePosition,
} = await load('compiler/parallel-check.js');

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
  const plan = planSchedule(c, 2);
  const schedule = new Int32Array(scheduleOf(plan, 2));
  const order = plan.order;
  assert.equal(order.length, 3);
  // Checker 1 takes the two costliest files from the shared queue, then the whole range of checker 0.
  const taken = [];
  for (let k; (k = takePosition(schedule, order.length, 1)) >= 0;) taken.push(baseName(c.program, order[k]));
  assert.deepEqual(taken.slice(0, 2), ['adapter.ts', 'big.ts']);
  assert.deepEqual(taken.sort(), ['adapter.ts', 'big.ts', 'small.ts']);
  assert.equal(takePosition(schedule, order.length, 0), -1);
});

// The ranges start after the 8 header entries of the schedule.
const ranges = 8;

function ownRanges(schedule, ...bounds) {
  schedule[2] = 0; // no shared prefix
  for (let k = 0; k < bounds.length; k++) schedule[ranges + k] = bounds[k];
}

test('without costs, an idle checker takes the back half of the largest remaining range', () => {
  const schedule = new Int32Array(newSchedule(2));
  // Checker 0 owns positions 0..9, checker 1 none.
  ownRanges(schedule, 0, 10, 10, 10);
  assert.equal(takePosition(schedule, 10, 0), 0);
  assert.equal(takePosition(schedule, 10, 1), 5);
  assert.deepEqual(Array.from(schedule.slice(ranges, ranges + 4)), [1, 5, 6, 10]);
});

test('an idle checker takes the end of a range that makes both finish earliest', () => {
  // Ten files of cost 10 without libraries: checker 1 takes the last four of the nine checker 0 has
  // left (the first larger end that does not make it finish later).
  const schedule = new Int32Array(newSchedule(2, 10, 0, 0));
  fillScheduleCosts(schedule, Array(10).fill(10), Array(10).fill([]), []);
  ownRanges(schedule, 0, 10, 10, 10);
  assert.equal(takePosition(schedule, 10, 0), 0);
  assert.equal(takePosition(schedule, 10, 1), 6);
  assert.deepEqual(Array.from(schedule.slice(ranges, ranges + 4)), [1, 6, 7, 10]);
  // Uneven costs: the end that balances the estimated work, not half of the files.
  const uneven = new Int32Array(newSchedule(2, 4, 0, 0));
  fillScheduleCosts(uneven, [100, 10, 10, 10], Array(4).fill([]), []);
  ownRanges(uneven, 0, 4, 4, 4);
  assert.equal(takePosition(uneven, 4, 1), 1);
  assert.deepEqual(Array.from(uneven.slice(ranges, ranges + 4)), [0, 1, 2, 4]);
});

test('an idle checker leaves files whose library only the owner has resolved', () => {
  // Four small files importing one library that costs 1000 to resolve; checker 0 has taken the first.
  const schedule = new Int32Array(newSchedule(2, 4, 1, 4));
  fillScheduleCosts(schedule, Array(4).fill(10), Array(4).fill([0]), [1000]);
  ownRanges(schedule, 0, 4, 4, 4);
  assert.equal(takePosition(schedule, 4, 0), 0);
  // Taking any of the other three would make checker 1 resolve the library: it is done instead.
  assert.equal(takePosition(schedule, 4, 1), -1);
  assert.deepEqual(Array.from(schedule.slice(ranges, ranges + 4)), [1, 4, 4, 4]);
  // Once checker 1 has resolved the library too, it takes the last file.
  const both = new Int32Array(newSchedule(2, 6, 1, 6));
  fillScheduleCosts(both, Array(6).fill(10), Array(6).fill([0]), [1000]);
  ownRanges(both, 0, 2, 2, 6);
  assert.equal(takePosition(both, 6, 0), 0);
  assert.equal(takePosition(both, 6, 1), 2);
  assert.equal(takePosition(both, 6, 0), 1);
  assert.deepEqual(Array.from(both.slice(ranges, ranges + 4)), [2, 2, 3, 6]);
  assert.equal(takePosition(both, 6, 0), 5);
  assert.deepEqual(Array.from(both.slice(ranges, ranges + 4)), [6, 6, 3, 5]);
});

test('auto starts a checker per CPU, at least four, fewer only when memory does not fit', () => {
  assert.equal(autoCheckers(8, 100), 8);
  assert.equal(autoCheckers(2, 100), 4);
  assert.equal(autoCheckers(16, 10), 10);
  assert.equal(autoCheckers(8, 1), 4);
  const GiB = 1024 ** 3;
  // VS Code (158.6M characters, 16.8M in declaration files): on 16 GiB the estimate leaves tsgo's
  // four checkers (it checked with 13.2 GiB at 8), on 32 GiB one per CPU.
  assert.equal(autoCheckers(8, checkersFittingMemory(158592222, 16769893, 16 * GiB)), 4);
  assert.equal(autoCheckers(16, checkersFittingMemory(158592222, 16769893, 32 * GiB)), 16);
  // T3 Code's apps/server (57.5M, 30.4M; 11.1 GiB at 8 checkers, 19 GiB at 16) and Sentry (71.7M, 22.1M;
  // 9.8 GiB at 8) get eight on 16 GiB.
  assert.equal(autoCheckers(8, checkersFittingMemory(57491513, 30414210, 16 * GiB)), 8);
  assert.equal(autoCheckers(16, checkersFittingMemory(57491513, 30414210, 16 * GiB)), 8);
  assert.equal(autoCheckers(8, checkersFittingMemory(71728469, 22113123, 16 * GiB)), 8);
  assert.equal(autoCheckers(16, checkersFittingMemory(57491513, 30414210, 32 * GiB)), 16);
});
