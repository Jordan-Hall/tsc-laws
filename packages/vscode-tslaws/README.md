# vscode-tslaws

tsc-laws in VS Code. When a law fails, the editor says so on the law and on the code it exercises, as you work.
The grammar is an injection (`source.tslaws`) added to `source.ts` and `source.tsx`. It adds no new language.

## What you see when a law fails

Take a checkout whose total can go below zero, with the law `totalNeverNegative` in `cart.laws.ts`:

- **On the law.** The name `totalNeverNegative` gets an error squiggle (not the whole line). The message holds the shrunk counterexample with the
  law's own parameter names (`price = 0, coupon = 1`), how the status was reached (`property, 12 runs, seed 99`) and the command that
  reproduces it. The line ends with the counterexample in the theme's error colour, and the gutter shows a mark.
- **On the code.** The function the law exercises (`total`, in `cart.ts`) gets its own squiggle on its name, with the same
  message. The call to it inside the law is underlined with a dashed line.
- **Each end links to the other.** Both diagnostics carry related information. In the Problems panel, expand the problem to
  see the link to the other end, and click it to jump there. Both have the stable code `tslaws/<law name>`, so
  typing `tslaws/totalNeverNegative` in the Problems filter shows one law's problems on both files.
- **Which function.** If the law threw, the function in the error's stack is the one marked. If the law returned `false` and
  calls one function, that one is marked. If it calls several, each is marked with a warning ("this may be where"), because
  the report cannot say which one is wrong. The ranges come from `tslaws check` and are checked against your text as it is now,
  so the marks follow your edits between runs.
- **It clears itself.** The next run of the law removes both marks when it passes.

Other results show too: `tampered`, `error` and `open` laws on the law, and `uncovered` exported functions on the function's name.

## Law syntax in the editor

VS Code's TypeScript server does not know `law`, so without help every `export law name(params) { ... }` shows red squiggles. The
extension fixes that with a TypeScript server plugin (`tslaws-ts-plugin`, contributed as `typescriptServerPlugins`). It needs no
setting and does not change how other files are edited.

- A file that declares a law is shown to the TypeScript server with each `law` declaration written as a function (`law proved` and
  `async law` too; the arrow form `law name(a: A) => e;` as a `const` arrow function). Every answer is mapped back to your text, so
  hover, go to definition, find references, rename, completions, signature help, the outline and semantic colours land on the
  right characters, and real type errors in a law body appear where you wrote them.
- `law` stays an ordinary identifier everywhere else (`const law = 1`, `obj.law`, `law(1)`). A file without a law declaration is not
  touched at all.
- `assume`, `invariant`, `forall`, `exists` and `int` are typed from the `tslaws` package you installed.
- The compiler's own rules (TS9101 to TS9106: boolean or void result, exported, typed parameters, plain parameters, not called by
  application code) come from `tslaws check` and appear in the Problems view after a run, on the law's name or parameter.
- Format Document leaves the `law` line itself alone; the rest of the file is formatted as usual.
- Limits: `.tsx` files are not rewritten; the first time the extension runs it copies the plugin into its own folder and restarts the
  TypeScript server once. See [docs/editor-law-syntax.md](../../docs/editor-law-syntax.md) for how it works and what it cannot do.

## Features

