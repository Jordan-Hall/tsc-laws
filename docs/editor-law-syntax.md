# The editor and the `law` keyword

VS Code shows red squiggles under `law`, the law's name and its parameter list on every `law name(params) { ... }`. The cause
is simple: VS Code's TypeScript support runs Microsoft's `tsserver`, and `tsserver` does not know `law`. Only the tsc-laws
compiler (`packages/tsc-ts`, a fork of tsgo) parses `law` and enforces TS9101 to TS9106. CodeLens still works because the
extension finds laws with its own scanner and gets results from `tslaws check`, not from `tsserver`.

This note records what each way of fixing that was checked against, what was chosen, and what is not proven.

## What the language is

Read from `packages/tsc-ts/src/compiler/parser.ts` (`isLawDeclarationStart`, `parseLawDeclaration`) and `docs/laws.md`:

```
[export] [async] law [proved] name<T>(a: A, b: B) { block }
[export] [async] law [proved] name<T>(a: A, b: B): R => expression;
```

- `law` is a contextual keyword. It starts a declaration only as `law name(` or `law name<` (or `law proved name(` /
  `law proved name<`) with the name on the same line as `law`. Everywhere else it is an identifier.
- `proved` is the only modifier. `bounded` and `tested` are result statuses (`docs/laws.md`, "Statuses"), not syntax.
- A law is a function declaration flagged `Law`. The arrow form is a function whose body is `return expression;`.
- `assume`, `invariant`, `forall`, `exists` and `int` are ordinary exports of the `tslaws` package
  (`packages/tslaws/src/api.ts`). `tsserver` types them as it types any import, so no plugin work is needed for them.
- TS9101 to TS9106 come from `packages/tsc-ts/src/compiler/checker-laws.ts`.

## Option A: does the compiler have a language server?

No. Evidence:

- `packages/tsc-ts/src/main.ts` knows `--api`, `--laws-manifest`, `doctor` and the `tsc` arguments. Nothing else.
- `tsc.exe --lsp` (the built compiler, version `7.1.0-beta`) answers `error TS5023: Unknown compiler option '--lsp'`.
  `--help` mentions no `--stdio`, `--lsp` or server mode.
- `tsc --api` (`src/api/server.ts`, tested by the `windows-api` job in `.github/workflows/ci.yml`) is a binary
  programme-inspection protocol over stdio, a pipe or a socket, not LSP and not the `tsserver` protocol. Its methods
  (`src/api/session.ts`) are programs, symbols, types, signatures, diagnostics, `getCompletionsAtPosition`, references and
  JSDoc. There is no hover, definition, rename, signature help, formatting or code action request. `src/services/` has
  completion and find-references code, not a full language service.

So the fork can answer "what are the diagnostics of this program" but cannot drive an editor by itself.

## Option C: point `typescript.tsdk` or the native preview at the fork

Not possible today, and it would be worse than the plugin even if it were:

- `typescript.tsdk` must name a directory holding `typescript.js`, `tsserver.js` and the `lib*.d.ts` files. The compiler
  ships an executable (`dist/tsc`, `dist/tsc.exe`), the `bin/tsc-ts.js` launcher, and `lib.*.d.ts`. No `tsserver.js`.
- The TypeScript native preview extension talks to a `--lsp` executable. The fork has no `--lsp` (above).
- It would need a per-user setting (so it fails the "no setup" requirement), replace the TypeScript every other project in
  the window uses, and tie editing to a beta native build.

## Option D: a language client running the fork's server

Needs a server, and Option A shows there is none. Building one means writing an LSP server on top of `--api` (hover,
definition, rename, signature help and code actions do not exist there), and silencing the built-in diagnostics for the
same files, which VS Code lets an extension do only by disabling TypeScript for the file or by filtering. The user would
lose every `tsserver` feature in law files. Rejected.

## Option B: a `tsserver` plugin from the extension (chosen)

VS Code lets an extension contribute `typescriptServerPlugins`. `typescript-language-features` passes the extension's folder
to `tsserver` as a plugin probe location, and `tsserver` loads `<extension>/node_modules/<name>` (only a package name is
allowed as a plugin name). The plugin runs inside the `tsserver` that VS Code already starts, so there is no setting, no
second server and no change for files that are not laws.

