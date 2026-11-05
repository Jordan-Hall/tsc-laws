// Laws written as `law('name', fn)` calls: lowering keeps lines, flags problems, and the checker gives the same verdicts
// as the `law` keyword. Needs `npm run build` for dist/; uses the built-in compiler, so no TSC_LAWS_BIN.
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { after, describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';
import { check } from '../dist/check.js';
import { readManifest } from '../dist/compile.js';
import { lowerLawFile } from '../dist/lower.js';
import { writeLock } from '../dist/lock.js';
import type { CheckOptions } from '../dist/types.js';

const here = dirname(fileURLToPath(import.meta.url));
const root = mkdtempSync(join(here, '..', '.tmp-'));

after(() => {
  rmSync(root, { recursive: true, force: true });
  setTimeout(() => process.exit(process.exitCode ?? 0), 100).unref();
});

function project(name: string, files: Record<string, string>): string {
  const dir = join(root, name);
  for (const [file, text] of Object.entries(files)) {
    mkdirSync(dirname(join(dir, file)), { recursive: true });
    writeFileSync(join(dir, file), text);
  }
  return dir;
}

function options(cwd: string, files: string[]): CheckOptions {
  return {
    files,
    cwd,
    runs: 100,
    compiler: 'builtin',
    lockFile: join(cwd, 'tsc-laws.lock'),
    noProve: false,
    bound: 4,
    proofTimeoutMs: 5000,
  };
}

describe('lowering law calls', () => {
  it('keeps every line where it was', () => {
    const text = [
      "import { law } from 'tslaws';",
      "law('one',",
      '  (a: number) =>',
      '    a === a,',
      ');',
      '',
      "law.proved('two', async (b: number): Promise<boolean> => {",
      '  return b === b;',
      '});',
    ].join('\n');
    const { text: lowered, laws } = lowerLawFile('x.laws.ts', text);
    assert.equal(lowered.split('\n').length - 1 >= text.split('\n').length - 1, true);
    const at = (needle: string, source: string): number => source.slice(0, source.indexOf(needle)).split('\n').length;
    assert.equal(at('return b === b', lowered), at('return b === b', text));
    assert.equal(at('a === a', lowered), at('a === a', text));
    assert.deepEqual(
      laws.map((l) => [l.name, l.proved, l.line, l.problems]),
      [
        ['one', false, 2, []],
        ['two', true, 7, []],
      ],
    );
  });

  it('flags laws the runner cannot load', () => {
    const { laws } = lowerLawFile(
      'x.laws.ts',
      [
        "law('needs a type', (a) => true);",
        "law('destructured', ({ a }: { a: number }) => true);",
        'law(dynamicName, (a: number) => true);',
        "law('dup', (a: number) => true);",
        "law('dup', (a: number) => true);",
        "law('not a function', 3);",
      ].join('\n'),
    );
    assert.equal(laws[0]!.problems.length, 1);
    assert.match(laws[0]!.problems[0]!, /type annotation/);
    assert.match(laws[1]!.problems[0]!, /plain identifier/);
    assert.match(laws[2]!.problems[0]!, /string literal/);
    assert.match(laws[4]!.problems[0]!, /already a law named/);
    assert.match(laws[5]!.problems[0]!, /function/);
  });
});

describe('checking law calls', () => {
  it('gives the verdicts the keyword syntax gives, with prose names', async () => {
    const cwd = project('verdicts', {
      'src/f.ts': 'export const add = (a: number, b: number): number => a + b;\nexport const keep = (xs: number[]): number[] => xs.slice(1);\n',
      'src/f.laws.ts': [
        "import { law } from 'tslaws';",
        "import { add, keep } from './f';",
        "law.proved('add commutes', (a: number, b: number) => add(a, b) === add(b, a));",
        "law('keep keeps length', (xs: number[]) => keep(xs).length === xs.length);",
      ].join('\n'),
    });
    const opts = options(cwd, ['src/f.laws.ts']);
    writeLock(opts.lockFile, readManifest('builtin', opts.files, cwd));
    const { results, ok } = await check(opts, true);
    const status = Object.fromEntries(results.map((r) => [r.name, r.status]));
    assert.deepEqual(status, { 'add commutes': 'proved', 'keep keeps length': 'failed' });
    assert.equal(ok, false);
    assert.equal(results.find((r) => r.name === 'keep keeps length')!.line, 4);
  });

  it('reports a law that returns something other than a boolean', async () => {
    const cwd = project('badreturn', {
      'src/f.laws.ts': "import { law } from 'tslaws';\nlaw('returns a number', (a: number) => a + 1);\n",
    });
    const opts = options(cwd, ['src/f.laws.ts']);
    writeLock(opts.lockFile, readManifest('builtin', opts.files, cwd));
    const report = await check(opts, true);
    assert.equal(report.compileOk, false);
    assert.match(report.compileDiagnostics, /f\.laws\.ts/);
  });
});
