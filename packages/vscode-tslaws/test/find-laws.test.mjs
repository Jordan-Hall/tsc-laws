import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const { findLaws } = createRequire(import.meta.url)('../src/find-laws.js');

test('finds plain, proved, exported and async declarations', () => {
  const text = [
    'law a(x: number) { return true; }',
    'export law proved b(x: number) => x === x;',
    '  async law c<T>(x: T) { return true; }',
    'export async law proved d(x: number) => true;',
  ].join('\n');
  assert.deepEqual(
    findLaws(text).map((l) => [l.name, l.line, l.proved]),
    [
      ['a', 0, false],
      ['b', 1, true],
      ['c', 2, false],
      ['d', 3, true],
    ],
  );
});

test('a law named proved is a name, not the modifier', () => {
  const [l] = findLaws('law proved(x: number) => true;');
  assert.equal(l.name, 'proved');
  assert.equal(l.proved, false);
});

test('ignores ordinary uses of law', () => {
  const text = ['law(1);', 'const law = 1;', 'obj.law x(', 'x = law foo(', 'law foo', '// law bar(x) {}'].join('\n');
  assert.deepEqual(findLaws(text), []);
});

test('ignores laws inside block comments and handles CRLF', () => {
  const text = '/*\nlaw hidden(x) {}\n*/\r\nlaw shown(x) { return true; }\r\n';
  assert.deepEqual(
    findLaws(text).map((l) => [l.name, l.line]),
    [['shown', 3]],
  );
});

test('reports the column of the law keyword', () => {
  assert.equal(findLaws('  export law x(a) {}')[0].column, 9);
});
