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

test('a law name with characters Windows refuses still gets a corpus file', async () => {
  const { regressionFile } = await import('../dist/regressions.js');
  const odd = regressionFile('/p', 'a.laws.ts', 'describe > test: "x"?');
  assert.doesNotMatch(odd.split(/[\/]/).at(-1)!, /[<>:"|?*]/);
  assert.notEqual(odd, regressionFile('/p', 'a.laws.ts', 'describe _ test_ _x__'));
  assert.match(regressionFile('/p', 'a.laws.ts', 'plain name'), /plain name\.json$/);
});

test('a stored object keeps a key named __proto__', async () => {
  const { decodeExample, encodeExample } = await import('../dist/regressions.js');
  const value = JSON.parse('{"__proto__":1,"a":2}');
  const back = decodeExample(encodeExample([value]))[0] as Record<string, unknown>;
  assert.deepEqual(Object.keys(back), ['__proto__', 'a']);
  assert.equal(Object.getPrototypeOf(back), Object.prototype);
});
