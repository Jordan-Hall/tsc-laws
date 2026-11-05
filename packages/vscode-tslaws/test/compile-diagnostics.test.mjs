import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { parseLawDiagnostics, compileDiagnostics } = require('../src/compile-diagnostics.js');

const output = [
  "src/a.laws.ts(1,12): error TS9101: A law must return boolean or void, not 'number'.",
  'src/a.laws.ts(2,5): error TS9102: A law must be exported so tslaws can load it.',
  "src/a.laws.ts(3,20): error TS7006: Parameter 'a' implicitly has an 'any' type.",
  "src/a.laws.ts(3,20): error TS9103: Parameter 'a' of a law needs a type annotation so inputs can be generated.",
  'src\\b.laws.ts(4,25): error TS9106: A law parameter must be a plain identifier so inputs can be generated.',
  "src/a.ts(9,1): error TS9105: 'noReturn' is a law and only another law can call it.",
  'error TS2318: Cannot find global type Array.',
].join('\n');

test('only the compiler law rules are taken, with their positions', () => {
  const found = parseLawDiagnostics(output);
  assert.deepEqual(
    found.map((d) => `${d.file}:${d.line}:${d.column} ${d.code}`),
    [
      'src/a.laws.ts:1:12 TS9101',
      'src/a.laws.ts:2:5 TS9102',
      'src/a.laws.ts:3:20 TS9103',
      'src/b.laws.ts:4:25 TS9106',
      'src/a.ts:9:1 TS9105',
    ],
  );
});

test('each diagnostic covers the identifier at the reported position, in the text as it is', () => {
  const texts = {
    'src/a.laws.ts':
      'export law noReturn(a: number) { return 1; }\nlaw notExported(a: number) { return true; }\nexport law untyped(a) { return true; }\n',
    'src/b.laws.ts': '\n\n\nexport law destructured({ a }: { a: number }) { return true; }\n',
    'src/a.ts': 'x\n'.repeat(8) + 'noReturn(1);\n',
  };
  const descs = compileDiagnostics(output, (f) => texts[f]);
  const line = (file, d) => texts[file].split('\n')[d.range.line].slice(d.range.start, d.range.end);
  const a = descs.get('src/a.laws.ts');
  assert.deepEqual(
    a.map((d) => line('src/a.laws.ts', d)),
    ['noReturn', 'notExported', 'a'],
  );
  assert.ok(
    a.every(
      (d) => d.severity === 'error' && d.source === 'tsc-laws' && d.role === 'compiler' && d.related.length === 0,
    ),
  );
  assert.equal(descs.get('src/b.laws.ts')[0].code, 'TS9106');
  assert.equal(line('src/a.ts', descs.get('src/a.ts')[0]), 'noReturn');
});

test('a file that cannot be read still gets a one-character mark', () => {
  const descs = compileDiagnostics(output, () => undefined);
  assert.deepEqual(descs.get('src/a.laws.ts')[0].range, { line: 0, start: 11, end: 12 });
});
