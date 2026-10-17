# Changelog

## Unreleased

<!-- release:start -->

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

<!-- release:end -->
