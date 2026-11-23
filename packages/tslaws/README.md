# tslaws

[![npm](https://img.shields.io/npm/v/tslaws)](https://www.npmjs.com/package/tslaws)
[![CI](https://github.com/Jordan-Hall/tsc-laws/actions/workflows/ci.yml/badge.svg?branch=main)](https://github.com/Jordan-Hall/tsc-laws/actions/workflows/ci.yml)
[![License](https://img.shields.io/github/license/Jordan-Hall/tsc-laws)](https://github.com/Jordan-Hall/tsc-laws/blob/main/LICENSE)
[![tslaws](https://img.shields.io/endpoint?url=https%3A%2F%2Fraw.githubusercontent.com%2FJordan-Hall%2Ftsc-laws%2Fmain%2Fdocs%2Fcertificates%2Fbadge-laws.json)](https://github.com/Jordan-Hall/tsc-laws/blob/main/docs/certificates/README.md)
[![certificates](https://img.shields.io/endpoint?url=https%3A%2F%2Fraw.githubusercontent.com%2FJordan-Hall%2Ftsc-laws%2Fmain%2Fdocs%2Fcertificates%2Fbadge-certificates.json)](https://github.com/Jordan-Hall/tsc-laws/blob/main/docs/certificates/README.md)

Laws for TypeScript. A person writes `law` declarations, an agent writes the code, and one command says whether the code
satisfies every law and whether any exported code is left unchecked.

## Install and quick start

```sh
npm i -D tslaws   # also installs the compiler for your platform (tslaws-compiler-<platform>)
npx tslaws init   # tslaws.json, agent rules in AGENTS.md, a Claude Code hook, a starter law; never writes the lock
npx tslaws accept # a person, at a terminal: records the laws in tsc-laws.lock
npx tslaws check  # exit 0 only when everything holds
```

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

`law` is syntax of the `tsc-laws` compiler, a fork of [tsc-ts](https://github.com/vercel-labs/tsc-ts) that `tslaws`
installs. A law is a function declaration the compiler
type-checks like any other. It holds for an input when it returns anything but `false` and does not throw. `assume(cond)`
skips inputs a law does not cover. Everywhere except at the start of a statement, `law` is still an ordinary identifier.

## Output

```
$ tslaws check
PROVED    clampWithinBounds (src/math.laws.ts:5) [smt]
          assuming: number parameters exclude NaN and ±Infinity
BOUNDED   sortOrders (src/math.laws.ts:11) [smt]
          holds within bounds: int values stay within ±2^26; arrays hold at most 4 elements; loops run at most 4 times
          hint: Proved only within bounds (...). Passing; no action needed unless a person wants a full proof.
FAILED    sortKeepsLength (src/math.laws.ts:17) [property]
          returned false
          counterexample: [[3,3]]
          reproduce with --seed 1090953994
          hint: The code breaks this law. The counterexample is [[3,3]]. Fix the code, not the law, then rerun. ...
UNCOVERED sub (src/math.ts) [coverage]
          no law reaches this exported function; add a law, or a person can mark it @tslaws-exempt and accept
          hint: No law reaches this exported code. Ask a person for a law, ...

4 laws: 1 proved, 1 bounded, 0 tested, 0 open, 1 failed, 0 tampered, 0 errors
```

Each result is `STATUS name (file:line) [method]`, then its detail lines. Every result that is not `proved` ends with a
`hint:`, the next action for an agent. The last line counts the results. `--summary` prints only the results that do not
pass, and `--reporter text|json|junit|github|ndjson` (or `--json`) picks another format: `junit` is JUnit XML, `github`
prints workflow annotations and appends a table to `GITHUB_STEP_SUMMARY`, and `ndjson` streams one JSON event per line for
editors.

| Status      | Meaning                                                                                                                                        |
| ----------- | ---------------------------------------------------------------------------------------------------------------------------------------------- |
| `proved`    | Z3 shows no input makes the law return `false`, with no bound involved.                                                                        |
| `bounded`   | Proved for every input within stated bounds: array length (`--bound`, default 4), loop iterations, recursion depth, `int` values within ±2^26. |
| `tested`    | Property tests found no counterexample in `--runs` inputs (default 200); the code does not lower to the prover. Not a proof.                   |
| `open`      | Declared `law proved …` but not proved for every input (a bounded proof does not count). Fails the check.                                      |
| `failed`    | A counterexample, shrunk to a minimal input, with the seed to reproduce it.                                                                    |
| `uncovered` | Exported code no law reaches. Fails the check.                                                                                                 |
| `tampered`  | A law changed, was added or removed since `tsc-laws.lock` was accepted, or a coverage exemption is not in it. Fails the check.                 |
| `error`     | The law cannot run: not exported, a parameter has no type, no generator for a type, a load failure, or a Z3 crash (see below).                 |

`tslaws check` exits 0 only when every law is `proved`, `bounded` or `tested`, nothing is `uncovered`, the files compile
and the lock matches. Inputs are generated from each parameter's type; register a generator for a type the runner cannot
derive with `arbitrary('UserId', fc.string(...))` (`arbitrary` and `fc` come from `tslaws`).

## Coverage

Every exported function or class in the covered modules must be reached by a law, directly or through the functions the
law calls. The covered modules are the `cover` globs of `tslaws.json`
(`{ "cover": ["src/**/*.ts", "!src/**/*.test.ts"] }`), or, without that file, every project module the laws import.
Coverage follows ES `import`s as well as `require`, including the interop helpers a compiler wraps around them
(`__importStar`, `__importDefault`, `__toESM`), directory index imports (`./dir` -> `./dir/index.js`), barrel re-exports,
and files transformed by `bundlerPlugins`, so code you import with `import x from './y'` counts as reached. Mark
code that needs no law `@tslaws-exempt`; a person accepts the exemption into the lock.

## Levels

A laws file's level comes from its name: `*.browser.laws.ts` runs in a real browser (Chrome, Edge or Chromium, or
`--browser firefox|webkit`) against a live DOM, `*.e2e.laws.ts` drives your running app, and any other `*.laws.ts` runs in
Node. Set `"levels": "imports"` in `tslaws.json` and the level comes from the file's imports instead (`tslaws/browser`,
`tslaws/adapters/*`, `tslaws/e2e`). Browser laws run in parallel isolated `BrowserContext`s on a real local HTTP origin
(with top-level pages by default, or `--browser-mode iframe`, plus `--headed` for interactive debugging), execute
`fast-check` in-browser to avoid per-input IPC, reuse Vite `middlewareMode` when present, and expose Playwright-backed
trusted `user` interactions (`user.click`, `user.fill`, `user.type`, `user.press`, `user.hover`, `user.select`,
`user.setViewport`) and `mock(urlPattern, response)` network interception. Browser laws are `tested`, never `proved`.
Node laws run in a permission sandbox (Node 22.15 or later; `--no-sandbox` opts out), and an end-to-end law needs
`--allow-e2e` because it cannot run inside it. `tslaws list` shows each laws file, its level and whether it is accepted.

## The lock

`tsc-laws.lock` holds a hash of every law and the list of coverage exemptions. A law's hash covers its declaration, the
helpers and generators it reaches, every module its file imports, and the effective `tslaws.json` apart from `github`,
`security` and `levels`, so weakening a helper reads as tampering too. Comments and layout do not.

- A change, an added law, a removed law or a new `@tslaws-exempt` fails the check until a person runs `tslaws accept`. It
  refuses to run without a terminal, under `CI`, or with `TSLAWS_AGENT` set, unless a person lent it with
  `tslaws delegate grant [--for 1h|8h|1d|7d]` (revoke with `delegate revoke`; never under `CI`).
- Agents propose laws in `*.proposed.laws.ts` files (or with `tslaws propose` or the MCP tool) and try them with
  `tslaws check --proposed`. A person moves one into the tree with `tslaws promote`, then accepts.
- `tslaws mcp` serves check, explain, list and propose to agents over MCP. It cannot accept or touch the lock.
- `hooks/claude-hook.mjs` is a Claude Code hook that blocks `git commit` while the check fails; `tslaws init` wires it up.

## Certificates

```sh
npx tslaws check --certify           # or "certify": true in tslaws.json
npx tslaws check --require-certify   # a proof that cvc5 and Carcara cannot certify fails the check
```

For a law Z3 proved, cvc5 writes a proof and Carcara checks it, so a proof is more than a solver's say-so. Loops are
certified through their `invariant`s. Install `cvc5` and `carcara` on the PATH (or set `TSLAWS_CVC5` and `TSLAWS_CARCARA`);
without them a certificate is `unavailable`, which fails the check only with `--require-certify`. Real certificates, with
the command that checks each, are in the
[certificate gallery](https://github.com/Jordan-Hall/tsc-laws/blob/main/docs/certificates/README.md).

### Badges

```sh
npx tslaws badge --certify
```

`tslaws badge [files...] [--out DIR] [--report FILE] [--repo OWNER/NAME] [--branch NAME] [--link URL] [--certify]` checks
the project (or reads a `check --json` report from `--report`), writes the shields.io endpoint files `badge-laws.json` and
`badge-certificates.json` into `badges/` (default; commit them), and prints the markdown that shows them. When a law is
certified it also writes `badges/README.md`, a page of your laws, their status and proof files, which the badges link to.
See [Proof certificates](https://github.com/Jordan-Hall/tsc-laws/blob/main/docs/certificates.md#badges).

## GitHub integration

`tslaws github report|command|merge|verify` accepts laws on GitHub (CI only; configure the `github` section of
`tslaws.json`). A pull request that adds, changes or removes a law is a proposal: `report` runs each one and comments with
what it would be if accepted, `command` records `/tslaws accept` comments, and `merge` writes `tsc-laws.lock` on your
branch after the merge, or on demand from `workflow_dispatch`.

The merge fast path: `merge` compares the laws on the merged code with the lock first, and runs only the laws the lock
does not record (new laws, edited laws, and laws whose dependencies changed). When the lock already records every law,
which is the usual merge, no law runs and nothing is written. Nothing from the pull request counts as proof; the merge
re-proves each law it runs. See
[Accepting laws on GitHub](https://github.com/Jordan-Hall/tsc-laws/blob/main/docs/github.md).

## Bundler plugins

`tslaws.json` `bundlerPlugins` lists esbuild plugin modules (paths relative to the file) that teach tslaws source formats
Node and the browser bundler cannot read, such as `.tsrx`, `.svelte` or `.vue`. Browser laws bundle through them. Node
laws use them too: project source that imports such a file loads it through the plugin, and a relative import from that
file to a project `.ts` module resolves to the compiled twin in `.tslaws/out`, the same copy the law's own imports get.
See [Bundler plugins](https://github.com/Jordan-Hall/tsc-laws/blob/main/docs/laws.md#bundler-plugins).

## The prover

`tslaws` symbolically executes the compiled JavaScript of a law, inlining the project functions it calls (including through
directory imports and barrel re-exports), and asks Z3 for an input that returns `false`; only a failure it can replay in
JavaScript is reported as `failed`. `int` is an exact whole number and `bigint` is exact with no bound. Built-in
refinement types — `nat`, `posInt`, `nonZeroInt`, `intRange<Lo, Hi>`, `nonEmpty<T>`, and `asciiString` — narrow both
generated property inputs and SMT assumptions at the type level. Arrays, loops and recursion unroll up to `--bound` (a
`bounded` result); `invariant(cond)` first in a loop body proves the loop for every iteration count, `decreases(measure)`
checks loop and recursion termination, `lemma(cond)` splits larger proofs into proved subgoals, and `requires(cond)` /
`ensures(cond)` check caller preconditions and postconditions. What does not lower stays `tested`, or a `law proved` is
`open`, with the reason. `TSLAWS_DEBUG=1` keeps each query as an `.smt2` file under `.tslaws/out/smt`.

When native `z3` is installed on the PATH (or via `TSLAWS_Z3`), `tslaws` uses a persistent pooled native Z3 backend
(opt out with `TSLAWS_Z3=wasm`) and caches proved SMT results on disk in `.tslaws/proof-cache.json` keyed by query hash
and solver fingerprint so unchanged checks return in milliseconds.

If the Z3 worker crashes (it throws, runs out of memory or exits), the query is retried twice on a fresh worker. If every
try crashes, the law is an `error` whose message says `the Z3 solver crashed` and why. It is never quietly downgraded to
a bounded proof or a test. A solver that gives up or runs out of time still falls back to a bounded proof or to tests,
and says so.

## Commands

```
tslaws init [--force]
tslaws check [files...] [--reporter ...] [--summary] [--watch] [--certify] [--require-certify] [--runs N] [--seed N] [--bound N] [--browser-mode page|iframe] [--headed] [--proposed] ...
tslaws accept [files...]
tslaws delegate grant|revoke|status
tslaws propose <file.ts>     tslaws promote <proposal>     tslaws list [--json]
tslaws badge [files...] [--certify]
tslaws github report|command|merge|verify
tslaws ui [files...] [--port N] [--no-open] [--tab]
tslaws mutate [files...] [--max N] [--seed N] [--json]
tslaws regressions [list|clear]
tslaws security deps [--offline] [--fail-on LEVEL]
tslaws migrate <source> [files...] [--write]
tslaws mcp
```

Run `tslaws --help` for every flag. `tslaws ui` opens a dashboard (tree, filters, counterexamples, source, live
reruns on save). `tslaws mutate` changes your code in small ways and lists the changes no law notices. Counterexamples are
kept in `.tslaws/regressions` and replayed first on every later run. In a monorepo, run from the root and each project
checks with its own config and lock (`--project`, `--filter`, `--changed`).

## Docs

- [Laws for TypeScript](https://github.com/Jordan-Hall/tsc-laws/blob/main/docs/laws.md): the language, levels, the prover, settings
- [Proof certificates](https://github.com/Jordan-Hall/tsc-laws/blob/main/docs/certificates.md) and the [gallery](https://github.com/Jordan-Hall/tsc-laws/blob/main/docs/certificates/README.md)
- [Accepting laws on GitHub](https://github.com/Jordan-Hall/tsc-laws/blob/main/docs/github.md)
- [tslaws in a monorepo](https://github.com/Jordan-Hall/tsc-laws/blob/main/docs/monorepo.md)
- [Security laws](https://github.com/Jordan-Hall/tsc-laws/blob/main/docs/security-laws.md)
- [Editor law syntax](https://github.com/Jordan-Hall/tsc-laws/blob/main/docs/editor-law-syntax.md)
- [Build from source](https://github.com/Jordan-Hall/tsc-laws#readme): clone the repository and follow its build steps
- [Changelog](https://github.com/Jordan-Hall/tsc-laws/blob/main/CHANGELOG-LAWS.md)
