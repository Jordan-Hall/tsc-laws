import assert from 'node:assert/strict';
import { before, describe, it } from 'node:test';

describe('sum', () => {
  let base = 0;

  before(() => {
    base = 10;
  });

  it('adds to the base', () => {
    assert.equal(base + 1, 11);
  });

  it('is commutative', async () => {
    await Promise.resolve();
    assert.equal(1 + 2, 2 + 1);
  });

  it('is not written yet', { todo: true }, () => {
    assert.equal(1, 2);
  });
});
