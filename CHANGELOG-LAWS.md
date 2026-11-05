# tsc-laws changelog

The upstream tsc-ts changelog is CHANGELOG.md. Releases of tsc-laws are tagged `laws-v<version>` (see RELEASING-LAWS.md).

## Unreleased

- feat(vscode): a TypeScript server plugin so the editor understands `law` declarations: no red squiggles, with hover, definition, references, rename and completions mapped to the original text
- feat(vscode): the compiler's law rules (TS9101 to TS9106) are shown as diagnostics after a run
- feat(vscode): live results in the background with a status after each function, a Laws view, cached results, a CPU and run-time guard, and `tslaws.liveBackground`
- feat(vscode): an uncovered function is a hint with _Write a law for this function_ (a proposed laws file only)
- feat(vscode): Go to Laws, Peek Laws, Go to Implementation and Find All References from a function to its laws, laws as document and workspace symbols, _Go to law..._
- docs: how the editor and the `law` keyword fit together (docs/editor-law-syntax.md)
- **A laws file's level comes from what it imports.** A file that reaches `tslaws/browser` (or an adapter) through its own import graph is a browser law, one that reaches `tslaws/e2e` is an end-to-end law, both is an error that names the chains, neither is a Node law. Type-only imports and `node_modules` do not count. The `.browser.laws.ts` and `.e2e.laws.ts` names are hints; one the imports do not back is reported as a notice (`report.notices`), and `.e2e.laws.ts` that reaches only the browser API is an error.
- **`"laws"` in `tslaws.json`:** globs for laws files with other names (a file counts when it declares a top-level `export law`). Default unchanged; every laws file of the tree stays locked.
- **Proposals live in `.tslaws/proposals/`**, outside the tree and git-ignored (`tslaws init` adds it). New: `tslaws propose <file.ts> [--from PATH]` (stdin or a file; writes only that directory and refuses links that leave the project). `check --proposed` runs every proposal at the level its imports give, with no lock and no coverage gate. `tslaws promote <proposal> [--to PATH]` (people only, as before; a delegation does not cover it) moves one into the tree at a confirmed path, rewrites its imports and never writes the lock. Imports written `./` in a proposal are relative to the project root. The MCP `tslaws_propose` writes there too.
- **Deprecated:** in-tree `*.proposed.laws.ts`, `*.browser.proposed.laws.ts` and `*.e2e.proposed.laws.ts` keep working through `check --proposed` and `promote` and print a notice recommending `.tslaws/proposals/`.
- **`tslaws list [--json]`** and the MCP tool `tslaws_list`: every laws file and proposal with its level and whether it is accepted, unaccepted or proposed.
- **VS Code:** laws files are found by asking `tslaws list` (falling back to names for an older tslaws), and each shows an Explorer badge for its level (N, B, E, or P for a proposal).
- **Fix:** the property worker reused its TypeScript program across checks in one process, so a file added between two checks (a new proposal) failed with "no declaration output".

## 0.6.4

- Merge pull request #13 from Jordan-Hall/chore/vscode-listing-metadata
- chore(vscode): listing metadata for the Marketplace: keywords, GitHub-flavoured readme, Q&A and pricing

## 0.6.3

- Merge pull request #10 from Jordan-Hall/ci/extension-publish
- fix(vscode): the publisher is TS-Laws, as created on the Marketplace
- ci: publish to the Marketplace with trusted publishing, keeping a PAT as fallback
- ci: publish the extension to each store only when its token exists, and a guide to switching it on

## 0.6.2

- Merge pull request #9 from Jordan-Hall/feat/brand-icons
- Merge pull request #11 from Jordan-Hall/fix/stateful-shrink
- Merge fix/stateful-shrink
- fix(tslaws): shrinking removes any set of elements, not only one run
- Merge fix/stateful-shrink so CI is green
- Merge origin/main
- fix(tslaws): stateful shrinking always reaches the shortest failing sequence
- docs: use the law-with-a-tick mark, and show it in the README
- docs: a proper mark for tsc-laws, and every icon size the stores and the repository need

## 0.6.1

- Merge pull request #8 from Jordan-Hall/docs/delegation-explainer
- docs: show both explainer videos in the README
- docs: an explainer video on laws, migration and delegated accept

