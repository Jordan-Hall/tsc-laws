// A `proved` verdict is checked in plain JavaScript on inputs inside the proved domain.
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { after, describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';
import { check } from '../dist/check.js';
import { readManifest } from '../dist/compile.js';
import { writeLock } from '../dist/lock.js';
import { crossCheck, crossCheckRuns, disagreement, type PropertyOutcome } from '../dist/propertyRun.js';
import type { CheckOptions, LawResult } from '../dist/types.js';

const compiler = process.env.TSC_LAWS_BIN;
const here = dirname(fileURLToPath(import.meta.url));
const root = mkdtempSync(join(here, '..', '.tmp-cross-'));

after(() => {
  rmSync(root, { recursive: true, force: true });
  setTimeout(() => process.exit(process.exitCode ?? 0), 100).unref();
});

const outcome = (extra: Partial<PropertyOutcome>): PropertyOutcome => ({
  failed: false,
  numRuns: 5,
  seed: 7,
  ...extra,
});

describe('crossCheck', () => {
  it('trusts a property run of enough inputs and runs nothing more', async () => {
    let calls = 0;
    const rerun = async (): Promise<PropertyOutcome> => {
      calls += 1;
      return outcome({});
    };
    assert.equal(await crossCheck({ numRuns: crossCheckRuns }, 2, rerun), undefined);
    assert.equal(await crossCheck({ numRuns: 200 }, 1, rerun), undefined);
    assert.equal(calls, 0);
  });

  it('runs nothing for a law without parameters, which one run settles', async () => {
    const rerun = async (): Promise<PropertyOutcome> => assert.fail('no rerun expected');
    assert.equal(await crossCheck({ numRuns: 1 }, 0, rerun), undefined);
  });

  it('tops up a short run to the minimum and finds nothing when it passes', async () => {
    const asked: number[] = [];
    const rerun = async (runs: number): Promise<PropertyOutcome> => {
      asked.push(runs);
      return outcome({ numRuns: runs });
    };
    assert.equal(await crossCheck({ numRuns: 5 }, 1, rerun), undefined);
    assert.deepEqual(asked, [crossCheckRuns]);
  });

  it('returns the failing outcome when the top-up run disagrees', async () => {
    const failing = outcome({ failed: true, counterexample: '[3, 4]', message: 'Property failed by returning false' });
    assert.equal(await crossCheck({ numRuns: 5 }, 2, async () => failing), failing);
  });

  it('does not call a run that discarded everything a disagreement, and passes a timeout on', async () => {
    assert.equal(await crossCheck({ numRuns: 5 }, 1, async () => outcome({ failed: true })), undefined);
    assert.equal(await crossCheck({ numRuns: 5 }, 1, async () => 'timeout'), 'timeout');
  });
});

describe('disagreement', () => {
  it('says the prover said proved, that JavaScript disagrees, and asks for a report', () => {
    const text = disagreement({ message: 'Property failed by returning false' });
    assert.match(text, /the prover said proved but a JavaScript run disagrees \(returned false\)/);
    assert.match(text, /likely a translation bug in the prover, please report it/);
  });

  it('names what a throwing law threw', () => {
    assert.match(disagreement({ message: 'boom' }), /\(threw: boom\)/);
  });
});

function project(name: string, files: Record<string, string>, runs: number): CheckOptions {
  const cwd = join(root, name);
  for (const [file, text] of Object.entries(files)) {
    mkdirSync(dirname(join(cwd, file)), { recursive: true });
    writeFileSync(join(cwd, file), text);
  }
  const options: CheckOptions = {
    files: ['src/f.laws.ts'],
    cwd,
    runs,
    seed: 42,
    compiler: compiler!,
    lockFile: join(cwd, 'tsc-laws.lock'),
    noProve: false,
    bound: 4,
    proofTimeoutMs: 10000,
  };
  writeLock(options.lockFile, readManifest(compiler!, options.files, cwd));
  return options;
}

const lines = (...l: string[]): string => `${l.join('\n')}\n`;

const impl = lines(
  'export function clamp(x: number, lo: number, hi: number): number {',
  '  return Math.min(Math.max(x, lo), hi);',
  '}',
  'export function shout(s: string): string {',
  "  return s + '!';",
  '}',
);

const laws = lines(
  "import { assume } from 'tslaws';",
  "import { clamp, shout } from './f';",
  'export law proved clampWithin(x: number, lo: number, hi: number) {',
  '  assume(lo <= hi);',
  '  const y = clamp(x, lo, hi);',
  '  return y >= lo && y <= hi;',
  '}',
  'export law proved shoutKeepsLength(s: string) {',
  '  return shout(s).length === s.length + 1;',
  '}',
);

function byName(results: LawResult[], name: string): LawResult {
  const found = results.find((r) => r.name === name);
  assert.ok(found, `no result for ${name}: ${JSON.stringify(results)}`);
  return found;
}

describe('proved laws run in JavaScript too', { skip: compiler === undefined ? 'set TSC_LAWS_BIN' : false }, () => {
  for (const runs of [3, 200]) {
    it(`keeps a correct proof proved at --runs ${runs}`, async () => {
      const results = (await check(project(`ok-${runs}`, { 'src/f.ts': impl, 'src/f.laws.ts': laws }, runs), true))
        .results;
      for (const name of ['clampWithin', 'shoutKeepsLength']) {
        const result = byName(results, name);
        assert.equal(result.status, 'proved', JSON.stringify(result));
        assert.equal(result.method, 'smt');
      }
    });
  }

  it('reports a wrong law failed with a counterexample, not proved', async () => {
    const wrong = laws.replace('assume(lo <= hi);', 'assume(true);');
    const results = (await check(project('wrong', { 'src/f.ts': impl, 'src/f.laws.ts': wrong }, 3), true)).results;
    const result = byName(results, 'clampWithin');
    assert.equal(result.status, 'failed', JSON.stringify(result));
    assert.ok(result.counterexample !== undefined);
  });
});
