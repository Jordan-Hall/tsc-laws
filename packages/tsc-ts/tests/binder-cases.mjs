// Shared by the binder test and scripts/bind-corpus.mjs: building the bind driver and
// comparing it with the bind oracle.
import { join, resolve } from 'node:path';
import { repo, run } from './parser-cases.mjs';
import { compileSources } from './temp.mjs';

export const bindOracle = resolve(repo, 'packages/tsgo/dist/bind-oracle');

/** Compiles the bind driver with tsc and returns the command that runs it under Node. */
export function buildBindDriver() {
  const out = compileSources('tsc-ts-bind-', ['drivers/bind.ts']);
  return [process.execPath, '--stack-size=16000', join(out, 'drivers/bind.js')];
}

/** The first differing line of two outputs, or undefined if they're equal. */
export function firstDifference(expected, actual) {
  const a = expected.split('\n');
  const b = actual.split('\n');
  for (let i = 0; i < Math.max(a.length, b.length); i++)
    if (a[i] !== b[i]) return { line: i, expected: a[i], actual: b[i] };
  return undefined;
}

/**
 * Compares binding of one file with `flags`. When the outputs differ, also compares the
 * parse trees, so binder differences can be told from parser ones.
 */
export async function compareBinding(command, path, flags) {
  const [expected, actual] = await Promise.all([run([bindOracle, path, ...flags]), run([...command, path, ...flags])]);
  const ok = expected.code === 0 && actual.code === 0;
  const difference = ok ? firstDifference(expected.stdout.toString(), actual.stdout.toString()) : undefined;
  if (ok && difference === undefined) return { match: true };
  const named = flags.includes('--named') ? ['--named'] : [];
  const [expectedTree, actualTree] = await Promise.all([
    run([bindOracle, path, '--tree', ...named]),
    run([...command, path, '--tree', ...named]),
  ]);
  const parserDiffers =
    expectedTree.code !== 0 ||
    actualTree.code !== 0 ||
    firstDifference(expectedTree.stdout.toString(), actualTree.stdout.toString()) !== undefined;
  return { match: false, parserDiffers, difference, error: actual.stderr.slice(0, 2000) };
}
