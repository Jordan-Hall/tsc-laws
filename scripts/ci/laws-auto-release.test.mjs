import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  chooseBump,
  hasCodeChange,
  insertSection,
  nextVersion,
  parseMessage,
  plan,
  renderSection,
  skipReason,
} from './laws-auto-release.mjs';

const head = { author: 'Jordan Upton', subject: 'fix: a thing', body: '' };
const never = () => false;
const run = (over) =>
  plan({
    currentVersion: '0.3.2',
    head,
    commits: [head],
    paths: ['packages/tslaws/src/a.ts'],
    tagExists: never,
    ...over,
  });

test('docs-only changes are not code', () => {
  assert.equal(
    hasCodeChange(['README.md', 'docs/a.mdx', 'packages/tslaws/README.md', 'CHANGELOG-LAWS.md', 'LICENSE']),
    false,
  );
  assert.equal(
    hasCodeChange(['examples/react/src/app.ts', '.github/workflows/ci.yml', '.github/ISSUE_TEMPLATE/x.yml']),
    false,
  );
  const r = run({ paths: ['README.md', 'docs/x.md'] });
  assert.equal(r.release, false);
  assert.match(r.reason, /no code changed/);
});

test('code paths count, also mixed with docs', () => {
  for (const p of [
    'packages/tsc-ts/src/a.zig',
    'packages/vscode-tslaws/src/x.ts',
    'scripts/ci/a.mjs',
    'upstream.json',
    'package.json',
    'package-lock.json',
    '.github/workflows/laws.yml',
  ]) {
    assert.equal(hasCodeChange([p]), true, p);
  }
  assert.equal(hasCodeChange(['README.md', 'packages/tslaws/src/a.ts']), true);
});

test('a code change releases a patch by default', () => {
  assert.deepEqual(run({}), {
    release: true,
    version: '0.3.3',
    tag: 'laws-v0.3.3',
    bump: 'patch',
    reason: 'patch release 0.3.3',
  });
});

test('feat bumps minor', () => {
  const commits = [
    { subject: 'fix: x', body: '' },
    { subject: 'feat(prover): y', body: '' },
  ];
  assert.equal(chooseBump(commits), 'minor');
  assert.equal(run({ commits }).version, '0.4.0');
  assert.equal(chooseBump([{ subject: 'feature flag cleanup', body: '' }]), 'patch');
});

test('breaking changes bump major', () => {
  assert.equal(chooseBump([{ subject: 'feat!: drop node 20', body: '' }]), 'major');
  assert.equal(chooseBump([{ subject: 'fix(api)!: rename', body: '' }]), 'major');
  assert.equal(chooseBump([{ subject: 'fix: x', body: 'BREAKING CHANGE: gone' }]), 'major');
  assert.equal(run({ commits: [{ subject: 'feat!: x', body: '' }] }).version, '1.0.0');
});

test('release commits and [skip release] do not release', () => {
  const release = { author: 'github-actions[bot]', subject: 'chore(release): tslaws 0.3.3', body: '' };
  assert.match(skipReason(release), /release commit/);
  assert.equal(run({ head: release }).release, false);
  assert.match(skipReason({ ...head, body: 'merge\n\n[skip release]' }), /skip release/);
  assert.equal(run({ head: { ...head, subject: 'fix: x [skip release]' } }).release, false);
  assert.equal(skipReason(head), undefined);
});

test('an existing tag makes a re-run a no-op', () => {
  const r = run({ tagExists: (t) => t === 'laws-v0.3.3' });
  assert.equal(r.release, false);
  assert.match(r.reason, /already exists/);
});

test('versions and changelog', () => {
  assert.equal(nextVersion('0.9.9', 'patch'), '0.9.10');
  assert.equal(nextVersion('0.9.9', 'minor'), '0.10.0');
  assert.throws(() => nextVersion('1.0.0-rc.1', 'patch'));
  const section = renderSection('0.3.3', [
    { subject: 'fix: a' },
    { subject: 'chore(release): tslaws 0.3.2' },
    { subject: 'feat: b' },
  ]);
  assert.equal(section, '## 0.3.3\n\n- fix: a\n- feat: b\n');
  assert.equal(renderSection('0.3.3', []), '## 0.3.3\n\n- Maintenance release.\n');
  const out = insertSection('# T\n\nIntro.\n\n## 0.3.2\n\n- old\n', section);
  assert.match(out, /Intro\.\n\n## 0\.3\.3\n\n- fix: a\n- feat: b\n\n## 0\.3\.2/);
});

test('the triggering commit decides [skip release], not a newer head', () => {
  const marked = parseMessage('Merge pull request #9\n\ndocs tweak [skip release]');
  assert.deepEqual(parseMessage('a\r\nb\r\n'), { subject: 'a', body: 'b' });
  // marker on the trigger, newer unmarked head: skip
  const a = run({ trigger: marked });
  assert.equal(a.release, false);
  assert.match(a.reason, /triggering commit says \[skip release\]/);
  // marker only on a newer head: the triggering merge still releases
  const newer = { ...head, subject: 'fix: later [skip release]' };
  assert.equal(run({ head: newer, trigger: parseMessage('fix: code merge') }).release, true);
  // no trigger (workflow_dispatch): the head marker applies
  assert.equal(run({ head: newer, trigger: undefined }).release, false);
  // release commits skip either way
  assert.equal(run({ trigger: parseMessage('chore(release): tslaws 0.3.3') }).release, false);
});
