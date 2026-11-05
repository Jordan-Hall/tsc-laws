import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  branchName,
  classifyOrphanBranch,
  decideIssue,
  decideSync,
  isSyncBranch,
  isWorkflowPushRefusal,
  issueBody,
  parseCommits,
  parseConflictFiles,
  prBody,
  prTitle,
  safeSubject,
} from './sync-upstream.mjs';

const date = new Date('2026-11-05T03:17:00Z');

test('the branch is named after the UTC date', () => {
  assert.equal(branchName(date), 'sync/upstream-2026-11-05');
  assert.equal(branchName(new Date('2026-11-05T23:59:59-05:00')), 'sync/upstream-2026-11-06');
  assert.ok(isSyncBranch('sync/upstream-2026-11-05'));
  assert.ok(!isSyncBranch('chore/sync-upstream'));
});

test('there is nothing to merge when main has every upstream commit', () => {
  assert.equal(decideSync({ behind: 0, date }).action, 'none');
  assert.equal(decideSync({ behind: Number.NaN, date }).action, 'none');
});

test('upstream commits that main lacks start a sync on a dated branch', () => {
  const decision = decideSync({ behind: 3, date });
  assert.equal(decision.action, 'sync');
  assert.equal(decision.branch, 'sync/upstream-2026-11-05');
  assert.match(decision.reason, /3 upstream commits/);
  assert.match(decideSync({ behind: 1, date }).reason, /1 upstream commit behind/);
});

test('an open sync pull request skips the sync, whatever its date', () => {
  const decision = decideSync({
    behind: 5,
    openPullRequestBranches: ['feat/laws', 'sync/upstream-2026-10-29'],
    date,
  });
  assert.equal(decision.action, 'skip');
  assert.match(decision.reason, /sync\/upstream-2026-10-29/);
});

const orphan = (name, extra = {}) => ({
  name,
  sha: `sha-of-${name}`,
  containedInMain: false,
  containsUpstreamHead: false,
  ...extra,
});

test('a sync branch already merged into main is deleted, and the sync goes on', () => {
  // The pull request was closed after its branch was merged some other way.
  const decision = decideSync({
    behind: 5,
    remoteBranches: [orphan('sync/upstream-2026-10-29', { containedInMain: true, containsUpstreamHead: true })],
    date,
  });
  assert.equal(decision.action, 'sync');
  assert.equal(decision.branch, 'sync/upstream-2026-11-05');
  assert.equal(decision.lease, undefined);
  assert.deepEqual(decision.remove, ['sync/upstream-2026-10-29']);
});

test('a closed pull request with a stale leftover branch no longer blocks the sync', () => {
  // The branch lacks the current upstream head: upstream moved on after it was pushed.
  const decision = decideSync({
    behind: 5,
    openPullRequestBranches: ['feat/laws'],
    remoteBranches: [orphan('sync/upstream-2026-10-29')],
    date,
  });
  assert.equal(decision.action, 'sync');
  assert.equal(decision.branch, 'sync/upstream-2026-11-05');
  assert.deepEqual(decision.remove, ['sync/upstream-2026-10-29']);
});

test('a pushed branch with no pull request is reused, replacing exactly the sha seen on origin', () => {
  const decision = decideSync({
    behind: 5,
    remoteBranches: [orphan('sync/upstream-2026-10-29', { containsUpstreamHead: true })],
    date,
  });
  assert.equal(decision.action, 'sync');
  assert.equal(decision.branch, 'sync/upstream-2026-10-29');
  assert.equal(decision.lease, 'sha-of-sync/upstream-2026-10-29');
  assert.deepEqual(decision.remove, []);
  assert.match(decision.reason, /reusing the sync branch sync\/upstream-2026-10-29/);
});

test('a stale branch with the name of today is replaced, not deleted', () => {
  const decision = decideSync({ behind: 2, remoteBranches: [orphan('sync/upstream-2026-11-05')], date });
  assert.equal(decision.branch, 'sync/upstream-2026-11-05');
  assert.equal(decision.lease, 'sha-of-sync/upstream-2026-11-05');
  assert.deepEqual(decision.remove, []);
});

test('with several leftover branches one complete one is reused and the rest are deleted', () => {
  const decision = decideSync({
    behind: 2,
    remoteBranches: [
      orphan('sync/upstream-2026-10-15'),
      orphan('sync/upstream-2026-10-22', { containsUpstreamHead: true }),
      orphan('sync/upstream-2026-10-29', { containedInMain: true, containsUpstreamHead: true }),
    ],
    date,
  });
  assert.equal(decision.branch, 'sync/upstream-2026-10-22');
  assert.deepEqual(decision.remove, ['sync/upstream-2026-10-15', 'sync/upstream-2026-10-29']);
});

