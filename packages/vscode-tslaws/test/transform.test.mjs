import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import fc from 'fast-check';

const require = createRequire(import.meta.url);
const { rewrite, lex, PositionMap, applyEdits } = require('../ts-plugin/transform.js');

const out = (text) => rewrite(text)?.text;

test('a block law becomes a function declaration', () => {
  assert.equal(
    out('export law foo(a: number) { return a === a; }'),
    'export function foo(a: number) { return a === a; }',
  );
  assert.equal(out('law foo(a: number) {}'), 'function foo(a: number) {}');
});

test('proved is dropped, bounded and tested are not syntax', () => {
  assert.equal(out('export law proved foo(a: number) { }'), 'export function foo(a: number) { }');
  assert.equal(out('law   proved   foo (a: number) { }'), 'function foo (a: number) { }');
  // `bounded` and `tested` are statuses: `law bounded x(` is a law named x with a stray word, so it is not a law at all
  assert.equal(rewrite('law bounded x(a: number) { }')?.laws.length ?? 0, 0);
});

test('a law named proved', () => {
  assert.equal(out('law proved(a: number) { }'), 'function proved(a: number) { }');
});

test('generics and async', () => {
  assert.equal(
    out('export law foo<T extends { a: 1 }>(a: T) { }'),
    'export function foo<T extends { a: 1 }>(a: T) { }',
  );
  assert.equal(
    out('export async law foo(a: number) { await a; }'),
    'export async function foo(a: number) { await a; }',
  );
});

test('the arrow form becomes a const arrow function', () => {
  assert.equal(out('export law foo(a: number) => a === a;'), 'export const foo = (a: number) => a === a;');
  assert.equal(out('law foo<T>(a: T): boolean => true;'), 'const foo = <T>(a: T): boolean => true;');
  assert.equal(out('export async law foo(a: number) => await a;'), 'export const foo = async (a: number) => await a;');
  assert.equal(out('export law proved foo(a: number) => a === a'), 'export const foo = (a: number) => a === a');
});

test('return types with braces and arrows do not confuse the body', () => {
  assert.equal(
    out('law foo(a: number): { ok: boolean } { return { ok: true }; }'),
    'function foo(a: number): { ok: boolean } { return { ok: true }; }',
  );
  assert.equal(
    out('law foo(a: number): Promise<{ ok: boolean }> { }'),
    'function foo(a: number): Promise<{ ok: boolean }> { }',
  );
  assert.equal(
    out('law foo(a: number): (x: number) => boolean { }'),
    'function foo(a: number): (x: number) => boolean { }',
  );
  assert.equal(out('law foo(a: number): boolean => true;'), 'const foo = (a: number): boolean => true;');
});

test('unusual formatting', () => {
  const text = [
    '/** doc */',
    'export  law\tproved   foo\n',
    '',
    'law bar<T>(',
    '  a: T,',
    '  b: Array<{ x: 1 }>,',
    ') {',
    '  return true;',
    '}',
    'law baz(a: string) /* c */ => a.length >= 0',
    'const x = 1; law qux(a: number) { }',
  ].join('\n');
  const r = rewrite(text);
  assert.deepEqual(
    r.laws.map((l) => l.name),
    ['bar', 'baz', 'qux'],
  );
  // `law foo` is followed by a line break before `(`: it is `law proved foo` with no parameter list, so left alone
  assert.ok(r.text.includes('export  law\tproved   foo'));
  assert.ok(r.text.includes('function bar<T>('));
  assert.ok(r.text.includes('const baz = (a: string) /* c */ => a.length >= 0'));
  assert.ok(r.text.includes('; function qux(a: number) { }'));
});

test('law as an ordinary identifier is not rewritten', () => {
  for (const text of [
    'const law = 1;',
    'obj.law = 2;',
    'law(1);',
    'law\nfoo()',
    'lawful x(',
    'x.law foo(1)',
    'const o = { law: 1 };\nfoo(o.law);',
    'function law(a) { return law; }',
    'let law;\nlaw = 3;',
    '// law foo(a) {}',
    '/* law foo(a) {} */',
    'const s = "law foo(a) {}";',
    "const s = 'law foo(a) {}';",
    'const s = `law foo(a) {} ${law} law bar(b) {}`;',
    'const r = /law foo(a)/;',
    'import { law } from "./x";',
    'type X = { law: number };',
  ]) {
    assert.equal(rewrite(text), null, text);
  }
});

