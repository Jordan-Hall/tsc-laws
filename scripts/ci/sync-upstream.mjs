// Brings vercel-labs/tsc-ts main into this fork. The sync-upstream workflow runs it every week.
//
//   node scripts/ci/sync-upstream.mjs [--dry-run]
//
// It fetches upstream main. If upstream has commits that main lacks, it merges them into a branch named
// `sync/upstream-<date>`, pushes that branch and opens a pull request into main. If the merge conflicts, it opens an
// issue (labelled `upstream-sync`) that lists the conflicting files. It never pushes to main and never publishes.
// With --dry-run it only fetches and prints what it would do.
//
// The decisions are plain functions, tested in sync-upstream.test.mjs. `git` and `gh` run only from `main()`.
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

export const upstreamUrl = 'https://github.com/vercel-labs/tsc-ts.git';
export const branchPrefix = 'sync/upstream-';
export const issueLabel = 'upstream-sync';
const maxListed = 100;

/** `2026-11-05` for a Date, in UTC. */
export function isoDate(date) {
  return date.toISOString().slice(0, 10);
}

/** The branch a sync on `date` uses. */
export function branchName(date) {
  return `${branchPrefix}${isoDate(date)}`;
}

/** True when `name` is a branch this workflow made. */
export function isSyncBranch(name) {
  return name.startsWith(branchPrefix);
}

/**
 * What to do with the state of the repository.
 * - `behind`: the number of upstream commits main lacks.
 * - `openPullRequestBranches`: head branches of open pull requests.
 * - `remoteBranches`: branches on origin.
 * Gives `{ action: 'none' | 'skip' | 'sync', reason, branch? }`.
 */
export function decideSync({ behind, openPullRequestBranches = [], remoteBranches = [], date }) {
  if (!(behind > 0)) return { action: 'none', reason: 'main already has every upstream commit' };
  const openPullRequest = openPullRequestBranches.find(isSyncBranch);
  if (openPullRequest !== undefined) {
    return { action: 'skip', reason: `the open sync pull request from ${openPullRequest} is not merged yet` };
  }
  const existing = remoteBranches.find(isSyncBranch);
  if (existing !== undefined) {
    return { action: 'skip', reason: `the sync branch ${existing} already exists on origin` };
  }
  return {
    action: 'sync',
    reason: `main is ${behind} upstream commit${behind === 1 ? '' : 's'} behind`,
    branch: branchName(date),
  };
}

/** Whether to open an issue for a conflict: not when an open issue with the label exists already. */
export function decideIssue({ openIssueNumbers = [] }) {
  if (openIssueNumbers.length > 0) {
    return { action: 'skip', reason: `issue #${openIssueNumbers[0]} about the upstream sync is still open` };
  }
  return { action: 'create', reason: 'no open upstream-sync issue' };
}

/** The file names in `git diff --name-only --diff-filter=U` output. */
export function parseConflictFiles(output) {
  return [
    ...new Set(
      output
        .split(/\r?\n/)
        .map((line) => line.trim())
        .filter(Boolean),
    ),
  ].sort();
}

/** True when a failed push was refused because the branch changes a workflow file and the token may not. */
export function isWorkflowPushRefusal(stderr) {
  return /workflow/i.test(stderr) && /(refus|reject|denied|declined|without)/i.test(stderr);
}

/**
 * A commit subject safe to put in a pull request or issue: `@name` does not notify anyone and `#123` points at the
 * upstream repository, not at this one.
 */