test('leftover branches are judged by what they contain', () => {
  assert.equal(classifyOrphanBranch({ containedInMain: true, containsUpstreamHead: true }), 'delete');
  assert.equal(classifyOrphanBranch({ containedInMain: false, containsUpstreamHead: false }), 'delete');
  assert.equal(classifyOrphanBranch({ containedInMain: false, containsUpstreamHead: true }), 'reuse');
});

test('only an open pull request blocks a sync, and no branch is touched then', () => {
  const decision = decideSync({
    behind: 5,
    openPullRequestBranches: ['sync/upstream-2026-10-29'],
    remoteBranches: [orphan('sync/upstream-2026-10-29', { containsUpstreamHead: true })],
    date,
  });
  assert.equal(decision.action, 'skip');
  assert.equal(decision.remove, undefined);
});

test('other branches and pull requests do not block a sync', () => {
  const decision = decideSync({
    behind: 2,
    openPullRequestBranches: ['feat/delegated-accept', 'chore/sync-upstream'],
    remoteBranches: [],
    date,
  });
  assert.equal(decision.action, 'sync');
});

test('nothing to merge wins over a blocking pull request', () => {
  assert.equal(decideSync({ behind: 0, openPullRequestBranches: ['sync/upstream-2026-10-29'], date }).action, 'none');
});

test('an open upstream-sync issue means no second issue', () => {
  assert.equal(decideIssue({ openIssueNumbers: [] }).action, 'create');
  assert.equal(decideIssue({}).action, 'create');
  const decision = decideIssue({ openIssueNumbers: [12, 14] });
  assert.equal(decision.action, 'skip');
  assert.match(decision.reason, /#12/);
});

test('conflicting files are listed once, sorted', () => {
  const output = 'packages/tsc-ts/src/main.ts\r\npackages/tsc-ts/package.json\n\npackages/tsc-ts/src/main.ts\n';
  assert.deepEqual(parseConflictFiles(output), ['packages/tsc-ts/package.json', 'packages/tsc-ts/src/main.ts']);
  assert.deepEqual(parseConflictFiles(''), []);
});

test('a push refused for workflow files is told from other failures', () => {
  assert.ok(
    isWorkflowPushRefusal(
      '! [remote rejected] x -> x (refusing to allow a GitHub App to create or update workflow `.github/workflows/ci.yml` without `workflows` permission)',
    ),
  );
  assert.ok(!isWorkflowPushRefusal('fatal: unable to access: Could not resolve host'));
  assert.ok(!isWorkflowPushRefusal('! [rejected] x -> x (non-fast-forward)'));
});

test('commit subjects notify nobody and link to the upstream repository', () => {
  assert.equal(safeSubject('Thanks @someone (#42)'), 'Thanks @​someone (vercel-labs/tsc-ts#42)');
  assert.equal(safeSubject('Fix a/b#7 and #8'), 'Fix a/b#7 and vercel-labs/tsc-ts#8');
  assert.equal(safeSubject('Plain subject'), 'Plain subject');
});

test('git log lines become commits', () => {
  assert.deepEqual(parseCommits('abc1234\tFix the thing\ndef5678\tTabs\tin the subject\n'), [
    { hash: 'abc1234', subject: 'Fix the thing' },
    { hash: 'def5678', subject: 'Tabs\tin the subject' },
  ]);
});

test('the pull request lists the new upstream commits and says how to merge', () => {
  const commits = [
    { hash: 'abc1234', subject: 'Prepare v0.1.2 (#9)' },
    { hash: 'def5678', subject: 'Fix the checker' },
  ];
  const body = prBody({ commits, total: 2 });
  assert.match(body, /Merges 2 new commits/);
  assert.match(body, /- `abc1234` Prepare v0\.1\.2 \(vercel-labs\/tsc-ts#9\)/);
  assert.match(body, /merge commit/);
  assert.equal(prTitle(date, 2), 'chore: sync with upstream tsc-ts (2026-11-05, 2 commits)');
  assert.equal(prTitle(date, 1), 'chore: sync with upstream tsc-ts (2026-11-05, 1 commit)');
});

test('a long list of commits is cut and says how many more', () => {
  const commits = Array.from({ length: 130 }, (_, i) => ({ hash: `h${i}`, subject: `commit ${i}` }));
  const body = prBody({ commits, total: 130 });
  assert.equal(body.split('\n').filter((line) => line.startsWith('- `h')).length, 100);
  assert.match(body, /- and 30 more/);
});

test('the conflict issue lists the files', () => {
  const body = issueBody({ files: ['a.ts', 'b.ts'], commits: [{ hash: 'abc1234', subject: 'x' }], total: 7 });
  assert.match(body, /conflicts in 2 files/);
  assert.match(body, /- `a\.ts`\n- `b\.ts`/);
  assert.match(body, /lacks 7 upstream commits/);
});
