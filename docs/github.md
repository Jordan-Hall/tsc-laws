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
    "bot": "tslaws[bot]", // the login that writes the lock and the approval records
    "approvers": ["author", "reviewers"], // comment mode: who may accept; each also needs write access
    "requirePassing": true, // a failing proposal is never accepted (default true)
    "approvePullRequest": false, // comment mode: approve the pull request once every proposal is accepted
  },
}
```

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

The report job runs the pull request's code, so it only advises. The decision is made on the trusted branch.

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
    if: github.event.issue.pull_request && startsWith(github.event.comment.body, '/tslaws')
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

Set `bot` to the app's login (`<app-slug>[bot]`). The app needs these permissions: **Contents: write**, **Pull
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

## Limits

- Pull requests from forks get a read-only token, so `report` cannot write its comment. The annotations and the step
  summary still show every proposal.
- In comment mode, a pull request's author can accept their own proposals when `approvers` includes `author`. Remove
  `author` if a second person must accept. An agent that opens pull requests under a person's account counts as that
  person.
