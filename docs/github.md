# Accepting laws on GitHub

When `tslaws.json` has a `github` section, the tslaws workflow writes `tsc-laws.lock` on your main branch: after a pull
request merges, or on demand when a maintainer runs it. A person can also change the lock by hand while `local` is true
(the default): see "Accepting by hand". Set `local` to false to make the workflow the only writer: `tslaws accept`
then refuses to run, and no pull request edits the lock.

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
    "flow": "shared", // monorepo: "own" keeps this package out of the root's report, merge and command (see "Monorepos")
    "local": true, // a person may also accept by hand, or merge a pull request that changes the lock (default true)
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

### What a merge runs

A merge only acts on laws the lock does not record as they are: new laws, edited laws and laws whose dependencies
changed. It compares the laws on the merged code with the lock first, and runs only those laws, in the same sandboxed
child as before. The coverage analysis is left out of that run.

- When the lock already records every law (the usual merge: the pull request changed code, not laws), no law runs, the
  lock is not written and no comment is posted. The run takes seconds, not a full test run.
- When some laws changed, only those laws run. A project with hundreds of laws and three new ones runs three.
- A removal or an exemption runs nothing: the merged lock is computed from the files. A level change runs the law, as a
  changed law does.
- A run with nothing to prove still compiles the project and checks that the sandbox can be enforced, so a project that
  does not build, or a Node that cannot sandbox the laws, fails the run as it always did.

Nothing from the pull request counts as proof. A report comment from a pull request run is never read, because that
run executes the pull request's own code and can write what it likes. The merge re-proves each changed law on the
merged code, and the result is checked against the laws the merge computed itself: a result for a law that is not in
the project, or a missing result for a law that had to run, is an error, and nothing is accepted. A law that fails,
and a proposal that comment mode has no accept for, is held exactly as before.

In the two-job flow, the `laws` job runs the changed laws and `--results` hands the report to the `merge` job. A
project with no changed laws has no report, and the `merge` job treats that as nothing to accept. If the `merge` job
finds a changed law that the `laws` job did not report (a report that is missing or short), it holds that law with the
reason "changed after the laws job ran" and accepts nothing for it: run the workflow again.

### Keeping merge runs short

- Add `paths-ignore` for files that cannot change a law, such as docs, to the `push` trigger of the merge workflow.
- Make the lock commit not start the workflow again. A commit made with `GITHUB_TOKEN` does not start workflows. A
  commit made with an app token does, and that run finds nothing to do, but it still pays for a runner and an install.
  Add `paths-ignore: [tsc-laws.lock]` to the merge workflow, or skip the job when the head commit is the bot's own lock
  commit.
- In a monorepo, choose the projects to run by what changed, not by which projects succeeded last time. A project that
  holds a proposal fails every run, so a "last successful run" base is the first commit and every project runs.
- Keep the `laws` job's cache for `node_modules`. The `merge` job must not use one.

## On demand

