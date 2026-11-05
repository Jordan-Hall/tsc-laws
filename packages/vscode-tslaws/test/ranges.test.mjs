import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const { lawRange, declarationRange, callRange, textOf } = createRequire(import.meta.url)('../src/ranges.js');

const laws = [
  "import { sortNumbers } from './math';",
  '',
  'export law proved addIdentity(a: number) => a + 0 === a;',
  'export law sortKeepsLength(xs: number[]) => sortNumbers(xs).length === xs.length;',
  'export law other(xs: number[]) {',
  '  return sortNumbers(xs).length >= 0;',
  '}',
].join('\n');

test('a law range covers the name, not the keyword or the line', () => {
  const r = lawRange(laws, 'addIdentity');
  assert.deepEqual(r, { line: 2, start: 18, end: 29 });
  assert.equal(textOf(laws, r), 'addIdentity');
  assert.equal(textOf(laws, lawRange(laws, 'sortKeepsLength')), 'sortKeepsLength');
  assert.equal(lawRange(laws, 'missing'), null);
});

const source = [
  '// helpers',
  'export function other() {}',
  '',
  '/** Buggy on purpose. */',
  'export function sortNumbers(xs: number[]): number[] {',
  '  return [...new Set(xs)];',
  '}',
  'export const clamp = (x: number): number => x;',
].join('\n');

test('a declaration range keeps the reported span when the name is still there', () => {
  const r = declarationRange(source, { line: 5, column: 17 }, 'sortNumbers');
  assert.deepEqual(r, { line: 4, start: 16, end: 27 });
  assert.equal(textOf(source, r), 'sortNumbers');
});

test('a declaration range follows the function when lines were added above it', () => {
  const moved = `// new\n// new\n${source}`;
  const r = declarationRange(moved, { line: 5, column: 17 }, 'sortNumbers');
  assert.equal(r.line, 6);
  assert.equal(textOf(moved, r), 'sortNumbers');
});

test('a declaration is found without a column (an uncovered function) and by its kind of declaration', () => {
  assert.equal(textOf(source, declarationRange(source, { line: 8 }, 'clamp')), 'clamp');
  assert.equal(declarationRange(source, { line: 1 }, 'clamp').line, 7);
  const klass = 'export class Counter extends Base {\n}\nexport async function* gen<T>() {}\n';
  assert.equal(textOf(klass, declarationRange(klass, { line: 1 }, 'Counter')), 'Counter');
  assert.equal(textOf(klass, declarationRange(klass, { line: 1 }, 'gen')), 'gen');
});

test('a call is not taken for a declaration, and a missing name gives null', () => {
  const text = 'function f() {\n  total(1, 2);\n}\n';
  assert.equal(declarationRange(text, { line: 2, column: 1 }, 'total'), null);
  assert.equal(declarationRange(source, { line: 1, column: 1 }, 'gone'), null);
});

test('a call range keeps the reported span, else searches inside the law only, never a member access', () => {
  assert.deepEqual(callRange(laws, { line: 4, column: 45 }, 'sortNumbers', 'sortKeepsLength'), {
    line: 3,
    start: 44,
    end: 55,
  });
  const shifted = `// x\n${laws}`;
  const r = callRange(shifted, { line: 4, column: 45 }, 'sortNumbers', 'sortKeepsLength');
  assert.equal(r.line, 4);
  assert.equal(textOf(shifted, r), 'sortNumbers');
  assert.equal(callRange(laws, { line: 1, column: 1 }, 'sortNumbers', 'addIdentity'), null);
  const member = 'export law x(a: number) => obj.sortNumbers(a) > 0;';
  assert.equal(callRange(member, { line: 9, column: 1 }, 'sortNumbers', 'x'), null);
});
