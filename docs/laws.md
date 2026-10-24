# Laws for TypeScript

`tsc-laws` is a fork of [tsc-ts](https://github.com/vercel-labs/tsc-ts) that adds one statement to TypeScript, `law`, and
`tslaws`, a checker that holds your code to those laws. It exists so that people can say what code must do, let coding
agents write the code, and get a machine verdict instead of a code review. The idea is Bend 2's: the person writes the
laws, the agent writes the program and its proofs, and a checker the agent cannot talk round gates every change. The
difference is that it stays TypeScript, so any human can read, run and fix everything.

## What it offers

| Offer                            | What you get                                                                                                                                                                           |
| -------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **`law` declarations**           | A statement of the language, type-checked like a function, that says what must hold for all inputs.                                                                                    |
| **Verdicts, not opinions**       | Each law ends `proved`, `bounded`, `tested`, `failed`, `open`, `uncovered`, `tampered` or `error`. One exit status.                                                                    |
| **Real proofs**                  | Z3 proves laws over exact integers, bigints, booleans, strings and records, and over IEEE doubles where it can decide. Loop invariants extend this to loops for every iteration count. |
| **Bounded proofs**               | Arrays, plain loops and recursion are checked exhaustively up to a stated bound.                                                                                                       |
| **Property tests as the floor**  | Anything the prover cannot lower is tested with `fast-check`; inputs are generated from your declared types, and failures shrink to a minimal counterexample with a seed.              |
| **Laws the agent cannot weaken** | `tsc-laws.lock` hashes every law. Changing, adding or removing one, or exempting code, fails the check until a person runs `tslaws accept`, which refuses to run without a terminal.   |
| **Coverage**                     | Every exported function and class must be reached by a law, so new code cannot slip through unchecked.                                                                                 |
| **Agent ergonomics**             | `tslaws init` scaffolds the rules and a Claude Code hook; `--json` and `--summary` give structured, compact output with a next-action `hint` per result; `--watch` re-checks on save.  |
| **Human ergonomics**             | A VS Code grammar for `law`, plain TypeScript output, and counterexamples you can paste into a test.                                                                                   |

## How it compares with Bend 2

|                             | Bend 2                                             | tsc-laws                                                                                                                         |
| --------------------------- | -------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------- |
| Language                    | A new language                                     | TypeScript with one added statement                                                                                              |
| Who writes what             | Person: `LAWS.bend`. Agent: code and `PROOF.bend`. | Person: `*.laws.ts`. Agent: code, and loop `invariant`s inside it.                                                               |
| Checker                     | The type checker is the proof checker              | Z3 over symbolic execution of the real code, plus property tests where proof is out of reach                                     |
| Strength of "pass"          | A proof for all inputs                             | `proved` (all inputs), `bounded` (all inputs within a stated bound) or `tested` (no counterexample found); the status says which |
| Agent cannot cheat the laws | Human reviews the laws file                        | Lock file plus coverage gate; agents propose in `*.proposed.laws.ts`                                                             |
| Escape hatch for humans     | Learn Bend                                         | Read the code, run it, fix it                                                                                                    |

The honest difference: a Bend proof is checked by the type system for every program it accepts. Here, proof covers the part
of TypeScript that lowers to SMT (see [The prover](#the-prover)), and the rest is tested. Every result says which it is.

## Laws versus unit tests

A unit test checks examples you chose: `sort([3,1,2])` gives `[1,2,3]`. A law states a property of all inputs: for any
array, the result is ordered and has the same length. Both are TypeScript the agent must satisfy, but they differ in what
they can promise and who controls them.

|                       | Unit test                                                           | Law                                                                                                |
| --------------------- | ------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------- |
| Says                  | "for this input, this output"                                       | "for every input of this type, this holds"                                                         |
| Inputs                | Written by hand; the agent can pick easy ones                       | Generated from the declared types, biased to edge cases, shrunk to a minimal counterexample        |
| Strongest verdict     | Passed on the cases written                                         | `proved` for all inputs, or `bounded` for all inputs within a stated bound, or `tested`            |
| Who can change it     | Anyone, including the agent that is being checked                   | Only a person: the lock fails the check on any change, addition or removal                         |
| Missing code          | An untested function is invisible                                   | An exported function no law reaches fails as `uncovered`                                           |
| Can the agent game it | Yes: edit the test, delete it, assert less, special-case the inputs | Not by editing: the lock catches it. Special-casing is caught by generated inputs and by the proof |
| Feedback              | "expected 3, got 2"                                                 | A minimal failing input, the seed, and a next-action hint                                          |
| Cost to write         | Cheap per case, many cases                                          | One statement per behaviour, but you must be able to state the behaviour                           |

They also fit together: laws say what must always hold, and unit tests still pin down specific examples, regressions and
integration behaviour. Use laws for the properties you would otherwise review the agent's code for (ordering, bounds,
round-trips, "never negative", "same length", "idempotent"), and keep example tests for everything that is a case rather
than a rule.

## Quick start

```sh
npm i -D tslaws                 # plus the tsc-laws compiler binary, see "Build" below
npx tslaws init                 # config, agent rules, Claude Code hook; never writes the lock
# write src/foo.laws.ts, then, as a person at a terminal:
npx tslaws accept               # records the laws (and any coverage exemptions) in tsc-laws.lock
npx tslaws check                # exit 0 only when everything holds
npx tslaws check --watch        # re-check on every save
```

A law file:

```ts
// src/math.laws.ts
import { assume } from 'tslaws';
import type { int } from 'tslaws';
import { clamp, sortNumbers } from './math';

// Expression form: holds when it returns anything but false and does not throw.
export law addCommutes(a: number, b: number) => a + b === b + a;

// Block form, with a precondition. `proved` demands a proof for every input.
export law proved clampWithinBounds(x: number, lo: number, hi: number) {
  assume(lo <= hi);
  const y = clamp(x, lo, hi);
  return y >= lo && y <= hi;
}

// Arrays are checked exhaustively up to --bound (default 4), exactly like a bounded model checker.
export law sortOrders(xs: int[]) {
  const s = sortNumbers(xs);
  for (let i = 1; i < s.length; i++) if (s[i - 1] > s[i]) return false;
  return true;
}
```

## The language

`law` is a contextual keyword: it starts a statement only as `law name(` or `law proved name(` on one line, optionally
after `export`. Everywhere else it is an ordinary identifier, so existing code with variables or functions named `law`
keeps compiling.

```
law [proved] name<T>(a: A, b: B)  { block }
law [proved] name<T>(a: A, b: B)  => expression;
```

A law compiles to an ordinary exported function, so it type-checks and appears in declaration output.

### What the language does that a package cannot

`law` is part of the compiler, not a convention of a test library. The fork parses it and the **checker enforces the rules
of a specification**, as ordinary compile errors in your editor and in `tsc-laws` output:

| Code   | Rule                                                                                                                                 |
| ------ | ------------------------------------------------------------------------------------------------------------------------------------ |
| TS9101 | A law returns `boolean` or `void` (a promise of either, when it is `async`). Anything else is not a claim.                           |
| TS9102 | A law is exported, so the runner can load it.                                                                                        |
| TS9103 | Every parameter has a type annotation, because the type generates the inputs.                                                        |
| TS9104 | A law is not a generator or a default export.                                                                                        |
| TS9105 | Only another law may call a law. Application code cannot call a specification, so a law cannot become part of the program it checks. |
| TS9106 | Parameters are plain identifiers (no destructuring), so inputs map one to one.                                                       |

It also fixes what a package cannot: the declaration is a distinct kind of node (`law proved` is a modifier the lock hashes,
not a comment or a naming pattern), `--laws-manifest` lists every law from the syntax tree rather than by regex, and `law`
stays an identifier everywhere else, so no existing code breaks. What stays in the runner is what needs a runtime: running,
generating, proving, locking. Both halves are needed; the compiler makes a malformed or misplaced law impossible to write,
and the runner decides whether the code satisfies it.

Helpers from `tslaws`:

- `assume(cond)`: skip inputs the law does not cover. If it discards nearly every input the law is `open`.
- `int`: a whole number the prover treats exactly. At runtime an ordinary `number`.
- `invariant(cond)`: first statement of a loop body (see below). Throws at runtime if false.
- `arbitrary(typeName, fc.Arbitrary)`: a generator for a type the runner cannot derive.

## Browser laws

Name a law file `*.browser.laws.ts` and its laws run in a real browser (Chrome, Edge or Chromium; `TSLAWS_BROWSER` points at
another executable). Node still generates the inputs from the declared types and shrinks failures; each input is sent to a
page where your compiled code and the law run against a live DOM. A law there may be `async`.

```ts
// src/counter.browser.laws.ts
import type { int } from 'tslaws';
import { assume } from 'tslaws';
import { click, mount, settle } from 'tslaws/browser';
import { createCounter } from './counter';

export async law counterCountsClicks(clicks: int) {
  assume(clicks >= 0 && clicks <= 5);
  const { button, label } = createCounter(mount());
  for (let i = 0; i < clicks; i++) click(button);
  await settle();
  return label.textContent === String(clicks);
}
```

It is framework-agnostic: the law talks to the DOM. `mount(content)` takes markup, a node, or a function that renders into
the container (React's `createRoot(el).render(...)`, Vue's `createApp(...).mount(el)`, Svelte, Lit, or plain DOM) and may
return what undoes it. The page is cleaned between inputs. `tslaws/browser` also has `settle`, `click`, `type` and `fire`.

Browser laws are `tested` (method `browser`), never `proved`: Z3 cannot model a DOM or an `await`. A page that never
settles is stopped after `--property-timeout` and reported `error`. They sit under the same lock and coverage gate as any law.

## The dashboard

`tslaws ui` opens a local dashboard in the manner of Vitest's UI: a sidebar tree of files and laws with status icons, filters
(All, Failed, Open, Passed), search, and a detail pane with the report (message, counterexample, a copyable reproduce command,
the next step), the law's source with its lines highlighted, and the compiler output. It reruns on save and has a Run all button
(`r`; `/` focuses search; `Esc` clears the selection); hovering a file shows a button that reruns just that file. When a browser law fails, the page is photographed at the shrunk counterexample (`.tslaws/screenshots/`) and the image appears in the report. `--port N` picks the port (default 51205, another if busy);
`--no-open` keeps it from opening a browser.

Laws appear as the run proceeds: waiting, running (pulsing), then their result, with a progress bar and a Running filter. For browser laws the dashboard shows the page itself, live: while a law runs, the first runs linger for a moment (`browserPauseMs`) and the page is photographed a few times a second, so you see the component the law is driving; afterwards the last frame stays on the law's report.

It listens on 127.0.0.1 only, rejects requests whose Host or Origin is not loopback and the page itself, and cannot accept
laws: `tslaws accept` stays a person's act at a terminal.

## Editor integration

`packages/vscode-tslaws` is a VS Code extension with no bundled dependencies. Above each `law` in a `*.laws.ts` file it shows a
CodeLens with the last status (`proved`, `bounded`, `tested`, `open`, `failed`, `uncovered`, `tampered`, `error` or `not run`),
a `Run` lens, and for a failure the shrunk counterexample. Failed, open, tampered and error laws appear as problems on the
law's line with the message, counterexample and hint. A status-bar item shows totals (`laws: 3 proved, 1 failed`) and opens
the dashboard. Commands: `tslaws.check`, `tslaws.runFile`, `tslaws.openDashboard` (runs `tslaws ui --no-open --port 0`), and
`tslaws.accept`, which only types `npx tslaws accept` into a terminal; a person presses Enter. Settings: `tslaws.runOnSave`
(default on), `tslaws.executable` and `tslaws.args`. It runs `node_modules/.bin/tslaws`, else `npx tslaws`.

## Statuses

| Status      | Meaning                                                                                                           | Passes? |
| ----------- | ----------------------------------------------------------------------------------------------------------------- | ------- |
| `proved`    | No input breaks the law; no bound involved.                                                                       | yes     |
| `bounded`   | No input breaks it within the stated bounds (array length, loop iterations, recursion depth, `int` within ±2^26). | yes     |
| `tested`    | `fast-check` found nothing in `--runs` inputs; the code does not lower to the prover.                             | yes     |
| `open`      | `law proved` that was not proved for every input, or `assume` discards nearly everything.                         | no      |
| `failed`    | A counterexample, minimal, with the seed to reproduce.                                                            | no      |
| `uncovered` | Exported code no law reaches.                                                                                     | no      |
| `tampered`  | A law changed, was added or removed since the lock was accepted, or a coverage exemption is not in the lock.      | no      |
| `error`     | The law cannot run: not exported, untyped parameter, no generator, load failure.                                  | no      |

## Inputs

The compiler emits declarations and `tslaws` reads each parameter's type from them, so the whole type system drives input
generation: primitives and literals, unions, enums, template literals, arrays, tuples, interfaces and type literals,
optional properties, index signatures, `Date`, and type parameters through their constraints. Parameters typed `number`
are finite doubles. Failures shrink, and the report prints the seed: `tslaws check --seed N` reproduces it.

## The prover

`tslaws` symbolically executes the compiled JavaScript of the law, inlining the project functions it calls, and asks Z3
for an input that returns `false` or breaks an obligation. A model is replayed in JavaScript; only a reproduced failure is
reported as `failed`.

- **Numbers are IEEE doubles**, so rounding, overflow and `-0` are real and `(a + b) + c === a + (b + c)` is refuted. Z3
  cannot decide most double arithmetic, so those laws stay `tested`; commutative `+` and `*` are normalised, so
  `a + b === b + a` proves.
- **`int` is exact.** Integer arithmetic carries the obligation that results stay within ±(2^53 − 1). When the full range
  fails only on that obligation the proof is retried with `int` in ±2^26 and reported `bounded`. `bigint` is exact with no
  bound.
- **Arrays, loops and recursion** unroll up to `--bound` (default 4) and give `bounded`. Supported: `length`, indexing,
  literals and spread, `push`, `map`, `filter`, `every`, `some`, `reduce`, `includes`, `indexOf`, `slice(n)`, `concat`,
  `reverse`, `sort(comparator)`, `[...new Set(xs)]`, `for`, `while`, `for…of`, `break`, `continue`. Mutation is allowed
  only on arrays no second name can reach.
- **Strings** are SMT strings restricted to the BMP: `+`, templates, `length`, `charAt`, indexing, `slice`, `substring`,
  `includes`, `startsWith`, `endsWith`, `indexOf`, comparisons.
- **Records**, `typeof`, `Math.abs/min/max/floor/ceil/trunc`, ternaries, `const`/`let`, `assume`.
- **Loop invariants** give a proof for every iteration count. Put `invariant(cond)` first in a loop body. The prover proves
  it on entry, assumes it at the top of an arbitrary iteration, proves it again at the end, and gives the code after the
  loop an arbitrary state where the invariant holds and the condition is false:

  ```ts
  export function sumTo(n: int): int {
    let s = 0,
      i = 0;
    while (i < n) {
      invariant(0 <= i && i <= n);
      invariant(2 * s === i * (i - 1));
      s += i;
      i += 1;
    }
    return s as int;
  }
  // law proved: assume(n >= 0 && n < 1_000_000); return 2 * sumTo(n) === n * (n - 1);
  ```

  Invariants live in the implementation, so the agent writes them; the laws stay yours. The loop may change numbers,
  booleans, strings, arrays and records, and may `return`, `break` or `continue`. A changed array keeps the room it had,
  so such a proof is `bounded` by that length. This is partial correctness.

- **Quantifiers:** `forall(xs, (x, i) => cond)` and `exists(xs, (x, i) => cond)` (from `tslaws`) say that every, or some,
  element satisfies a condition. They run as loops in property tests. The prover lowers them over the array's slots:
  `forall` is the conjunction of `k < length => cond(xs[k], k)` and `exists` the disjunction of `k < length && cond(xs[k], k)`.
  Use them in `assume(...)`, in a law's result and in `invariant(...)`; the predicate may use outer variables and the index.
  Like any array claim, a proof that uses them is `bounded` by `--bound`, never `proved`. The predicate must be an arrow
  function the prover can lower, or the law stays `tested`:

  ```ts
  export law allPositiveSumPositive(xs: int[]) { assume(forall(xs, (x) => x > 0)); return sum(xs) >= 0; }
  ```

Anything else leaves the law `tested`, or a `law proved` `open`, with the reason. Z3 runs in a worker that is terminated if
a query outlives its timeout (`--proof-timeout`, default 5000 ms). `TSLAWS_DEBUG=1` keeps each query as an `.smt2` file
under `.tslaws/out/smt`.

## Keeping agents honest

1. **Laws are the person's.** `tsc-laws.lock` holds a hash of every law declaration and every coverage exemption. Any
   difference fails the check as `tampered`. `tslaws accept` refuses to run without a terminal, under `CI`, or with
   `TSLAWS_AGENT` set.
2. **No code escapes.** Every exported function or class in the covered modules must be reached by a law, directly or
   through the functions a law calls. Covered modules are the `cover` globs of `tslaws.json`
   (`{ "cover": ["src/**/*.ts", "!src/**/*.test.ts"] }`), or, without that file, every module the laws import. A function
   marked `@tslaws-exempt` in its doc comment is exempt only once the exemption is in the lock.
3. **Agents propose, people promote.** Agents write candidate laws in `*.proposed.laws.ts` and try them with
   `tslaws check --proposed` (no lock, no coverage gate). A person moves them into a `*.laws.ts` file and accepts.
4. **The gate runs by itself.** `tslaws init` installs a Claude Code hook (`hooks/claude-hook.mjs`) that blocks
   `git commit` and sends the agent back to work when the check fails, plus rules for `AGENTS.md`
   (`hooks/AGENTS.snippet.md`).

## Commands

```
tslaws init [--force]
tslaws accept [files...]
tslaws regressions [list|clear]
tslaws mutate [files...] [--max N] [--seed N] [--json]
tslaws check [files...] [--json] [--summary] [--watch] [--runs N] [--seed N] [--no-prove] [--no-regressions] [--bound N]
             [--proof-timeout MS] [--proposed] [--compiler PATH]
```

Exit status is 0 only when every law is `proved`, `bounded` or `tested`, nothing is `uncovered`, the files compile and the
lock matches. `--json` adds a `hint` to each result: the concrete next action for an agent. `--summary` prints only the
results that do not pass, and the totals.

The compiler is `--compiler`, `TSC_LAWS_BIN`, or `tsc-laws` on `PATH`. It finds its lib files through `TSC_TS_LIB_DIR`, or
the TypeScript 7 libs scriptc installs in `node_modules/@scriptc/*`. `tsc-ts --laws-manifest <files>` lists the laws of
files as JSON.

## Regression corpus

Every counterexample that a property test finds (node laws and browser laws) is saved to
`.tslaws/regressions/<law file, with / written as __>/<law>.json`. Values are stored in a lossless tagged JSON, so `NaN`,
`-0`, `Infinity`, `undefined`, `bigint` and `Date` come back exactly. A law keeps at most 20 distinct examples, newest first.
Only a real counterexample is saved: not a law whose `assume` discards nearly every input, not a timeout, not a prover model.

On the next run, every stored example of a law is replayed before the random search. If one still fails, the law fails with
`regression: a previously found counterexample still fails` and the counterexample, whatever the seed or `--runs`. An example
that now passes stays in the corpus and keeps guarding the law. A fixed bug therefore cannot return unnoticed, even though the
random search would rarely find it again.

`tslaws init` ignores `.tslaws/out`, `.tslaws/mutants` and `.tslaws/screenshots` but not `.tslaws/regressions`, so a team may
commit the corpus. `tslaws check --no-regressions` neither reads nor writes it. `tslaws regressions list` prints each law and
its example count per file; `tslaws regressions clear` deletes the directory.

## Mutation testing

`tslaws mutate [files...] [--max N] [--seed N] [--json]` asks whether the laws are strong enough. It changes the covered
source in small ways (relational, arithmetic and logical operators, `true`/`false`, numeric literals, negated `if`
conditions, removed `!`), re-runs the laws against each mutant in a scratch copy under `.tslaws/mutants/`, and reports each
mutant as killed (a law failed, errored or timed out) or survived (every law still held, so the laws cannot tell the change
apart). Your files are never written. A `*.laws.ts` argument chooses the laws; other files limit which sources are mutated.
Without arguments it uses every laws file and every covered module. `--max` (default 50) and `--seed` sample a subset.

It prints each survivor as `file:line  original  ->  mutated` with a hint, and the mutation score. Exit status is 0 only when
every tried mutant is killed. It first checks the unmutated code and stops if the laws do not pass. Mutants that do not
compile are skipped and not counted. Some survivors are equivalent mutants (for example `<` to `<=` where both sides are
equal); strengthen a law only when the survivor is a real behaviour change. Each mutant runs 50 tests with a short proof
timeout, and the lock is not enforced.

## CI reporters

`tslaws check --reporter <name>` chooses the output. The exit status does not change: 0 only when the check passes.

- `text` (default) is the console report; `json` is the same as `--json`.
- `junit` writes JUnit XML to stdout: one `<testsuite>` per law file and one `<testcase classname=file name=law>` per law. `failed`,
  `open`, `tampered`, `error` and `uncovered` results carry a `<failure>` with the message, counterexample and hint.
- `github` writes GitHub Actions workflow commands: `::error file=...,line=...,title=<law> <status>::...` for each failing
  result and a `::notice` for `bounded` and `tested` ones. When `GITHUB_STEP_SUMMARY` is set, it also appends a markdown table
  of the results to that file.

```yaml
- run: npx tslaws check --reporter github
```

For a test report, redirect JUnit output: `npx tslaws check --reporter junit > tslaws-junit.xml`.

## Build

```sh
npm ci
npm run fetch:upstream
npm run build:native -w tsc-ts           # needs clang (and zig on Windows); build:native:dev is faster to build
npm run build -w tslaws
TSC_LAWS_BIN=packages/tsc-ts/dist/tsc npm test -w tslaws
TSC_TS_BIN=packages/tsc-ts/dist/tsc node --test packages/tsc-ts/tests/laws.test.mjs
```

On Windows the native build is `dist/tsc`; copy it to `tsc.exe` to run it.

## What is where

| Path                                                     | Contents                                                                                                |
| -------------------------------------------------------- | ------------------------------------------------------------------------------------------------------- |
| `packages/tsc-ts/src/compiler/parser.ts`                 | `law` parsing: `isLawDeclarationStart`, `parseLawDeclaration`; `NodeFlags.Law` and `Proved` in `ast.ts` |
| `packages/tsc-ts/src/laws/manifest.ts`                   | `--laws-manifest`                                                                                       |
| `packages/tslaws/src/symbolic.ts`, `smt.ts`              | the symbolic executor and the Z3 driver                                                                 |
| `packages/tslaws/src/check.ts`, `coverage.ts`, `lock.ts` | the check, the coverage gate, the tamper lock                                                           |
| `packages/tslaws/src/generators.ts`                      | generators from declared types                                                                          |
| `packages/tslaws/src/init.ts`, `hints.ts`, `cli.ts`      | scaffolding, agent hints, commands                                                                      |
| `packages/tslaws/hooks/`                                 | Claude Code hook, settings example, agent rules                                                         |
| `packages/vscode-tslaws/`                                | VS Code grammar for `law`                                                                               |
| `examples/basic/`                                        | a small project with a failing law, a lock and coverage                                                 |

## Limits

- Laws over arrays are bounded: Z3 holds an array as a fixed number of slots. Unbounded claims about every element need
  quantifiers, which Z3 does not decide reliably; put the claim in a loop `invariant` over scalars and the array's length.
- Laws over plain `number` mostly stay `tested`: SMT floating point arithmetic is decidable but usually too slow. Use `int`
  or `bigint` where you want a proof.
- Loop invariants prove partial correctness (a loop that never ends is not flagged), and an array that grows past its room
  is outside the claim.
- Browser and async laws are tested, not proved.
- Browser laws need an installed Chromium-family browser; Firefox and WebKit are not driven.
- The compiler needs a native toolchain to build; the `laws-v*` release workflow publishes builds for macOS, Linux and Windows.
