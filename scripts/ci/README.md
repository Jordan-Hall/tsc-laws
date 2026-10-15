# CI scripts

`.github/workflows/ci.yml` runs in two lanes:

- **Pull requests** run lint and format, the build (which type-checks every source file), a smoke set of short
  tests, and the tests the change selects. Selection reads the diff from the merge base; see the rules at the top of
  `select-tests.mjs`. Changes to CI configuration, build scripts, manifests, the lockfile, `upstream.json`, the
  oracles or a path no rule covers run every test.
- **Pushes to main** (and manual runs) run every test.

Both lanes build once (`build` job) and share the build through an artifact. The tests run in shards packed from
measured durations; the `CI result` job fails when any other job failed, and is the check to require.

`release.yml` builds packages only for a commit whose push run on main succeeded in every job.

| Script              | What it does                                                                                                    |
| ------------------- | --------------------------------------------------------------------------------------------------------------- |
| `units.mjs`         | The test units (test files, parts of the split test files, corpus suites) and shard packing.                    |
| `select-tests.mjs`  | Chooses the units for a change. `node scripts/ci/select-tests.mjs --base origin/main` shows what a branch runs. |
| `run-tests.mjs`     | Runs units, retries a failed unit once, reports flaky passes and quarantined failures separately.               |
| `quarantine.txt`    | Tests that are known to flake: they run, but their failures do not fail the job.                                |
| `coverage-map.mjs`  | Regenerates `coverage-map.json`, which source files and functions each tsc-ts test file runs.                   |
| `durations.json`    | Seconds per unit on a GitHub-hosted runner. `update-durations.mjs` refreshes it from test reports.              |
| `compile-tests.mjs` | Compiles all tsc-ts sources once for the tests (`TSC_TS_TEST_BUILD`).                                           |
| `ci-status.mjs`     | `latest-green` prints the latest main commit with a green CI run; `require-green <sha>` is the release gate.    |

Running a shard locally, after `npm ci`, `npm run fetch:upstream` and
`npx turbo run build build:oracle --filter='!@tsc-ts/web'`:

```sh
node scripts/ci/select-tests.mjs --base origin/main --out plan.json
node scripts/ci/run-tests.mjs --plan plan.json --shard 1/3
```

Regenerate `coverage-map.json` after adding test files or moving code between source files
(`node scripts/ci/coverage-map.mjs`, about 15 minutes on 16 cores). A stale map can leave a test out of a pull
request's selection; the full run on main still runs it.
