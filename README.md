# tsc-ts

An experimental TypeScript port of the [TypeScript-Go](https://github.com/microsoft/typescript-go) (tsgo) compiler front end, compiled to native code with [scriptc](https://scriptc.dev).

## Packages

| Package                                | Description                                                             |
| -------------------------------------- | ----------------------------------------------------------------------- |
| [`packages/tsgo`](packages/tsgo)       | tsgo's scanner, parser, binder, and checker, translated to TypeScript.  |
| [`packages/gots`](packages/gots)       | Go-to-TypeScript translator that generates `packages/tsgo/src/tsgo`.    |
| [`packages/relater`](packages/relater) | Hand-ported assignability checker over a type graph exported from tsgo. |

Tasks run with [Turborepo](https://turborepo.com).

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

`package.json` pins scriptc `0.2.5`. The build fails with any other version.

## Checker

`packages/gots` translates tsgo's Go packages to TypeScript in `packages/tsgo/src/tsgo`, with a small Go runtime in `packages/tsgo/src/go`. The output compiles with scriptc.

```sh
npm run translate                    # regenerate packages/tsgo/src/tsgo
npm run build:check -w @tsc-ts/tsgo  # packages/tsgo/dist/check
packages/tsgo/dist/check file.ts upstream/typescript-go/internal/bundled/libs
```

`check` reports the same diagnostics as tsgo for all 6,537 of TypeScript's compiler test cases and all 5,907 of its conformance test cases. It is currently about 6.5× slower than tsgo.

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

### Benchmarks

Median of five runs on an Apple M1 Max, measuring assignability checks only (no parsing, binding, or startup). Values are relater time divided by tsgo time; below 1× means relater is faster. Raw data: [`packages/relater/benchmarks/latest.json`](packages/relater/benchmarks/latest.json).

| Workload          | Warm cache | Cold cache |
| ----------------- | ---------: | ---------: |
| primitives        |      0.40× |      1.25× |
| structural        |      0.43× |      0.73× |
| signatures        |      0.64× |      0.89× |
| generics          |      0.71× |      1.56× |
| array-methods     |      0.14× |      0.69× |
| indexed-types     |      0.25× |      1.60× |
| mapped-types      |      0.39× |      1.71× |
| conditional-types |      0.37× |      1.69× |
| variadic-tuples   |      0.92× |      1.11× |
| no-infer          |      0.76× |      1.70× |
| enums             |      0.50× |      2.12× |
| template-types    |      0.96× |      1.83× |
| patterned-indexes |      0.63× |      1.42× |
| string-mappings   |      0.84× |      1.41× |

These are synthetic, single-threaded benchmarks. They don't predict whole-compiler performance.

## Testing

```sh
npm test                     # compare both checkers with tsgo
npm run test:corpus          # compare the translated checker with tsgo on TypeScript's test cases
npm run coverage -w @tsc-ts/relater     # check that all statements compile statically
npm run bench -w @tsc-ts/relater        # time relater against tsgo
npm run lint                 # oxlint
npm run format               # oxfmt
```

## Limitations

- `check` checks one file at a time against the bundled libs. Module resolution, multi-file programs, and emit are not supported.
- `relater` has no expression checking or control flow analysis, and fails comparisons that need protected-member rules as unsupported.

## License

[Apache-2.0](LICENSE). See [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md) for TypeScript-Go and other third-party notices.
