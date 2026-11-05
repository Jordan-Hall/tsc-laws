# Releasing tsc-laws

The upstream `RELEASING.md` covers tsc-ts. tsc-laws releases are separate and tagged `laws-v<version>`.

```sh
# set "version" in packages/tslaws/package.json, commit to main, then
git tag -a laws-v0.1.2 -m "tsc-laws 0.1.2" && git push origin laws-v0.1.2
```

The `tsc-laws` workflow then:

1. runs the tests on Linux and Windows,
2. builds the compiler for macOS (arm64, x64), Linux (arm64, x64 glibc) and Windows (x64),
3. publishes a GitHub release with those builds and the `tslaws` tarball,
4. publishes to npm, if enabled (below).

The GitHub release, the npm packages (`tslaws` and the compilers) and the VS Code extension are released together from one tag
and share its version. The release notes are the version's section of `CHANGELOG-LAWS.md` (generated notes when the tag has
no section).

## Automatic releases

Every push to `main` runs `.github/workflows/laws-auto-release.yml`. When the commits since the latest `laws-v*` tag change
code, it releases (the manual steps above are then only a fallback):

- Code is anything under `packages/tslaws`, `packages/tsc-ts`, `packages/vscode-tslaws` or `scripts`, plus `upstream.json`,
  `package.json`, `package-lock.json` and `.github/workflows/laws.yml`. Markdown, `docs/`, `examples/`, `LICENSE`, `CHANGELOG*`
  and other workflow files do not count, so a merge with only those releases nothing.
- The bump is patch, minor if a commit subject starts with `feat`, major for `type!:` or a `BREAKING CHANGE:` footer.
- It sets the version in both packages and the lockfile, adds a section to `CHANGELOG-LAWS.md`, commits
  `chore(release): tslaws <version>`, tags `laws-v<version>`, pushes both to `main`, and runs `laws.yml` on the tag (a tag
  pushed with the default token starts no workflow by itself). That run tests, builds, publishes the GitHub release and
  publishes to npm. The auto-release workflow never publishes to npm itself.
- To skip a release, put `[skip release]` in the message of the merge or squash commit that triggers the run (a manual run reads it from the latest main commit instead). If main moves before the release push, nothing is pushed and the run ends with a notice; the newer push's own run releases. The release commit is
  never released again.
- To retry: if the tag exists but the pipeline failed, run `gh workflow run laws.yml --ref laws-v<version>` (or re-run it in
  the Actions tab). If no tag was pushed, re-run the `tslaws auto release` workflow. It does nothing when the tag exists.

Setup: the workflow pushes to `main` as `github-actions[bot]`, so Actions need read and write workflow permissions, and the
bot must be able to push to `main`.

### When main is protected

A version bump is a commit, and it cannot be pushed to a `main` whose ruleset requires a pull request. While the ruleset has no
bypass for the bot, the workflow cannot release. It does not fail: it tries the push, sees GitHub refuse it (`GH013`, "Changes
must be made through a pull request"), prints one warning, writes it to the job summary, and stops. Nothing is pushed, no tag is
made, `laws.yml` is not started, and the run is green. The local release commit and tag exist only in that run's checkout and are
discarded; a re-run starts from a clean checkout and plans again.

To release automatically, choose one:

- Allow the bot to bypass: Settings > Rules > Rulesets > the `main` ruleset > Bypass list > add the GitHub Actions app (or a
  repository role the bot holds). The next push to `main` then releases.
- Release through a pull request: bump the versions and `CHANGELOG-LAWS.md` in a pull request, merge it, then tag the merge
  commit by hand (`git tag -a laws-v<version> -m "tsc-laws <version>" && git push origin laws-v<version>`; the tag rule must
  allow it) or run `gh workflow run laws.yml --ref laws-v<version>`.

A push refused because `main` moved (not a fast-forward) ends with a notice and nothing pushed; the newer push releases. Any
other failure (authentication, network) still fails the run and shows git's output.

## npm

`npm i -D tslaws` installs the runner and, as an optional dependency, the compiler for the machine
(`tslaws-compiler-<platform>`). With no configuration, `tslaws check` finds it. `--compiler`, then `TSC_LAWS_BIN`, take priority.

Packages published, all at the same version: `tslaws`, `tslaws-compiler-darwin-arm64`, `tslaws-compiler-darwin-x64`,
`tslaws-compiler-linux-arm64-gnu`, `tslaws-compiler-linux-x64-gnu`, `tslaws-compiler-win32-x64-msvc`. There is no musl build yet.

To publish, add the repository secret `NPM_TOKEN` (Settings, Secrets and variables, Actions): an npm token that can publish these
package names (a granular access token with read and write on packages, allowed to publish without a 2FA prompt). The `npm` job
runs on every `laws-v*` tag after the GitHub release succeeds.

Instead of a token you can use **trusted publishing**: on npmjs.com give each package a trusted publisher (repository
`Jordan-Hall/tsc-laws`, workflow `laws.yml`). A package that does not exist yet must be published once with a token.

Packages are published with provenance and `--access public`. The compilers go first, so `tslaws` never points at a package
that is not there yet. `scripts/ci/laws-npm.mjs` does the repacking (the tsc-ts platform tarballs are renamed and given
tslaws's version) and adds the optional dependencies.

## VS Code extension

Every workflow run tests the extension (`npm test -w vscode-tslaws`), packages it with `vsce`, and uploads the `.vsix` as the
`vscode-tslaws` artifact, so each build carries one. A `laws-v*` release attaches it as
`tslaws-vscode-<version>.vsix` (install with `code --install-extension`). The release refuses to proceed when
`packages/vscode-tslaws/package.json` has a different version from the tag, so bump both together.

To publish it to the Marketplace and Open VSX, set the repository variable `VSCODE_PUBLISH` to `true`. The Marketplace uses
trusted publishing (a policy on the `TS-Laws` publisher; `VSCE_PAT` is only a fallback). Open VSX needs an `OVSX_PAT` secret.
Open VSX is skipped with a notice when that secret is missing. The full set-up is in
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
