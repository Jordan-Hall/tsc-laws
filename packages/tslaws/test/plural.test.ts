import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { plural } from '../dist/plural.js';
import { totals } from '../dist/cli.js';
import { hintFor } from '../dist/hints.js';

describe('plural', () => {
  it('adds an s unless there is exactly one', () => {
    assert.equal(plural(0, 'law'), '0 laws');
    assert.equal(plural(1, 'law'), '1 law');
    assert.equal(plural(8, 'file'), '8 files');
    assert.equal(plural(1, 'advisory', 'advisories'), '1 advisory');
    assert.equal(plural(2, 'advisory', 'advisories'), '2 advisories');
  });

  it('names one law in one file in the accept listing and the totals', () => {
    const report = { results: [{ status: 'proved' }] } as never;
    assert.match(totals(report), /^1 law: 1 proved, .*, 0 errors$/);
    const two = { results: [{ status: 'proved' }, { status: 'error' }] } as never;
    assert.match(totals(two), /^2 laws: 1 proved, .*, 1 error$/);
  });

  it('says one run, not 1 runs, in the property-tested hint', () => {
    assert.match(hintFor({ status: 'tested', runs: 1, method: 'property' } as never) ?? '', /\(1 run\)/);
    assert.match(hintFor({ status: 'tested', runs: 100, method: 'property' } as never) ?? '', /\(100 runs\)/);
  });
});