## 0.6.0

- Merge pull request #7 from Jordan-Hall/feat/vscode-live-laws
- fix(vscode): default-export and excluded-law handling
- feat(vscode): law failures show live on the law and on the source it exercises

## 0.5.2

- Merge pull request #6 from Jordan-Hall/chore/sync-upstream
- fix(ci): a sync branch without an open PR no longer blocks the weekly sync
- Merge origin/main into chore/sync-upstream
- ci: sync with the upstream tsc-ts every week
- Merge remote-tracking branch 'upstream/main' into chore/sync-upstream
- Merge pull request #411 from vercel-labs/ctate/prepare-v0-1-ccd382
- Remove a blank line from the changelog
- Prepare v0.1.2 release
- Make @scriptc/threads an optional peer dependency (#410)
- Order package.json fields as the formatter does
- Make @scriptc/threads an optional peer dependency
- Optimize macOS builds with the two-phase profile (#407)
- Create three checker collections only when they get an entry (#409)
- Find an intersection's duplicate types by scanning its list (#408)
- Check out the profile block counts byte for byte
- Create three checker collections only when they get an entry
- Find an intersection's duplicate types by scanning its list
- Optimize macOS builds with the two-phase profile
- Count every checker in --extendedDiagnostics (#406)
- Keep the Memory allocs row
- Count every checker in --extendedDiagnostics
- Store kind, flags and pos as node fields (#405)
- Format check-int32-fields.mjs
- Store kind, flags and pos as fields of a node
- Pack kind, flags and pos of a node into two words (#404)
- Pack kind, flags and pos of a node into two words
- Run a file's grammar checks in its parse thread (#400)
- Merge main
- Merge pull request #403 from vercel-labs/ctate/prepare-v0-1-d9c6e5
- Fix the security finding and CI, and merge main
- Prepare v0.1.1 release
- Build with scriptc 0.4.8 and a profile collected with it (#402)
- Build with scriptc 0.4.8 and a profile collected with it
- Collect the two-phase profile with the scriptc the build uses (#401)
- Collect the two-phase profile with the scriptc the build uses
- Run a file's grammar checks in its parse thread
- Build the native tsc-ts to unwind exceptions on Linux (#399)
- Build the native tsc-ts to unwind exceptions on Linux
- Pick the shared queue's files by their share of the program (#398)
- Pick the shared queue's files by their share of the program
- Reuse the type of a completed check for context-free expressions (#397)
- Mark the finally case as differing from the 7.0.2 oracle
- Keep the completed-check record out of reduced flow
- Remove the completed-check record environment switch
- Reuse the type of a completed check for context-free expressions
- Reuse the union a list of types was created from (#396)
- Report a union that is too complex to represent at each expression
- Reuse the union a list of types was created from
- Read shared checker results where they wrote them (#395)
- Name a union origin's field and a property's alias arguments as they are
- Compute a wildcard module pattern's prefix and suffix once (#394)
- Read a shared result where the checker that exported it wrote it
- Format the pattern match the way oxfmt does
- Compute a wildcard module pattern's parts once
- Choose the run configuration from paired runs, and date the adoption from any sample (#393)
- Read three pairs from three runs of each arm, and keep the paired verdict
- Choose the run configuration from paired runs, and date the adoption from any sample
- Add `TSC_TS_SHARE_PRICE`, a per-checker log of what result sharing costs, built only on request (#392)
- Pair each translation with the computation its producer made
- Price the replay's posts, takes and wall time from what the run measured
- Build the result-sharing price log only on request
- Read the CPUs an automatic configuration may use from the cgroup CPU quota (#391)
- Read the cgroup v1 quota of a parent cgroup too
- Lower the CPU count to the cgroup quota
- Choose a run's configuration from what earlier runs of the project measured (#390)
- Keep a rejected configuration rejected, and read the sharing fit wherever a count is learned
- Correct the comment on what the memory estimate costs
- Adopt a reverted or pinned configuration only from a comparison
- Decide a project's next configuration from what its earlier runs measured
- Measure a project's run configuration with `tsc-ts doctor (#388)
- Report sharing's gain at the count doctor recommends, not the count's
- Merge main
- Merge main
- Turn result sharing on where it pays, and stop it where it stops paying (#389)
- Print the sharing-signals test as the formatter does
- Keep the signals the library-bound cut reads, and compare sharing with runs that pin it off
- Turn result sharing on where it pays, and stop it where it stops paying
- Mark `tsc-ts doctor` experimental in its usage and the README
- Measure a project's run configuration with `tsc-ts doctor`
- Write a record of each eligible run, and name it in the section (#387)
- Write a build project's record, and only for a full check
- Write a run record after each eligible run, and name it in the section
- Give each run a configuration, and print it under `--extendedDiagnostics (#386)
- Give each run a configuration, and print it under --extendedDiagnostics
- Check that every run configuration prints what one checker prints (#385)
- Write an emit run's declarations where its tree is compared
- Check that every run configuration prints what one checker prints
- Hold an identifier's text in a shared name (#384)
- Generate an identifier that stores its name
- Hold an identifier's text in a shared name
- Prepare v0.1.0 release (#383)
- Prepare v0.1.0 release
- Create a shared instantiation's resolved return types right after it (#382)
- Keep an instantiation's failed export failed when its return types are exported
- Create a shared instantiation's resolved return types right after it
- Share results between checker threads behind TSC_TS_SHARE (#381)
- Name a posted result's checker by the checker count, and give each checker its own forbidden bit
- Refresh the two-phase profile
- Write the installed executable once with one write on Linux (#380)
- Create the launcher's copy exclusively, with mode 0600
- Keep the executable's mode when the launcher writes it again
- Write the installed executable once with one write on Linux
- Target TypeScript 7.1.0-beta: upstream layout, oracles and generated files (#325)
- Print a mapped type written without a type as tsgo 7.1 does (#379)
- Print a mapped type written without a type as tsgo 7.1 does
- Import no export whose name is not an identifier
- Insert no declaration text as code in completions
- Keep the recursion identities of invokeOnce's stack entries (#376)
- Offer only tag names in opening-tag completions
- Merge main
- Build with scriptc 0.4.6 and a two-phase profile collected with it (#378)
- Build with scriptc 0.4.6 and a two-phase profile collected with it
- Resolve type reference directives against their type root as tsgo does (#377)
- Resolve type reference directives against their type root as tsgo does
- Keep the recursion identities of invokeOnce's stack entries
- Keep CompactLinkTable values only for the pages stored
- Adapt the contextual return-type inference memo to the TypeScript 7.1 checker
- Merge main
- Memoize contextual return type inference walks (#375)
- Memoize contextual return type inference walks
- Merge main
- Restore the one-phase profile collected with scriptc 0.4.5 (#374)
- Restore the one-phase profile collected with scriptc 0.4.5
- Keep the one-phase profile's record with the branch's profile
- Merge main
- Relate without reporting before relating with an error node (#373)
- Refresh the profiles with scriptc main e2b95cdee (#372)
- Relate without reporting before relating with an error node
- Refresh the profiles with scriptc main e2b95cdee
- Resolve deferred type arguments before measuring variances for inference
- Merge main
- Record block counts beside the two-phase profile (#371)
- Record block counts beside the two-phase profile
- Run the object references test on the TypeScript 7.1 API
- Merge main
- Name objects the client already holds by their ids in API replies (#370)
- Format the initialize case of the session's dispatch
- Name objects the client already holds by their ids in API replies
- Merge main
- Keep the one-phase profile for scriptc without a second profile phase (#369)
- Keep the one-phase profile for scriptc without a second profile phase (#368)
- Keep the one-phase profile for scriptc without a second profile phase
- Keep the one-phase profile for scriptc without a second profile phase
- Merge main
- Collect the profile in two phases (#367)
- Collect the profile in two phases (#366)
- Refresh the profile with both phases
- Refresh the profile with both phases
- Keep sparse symbol link columns in pages of present ids (#365)
- Keep sparse symbol link columns in pages of present ids
- Collect the tsc-ts profile again after the compact link table change (#363)
- Test that escaping wildcard exports targets are not searched outside their package (#364)
- Test that escaping wildcard exports targets are not searched outside their package
- Collect the tsc-ts profile again after the compact link table change
- Keep compact link pages' presence bits in 32-bit fields and update their counts at once (#362)
- Keep compact link pages' presence bits in 32-bit fields and update their counts at once
- Merge main
- Choose the cannot-find-name message on failure and walk ahead past dropped JavaScript files (#361)
- Walk ahead past JavaScript files the loader drops
- Look up an inference pair's visited status once per invokeOnce (#359)
- Keep resolved types and signatures in pages of present ids and their values (#360)
- Narrow uniform primitive unions by === and case without comparing every constituent (#358)
- Keep resolved types and signatures in pages of present ids and their values
- Look up an inference pair's visited status once per invokeOnce
- Merge main
- Narrow uniform primitive unions by === and case without comparing every constituent
- Restart a file's references at a lower depth only within maxNodeModuleJsDepth (#357)
- Restart a file's references at a lower depth only when it is within maxNodeModuleJsDepth
- Key the program's maps of a loaded file by its own path (#356)
- Merge main
- Key the program's maps of a loaded file by its own path
- Stop the native API test from hanging on a cold build cache (#355)
- Stop the native API test from hanging on a cold build cache
- Load the first --watch build on parse threads (#354)
- Merge main into the TypeScript 7.1.0-beta branch
- Load the first --watch build on parse threads
- Reuse printed type and symbol strings within a checker (#352)
- Check the profile match in build:native and refresh the profile with one command (#350)
- Share a rebuilt watch program with checker threads again (#349)
- Build instantiated member lists from the source's cached order (#353)
- Key kept type prints by the variance check in progress
- Build instantiated member lists from the source's cached order
- Reuse printed type and symbol strings within a checker
- Search the active mappers by id (#351)
- Search the active mappers by id
- Check the profile match in build:native and refresh the profile with one command
- Share a rebuilt watch program with checker threads again
- Keep Node, Type and Symbol number fields as 32-bit integers (#348)
- Keep Node, Type and Symbol number fields as 32-bit integers
- Infer alias and reference type arguments once, as tsgo 7.1 does (#347)
- Infer alias and reference type arguments once, as tsgo 7.1 does
- Match tsgo 7.1 on the last node builder and emit rows (#346)
- Replay a file's JavaScript transforms before its declarations on threads
- Match tsgo 7.1 on the last node builder and emit rows
- Fail CI test runs that lack the reference compilers
- Add getImportAdderEdits to tsc-ts --api (#345)
- Write a trailing comment after an added list separator as tsc --api does
- Add getImportAdderEdits to tsc-ts --api
- Report unused locals after a top-level return
- Fix source phase import emit and the union order test for TypeScript 7.1 (#344)
- Fix source phase import emit and the union order test for TypeScript 7.1
- Keep wildcard export targets inside their package
- Complete exhaustive switch cases over enums in tsc-ts --api (#342)
- Complete exhaustive switch cases over enums in tsc-ts --api
- Offer auto-imports from packages in node_modules in tsc-ts --api completions (#341)
- Stop the native API test from hanging on a cold build cache
- Refresh the tsc-ts profile for the TypeScript 7.1 parts E and B
- Port TypeScript 7.1's checker changes for statements, grammar, JSDoc and JavaScript (#340)
- Offer auto-imports from packages in node_modules in tsc-ts --api completions
- Offer auto-imports from the project's files in tsc-ts --api completions (#339)
- Address review feedback
- Fix the completions fixture failure and review feedback
- Port TypeScript 7.1's checker changes for statements, grammar, JSDoc and JavaScript
- Offer auto-imports from the project's files in tsc-ts --api completions
- Serve TypeScript 7.1's API protocol from tsc-ts --api (#338)
- Look up a descriptor in the newest snapshot that retains it
- Keep older snapshots' symbol references resolvable and hash each file once
- Serve TypeScript 7.1's API protocol from tsc-ts --api
- Port TypeScript 7.1's command line, tsconfig, path and incremental build changes (#337)
- Report a root file matched by both files and include once
- Count declaration emit for signatures as emit time
- Port TypeScript 7.1's command line, tsconfig, path and incremental build changes
- Port TypeScript 7.1's parser, scanner, binder and program loading changes (#336)
- Merge the TypeScript 7.1.0-beta branch and refresh the tsc-ts profile
- Encode source files in TypeScript 7.1's binary AST format (#335)
- Format the protocol 9 encoder test
- Refresh the tsc-ts profile for the TypeScript 7.1 checker changes
- Merge main into the TypeScript 7.1.0-beta branch, and cache the reference tsc with the oracle builds
- Compare check-corpus diagnostics after deduplicating them, as tsgo does (#332)
- Decode a private name on the right of a qualified name
- Port TypeScript 7.1.0-beta checker relations, inference and types (#334)
- Port TypeScript 7.1's parser, scanner, binder and program loading changes
- Test constructing a protected base from a class expression subclass
- Encode source files in TypeScript 7.1's binary AST format
- Port TypeScript 7.1.0-beta checker relations, inference and types
- Refresh the tsc-ts profile for TypeScript 7.1
- Report tsgo's arity errors for calling a new Promise's resolve without an argument (#333)
- Fetch upstream TypeScript before packaging in CI
- Merge main
- Report tsgo's arity errors for calling a new Promise's resolve without an argument
- Compare check-corpus diagnostics after deduplicating them, as tsgo does
- Report cycles and truncation in the node builder as TypeScript 7.1 does (#328)
- Port TypeScript 7.1's declaration emit fixes (#329)
- Port TypeScript 7.1's JavaScript emit fixes (#330)
- Instantiate generic value import type queries with their type arguments (#331)
- Instantiate generic value import type queries with their type arguments
- Bound deferred array and tuple references by their node
- Port TypeScript 7.1's JavaScript emit fixes
- Port TypeScript 7.1's declaration emit fixes
- Report cycles and truncation in the node builder as TypeScript 7.1 does
- Look up each path once in the loader's walk and collect (#326)
- Look up each path once in the loader's walk and collect
- Target TypeScript 7.1.0-beta: upstream layout, oracles and generated files
- Prepare v0.0.10 release (#324)
- Prepare v0.0.10 release
- Build with scriptc 0.4.5 and a refreshed profile (#323)
- Take the printer and output writes off slow paths (#322)
- Build with scriptc 0.4.5 and a refreshed profile
- Write output files before creating their directories
- Skip comment lookups in source ranges without comments (#321)
- Skip comment lookups in source ranges without comments
- Bound each chunk of files for parse threads by its text (#320)
- Bound each chunk of files for parse threads by its text
- Read the default library files from disk on request in `--api (#319)
- Resolve the library directory as the file loader does
- Read the default library files from disk on request in --api
- Emit on emit threads in incremental and -b builds (#317)
- Emit a -b project once when its pending emit is too little for emit threads
- Keep each source file's encoding in a --listen server (#318)
- Keep each source file's encoding in a --listen server
- Skip work in hot checker paths whose result is already known (#316)
- Emit on emit threads in incremental and -b builds that emit every file
- Publish each file on its parse thread right after binding it
- Find declaration errors on the declaration thread under noEmit at --checkers 1 (#315)
- Find declaration errors on the declaration thread under noEmit at --checkers 1
- Shorten the main thread's work around checking on threads (#314)
- Shorten the main thread's work around checking on threads
- Emit declarations on a declaration thread at up to 8 checkers (#313)
- Expect a declaration thread with 2 checkers only on more than 2 CPUs
- Serve the API to one client at a time on a Unix socket (#312)
- Emit declarations on a declaration thread while the program is checked
- Probe an existing socket without waiting before replacing it
- Serve the clients that connected before a --listen server stops
- Serve the API to one client at a time on a Unix socket
- Emit decorated files on the emit threads with metadata answers from the checker (#311)
- Emit decorated files on the emit threads with metadata answers from the checker
- Emit JavaScript on threads while the main thread checks at --checkers 1 (#310)
- Emit JavaScript on threads while the main thread checks at --checkers 1

## Unreleased: law failures show live in VS Code

- VS Code: a failed law is marked on the law's name and on the name of the function it exercises, as you edit. Each is a
  diagnostic with the shrunk counterexample and the reproduce command, each is related information of the other, and both have the
  code `tslaws/<law name>`. They clear when the law passes.
- VS Code: only the laws that cover the changed file run (the laws that reached it, else the laws file beside it, else all), debounced,
  and a newer change stops a run that is going. The status bar counts results as they stream.
- VS Code: CodeLens above each law (state, counts, last run time; click to rerun) and above each function a law reaches
  (`covered by N laws, M failing`), hover with the shrunk input, quick fixes (re-run, open the failing law, copy the reproduce
  command), the counterexample after the failing line, and the laws as tests in the Testing view.
- VS Code settings: new `tslaws.run` (`onSave` default, `onType`, `manual`), `tslaws.debounceMs`, `tslaws.runOnOpen`,
  `tslaws.inlineCounterexample`. `tslaws.runOnSave` is deprecated and still read while `tslaws.run` is not set (`false` is `manual`).
  `onType` runs on a copy of the project in `.tslaws/shadow` that holds the unsaved text; your files are not written.
- tslaws: `check --reporter ndjson` streams `plan`, `start`, `result` and `report` events; `check --law NAME[,NAME]` runs named laws.
- tslaws: each result carries `exercises`, the functions the law reaches with their declaration and call ranges, and `failing`
  on the one a thrown error's stack names. An `uncovered` result's `line` is the function's declaration line.
- tslaws: a law that imports a helper as a default export now resolves for every form: `export default helper;`, `export default function`/`class`,
  `export { x as default }`, `export default () => ...` and a default re-exported from an imported function. Before, `export default helper` never resolved, so a
  failing law got no mark on the function.
- VS Code Test Explorer: running a laws file with some of its laws excluded now runs only the others (`--law`), not every law in the file.
- The extension still never accepts laws: `tslaws.accept` only types the command into a terminal.

## 0.5.1

- Merge pull request #5 from Jordan-Hall/feat/auto-release
- ci: the release fails when tslaws' version differs from the tag
- ci: write the GitHub release notes from the changelog section

## 0.5.0

- Merge pull request #4 from Jordan-Hall/feat/delegated-accept
- fix(tslaws): delegation reads the home directory from the user database
- fix(tslaws): delegation always reads the real home directory
- feat(tslaws): a person can lend accept to an agent for a limited time

## 0.4.0

- Merge pull request #3 from Jordan-Hall/feat/auto-release
- fix(ci): honour the triggering commit's skip marker, and harden the release push
- Merge pull request #2 from Jordan-Hall/feat/bundler-plugins
- test(tslaws): use the public TSRX compiler for the bundler fixtures
- docs(tslaws): finish the bundler plugins sentence about files the compiler does not emit
- fix(tslaws): load the CSS and assets a bundle emits
- ci: release tslaws automatically when a merge to main changes code
- Merge pull request #1 from Jordan-Hall/fix/format-demo-scripts
- style(demo): format the demo scripts with oxfmt
- feat(tslaws): bundlerPlugins setting teaches the browser bundler new source formats
- Merge branch 'laws': playable audio
- fix(demo): mix the soundtrack as 44.1 kHz stereo so every player plays it
- Merge branch 'laws': illustrated explainer, checkout example
- docs: the illustrated explainer, and the intro video in a British voice
- feat(demo): an illustrated explainer of what tslaws is, with the checkout example's real output
- feat(examples): a checkout example held to a law, a total is never below zero
- Merge branch 'laws': new intro video
- docs: a 79-second intro video with a natural Kokoro voice, a live law, and real tslaws check and tamper output

## 0.3.2

- **Speed laws in the browser:** `measure`, `fast` and `blocking` in `tslaws/browser` (timings and main-thread blocking of component work); `vitals`, `speed` and `fast` in `tslaws/e2e` (FCP, LCP, CLS, blocking time, load, DOM size and bytes against a budget).
- **Compiler lookup:** in a checkout of the repository `tslaws` finds `packages/tsc-ts/dist` itself, and a missing compiler now says how to fix it instead of `spawnSync tsc-laws ENOENT`.
- **Desktop window:** `tslaws ui` opens in its own app window (Chrome, Edge or Chromium); `--tab` opens a browser tab instead.

## 0.3.1

- **Release:** the npm publish step passed compiler tarballs without `./`, which npm reads as a GitHub repository; fixed. Nothing else changed from 0.3.0.

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
