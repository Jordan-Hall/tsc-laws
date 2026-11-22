// Every `proved` or `bounded` result names the domain assumptions its proof relied on.
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { after, describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';
import { check, type CheckReport } from '../dist/check.js';
import { readManifest } from '../dist/compile.js';
import { writeLock } from '../dist/lock.js';
import { github, githubSummary } from '../dist/reporters.js';
import { assumptionsFor } from '../dist/smt.js';
import type { CheckOptions, LawResult } from '../dist/types.js';

const compiler = process.env.TSC_LAWS_BIN;
const here = dirname(fileURLToPath(import.meta.url));

const numberText = 'number parameters exclude NaN and ±Infinity';
const intText = 'int parameters stay within ±(2^53 - 1)';

describe('assumptionsFor', () => {
  it('names NaN and the infinities for a number parameter', () => {
    assert.deepEqual(assumptionsFor(['number']), [numberText]);
  });

  it('names the safe-integer range for an int, and nothing once the proof narrowed it', () => {
    assert.deepEqual(assumptionsFor(['int']), [intText]);
    assert.deepEqual(assumptionsFor(['int'], 2n ** 26n), []);
  });

  it('names the BMP and length limits for a string parameter', () => {
    const [text, ...rest] = assumptionsFor(['string']);
    assert.equal(rest.length, 0);
    assert.match(text!, /^string parameters use only characters up to U\+FFFF .* at most 536870888 UTF-16 units$/);
  });

  it('names nothing for boolean, bigint or a type that is not modelled', () => {
    assert.deepEqual(assumptionsFor(['boolean', 'bigint', undefined]), []);
    assert.deepEqual(assumptionsFor([]), []);
  });

  it('leaves arrays to the proof limits but reads their elements', () => {
    assert.deepEqual(assumptionsFor([{ array: 'boolean' }]), []);
    assert.deepEqual(assumptionsFor([{ array: 'number' }]), [numberText]);
    assert.deepEqual(assumptionsFor([{ array: { array: 'int' } }]), [intText]);
  });

  it('reads the fields of a record', () => {
    assert.deepEqual(assumptionsFor([{ fields: { price: 'number', qty: 'int', ok: 'boolean' } }]), [
      numberText,
      intText,
    ]);
  });

  it('lists each assumption once, in order of first use', () => {
    assert.deepEqual(assumptionsFor(['int', 'number', 'int', 'number', { array: 'int' }]), [intText, numberText]);
  });
});

function report(results: LawResult[]): CheckReport {
  return { results, compileDiagnostics: '', compileOk: true, lockMissing: false, notices: [], ok: true };
}

const base = { file: 'src/f.laws.ts', line: 3, method: 'smt' };

describe('assumptions in the reporters', () => {
  const proved: LawResult = { ...base, name: 'p', status: 'proved', assumptions: [numberText] };
  const bounded: LawResult = {
    ...base,
    name: 'b',
    status: 'bounded',
    message: 'holds within bounds: arrays hold at most 4 elements',
    assumptions: [numberText, intText],
  };
  const plain: LawResult = { ...base, name: 'q', status: 'proved' };

  it('puts them in the step-summary Detail cell of a proved and a bounded result', () => {
    const rows = githubSummary(report([proved, bounded, plain])).split('\n');
    assert.ok(rows.some((r) => r.startsWith('| proved | p |') && r.endsWith(`| assuming ${numberText} |`)));
    assert.ok(
      rows.some(
        (r) =>
          r.startsWith('| bounded | b |') &&
          r.endsWith(`| holds within bounds: arrays hold at most 4 elements; assuming ${numberText}; ${intText} |`),
      ),
    );
    assert.ok(rows.includes('| proved | q | src/f.laws.ts:3 | smt |  |'));
  });

  it('adds them to the notice of a bounded result and nothing to a proved one', () => {
    const lines = github(report([proved, bounded, plain])).split('\n');
    const notices = lines.filter((l) => l.startsWith('::notice'));
    assert.equal(notices.length, 1);
    assert.match(
      notices[0]!,
      /title=b bounded::.*assuming number parameters exclude NaN and ±Infinity; int parameters/,
    );
    assert.equal(lines.filter((l) => l.includes('title=p proved') || l.includes('title=q proved')).length, 0);
  });
});

const root = compiler === undefined ? '' : mkdtempSync(join(here, '..', '.tmp-assume-'));

after(() => {
  if (root === '') return;
  rmSync(root, { recursive: true, force: true });
});

const lines = (...l: string[]): string => `${l.join('\n')}\n`;

async function run(name: string, impl: string, laws: string): Promise<LawResult[]> {
  const cwd = join(root, name);
  for (const [file, text] of Object.entries({ 'src/f.ts': impl, 'src/f.laws.ts': laws })) {
    mkdirSync(dirname(join(cwd, file)), { recursive: true });
    writeFileSync(join(cwd, file), text);
  }
  const options: CheckOptions = {
    files: ['src/f.laws.ts'],
    cwd,
    runs: 100,
    compiler: compiler!,
    lockFile: join(cwd, 'tsc-laws.lock'),
    noProve: false,
    bound: 4,
    proofTimeoutMs: 10000,
  };
  writeLock(options.lockFile, readManifest(compiler!, options.files, cwd));
  return (await check(options, true)).results;
}

function byName(results: LawResult[], name: string): LawResult {
  const found = results.find((r) => r.name === name);
  assert.ok(found, `no result for ${name}: ${JSON.stringify(results)}`);
  return found;
}

describe(
  'prover results carry their assumptions',
  { skip: compiler === undefined ? 'set TSC_LAWS_BIN' : false },
  () => {
    it('names only the assumptions that apply to each law', async () => {
      const results = await run(
        'each',
        lines('export const unused = 0;'),
        lines(
          "import { assume } from 'tslaws';",
          "import type { int } from 'tslaws';",
          'export law proved noNaN(x: number) { return !Number.isNaN(x); }',
          'export law proved modRange(x: int) { assume(x >= 0); return x % 7 >= 0 && x % 7 <= 6; }',
          'export law proved sameText(s: string) { return (s + s).length === 2 * s.length; }',
          'export law proved flip(a: boolean) { return (a && !a) === false; }',
          'export law lengthKept(xs: boolean[]) { return xs.map((x) => !x).length === xs.length; }',
          'export law numbersKept(xs: number[]) { return xs.map((x) => x).length === xs.length; }',
        ),
      );
      assert.equal(byName(results, 'noNaN').status, 'proved');
      assert.deepEqual(byName(results, 'noNaN').assumptions, [numberText]);
      const ints = byName(results, 'modRange');
      assert.equal(ints.status, 'proved');
      assert.deepEqual(ints.assumptions, [intText]);
      const text = byName(results, 'sameText');
      assert.equal(text.status, 'proved', JSON.stringify(text));
      assert.equal(text.assumptions?.length, 1);
      assert.match(text.assumptions![0]!, /^string parameters use only characters up to U\+FFFF/);
      const flip = byName(results, 'flip');
      assert.equal(flip.status, 'proved');
      assert.equal('assumptions' in flip, false, JSON.stringify(flip));
      const arr = byName(results, 'lengthKept');
      assert.equal(arr.status, 'bounded', JSON.stringify(arr));
      assert.equal('assumptions' in arr, false, JSON.stringify(arr));
      const nums = byName(results, 'numbersKept');
      assert.equal(nums.status, 'bounded', JSON.stringify(nums));
      assert.deepEqual(nums.assumptions, [numberText]);
    });
  },
);
