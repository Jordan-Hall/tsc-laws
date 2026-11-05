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

test('finds law(...) and law.proved(...) calls, with spaces in names', () => {
  const text = [
    "law('add commutes', (a: int, b: int) => a + b === b + a);",
    'export const x = 1;',
    'law.proved("sq is non negative", (x: int) => x * x >= 0);',
  ].join('\n');
  assert.deepEqual(
    findLaws(text).map((l) => [l.name, l.line, l.column, l.proved]),
    [
      ['add commutes', 0, 0, false],
      ['sq is non negative', 2, 0, true],
    ],
  );
});

test('finds multi-line and async call laws, and template-literal names', () => {
  const text = [
    'law(',
    "  'multi line',",
    '  (x: int) => true,',
    ');',
    '  law.proved(`tpl name`, async (x: int) => {',
    '    return true;',
    '  });',
    'law.proved(',
    '  "async one", async (x: int) => x === x);',
    "law('it\\'s escaped', (x: int) => true);",
  ].join('\n');
  assert.deepEqual(
    findLaws(text).map((l) => [l.name, l.line, l.proved]),
    [
      ['multi line', 0, false],
      ['tpl name', 4, true],
      ['async one', 7, true],
      ["it's escaped", 9, false],
    ],
  );
});

test('call and keyword laws coexist, in source order', () => {
  const text = [
    "law('new style', (x: int) => true);",
    'export law proved old(x: number) => true;',
    "law.proved('again', (x: int) => true);",
  ].join('\n');
  assert.deepEqual(
    findLaws(text).map((l) => [l.name, l.line, l.proved]),
    [
      ['new style', 0, false],
      ['old', 1, true],
      ['again', 2, true],
    ],
  );
});

test('ignores non-law calls, dynamic names, comments and strings', () => {
  const text = [
    'obj.law("a", f);',
    'xlaw("b", f);',
    'law(name, f);',
    'law(`dyn ${n}`, f);',
    'law("only name");',
    "// law('commented', f);",
    "/* law('block', f); */",
    'const s = "law(\'in string\', f)";',
    'law.other("c", f);',
  ].join('\n');
  assert.deepEqual(findLaws(text), []);
});

test('reports where the name starts and the parameter names, including type parameters and patterns', () => {
  const text = [
    'export law proved a<T extends { x: number }>(x: T, y?: Map<string, number>, { z }: P, ...rest: number[]) => 1;',
    'law b(',
    '  p: (n: number) => void,',
    '  q = 3,',
    ') { return true; }',
  ].join('\n');
  const [a, b] = findLaws(text);
  assert.equal(text.slice(a.nameColumn, a.nameColumn + 1), 'a');
  assert.deepEqual(a.params, ['x', 'y', 'arg3', 'rest']);
  assert.equal(b.nameColumn, 4);
  assert.deepEqual(b.params, ['p', 'q']);
});
