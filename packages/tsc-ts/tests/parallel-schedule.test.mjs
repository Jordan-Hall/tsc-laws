// How --checkers spreads work: the order parse threads load files in (libraries first, so a large
// one such as lib.dom.d.ts does not finish last).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { compiledDir } from './temp.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, '../../..');

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
const { ParseQueue } = await load('compiler/parallel-parse.js');

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
