# tslaws

Laws for TypeScript, checked the way Bend 2 checks its `LAWS.bend`: a person writes the laws, an agent writes the code,
and one command says whether the code satisfies every law and whether any code is left unchecked.

```ts
// src/math.laws.ts
import type { int } from 'tslaws';
import { assume } from 'tslaws';
import { clamp, sortNumbers } from './math';

export law proved clampWithinBounds(x: number, lo: number, hi: number) {
  assume(lo <= hi);
  const y = clamp(x, lo, hi);
  return y >= lo && y <= hi;
}

export law sortOrders(xs: int[]) {
  const s = sortNumbers(xs);
  for (let i = 1; i < s.length; i++) if (s[i - 1] > s[i]) return false;
  return true;
}
```

`law` is syntax of the `tsc-laws` compiler (a fork of [tsc-ts](https://github.com/vercel-labs/tsc-ts)). A law is a function
declaration the compiler type-checks like any other. It holds for an input when it returns anything but `false` and does not
throw. `assume(cond)` skips inputs a law does not cover. Everywhere except at the start of a statement, `law` is still an
ordinary identifier.

```
$ tslaws check
PROVED   clampWithinBounds (src/math.laws.ts:5) [smt]
BOUNDED  sortOrders (src/math.laws.ts:11) [smt]
         holds within bounds: int values stay within ±2^26; arrays hold at most 4 elements; loops run at most 4 times
FAILED   sortKeepsLength (src/math.laws.ts:17) [property]
         returned false
         counterexample: [[3,3]]
         reproduce with --seed 1090953994
UNCOVERED sub (src/math.ts) [coverage]
         no law reaches this exported function; add a law, or a person can mark it @tslaws-exempt and accept
```

## What "checked against the laws" means

Two things, both required for exit status 0:

1. **Every law holds for the code.** The implementation, not a copy of it, is what runs and what is proved.
2. **No code escapes the laws.** Every exported function or class in the covered modules is reached by a law, directly or
   through the functions the law calls. Covered modules are the `cover` globs of `tslaws.json`
   (`{ "cover": ["src/**/*.ts", "!src/**/*.test.ts"] }`), or, without that file, every project module the laws import.

## Statuses

| Status | Meaning |
| --- | --- |
| `proved` | Z3 shows no input makes the law return `false`, with no bound involved. |
| `bounded` | Z3 shows it for every input within stated bounds: array length (`--bound`, default 4), loop iterations, recursion depth, `int` values within ±2^26. |
| `tested` | `fast-check` found no counterexample in `--runs` inputs (default 200); the code does not lower to the prover. Not a proof. |
| `open` | Declared `law proved …` but not proved for every input (a bounded proof does not count), or `assume` discards nearly every input. Fails the check. |
| `failed` | A counterexample, shrunk to a minimal input, with the seed to reproduce it. |
| `uncovered` | Exported code no law reaches. Fails the check. |
| `tampered` | A law changed, was added or removed since `tsc-laws.lock` was accepted, or a coverage exemption is not in it. Fails the check. |
| `error` | The law cannot run: not exported, a parameter has no type, no generator for a type, load failure. |

`tslaws check` exits 0 only when every law is `proved`, `bounded` or `tested`, nothing is `uncovered`, the files compile, and
the lock matches.

## Inputs come from types

The compiler emits declarations and `tslaws` reads each parameter's type from them, so the full type system drives input
generation: primitives and literals, unions, enums, template literals, arrays, tuples, interfaces and type literals (optional
properties included), index signatures, `Date`, and type parameters through their constraints. Parameters typed `number` are
finite doubles (no NaN, no infinities). Register a generator for a type the runner cannot derive, by its name:

```ts
import { arbitrary, fc } from 'tslaws';
arbitrary('UserId', fc.string({ minLength: 8, maxLength: 8 }));
```

## The prover

`tslaws` symbolically executes the compiled JavaScript of a law, inlining the project functions it calls, and asks Z3 for an
input that returns `false` or breaks an obligation. A model is replayed in JavaScript, and only a reproduced failure is
reported as `failed`.

- **Numbers are IEEE doubles** (SMT-LIB floating point), so rounding, overflow and `-0` are real, and `(a + b) + c ===
  a + (b + c)` is refuted. Z3 cannot decide most double arithmetic, so those laws stay `tested`; commutative `+` and `*` are
  normalised so `a + b === b + a` is proved.
- **`int` is exact.** `import type { int } from 'tslaws'` marks a whole number (`number & brand`, an ordinary number at
  runtime). Integer arithmetic carries the obligation that results stay within ±(2^53 − 1); when the full range fails only on
  that obligation, the proof is retried with `int` values in ±2^26 and reported `bounded`. `bigint` is exact with no bound.
- **Arrays, loops, recursion** are unrolled up to `--bound` (default 4), making the result `bounded`. Supported: `length`,
  indexing, literals and spread, `push`, `map`, `filter`, `every`, `some`, `reduce`, `includes`, `indexOf`, `slice(n)`,
  `concat`, `reverse`, `sort(comparator)` (a stable sorting network), `[...new Set(xs)]`, `for`, `while`, `for…of`, `break`,
  `continue`. Mutation is allowed only on arrays no second name can reach.
- **Strings** are unbounded SMT strings restricted to the BMP: `+`, templates, `length`, `charAt`, indexing, `slice`,
  `substring`, `includes`, `startsWith`, `endsWith`, `indexOf`, comparisons.
- **Records** of any of these, and `typeof`, `Math.abs/min/max/floor/ceil/trunc`, ternaries, `const`/`let`, `assume`.

- **Loop invariants give proofs for every number of iterations.** Put `invariant(cond)` first in a loop body (`import {
  invariant } from 'tslaws'`; it throws at runtime when false, so property tests check it on every iteration). The prover
  proves the invariant on entry, assumes it at the top of an arbitrary iteration, proves it again at the end, and gives the
  code after the loop an arbitrary state where the invariant holds and the condition is false. No unrolling, so no bound:

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
  // law proved: 2 * sumTo(n) === n * (n - 1), for every n >= 0
  ```

  Invariants live in the implementation, so the agent writes them; the laws stay the person's. Restrictions: the loop may
  change numbers, booleans and strings but only read arrays and records, and may not `return`, `break` or `continue`.
  This is partial correctness (a loop that never ends is not flagged).

Anything else leaves the law `tested`, or a `law proved` `open`, with the reason. Z3 runs in a worker thread that is terminated if a query outlives its timeout, so a hard query cannot hang the check. `TSLAWS_DEBUG=1` keeps each query as an
`.smt2` file under `.tslaws/out/smt` to replay in `z3`.

## Agents cannot move the goalposts

`tsc-laws.lock` holds a hash of every law declaration and the list of coverage exemptions. A change, an added law, a removed
law or a new `@tslaws-exempt` fails the check until a person runs `tslaws accept`, which refuses to run without a terminal,
under `CI`, or with `TSLAWS_AGENT` set. Agents propose laws in `*.proposed.laws.ts` and try them with `tslaws check
--proposed` (no lock, no coverage gate); a person moves them into a `*.laws.ts` file and accepts.

`hooks/claude-hook.mjs` is a Claude Code hook that blocks `git commit` and sends an agent back to work when the check fails;
`hooks/claude-settings.example.json` wires it up and `hooks/AGENTS.snippet.md` tells the agent the rules.

## Commands

```
tslaws init [--force]
tslaws accept [files...]
tslaws check [files...] [--json] [--summary] [--watch] [--runs N] [--seed N] [--no-prove] [--bound N]
             [--proof-timeout MS] [--proposed] [--compiler PATH]
```

- `init` scaffolds `tslaws.json`, the `.tslaws` ignore entry, the agent rules in `AGENTS.md`, the Claude Code hook in
  `.claude/settings.json`, and a starter law if none exists. It never writes the lock; a person then runs `accept`.
- `accept` records the laws and the `@tslaws-exempt` functions in `tsc-laws.lock`. It refuses to run without a terminal,
  under `CI`, or with `TSLAWS_AGENT` set.
- `check` exits 0 only when every law is `proved`, `bounded` or `tested`, nothing is `uncovered`, the files compile and the
  lock matches. `--json` adds a `hint` to each result, the concrete next action for an agent. `--summary` prints only the
  results that do not pass, plus the totals. `--watch` re-runs on every `.ts` change.

Without files, every `*.laws.ts` under the current directory is used. The compiler is `--compiler`, `TSC_LAWS_BIN`, or
`tsc-laws` on `PATH`; it finds its lib files through `TSC_TS_LIB_DIR`, or the TypeScript 7 libs scriptc installs in
`node_modules/@scriptc/*`.

See [docs/laws.md](../../docs/laws.md) for the language, how it compares with Bend 2, and the limits.

## Build and test

```
npm ci
npm run fetch:upstream && npm run build:native:dev -w tsc-ts   # needs clang (and zig on Windows)
npm run build -w tslaws
TSC_LAWS_BIN=packages/tsc-ts/dist/tsc npm test -w tslaws
TSC_TS_BIN=packages/tsc-ts/dist/tsc node --test packages/tsc-ts/tests/laws.test.mjs
```

`tsc-ts --laws-manifest <files>` lists the laws of files as JSON (name, parameters, line, declaration text, and the problems
that stop a law running); `tslaws` uses it for the lock and for reporting.
