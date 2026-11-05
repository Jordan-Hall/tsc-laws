import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const { buildDiagnostics } = createRequire(import.meta.url)('../src/diagnostics.js');
const { textOf } = createRequire(import.meta.url)('../src/ranges.js');

const files = {
  'src/cart.laws.ts': [
    "import { total } from './cart';",
    '',
    'export law totalNeverNegative(price: number, coupon: number) {',
    '  return total(price, coupon) >= 0;',
    '}',
    'export law other(a: number) => a === a;',
  ].join('\n'),
  'src/cart.ts': [
    '// the price',
    'export function total(price: number, coupon: number): number {',
    '  return price - coupon;',
    '}',
  ].join('\n'),
};
const read = (f) => files[f];
const span = (file, line, column, name) => ({ file, line, column, endLine: line, endColumn: column + name.length });

const failed = {
  file: 'src/cart.laws.ts',
  name: 'totalNeverNegative',
  line: 3,
  status: 'failed',
  method: 'property',
  runs: 12,
  seed: 99,
  counterexample: '[0,1]',
  message: 'returned false',
  exercises: [
    {
      name: 'total',
      declaration: span('src/cart.ts', 2, 17, 'total'),
      call: span('src/cart.laws.ts', 4, 10, 'total'),
      failing: false,
    },
  ],
};

test('a failed law is marked on its name and on the function it exercises, each linking to the other', () => {
  const out = buildDiagnostics([failed], read);
  const [law] = out.get('src/cart.laws.ts');
  const [source] = out.get('src/cart.ts');

  assert.equal(law.code, 'tslaws/totalNeverNegative');
  assert.equal(source.code, 'tslaws/totalNeverNegative');
  assert.equal(law.source, 'tslaws');
  assert.equal(law.severity, 'error');
  assert.equal(textOf(files['src/cart.laws.ts'], law.range), 'totalNeverNegative');
  assert.equal(textOf(files['src/cart.ts'], source.range), 'total');
  assert.equal(source.severity, 'error');

  assert.match(law.message, /Shrunk counterexample: price = 0, coupon = 1/);
  assert.match(law.message, /Reproduce: npx tslaws check src\/cart\.laws\.ts --law totalNeverNegative --seed 99/);
  assert.match(source.message, /^Law totalNeverNegative fails on total\./);

  // The law links to the function and to the call; the function links back to the law and to the call.
  assert.deepEqual(
    law.related.map((r) => [r.file, textOf(files[r.file], r.range)]),
    [
      ['src/cart.ts', 'total'],
      ['src/cart.laws.ts', 'total'],
    ],
  );
  assert.deepEqual(
    source.related.map((r) => [r.file, textOf(files[r.file], r.range)]),
    [
      ['src/cart.laws.ts', 'totalNeverNegative'],
      ['src/cart.laws.ts', 'total'],
    ],
  );
  assert.deepEqual(
    law.calls.map((c) => textOf(files['src/cart.laws.ts'], c)),
    ['total'],
  );
  assert.equal(law.reproduce, 'npx tslaws check src/cart.laws.ts --law totalNeverNegative --seed 99');
});

test('ranges follow the text as it is now, not the lines of the last run', () => {
  const moved = { ...files, 'src/cart.ts': `// one\n// two\n${files['src/cart.ts']}` };
  const out = buildDiagnostics([failed], (f) => moved[f]);
  const [source] = out.get('src/cart.ts');
  assert.equal(source.range.line, 3);
  assert.equal(textOf(moved['src/cart.ts'], source.range), 'total');
});

test('several candidates are warnings, not a certainty', () => {
  const two = {
    ...failed,
    exercises: [
      failed.exercises[0],
      {
        name: 'other',
        declaration: span('src/cart.ts', 4, 1, 'other'),
        call: span('src/cart.laws.ts', 4, 30, 'other'),
        failing: false,
      },
    ],
  };
  const text = { ...files, 'src/cart.ts': `${files['src/cart.ts']}\nfunction other() {}` };
  const out = buildDiagnostics([two], (f) => text[f]);
  assert.deepEqual(
    out.get('src/cart.ts').map((d) => d.severity),
    ['warning', 'warning'],
  );
});

test('open, tampered and error laws are marked on the law only; passing laws and unreadable files are skipped', () => {
  const records = [
    {
      file: 'src/cart.laws.ts',
      name: 'other',
      line: 6,
      status: 'open',
      method: 'smt',
      message: 'marked proved but only bounded',
      hint: 'Make it provable.',
      exercises: [],
    },
    { file: 'src/cart.laws.ts', name: 'totalNeverNegative', line: 3, status: 'proved', exercises: [] },
    { file: 'src/gone.laws.ts', name: 'x', line: 1, status: 'error', exercises: [] },
  ];
  const out = buildDiagnostics(records, read);
  assert.deepEqual([...out.keys()], ['src/cart.laws.ts']);
  const [d] = out.get('src/cart.laws.ts');
  assert.equal(d.severity, 'warning');
  assert.equal(d.code, 'tslaws/other');
  assert.match(d.message, /Next: Make it provable\./);
  assert.deepEqual(d.related, []);
});

test('an uncovered function is marked on its name, from the declaration line the report gives', () => {
  const out = buildDiagnostics(
    [
      {
        file: 'src/cart.ts',
        name: 'total',
        line: 2,
        status: 'uncovered',
        message: 'no law reaches this exported function',
        exercises: [],
      },
    ],
    read,
  );
  const [d] = out.get('src/cart.ts');
  assert.equal(textOf(files['src/cart.ts'], d.range), 'total');
  assert.equal(d.severity, 'warning');
  assert.equal(d.lawFile, undefined);
});

test('a law removed from its file is marked at the reported line, not dropped', () => {
  const out = buildDiagnostics(
    [
      {
        file: 'src/cart.laws.ts',
        name: 'removed',
        line: 0,
        status: 'tampered',
        message: 'law was removed since the lock was accepted',
        exercises: [],
      },
    ],
    read,
  );
  const [d] = out.get('src/cart.laws.ts');
  assert.equal(d.range.line, 0);
  assert.equal(d.severity, 'error');
});
