# Changelog

## Unreleased

<!-- release:start -->

## 0.0.3

### Fixes

- **Conditional type inference:** Conditional types that infer a spread, such as `[...args: infer A, cb: C]`, no longer resolve to `never`. This was a regression in 0.0.2.
- **Module and emit checks:** Errors now match TypeScript 7.0.2 for:
  - ESM imports and exports in CommonJS files under `verbatimModuleSyntax`.
  - Enum members, namespaces, ambient const enums and decorated signatures under `isolatedModules`.
  - `<T>expr` type assertions under `erasableSyntaxOnly`, which no longer checks JavaScript files.
  - Missing `tslib` helpers under `importHelpers`.
  - Declarations named `require`, `exports`, `Promise` and other names that the emitted code uses.
  - JSON modules imported into ES modules under `node16` to `nodenext`, which now have only a default export.
  - Deferred imports, `export * as "name"` and BigInt literals under module kinds and targets that don't support them.
- **Type checking:** Errors now match TypeScript 7.0.2 for:
  - Narrowing of element accesses, union discrimination and loop variables.
  - Conditional types whose extends check fails on a fixed type argument.
  - Element compound assignments and used-before-assigned variables under `noUncheckedIndexedAccess`.
  - Property initializers that reference constructor locals, and static properties that conflict with `Function` properties.
  - Type arguments of untyped JSX elements and contextual types of JSX attributes and children.
  - Unused identifiers, which are now reported only in code the checker checks.
  - Global errors such as a missing `Disposable`, which are now reported at position 0.
- **Declaration emit:** Union members are written to `.d.ts` files in the same order in every run and with any number of checker threads. Error messages list union members in the union's order, and widened object literal types order their optional `undefined` properties as TypeScript 7.0.2 does.

### Improvements

- The first build of `tsc-ts -w`, and rebuilds that affect many files, run on checker threads (VS Code's first watch build: 56.9 s → 6.7 s).
- Incremental rebuilds compare and write build info faster (VS Code rebuilds 16–21% faster).
- `tsc-ts --api` keeps file contents and parsed files across snapshots, so `updateSnapshot` after a file change is 4–9x faster and the server uses about half the memory. `getSourceFile` is faster on large files.
- Checking is 2–4% faster on large projects, and faster on long chains of conditions, large tuple spreads, recursive conditional types and files with many unresolved names.
- Build with scriptc 0.3.6, which lowers check wall time by about 6% and peak memory by 3–7%.

<!-- release:end -->

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
