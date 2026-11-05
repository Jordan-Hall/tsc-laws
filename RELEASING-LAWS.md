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
- To skip a release, put `[skip release]` in the message of the merge or squash commit that triggers the run (a manual run reads it from the latest main commit instead). If main moves before the release push, the push fails loudly and nothing is pushed; the newer push's own run releases. The release commit is
  never released again.
- To retry: if the tag exists but the pipeline failed, run `gh workflow run laws.yml --ref laws-v<version>` (or re-run it in
  the Actions tab). If no tag was pushed, re-run the `tslaws auto release` workflow. It does nothing when the tag exists.

Setup: the workflow pushes to `main` as `github-actions[bot]`, so branch protection must let that actor push (a ruleset
bypass for it), and Actions need read and write workflow permissions.

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
