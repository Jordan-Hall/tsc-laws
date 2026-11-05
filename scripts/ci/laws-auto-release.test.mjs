import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  chooseBump,
  classifyPushFailure,
  hasCodeChange,
  insertSection,
  nextVersion,
  parseMessage,
  releaseNotes,
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

test('release notes are the version section without its heading', () => {
  const log = '# T\n\nIntro.\n\n## 0.3.3\n\n- fix: a\n- feat: b\n\n## 0.3.2\n\n- old\n';
  assert.equal(releaseNotes(log, '0.3.3'), '- fix: a\n- feat: b\n');
  assert.equal(releaseNotes(log, '0.3.2'), '- old\n');
  assert.equal(releaseNotes(log.replaceAll('\n', '\r\n'), '0.3.3'), '- fix: a\n- feat: b\n');
  // a missing section, a version that is only a prefix of another, and an empty section give nothing
  assert.equal(releaseNotes(log, '0.3'), undefined);
  assert.equal(releaseNotes(log, '9.9.9'), undefined);
  assert.equal(releaseNotes('## 1.0.0\n\n## 0.9.0\n\n- x\n', '1.0.0'), undefined);
});

test('classifyPushFailure: a repository rule violation is protected', () => {
  const log = [
    'remote: error: GH013: Repository rule violations found for refs/heads/main.',
    'remote: - Changes must be made through a pull request.',
    'To https://github.com/Jordan-Hall/tsc-laws',
    ' ! [remote rejected] HEAD -> main (push declined due to repository rule violations)',
    ' ! [remote rejected] laws-v0.6.5 -> laws-v0.6.5 (atomic transaction failed)',
    'error: failed to push some refs to https://github.com/Jordan-Hall/tsc-laws',
  ].join('\n');
  assert.equal(classifyPushFailure(log), 'protected');
});

test('classifyPushFailure: a non-fast-forward push means main moved', () => {
  const log = [
    'To https://github.com/Jordan-Hall/tsc-laws',
    ' ! [rejected]        HEAD -> main (fetch first)',
    ' ! [rejected]        laws-v0.6.5 -> laws-v0.6.5 (atomic push failed)',
    'hint: Updates were rejected because the remote contains work that you do not have locally. (non-fast-forward)',
  ].join('\n');
  assert.equal(classifyPushFailure(log), 'moved');
  assert.equal(classifyPushFailure(' ! [rejected] HEAD -> main (stale info)'), 'moved');
});

test('classifyPushFailure: a network or auth error is other', () => {
  assert.equal(
    classifyPushFailure(
      "fatal: unable to access 'https://github.com/Jordan-Hall/tsc-laws/': Could not resolve host: github.com",
    ),
    'other',
  );
  assert.equal(classifyPushFailure('remote: Invalid username or password.\nfatal: Authentication failed'), 'other');
});

test('classifyPushFailure: empty or missing output is other', () => {
  assert.equal(classifyPushFailure(''), 'other');
  assert.equal(classifyPushFailure(undefined), 'other');
});
