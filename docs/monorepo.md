# tslaws in a monorepo

A monorepo has many packages and each can have laws of its own. A package is a tslaws project: a directory with a
`tslaws.json` and its own `tsc-laws.lock`. Run `tslaws` at the repository root and it runs every project in turn, each
in its own directory with its own config and lock, then ends with one summary line. You do not write a loop.

The examples use a Bun workspace with `apps/*` and `packages/*`, about nineteen packages in all.

```
repo/
  package.json              { "workspaces": ["apps/*", "packages/*"] }
  tslaws.json               the project list and the settings every package shares
  apps/web/
    tslaws.json             { "extends": "../../tslaws.json" }
    tsc-laws.lock
    src/
  packages/ui/
    tslaws.json             { "extends": "../../tslaws.json" }
    tsc-laws.lock
    src/
  packages/core/ ...
```

## The root `tslaws.json`

```json
{
  "projects": ["apps/*", "packages/*"],
  "cover": ["src/**/*.ts", "!src/**/*.laws.ts"],
  "runs": 300,
  "bound": 5
}
```

`projects` lists the directories to look in, as globs relative to the root (a leading `!` excludes). Only directories
that hold a `tslaws.json` count as projects, so a package without laws is skipped. Without `projects`, tslaws reads the
same list from `workspaces` in `package.json` (npm, yarn and Bun alike) or from `packages:` in `pnpm-workspace.yaml`. The
first source that names any globs wins: `projects`, then `workspaces`, then pnpm. A repository with no root
`tslaws.json` needs nothing else: the workspaces are enough. A root `tslaws.json` that is only shared settings (no
`projects`) makes the root a plain single project, so name the projects there, as above.

## Packages that extend it

Each package's `tslaws.json` can inherit from the root file with `extends`:

```json
{ "extends": "../../tslaws.json" }
```

The package's own keys win, and they replace an inherited array instead of adding to it. A package can set its own
`runs` or add `levels`, `e2e` or `bundlerPlugins`. A chain works too (a package extends a team base that extends the
root), and a cycle or a missing file is an error that names the files. The path must be relative, use only letters, digits and `. _ - / @`, and
stay inside the repository (the nearest directory with a `.git`, else the highest one with a workspace file). A symbolic
link, or a path that reaches outside through one, is refused. `projects` is read from the file you run in and
is not inherited.

Paths in an inherited file follow one rule:

- Globs are relative to the project that uses the config. `cover` and `laws` are globs. A root that says
  `"cover": ["src/**/*.ts"]` means each package's own `src/`, so one setting covers every package.
- References to a file are relative to the file that declares them, as in `tsconfig.json`. `bundlerPlugins` module paths
  and `e2e.server.cwd` are rebased to each package, so `"bundlerPlugins": ["./tools/plugin.mjs"]` in the root file still
  finds the root's `tools/plugin.mjs` from `packages/ui`.

## The root as a project

The root is a project too only when it has a `tslaws.json` and either of these is true:

- that file has no `projects` key (a plain single project that happens to hold others), or
- the root has laws of its own: a `tsc-laws.lock` beside it, or a `*.laws.ts` file outside the projects.

A root whose `tslaws.json` only lists projects is just the list: nothing runs for it. When the root is a project it
runs first, under the header `── . ──`, and leaves the laws of the other projects to them. Its `cover` globs are
relative to the root, so exclude the packages there (`"!packages/**"`).

## Running it from the root

```sh
tslaws check                                  # every project, one at a time
tslaws check --project packages/ui            # one project
tslaws check --project packages/ui,apps/web   # a comma list, or repeat the flag
tslaws check --filter 'packages/*'            # projects whose path matches a glob
tslaws check --filter 'packages/*' --filter '!packages/legacy'
```

Each project's output follows a header, and the run ends with a summary:

```
── packages/core ──
PROVED   clamp stays in range (src/clamp.laws.ts:3) [prover]

1 laws: 1 proved, 0 bounded, 0 tested, 0 open, 0 failed, 0 tampered, 0 errors

── packages/ui ──
FAILED   tint keeps contrast (src/tint.laws.ts:5) [property]
         counterexample: [0.5]

1 laws: 0 proved, 0 bounded, 0 tested, 0 open, 1 failed, 0 tampered, 0 errors

2 projects, 1 failed (packages/ui)
```

The exit status is nonzero when any project failed. A project that cannot run (no laws files, a broken config) counts as
failed; the run goes on with the rest.

