import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const { planRun, isRunnable } = createRequire(import.meta.url)('../src/plan.js');

const lawFiles = [
  'src/cart.laws.ts',
  'src/orders/orders.laws.ts',
  'src/orders/refunds.laws.ts',
  'pkg/a/a.laws.ts',
  'src/x.proposed.laws.ts',
];

test('a laws file runs by itself', () => {
  assert.deepEqual(planRun({ file: 'src/cart.laws.ts', lawFiles, coverage: null }), {
    files: ['src/cart.laws.ts'],
    reason: 'law',
  });
});

test('a covered source runs the laws that reached it in the last report', () => {
  const coverage = new Map([['src/util/money.ts', new Set(['src/orders/refunds.laws.ts', 'src/cart.laws.ts'])]]);
  assert.deepEqual(planRun({ file: 'src/util/money.ts', lawFiles, coverage }), {
    files: ['src/cart.laws.ts', 'src/orders/refunds.laws.ts'],
    reason: 'covered',
  });
});

test('without coverage the laws file beside it runs, else those of the nearest folder, else all', () => {
  assert.deepEqual(planRun({ file: 'src/cart.ts', lawFiles, coverage: new Map() }), {
    files: ['src/cart.laws.ts'],
    reason: 'nearby',
  });
  assert.deepEqual(planRun({ file: 'src/orders/total.ts', lawFiles, coverage: null }), {
    files: ['src/orders/orders.laws.ts', 'src/orders/refunds.laws.ts'],
    reason: 'nearby',
  });
  assert.deepEqual(planRun({ file: 'src/orders/deep/er/x.ts', lawFiles, coverage: null }).files, [
    'src/orders/orders.laws.ts',
    'src/orders/refunds.laws.ts',
  ]);
  assert.deepEqual(planRun({ file: 'lib/other.ts', lawFiles, coverage: null }), { files: null, reason: 'all' });
});

test('files that cannot be laws or covered code, proposed laws and projects without laws run nothing', () => {
  for (const file of [
    'src/types.d.ts',
    'README.md',
    'node_modules/x/index.ts',
    '.tslaws/out/a.ts',
    'src/x.proposed.laws.ts',
  ])
    assert.deepEqual(planRun({ file, lawFiles, coverage: null }), { files: [], reason: 'none' }, file);
  assert.deepEqual(planRun({ file: 'src/a.ts', lawFiles: [], coverage: null }), { files: [], reason: 'none' });
  assert.equal(isRunnable('src/a.tsx'), true);
  assert.equal(isRunnable('src/a.js'), false);
});