`tslaws github merge` also runs on `workflow_dispatch`. Use it when the workflow could not run for a while and the lock
fell behind, or to accept without a push. The person who starts the run must have `admin` or `maintain` access to the
repository, and the run must be on `branch`. On a re-run, both the person who first started the workflow
(`GITHUB_ACTOR`) and the person who re-ran it (`GITHUB_TRIGGERING_ACTOR`) must have that access, and the commit names
the second. The run also builds on the lock as `branch` holds it, so the latest commit that changed `tsc-laws.lock` must
be the bot's (with a verified signature) or, with `local` true, a maintainer's merged pull request (see "Accepting by
hand"). Otherwise it accepts nothing and says which commit to revert or to merge again through a maintainer's pull
request. The run must also still be at the head of `branch`, read from the API: if the branch moved while the run was
queued, it accepts nothing and says so, and you run it again. It runs the laws at the head of `branch`, accepts every
proposal that passes, and commits `tsc-laws.lock` as the bot. There is no pull request, so it posts no comment; it prints what it
accepted to the job log and the step summary. In comment mode, the person who started the run takes the place of the
`/tslaws accept` records. `requirePassing` still applies. Add the trigger to the merge workflow:

```yaml
on:
  push: { branches: [master] }
  workflow_dispatch:
```

## Accepting by hand

With `local` true, a person can accept without the workflow:

1. Write a `*.proposed.laws.ts` file, then run `tslaws promote` and `tslaws accept` on your machine. `accept` has the
   same gate as in any project: a person at a terminal, or a live delegation, never under `CI`.
2. Commit the lock and open a pull request. `verify` lets a pull request change `tsc-laws.lock` when its author has
   `admin` or `maintain` access (read from the base branch's `tslaws.json`) and so does the author of every commit in
   the pull request that changes the lock; from anyone else it still fails.
3. When the pull request merges, `merge` accepts that lock change as it stands, then goes on as usual: it accepts the
   passing proposals that are still outstanding, relative to the lock now on the branch. It finds the pull request with
   the commit's `/pulls` and checks that it was merged into `branch`, that its author and the person who merged it have
   `admin` or `maintain` access, and that the commit's own GitHub author does too
   (committing someone else's change, by a rebase or cherry-pick, does not count). A lock commit that is
   neither the bot's (with a verified signature) nor from such a pull request still makes `merge` accept nothing.

## Workflows

The report job runs the pull request's code, so it only advises. The decision is made on the trusted branch.

### What keeps a token from the laws

A law, and any module a law imports, is code a pull request wrote. `report` and `merge` guarantee this about it:

- **Its own process has no credentials.** Every law runs in a child process that starts with an allowlisted
  environment: `PATH`, `HOME`, `USERPROFILE`, the temporary-directory and locale variables, `CI`, `NODE_ENV`,
  `TSC_LAWS_*`, `TSLAWS_*` and `TSC_TS_*`. `GITHUB_*`, `GH_*`, `ACTIONS_*`, `RUNNER_*`, and any name that looks like a
  credential (`*TOKEN*`, `*SECRET*`, `*PASSWORD*`, `*_KEY`) are dropped, and `NODE_OPTIONS` keeps only memory limits. So
  `process.env` and `/proc/self/environ` in a law hold no token. The process that talks to GitHub receives the laws'
  reports as plain data and only then comments or writes the lock. A law that reads another variable needs it named
  with a `TSLAWS_` prefix.
- **Its report is rebuilt, not trusted.** Each result is copied field by field, with a length cap on every string
  and a range on every number, and anything else is dropped. The results must name exactly the laws that the process
  holding the token finds in the pull request itself, plus the removals, exemptions and uncovered functions its own
  view of the lock allows: an extra, missing or repeated law refuses the whole report. The hash of each law, and every
  other thing the lock records, comes from the process holding the token, never from the laws. **Certificates are
  dropped**: a lock written by `merge` records none, so a law proved with `certify` is uncertified there until a person
  runs `tslaws accept` with the checkers installed.
- **With the workflows below, it never runs beside the token.** The laws run in a job that holds no token, and its
  checkout has `persist-credentials: false`, so `.git/config` holds none either. A second job, which runs none of the
  pull request's code, downloads the reports as an artifact and does the GitHub work. In the `merge` job that tslaws is
  a pinned release installed on its own, never the one the branch's lockfile installs, and the branch's packages are
  installed with `--ignore-scripts`, so no code from the branch runs there. The app's token is minted after every step
  that installs anything.

What this does not do. A process that runs as the same user can read the environment of the other processes and the
files of the checkout, so a single job that holds the token while the laws run is protected from `process.env` reads
but not from a determined law: run the two jobs. The reports are data that the laws' job produced, so a law can lie
about its own result; the token stays safe, and the lock still records only what a person, or the `merge` flow,
accepts for that exact version of the law. Files in the workspace and the home directory (an `.npmrc` with a registry
token, for example) are readable by laws, so keep credentials out of the laws job. The job that holds the token still
compiles the pull request's files and reads their config and lock, as data. If you change the `merge` job to install
`tslaws` from the branch's lockfile, or to run its install scripts, the branch controls the code that holds the token,
and none of the above holds.

The action always runs the `tslaws` installed in `tslaws-root` (default: the workspace root) by path. It never looks
`tslaws` up from `working-directory`, so in the command job, where `working-directory` is the pull request's files,
nothing from the pull request runs: not a committed `node_modules/.bin`, not an `.npmrc`. With `--config-from`, tslaws
also refuses a compiler found among the pull request's files.

```yaml
# .github/workflows/tslaws-pr.yml
name: tslaws
on: pull_request
permissions: { contents: read }
jobs:
  laws: # runs the pull request's code, so it holds no token
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
        with: { ref: '${{ github.event.pull_request.head.sha }}', persist-credentials: false }
      - uses: actions/setup-node@v4
        with: { node-version: 22, cache: npm }
      - run: npm ci
      - uses: Jordan-Hall/tsc-laws/packages/tslaws/github@laws-v0.10.0 # pin a release tag or a full commit SHA, never @main
        with: { mode: report, args: '--results-out ${{ runner.temp }}/tslaws-results.json' }
      - uses: actions/upload-artifact@v4
        with: { name: tslaws-results, path: '${{ runner.temp }}/tslaws-results.json' }
  report: # holds the token, and runs none of the pull request's code
    needs: laws
    runs-on: ubuntu-latest
    permissions: { contents: read, pull-requests: write }
    steps:
      - uses: actions/checkout@v4 # the base branch: trusted tools
        with: { ref: '${{ github.event.pull_request.base.sha }}', persist-credentials: false }
      - uses: actions/setup-node@v4
        with: { node-version: 22 }
      - run: npm ci
      - uses: actions/checkout@v4 # the pull request's files, read as data only (no npm ci, no scripts)
        with: { ref: '${{ github.event.pull_request.head.sha }}', path: pr, persist-credentials: false }
      - uses: actions/download-artifact@v4
        with: { name: tslaws-results, path: '${{ runner.temp }}' }
      - uses: Jordan-Hall/tsc-laws/packages/tslaws/github@laws-v0.10.0 # pin a release tag or a full commit SHA, never @main
        with:
          mode: report
          working-directory: pr
          install: 'false'
          token: '${{ github.token }}'
          args: --comment --config-from .. --results ${{ runner.temp }}/tslaws-results.json
```

`--results-out <file>` runs the laws and writes each project's report to the file; it needs no token. `--results <file>`
acts on such a file and runs no law; it refuses a file made for another commit or another mode, and a project whose lock
is not the one its laws ran against. In a single job, `report` and `merge` without these flags still run the laws in
the token-free child, with the limits above.

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
        with: { persist-credentials: false }
      - uses: actions/setup-node@v4
        with: { node-version: 22, cache: npm }
      - run: npm ci
      - uses: Jordan-Hall/tsc-laws/packages/tslaws/github@laws-v0.10.0 # pin a release tag or a full commit SHA, never @main
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
        with: { persist-credentials: false }
      - uses: actions/setup-node@v4
        with: { node-version: 22, cache: npm }
      - run: npm ci
      - id: pr
        run: echo "sha=$(gh pr view ${{ github.event.issue.number }} --json headRefOid -q .headRefOid)" >> "$GITHUB_OUTPUT"
        env: { GH_TOKEN: '${{ github.token }}' }
      - uses: actions/checkout@v4 # the pull request's files, read as data only (no npm ci, no scripts)
        with: { ref: '${{ steps.pr.outputs.sha }}', path: pr, persist-credentials: false }
      - uses: Jordan-Hall/tsc-laws/packages/tslaws/github@laws-v0.10.0 # pin a release tag or a full commit SHA, never @main
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
  laws: # runs the branch's code, so it holds no token and no app key
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
        with: { persist-credentials: false }
      - uses: actions/setup-node@v4
        with: { node-version: 22, cache: npm }
      - run: npm ci
      - uses: Jordan-Hall/tsc-laws/packages/tslaws/github@laws-v0.10.0 # pin a release tag or a full commit SHA, never @main
        with: { mode: merge, args: '--results-out ${{ runner.temp }}/tslaws-results.json' }
      - uses: actions/upload-artifact@v4
        with: { name: tslaws-results, path: '${{ runner.temp }}/tslaws-results.json' }
  merge: # holds the app's token, and runs none of the branch's code: its packages are installed as data, never run
    needs: laws
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4 # the pushed commit, read as data
        with: { persist-credentials: false }
      - uses: actions/setup-node@v4
        with: { node-version: 22 } # no cache: see "Monorepos"
      - run: npm ci --ignore-scripts # so the project's imports resolve; no install script of the branch runs
      - run: npm install --prefix "$RUNNER_TEMP/tslaws" --ignore-scripts --no-package-lock tslaws@0.10.0 # a pinned release: the branch's lockfile decides nothing here
      - uses: actions/download-artifact@v4
        with: { name: tslaws-results, path: '${{ runner.temp }}' }
      - uses: actions/create-github-app-token@v1 # after every step that installs anything
        id: app
        with: { app-id: '${{ vars.TSLAWS_APP_ID }}', private-key: '${{ secrets.TSLAWS_APP_KEY }}' }
      - uses: Jordan-Hall/tsc-laws/packages/tslaws/github@laws-v0.10.0 # pin a release tag or a full commit SHA, never @main
        with:
          mode: merge
          install: 'false'
          tslaws-root: '${{ runner.temp }}/tslaws' # the pinned tslaws, never one the branch installed
          token: '${{ steps.app.outputs.token }}'
          args: --results ${{ runner.temp }}/tslaws-results.json
```

If the lock on the branch moved on after the laws job checked it out (an earlier run's commit), the `merge` job accepts
nothing and says so: run the workflow again. Without `--results`, `merge` builds on the newer lock instead and runs
the laws again.

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

- the pull request's diff changes the lock (the bot never commits to a pull request's branch), unless `local` is true and
  the pull request's author, and the author of each commit that changes the lock, has `admin` or `maintain` access;
- the `github` section of `tslaws.json` changes;
- a `--protect` path changes.

`merge` accepts nothing when a push to `branch` changes the lock and is not made only of commits that GitHub shows as
the bot's, with signatures it verified, or (with `local` true) that reached `branch` through a merged pull request that a
maintainer wrote and merged. It compares the lock before and after the push, so a truncated push payload
cannot hide a change.

A pull request in `verify` can have at most 249 commits when it changes a lock by hand: GitHub lists no more than 250, so a
longer pull request cannot be checked commit by commit. A commit that GitHub lists with 300 files or more counts as
touching the lock.

## Monorepos

Run `tslaws github` at the repository root, where the monorepo's `tslaws.json` (with `projects`) or `package.json`
workspaces are, and every mode covers every project in one process. You need one job per mode, not one per package, and
no shell loop. To run `check`, `list` and the other commands across the packages, see [monorepo.md](monorepo.md).

| Mode      | From the root                                                                                                                              |
| --------- | ------------------------------------------------------------------------------------------------------------------------------------------ |
| `report`  | One sticky comment with a section per project; quiet projects collapse into one line. Annotations and the step summary cover all projects. |
| `verify`  | One check over every project's lock and settings (see "What the PR cannot steer").                                                         |
| `merge`   | Accepts every project's proposals and writes all the changed locks in one commit.                                                          |
| `command` | Routes `/tslaws accept` to the project a proposal belongs to.                                                                              |

The examples use a Bun workspace (`apps/*`, `packages/*`). The action finds the package manager from the lockfile
(`bun.lock`), sets up Bun and runs `bun install --frozen-lockfile`, so the job needs no `npm ci`. Do not turn on
`actions/setup-node`'s `cache` in a job that writes the lock (`merge`, `command`): a cache a pull request's workflow
could have filled is not input a job that holds the app's token should trust. Jobs that only read, such as `report`,
may use a cache.

```yaml
# .github/workflows/tslaws-pr.yml
name: tslaws
on: pull_request
permissions: { contents: read }
jobs:
  laws:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
        with: { ref: '${{ github.event.pull_request.head.sha }}', persist-credentials: false }
      - uses: Jordan-Hall/tsc-laws/packages/tslaws/github@laws-v0.10.0 # pin a release tag or a full commit SHA, never @main
        with: { mode: report, args: '--results-out ${{ runner.temp }}/tslaws-results.json' }
      - uses: actions/upload-artifact@v4
        with: { name: tslaws-results, path: '${{ runner.temp }}/tslaws-results.json' }
  report:
    needs: laws
    runs-on: ubuntu-latest
    permissions: { contents: read, pull-requests: write }
    steps:
      - uses: actions/checkout@v4 # the base branch: trusted tools
        with: { ref: '${{ github.event.pull_request.base.sha }}', persist-credentials: false }
      - uses: actions/checkout@v4 # the pull request's files, read as data only
        with: { ref: '${{ github.event.pull_request.head.sha }}', path: pr, persist-credentials: false }
      - uses: actions/download-artifact@v4
        with: { name: tslaws-results, path: '${{ runner.temp }}' }
      - uses: Jordan-Hall/tsc-laws/packages/tslaws/github@laws-v0.10.0 # pin a release tag or a full commit SHA, never @main
        with:
          mode: report
          working-directory: pr
          token: '${{ github.token }}'
          args: --comment --config-from .. --results ${{ runner.temp }}/tslaws-results.json
```

```yaml
# .github/workflows/tslaws-merge.yml
name: tslaws merge
on:
  push: { branches: [master] }
concurrency: { group: tslaws-lock, cancel-in-progress: false }
permissions: { contents: read }
jobs:
  laws:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
        with: { persist-credentials: false }
      - uses: Jordan-Hall/tsc-laws/packages/tslaws/github@laws-v0.10.0 # pin a release tag or a full commit SHA, never @main
        with: { mode: merge, args: '--results-out ${{ runner.temp }}/tslaws-results.json' }
      - uses: actions/upload-artifact@v4
        with: { name: tslaws-results, path: '${{ runner.temp }}/tslaws-results.json' }
  merge: # holds the app's token; the branch's packages are installed as data, never run
    needs: laws
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4 # the pushed commit, read as data
        with: { persist-credentials: false }
      - uses: actions/setup-node@v4
        with: { node-version: 22 } # no cache: a cache could carry code from another run into a job with the token
      - run: npm ci --ignore-scripts # so the projects' imports resolve; no install script of the branch runs
      - run: npm install --prefix "$RUNNER_TEMP/tslaws" --ignore-scripts --no-package-lock tslaws@0.10.0 # a pinned release: the branch's lockfile decides nothing here
      - uses: actions/download-artifact@v4
        with: { name: tslaws-results, path: '${{ runner.temp }}' }
      - uses: actions/create-github-app-token@v1 # after every step that installs anything
        id: app
        with: { app-id: '${{ vars.TSLAWS_APP_ID }}', private-key: '${{ secrets.TSLAWS_APP_KEY }}' }
      - uses: Jordan-Hall/tsc-laws/packages/tslaws/github@laws-v0.10.0 # pin a release tag or a full commit SHA, never @main
        with:
          mode: merge
          install: 'false'
          tslaws-root: '${{ runner.temp }}/tslaws' # the pinned tslaws, never one the branch installed
          token: '${{ steps.app.outputs.token }}'
          args: --results ${{ runner.temp }}/tslaws-results.json
```

The `merge` job never runs the branch's `tslaws`: it installs a pinned release into a directory of its own and passes
that as `tslaws-root`. The branch's packages are installed with `--ignore-scripts` only so that imports resolve while
the files are compiled; nothing in them runs. Change the pinned version with the action's tag.

The `verify` and `command` workflows above work as they are, run from the root. The concurrency group keeps one pending
run when pushes arrive quickly. That loses nothing: `merge` compares the laws at the branch head with each lock, so the
run that goes ahead accepts every proposal still outstanding.

### The action's inputs

| Input               | Default       | Meaning                                                                                                                                                                                                                                         |
| ------------------- | ------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `mode`              | (required)    | `report`, `command`, `merge` or `verify`.                                                                                                                                                                                                       |
| `token`             | empty         | The token for the GitHub API; the app's token for `merge` and `command`. Empty in the job that runs the laws (`--results-out`).                                                                                                                 |
| `working-directory` | `.`           | A project's directory, or a monorepo root.                                                                                                                                                                                                      |
| `args`              | empty         | Extra arguments for `tslaws github <mode>`.                                                                                                                                                                                                     |
| `tslaws-root`       | the workspace | The trusted checkout that holds `tslaws`.                                                                                                                                                                                                       |
| `package-manager`   | `auto`        | `auto`, `npm`, `pnpm`, `yarn` or `bun`. `auto` reads the lockfile in `tslaws-root`, then the `packageManager` field of its `package.json`, then falls back to npm.                                                                              |
| `install`           | `true`        | Run a frozen install in `tslaws-root` first (`npm ci`, `pnpm install --frozen-lockfile`, `yarn install --immutable`, `yarn install --frozen-lockfile` for Yarn 1, `bun install --frozen-lockfile`). Set `false` when an earlier step installed. |
| `pnpm-version`      | empty         | The pnpm version to set up (plain `x.y.z`). Empty reads `packageManager` from the `tslaws-root` `package.json`, then a pinned default; never from the workspace.                                                                                |
| `bun-version`       | empty         | The Bun version to set up (plain `x.y.z`). Empty reads `packageManager` from the `tslaws-root` `package.json`, then a pinned default.                                                                                                           |

The action sets up Bun or pnpm only when that is the detected manager and `install` is `true`, with
`oven-sh/setup-bun` and `pnpm/action-setup` pinned to commits. It finds `tslaws` with Node's own resolution from
`tslaws-root` (the `tslaws/package.json` that package resolution reaches from there), so hoisted, nested and pnpm layouts all
work, and it never looks in `working-directory`. The old inputs behave as before; a workflow that already ran `npm ci`
runs one more frozen install, or sets `install: false`.

### One comment for the repository

The root run keeps one sticky comment, under the root's marker (`<!-- tslaws-proposals -->`, the one a single-project
root already used). It has a `####` section for each project with proposals, and a line naming the rest ("No change in
`packages/ui`, ..."). A project that opted out (below) is not in it. When an earlier per-project workflow left comments
with a project's own marker, the root run removes the bot's own old comments for the projects it now covers, so a pull
request does not show both. A project that runs its own flow keeps its own marker and comment.

### Accepting by comment

A proposal belongs to a project. Name it by its path from the repository root, or with `--project`:

```
/tslaws accept packages/ui/src/tint.laws.ts::tint keeps contrast
/tslaws accept tint --project packages/ui
/tslaws accept all --project packages/ui --project apps/web
```

A bare law name that matches laws in more than one file or project is ambiguous: tslaws records nothing and tells the
commenter to use the path or `--project`. Each project decides for itself: its own `accept` mode, its own approvers.
A commenter who may accept in one package and not another is recorded for the first and told "not recorded" for the
second.

`approvePullRequest` approves the pull request only when every project that has proposals has all of them accepted and has set it. A project that was declined, runs its own flow or still has a pending proposal stops the review. In `command` mode the project list and each project's `flow`, `standalone` and `github` settings are
read from the base commit, and a pull request that changes how projects are found, any of those settings, or adds or
removes a project is not approved.

### Writing the locks

`merge` writes the locks of every project that has accepted proposals in one commit through the Git data API (a tree
with each changed lock, one commit on top of the branch head, and a plain, never forced, ref update). A single changed
lock goes through the contents API, as in a single project. If the branch moved while the job ran, GitHub refuses the
update and nothing is written; the next push's run accepts what is still outstanding.

The commit comes from the token's account, the app, and GitHub signs it as it does for commits made through the
contents API. `verify` and the next `merge` run only trust a lock commit by the bot with a verified signature (or, in a
project with `local` true, a maintainer's merged pull request), so check once, on a scratch branch, that a Git-data commit by your app shows as Verified before relying on multi-project writes.
If it does not, the next run fails closed rather than accepting.

**Failure policy.** The outside-change checks (a lock commit that is not the bot's or a maintainer's, a lock that moved
since the push, a push that changed a lock by other means, and the on-demand check of the branch's latest lock commit)
run per project, each with that project's own `local` and `bot`. A project that fails them, or that cannot be compiled or
checked, is reported, skipped, and counted as a failure; the other projects' locks are still written. The job fails
when any project failed or any proposal is held. A project that fails is never half written, and the others do not wait
for it. The failure is on the next run too until someone resolves it, because the outside change is still in the history
of its lock.

### What the pull request cannot steer

Some things in a pull request could otherwise change what the checks watch, so they are read from the base branch.

**Approvals belong to a project.** Every record carries the project it was made for (its path from the repository root,
empty for the root project). `merge`, `report` and `command` count a record only for that project, so
accepting a law in one package never accepts the same law (even with the same text and fingerprint) in another. A
record with no project, made by an older version, counts for the root project only. Approvals recorded by a per-package
workflow before you move to the root flow therefore stop counting for those packages: ask for `/tslaws accept` again.
A record also counts only when its author is still one of _that package's_ approvers.

**Discovery is read from the base commit.** `verify` and `merge` take the project list from the base commit through the
API (the root `tslaws.json` `projects`, `package.json` `workspaces`, `pnpm-workspace.yaml`, and the files that match),
united with the head's list. A pull request cannot hide a package by editing the files that find it:

- `verify` fails when a package that is a project on the base is no longer discovered on the head;
- `verify` reports a change to how projects are found (the `projects` list, `workspaces`, `pnpm-workspace.yaml`) the way
  it reports a change to a `github` section: such a pull request is merged by an administrator in a pull request of its
  own;
- `verify` fails on any `tsc-laws.lock` the pull request adds or changes anywhere in the repository, in a project or not.
  The one exception is a lock of a project whose base settings have `local` true, in a pull request whose author and
  lock-changing commit authors have `admin` or `maintain` access. A lock outside every project, or in a project with no
  `github` section, never has the exception, and the `command` job does not approve a pull request that changes any lock;
- `merge` still checks a project that was in the base and is no longer discovered, and fails the run;
- the `github` section and `standalone` are read per project from the base, following `extends`, and a change to either
  fails `verify` whichever file the change is in (not only `.json` files);
- an `extends` target must be a relative path of letters, digits and `. _ - / @` that stays inside the repository, and a regular file
  at both commits. An unreadable target, a symbolic link, a submodule, an absolute path, a backslash or a path that
  leaves the repository fails `verify` and `merge` instead of being guessed. All of them resolve the path with one
  helper, so they cannot read different files.

**The list of changed files is not trusted.** The API lists at most 3000 files of a pull request, so `verify` never
decides from that list alone: it reads each project's settings and the discovery files at both commits and compares them,
and compares the blob id of every `tsc-laws.lock` in the two trees. It also fails when the list reaches 3000 files or is
not the number of files GitHub says the pull request changes.

**The package manager version is not the pull request's to set.** The action passes `pnpm` and `bun` an explicit
plain-semver version (the input, the trusted `tslaws-root` `package.json`, or a pinned default). The setup actions never
fall back to the `packageManager` field of the workspace under test.

### Where the project sits

`tslaws github` finds a project's place in the repository with `git rev-parse --show-prefix`; pass `--project-path <dir>`
to name it yourself. From a root run, every lock and config path, every annotation and every link starts with the
project's path from the repository root. Run from a package's own directory, or with `--project <dir>`, it covers that
package alone and a root's markers and comments are unchanged. `--protect` paths stay relative to the repository root.
In the ruleset, restrict `**/tsc-laws.lock`.

### Packages that keep their own flow

Each project's `github` block is read from its own `tslaws.json`, and its own keys win over a root base it extends.
`approvers`, `bot`, `branch` and `accept` are per package. A package can leave the shared flow in two ways, described in
[monorepo.md](monorepo.md#owning-a-packages-laws): `"github": { "flow": "own" }` keeps its settings but takes it out of
the root's `report`, `merge` and `command` (it runs `tslaws github <mode> --project <dir>` in its own workflow;
`verify` still guards its lock), and `"standalone": true` makes every root run skip it unless `--project` names it.

## Limits

- Pull requests from forks get a read-only token, so `report` cannot write its comment. The annotations and the step
  summary still show every proposal.
- In comment mode, a pull request's author can accept their own proposals when `approvers` includes `author`. Remove
  `author` if a second person must accept. An agent that opens pull requests under a person's account counts as that
  person.
