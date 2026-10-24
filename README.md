# tsc-laws

**Laws for TypeScript, checked the way Bend 2 checks its laws, without leaving TypeScript.**

A person writes `law` declarations. A coding agent writes the code. One command, `tslaws check`, says whether the code
satisfies every law, proves what it can, tests the rest, and fails if any exported code is not covered by a law or if
anyone touched the laws.

```ts
export law proved clampWithinBounds(x: number, lo: number, hi: number) {
  assume(lo <= hi);
  const y = clamp(x, lo, hi);
  return y >= lo && y <= hi;
}
```

```
$ tslaws check
PROVED    clampWithinBounds (src/math.laws.ts:5) [smt]
BOUNDED   sortOrders (src/math.laws.ts:11) [smt]
          holds within bounds: int values stay within ±2^26; arrays hold at most 4 elements; loops run at most 4 times
FAILED    sortKeepsLength (src/math.laws.ts:17) [property]
          counterexample: [[3,3]]
UNCOVERED sub (src/math.ts) [coverage]
```

What it offers:

- **`law` as syntax.** A fork of [tsc-ts](https://github.com/vercel-labs/tsc-ts) (the TypeScript 7 compiler, ported to
  TypeScript and compiled natively) parses `law`, enforces the rules of a specification in the checker (TS9101 to TS9106),
  and emits ordinary, type-checked functions. `law` stays a normal identifier
  everywhere else.
- **Proof where possible, tests everywhere else.** Z3 proves laws over exact integers, bigints, strings, booleans and
  records, bounded-checks arrays, loops and recursion, and proves loops for every iteration count when the code carries an
  `invariant`. Whatever does not lower is property-tested with inputs generated from your types, shrunk to a minimal
  counterexample. Every result says which it was.
- **Agents cannot weaken the laws.** A lock file hashes the laws and coverage exemptions; `tslaws accept` needs a person at
  a terminal. A coverage gate fails exported code that no law reaches.
- **Built for the agent loop.** `tslaws init` scaffolds the rules and a Claude Code hook that blocks commits on failure;
  `--json` and `--summary` give compact output with a next-action hint per result; `--watch` re-checks on save.
- **Browser laws.** Name a file `*.browser.laws.ts` and its laws run in a real Chrome, Edge or Chromium against a live DOM,
  with any framework or none. Inputs are still generated from your types and shrunk in Node.
- **Humans stay in control.** It is TypeScript, so every counterexample, proof obligation and fix is code a person can read
  and run. A VS Code grammar highlights `law`.

Start with the [guide to laws](docs/laws.md), the [`tslaws` reference](packages/tslaws/README.md), and the
[basic example](examples/basic/README.md). The rest of this file is the upstream tsc-ts README.

---

## tsc-ts (upstream compiler)

<p>
  <a href="https://vercel.com/labs#active-experiments"><img alt="Vercel Labs Experiment" src="https://img.shields.io/badge/LABS-EXPERIMENT-0a0a0a.svg?style=for-the-badge&amp;logo=Vercel&amp;labelColor=000000" height="28"></a>
  <a href="https://github.com/vercel-labs/tsc-ts/blob/main/LICENSE"><img alt="License: Apache-2.0" src="https://img.shields.io/github/license/vercel-labs/tsc-ts.svg?style=for-the-badge&amp;labelColor=000000" height="28"></a>
</p>