- **Runs as you work.** A debounced run of only the laws that cover the file you changed. See [Running](#running).
- **CodeLens.** Above each law: its state with counts and the time of the last run (`$(error) failed · property, 12 runs, seed 99 · 14:03:22`);
  click to run just that law. At the top of a laws file: the counts for the file, and a Run lens. Above a source function a
  law reaches: `covered by 2 laws, 1 failing`; click to choose a law to open.
- **Hover.** On a squiggle: the message, the shrunk input, the reproduce command, and links to re-run the law, copy the
  command and jump to the other end.
- **Quick fixes.** On a tslaws problem: `tslaws: Re-run this law`, `tslaws: Open the failing law` (from the code),
  `tslaws: Go to the code it exercises` (from the law) and `tslaws: Copy the reproduce command`.
- **Test Explorer.** Every law is a test in the Testing view, under its laws file. Profiles: `Run`, `Rerun failed` and
  `Run without the prover` (`--no-prove`, fast). A failure reports two messages, one at the law and one at the function.
  The same results feed the diagnostics. There is no debug profile: a law is not run under a debugger.
- **Status bar.** `laws: 3 proved, 1 failed`; while a run is going `laws: running 2/5 - 1 proved, 1 failed`. Click it to
  open the dashboard.
- **Commands.** `tslaws.check` (all laws), `tslaws.runFile` (this file), `tslaws.cancel`, `tslaws.openDashboard` (runs
  `tslaws ui --no-open --port 0` and opens the printed URL) and `tslaws.accept`. Accept never runs: it opens a terminal with
  `npx tslaws accept` typed and not executed, and a person presses Enter. The extension never accepts laws and never writes
  your files.

## Running

`tslaws.run` says when laws run:

| Value              | When                                                                       |
| ------------------ | -------------------------------------------------------------------------- |
| `onSave` (default) | `tslaws.debounceMs` (600 ms) after you save a TypeScript file.             |
| `onType`           | The same delay after you stop typing, on the text of the open buffers.     |
| `manual`           | Only when you ask: a command, a CodeLens, a quick fix or the Testing view. |

Each laws file shows a badge in the Explorer for its level: `N` Node, `B` browser, `E` end to end, `P` a proposal (hover for the words, and for a note when the file is not in `tsc-laws.lock` yet). The level comes from what the file imports, so the badge replaces the cue the `.browser.laws.ts` suffix gave.

Only the laws that cover the changed file run:

1. A laws file runs itself. Which files are laws files comes from `tslaws list --json` (any file name a project lists under `"laws"` in `tslaws.json` counts; its level comes from its imports). An older `tslaws`, or an untrusted workspace, falls back to `*.laws.ts`. Proposals in `.tslaws/proposals/` are never run as part of the check.
2. A source file runs the laws that reached it in the last report (each result lists the functions the law exercises).
3. Otherwise the laws file beside it (`cart.ts`, `cart.laws.ts`), or the laws files of the nearest folder that has any.
4. Otherwise every law.

A newer change stops a run that is going (the process is killed) and starts again after the delay. With a `tslaws` that
streams (`--reporter ndjson`), results appear law by law and the status bar counts them. An older `tslaws` is run with
`--json` and its report is shown at the end.

Why `onSave` is the default: a check compiles the project and starts the prover, which takes a few seconds even for the
two-law checkout example. That is too slow and too hot for every keystroke, so running on type is opt-in.

How `onType` works: `tslaws` reads files from disk, and unsaved text is not there. So when buffers are dirty the extension keeps a
copy of the project in `.tslaws/shadow` (ignored by git and by tslaws; `node_modules` is linked, not copied; only changed
files are copied again), puts the unsaved text in the copy and runs `tslaws` there. Your files are not written. Results use
the same project-relative paths. If the project is too big to copy (more than 6000 files), the run uses the saved files and says so
in the `tslaws` output. Runs started by a command, a CodeLens, a quick fix or the Testing view always use the saved files.

A subset run reads only part of the project, so its `uncovered` results and its "law was removed" tampering results are
dropped; the last full run's stay.

## Live results

With `tslaws.liveBackground` on, the laws that cover the code you are editing run in the background after you stop typing, on the
text of your open buffers (a copy under `.tslaws/shadow`; your files are not written). A run never blocks typing: it is debounced,
a newer edit stops the one that is going, only one check runs at a time, and results stream in as they arrive.

- **Status after each function.** A theme-coloured line after the signature, with a gutter icon: `proved`, `bounded`,
  `tested 24 runs`, `failing: counterexample (price=0, coupon=1)`, `running…`, or `stale · ran 3m ago` once you have edited since the
  last run. It shows without hovering; the hover links to the laws.
- **Uncovered functions.** An exported function no law reaches shows `uncovered` as a hint, not an error. The hover, the quick fix and
  the Problems entry offer _Write a law for this function_, which writes a first law into `<file>.proposed.laws.ts`. It never writes an
  accepted laws file or the lock; you check it with `tslaws check --proposed` and promote it yourself.
- **Laws view.** In the Explorer: every law and uncovered function grouped by status (failing first), with its file and the age of its
  last run. A click opens it. The status bar item shows the live counts and opens this view.
- **Guard.** Background runs wait while the machine is busy (`tslaws.liveCpuLimit`), stop by themselves when a run took longer than
  `tslaws.liveMaxSeconds`, and can be paused: _tslaws: pause/resume live results_.
- **Reload.** The last report is kept in `.tslaws/last-report.json` (git ignores `.tslaws/`), so results show at once when the folder
  opens; files edited since are marked stale.

## Navigation

- **Go to Laws** (`tslaws.goToLaws`, in the editor context menu and the CodeLens click) on a function: opens its law, or a Quick Pick
  with each law's status icon and counterexample when there are several. **Peek Laws** (`tslaws.peekLaws`) shows them in the peek
  widget without leaving the file. Suggested keys, which the extension does not bind for you:
  `{ "key": "alt+l", "command": "tslaws.goToLaws", "when": "editorTextFocus" }` and
  `{ "key": "alt+shift+l", "command": "tslaws.peekLaws", "when": "editorTextFocus" }`.
- **Go to Implementation** (Ctrl+F12) and **Find All References** on a function list the laws that exercise it. They come from the last
  report, and from the laws file's imports when no run has covered a law yet.
- **From a law**, F12 on its name, or _tslaws: Go to the function this law exercises_, goes to the function under test.
- **Outline and Ctrl+T.** Laws are document symbols (status in the detail) and workspace symbols named `law:<name>`, so `law:` lists every
  law and a fuzzy name finds one. _tslaws: Go to law..._ is the same list in a Quick Pick.
- All of it works in `.laws.ts` and its `.proposed`, `.browser` and `.e2e` variants, with the positions the law-syntax plugin maps.

## Settings

| Setting                       | Default  | Meaning                                                                                                                            |
| ----------------------------- | -------- | ---------------------------------------------------------------------------------------------------------------------------------- |
| `tslaws.run`                  | `onSave` | `onSave`, `onType` or `manual`.                                                                                                    |
| `tslaws.runOnSave`            | `true`   | Deprecated. `false` means `manual`. It counts only while `tslaws.run` is not set, so existing configuration keeps its meaning.     |
| `tslaws.debounceMs`           | `600`    | Wait after the last change before running (100 to 10000).                                                                          |
| `tslaws.runOnOpen`            | `false`  | Run every law once when the folder opens, so failures show before the first edit.                                                  |
| `tslaws.inlineCounterexample` | `true`   | Show the counterexample after the failing line. The Problems panel and the hover carry the same text.                              |
| `tslaws.executable`           | empty    | Path of `tslaws.js` or a native executable (`.cmd`/`.bat` shims are refused). Empty uses `node_modules/tslaws`. A machine setting. |
| `tslaws.liveBackground`       | `auto`   | `auto` (on for a project with a `tslaws.json`, unless you chose `tslaws.run`), `on` or `off`. See [Live results](#live-results).   |
| `tslaws.liveCpuLimit`         | `85`     | Live results wait while the machine is busier than this many percent.                                                              |
| `tslaws.liveMaxSeconds`       | `30`     | Live results stop by themselves when a run takes longer than this many seconds.                                                    |
| `tslaws.args`                 | `[]`     | Extra arguments for every `tslaws` call, such as `["--compiler", "path/to/tsc"]`. A machine setting.                               |

The extension runs the workspace's code, so it does not run in an untrusted workspace.

## Accessibility

The inline counterexample is decoration text, which screen readers do not read reliably. The same information is in the
diagnostic (Problems panel, `F8` to step through, the accessible diagnostics view), in the hover and in the CodeLens, all as plain
words (`failed: counterexample price = 0, coupon = 1`), never a symbol alone. The colours are theme tokens
(`editorError.foreground`, `editorWarning.foreground`), so they follow the theme and high-contrast themes. The gutter marks
are SVG files with a title and light and dark variants. Turn the inline text off with `tslaws.inlineCounterexample`.

## Structure

The tsserver plugin is in `ts-plugin/` (`transform.js` rewrites the laws and keeps the position map, `index.js` wraps the
language service); `src/plugin.js` puts it where tsserver looks. The logic is in plain modules that do not load `vscode`
(`parse-report`, `find-laws`, `model`, `ranges`, `diagnostics`, `compile-diagnostics`,
`format`, `plan`, `scheduler`, `runner`, `shadow`, `settings`, `summary`, `command`). `src/host.js`, `src/editor.js` and
`src/testing.js` take the `vscode` API as an argument; `src/extension.js` is the only file that requires it. There is no
bundler and there are no runtime dependencies.

`tslaws check --reporter ndjson --law NAME[,NAME]` and the `exercises` field of each result (the functions a law reaches, with the
declaration and the call as ranges, and `failing` when a stack names the function) are what this extension reads. They are in
`tslaws` releases after 0.5.1; an older `tslaws` works with `--json` and shows only the law end.

## Call-style laws

Laws are ordinary TypeScript calls in `*.laws.ts`: `law('add commutes', (a: int, b: int) => a + b === b + a)` and
`law.proved('name', (x: int) => ...)`. The name is a string or plain template literal and may contain spaces; the call may
span lines and take an async arrow. CodeLens, problems and the status bar treat these exactly like keyword laws. They need no
grammar, so highlighting comes from TypeScript itself.

## Dialect (old `law` keyword syntax, still supported)

`law` is a contextual keyword. It starts a declaration only when a name and a `(` or `<` follow on the same line:

```ts
law commutes(a: number, b: number) { return a + b === b + a; }
export law proved nonNeg(x: number) => x * x >= 0;
```

Elsewhere `law` is an ordinary identifier (`law(1)`, `obj.law x`, `const law = 1`).
`law` is scoped `storage.type.law.tslaws`, `proved` `storage.modifier.proved.tslaws`
(both also `keyword.declaration.law.tslaws`), and the name `entity.name.function.law.tslaws`.

## Install

Download `tslaws-vscode-<version>.vsix` from the [releases](https://github.com/Jordan-Hall/tsc-laws/releases) and run `code --install-extension tslaws-vscode-<version>.vsix`.
To build a package: `npx @vscode/vsce package --no-dependencies`.
Or run VS Code with `--extensionDevelopmentPath` pointing at this directory.

## Test

`npm test -w vscode-tslaws` (after `npm ci`). The tests run the whole extension under a small fake of the `vscode` API
(`test/fake-vscode.mjs`) with a scripted `tslaws`, and `test/real-cli.test.mjs` runs the real `tslaws` on a copy of
`examples/checkout` when `TSC_LAWS_BIN` names the compiler. `test/tsserver-plugin.test.mjs` starts a real `tsserver` with the plugin on a fixture project (no GUI). They prove the wiring and the data (what is published to the
Problems panel, the lenses, the hover, the quick fixes, the decoration options and the test results), not how VS Code draws them.
