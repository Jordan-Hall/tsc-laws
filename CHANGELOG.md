# Changelog

## Unreleased

<!-- release:start -->

## 0.0.5

### Highlights

- **Programmatic API:** `tsc-ts/api` adds `createProgram`, `Program`, `TypeChecker`, `parseSourceFile`, the node functions (including `getSourceFileOfNode` and `getTextOfNode`), `getPreEmitDiagnostics` and `dispose()`, with tsc-ts's own nodes, symbols, types and signatures. Its node interfaces now declare what tsc-ts's nodes hold: `parent` may be undefined, optional members are `?: T | undefined`, and members that were declared but never set (`modifierFlags`, `tokenFlags`, `phaseModifier`) hold TypeScript 7's values. The API compiles with scriptc, and its native build gives the same answers as the Node build.
- **Composite rebuilds:** An incremental rebuild of a composite program (any project with references) checks and emits the files a change affects on checker threads. Rebuilding TypeScript 5.8 after an edit to `core.ts`: `-p src/compiler` 1.96 s → 0.85 s, `-b src/tsc` 1.01 s → 0.88 s. Outputs, the declaration files written or left unchanged, and the build info are the same.
- **`noEmitOnError` builds:** The main thread takes each file's declaration diagnostics from the checker thread that emitted it instead of running the declaration transform again (typescript-eslint `-b` clean build: 5.39 s → 3.23 s, peak RSS down 20%).
- **Memory:** A parser frees its copy of the file's text as soon as it's done, instead of at the next cycle collection (TypeScript 5.8 `src/compiler`, single-threaded: emit peak 330 MB → 312 MB, check 333 MB → 318 MB).

### Fixes

- **Enums:** A number member of an enum is no longer assignable to a string member of the same enum (`enum M { A, B = 'b' }; const x: M.B = M.A` reports TS2322), as TypeScript 7.0.2 does.
- **Default library files:** With `skipLibCheck` off, the default library files are checked with the checker of the other files, as TypeScript 7.0.2 does. Excalidraw no longer reports TS2430 twice. A one-file program that checks its libraries now takes 0.19 s (0.05 s before; TypeScript 7.0.2: 0.26 s).

### Improvements

- `typeToString` of simple types is about 20% faster in native builds: a node builder creates its tables on first use, and the objects of one call no longer form reference cycles.
- The thread entry moves out of `main.ts`, so a host embedding tsc-ts can start the same parse and checker threads. tsc-ts/api's programs use a file the parse threads prepared only when the host gives the same text for it.

<!-- release:end -->

## 0.0.4

### Highlights

- **Programmatic API types:** The `tsc-ts` package exports `tsc-ts/api`, which describes tsc-ts's programs, checkers, nodes, symbols, types and signatures with TypeScript 7's API names and numbering. Its node interfaces are generated from TypeScript 7's AST schema, and its enums and `CompilerOptions` match TypeScript 7's API package. The export has a JavaScript build with declaration files, and the sources under the `source` condition.
- **Watch mode:** In a watch without build info, the first edit of a file rechecks the files that import it only when its declaration output changes, as later edits do. Before, the first edit of each file rechecked all of its importers (first body edits: VS Code 4.18 s → 1.17 s, Sentry 3.91 s → 1.29 s, T3 web 3.12 s → 0.40 s; with `--declaration`, VS Code 4.86 s → 1.09 s). Memory after four edits on VS Code went from 11.2 GB to 7.5 GB.
- **Incremental builds:** Parse threads keep parsing while the main thread reads an incremental program's build info (edit rebuilds: Sentry 15–17% faster, VS Code 10–14% faster).
- **`--api` echo:** `tsc-ts --api` returns an `echo` request's payload bytes unchanged, including a byte order mark and bytes that are not UTF-8 text, as TypeScript 7.0.2 does.
- **`--api` snapshots:** After a change to one file whose imports and references are unchanged, `updateSnapshot` replaces the file in the program instead of loading the program again (Excalidraw: 488 ms → 2.6 ms, TypeORM: 577 ms → 2.7 ms; TypeScript 7.0.2: 2.3 ms and 4.6 ms). Results match TypeScript 7.0.2, including for a changed JSX import source pragma.
- **Parsing:** A parse session and its file loader are freed when the parse threads exit, instead of at the main thread's next full cycle collection (Sentry check: 49 ms faster).

