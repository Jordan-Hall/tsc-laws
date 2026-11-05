import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const { merge, functionIndex, coverageMap, blamedFunctions } = createRequire(import.meta.url)('../src/model.js');

const span = (file, line, column = 1) => ({ file, line, column, endLine: line, endColumn: column + 3 });
const rec = (file, name, status, extra = {}) => ({
  file,
  name,
  line: 1,
  status,
  method: 'property',
  exercises: [],
  ...extra,
});
const ex = (name, file, extra = {}) => ({ name, declaration: span(file, 1), failing: false, ...extra });

const full = [
  rec('src/a.laws.ts', 'one', 'proved'),
  rec('src/a.laws.ts', 'two', 'failed'),
  rec('src/b.laws.ts', 'three', 'tested'),
  rec('src/a.ts', 'lonely', 'uncovered', { method: 'coverage' }),
];

test('a run of every law replaces what was known', () => {
  const next = [rec('src/a.laws.ts', 'one', 'tested')];
  assert.deepEqual(merge(full, next, { files: null }), next);
});

test('a run of one laws file replaces that file and keeps the rest, uncovered included', () => {
  const next = [rec('src/a.laws.ts', 'one', 'proved'), rec('src/a.laws.ts', 'two', 'proved')];
  const merged = merge(full, next, { files: ['src/a.laws.ts'] });
  assert.deepEqual(merged.map((r) => `${r.file}:${r.name}:${r.status}`).sort(), [
    'src/a.laws.ts:one:proved',
    'src/a.laws.ts:two:proved',
    'src/a.ts:lonely:uncovered',
    'src/b.laws.ts:three:tested',
  ]);
});

test('a partial run ignores uncovered and the removed-law tampering that reading only part of the project causes', () => {
  const next = [
    rec('src/a.laws.ts', 'one', 'proved'),
    rec('src/a.laws.ts', 'two', 'failed'),
    rec('src/a.ts', 'helper', 'uncovered', { method: 'coverage' }),
    rec('src/b.laws.ts', 'three', 'tampered', {
      method: 'lock',
      message: 'law was removed since the lock was accepted',
    }),
  ];
  const merged = merge(full, next, { files: ['src/a.laws.ts'] });
  assert.equal(
    merged.find((r) => r.name === 'helper'),
    undefined,
  );
  assert.equal(merged.find((r) => r.name === 'three').status, 'tested');
  assert.equal(merged.find((r) => r.name === 'lonely').status, 'uncovered');
});

test('a law that is no longer reported in a rerun file has been removed from it', () => {
  const merged = merge(full, [rec('src/a.laws.ts', 'one', 'proved')], { files: ['src/a.laws.ts'] });
  assert.equal(
    merged.find((r) => r.name === 'two'),
    undefined,
  );
});

test('rerunning named laws replaces only those, and keeps the other laws of the file', () => {
  const merged = merge(full, [rec('src/a.laws.ts', 'two', 'proved')], { files: ['src/a.laws.ts'], laws: ['two'] });
  assert.equal(merged.find((r) => r.name === 'two').status, 'proved');
  assert.equal(merged.find((r) => r.name === 'one').status, 'proved');
  assert.equal(merged.length, 4);
});

test('which laws reach which function, and which law files cover which source file', () => {
  const records = [
    rec('src/a.laws.ts', 'one', 'failed', { exercises: [ex('total', 'src/cart.ts'), ex('round', 'src/util.ts')] }),
    rec('src/b.laws.ts', 'two', 'proved', { exercises: [ex('total', 'src/cart.ts')] }),
  ];
  const index = functionIndex(records);
  const total = index.get('src/cart.ts::total');
  assert.deepEqual(
    total.laws.map((l) => [l.name, l.failing]),
    [
      ['one', true],
      ['two', false],
    ],
  );
  assert.equal(index.get('src/util.ts::round').laws.length, 1);
  assert.deepEqual([...coverageMap(records).get('src/cart.ts')].sort(), ['src/a.laws.ts', 'src/b.laws.ts']);
});

test('the blamed function is the one the stack named, else the one the law calls, else every candidate', () => {
  const called = ex('a', 'src/x.ts', { call: span('src/a.laws.ts', 3) });
  const deep = ex('b', 'src/y.ts');
  assert.deepEqual(
    blamedFunctions({ exercises: [called, { ...deep, failing: true }] }).map((b) => [b.exercise.name, b.certain]),
    [['b', true]],
  );
  assert.deepEqual(
    blamedFunctions({ exercises: [called, deep] }).map((b) => [b.exercise.name, b.certain]),
    [['a', true]],
  );
  const two = ex('c', 'src/z.ts', { call: span('src/a.laws.ts', 4) });
  assert.deepEqual(
    blamedFunctions({ exercises: [called, two, deep] }).map((b) => [b.exercise.name, b.certain]),
    [
      ['a', false],
      ['c', false],
    ],
  );
  assert.deepEqual(
    blamedFunctions({ exercises: [deep] }).map((b) => [b.exercise.name, b.certain]),
    [['b', true]],
  );
  assert.deepEqual(blamedFunctions({ exercises: [] }), []);
});