These commands run in every selected project: `check` (with `--proposed`), `accept`, `list`, `mutate`,
`regressions` and `security deps` (each package checks the packages its own covered code imports, under its own `security`
settings; see [security-laws.md](security-laws.md#in-a-monorepo)). `--project` and `--filter` also work in a single-project repository: `--project .` names the project,
and a flag that matches nothing is an error listing the projects there are.

Machine output stays valid. `--json` (or `--reporter json`) on `check`, `list`, `mutate` or `security deps` prints one object keyed by
project path (`.` for the root) with each project's report as the value, and the summary goes to stderr.
`--reporter ndjson` tags every line with a `project` field. `--reporter junit` is refused at a root with several projects, because several XML
documents do not make one; run it with `--project`. File arguments are refused too: they belong to one project.

`init`, `ui`, `mcp`, `github`, `propose`, `promote`, `delegate`, `migrate` and `check --watch` work in one project. At a
root with more than one project they stop with a message naming `--project <dir>`; with `--project packages/ui` (or when
the repository has exactly one project) they run in that project's directory. `tslaws init --project .` scaffolds the
root itself.

## Only what changed

```sh
tslaws check --changed origin/main            # the projects a pull request can affect
tslaws check --changed origin/main --filter 'packages/*'
```

`--changed <ref>` compares the working tree with `git merge-base <ref> HEAD`, so a branch is judged by its own changes
and not by what landed on the base since. Committed, staged, unstaged and untracked files all count; ignored files do
not. In CI, fetch the full history (`fetch-depth: 0`), or the merge-base cannot be found and the run stops with a message
that says so. It works for every command that runs in each project (`check`, `accept`, `list`, `mutate`,
`regressions`) and combines with `--project` and `--filter`: the projects it picks are intersected with those.

A project is selected when:

- it contains a changed file (any file under its directory, including its `tslaws.json`, its `tsc-laws.lock` and its
  laws files, and not the files of a project nested in it), or
- it depends on a selected project, however indirectly.

Dependencies come from three places:

1. The nearest `package.json`, for `dependencies`, `devDependencies` and `peerDependencies` that name another workspace
   package. A package without a `tslaws.json` is still a node in the graph, so `app` depends on `util` depends on `core`
   selects `app` when `core` changes, even though `util` has no laws.
2. The project's tsconfig `paths` (the same resolution as [TypeScript resolution](#typescript-resolution)): a target that
   lands in another package is a dependency, which covers packages that import each other by path without naming each
   other in `package.json`.
3. A package or project nested inside another depends on the one around it.

A change to a file every project shares selects all of them: the root `tslaws.json`, a file a `tslaws.json` `extends`,
the root `package.json`, a lockfile (`package-lock.json`, `pnpm-lock.yaml`, `yarn.lock`, `bun.lock`) or a root
`tsconfig*.json`.

Each selected project gets one line on stderr that says why, so a surprising selection explains itself:

```
--changed origin/main (merge-base 3f2a9c1d, 2 changed files): 3 of 4 projects selected
  packages/core: contains changed file packages/core/src/clamp.ts
  packages/ui: depends on packages/core, which has changes
  apps/web: depends on packages/ui, which is affected
```

When nothing is selected, the run prints that and exits 0; `--json` still prints `{}`. Inside a single project (no
monorepo root), `--changed` runs the project when anything under it changed and otherwise exits 0 with a note.

## TypeScript resolution

Laws are compiled with the module resolution of the package's own tsconfig, so a law can import what the package's code
imports: `paths` aliases, `baseUrl`, packages that `extends` a shared config (`"extends": "@repo/typescript-config/base.json"`
resolves through `node_modules`), and workspace packages that point `exports` or `types` at TypeScript source.

```json
{ "tsconfig": "tsconfig.audits.json" }
```

- The tsconfig is the one `"tsconfig"` names in `tslaws.json` (relative to that file), else the nearest `tsconfig.json`
  from the project directory upwards. `"tsconfig": false` opts out. A named file that is missing is an error; a
  discovered one that cannot be read is skipped.
- Only resolution options are taken, after following `extends`: `baseUrl`, `paths`, `rootDirs`, `customConditions`,
  `moduleSuffixes`, `resolveJsonModule`, `allowArbitraryExtensions`, `resolvePackageJsonExports` and
  `resolvePackageJsonImports`, with every path made absolute and `baseUrl` folded into `paths`.
  `allowImportingTsExtensions` becomes `rewriteRelativeImportExtensions`, because tslaws emits JavaScript. `include`,
  `files`, `outDir`, `noEmit`, `module`, `moduleResolution`, `types` and `typeRoots` are ignored: tslaws chooses the law
  files, compiles to CommonJS internally (laws still read your ES-module project as such) and resolves the way a bundler does. `compilerOptions` in `tslaws.json` still win.
- The compiler gets these options in-process (the built-in path) or in a generated `.tslaws/resolution.tsconfig.json`
  (the tsc-laws compiler, where `paths` is not a command line option). The compiler's flags stay on the command line and
  win over that file.
- The compiled laws run in Node, which knows nothing of `paths`. When Node cannot resolve an import, tslaws asks
  TypeScript with the same options and runs the file it finds (the compiled output for project source). `.ts` and
  `.tsx` files that no compiler wrote out, such as a workspace package's source reached through `node_modules`, are
  transpiled with esbuild as they load. Property workers get the same hooks, and the browser bundler uses the same
  tsconfig through esbuild.
- Source files outside the project reached through `paths` (a sibling package, say) work with both compilers. The built-in
  path type-checks them and loads them in place. The tsc-laws compiler needs every source file under one root, so it
  gets the common ancestor of the project and the `paths` targets as `rootDir`, and `.tslaws/out` mirrors the tree from
  there: the project's output is in `.tslaws/out/<project path below the root>`, and a sibling's beside it. Only a
  project that reaches outside itself has the extra directory level.

## Owning a package's laws

A package is a project of its own. It has its own laws, its own config, its own lock and its own approvers, and the root
only supplies what the package does not set.

- **Own laws.** A package's `*.laws.ts` files and `tsc-laws.lock` belong to it. Nothing in another package can accept,
  change or remove them.
- **Own config.** Everything in a package's `tslaws.json` wins over an inherited value (`runs`, `levels`, `e2e`, `github`).
- **`extends` is optional.** A package with no `extends` is configured by its own file alone, and a package can extend a
  team base instead of the root.
- **Own approvers.** The `github` block is read for each package, and a package's keys win over a root base it extends.
  `approvers`, `bot`, `branch` and `accept` are per package, and an approval recorded for one package is never counted for
  another (see [github.md](github.md#what-the-pull-request-cannot-steer)).

  ```json
  { "extends": "../../tslaws.json", "github": { "approvers": ["reviewers"], "accept": "comment" } }
  ```

- **Opting out of the shared flow.** `"github": { "flow": "own" }` keeps the package's settings but takes it out of the
  root's `tslaws github report`, `merge` and `command`. Run those in the package (`--project packages/ui`), in a workflow
  of its own. The root's `verify` still checks the package's lock, so the lock stays protected. A package with no
  `github` section is not part of the GitHub flow at all, and `tslaws accept` works there as usual.
- **`"standalone": true`.** A root `check`, `accept`, `list`, `mutate`, `regressions` and `github` run skips a standalone
  package unless `--project` (or `--filter`) names it. `verify` still lists it, so its lock is guarded. The key is not
  inherited through `extends`, so a package that extends a standalone package is not standalone.

## One lock per package

Every project has its own `tsc-laws.lock`, written by `tslaws accept` in that project (`tslaws accept` at the root asks
once for each project) and committed with the package. A lock changes only when someone accepts laws in its package, so
a review of `packages/ui/tsc-laws.lock` is a review of that package's laws, and one package's accepted laws never
depend on another's.

## In CI

Install the dependencies, then check from the root:

```yaml
name: laws
on: [pull_request]
jobs:
  laws:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: oven-sh/setup-bun@v2
      - run: bun install --frozen-lockfile
      - run: bunx tslaws check --summary
```

The step fails when any project does, and its last line says which. `--reporter github` adds annotations on the lines of
the failing laws.

## In VS Code

The [extension](../packages/vscode-tslaws/README.md#projects) follows the project of the open file: the nearest
`tslaws.json` above it is the directory `tslaws` runs in, and its `tsc-laws.lock` is the one that counts. The status bar
names the project, and _tslaws: Check all projects_ runs the whole repository from the root.

## What comes next

The GitHub flow runs from the root too: `tslaws github report`, `verify`, `merge` and `command` cover every project in
one job, with one comment and one commit for the locks. See [github.md](github.md#monorepos), including how the action
finds your package manager (npm, pnpm, Yarn or Bun) from the lockfile.
