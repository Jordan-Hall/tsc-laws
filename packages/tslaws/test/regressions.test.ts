// The regression corpus: serialisation of awkward values, and the save / replay cycle through `check`.
// Needs the built compiler in TSC_LAWS_BIN and `npm run build` for dist/.
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { after, describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';
import { check } from '../dist/check.js';
import {
  clearCorpus,
  decodeExample,
  encodeExample,
  listCorpus,
  loadExamples,
  maxExamples,
  regressionFile,
  regressionMessage,
  saveExample,
} from '../dist/regressions.js';
import type { CheckOptions, LawResult } from '../dist/types.js';

const compiler = process.env.TSC_LAWS_BIN;
const here = dirname(fileURLToPath(import.meta.url));
const root = mkdtempSync(join(here, '..', '.tmp-regress-'));

after(() => {
  rmSync(root, { recursive: true, force: true });
  setTimeout(() => process.exit(process.exitCode ?? 0), 100).unref();
});

function write(dir: string, files: Record<string, string>): void {
  for (const [file, text] of Object.entries(files)) {
    mkdirSync(dirname(join(dir, file)), { recursive: true });
    writeFileSync(join(dir, file), text);
  }
}

function options(cwd: string, extra: Partial<CheckOptions> = {}): CheckOptions {
  return {
    files: ['src/f.laws.ts'],
    cwd,
    runs: 100,
    compiler: compiler!,
    lockFile: join(cwd, 'tsc-laws.lock'),
    noProve: true,
    bound: 4,
    proofTimeoutMs: 5000,
    ...extra,
  };
}

async function resultOf(opts: CheckOptions): Promise<LawResult> {
  const found = (await check(opts, false)).results.find((r) => r.name === 'notMultipleOf97');
  assert.ok(found);
  return found;
}

describe('serialiser', () => {
  it('round-trips the values JSON cannot', () => {
    const args = [
      Number.NaN,
      -0,
      0,
      Infinity,
      -Infinity,
      12345678901234567890n,
      new Date(Date.UTC(2020, 1, 29, 12, 30, 15, 7)),
      new Date(Number.NaN),
      undefined,
      null,
      'a\u0000"quote" 😀',
      [1, [undefined, [-0, 2n]]],
      { a: undefined, nested: { $t: 'number', v: 'NaN', list: [Number.NaN] }, n: null },
    ];
    const decoded = decodeExample(encodeExample(args));
    assert.deepEqual(decoded, args);
    assert.ok(Object.is(decoded[0], Number.NaN));
    assert.ok(Object.is(decoded[1], -0));
    assert.ok(Object.is(decoded[2], 0));
    assert.equal(typeof decoded[5], 'bigint');
    assert.ok(decoded[6] instanceof Date && decoded[6].getTime() === (args[6] as Date).getTime());
    assert.ok(decoded[7] instanceof Date && Number.isNaN((decoded[7] as Date).getTime()));
    assert.ok('a' in (decoded[12] as object));
    // A user object that looks like a tag stays a plain object.
    assert.deepEqual((decoded[12] as { nested: unknown }).nested, (args[12] as { nested: unknown }).nested);
    assert.equal(encodeExample(decoded), encodeExample(args));
  });

  it('refuses values it cannot store', () => {
    assert.throws(() => encodeExample([() => 1]));
    assert.throws(() => encodeExample([new Map()]));
  });
});

describe('corpus files', () => {
  it('keeps at most 20 distinct examples, newest first, and lists and clears them', () => {
    const cwd = join(root, 'files');
    mkdirSync(cwd, { recursive: true });
    for (let i = 0; i < 30; i += 1) assert.ok(saveExample(cwd, 'src/a.laws.ts', 'law', [i]));
    assert.ok(saveExample(cwd, 'src/a.laws.ts', 'law', [25]));
    assert.ok(saveExample(cwd, 'src/b.laws.ts', 'other', [Number.NaN, 1n]));
    assert.equal(saveExample(cwd, 'src/b.laws.ts', 'other', [() => 1]), false);
    const kept = loadExamples(cwd, 'src/a.laws.ts', 'law').map((e) => decodeExample(e)[0]);
    assert.equal(kept.length, maxExamples);
    assert.equal(kept[0], 25);
    assert.equal(new Set(kept).size, maxExamples);
    assert.ok(
      regressionFile(cwd, 'src/a.laws.ts', 'law').replace(/\\/g, '/').endsWith('regressions/src__a.laws.ts/law.json'),
    );
    assert.deepEqual(listCorpus(cwd), [
      { file: 'src/a.laws.ts', law: 'law', count: maxExamples },
      { file: 'src/b.laws.ts', law: 'other', count: 1 },
    ]);
    assert.equal(clearCorpus(cwd), true);
    assert.deepEqual(listCorpus(cwd), []);
    assert.equal(clearCorpus(cwd), false);
  });
});

describe('regressions through check', { skip: compiler === undefined ? 'set TSC_LAWS_BIN' : false }, () => {
  const buggy = 'export const ok = (n: number): boolean => !(n > 0 && n % 97 === 0);\n';
  const fixed = 'export const ok = (n: number): boolean => true;\n';
  const laws = "import { ok } from './f';\nexport law notMultipleOf97(n: number) => ok(n);\n";

  it('saves a counterexample, replays it before the search, and passes once the code is fixed', async () => {
    const cwd = join(root, 'e2e');
    write(cwd, { 'src/f.ts': buggy, 'src/f.laws.ts': laws });
    const file = regressionFile(cwd, 'src/f.laws.ts', 'notMultipleOf97');

    const first = await resultOf(options(cwd, { runs: 3000, seed: 1 }));
    assert.equal(first.status, 'failed');
    assert.ok(!first.message?.includes(regressionMessage), first.message);
    assert.ok(existsSync(file), 'the counterexample is saved');
    assert.deepEqual(listCorpus(cwd), [{ file: 'src/f.laws.ts', law: 'notMultipleOf97', count: 1 }]);
    const stored = loadExamples(cwd, 'src/f.laws.ts', 'notMultipleOf97');
    assert.equal(stored.length, 1);
    const saved = readFileSync(file, 'utf8');

    // One random input would hardly hit a multiple of 97: only the replay can fail this.
    const second = await resultOf(options(cwd, { runs: 1, seed: 987654 }));
    assert.equal(second.status, 'failed');
    assert.match(second.message ?? '', /regression: a previously found counterexample still fails/);
    assert.equal(second.counterexample, first.counterexample);
    assert.equal(readFileSync(file, 'utf8'), saved, 'a replayed example is not saved again');

    // Skipping the corpus: nothing replayed, nothing written.
    const skipped = await resultOf(options(cwd, { runs: 1, seed: 987654, noRegressions: true }));
    assert.equal(skipped.status, 'tested');
    rmSync(join(cwd, '.tslaws', 'regressions'), { recursive: true, force: true });
    const unsaved = await resultOf(options(cwd, { runs: 3000, seed: 1, noRegressions: true }));
    assert.equal(unsaved.status, 'failed');
    assert.equal(existsSync(file), false, '--no-regressions writes nothing');
    saveExample(cwd, 'src/f.laws.ts', 'notMultipleOf97', decodeExample(stored[0]!));

    // Fixed code: the stored example now passes and stays as a guard.
    write(cwd, { 'src/f.ts': fixed });
    const fixedResult = await resultOf(options(cwd, { runs: 1, seed: 987654 }));
    assert.equal(fixedResult.status, 'tested');
    assert.equal(loadExamples(cwd, 'src/f.laws.ts', 'notMultipleOf97').length, 1);
  });
});
