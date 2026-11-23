// Loaded into every test file's process (`node --import`): the files run side by side (`--test-concurrency` of the test
// script), so each gets its share of the cores as its CPU budget (src/pool.ts) instead of every file taking all of them.
// A TSLAWS_JOBS already set, by a person running a single file or a CI job, wins.
import { availableParallelism } from 'node:os';

/** How many test files run at once; the same number as `--test-concurrency` in the test script. */
const files = 4;

process.env.TSLAWS_JOBS ??= String(Math.max(1, Math.min(8, Math.floor(availableParallelism() / files))));
