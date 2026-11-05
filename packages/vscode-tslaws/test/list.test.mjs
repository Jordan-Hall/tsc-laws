import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const { parseList, fromName, badgeFor } = createRequire(import.meta.url)('../src/list.js');

const entry = (file, kind, status) => ({ file, kind, status, notices: [] });

test('parses what tslaws list --json prints', () => {
  const text = JSON.stringify({
    files: [
      { file: 'src\\a.laws.ts', kind: 'node', status: 'accepted', notices: [] },
      { file: 'x.ts', kind: 'browser', status: 'unaccepted', error: 'both', notices: ['n'] },
    ],
  });
  assert.deepEqual(parseList(text), [
    entry('src/a.laws.ts', 'node', 'accepted'),
    { ...entry('x.ts', 'browser', 'unaccepted'), error: 'both', notices: ['n'] },
  ]);
});

test('anything else is not an answer, so the caller can fall back', () => {
  for (const text of [
    '',
    'tslaws check [files...]',
    '{}',
    '{"files":3}',
    '{"files":[{"file":"a"}]}',
    '{"files":[{"file":"a","kind":"x","status":"accepted"}]}',
  ])
    assert.equal(parseList(text), null, text);
});

test('names stand in for the answer of an older tslaws', () => {
  assert.equal(fromName('src/a.browser.laws.ts').kind, 'browser');
  assert.equal(fromName('src/a.e2e.laws.ts').kind, 'e2e');
  assert.equal(fromName('src/a.laws.ts').kind, 'node');
  assert.equal(fromName('src/a.proposed.laws.ts').status, 'proposed');
});

test('one letter and a colour per level, P for a proposal, a note for an unaccepted file', () => {
  assert.equal(badgeFor(entry('a', 'node', 'accepted')).badge, 'N');
  assert.equal(badgeFor(entry('a', 'browser', 'accepted')).badge, 'B');
  assert.equal(badgeFor(entry('a', 'e2e', 'accepted')).badge, 'E');
  assert.equal(badgeFor(entry('a', 'e2e', 'proposed')).badge, 'P');
  assert.match(badgeFor(entry('a', 'e2e', 'proposed')).tooltip, /proposed end-to-end laws/);
  assert.match(badgeFor(entry('a', 'node', 'unaccepted')).tooltip, /not in tsc-laws\.lock/);
  assert.doesNotMatch(badgeFor(entry('a', 'node', 'accepted')).tooltip, /lock/);
  assert.match(badgeFor({ ...entry('a', 'node', 'accepted'), error: 'both levels' }).tooltip, /both levels/);
  for (const k of ['node', 'browser', 'e2e']) assert.ok(badgeFor(entry('a', k, 'accepted')).badge.length <= 2);
});
