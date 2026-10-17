# tsc-ts

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

| Package                                | Description                                                                             |
| -------------------------------------- | --------------------------------------------------------------------------------------- |
| [`packages/tsc-ts`](packages/tsc-ts)   | The compiler, written in TypeScript, with the `tsc-ts` command line and `--api` server. |
| [`packages/tsgo`](packages/tsgo)       | tsgo's scanner, parser, binder, and checker, translated to TypeScript.                  |
| [`packages/gots`](packages/gots)       | Go-to-TypeScript translator that generates `packages/tsgo/src/tsgo`.                    |
| [`packages/relater`](packages/relater) | Hand-ported assignability checker over a type graph exported from tsgo.                 |

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
- A scriptc host: macOS, Linux, or Windows, with `clang` available for linking

## Build

```sh
npm ci
npm run fetch:upstream   # clone tsgo at the pinned commit
npm run build            # packages/relater/dist/relater
npm run build:oracle     # tsgo reference builds in packages/*/dist
```

`package.json` pins scriptc `0.2.8`, with its `@scriptc/threads` package. The build fails with any other version.

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

`tsc-ts --api` serves the same API as TypeScript 7.0.2's `tsc --api`, over stdin and stdout, so tools that drive `tsc --api` (such as scriptc) can run `tsc-ts` instead.

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

`TSC_TS_BIN=packages/tsc-ts/dist/tsc` runs the `tsc-ts` and `tsc` tests against a native build.

The server is checked against `tsc --api` 7.0.2 response by response, and scriptc builds the same programs with either. It runs on the tsc-ts compiler, natively or under Node.

Language service methods are supported: `getCompletionsAtPosition`, `getJsDocTags`, `getDocumentationComment`, `getReferencesToSymbolInFile`, `getReferencedSymbolsForNode` and `getSignatureUsages`. Like `tsc --api`, completions that need auto imports (global identifiers, import statements, exhaustive `switch` cases) report `completion list needs auto imports`. The profiling methods (`startCPUProfile`, `stopCPUProfile`, `saveHeapProfile`) are not supported.

## Checker

`packages/gots` translates tsgo's Go packages to TypeScript in `packages/tsgo/src/tsgo`, with a small Go runtime in `packages/tsgo/src/go`. The output compiles with scriptc.

```sh
npm run translate                    # regenerate packages/tsgo/src/tsgo
npm run build:check -w @tsc-ts/tsgo  # packages/tsgo/dist/check
packages/tsgo/dist/check file.ts upstream/typescript-go/internal/bundled/libs
```

`check` reports the same diagnostics as tsgo for all 6,537 of TypeScript's compiler test cases and all 5,907 of its conformance test cases. It is currently about 6.5× slower than tsgo.

`src/drivers/tsc.ts` runs the translated `tsc` command line, with module resolution, `tsconfig.json`, multi-file programs, and emit:

```sh
cd packages/tsgo
npx tsc --outDir dist/js --target es2024 --module nodenext --skipLibCheck --types node src/drivers/tsc.ts
TSC_TS_LIB_DIR=../../upstream/typescript-go/internal/bundled/libs node --stack-size=16000 dist/js/drivers/tsc.js -p path/to/project
```

## Assignability checker

`relater` answers assignability queries between type aliases. An input file has TypeScript declarations and queries:

```json
{
  "source": "type Wide = { value: number }; type Narrow = { value: 1 }; ...",
  "queries": [
    { "source": "Narrow", "target": "Wide" },
    { "source": "Wide", "target": "Narrow" },
    { "source": "RecursiveA", "target": "RecursiveB" }
  ]
}
```

Export a type graph, then check it:

```sh
cd packages/relater
npm run export:graph -- examples/relations.json dist/relations.graph.json
./dist/relater dist/relations.graph.json
# [true, false, true]
```

Run the queries repeatedly to measure throughput:

```sh
./dist/relater dist/relations.graph.json --rounds 10000 --cold
```

`--cold` clears relation caches between rounds.

### Options

| Option                       | Default | Description                             |
| ---------------------------- | ------- | --------------------------------------- |
| `strictNullChecks`           | `true`  | Same as the TypeScript compiler option. |
| `strictFunctionTypes`        | `true`  | Same as the TypeScript compiler option. |
| `exactOptionalPropertyTypes` | `false` | Same as the TypeScript compiler option. |

Set options at the top level of the input file.

### Examples

Each file in [`packages/relater/examples`](packages/relater/examples) covers one area of the checker:

| Example                  | Covers                                                 |
| ------------------------ | ------------------------------------------------------ |
| `relations.json`         | Objects, literals, recursive types                     |
| `generics.json`          | Type argument inference and substitution               |
| `indexed-types.json`     | `keyof`, `T[K]`                                        |
| `mapped-types.json`      | Mapped types, reverse inference                        |
| `conditional-types.json` | `infer`, distribution                                  |
| `conditional-tail.json`  | Tail-recursive conditional types                       |
| `variadic-tuples.json`   | Variadic tuples, rest parameters                       |
| `no-infer.json`          | `NoInfer`                                              |
| `enums.json`             | Enum compatibility                                     |
| `template-types.json`    | Template literal types                                 |
| `patterned-indexes.json` | Template-pattern index signatures                      |
| `string-mappings.json`   | `Uppercase`, `Lowercase`, `Capitalize`, `Uncapitalize` |

## Testing

```sh
npm test                     # compare both checkers with tsgo
npm run test:corpus          # compare the translated checker with tsgo on TypeScript's test cases
npm run coverage -w @tsc-ts/relater     # check that all statements compile statically
npm run lint                 # oxlint
npm run format               # oxfmt
```

## Limitations

- `check` checks one file at a time against the bundled libs.
- The `tsc` driver runs on Node only; it doesn't compile with scriptc yet. Watch mode is not supported, and `--build` is untested.
- `relater` has no expression checking or control flow analysis, and fails comparisons that need protected-member rules as unsupported.

## License

[Apache-2.0](LICENSE). See [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md) for TypeScript-Go and other third-party notices.
