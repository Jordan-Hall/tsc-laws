# vscode-tslaws

tsc-laws in VS Code: highlighting for `law` declarations, CodeLens status, problems and commands.
The grammar is an injection (`source.tslaws`) added to `source.ts` and `source.tsx`. It adds no new language.

## Features

- **CodeLens** above each `law` in `*.laws.ts`: the status of the last run (`proved`, `bounded`, `tested`, `open`, `failed`,
  `uncovered`, `tampered`, `error`, or `not run`), a `Run` lens, and for a failure the shrunk counterexample.
- **Status bar:** totals such as `laws: 3 proved, 1 failed`. Click it to open the dashboard.
- **Problems:** failed, open, tampered and error laws, on the law's line, with message, counterexample and hint.
- **Commands:** `tslaws.check` (all laws), `tslaws.runFile` (this file), `tslaws.openDashboard` (runs `tslaws ui --no-open --port 0`
  and opens the printed URL), `tslaws.accept`. Accept never runs: it opens a terminal with `npx tslaws accept` typed and not
  executed, and a person presses Enter.
- **On save:** a debounced re-run when a `.ts` file is saved.

Settings: `tslaws.runOnSave` (default `true`), `tslaws.executable` (default: `node_modules/.bin/tslaws`, else `npx tslaws`),
`tslaws.args` (extra arguments for every call, such as `["--compiler", "path/to/tsc"]`).

The logic is in plain modules that do not load `vscode` (`src/parse-report.js`, `src/find-laws.js`, `src/summary.js`,
`src/command.js`); `src/extension.js` is the only glue. There is no bundler and there are no runtime dependencies.

## Dialect

`law` is a contextual keyword. It starts a declaration only when a name and a `(` or `<` follow on the same line:

```ts
law commutes(a: number, b: number) { return a + b === b + a; }
export law proved nonNeg(x: number) => x * x >= 0;
```

Elsewhere `law` is an ordinary identifier (`law(1)`, `obj.law x`, `const law = 1`).
`law` is scoped `storage.type.law.tslaws`, `proved` `storage.modifier.proved.tslaws`
(both also `keyword.declaration.law.tslaws`), and the name `entity.name.function.law.tslaws`.

## Install

Optional, to build a package: `npx @vscode/vsce package`, then `code --install-extension vscode-tslaws-0.0.1.vsix`.
Or run VS Code with `--extensionDevelopmentPath` pointing at this directory.

## Test

`npm install --no-save vscode-textmate vscode-oniguruma; node --test test/grammar.test.mjs`
