# tsts

An experimental TypeScript port of the type checker from [TypeScript-Go](https://github.com/microsoft/typescript-go) (tsgo), compiled to a native executable with [scriptc](https://scriptc.dev).

> [!NOTE]
> tsts does not check TypeScript source files yet. It checks assignability between types in a resolved type graph that a Go reference build exports.

## Requirements

- Node.js 24+ and npm
- Go 1.26 (for the reference build)
- A scriptc host: macOS, Linux, or Windows, with `clang` available for linking

## Build

```sh
npm ci
npm run fetch:upstream   # clone tsgo at the pinned commit
npm run build            # dist/tsts
npm run build:oracle     # dist/tsgo-oracle
```

`package.json` pins scriptc `0.2.5`. The build fails with any other version.

## Usage

An input file has TypeScript declarations and queries naming source and target type aliases:

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
npm run export:graph -- examples/relations.json dist/relations.graph.json
./dist/tsts dist/relations.graph.json
# [true, false, true]
```

Run the queries repeatedly to measure throughput:

```sh
./dist/tsts dist/relations.graph.json --rounds 10000 --cold
```

`--cold` clears relation caches between rounds.

### Options

| Option | Default | Description |
| --- | --- | --- |
| `strictNullChecks` | `true` | Same as the TypeScript compiler option. |
| `strictFunctionTypes` | `true` | Same as the TypeScript compiler option. |
| `exactOptionalPropertyTypes` | `false` | Same as the TypeScript compiler option. |

Set options at the top level of the input file.

## Examples

Each file in [`examples`](examples) covers one area of the checker:

| Example | Covers |
| --- | --- |
| `relations.json` | Objects, literals, recursive types |
| `generics.json` | Type argument inference and substitution |
| `indexed-types.json` | `keyof`, `T[K]` |
| `mapped-types.json` | Mapped types, reverse inference |
| `conditional-types.json` | `infer`, distribution |
| `conditional-tail.json` | Tail-recursive conditional types |
| `variadic-tuples.json` | Variadic tuples, rest parameters |
| `no-infer.json` | `NoInfer` |
| `enums.json` | Enum compatibility |
| `template-types.json` | Template literal types |
| `patterned-indexes.json` | Template-pattern index signatures |
| `string-mappings.json` | `Uppercase`, `Lowercase`, `Capitalize`, `Uncapitalize` |

## Testing

```sh
npm test          # compare tsts answers with tsgo
npm run coverage  # check that all statements compile statically
npm run bench     # time tsts against tsgo
```

## Benchmarks

Median of five runs on an Apple M1 Max, measuring assignability checks only (no parsing, binding, or startup). Values are tsts time divided by tsgo time; below 1× means tsts is faster. Raw data: [`benchmarks/latest.json`](benchmarks/latest.json).

| Workload | Warm cache | Cold cache |
| --- | ---: | ---: |
| primitives | 0.40× | 1.25× |
| structural | 0.43× | 0.73× |
| signatures | 0.64× | 0.89× |
| generics | 0.71× | 1.56× |
| array-methods | 0.14× | 0.69× |
| indexed-types | 0.25× | 1.60× |
| mapped-types | 0.39× | 1.71× |
| conditional-types | 0.37× | 1.69× |
| variadic-tuples | 0.92× | 1.11× |
| no-infer | 0.76× | 1.70× |
| enums | 0.50× | 2.12× |
| template-types | 0.96× | 1.83× |
| patterned-indexes | 0.63× | 1.42× |
| string-mappings | 0.84× | 1.41× |

These are synthetic, single-threaded benchmarks. They don't predict whole-compiler performance.

## Limitations

- No parser, binder, or diagnostics. Input comes from the Go reference build.
- No expression checking or control flow analysis.
- Comparisons that need protected-member rules fail as unsupported.

## License

[Apache-2.0](LICENSE). See [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md) for TypeScript-Go and other third-party notices.
