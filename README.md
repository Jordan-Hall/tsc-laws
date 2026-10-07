# tsts

An experimental TypeScript port of tsgo's resolved-type assignability engine, compiled to native code with **scriptc v0.2.5**. The full checker port is **incomplete**: tsts currently takes a resolved type graph, rather than checking TypeScript source files. The Go oracle constructs those graphs and supplies reference answers for tests; the tsts executable performs its own comparisons and contains no Go checker.

This stage measures whether statically compiled TypeScript can make the checker's relation engine faster. It includes enum relations, native generic substitution, lazy reference members, contextual signature inference and `NoInfer`, generic variadic tuples/rest signatures, `keyof`/indexed-access construction, mapped types and reverse inference, conditional evaluation with tail recursion and `infer` extraction, template-literal construction, matching, constrained inference and key remapping, intrinsic string mappings, patterned index signatures, and marker-based generic-reference variance. It does not yet replace tsgo inside scriptc. Full type construction, expression checking, flow analysis, and diagnostics still need ports.

## Build and verify

Use Node.js/npm, Git, and a supported scriptc host. Building the reference oracle also requires Go; upstream's `go.mod` selects Go 1.26.0. Both executables are built for the host architecture.

```sh
npm ci
npm run fetch:upstream
npm run build
npm run build:oracle
npm test
npm run coverage
npm run bench
```

The compiler dependency is pinned to exactly `0.2.5` in `package.json` and `package-lock.json`; the build refuses a different version. If npm's local release-age policy rejects that exact release, the installation used for this experiment was `npm install --before=2026-10-07T00:00:00Z`.

The native executable is `dist/tsts`. scriptc builds it in release mode without `--dynamic`; coverage reports whether all statements compile statically. System libraries remain dynamically linked on macOS. `tools/build.mjs` also checks the generated LLVM signatures to prevent recursive type IDs from silently becoming boxed arguments.

The current verification passes 117 tests with 56,757 differential queries against tsgo. scriptc v0.2.5 reports 4,181 of 4,181 statements compiled statically, with no dynamic remainder. Tests and benchmarks reject binaries built from older source files.

