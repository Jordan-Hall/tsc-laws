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
    "flow": "shared", // monorepo: "own" keeps this package out of the root's report, merge and command (see "Monorepos")
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
permissions: { contents: read, pull-requests: write }
jobs:
  report:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: Jordan-Hall/tsc-laws/packages/tslaws/github@main
        with: { mode: report, token: '${{ github.token }}', args: --comment }
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
      - uses: Jordan-Hall/tsc-laws/packages/tslaws/github@main
        with: { mode: merge, token: '${{ steps.app.outputs.token }}' }
```

The `verify` and `command` workflows above work as they are, run from the root. The concurrency group keeps one pending
run when pushes arrive quickly. That loses nothing: `merge` compares the laws at the branch head with each lock, so the
run that goes ahead accepts every proposal still outstanding.

### The action's inputs

| Input               | Default       | Meaning                                                                                                                                                                                                                                         |
| ------------------- | ------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `mode`              | (required)    | `report`, `command`, `merge` or `verify`.                                                                                                                                                                                                       |
| `token`             | (required)    | The token for the GitHub API; the app's token for `merge` and `command`.                                                                                                                                                                        |
| `working-directory` | `.`           | A project's directory, or a monorepo root.                                                                                                                                                                                                      |
| `args`              | empty         | Extra arguments for `tslaws github <mode>`.                                                                                                                                                                                                     |
| `tslaws-root`       | the workspace | The trusted checkout that holds `tslaws`.                                                                                                                                                                                                       |
| `package-manager`   | `auto`        | `auto`, `npm`, `pnpm`, `yarn` or `bun`. `auto` reads the lockfile in `tslaws-root`, then the `packageManager` field of its `package.json`, then falls back to npm.                                                                              |
| `install`           | `true`        | Run a frozen install in `tslaws-root` first (`npm ci`, `pnpm install --frozen-lockfile`, `yarn install --immutable`, `yarn install --frozen-lockfile` for Yarn 1, `bun install --frozen-lockfile`). Set `false` when an earlier step installed. |
| `pnpm-version`      | empty         | The pnpm version to set up (plain `x.y.z`). Empty reads `packageManager` from the `tslaws-root` `package.json`, then a pinned default; never from the workspace.                                                                                |
| `bun-version`       | empty         | The Bun version to set up (plain `x.y.z`). Empty reads `packageManager` from the `tslaws-root` `package.json`, then a pinned default.                                                                                                           |

The action sets up Bun or pnpm only when that is the detected manager and `install` is `true`, with
`oven-sh/setup-bun` and `pnpm/action-setup` pinned to commits. It finds `tslaws` with Node's own resolution from
`tslaws-root` (`require.resolve('tslaws/package.json', { paths: [root] })`), so hoisted, nested and pnpm layouts all
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
contents API. `verify` and the next `merge` run only trust a lock commit by the bot with a verified signature, so check
once, on a scratch branch, that a Git-data commit by your app shows as Verified before relying on multi-project writes.
If it does not, the next run fails closed rather than accepting.

**Failure policy.** The outside-change checks (a lock commit that is not the bot's, a lock that moved since the push, a
push that changed a lock by other means) run per project. A project that fails them, or that cannot be compiled or
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
- `verify` fails on any `tsc-laws.lock` the pull request adds or changes anywhere in the repository, in a project or not;
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
