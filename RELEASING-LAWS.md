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

To turn publishing on:

1. Set the repository variable `NPM_PUBLISH` to `true` (Settings, Secrets and variables, Actions, Variables).
2. Give the workflow permission to publish, either of
   - **trusted publishing** (no secret): on npmjs.com, for each package above, add a trusted publisher: repository
     `Jordan-Hall/tsc-laws`, workflow `laws.yml`. A package that does not exist yet must be published once with a token;
   - an **`NPM_TOKEN` secret**: an npm automation token that can publish these package names.

Packages are published with provenance and `--access public`. The compilers go first, so `tslaws` never points at a package
that is not there yet. `scripts/ci/laws-npm.mjs` does the repacking (the tsc-ts platform tarballs are renamed and given
tslaws's version) and adds the optional dependencies.
