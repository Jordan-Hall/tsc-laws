import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { jobsPerFile } from './jobs-split.ts';

const gibibyte = 2 ** 30;

describe('the CPU budget of a test file', () => {
  it('splits the cores between the files that run at once', () => {
    assert.equal(jobsPerFile(3, 12, 64 * gibibyte), 4);
    assert.equal(jobsPerFile(3, 4, 64 * gibibyte), 1);
  });

  it('keeps the memory cap: a host with many cores and little free memory gets fewer slots', () => {
    assert.equal(jobsPerFile(3, 64, 6 * gibibyte), 2);
    assert.equal(jobsPerFile(3, 64, 3 * gibibyte), 1);
  });

  it('takes the smaller of the two', () => {
    assert.equal(jobsPerFile(3, 6, 64 * gibibyte), 2);
    assert.equal(jobsPerFile(3, 64, 64 * gibibyte), 8);
  });

  it('gives every file one slot, however little there is', () => {
    assert.equal(jobsPerFile(3, 1, 0), 1);
    assert.equal(jobsPerFile(4, 2, gibibyte / 2), 1);
  });
});