The plugin source is `ts-plugin/`. `vsce package --no-dependencies` (what CI runs) never packs the extension's root
`node_modules` (checked with vsce 4.1.0), so the .vsix carries `ts-plugin/` and `src/plugin.js` copies it to
`node_modules/tslaws-ts-plugin` the first time the extension activates, then runs `typescript.restartTsServer` once. Later
activations find it current and do nothing.

How it works (`packages/vscode-tslaws/ts-plugin`):

1. **Transform.** For a file that contains `law name(` the plugin's `getScriptSnapshot` returns text in which each law
   declaration is rewritten to something `tsserver` parses:
   - block form: `law proved name(...) { }` becomes `function name(...) { }`. `law` becomes `function`, `proved ` is dropped.
   - arrow form: `law name(a: A): R => e;` becomes `const name = (a: A): R => e;`. `async law` moves `async` after `=`.
     Only the head of the declaration changes, so the end of the expression never has to be guessed.
2. **Position map.** The transform is a list of edits (`start`, `end`, `newText`). The map converts an offset in the original
   text to one in the transformed text and back. An offset inside an edited span goes to the edge of its replacement.
3. **Wrapped language service.** Requests carry original offsets. The plugin maps them in, calls the real service, and maps
   every returned span (diagnostics, hover, definitions, references, rename locations, completions, signature help,
   navigation tree, semantic classifications, code-fix edits) back, per file, because a result can sit in another file.
   Formatting edits that would cut into text the rewrite wrote (the `function` that stands for `law`) are dropped; the rest
   are mapped.
4. **Syntax errors.** Because `tsserver` sees valid text, the `law` syntax errors never exist. Real type errors in a law
   body arrive at their original positions. Errors whose range falls wholly in text the transform replaced are dropped.
5. **Ordinary identifiers.** The plugin only rewrites the exact `law [proved] identifier (` or `<` shape, found with a lexer
   that skips strings, comments, template literals and regular expressions, and never after a `.`. `const law = 1`,
   `obj.law`, `law(1)` and `law` followed by a newline are left alone. A file with no such shape is returned unchanged,
   as the very same snapshot object.
6. **The compiler's own diagnostics.** `tslaws check` already compiles the project with the fork. Its
   `compileDiagnostics` text carries `error TS9101` to `TS9106` lines with original positions. The extension parses those
   lines into a diagnostic collection on the same ranges. They arrive after a run (on save by default), not per keystroke.
7. **Highlighting.** The TextMate injection in `syntaxes/tslaws.injection.json` scopes `law`, `proved` and the name, after `export`
   and `async`, with generics, and not inside comments or strings. A `.laws.ts` file and its proposed, browser and e2e
   variants are TypeScript files to VS Code, so the injection into `source.ts` covers them (`test/grammar.test.mjs`).
   `bounded` and `tested` are statuses, not keywords, so they have no scope.

### Costs and limits of the plugin

- It re-reads each candidate file's text once per version (a substring check first), which is cheap.
- `const` for arrow laws means hover shows `const name: (...) => ...`, and a law used before its line gets
  "used before its declaration" from `tsserver`. Laws are not called from application code (TS9105), so this is rare.
- A `law name(` inside a class body would be rewritten as a function declaration there. It is invalid either way.
- `tsserver` features that do not go through the language service (for example some project-wide refactors that edit text
  directly) see the original text. Those are not mapped.
- JSX files (`.tsx`) are not transformed.
- Plugins load only for the TypeScript version VS Code starts. `enableForWorkspaceTypeScriptVersions` is set so a workspace
  `typescript.tsdk` still loads it.

## What only a real VS Code window can prove

The tests drive a real `tsserver` (the `typescript` package in `node_modules`) with the plugin and a fixture project, with
no GUI. They cannot prove that `typescript-language-features` finds the plugin in the installed `.vsix`, that it is enabled
for a workspace TypeScript version, how VS Code draws the results, or that the `.vsix` includes the staged plugin folder.
The remaining checks by hand: open a `.laws.ts` file in a window with the packaged extension; install the .vsix and confirm
the first activation restarts the TypeScript server and the squiggles go; select a workspace TypeScript version; look at the
colours and squiggles themselves.
