import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const { parseReport, recordsForFile, lensesFor, diagnosticsFor, parseUiUrl } = createRequire(import.meta.url)(
  '../src/parse-report.js',
);

const report = {
  results: [
    { file: 'src/math.laws.ts', name: 'add', line: 4, status: 'proved', method: 'smt', runs: 200, seed: 1 },
    {
      file: 'src/math.laws.ts',
      name: 'sortKeepsLength',
      line: 14,
      status: 'failed',
      method: 'property',
      counterexample: '[[5,5]]',
      message: 'returned false',
      hint: 'Fix the code.',
    },
    { file: 'src/math.laws.ts', name: 'slow', line: 16, status: 'open', message: 'gave up' },
    { file: 'src/other.laws.ts', name: 'x', line: 1, status: 'tampered', message: 'changed' },
    { file: 'src/api.ts', name: 'helper', line: 0, status: 'uncovered', message: 'no law' },
  ],
  compileDiagnostics: '',
  compileOk: true,
  lockMissing: false,
  ok: false,
};

test('parses a report, tolerating text before the JSON', () => {
  const p = parseReport('warning: noise\n' + JSON.stringify(report));
  assert.equal(p.records.length, 5);
  assert.equal(p.ok, false);
  assert.equal(p.compileOk, true);
  assert.throws(() => parseReport('nothing'), /no JSON/);
});

test('normalizes Windows paths and picks records per file', () => {
  const p = parseReport(
    JSON.stringify({ results: [{ file: '.\\src\\a.laws.ts', name: 'a', line: 1, status: 'proved' }] }),
  );
  assert.equal(recordsForFile(p.records, 'C:\\w\\src\\a.laws.ts', 'C:\\w').length, 1);
  assert.equal(recordsForFile(p.records, 'C:\\w\\src\\b.laws.ts', 'C:\\w').length, 0);
});

test('lenses: status per law, counterexample lens for failures, not run when unknown', () => {
  const { records } = parseReport(JSON.stringify(report));
  const laws = [
    { name: 'add', line: 3 },
    { name: 'sortKeepsLength', line: 13 },
    { name: 'fresh', line: 20 },
  ];
  const lenses = lensesFor(laws, recordsForFile(records, 'src/math.laws.ts', ''));
  assert.deepEqual(
    lenses.map((l) => [l.line, l.title]),
    [
      [3, '$(check) proved'],
      [13, '$(error) failed'],
      [13, 'counterexample: [[5,5]]'],
      [20, '$(circle-outline) not run'],
    ],
  );
});

test('diagnostics: failed, open, tampered, error and uncovered only, on the law line', () => {
  const { records } = parseReport(JSON.stringify(report));
  const mine = recordsForFile(records, 'src/math.laws.ts', '');
  const ds = diagnosticsFor(mine, [{ name: 'sortKeepsLength', line: 13 }]);
  assert.equal(ds.length, 2);
  assert.equal(ds[0].line, 13);
  assert.equal(ds[0].severity, 'error');
  assert.match(ds[0].message, /returned false/);
  assert.match(ds[0].message, /counterexample: \[\[5,5\]\]/);
  assert.match(ds[0].message, /hint: Fix the code\./);
  assert.equal(ds[1].line, 15); // open law not found in text: reported line, 0-based
  assert.equal(ds[1].severity, 'warning');
  const unc = diagnosticsFor(recordsForFile(records, 'src/api.ts', ''));
  assert.equal(unc[0].line, 0);
});

test('parses the dashboard URL', () => {
  assert.equal(parseUiUrl('tslaws ui: http://127.0.0.1:51234/  (Ctrl+C exits)\n'), 'http://127.0.0.1:51234/');
  assert.equal(parseUiUrl('starting'), null);
});