### Fixes

- **`--api` file deletion:** A file the client reports deleted stays out of the session until it is reported changed or created, or until `invalidateAll`, and a `created` report reads the file again, as in TypeScript 7.0.2. Before, a file reported deleted and then created kept its old contents.
- **`--api` type nodes:** With a location, `typeToTypeNode` and `signatureToSignatureDeclaration` reuse the type nodes written in the declarations, with their positions encoded as UTF-8 offsets, as TypeScript 7.0.2 does (for example, `b?: string` returns `string`).
- **Errors that were missing:** tsc-ts now reports TS2536 for invalid indexes inside the true branch of a conditional type that checks the same indexed access, as TypeScript 7.0.2 does.

### Improvements

- When a program has syntactic, option or other program errors, checker threads emit its files without checking them, as one checker and TypeScript 7.0.2 do (rxjs with its option error: 1.5 s → 0.15 s; TypeScript 7.0.2: 0.73 s).
- The check for a mapped type with a `keyof` constraint reads the constraint as a type operator node, the node type it has. No change in output.
- Adds a project test for callbacks of generic JSX components whose props type is conditional (#210).

## 0.0.3

### Fixes

- **Conditional type inference:** Conditional types that infer a spread, such as `[...args: infer A, cb: C]`, no longer resolve to `never`. This was a regression in 0.0.2.
- **Watch mode:** `tsc-ts -w` no longer exits with "Cannot assign to read only property 'id'" when a config edit turns checker threads on after the first build ran with `"checkers": 1` or `"singleThreaded": true`.
- **Errors that were missing:** tsc-ts now reports, as TypeScript 7.0.2 does:
  - Values of UMD globals (`export as namespace`) referenced from modules, including JSX's implicit `React` under `"jsx": "react"` (TS2686, fixing #219).
  - Value imports that share their name with a global value the file uses, under `isolatedModules` (TS2866).
  - Unused labels under `allowUnusedLabels: false` (TS7028).
  - Declaration emit errors under `noEmit`, also when there are other errors (such as TS2883).
  - JSDoc `@type` tags on class methods without a matching call signature (TS8030).
  - Implicit `any` for the `null` and `undefined` in a function's inferred return, yield and next types without `strictNullChecks` (TS7010, TS7011, TS7025, TS7055).
- **Module and emit checks:** Errors now match TypeScript 7.0.2 for:
  - ESM imports and exports in CommonJS files under `verbatimModuleSyntax`.
  - Enum members, namespaces, ambient const enums and decorated signatures under `isolatedModules`.
  - `<T>expr` type assertions under `erasableSyntaxOnly`, which no longer checks JavaScript files.
  - Missing `tslib` helpers under `importHelpers`.
  - Declarations named `require`, `exports`, `Promise` and other names that the emitted code uses.
  - JSON modules imported into ES modules under `node16` to `nodenext`, which now have only a default export.
  - Deferred imports, `export * as "name"` and BigInt literals under module kinds and targets that don't support them.
  - Type-only exports (`export { type X }`, `import type` re-exports and `export type *`), which are no longer values of a module's namespace object.
- **Type checking:** Errors now match TypeScript 7.0.2 for:
  - `exactOptionalPropertyTypes` (on VS Code, the lines that differ from TypeScript 7.0.2 went from 1,506 to 2).
  - Narrowing of element accesses, union discrimination and loop variables.
  - Conditional types whose extends check fails on a fixed type argument.
  - Element compound assignments and used-before-assigned variables under `noUncheckedIndexedAccess`.
  - Property initializers that reference constructor locals, and static properties that conflict with `Function` properties.
  - Type arguments of untyped JSX elements and contextual types of JSX attributes and children.
  - Namespaced JSX attributes such as `q:slot`, which no longer match template literal index signatures.
  - Unannotated `this` parameters, which now take the contextual `this` type, as in object literal methods.
  - The type of a `satisfies` expression, which is now checked like other type annotations.
  - Type arguments of references whose other arguments are unresolved, of references to unresolved types, and of import types such as `import("./m").G<number>`.
  - Missing type arguments in JavaScript, which are `any` where the type parameter's default is `unknown` or `{}`.
  - The yield type of generators with `yield` expressions in a class's `extends` clause.
  - Unused identifiers, which are now reported only in code the checker checks.
  - Global errors such as a missing `Disposable`, which are now reported at position 0, and unreachable code that starts at a missing statement.
- **Declaration emit:** Union members are written to `.d.ts` files in the same order in every run and with any number of checker threads. Error messages list union members in the union's order, and widened object literal types order their optional `undefined` properties as TypeScript 7.0.2 does.

### Improvements

- The first build of `tsc-ts -w`, and rebuilds that affect many files, run on checker threads (VS Code's first watch build: 56.9 s → 6.7 s).
- Watch rebuilds after a body edit recheck fewer files. In projects without `declaration`, `incremental` or `composite`, an edit no longer rechecks the edited file's importers (four body edits on VS Code: 48.5 s → 15.6 s). An edit that keeps a file's declaration signature rechecks only that file (VS Code: 1.40 s → 1.07 s).
- Incremental rebuilds compare and write build info faster (VS Code rebuilds 16–21% faster), and compare unchanged files' references on checker threads (another 9–11% on VS Code rebuilds).
- `tsc-ts --api` keeps file contents and parsed files across snapshots, so `updateSnapshot` after a file change is 4–9x faster and the server uses about half the memory. `getSourceFile` is faster on large files.
- Checking is 2–4% faster on large projects, and faster on long chains of conditions, large tuple spreads, recursive conditional types and files with many unresolved names.
- Lower peak memory on large projects: mapped types, type references and pending member tables are stored more compactly (each change lowers peak memory by 1.4–2.2% on the T3 Code apps).
- Build with scriptc 0.3.6, which lowers check wall time by about 6% and peak memory by 3–7%.
- The watch tests no longer fail intermittently, and the project tests run again after a merge had left their file empty.

## 0.0.2

### Fixes

- **Linux glibc compatibility:** ARM64 and x64 packages now target glibc 2.34 and newer, fixing startup failures on distributions such as Debian 12.

### Improvements

- Emit files skipped by type checking, such as `// @ts-nocheck` files, while checker threads check other files.
- Batch diagnostic output and reuse each file's relative path during formatting.
- Flatten the documentation sidebar into a single level.
- Publish GitHub releases with changelog notes and all eight npm package archives after npm publishing succeeds.

## 0.0.1

Initial release of **tsc-ts**, a Vercel Labs experiment: the TypeScript 7.0.2 compiler ported to TypeScript and compiled to native code with [scriptc](https://scriptc.dev).

### Features

- **The `tsc-ts` command line** type-checks projects and emits JavaScript and declaration files using `tsconfig.json`, with support for incremental builds, project references, and watch mode.
- **The `--api` server** provides the TypeScript 7.0.2 compiler API over stdin and stdout for tools that use `tsc --api`.
- **Native npm packages** support macOS ARM64 and x64, Linux ARM64 and x64 with glibc or musl, and Windows x64. The `tsc-ts` launcher selects the package for the host platform.

### Installation

```sh
npm install --save-dev tsc-ts
npx tsc-ts -p tsconfig.json
```
