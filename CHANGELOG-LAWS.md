# tsc-laws changelog

The upstream tsc-ts changelog is CHANGELOG.md. Releases of tsc-laws are tagged `laws-v<version>` (see RELEASING-LAWS.md).

## 0.3.0

- **Prover:** exact integer division (`Math.floor/ceil/trunc/round(a / b)`, `(a / b) | 0`, `a % b` over `int`, with a provably non-zero divisor), module-level constants (`const NAME`, `exports.NAME`, `module_1.NAME`), `Number.isFinite/isInteger/isNaN`, `Math.sign` and `Math.min/max` with any number of arguments now lower, so laws over pricing-style code are `proved` instead of `tested`.
- **Run settings and mutate fixes:** `tslaws.json` accepts `runs`, `bound`, `proofTimeoutMs` and `propertyTimeoutMs` (integers >= 1; unknown top-level keys are an error); precedence is flag, then `tslaws.json`, then default, for `check`, `ui`, `mutate` and `mcp`. `tslaws mutate` takes `--runs`, `--bound`, `--proof-timeout`, `--property-timeout` and `--browser`, defaults to 30 runs and the `check` timeouts (was 50 runs, 1500 ms, 5000 ms), names the failing law when the baseline fails, mutates and copies `.tsx`/`.jsx`, copies `tsc-laws.lock`, and with named laws files mutates only the sources they reach.
- **End-to-end laws:** a `*.browser.laws.ts` file that imports `tslaws/e2e` (alias: `*.e2e.laws.ts`) runs in Node and drives a whole running app through a real browser with a Playwright `Page` (`page`, `open`, `newPage`, `context`, `route`, `settle`, `accessible`, `baseURL`); a file importing both `tslaws/browser` and `tslaws/e2e` is an error. `tslaws.json` `e2e` (`baseURL`, `server` with `command`, `url`, `timeoutMs`, `reuseExisting`, `cwd`, `runs`, `timeoutMs`) starts and stops the dev server (process tree killed, also on errors and Ctrl+C). Fresh context per input, shrunk counterexample, screenshot, live frames, regression corpus; status `tested`, method `e2e`, default 10 runs and a 120 s limit.

- **Component testing:** `mountComponent` (from `tslaws/browser`) renders one component in isolation with props generated from its props type, through dependency-injected adapters for React, Angular, DOM functions and custom elements (also `tslaws/adapters/*`); `spy`, `rendersSame` and Testing Library style queries (`byRole`, `byText`, `byLabel`, `byTestId`, `within`). Parameters and properties of function type now generate (a function returning values of the return type), in browser laws too.
- **Plain JavaScript:** `tslaws.json` `compilerOptions` accepts `allowJs` and `checkJs`; with `allowJs`, `cover` globs include `.js` sources, laws import `.js` modules with generators typed from the emitted declarations, and an exported JS function no law reaches is `uncovered`. Examples: `examples/vanilla-ts` and `examples/vanilla-js`.
- **Frameworks:** `tslaws.json` `compilerOptions` (jsx, jsxFactory, jsxFragmentFactory, jsxImportSource, experimentalDecorators, emitDecoratorMetadata, useDefineForClassFields, lib, types, strict, noUncheckedIndexedAccess, exactOptionalPropertyTypes; unknown keys are an error), `.tsx` covered sources, and browser bundles that resolve bare imports from the project's `node_modules` (with `global` defined as `globalThis`).
- **`tslaws ui`:** per-law durations and a list of the slowest laws, a history of the last 20 runs, `flaky` detection with a Flaky filter, and a rerun button for a single law (`only` in `CheckOptions`; `POST /api/run?file=&law=`).
- **`law` declarations:** a contextual statement, `law [proved] name(params) { … }` or `=> expr;`, parsed as a flagged function
  declaration; `tsc-ts --laws-manifest` lists them.
- **`tslaws`:** property tests with generators derived from declared types, a Z3 prover (IEEE doubles, exact `int` and
  `bigint`, bounded arrays, loops and recursion, strings, records), loop `invariant`s for proofs over every iteration count,
  a tamper lock, a coverage gate with lock-recorded exemptions, `init`, `--watch`, `--summary`, `--json` hints, and a Claude
  Code hook.
- **Checker rules for `law`:** TS9101 to TS9106 (return type, exported, typed plain parameters, not a generator or default
  export, only laws call laws). Laws may be `async`.