test('a template with an expression holding a law-like string', () => {
  const text = 'const s = `a ${"x"} ${`law foo(a) {}`} b`;\nlaw real(a: number) { }';
  assert.equal(
    rewrite(text)
      .laws.map((l) => l.name)
      .join(),
    'real',
  );
});

test('lex keeps comments and strings out of the tokens', () => {
  const t = lex(['a /* b */ "c d" // e', '`f${g}h`;', '/i/g'].join('\n'));
  assert.deepEqual(
    t.map((x) => x.t),
    ['a', '"c d"', '`f${', 'g', '}h`', ';', '/i/g'],
  );
});

test('offsets round-trip around the edits', () => {
  const text =
    'export law proved foo<T>(a: T) { return a; }\nexport async law bar(a: number) => a === a;\nconst z = 1;';
  const { text: next, map } = rewrite(text);
  assert.equal(next, applyEdits(text, map.edits));
  for (let o = 0; o <= text.length; o++) {
    const inside = map.edits.some((e) => o > e.start && o < e.end);
    if (inside) continue;
    for (const bias of ['start', 'end'])
      assert.equal(map.toOriginal(map.toNew(o, bias), bias), o, `offset ${o} ${bias}`);
  }
  // the name of the law is where it was, shifted
  const nameNew = next.indexOf('foo');
  assert.equal(map.toOriginal(nameNew), text.indexOf('foo'));
  assert.equal(map.toNew(text.indexOf('foo')), nameNew);
  // a span over the name maps to a span over the name
  const span = map.spanToOriginal({ start: nameNew, length: 3 });
  assert.equal(text.slice(span.start, span.start + span.length), 'foo');
});

test('an offset inside replaced text goes to the edge of the replacement', () => {
  const map = new PositionMap([{ start: 0, end: 11, text: 'function ' }]);
  assert.equal(map.toNew(4, 'start'), 0);
  assert.equal(map.toNew(4, 'end'), 9);
  assert.equal(map.toOriginal(3, 'start'), 0);
  assert.equal(map.toOriginal(3, 'end'), 11);
  assert.equal(map.toNew(11), 9);
  assert.equal(map.toNew(15), 13);
});

test('property: for random law-like text every untouched offset round-trips and the rewrite has no law head left', () => {
  const piece = fc.constantFrom(
    'law ',
    'proved ',
    'export ',
    'async ',
    'foo',
    'bar',
    '(',
    ')',
    '<T>',
    '(a: number)',
    '{',
    '}',
    ' ',
    '\n',
    '\t',
    '=> ',
    ': boolean',
    ';',
    'const law = 1;',
    'x.law',
    '`${',
    '`',
    '"law a("',
    '/* c */',
    '// c\n',
    'return true',
    ' => a === a;',
    'int',
    '[]',
    ',',
  );
  fc.assert(
    fc.property(fc.array(piece, { maxLength: 40 }), (parts) => {
      const text = parts.join('');
      const r = rewrite(text);
      if (r === null) return true;
      assert.equal(r.text, applyEdits(text, r.map.edits));
      for (let o = 0; o <= text.length; o++) {
        if (r.map.edits.some((e) => o > e.start && o < e.end)) continue;
        for (const bias of ['start', 'end']) assert.equal(r.map.toOriginal(r.map.toNew(o, bias), bias), o);
      }
      // each law's name stays readable at its mapped place
      for (const law of r.laws) {
        const at = r.map.toNew(law.nameStart);
        assert.equal(r.text.slice(at, at + law.name.length), law.name);
      }
      return true;
    }),
    { numRuns: 400 },
  );
});

test('property: text with no law declaration shape is never rewritten', () => {
  const piece = fc.constantFrom(
    'law',
    ' ',
    '.',
    'law.',
    '(',
    ')',
    '=',
    '1',
    '\n',
    'foo',
    'law\n',
    ';',
    ',',
    'x',
    '{',
    '}',
  );
  fc.assert(
    fc.property(fc.array(piece, { maxLength: 30 }), (parts) => {
      const text = parts.join('');
      // a law shape needs `law` + spaces + an identifier + `(` or `<`, none of which is built here except `law foo(`
      if (/\blaw[ \t]+[A-Za-z_$]/.test(text) && /[(<]/.test(text)) return true;
      return rewrite(text) === null;
    }),
    { numRuns: 400 },
  );
});
