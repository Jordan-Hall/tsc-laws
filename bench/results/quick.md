# tslaws benchmark results

Run started 2026-11-05T14:01:08.656Z on Windows_NT 10.0.26300 x64, 13th Gen Intel(R) Core(TM) i7-13850HX (28 logical cores), 63.7 GiB RAM, Node v26.13.0, Chrome 156.0.8078.80.
tslaws 0.3.2 from feat/laws-as-calls at e05a0d2 (1 uncommitted files under packages/tslaws/src and dist).
Pinned: tslaws 0.3.2, vitest 5.1.0, @vitest/browser-playwright 5.1.0, @rstest/core 0.12.6, @playwright/test 1.64.1, playwright 1.64.1, fast-check 4.10.2, typescript 5.9.3.
Parameters: 3 repeats per cell; 100 generated inputs per property test; 5 DOM walk-throughs per browser test; 2 fresh-context click-throughs per e2e test. Seconds are wall time; median and p95 (nearest rank) over the repeats. Peak RSS is peak sum of working sets over the whole process tree (job object, sampled every ~8 ms).

## Unit and property tests, 10 tests

| Tool | Cold median s | Cold p95 s | Warm median s | Warm p95 s | Tests/s cold | Tests/s warm | Peak RSS median MB | Peak RSS p95 MB | Cold vs tslaws | Repeats |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| tslaws check --no-prove | 3.99 | 4.13 | 4.04 | 5.30 | 2.5 | 2.5 | 1518 | 1532 | 1.00x | 3 |
| tslaws check (prover on, default) * | 5.47 | 5.71 | 5.20 | 5.64 | 1.8 | 1.9 | 1774 | 1778 | 1.37x | 3 |
| Vitest | 0.87 | 0.95 | 0.77 | 0.83 | 12 | 13 | 193 | 195 | 0.22x | 3 |
| Rstest | 0.94 | 1.03 | 0.78 | 0.82 | 11 | 13 | 220 | 221 | 0.24x | 3 |

- tslaws check (prover on, default) (*): proves what Z3 can lower instead of running the generated cases.

## Unit tests, example based, 10 tests

| Tool | Cold median s | Cold p95 s | Warm median s | Warm p95 s | Tests/s cold | Tests/s warm | Peak RSS median MB | Peak RSS p95 MB | Cold vs tslaws | Repeats |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| tslaws check --no-prove --runs 1 | 4.38 | 5.30 | 3.89 | 4.07 | 2.3 | 2.6 | 1506 | 1521 | 1.00x | 3 |
| tslaws check, zero-parameter laws | failed | | | | | | | | | 0 |
| Vitest | 0.68 | 0.78 | 0.63 | 0.63 | 15 | 16 | 188 | 188 | 0.16x | 3 |
| Rstest | 0.54 | 0.67 | 0.64 | 0.68 | 18 | 16 | 215 | 215 | 0.12x | 3 |

- tslaws check --no-prove --runs 1: a one-parameter law run once: zero-parameter laws do not run.
- tslaws check, zero-parameter laws fails as the probe expected: error src/ops_0.laws.ts add_0 adds: asyncProperty expects at least two parameters

## Browser tests, 10 tests

| Tool | Cold median s | Cold p95 s | Warm median s | Warm p95 s | Tests/s cold | Tests/s warm | Peak RSS median MB | Peak RSS p95 MB | Cold vs tslaws | Repeats |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| tslaws check --no-prove (browser laws) | 6.87 | 8.47 | 6.58 | 7.94 | 1.5 | 1.5 | 991 | 992 | 1.00x | 3 |
| Vitest browser mode (playwright provider) | 2.13 | 2.18 | 2.14 | 2.57 | 4.7 | 4.7 | 898 | 898 | 0.31x | 3 |
| Playwright Test | 7.50 | 8.56 | 7.62 | 8.33 | 1.3 | 1.3 | 6819 | 7084 | 1.09x | 3 |


## End-to-end tests, 10 tests

| Tool | Cold median s | Cold p95 s | Warm median s | Warm p95 s | Tests/s cold | Tests/s warm | Peak RSS median MB | Peak RSS p95 MB | Cold vs tslaws | Repeats |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| tslaws check --no-prove (e2e laws) | 19.17 | 24.03 | 16.34 | 17.61 | 0.5 | 0.6 | 1029 | 1031 | 1.00x | 3 |
| Playwright Test | 9.75 | 9.76 | 9.84 | 10.61 | 1.0 | 1.0 | 7327 | 7328 | 0.51x | 3 |


## Where tslaws is slower

- Unit and property tests, 10 tests: tslaws is slower or larger than Vitest: cold 3.99 s against 0.87 s (4.6x); warm 4.04 s against 0.77 s (5.2x); peak RSS 1518 MB against 193 MB (7.9x).
- Unit and property tests, 10 tests: tslaws is slower or larger than Rstest: cold 3.99 s against 0.94 s (4.2x); warm 4.04 s against 0.78 s (5.2x); peak RSS 1518 MB against 220 MB (6.9x).
- Unit tests, example based, 10 tests: tslaws is slower or larger than Vitest: cold 4.38 s against 0.68 s (6.4x); warm 3.89 s against 0.63 s (6.2x); peak RSS 1506 MB against 188 MB (8.0x).
- Unit tests, example based, 10 tests: tslaws is slower or larger than Rstest: cold 4.38 s against 0.54 s (8.1x); warm 3.89 s against 0.64 s (6.1x); peak RSS 1506 MB against 215 MB (7.0x).
- Browser tests, 10 tests: tslaws is slower or larger than Vitest browser mode (playwright provider): cold 6.87 s against 2.13 s (3.2x); warm 6.58 s against 2.14 s (3.1x); peak RSS 991 MB against 898 MB (1.1x).
- End-to-end tests, 10 tests: tslaws is slower or larger than Playwright Test: cold 19.17 s against 9.75 s (2.0x); warm 16.34 s against 9.84 s (1.7x).

Cold means the tool's own caches are cleared first; the operating system file cache is not. Warm means a second run after one source file changed, caches kept. Rows marked * do different work and are not like for like.
