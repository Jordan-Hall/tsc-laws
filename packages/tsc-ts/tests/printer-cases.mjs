// Shared by the printer test and scripts/print-corpus.mjs: builds the print driver and compares
// it with the print oracle on batches of files.

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { repo, run } from './parser-cases.mjs';
import { compileSources, tempDir } from './temp.mjs';

export const printOracle = resolve(repo, 'packages/tsgo/dist/print-oracle');

/** Compiles the print driver with tsc and returns the command that runs it under Node. */
export function buildPrintDriver() {
  const out = compileSources('tsc-ts-print-', ['drivers/print.ts']);
  return [process.execPath, '--stack-size=16000', join(out, 'drivers/print.js')];
}

function readResult(dir, i) {
  const out = join(dir, i + '.out');
  return existsSync(out) ? readFileSync(out) : undefined;
}

/**
 * Prints `paths` with the oracle and `command` in batches of `batchSize` across `jobs` processes.
 * Returns the indexes of paths whose output differs; files both printers reject count as matching.
 */
export async function comparePrints(command, paths, flags, jobs, batchSize = 100) {
  const dir = tempDir('tsc-ts-print-out-');
  const batches = [];
  for (let start = 0; start < paths.length; start += batchSize) batches.push(start);
  const failures = [];
  let next = 0;
  const worker = async () => {
    while (next < batches.length) {
      const start = batches[next++];
      const slice = paths.slice(start, start + batchSize);
      const batchDir = join(dir, String(start));
      const expectedDir = join(batchDir, 'expected');
      const actualDir = join(batchDir, 'actual');
      mkdirSync(expectedDir, { recursive: true });
      mkdirSync(actualDir, { recursive: true });
      const list = join(batchDir, 'list');
      writeFileSync(list, slice.join('\n') + '\n');
      await Promise.all([
        run([printOracle, '--batch', list, expectedDir, ...flags]),
        run([...command, '--batch', list, actualDir, ...flags]),
      ]);
      // A crash ends the batch; print the rest one file at a time.
      for (let i = 0; i < slice.length; i++) {
        if (existsSync(join(actualDir, i + '.out')) || existsSync(join(actualDir, i + '.err'))) continue;
        const single = join(batchDir, 'single-' + i);
        writeFileSync(single, slice[i] + '\n');
        const one = join(batchDir, 'one-' + i);
        mkdirSync(one);
        await run([...command, '--batch', single, one, ...flags]);
        const out = readResult(one, 0);
        if (out !== undefined) writeFileSync(join(actualDir, i + '.out'), out);
      }
      for (let i = 0; i < slice.length; i++) {
        const expected = readResult(expectedDir, i);
        const actual = readResult(actualDir, i);
        if (expected === undefined && actual === undefined) continue;
        if (expected === undefined || actual === undefined || !expected.equals(actual)) failures.push(start + i);
      }
    }
  };
  await Promise.all(Array.from({ length: jobs }, worker));
  return failures.sort((a, b) => a - b);
}
