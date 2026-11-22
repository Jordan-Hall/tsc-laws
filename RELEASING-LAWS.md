# Releasing tsc-laws

The upstream `RELEASING.md` covers tsc-ts. tsc-laws releases are separate and tagged `laws-v<version>`.

## Automatic releases (release-please)

Releases are made by [release-please](https://github.com/googleapis/release-please) from conventional commit messages
(`.github/workflows/release-please.yml`, configured by `release-please-config.json` and `.release-please-manifest.json`).

1. Every push to `main` opens or updates one pull request, `chore(release): tslaws <next>`. It sets the version in
   `version.txt`, `packages/tslaws/package.json`, `packages/vscode-tslaws/package.json` and the lockfile, and adds the
   version's section to `CHANGELOG-LAWS.md`.
2. Merging it creates the `laws-v<version>` tag and the GitHub release, then runs the `tsc-laws` workflow (`laws.yml`) on the
   tag.
3. That run tests, builds the compilers, uploads them, the `tslaws` tarball and the `.vsix` to the release, publishes to npm
   and, when enabled, to the VS Code Marketplace and Open VSX.

Nothing is pushed to `main` directly, so the `main` ruleset (pull requests required) needs no bypass.

- **The bump** follows the commits since the latest `laws-v*` release: `fix:` and `perf:` give a patch, `feat:` a minor,
  `type!:` or a `BREAKING CHANGE:` footer a major. `chore:`, `ci:`, `docs:`, `test:`, `style:` and `refactor:` commits, and
  commits that only touch `apps/`, `docs/` or `examples/`, release nothing and stay out of the changelog.
- **To choose a version**, add a `Release-As: 1.0.0` footer to a commit on `main`.
- **To hold a release**, leave the release pull request open; it keeps collecting commits.
- **Tokens:** with the default `GITHUB_TOKEN`, CI does not run on the release pull request, and the tag does not start a
  workflow by itself, so the release-please workflow starts `laws.yml` on the tag. To have CI checks on the release pull
  request, add a repository secret `RELEASE_PLEASE_TOKEN` (a GitHub App token or a fine-grained token with contents, pull
  requests and issues write); the tag push then starts `laws.yml` and the explicit start is skipped.
- **Setup:** Settings > Actions > General > Workflow permissions: read and write, and "Allow GitHub Actions to create and
  approve pull requests".
- **To retry** a failed publish: `gh workflow run laws.yml --ref laws-v<version>` (or re-run it in the Actions tab). The
  release step uploads to the existing release instead of creating a second one.

## By hand

A tag pushed by hand releases too (the release then gets the version's `CHANGELOG-LAWS.md` section, or generated notes):

```sh
# set the version in version.txt and both package.json files, merge to main, then
git tag -a laws-v0.1.2 -m "tsc-laws 0.1.2" && git push origin laws-v0.1.2
```

Set `.release-please-manifest.json` to the same version in that pull request so release-please continues from it.

The GitHub release, the npm packages (`tslaws` and the compilers) and the VS Code extension are released together from one tag
and share its version.

## npm

`npm i -D tslaws` installs the runner and, as an optional dependency, the compiler for the machine
(`tslaws-compiler-<platform>`). With no configuration, `tslaws check` finds it. `--compiler`, then `TSC_LAWS_BIN`, take priority.

Packages published, all at the same version: `tslaws`, `tslaws-compiler-darwin-arm64`, `tslaws-compiler-darwin-x64`,
`tslaws-compiler-linux-arm64-gnu`, `tslaws-compiler-linux-x64-gnu`, `tslaws-compiler-win32-x64-msvc`. There is no musl build yet.

Publishing uses **npm trusted publishing**: each package trusts the workflow `laws.yml` in `Jordan-Hall/tsc-laws`, and the
`npm` job proves it is that workflow with a GitHub OIDC token. No npm token is stored in the repository. The `npm` job runs on
every `laws-v*` tag after the GitHub release succeeds.

To set it up, or to add a package, log in to npm and run, for each package:

```sh
npm trust github <package> --repo Jordan-Hall/tsc-laws --file laws.yml --environment release --allow-publish --registry https://registry.npmjs.org
```

`npm trust list <package>` shows what is trusted. A package that does not exist yet must be published once by hand before it
can be trusted.

Packages are published with provenance and `--access public`. The compilers go first, so `tslaws` never points at a package
that is not there yet. `scripts/ci/laws-npm.mjs` does the repacking (the tsc-ts platform tarballs are renamed and given
tslaws's version) and adds the optional dependencies.

## Release gate

The `npm` and `marketplace` jobs in `laws.yml` run in the `release` environment and refuse a tag whose commit is not an
ancestor of `main`. The gate is two parts:

- **Environment `release`** (already set up): Jordan is the required reviewer, and the deployment policy allows only the
  tag pattern `laws-v*`. Every publish waits for that approval.
- **Ancestor check**: the first steps of each publish job fail unless the tagged commit is an ancestor of `origin/main`.

There is no tag ruleset restricting who can create `laws-v*`. release-please creates the tags with `github.token`, and a
personal repository cannot list GitHub Actions as a ruleset bypass actor, so such a ruleset would block releases. The
environment approval and the ancestor check stand in for it.

The npm trust policy is done: all six packages trust only `laws.yml` running in the `release` environment (set with
`npm trust github ... --environment release`), and the old policies are revoked. Publishing needs the `environment: release`
line this workflow now has. If you add a package, trust it the same way (see the npm section above). If you use the VS Code
Marketplace policy or the Open VSX trusted publisher, add `release` as their environment too, or their OIDC match fails.

## VS Code extension

Every workflow run tests the extension (`npm test -w vscode-tslaws`), packages it with `vsce`, and uploads the `.vsix` as the
`vscode-tslaws` artifact, so each build carries one. A `laws-v*` release attaches it as
`tslaws-vscode-<version>.vsix` (install with `code --install-extension`). The release refuses to proceed when
`packages/vscode-tslaws/package.json` has a different version from the tag, so bump both together.

To publish it to the Marketplace and Open VSX, set the repository variable `VSCODE_PUBLISH` to `true`. The Marketplace uses
trusted publishing (a policy on the `ts-laws` publisher; `VSCE_PAT` is only a fallback). Open VSX also uses trusted publishing (a trusted publisher on the extension, which needs its first version published once with an `OVSX_PAT` token; the namespace must be exactly `ts-laws`). The full set-up is in
[docs/publishing-the-extension.md](docs/publishing-the-extension.md).

## Syncing with upstream

This fork tracks [vercel-labs/tsc-ts](https://github.com/vercel-labs/tsc-ts). The `sync-upstream` workflow runs every Monday
(and on demand from the Actions tab) and only on `Jordan-Hall/tsc-laws`. `scripts/ci/sync-upstream.mjs` does the work:

- If upstream `main` has no commits that `main` lacks, it does nothing.
- If an open pull request from a `sync/upstream-*` branch exists, it does nothing. Only an open pull request blocks a run.
- Otherwise it merges `upstream/main` into a new branch `sync/upstream-<date>`, pushes it with the default token and opens a
  pull request into `main` that lists the new upstream commits.
- A `sync/upstream-*` branch on origin with no open pull request (the pull request was closed unmerged, or a run pushed the
  branch and failed before opening one) does not block anything. The job deletes such a branch when `main` already contains it
  or it lacks the current upstream head. A complete one that `main` lacks is reused: the job resets it to the fresh merge with
  `--force-with-lease` on that branch only, then opens the pull request. It never force-pushes `main`.
- If the merge conflicts, it opens one issue labelled `upstream-sync` that lists the conflicting files, and no pull request.
  While that issue is open, later runs open no second one.

It never pushes to `main` and never publishes. Merge the pull request with a **merge commit**, not a squash or a rebase, so the
next sync sees those upstream commits as merged. Upstream commits in `packages/tsc-ts` count as code for the release
workflow, which is fine. The versions of `tslaws` and `vscode-tslaws` are this fork's: never copy upstream's version bumps over
them. If upstream moves the pin in `upstream.json`, take upstream's.

GitHub starts no workflows for a pull request opened with the default token, so close and reopen the pull request to run its
checks. The default token also cannot push a branch that changes `.github/workflows`: the job then opens the `upstream-sync`
issue and you do the merge yourself.

To merge by hand, after a conflict or a refused push:

```sh
git fetch https://github.com/vercel-labs/tsc-ts.git main:refs/remotes/upstream/main
git switch -c chore/sync-upstream origin/main
git merge upstream/main
```

Resolve the conflicts. Take upstream's side for its own files and keep both sides where they touch different things. The law
syntax lives in `packages/tsc-ts/src/laws`, `checker-laws.ts` and the places that call them (checker, parser, `main.ts`). The
diagnostic tables are generated: take upstream's `diagnostic-messages.ts` and `locales/*.ts`, run `npm run fetch:upstream`, then
`node scripts/generate-diagnostics.mjs` in `packages/tsc-ts` (and `npx oxfmt` on the files it wrote, if the script's own format
step fails) to bring the law messages back. Then run what `laws.yml` runs: build the compiler, `node --test
packages/tsc-ts/tests/laws.test.mjs`, `npm test -w tslaws` and `npm test -w vscode-tslaws`.
