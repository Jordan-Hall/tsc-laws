import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

// build:native optimizes with profiles/tsc-ts.profdata. Functions whose generated code differs between scriptc
// versions lose their profile data, so the profile is collected again when the pinned scriptc changes
// (npm run refresh-profile, which records its scriptc in profiles/scriptc-version).
test('the committed profile was collected with the pinned scriptc', () => {
  const pinned = JSON.parse(readFileSync('../../package.json', 'utf8')).devDependencies.scriptc;
  const collected = readFileSync('profiles/scriptc-version', 'utf8').trim();
  assert.equal(
    collected,
    pinned,
    `profiles/tsc-ts.profdata was collected with scriptc ${collected}, but package.json pins ${pinned}: run npm run refresh-profile`,
  );
});
