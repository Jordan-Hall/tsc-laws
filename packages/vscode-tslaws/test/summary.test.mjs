import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const { summaryText, allPass } = createRequire(import.meta.url)('../src/summary.js');
const r = (...s) => s.map((status) => ({ status }));

test('totals in a stable order', () => {
  assert.equal(summaryText(r('failed', 'proved', 'proved', 'proved')), 'laws: 3 proved, 1 failed');
  assert.equal(summaryText(r('tested', 'bounded', 'error')), 'laws: 1 bounded, 1 tested, 1 error');
});

test('states without records', () => {
  assert.equal(summaryText(null), 'laws: not run');
  assert.equal(summaryText([]), 'laws: none');
  assert.equal(summaryText(r('proved'), { running: true }), 'laws: running...');
});

test('allPass', () => {
  assert.equal(allPass(r('proved', 'tested')), true);
  assert.equal(allPass(r('proved', 'open')), false);
  assert.equal(allPass(null), false);
});
