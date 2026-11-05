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

To publish it to the Marketplace and Open VSX, set the repository variable `VSCODE_PUBLISH` to `true` and add a
`VSCE_PAT` secret (an Azure DevOps token for the `tsc-laws` publisher) and/or an `OVSX_PAT` secret (an Open VSX token).

## Syncing with upstream

This fork tracks [vercel-labs/tsc-ts](https://github.com/vercel-labs/tsc-ts). The `sync-upstream` workflow runs every Monday
(and on demand from the Actions tab) and only on `Jordan-Hall/tsc-laws`. `scripts/ci/sync-upstream.mjs` does the work:

- If upstream `main` has no commits that `main` lacks, it does nothing.
- If an open pull request from a `sync/upstream-*` branch, or such a branch on origin, exists, it does nothing.
- Otherwise it merges `upstream/main` into a new branch `sync/upstream-<date>`, pushes it with the default token and opens a
  pull request into `main` that lists the new upstream commits.
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
