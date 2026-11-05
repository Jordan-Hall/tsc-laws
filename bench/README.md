# tslaws benchmark

Measures `tslaws check` against the fastest alternative test tools on equivalent work.

| Workload                                                            | tslaws                    | Compared with                                              |
| ------------------------------------------------------------------- | ------------------------- | ---------------------------------------------------------- |
| unit-prop: fast-check property tests, 100 generated inputs per test | `*.laws.ts`, `--runs 100` | Vitest, Rstest                                             |
| unit-example: one assertion per test                                | `*.laws.ts`, `--runs 1`   | Vitest, Rstest                                             |
| browser: the same DOM checks against real Chromium                  | `*.browser.laws.ts`       | Vitest browser mode (playwright provider), Playwright Test |
| e2e: the same click-through against a tiny local server             | `*.e2e.laws.ts`           | Playwright Test                                            |

## Run

```
cd bench && npm install          # bench-only dependencies, pinned; the repo root is untouched
cd .. && npx tsc -p packages/tslaws/tsconfig.json
node bench/run.mjs --quick       # size 10, 3 repeats, every workload
node bench/run.mjs               # sizes 10, 100, 1000, 5 repeats
node bench/run.mjs --workloads unit-prop,e2e --sizes 10,100 --repeats 7 --tools tslaws,vitest
```

Output goes to `bench/results/<name>.json` (every run, every summary, tool versions, environment) and `<name>.md`
(one table per workload and size, plus a "Where tslaws is slower" section). Logs of every child process are in
`bench/.logs/`. The run exits 1 if any non-probe run fails.

Browser workloads use Chrome from Program Files (or `BENCH_CHROME`); the same binary is given to tslaws
(`TSLAWS_BROWSER`), Vitest and Playwright.

## What is measured

- Each tool is a child process started by `run.mjs`; wall time is `process.hrtime` around the spawn to exit.
- Cold: the tool's own caches are cleared (`.tslaws`, `.vite`, `.rstest`, `.cache`, `dist`, reports, and the shared
  caches inside `bench/node_modules`). The operating system file cache is not cleared.
- Warm: a one-shot rerun after one imported source file changed (`// bench-touch: N` is rewritten), caches kept.
  This is not watch mode.
- Tests per second is the workload size divided by wall time.
- Peak RSS (Windows only): `tools/rsswrap.cs` is built to `bin/rsswrap.exe` with the .NET Framework C# compiler. It runs the
  command inside a job object and samples the sum of working sets of every process in the tree (Node workers, browsers,
  servers) about every 8 ms. Elsewhere RSS is not measured. The job is killed at exit, so nothing is left running.
- Median, and p95 by nearest rank, over the repeats. With 3 repeats p95 is the maximum.
- A run only counts if the tool exited 0 and reported exactly the expected number of passing tests.

## Equivalence rules

- Same test count per size: 10, 100, 1000 (50 per file).
- Property tests use the same generators as tslaws (numbers, strings up to 24 characters, arrays up to 8) and the same
  run count (100). Playwright browser tests draw their inputs with `fc.sample` from the same generators.
- Browser tests do 5 walk-throughs of the same widget; e2e tests do 2 fresh-context click-throughs per test.
- tslaws runs with `--no-prove` for the like-for-like row, because by default it proves laws with Z3 instead of
  running the generated cases. The default (prover on) row is shown separately and marked `*`: it does different work.
- Zero-parameter laws are not accepted by this tslaws build ("asyncProperty expects at least two parameters"). The
  `tslaws-zero-param` row is a probe that records that failure; the compared row gives each example law one ignored
  parameter and runs it once.
- Playwright Test uses its own idiom (locators, auto-waiting, workers); Vitest browser and tslaws use in-page DOM calls.
  The checks are the same; the code is what each tool encourages. Competitors are not tuned down: default workers, no
  throttling.
- tslaws needs a `tsc-laws.lock` that only `tslaws accept` normally writes. `lib/lock.mjs` writes it with the same
  `readManifest` and `writeLock` functions, so the bench never runs `accept`.

## Caveats

- Generated projects live in `bench/workloads/` (git-ignored) and are rewritten each run.
- The tslaws build under test is whatever is in `packages/tslaws/dist`. The results record the branch, commit and the
  number of uncommitted files under `packages/tslaws/src` and `dist`; rebuild before a run you intend to publish.
- Timing depends on the machine; a run on another machine is not comparable to a checked-in result.
