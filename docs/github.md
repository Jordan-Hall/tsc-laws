# Accepting laws on GitHub

When `tslaws.json` has a `github` section, `tsc-laws.lock` is written in one place only: the tslaws workflow on your
main branch, after a pull request merges. `tslaws accept` refuses to run, and no pull request edits the lock.

A pull request can add, change or remove a law, move a law to another level, or add or remove a coverage exemption. Each
such change is a **proposal**. Proposals run like every other law, so the pull request shows what each one _would_ be if
accepted: proved, bounded, tested, or failed with a counterexample. `tslaws check` still fails on proposals (they show as
`tampered`) until they are in the lock. A proposal is never a law until CI accepts it.

```jsonc
// tslaws.json
{
  "github": {
    "accept": "merge", // "merge": every passing proposal is accepted on merge (default)
    // "comment": a proposal also needs `/tslaws accept` from an approver
    "branch": "master", // the branch whose pushes write the lock (default "master")
    "bot": "tslaws-acme[bot]", // who writes the lock (default "github-actions[bot]"; see "Choosing the bot")
    "approvers": ["author", "reviewers"], // comment mode: who may accept; each also needs write access
    "requirePassing": true, // a failing proposal is never accepted (default true)
    "approvePullRequest": false, // comment mode: approve the pull request once every proposal is accepted
  },
}
```

## Choosing the bot

| `bot`                            | Works with                        | Setup                                    | What stops a forged lock                                 |
| -------------------------------- | --------------------------------- | ---------------------------------------- | -------------------------------------------------------- |
| `github-actions[bot]` (default)  | `accept: "merge"` only            | none: the merge job uses `github.token`  | the ruleset on `branch` alone                            |
| a GitHub App (`<app-slug>[bot]`) | `accept: "merge"` and `"comment"` | create the app, store its key as secrets | the ruleset, and `merge` checks every lock commit itself |

Every workflow's token acts as `github-actions[bot]`, including jobs that run a pull request's code. So with the default,
a pull request could post comments that look like the bot's, and `accept: "comment"` refuses it. In merge mode no
approval records are read, but `merge` cannot tell the tslaws job's lock commits from any other workflow's, so the
ruleset in "Making it impossible to bypass" must be in place. `merge` prints a warning on every run until `bot` is an
app.

With the default bot, give the merge job `permissions: { contents: write, pull-requests: write }` and pass
`token: '${{ github.token }}'` instead of the app token.

## On the pull request

`tslaws github report` puts an annotation on the line of each proposal and keeps one comment up to date:

| Law                | Change      | If accepted                      | State                      |
| ------------------ | ----------- | -------------------------------- | -------------------------- |
| `double is a sum`  | law added   | ✅ proved                        | ⏳ accepted on merge       |
| `double is bigger` | law changed | ❌ failed — counterexample `[0]` | 🚫 rejected while it fails |

The check fails when an accepted law fails or a proposal fails. In comment mode, it also fails while a proposal waits
for an accept.

In comment mode, an approver writes one of these comments:

```
/tslaws accept all
/tslaws accept `double is a sum` src/other.laws.ts::keeps
/tslaws reject `double is a sum`
/tslaws accept all @1a2b3c4      # only if the pull request is still at that commit
```

The bot replies with a record of exactly which version of each law was accepted. If a law is edited after it was
accepted, it needs a new accept. Records in comments that the bot did not write are ignored. Bots cannot accept laws.
If a bot opened the pull request, its author cannot accept them either.

## On merge

`tslaws github merge` runs on every push to `branch`. It runs the laws on the merged code and accepts each proposal
that passes. In comment mode, a proposal must also have an accept for that exact version. The job commits
`tsc-laws.lock` through the contents API, so GitHub signs the commit as the bot. It comments on the pull request with
what it accepted and what it held. If it holds a proposal, the run fails, and `tslaws check` keeps failing on `branch`
until the proposal is fixed or removed.

## Workflows

The report job runs the pull request's code, so it only advises. The decision is made on the trusted branch. tslaws
removes `GITHUB_TOKEN` from its environment before it runs any law, so a law under test cannot use the token.

The action always runs the `tslaws` installed in `tslaws-root` (default: the workspace root) by path. It never looks
`tslaws` up from `working-directory`, so in the command job, where `working-directory` is the pull request's files,
nothing from the pull request runs: not a committed `node_modules/.bin`, not an `.npmrc`. With `--config-from`, tslaws
also refuses a compiler found among the pull request's files.

```yaml
# .github/workflows/tslaws-pr.yml
name: tslaws
on: pull_request
permissions: { contents: read, pull-requests: write }
jobs:
  report:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with: { node-version: 22, cache: npm }
      - run: npm ci
      - uses: Jordan-Hall/tsc-laws/packages/tslaws/github@main
        with: { mode: report, token: '${{ github.token }}', args: --comment }
```

```yaml
# .github/workflows/tslaws-verify.yml — runs the base branch's code; the pull request's files are never executed
name: tslaws verify
on: pull_request_target
permissions: { contents: read, pull-requests: read }
jobs:
  verify:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4 # the base branch
      - uses: actions/setup-node@v4
        with: { node-version: 22, cache: npm }
      - run: npm ci
      - uses: Jordan-Hall/tsc-laws/packages/tslaws/github@main
        with:
          mode: verify
          token: '${{ github.token }}'
          args: --protect .github/workflows/tslaws-pr.yml,.github/workflows/tslaws-verify.yml,.github/workflows/tslaws-command.yml,.github/workflows/tslaws-merge.yml
```