An experimental TypeScript port of the TypeScript 7.0.2 compiler ([TypeScript-Go](https://github.com/microsoft/typescript-go), or tsgo), compiled to native code with [scriptc](https://scriptc.dev).

## Installation

Install the compiler from npm:

```sh
npm install -D tsc-ts
npx tsc-ts -p tsconfig.json
```

The `tsc-ts` package runs a native executable from a per-platform optional dependency (`@tsc-ts/darwin-arm64`, `@tsc-ts/linux-x64-gnu`, …). See [`packages/tsc-ts`](packages/tsc-ts/README.md).

See [CHANGELOG.md](CHANGELOG.md) for release notes and [GitHub Releases](https://github.com/vercel-labs/tsc-ts/releases) for package archives.

To build the packages for the current platform:

```sh
npm run pack:npm -w tsc-ts             # packages/tsc-ts/dist/npm/*.tgz
npm run pack:npm -w tsc-ts -- --check  # also install the tarballs and compile a project
```

`-- --binary dist/tsc` packs an existing native build, relative to `packages/tsc-ts`, instead of building one.

## Packages

| Package                              | Description                                                                                       |
| ------------------------------------ | ------------------------------------------------------------------------------------------------- |
| [`packages/tsc-ts`](packages/tsc-ts) | The compiler, written in TypeScript, with the `tsc-ts` command line and `--api` server.           |
| [`packages/tsgo`](packages/tsgo)     | Reference builds of tsgo (its command line and per-stage drivers) that the tests compare against. |

Tasks run with [Turborepo](https://turborepo.com).

## Documentation

[`apps/web`](apps/web/README.md) contains the tsc-ts compiler guides.

```sh
npm run dev:web
npm run build:web
```

## Requirements

- Node.js 24+ and npm
- Go 1.26
- A scriptc host: macOS, Linux, or Windows, with `clang` available for linking (on Windows, [zig](https://ziglang.org), which scriptc links with there and which compiles the `--api --pipe` server, `packages/tsc-ts/native/pipe-win32.c`)

## Build

```sh
npm ci
npm run fetch:upstream   # clone tsgo at the pinned commit
npm run build            # the Node build of tsc-ts (packages/tsc-ts/dist) and the documentation site
npm run build:oracle     # tsgo reference builds in packages/tsgo/dist
```

`package.json` pins scriptc `0.4.4`, with its `@scriptc/threads` package. The build fails with any other version.

## Compiler

`packages/tsc-ts/src/compiler` is the compiler, ported from tsgo 7.0.2 as idiomatic TypeScript. Each part is compared with tsgo on TypeScript's test corpus (about 12,500 files, 17,000 units after splitting multi-file cases):

| Part                         | Compared with tsgo                                  | Status                   |
| ---------------------------- | --------------------------------------------------- | ------------------------ |
| Scanner                      | tokens, values, errors, rescans, JSDoc              | all files match          |
| Parser and AST               | tree, diagnostics, API source file encoding         | all units match          |
| Binder                       | symbols, tables, flow graph, name resolution        | all units match          |
| Module resolution            | results, package IDs, `--traceResolution`           | all requests match       |
| `tsconfig.json` and programs | `--showConfig`, `--listFilesOnly`, `--explainFiles` | all cases match          |
| Command line and options     | output, errors, exit codes, `--locale`              | all cases match          |
| Diagnostics catalog          | messages, 13 translations, output formats           | all match                |
| JavaScript emit              | emitted files, 39 option sets                       | all compared units match |
| Declaration emit             | `.d.ts` and `.d.ts.map` output, declaration errors  | all units match          |
| `--build`, `--incremental`   | output, `.tsbuildinfo`, emitted files, `--watch`    | all scenarios match      |
| Type checker                 | diagnostics per file                                | all files match          |

The corpus scripts are in `packages/tsc-ts/scripts` (`*-corpus.mjs`).

## API server

`tsc-ts --api` serves the same API as TypeScript 7.0.2's `tsc --api`, over stdin and stdout, so tools that drive `tsc --api` (such as scriptc) can run `tsc-ts` instead. On Windows the native executable also serves it over a named pipe it creates (`--pipe \\.\pipe\<name>`), as `tsc --api --pipe` does.

```sh
npm run build -w tsc-ts
node packages/tsc-ts/dist/tsc-ts/src/main.js --api --cwd path/to/project
```

Native builds read lib files from the executable's directory, or from `TSC_TS_LIB_DIR`:

```sh
npm run build:native -w tsc-ts       # packages/tsc-ts/dist/tsc
npm run build:native:dev -w tsc-ts   # unoptimized, faster to build
TSC_TS_LIB_DIR=upstream/typescript-go/internal/bundled/libs packages/tsc-ts/dist/tsc -p path/to/project
```

`build:native` optimizes with the committed profile `packages/tsc-ts/profiles/tsc-ts.profdata`. `npm run refresh-profile -w tsc-ts -- --project <dir>[:<tsconfig>]` collects it again: it builds an instrumented tsc-ts, checks the tsc-ts sources and each project with it, and merges the results. A profile from older sources still applies to the functions that did not change. A profile from another scriptc version does not: the code scriptc generates changes between versions, so the profile is collected again whenever the pinned scriptc changes. `profiles/scriptc-version` records the scriptc that collected it, and `tests/profile.test.mjs` fails when it differs from the pinned one.

`TSC_TS_BIN=packages/tsc-ts/dist/tsc` runs the tsc-ts tests that take a native build against it.

The server is checked against `tsc --api` 7.0.2 response by response, and scriptc builds the same programs with either. It runs on the tsc-ts compiler, natively or under Node.

Language service methods are supported: `getCompletionsAtPosition`, `getJsDocTags`, `getDocumentationComment`, `getReferencesToSymbolInFile`, `getReferencedSymbolsForNode` and `getSignatureUsages`. Like `tsc --api`, completions that need auto imports (global identifiers, import statements, exhaustive `switch` cases) report `completion list needs auto imports`. The profiling methods (`startCPUProfile`, `stopCPUProfile`, `saveHeapProfile`) are not supported.

## Testing

```sh
npm test                     # compare tsc-ts with tsgo
npm run bench -w tsc-ts      # time tsc-ts against tsgo and TypeScript's JavaScript compiler
npm run lint                 # oxlint
npm run format               # oxfmt
```

## License

[Apache-2.0](LICENSE). See [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md) for TypeScript-Go and other third-party notices.
