import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, existsSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { createShadow } = require('../src/shadow.js');

function project() {
  const root = mkdtempSync(join(tmpdir(), 'tslaws-shadow-'));
  const put = (rel, text) => {
    mkdirSync(join(root, rel, '..'), { recursive: true });
    writeFileSync(join(root, rel), text);
  };
  put('src/a.ts', 'export const a = 1;\n');
  put('src/a.laws.ts', 'export law one(x: number) => true;\n');
  put('tsc-laws.lock', '{}\n');
  put('node_modules/dep/index.js', 'module.exports = 1;\n');
  put('.tslaws/out/stale.js', 'x');
  put('.tslaws/regressions/src__a.laws.ts/one.json', '[]');
  return { root, put, done: () => rmSync(root, { recursive: true, force: true }) };
}

test('copies the project into .tslaws/shadow with the unsaved text of open buffers, and leaves the files alone', () => {
  const p = project();
  try {
    const shadow = createShadow({ root: p.root });
    const synced = shadow.sync(new Map([['src/a.ts', 'export const a = 2; // unsaved\n']]));
    assert.deepEqual(synced, { ok: true, copied: 4 });
    assert.equal(shadow.dir, join(p.root, '.tslaws', 'shadow'));
    assert.equal(readFileSync(join(shadow.dir, 'src/a.ts'), 'utf8'), 'export const a = 2; // unsaved\n');
    assert.equal(
      readFileSync(join(p.root, 'src/a.ts'), 'utf8'),
      'export const a = 1;\n',
      'the real file is not written',
    );
    assert.equal(readFileSync(join(shadow.dir, 'tsc-laws.lock'), 'utf8'), '{}\n');
    assert.equal(existsSync(join(shadow.dir, '.tslaws', 'out')), false, 'build output is not copied');
    assert.equal(
      existsSync(join(shadow.dir, '.tslaws', 'regressions', 'src__a.laws.ts', 'one.json')),
      true,
      'the corpus is',
    );
    assert.equal(
      readFileSync(join(shadow.dir, 'node_modules', 'dep', 'index.js'), 'utf8'),
      'module.exports = 1;\n',
      'linked',
    );
  } finally {
    p.done();
  }
});

test('a second sync copies only what changed, restores a saved buffer, and removes deleted files', () => {
  const p = project();
  try {
    const shadow = createShadow({ root: p.root });
    shadow.sync(new Map([['src/a.ts', 'unsaved']]));
    assert.deepEqual(shadow.sync(new Map([['src/a.ts', 'unsaved']])), { ok: true, copied: 0 });

    // The buffer is saved or closed: the disk text comes back.
    assert.deepEqual(shadow.sync(new Map()), { ok: true, copied: 1 });
    assert.equal(readFileSync(join(shadow.dir, 'src/a.ts'), 'utf8'), 'export const a = 1;\n');

    p.put('src/b.ts', 'export const b = 1;\n');
    p.put('src/a.laws.ts', 'export law one(x: number) => false;\n');
    const later = new Date(Date.now() + 5000);
    utimesSync(join(p.root, 'src/a.laws.ts'), later, later);
    assert.deepEqual(shadow.sync(new Map()), { ok: true, copied: 2 });

    rmSync(join(p.root, 'src/b.ts'));
    shadow.sync(new Map());
    assert.equal(existsSync(join(shadow.dir, 'src/b.ts')), false);
    assert.equal(readFileSync(join(shadow.dir, 'src/a.laws.ts'), 'utf8'), 'export law one(x: number) => false;\n');
  } finally {
    p.done();
  }
});

test('a project too big to copy cheaply is refused, so the run falls back to the saved files', () => {
  const p = project();
  try {
    const fake = {
      ...require('node:fs'),
      readdirSync: (dir, o) => {
        if (String(dir).endsWith('src'))
          return Array.from({ length: 7000 }, (_, i) => ({
            name: `f${i}.ts`,
            isDirectory: () => false,
            isFile: () => true,
          }));
        return require('node:fs').readdirSync(dir, o);
      },
    };
    const synced = createShadow({ root: p.root, fs: fake }).sync(new Map());
    assert.equal(synced.ok, false);
    assert.match(synced.reason, /more than 6000 files/);
  } finally {
    p.done();
  }
});
