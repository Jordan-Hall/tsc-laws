# vscode-tslaws

Syntax highlighting for `law` declarations in the tsc-laws TypeScript dialect.
It is an injection grammar (`source.tslaws`) added to `source.ts` and `source.tsx`. It adds no new language.

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
