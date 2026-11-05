import assert from 'node:assert/strict';
import { test } from 'node:test';
import { runProperty } from '../dist/property.js';

const options = { runs: 100, seed: 1 } as Parameters<typeof runProperty>[2];

test('a law without parameters runs once and passes', async () => {
  let calls = 0;
  const details = await runProperty(() => { calls += 1; return true; }, [], options);
  assert.equal(details.failed, false);
  assert.equal(calls, 1);
});

test('a law without parameters that returns false fails', async () => {
  const details = await runProperty(() => false, [], options);
  assert.equal(details.failed, true);
});