```yaml
# .github/workflows/tslaws-command.yml — comment mode only
name: tslaws command
on:
  issue_comment: { types: [created] }
permissions: { contents: read, pull-requests: read }
jobs:
  command:
    if: >-
      github.event.issue.pull_request && startsWith(github.event.comment.body, '/tslaws') &&
      contains(fromJSON('["OWNER","MEMBER","COLLABORATOR"]'), github.event.comment.author_association)
    runs-on: ubuntu-latest
    steps:
      - uses: actions/create-github-app-token@v1
        id: app
        with: { app-id: '${{ vars.TSLAWS_APP_ID }}', private-key: '${{ secrets.TSLAWS_APP_KEY }}' }
      - uses: actions/checkout@v4 # the default branch: trusted tools and config
      - uses: actions/setup-node@v4
        with: { node-version: 22, cache: npm }
      - run: npm ci
      - id: pr
        run: echo "sha=$(gh pr view ${{ github.event.issue.number }} --json headRefOid -q .headRefOid)" >> "$GITHUB_OUTPUT"
        env: { GH_TOKEN: '${{ github.token }}' }
      - uses: actions/checkout@v4 # the pull request's files, read as data only (no npm ci, no scripts)
        with: { ref: '${{ steps.pr.outputs.sha }}', path: pr, persist-credentials: false }
      - uses: Jordan-Hall/tsc-laws/packages/tslaws/github@main
        with:
          mode: command
          working-directory: pr
          token: '${{ steps.app.outputs.token }}'
          args: --config-from .. --head-sha ${{ steps.pr.outputs.sha }} --rerun-workflow tslaws-pr.yml
```

```yaml
# .github/workflows/tslaws-merge.yml
name: tslaws merge
on:
  push: { branches: [master] }
concurrency: { group: tslaws-lock, cancel-in-progress: false }
permissions: { contents: read }
jobs:
  merge:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/create-github-app-token@v1
        id: app
        with: { app-id: '${{ vars.TSLAWS_APP_ID }}', private-key: '${{ secrets.TSLAWS_APP_KEY }}' }
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with: { node-version: 22, cache: npm }
      - run: npm ci
      - uses: Jordan-Hall/tsc-laws/packages/tslaws/github@main
        with: { mode: merge, token: '${{ steps.app.outputs.token }}' }
```

With an app, set `bot` to its login (`<app-slug>[bot]`). The app needs these permissions: **Contents: write**, **Pull
requests: write**, **Issues: write** and **Actions: write** (Actions is for `--rerun-workflow`).

## Making it impossible to bypass

The workflows protect nothing if people can write the lock some other way. Set up GitHub so they cannot:

1. **A ruleset on `master`** that restricts the file path `tsc-laws.lock` (push rules), with the tslaws app as the only
   bypass actor. Require pull requests for everything else.
2. **Required status checks**: `tslaws / report` and `tslaws verify / verify`.
3. **CODEOWNERS** for `tsc-laws.lock`, `tslaws.json` and `.github/workflows/tslaws-*.yml`, with code-owner review
   required.
4. Keep the app's private key in an environment or organisation secret that pull-request workflows cannot read.

`verify` fails a pull request in these cases:

- the pull request's diff changes the lock (the bot never commits to a pull request's branch);
- the `github` section of `tslaws.json` changes;
- a `--protect` path changes.

`merge` accepts nothing when a push to `branch` changes the lock and is not made only of commits that GitHub shows as
the bot's, with signatures it verified. It compares the lock before and after the push, so a truncated push payload
cannot hide a change.

## Monorepos

To run `check`, `list` and the other commands across every package from the root, see [monorepo.md](monorepo.md).

The project (`tslaws.json` and `tsc-laws.lock`) need not sit at the repository root. Keep one `tslaws.json` per package
and run `merge` for each package, one after another, in a single job. Do not use a matrix with a job-level concurrency
group: a group holds one pending job, so with three or more packages GitHub cancels the jobs waiting behind the first.

```yaml
name: tslaws merge
on:
  push: { branches: [master] }
concurrency: { group: tslaws-lock, cancel-in-progress: false }
permissions: { contents: read }
jobs:
  merge:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/create-github-app-token@v1
        id: app
        with: { app-id: '${{ vars.TSLAWS_APP_ID }}', private-key: '${{ secrets.TSLAWS_APP_KEY }}' }
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with: { node-version: 22, cache: npm }
      - run: npm ci
      - name: Accept each package's proposals
        env: { GITHUB_TOKEN: '${{ steps.app.outputs.token }}' }
        run: |
          failed=0
          for dir in packages/ui apps/core/auth; do
            (cd "$dir" && node "$GITHUB_WORKSPACE/node_modules/tslaws/bin/tslaws.js" github merge) || failed=1
          done
          exit "$failed"
```

The workflow-level group still keeps only the newest pending run when pushes arrive quickly. That loses nothing: `merge`
compares the laws at the branch head with the lock, so the run that does go ahead accepts every proposal that is still
outstanding, including those from the pushes whose runs were replaced. Run every package each time, or pick the
packages by diffing against the last commit a successful run checked, never only against the push's `before`.

`tslaws github` finds the project's place in the repository with `git rev-parse --show-prefix`; pass
`--project-path <dir>` to name it yourself. Every lock and config path, every annotation and every link then starts
with that directory. Each job commits only its own lock, checks only its own lock for outside changes (another
project's bot commit never blocks it), and starts from the current lock on the branch, so a job that runs after another
one still writes. `report` keeps one comment per project, headed with the project's path; a root project's comment is
unchanged. `--protect` paths stay relative to the repository root. In the ruleset, restrict `**/tsc-laws.lock`.

## Limits

- Pull requests from forks get a read-only token, so `report` cannot write its comment. The annotations and the step
  summary still show every proposal.
- In comment mode, a pull request's author can accept their own proposals when `approvers` includes `author`. Remove
  `author` if a second person must accept. An agent that opens pull requests under a person's account counts as that
  person.
