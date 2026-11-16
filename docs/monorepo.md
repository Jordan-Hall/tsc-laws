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
root), and a cycle or a missing file is an error that names the files. `projects` is read from the file you run in and
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

These commands run in every selected project: `check` (with `--proposed`), `accept`, `list`, `mutate` and
`regressions`. `--project` and `--filter` also work in a single-project repository: `--project .` names the project,
and a flag that matches nothing is an error listing the projects there are.

Machine output stays valid. `--json` (or `--reporter json`) on `check`, `list` or `mutate` prints one object keyed by
project path (`.` for the root) with each project's report as the value, and the summary goes to stderr.
`--reporter ndjson` tags every line with a `project` field. `--reporter junit` is refused at a root, because several XML
documents do not make one; run it with `--project`. File arguments are refused too: they belong to one project.

`init`, `ui`, `mcp`, `github`, `propose`, `promote`, `delegate`, `migrate` and `check --watch` work in one project. At a
root with more than one project they stop with a message naming `--project <dir>`; with `--project packages/ui` (or when
the repository has exactly one project) they run in that project's directory. `tslaws init --project .` scaffolds the
root itself.

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
  files, compiles to CommonJS and resolves the way a bundler does. `compilerOptions` in `tslaws.json` still win.
- The compiler gets these options in-process (the built-in path) or in a generated `.tslaws/resolution.tsconfig.json`
  (the tsc-laws compiler, where `paths` is not a command line option). The compiler's flags stay on the command line and
  win over that file.
- The compiled laws run in Node, which knows nothing of `paths`. When Node cannot resolve an import, tslaws asks
  TypeScript with the same options and runs the file it finds (the compiled output for project source). `.ts` and
  `.tsx` files that no compiler wrote out, such as a workspace package's source reached through `node_modules`, are
  transpiled with esbuild as they load. Property workers get the same hooks, and the browser bundler uses the same
  tsconfig through esbuild.
- Source files outside the project reached through `paths` are type-checked and loaded in place. They work with the
  built-in path (laws written as `law(...)` calls); the tsc-laws compiler reports them as outside its root directory.

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

## What comes next

The GitHub flow (`tslaws github report`, `command` and `merge`) still runs one package at a time, as
[docs/github.md](github.md#monorepos) describes. Running it across the whole repository from one command comes next, as
does support for other package managers in the action.
