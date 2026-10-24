# Laws for TypeScript

`tsc-laws` is a fork of [tsc-ts](https://github.com/vercel-labs/tsc-ts) that adds one statement to TypeScript, `law`, and
`tslaws`, a checker that holds your code to those laws. It exists so that people can say what code must do, let coding
agents write the code, and get a machine verdict instead of a code review. The idea is Bend 2's: the person writes the
laws, the agent writes the program and its proofs, and a checker the agent cannot talk round gates every change. The
difference is that it stays TypeScript, so any human can read, run and fix everything.

## What it offers

| Offer | What you get |
| --- | --- |
| **`law` declarations** | A statement of the language, type-checked like a function, that says what must hold for all inputs. |
| **Verdicts, not opinions** | Each law ends `proved`, `bounded`, `tested`, `failed`, `open`, `uncovered`, `tampered` or `error`. One exit status. |
| **Real proofs** | Z3 proves laws over exact integers, bigints, booleans, strings and records, and over IEEE doubles where it can decide. Loop invariants extend this to loops for every iteration count. |
| **Bounded proofs** | Arrays, plain loops and recursion are checked exhaustively up to a stated bound. |
| **Property tests as the floor** | Anything the prover cannot lower is tested with `fast-check`; inputs are generated from your declared types, and failures shrink to a minimal counterexample with a seed. |
| **Laws the agent cannot weaken** | `tsc-laws.lock` hashes every law. Changing, adding or removing one, or exempting code, fails the check until a person runs `tslaws accept`, which refuses to run without a terminal. |
| **Coverage** | Every exported function and class must be reached by a law, so new code cannot slip through unchecked. |
| **Agent ergonomics** | `tslaws init` scaffolds the rules and a Claude Code hook; `--json` and `--summary` give structured, compact output with a next-action `hint` per result; `--watch` re-checks on save. |
| **Human ergonomics** | A VS Code grammar for `law`, plain TypeScript output, and counterexamples you can paste into a test. |

## How it compares with Bend 2

| | Bend 2 | tsc-laws |
| --- | --- | --- |
| Language | A new language | TypeScript with one added statement |
| Who writes what | Person: `LAWS.bend`. Agent: code and `PROOF.bend`. | Person: `*.laws.ts`. Agent: code, and loop `invariant`s inside it. |
| Checker | The type checker is the proof checker | Z3 over symbolic execution of the real code, plus property tests where proof is out of reach |
| Strength of "pass" | A proof for all inputs | `proved` (all inputs), `bounded` (all inputs within a stated bound) or `tested` (no counterexample found); the status says which |
| Agent cannot cheat the laws | Human reviews the laws file | Lock file plus coverage gate; agents propose in `*.proposed.laws.ts` |
| Escape hatch for humans | Learn Bend | Read the code, run it, fix it |

The honest difference: a Bend proof is checked by the type system for every program it accepts. Here, proof covers the part
of TypeScript that lowers to SMT (see [The prover](#the-prover)), and the rest is tested. Every result says which it is.

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

A law compiles to an ordinary exported function, so it type-checks, appears in declaration output and can be called from
tests. Rules enforced by `tslaws`: a law must be exported, must not be `async` or the default export, and every parameter
must be a plain identifier with a type annotation (the type drives input generation).

Helpers from `tslaws`:

- `assume(cond)`: skip inputs the law does not cover. If it discards nearly every input the law is `open`.
- `int`: a whole number the prover treats exactly. At runtime an ordinary `number`.
- `invariant(cond)`: first statement of a loop body (see below). Throws at runtime if false.
- `arbitrary(typeName, fc.Arbitrary)`: a generator for a type the runner cannot derive.

## Statuses

| Status | Meaning | Passes? |
| --- | --- | --- |
| `proved` | No input breaks the law; no bound involved. | yes |
| `bounded` | No input breaks it within the stated bounds (array length, loop iterations, recursion depth, `int` within ±2^26). | yes |
| `tested` | `fast-check` found nothing in `--runs` inputs; the code does not lower to the prover. | yes |
| `open` | `law proved` that was not proved for every input, or `assume` discards nearly everything. | no |
| `failed` | A counterexample, minimal, with the seed to reproduce. | no |
| `uncovered` | Exported code no law reaches. | no |
| `tampered` | A law changed, was added or removed since the lock was accepted, or a coverage exemption is not in the lock. | no |
| `error` | The law cannot run: not exported, untyped parameter, no generator, load failure. | no |

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
    let s = 0, i = 0;
    while (i < n) {
      invariant(0 <= i && i <= n);
      invariant(2 * s === i * (i - 1));
      s += i; i += 1;
    }
    return s as int;
  }
  // law proved: assume(n >= 0 && n < 1_000_000); return 2 * sumTo(n) === n * (n - 1);
  ```

  Invariants live in the implementation, so the agent writes them; the laws stay yours. The loop may change numbers,
  booleans and strings, may only read arrays and records, and may not `return`, `break` or `continue`. This is partial
  correctness.

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
tslaws check [files...] [--json] [--summary] [--watch] [--runs N] [--seed N] [--no-prove] [--bound N]
             [--proof-timeout MS] [--proposed] [--compiler PATH]
```

Exit status is 0 only when every law is `proved`, `bounded` or `tested`, nothing is `uncovered`, the files compile and the
lock matches. `--json` adds a `hint` to each result: the concrete next action for an agent. `--summary` prints only the
results that do not pass, and the totals.

The compiler is `--compiler`, `TSC_LAWS_BIN`, or `tsc-laws` on `PATH`. It finds its lib files through `TSC_TS_LIB_DIR`, or
the TypeScript 7 libs scriptc installs in `node_modules/@scriptc/*`. `tsc-ts --laws-manifest <files>` lists the laws of
files as JSON.

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

| Path | Contents |
| --- | --- |
| `packages/tsc-ts/src/compiler/parser.ts` | `law` parsing: `isLawDeclarationStart`, `parseLawDeclaration`; `NodeFlags.Law` and `Proved` in `ast.ts` |
| `packages/tsc-ts/src/laws/manifest.ts` | `--laws-manifest` |
| `packages/tslaws/src/symbolic.ts`, `smt.ts` | the symbolic executor and the Z3 driver |
| `packages/tslaws/src/check.ts`, `coverage.ts`, `lock.ts` | the check, the coverage gate, the tamper lock |
| `packages/tslaws/src/generators.ts` | generators from declared types |
| `packages/tslaws/src/init.ts`, `hints.ts`, `cli.ts` | scaffolding, agent hints, commands |
| `packages/tslaws/hooks/` | Claude Code hook, settings example, agent rules |
| `packages/vscode-tslaws/` | VS Code grammar for `law` |
| `examples/basic/` | a small project with a failing law, a lock and coverage |

## Limits

- The property tests run in the main thread, so a law that calls code which never terminates can hang the check. Only the
  prover is protected by a watchdog.
- Laws over arrays are bounded; unbounded array proofs would need quantifiers.
- Laws over plain `number` mostly stay `tested`, because Z3 cannot decide most double arithmetic. Use `int` or `bigint`
  where you want a proof.
- Loops with an `invariant` cannot change arrays or records, and cannot `return`, `break` or `continue`.
- The compiler is Windows-, macOS- and Linux-buildable but needs a native toolchain; there is no prebuilt binary yet.