- **Browser laws:** `*.browser.laws.ts` runs in a real Chromium-family browser with inputs generated in Node; `tslaws/browser`
  helpers (`mount`, `settle`, `click`, `type`, `fire`) are framework-agnostic.
- **Accessibility and engines for browser laws:** `a11y` and `accessible` audit a mounted component with axe-core (optional peer
  dependency), and `--browser chromium|firefox|webkit` (or `TSLAWS_BROWSER_ENGINE`) picks the engine.
- **`forall` and `exists`:** quantifier helpers over arrays for `assume`, law results and `invariant`s; the prover lowers them over the
  array slots, so claims that use them are `bounded`.
- **Stateful laws:** `runModel` and `runModelAsync` (from `tslaws`) drive a real object and a simple model through a generated
  operation list and compare them after every step; a failing sequence shrinks to the shortest one, and `modelFailure()` names
  the step that diverged.
- **Invariant loops** may `return`, `break` and `continue`, and may change arrays and records. Property tests run in a
  killable worker (`--property-timeout`). A `laws.yml` workflow tests on Linux and Windows and publishes builds on `laws-v*` tags.
- **npm:** `npm i tslaws` brings the compiler for the machine (`tslaws-compiler-<platform>` optional dependencies); the release workflow publishes them with provenance when `NPM_PUBLISH` is set. See RELEASING-LAWS.md.
- **CI reporters:** `tslaws check --reporter text|json|junit|github`. `junit` writes JUnit XML (a suite per law file); `github` writes workflow
  annotations and, when `GITHUB_STEP_SUMMARY` is set, a results table for the job summary. Exit status is unchanged.
- **`tslaws ui`:** a local, loopback-only dashboard, with live progress (waiting, running, result), a live view of the browser page while a browser law runs, a per-file rerun, and a screenshot of the page at a failing browser law's counterexample.
- **`tslaws mutate`:** mutation testing. Mutates the covered code, re-runs the laws on each mutant in a scratch copy, and reports survivors (laws too weak) with a mutation score; exit 0 only when every tried mutant is killed.
- **`vscode-tslaws`:** a TextMate injection grammar for `law`, and an extension: CodeLens status and a counterexample lens above each law in `*.laws.ts`, problems for failed, open, tampered and error laws, a status-bar total that opens the dashboard, the commands `tslaws.check`, `tslaws.runFile`, `tslaws.openDashboard` and `tslaws.accept` (types the command in a terminal and never runs it), and a debounced re-run on save.
- **Regression corpus:** every counterexample a property test finds is saved to `.tslaws/regressions/` (lossless tagged JSON, 20 per law) and replayed before the random search; a stored example that still fails fails the law as a regression. `tslaws check --no-regressions` skips it, `tslaws regressions [list|clear]` manages it, and `tslaws init` no longer ignores the directory.
- **`tslaws mcp`:** a Model Context Protocol server over stdio with the tools `tslaws_check`, `tslaws_check_proposed`, `tslaws_explain` and `tslaws_propose`. It can write only `*.proposed.laws.ts` files; no tool accepts laws or edits the lock.
- **`tslaws promote [file] [--all]`:** people-only (terminal required, like `accept`): shows each proposed law with its check result, asks per law, moves the approved ones into the accepted `*.laws.ts`, and leaves the lock for `tslaws accept`.
- **Tests:** Windows fixes in the upstream test harness (extensionless oracles, slashed paths, fixture directories).

## 0.0.9

### Highlights

- **Faster small checks with library checking:** a declaration file that costs more than a checker's share, such as `lib.dom.d.ts` in a small program, is checked in statement ranges by all checkers. Checking one file with library checking goes from 182 to 112 ms, and peak RSS from 80 to 116 MB. Diagnostics are the same, and projects that plan no ranges are unchanged.
- **Less memory:** speculative parses check tokens instead of building nodes they discard, and parse and loader tasks create their lists on first use. Peak RSS on VS Code is about 120 MB lower with `--checkers 1`, with wall time unchanged.
- **Faster symbol lookups:** the checker probes its merged-symbol map only for symbols that were merged, about 1% faster on VS Code with `--checkers 1`.
- **API:** nine methods answer a batch of locations, signatures, types or symbols in one request, and `getDiagnosticsOfCheckedFiles` checks only the listed files and answers their diagnostics and the global ones.