export function safeSubject(subject) {
  return subject.replace(/@(?=[\w-])/g, '@​').replace(/(^|[^\w/])#(\d+)/g, '$1vercel-labs/tsc-ts#$2');
}

/** Parses `git log --format=%h%x09%s` lines into `{ hash, subject }`. */
export function parseCommits(output) {
  return output
    .split(/\r?\n/)
    .filter(Boolean)
    .map((line) => {
      const [hash, ...rest] = line.split('\t');
      return { hash, subject: rest.join('\t') };
    });
}

function commitLines(commits) {
  const lines = commits.slice(0, maxListed).map(({ hash, subject }) => `- \`${hash}\` ${safeSubject(subject)}`);
  if (commits.length > maxListed) lines.push(`- and ${commits.length - maxListed} more`);
  return lines.join('\n');
}

export function prTitle(date, count) {
  return `chore: sync with upstream tsc-ts (${isoDate(date)}, ${count} commit${count === 1 ? '' : 's'})`;
}

export function prBody({ commits, total }) {
  return [
    `Merges ${total} new commit${total === 1 ? '' : 's'} of [vercel-labs/tsc-ts](https://github.com/vercel-labs/tsc-ts) main:`,
    '',
    commitLines(commits),
    '',
    'The merge is clean. Review it, then merge it with a merge commit (not a squash or rebase), so the next sync sees these commits as merged.',
    '',
    "Upstream version bumps do not apply to `tslaws` or `vscode-tslaws`; their versions are this fork's own.",
    'GitHub does not start workflows for a pull request opened with the default token: close and reopen it, or push to the branch, to run the checks.',
  ].join('\n');
}

export function issueTitle(date) {
  return `Upstream sync (${isoDate(date)}) has merge conflicts`;
}

export function issueBody({ files, commits, total }) {
  return [
    `Merging [vercel-labs/tsc-ts](https://github.com/vercel-labs/tsc-ts) main into main conflicts in ${files.length} file${files.length === 1 ? '' : 's'}:`,
    '',
    ...files.map((file) => `- \`${file}\``),
    '',
    `Main lacks ${total} upstream commit${total === 1 ? '' : 's'}. The newest:`,
    '',
    commitLines(commits.slice(0, 20)),
    '',
    'Resolve it by hand (see "Syncing with upstream" in RELEASING-LAWS.md):',
    '',
    '```sh',
    'git fetch https://github.com/vercel-labs/tsc-ts.git main:refs/remotes/upstream/main',
    'git switch -c chore/sync-upstream origin/main',
    'git merge upstream/main',
    '```',
    '',
    'The weekly job opens no new issue while this one is open. Close it once the merge is in main.',
  ].join('\n');
}

export function issueBodyForPushRefusal({ branch, total, commits }) {
  return [
    `The weekly sync merged ${total} upstream commit${total === 1 ? '' : 's'} cleanly into \`${branch}\`, but GitHub refused the push.`,
    'The merge changes files in `.github/workflows`, and the default `GITHUB_TOKEN` may not push those.',
    '',
    commitLines(commits.slice(0, 20)),
    '',
    'Merge it by hand (see "Syncing with upstream" in RELEASING-LAWS.md):',
    '',
    '```sh',
    'git fetch https://github.com/vercel-labs/tsc-ts.git main:refs/remotes/upstream/main',
    'git switch -c chore/sync-upstream origin/main',
    'git merge upstream/main',
    'git push -u origin chore/sync-upstream',
    '```',
    '',
    'The weekly job opens no new issue while this one is open. Close it once the merge is in main.',
  ].join('\n');
}

// Everything below runs git and gh.

function run(command, args, { allowFailure = false, input } = {}) {
  const result = spawnSync(command, args, { encoding: 'utf8', input, stdio: ['pipe', 'pipe', 'pipe'] });
  if (result.error) throw result.error;
  if (result.status !== 0 && !allowFailure) {
    throw new Error(`${command} ${args.join(' ')} failed:\n${result.stderr}${result.stdout}`);
  }
  return { status: result.status, stdout: result.stdout, stderr: result.stderr };
}

const git = (args, options) => run('git', args, options);
const gh = (args, options) => run('gh', args, options);

function withBodyFile(body, use) {
  const dir = mkdtempSync(join(tmpdir(), 'sync-upstream-'));
  try {
    const file = join(dir, 'body.md');
    writeFileSync(file, body);
    return use(file);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

function openIssue({ title, body }) {
  gh([
    'label',
    'create',
    issueLabel,
    '--description',
    'Merging upstream tsc-ts needs attention',
    '--color',
    'ededed',
    '--force',
  ]);
  withBodyFile(body, (file) => gh(['issue', 'create', '--title', title, '--label', issueLabel, '--body-file', file]));
}

function reportIssue({ title, body, dryRun }) {
  const list = JSON.parse(gh(['issue', 'list', '--label', issueLabel, '--state', 'open', '--json', 'number']).stdout);
  const decision = decideIssue({ openIssueNumbers: list.map((issue) => issue.number) });
  console.log(`issue: ${decision.action} (${decision.reason})`);
  if (decision.action === 'create' && !dryRun) openIssue({ title, body });
}

export function main(argv = process.argv.slice(2), now = new Date()) {
  const dryRun = argv.includes('--dry-run');
  const url = process.env.UPSTREAM_URL || upstreamUrl;

  git(['fetch', '--no-tags', 'origin', '+main:refs/remotes/origin/main']);
  git(['fetch', '--no-tags', url, '+main:refs/remotes/upstream/main']);

  const behind = Number(git(['rev-list', '--count', 'origin/main..upstream/main']).stdout.trim());
  const pullRequests = JSON.parse(
    gh(['pr', 'list', '--state', 'open', '--json', 'headRefName', '--limit', '200']).stdout,
  );
  const remoteBranches = git(['ls-remote', '--heads', 'origin', `${branchPrefix}*`])
    .stdout.split(/\r?\n/)
    .filter(Boolean)
    .map((line) => line.split('\t')[1].replace(/^refs\/heads\//, ''));

  const decision = decideSync({
    behind,
    openPullRequestBranches: pullRequests.map((pr) => pr.headRefName),
    remoteBranches,
    date: now,
  });
  console.log(`sync: ${decision.action} (${decision.reason})`);
  if (decision.action !== 'sync' || dryRun) return 0;

  const commits = parseCommits(git(['log', '--format=%h%x09%s', '--no-merges', 'origin/main..upstream/main']).stdout);
  const branch = decision.branch;
  git(['switch', '--detach', 'origin/main']);
  git(['switch', '-C', branch]);
  const merge = git(['merge', '--no-ff', '-m', `Merge upstream tsc-ts main (${isoDate(now)})`, 'upstream/main'], {
    allowFailure: true,
  });
  if (merge.status !== 0) {
    const files = parseConflictFiles(git(['diff', '--name-only', '--diff-filter=U']).stdout);
    git(['merge', '--abort'], { allowFailure: true });
    if (files.length === 0) throw new Error(`git merge failed without conflicts:\n${merge.stderr}${merge.stdout}`);
    console.log(`conflicts: ${files.join(', ')}`);
    reportIssue({ title: issueTitle(now), body: issueBody({ files, commits, total: behind }), dryRun });
    return 0;
  }

  const push = git(['push', 'origin', `${branch}:refs/heads/${branch}`], { allowFailure: true });
  if (push.status !== 0) {
    if (!isWorkflowPushRefusal(push.stderr)) throw new Error(`git push failed:\n${push.stderr}${push.stdout}`);
    console.log('push refused: the merge changes workflow files');
    reportIssue({
      title: issueTitle(now).replace('has merge conflicts', 'needs a manual merge'),
      body: issueBodyForPushRefusal({ branch, total: behind, commits }),
      dryRun,
    });
    return 0;
  }

  withBodyFile(prBody({ commits, total: behind }), (file) =>
    gh(['pr', 'create', '--base', 'main', '--head', branch, '--title', prTitle(now, behind), '--body-file', file]),
  );
  console.log(`opened a pull request from ${branch}`);
  return 0;
}

if (process.argv[1] && resolve(process.argv[1]) === import.meta.filename) {
  process.exit(main());
}