The reference is Microsoft TypeScript-Go at [`89d5d5b2849a0db0957065889ca58536fa6d2e4a`](https://github.com/microsoft/typescript-go/tree/89d5d5b2849a0db0957065889ca58536fa6d2e4a). Its ignored checkout lives in `upstream/typescript-go`; the oracle builder adds test instrumentation there. `npm run generate` regenerates the checked-in type flags and Unicode 15.1.0 casing tables from that revision.

## Try a comparison

```sh
npm run export:graph -- examples/relations.json dist/example.graph.json
./dist/tsts dist/example.graph.json
./dist/tsts dist/example.graph.json --rounds 10000 --cold

npm run export:graph -- examples/generics.json dist/generics.graph.json
./dist/tsts dist/generics.graph.json

npm run export:graph -- examples/indexed-types.json dist/indexed-types.graph.json
./dist/tsts dist/indexed-types.graph.json

npm run export:graph -- examples/mapped-types.json dist/mapped-types.graph.json
./dist/tsts dist/mapped-types.graph.json

npm run export:graph -- examples/conditional-types.json dist/conditional-types.graph.json
./dist/tsts dist/conditional-types.graph.json

npm run export:graph -- examples/variadic-tuples.json dist/variadic-tuples.graph.json
./dist/tsts dist/variadic-tuples.graph.json

npm run export:graph -- examples/no-infer.json dist/no-infer.graph.json
./dist/tsts dist/no-infer.graph.json

npm run export:graph -- examples/conditional-tail.json dist/conditional-tail.graph.json
./dist/tsts dist/conditional-tail.graph.json

npm run export:graph -- examples/enums.json dist/enums.graph.json
./dist/tsts dist/enums.graph.json

npm run export:graph -- examples/template-types.json dist/template-types.graph.json
./dist/tsts dist/template-types.graph.json

npm run export:graph -- examples/patterned-indexes.json dist/patterned-indexes.graph.json
./dist/tsts dist/patterned-indexes.graph.json

npm run export:graph -- examples/string-mappings.json dist/string-mappings.graph.json
./dist/tsts dist/string-mappings.graph.json
```

The example returns `[true, false, true]`: a literal-valued object fits a wider object, the reverse fails, and two equivalent recursive types fit each other. The input to the exporter contains TypeScript source and queries naming its top-level type aliases. Optional input settings are `strictNullChecks`, `strictFunctionTypes`, and `exactOptionalPropertyTypes`; the first two default to true.

The generic example also returns `[true, false, true]`. tsts infers the identity function's type argument and substitutes `Box` members inside the native executable.

The indexed-types example returns `[true, false, true]`. tsts infers a generic getter's object/key arguments and evaluates `T[K]`, rejects the wrong return type, and constructs `keyof T` and `T[keyof T]` for a generic reference.

The mapped-types example returns `[true, false, true]`. tsts reverse-infers an object from a mapped wrapper, rejects an incompatible return, and constructs `Partial<T>` members inside the native executable.

The conditional-types example returns `[true, false, true]`. tsts recursively extracts array elements through `infer`, rejects the wrong return type, and distributes `Extract<T, number>` over a substituted union inside a generic reference.

The variadic-tuples example returns `[true, false, true]`. tsts infers a tuple from a generic rest signature, rejects the wrong return tuple, and recursively reverses a readonly tuple through variadic `infer` slices.

The `NoInfer` example returns `[true, false, true]`. An ordinary signature combines two candidates; `NoInfer` blocks the second candidate and rejects the mismatched hint. A concrete object substitution remains assignable after passing through the wrapper.

The conditional-tail example returns `[true, false, true]`. tsts builds a 180-element tuple through a recursive conditional alias and checks its length inside the native executable. Eligible aliases accept up to 999 tail steps; the 1,000-step boundary reports a complexity error.

The enum example returns `[true, false, true]`. A matching numeric literal fits an enum member, differently named enum declarations remain distinct, and native `keyof typeof Enum` excludes the reverse numeric index.

The template-types example returns `[true, false, true]`. tsts extracts a numeric literal through a constrained template `infer`, rejects the wrong return type, and constructs finite mapped keys such as `on_click` inside the native executable.

The patterned-indexes example returns `[true, false, true]`. tsts constructs a broad `pre_${string}` index from a mapped remap, rejects the wrong value type, and intersects the values of two patterns matching the same indexed key.

The string-mappings example returns `[true, false, true]`. tsts constructs `Uppercase<T>` inside contextual signature inference, expands `ß` to `SS`, rejects the wrong casing, and merges colliding mapped keys. `Lowercase`, `Capitalize`, and `Uncapitalize` also execute natively with the pinned tsgo Unicode tables, including final-sigma context and lone surrogates.

The executable accepts `tsts.type-graph.v11` JSON. Version 11 adds intrinsic string-mapping kinds and inner type IDs. Version 10 added pattern index key/value IDs and readonly metadata for all index signatures. Version 9 added template text spans and placeholder IDs; matching preserves lone surrogates and consumes one Unicode code point for adjacent captures, matching the pinned tsgo revision. Re-export older graphs: version 7 added conditional alias/nested-branch metadata for tail recursion, and version 8 added enum declaration identities, member values, and reverse-index markers. Signature `effectiveRest` templates and tuple shapes remain available from version 6. tsts constructs tuple members from the Array/ReadonlyArray declarations, preserving polymorphic `this` returns such as `sort()`. [types.ts](src/checker/types.ts) defines the schema. Type IDs are zero-based array indices; absent optional references use `-1`. Each graph query carries reference `expected` and `label` fields, but tsts computes its answer independently. String literal values, enum names/values, template text spans, and property names preserve the oracle's string bytes as opaque base64 so lone-surrogate identities survive JSON transport. Unique symbols retain distinct type IDs. Template construction/matching, intrinsic casing, index selection, enum compatibility, variances, mapped members, conditional evaluations, and instantiated key/access results are computed in the native checker.

## Results

The measured results are in [benchmarks/latest.json](benchmarks/latest.json), including all five samples, compiler versions, CPU, architecture, source hashes, checksums, and timing scope. Both lanes compare the same resolved source/target types, and the runner requires every query result and repeated-check checksum to agree. It refuses binaries built from older source files.

<!-- benchmark-table -->
Apple M1 Max, darwin/arm64, go1.26.0, scriptc 0.2.5; 2026-10-07. A ratio below 1 means tsts took less time.

| Workload | Cache | Checks | tsgo (ms) | tsts (ms) | tsts / tsgo |
| --- | --- | ---: | ---: | ---: | ---: |
| string-mappings | Warm | 648,000 | 17.80 | 14.89 | 0.84× |
| string-mappings | Cold | 648,000 | 754.72 | 1062.03 | 1.41× |
| patterned-indexes | Warm | 1,568,000 | 60.82 | 38.44 | 0.63× |
| patterned-indexes | Cold | 1,568,000 | 444.90 | 631.30 | 1.42× |
| template-types | Warm | 722,000 | 20.11 | 19.27 | 0.96× |
| template-types | Cold | 722,000 | 622.05 | 1135.37 | 1.83× |
| enums | Warm | 2,048,000 | 113.01 | 56.98 | 0.50× |
| enums | Cold | 2,048,000 | 139.41 | 295.91 | 2.12× |
| no-infer | Warm | 648,000 | 17.55 | 13.36 | 0.76× |
| no-infer | Cold | 648,000 | 308.81 | 524.52 | 1.70× |
| variadic-tuples | Warm | 648,000 | 17.45 | 16.14 | 0.92× |
| variadic-tuples | Cold | 648,000 | 989.47 | 1095.01 | 1.11× |
| primitives | Warm | 5,290,000 | 196.94 | 79.13 | 0.40× |
| primitives | Cold | 5,290,000 | 239.91 | 300.22 | 1.25× |
| structural | Warm | 968,000 | 55.29 | 23.75 | 0.43× |
| structural | Cold | 968,000 | 292.14 | 213.14 | 0.73× |
| signatures | Warm | 2,000,000 | 53.43 | 34.02 | 0.64× |
| signatures | Cold | 2,000,000 | 591.85 | 529.55 | 0.89× |
| generics | Warm | 200,000 | 5.13 | 3.63 | 0.71× |
| generics | Cold | 200,000 | 136.06 | 212.22 | 1.56× |
| array-methods | Warm | 200,000 | 23.46 | 3.40 | 0.14× |
| array-methods | Cold | 200,000 | 90.76 | 62.21 | 0.69× |
| indexed-types | Warm | 288,000 | 21.27 | 5.21 | 0.25× |
| indexed-types | Cold | 288,000 | 140.71 | 224.99 | 1.60× |
| mapped-types | Warm | 242,000 | 11.73 | 4.62 | 0.39× |
| mapped-types | Cold | 242,000 | 218.09 | 373.68 | 1.71× |
| conditional-types | Warm | 288,000 | 14.30 | 5.35 | 0.37× |
| conditional-types | Cold | 288,000 | 186.95 | 315.81 | 1.69× |

The native port was faster in 17 of these 28 measured cases. String mappings took 0.84× Go’s time with warm caches and 1.41× with cold caches. Template types took 0.96× with warm caches and 1.83× with cold caches. Cold primitives, generics, variadic tuples, enums, NoInfer, patterned indexes, indexed types, mapped types, and conditional types also remain slower than Go.
<!-- /benchmark-table -->

Each row reports the median of five samples on one host. Warm measurements reuse relation caches. Cold measurements clear relation caches and tsts's contextual-inference memoization between rounds, retaining resolved types, instantiated signatures, and allocated cache storage. Cold generic relations therefore include contextual inference. One untimed pass warms lazy resolution in each process. Timing excludes parsing, binding, graph export/decoding, initial type construction/resolution, process startup, and IPC.

These are synthetic, single-threaded assignability benchmarks against Go's production checker API. The TypeScript implementation covers fewer semantics than the Go checker. A speed advantage here supports further experimentation; it does not establish a faster full checker or compiler, or performance on real projects.

## License

Ported material retains Microsoft's Apache-2.0 licensing. See [LICENSE](LICENSE), [NOTICE.txt](NOTICE.txt), and the source attribution comments.
