import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const { parseReport, recordsForFile, createStreamParser, parseUiUrl, filesOf } = createRequire(import.meta.url)(
  '../src/parse-report.js',
);

const exercised = {
  name: 'sortNumbers',
  declaration: { file: 'src\\math.ts', line: 10, column: 17, endLine: 10, endColumn: 28 },
  call: { file: 'src/math.laws.ts', line: 14, column: 45, endLine: 14, endColumn: 56 },
  failing: true,
};

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
      exercises: [exercised],
    },
    { file: 'src/math.laws.ts', name: 'slow', line: 16, status: 'open', message: 'gave up' },
    { file: 'src/other.laws.ts', name: 'x', line: 1, status: 'tampered', message: 'changed' },
    { file: 'src/api.ts', name: 'helper', line: 3, status: 'uncovered', message: 'no law' },
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

test('keeps where a failure lives: the exercised function, its declaration, the call and the failing mark', () => {
  const p = parseReport(JSON.stringify(report));
  const failed = p.records.find((r) => r.name === 'sortKeepsLength');
  assert.deepEqual(failed.exercises, [
    {
      name: 'sortNumbers',
      declaration: { file: 'src/math.ts', line: 10, column: 17, endLine: 10, endColumn: 28 },
      call: { file: 'src/math.laws.ts', line: 14, column: 45, endLine: 14, endColumn: 56 },
      failing: true,
    },
  ]);
  assert.deepEqual(p.records.find((r) => r.name === 'add').exercises, []);
});

test('a report from an older tslaws, or with malformed locations, still parses', () => {
  const p = parseReport(
    JSON.stringify({
      results: [
        {
          file: 'a.laws.ts',
          name: 'a',
          status: 'failed',
          exercises: [{ name: 'f' }, { declaration: { line: 1 } }, null],
        },
      ],
    }),
  );
  assert.deepEqual(p.records[0].exercises, []);
  assert.equal(p.records[0].line, 0);
});

test('normalizes Windows paths and picks records per file', () => {
  const p = parseReport(
    JSON.stringify({ results: [{ file: '.\\src\\a.laws.ts', name: 'a', line: 1, status: 'proved' }] }),
  );
  assert.equal(recordsForFile(p.records, 'C:\\w\\src\\a.laws.ts', 'C:\\w').length, 1);
  assert.equal(recordsForFile(p.records, 'C:\\w\\src\\b.laws.ts', 'C:\\w').length, 0);
  assert.deepEqual(filesOf(parseReport(JSON.stringify(report)).records), [
    'src/math.laws.ts',
    'src/other.laws.ts',
    'src/api.ts',
  ]);
});

test('reads the ndjson stream: plan, start, result and the final report, and hands noise on', () => {
  const events = [];
  const noise = [];
  const parser = createStreamParser(
    (e) => events.push(e),
    (t) => noise.push(t),
  );
  const lines = [
    { type: 'plan', laws: [{ file: 'src\\a.laws.ts', name: 'a', line: 3 }] },
    { type: 'start', file: 'src/a.laws.ts', name: 'a' },
    { type: 'result', result: report.results[1] },
    { type: 'report', ...report },
  ].map((o) => JSON.stringify(o));
  parser.write(`${lines[0]}\ngarbage line\n${lines[1]}\n${lines[2].slice(0, 30)}`);
  parser.write(`${lines[2].slice(30)}\n${lines[3]}`);
  parser.end();
  assert.deepEqual(
    events.map((e) => e.type),
    ['plan', 'start', 'result', 'report'],
  );
  assert.deepEqual(events[0].laws, [{ file: 'src/a.laws.ts', name: 'a', line: 3 }]);
  assert.equal(events[2].record.exercises[0].failing, true);
  assert.equal(events[3].report.records.length, 5);
  assert.deepEqual(noise, ['garbage line']);
});

test('parses the dashboard URL', () => {
  assert.equal(parseUiUrl('tslaws ui: http://127.0.0.1:51234/  (Ctrl+C exits)\n'), 'http://127.0.0.1:51234/');
  assert.equal(parseUiUrl('starting'), null);
});
