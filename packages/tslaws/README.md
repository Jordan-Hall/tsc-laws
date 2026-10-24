# tslaws

Laws for TypeScript, checked the way Bend 2 checks its `LAWS.bend`: a person writes the laws, an agent writes the
code, and one command says whether every law holds.

```ts
// src/math.laws.ts
import { assume } from 'tslaws';
import { add, clamp } from './math';

export law addCommutes(a: number, b: number) => add(a, b) === add(b, a);

export law proved clampWithinBounds(x: number, lo: number, hi: number) {
  assume(lo <= hi);
  const y = clamp(x, lo, hi);
  return y >= lo && y <= hi;
}
```

`law` is syntax of the `tsc-laws` compiler (a fork of [tsc-ts](https://github.com/vercel-labs/tsc-ts)). A law is a function
declaration the compiler type-checks like any other. It holds for an input when it returns anything but `false` and does not
throw. `assume(cond)` skips inputs a law does not cover. Everywhere except at the start of a statement, `law` is still an
ordinary identifier.

```
$ tslaws check
PROVED   addCommutes (src/math.laws.ts:4) [smt:real]
PROVED   clampWithinBounds (src/math.laws.ts:6) [smt:real]
FAILED   sortKeepsLength (src/math.laws.ts:14) [property]
         returned false
         counterexample: [[3,3]]
         reproduce with --seed 1090953994
```

## Statuses

| Status | Meaning |
| --- | --- |
| `proved` | Z3 shows no input makes the law return `false` (see *The prover*). |
| `tested` | `fast-check` found no counterexample in `--runs` inputs (default 200). Not a proof. |
| `open` | Declared `law proved ...` but not proved, or `assume` discards nearly every input. Fails the check. |
| `failed` | A counterexample, shrunk to a minimal input, with the seed to reproduce it. |
| `tampered` | The law changed, was added or removed since `tsc-laws.lock` was accepted. |
| `error` | The law cannot run: not exported, a parameter has no type, no generator for a type, load failure. |

`tslaws check` exits 0 only when every law is `proved` or `tested`, the files compile, and the lock matches.

## Inputs come from types

The compiler emits declarations, and `tslaws` reads each parameter's type from them, so the full type system drives input
generation: primitives and literals, unions, enums, template literals, arrays, tuples, interfaces and type literals (optional
properties included), index signatures, `Date`, and type parameters through their constraints. Register a generator for a type
the runner cannot derive, by its name:

```ts
import { arbitrary, fc } from 'tslaws';
arbitrary('UserId', fc.string({ minLength: 8, maxLength: 8 }));
```

## The prover

For a law that is also under `law proved`, or whenever it can, `tslaws` lowers the compiled JavaScript of the law and of the
project functions it calls to SMT-LIB and asks Z3 whether any input returns `false`. What lowers: numbers, booleans and records
of them as parameters; `+ - * /` (division only by a nonzero literal), comparisons, `&& || !`, `?:`, `Math.abs/min/max/floor`;
`const` bindings; `if`/`return`; `assume` at the top of the law; calls to other functions made of the same things, including
arrow functions. Anything else leaves the law `tested`, and `proved` laws `open`, with the reason.

**Numbers are exact reals by default**, so a proof ignores rounding, overflow and NaN. Z3's floating-point theory cannot decide
even `a + b === b + a` within 20 s, so `--numbers fp` exists but mostly times out. A model Z3 finds is replayed in JavaScript;
only a reproduced failure is reported as `failed`.

## Agents cannot move the goalposts

`tsc-laws.lock` holds a hash of every law declaration. A change, an added law or a removed law fails the check until a
person runs `tslaws accept`, which refuses to run without a terminal, under `CI`, or with `TSLAWS_AGENT` set. Agents propose laws in
`*.proposed.laws.ts` and try them with `tslaws check --proposed` (no lock needed); a person moves them into a `*.laws.ts` file
and accepts.

`hooks/claude-hook.mjs` is a Claude Code hook that blocks `git commit` and sends an agent back to work when the check fails;
`hooks/claude-settings.example.json` wires it up and `hooks/AGENTS.snippet.md` tells the agent the rules.

## Commands

```
tslaws check [files...] [--json] [--runs N] [--seed N] [--no-prove] [--numbers real|fp]
             [--proof-timeout MS] [--proposed] [--compiler PATH]
tslaws accept [files...]
```

Without files, every `*.laws.ts` under the current directory is used. The compiler is `--compiler`, `TSC_LAWS_BIN`, or
`tsc-laws` on `PATH`; it finds its lib files through `TSC_TS_LIB_DIR`, or the TypeScript 7 libs scriptc installs in
`node_modules/@scriptc/*`.

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
