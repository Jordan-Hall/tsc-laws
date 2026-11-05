// `tslaws migrate`: tests of other frameworks become laws. Every converted file is lowered with the real lowering and
// must have no problems; one converted file is also checked end to end in a temporary project with the built-in compiler.
import assert from 'node:assert/strict';
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { after, describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';
import { check } from '../dist/check.js';
import { readManifest } from '../dist/compile.js';
import { writeLock } from '../dist/lock.js';
import type { CheckOptions } from '../dist/types.js';
import { main } from '../src/cli.ts';
import { lowerLawFile } from '../src/lower.ts';
import { migrate } from '../src/migrate/index.ts';
import type { Entry, FileResult } from '../src/migrate/report.ts';
import { sources, type SourceName } from '../src/migrate/framework.ts';

const here = dirname(fileURLToPath(import.meta.url));
const fixtures = join(here, 'fixtures', 'migrate');
const root = mkdtempSync(join(here, '..', '.tmp-migrate-'));

after(() => {
  rmSync(root, { recursive: true, force: true });
  setTimeout(() => process.exit(process.exitCode ?? 0), 100).unref();
});

function convert(from: SourceName, dir: string): FileResult[] {
  return migrate({ cwd: fixtures, from, files: [dir], write: false }).files;
}

/** The converted file, lowered: its laws, with every problem the lowering finds listed. */
function lowered(file: FileResult): { names: string[]; problems: string[] } {
  assert.ok(file.output !== undefined && file.target !== undefined, `${file.source} produced no file`);
  const { laws } = lowerLawFile(file.target, file.output);
  return { names: laws.map((l) => l.name), problems: laws.flatMap((l) => l.problems) };
}

function only(files: FileResult[], source: string): FileResult {
  const file = files.find((f) => f.source.endsWith(source));
  assert.ok(file, `${source} was not converted`);
  return file;
}

const at = (entries: Entry[], kind: Entry['kind']): string[] =>
  entries.filter((e) => e.kind === kind).map((e) => `${e.line} ${e.message}`);

describe('migrating from the test frameworks', () => {
  it('knows every source the brief names', () => {
    assert.deepEqual([...sources], ['vitest', 'jest', 'rstest', 'bun', 'node', 'fast-check', 'playwright']);
  });

  it('turns vitest tests into zero-parameter laws named by their describes', () => {
    const file = only(convert('vitest', 'vitest'), 'cart.test.ts');
    const { names, problems } = lowered(file);
    assert.deepEqual(problems, []);
    assert.deepEqual(names, [
      'cart > adds up the prices',
      'cart > when empty > is zero',
      'cart > keeps the focus note',
      'adds 1 and 2 to give 3',
      'adds 2 and 2 to give 4',
      'template 1 + 1 = 2',
      'template 2 + 3 = 5',
      'has a timeout',
      'is plainly true',
    ]);
    assert.equal(file.target, 'vitest/cart.laws.ts');
    const out = file.output!;
    assert.match(
      out,
      /^import \{ law \} from 'tslaws';\nimport \{ expect \} from 'vitest';\nimport \{ total \} from '\.\/cart';/,
    );
    assert.doesNotMatch(out, /\bdescribe\b|\bbeforeEach\b|\bit\(/);
    // The expect call is kept as written, and the hooks sit around it.
    assert.match(
      out,
      /law\('cart > adds up the prices', \(\) => \{\n {2}let items: number\[\] = \[\];\n {2}items = \[\.\.\.prices\];\n {2}try \{\n {4}expect\(total\(items\)\)\.toBe\(7\);\n {2}\} finally \{\n {4}items = \[\];\n {2}\}\n\}\);/,
    );
    // An inner beforeEach follows the outer one; the async body makes an async law.
    assert.match(
      out,
      /law\('cart > when empty > is zero', async \(\) => \{[\s\S]*items = \[\.\.\.prices\];[\s\S]*items = \[\];\n {4}await Promise\.resolve\(\);/,
    );
    // Rows of a table become constants named like the callback's parameters.
    assert.match(
      out,
      /law\('adds 1 and 2 to give 3', \(\) => \{\n {2}const a = 1;\n {2}const b = 2;\n {2}const sum = 3;\n/,
    );
    assert.match(out, /const \{ a, b, sum \} = \{ a: 1, b: 1, sum: 2 \};/);
  });

  it('reports skipped, todo and only tests with their lines, and writes no law for the skipped', () => {
    const file = only(convert('vitest', 'vitest'), 'cart.test.ts');
    assert.deepEqual(at(file.entries, 'skipped'), [
      '31 skip: "cart > when empty > is negative on Tuesdays"',
      '35 todo: "cart > when empty > handles refunds"',
    ]);
    assert.deepEqual(at(file.entries, 'note'), [
      '38 only on "cart > keeps the focus note": the focus is dropped, every law runs',
      '58 "has a timeout": timeout not kept (a law takes its limits from tslaws.json and the command line)',
    ]);
    assert.deepEqual(at(file.entries, 'unconverted'), []);
    assert.doesNotMatch(file.output!, /Tuesdays|refunds/);
  });

  it('converts jest, rstest, bun and node:test the same way and keeps their own expect', () => {
    const jest = only(convert('jest', 'jest'), 'strings.test.ts');
    assert.deepEqual(lowered(jest), { names: ['strings > shouts', 'strings > spies'], problems: [] });
    assert.match(jest.output!, /import \{ expect, jest \} from '@jest\/globals';/);
    assert.deepEqual(at(jest.entries, 'skipped'), ['15 skip: "strings > is disabled"']);

    const rstest = only(convert('rstest', 'rstest'), 'list.test.ts');
    assert.deepEqual(lowered(rstest), { names: ['list > has three items', 'list > reverses'], problems: [] });
    assert.match(rstest.output!, /import \{ expect \} from '@rstest\/core';/);
    assert.match(rstest.output!, /list = \[1, 2, 3\];\n {2}expect\(list\.length\)/);

    const bun = only(convert('bun', 'bun'), 'math.test.ts');
    assert.deepEqual(lowered(bun), { names: ['math > adds'], problems: [] });
    assert.match(bun.output!, /import \{ expect \} from 'bun:test';/);
    assert.deepEqual(at(bun.entries, 'skipped'), ['8 todo: "math > divides by zero"', '10 skip: "math > multiplies"']);

    const node = only(convert('node', 'node'), 'sum.test.ts');
    assert.deepEqual(lowered(node), { names: ['sum > adds to the base', 'sum > is commutative'], problems: [] });
    assert.match(node.output!, /import assert from 'node:assert\/strict';/);
    assert.doesNotMatch(node.output!, /node:test/);
    assert.deepEqual(at(node.entries, 'skipped'), ['20 todo: "sum > is not written yet"']);
    // node:test's `before` runs once, so inlining it changes when it runs.
    assert.deepEqual(at(node.entries, 'note'), ['7 before now runs in front of every law instead of once']);
  });

  it('imports expect for a file that relies on the framework globals', () => {
    const file = only(convert('vitest', 'globals'), 'math.test.ts');
    assert.deepEqual(lowered(file), {
      names: ['globals > uses the global expect', 'globals > shares set-up'],
      problems: [],
    });
    assert.match(file.output!, /import \{ expect \} from 'vitest';/);
    assert.match(file.output!, /law\('globals > shares set-up', \(\) => \{\n {2}const label = 'shared';/);
  });

  it('gives fast-check properties typed parameters when every arbitrary maps', () => {
    const files = convert('fast-check', 'fast-check');
    const file = only(files, 'props.test.ts');
    const { names, problems } = lowered(file);
    assert.deepEqual(problems, []);
    assert.equal(names.length, 7);
    const out = file.output!;
    assert.match(out, /^import \{ law, assume, type int \} from 'tslaws';/);
    assert.match(
      out,
      /law\('properties > addition commutes', \(a: int, b: int\) => \{\n {2}assert\.equal\(a \+ b, b \+ a\);\n\}\);/,
    );
    assert.match(out, /\(n: int\) => \{\n {2}assume\(n >= 0\);\n {2}return n >= 0;/);
    assert.match(out, /\(n: int\) => \{\n {2}assume\(n >= 1 && n <= 10\);/);
    assert.match(out, /\(s: string, flag: boolean, xs: int\[\]\) =>/);
    assert.match(out, /\(x: number\) => \{\n {2}assume\(!Number\.isNaN\(x\)\);/);
    // fc.pre becomes assume.
    assert.match(out, /\(n: int\) => \{\n {2}assume\(n !== 0\);\n {2}return n \* n > 0;/);
    // fc.record has no tslaws type: the property stays as it was in a law with no parameters, and the report says so.
    assert.match(
      out,
      /law\('properties > records have no tslaws type', \(\) => \{\n {2}fc\.assert\(fc\.property\(fc\.record/,
    );
    assert.deepEqual(at(file.entries, 'unconverted'), [
      '37 fc.assert kept as it is in a zero-parameter law: fc.record(...) has no tslaws type',
    ]);
  });

  it('converts it.prop of @fast-check/vitest, including a named object of arbitraries', () => {
    const file = only(convert('fast-check', 'fast-check'), 'prop.test.ts');
    assert.deepEqual(lowered(file), { names: ['multiplication commutes', 'named arbitraries'], problems: [] });
    assert.match(
      file.output!,
      /law\('multiplication commutes', \(a: int, b: int\) => \{\n {2}expect\(a \* b\)\.toBe\(b \* a\);/,
    );
    assert.match(file.output!, /law\('named arbitraries', \(n: int\) => \{\n {2}assume\(n >= 0\);/);
    assert.deepEqual(file.entries, []);
  });

  it('writes Playwright tests as end-to-end laws and reports what has no counterpart', () => {
    const file = only(convert('playwright', 'playwright'), 'login.spec.ts');
    assert.equal(file.target, 'playwright/login.browser.laws.ts');
    assert.deepEqual(lowered(file), { names: ['login > shows the form', 'login > signs in'], problems: [] });
    const out = file.output!;
    assert.match(out, /import \* as e2e from 'tslaws\/e2e';/);
    assert.match(out, /import \{ expect \} from '@playwright\/test';/);
    assert.match(
      out,
      /law\('login > shows the form', async \(\) => \{\n {2}const page = e2e\.page\(\);\n {2}await e2e\.open\('\/login'\);/,
    );
    assert.match(out, /const context = e2e\.context\(\);/);
    assert.deepEqual(at(file.entries, 'skipped'), ['23 skip: "login > is flaky"']);
    assert.deepEqual(at(file.entries, 'unconverted').sort(), [
      '18 "login > needs an api request": the fixture request has no counterpart in a law (only page, context and baseURL do)',
      '28 test.use(...) configures the Playwright runner and has no equivalent in a law; set it in tslaws.json or in the test',
    ]);
  });

  it('only picks up files of the framework when it searches', () => {
    const jest = migrate({ cwd: fixtures, from: 'jest', files: [], write: false }).files.map((f) => f.source);
    // A file that imports no test framework is read as using the globals of vitest, jest and rstest.
    assert.deepEqual(jest, ['globals/math.test.ts', 'jest/strings.test.ts']);
    const playwright = migrate({ cwd: fixtures, from: 'playwright', files: [], write: false }).files.map(
      (f) => f.source,
    );
    assert.deepEqual(playwright, ['playwright/login.spec.ts']);
  });

  it('explains what could not be turned into laws instead of guessing', () => {
    const dir = join(root, 'unsupported');
    mkdirSync(dir, { recursive: true });
    writeFileSync(
      join(dir, 'odd.test.ts'),
      [
        "import { describe, expect, it, test } from 'vitest';",
        "import { value } from './value';",
        '',
        'const table = [[1], [2]];',
        "describe.each(table)('outer %i', (n) => {",
        "  it('uses the row', () => { expect(n).toBe(n); });",
        '});',
        "test.each(table)('rows from a variable %i', (n) => { expect(n).toBe(n); });",
        "it.fails('is expected to fail', () => { expect(1).toBe(2); });",
        "it.runIf(process.env.CI)('only on CI', () => { expect(value).toBe(1); });",
        "it('keeps working', () => { expect(value).toBe(1); });",
        "for (const name of ['a', 'b']) {",
        '  it(`loop ${name}`, () => { expect(name).toBe(name); });',
        '}',
        '',
      ].join('\n'),
    );
    const report = migrate({ cwd: root, from: 'vitest', files: ['unsupported/odd.test.ts'], write: false });
    const file = report.files[0]!;
    assert.deepEqual(lowered(file).names, ['keeps working']);
    assert.deepEqual(at(file.entries, 'unconverted'), [
      '5 describe.each is not converted; its tests have no laws',
      '8 "rows from a variable %i": the table is not an array written in the file, so its rows cannot be listed',
      '9 "is expected to fail" is expected to fail, which a law cannot express',
      '10 test.runIf(...) chooses at run time; "only on CI" has no law',
      '12 tests declared inside a loop, condition or function are not converted; write them out as laws',
    ]);
  });

  describe('writing', () => {
    it('is a dry run by default and writes nothing', () => {
      const dir = join(root, 'dry');
      cpSync(join(fixtures, 'vitest'), dir, { recursive: true });
      const report = migrate({ cwd: root, from: 'vitest', files: ['dry'], write: false });
      assert.equal(report.files[0]!.written, 'dry-run');
      assert.equal(existsSync(join(dir, 'cart.laws.ts')), false);
    });

    it('writes next to the source with --write, never overwrites, and never touches the lock', () => {
      const dir = join(root, 'write');
      cpSync(join(fixtures, 'vitest'), dir, { recursive: true });
      const first = migrate({ cwd: root, from: 'vitest', files: ['write'], write: true });
      assert.equal(first.files[0]!.written, 'written');
      const target = join(dir, 'cart.laws.ts');
      assert.equal(readFileSync(target, 'utf8'), first.files[0]!.output);
      assert.equal(existsSync(join(root, 'tsc-laws.lock')), false);
      writeFileSync(target, '// edited by a person\n');
      const second = migrate({ cwd: root, from: 'vitest', files: ['write'], write: true });
      assert.equal(second.files[0]!.written, 'exists');
      assert.equal(readFileSync(target, 'utf8'), '// edited by a person\n');
      assert.equal(existsSync(join(dir, 'cart.test.ts')), true);
    });

    it('writes under --out and points the relative imports at the source', () => {
      const dir = join(root, 'out');
      cpSync(join(fixtures, 'vitest'), join(dir, 'src', 'vitest'), { recursive: true });
      const report = migrate({ cwd: dir, from: 'vitest', files: ['src/vitest'], write: true, out: 'laws' });
      const file = report.files[0]!;
      assert.equal(file.target, 'laws/src/vitest/cart.laws.ts');
      assert.equal(existsSync(join(dir, 'src', 'vitest', 'cart.laws.ts')), false);
      assert.match(
        readFileSync(join(dir, 'laws', 'src', 'vitest', 'cart.laws.ts'), 'utf8'),
        /from '\.\.\/\.\.\/\.\.\/src\/vitest\/cart'/,
      );
    });

    it('is reached through the command line', async () => {
      const dir = join(root, 'cli');
      cpSync(join(fixtures, 'jest'), join(dir, 'jest'), { recursive: true });
      const before = process.cwd();
      const write = process.stdout.write.bind(process.stdout);
      let printed = '';
      process.stdout.write = ((chunk: string | Uint8Array): boolean => {
        printed += String(chunk);
        return true;
      }) as typeof process.stdout.write;
      let status: number;
      try {
        process.chdir(dir);
        status = await main(['migrate', 'jest', 'jest']);
      } finally {
        process.chdir(before);
        process.stdout.write = write;
      }
      assert.equal(status, 0);
      assert.match(printed, /dry run: nothing is written/);
      assert.match(printed, /jest\/strings\.test\.ts -> jest\/strings\.laws\.ts: 2 laws \(1 skipped\)/);
      assert.match(
        printed,
        /Skipped, no law written \(1\):\n {2}jest\/strings\.test\.ts:15 skip: "strings > is disabled"/,
      );
      assert.match(printed, /not in tsc-laws\.lock/);
      assert.equal(existsSync(join(dir, 'jest', 'strings.laws.ts')), false);
    });
  });

  describe('checking what was written', () => {
    it('runs a converted file through check with the built-in compiler', async () => {
      const cwd = join(root, 'checked');
      mkdirSync(join(cwd, 'src'), { recursive: true });
      writeFileSync(
        join(cwd, 'src', 'ops.ts'),
        'export const add = (a: number, b: number): number => a + b;\nexport const double = (a: number): number => a * 2;\n',
      );
      writeFileSync(
        join(cwd, 'src', 'ops.test.ts'),
        [
          "import assert from 'node:assert/strict';",
          "import { beforeEach, describe, it } from 'node:test';",
          "import * as fc from 'fast-check';",
          "import { add, double } from './ops';",
          '',
          "describe('ops', () => {",
          '  let seed = 0;',
          '  beforeEach(() => {',
          '    seed = 2;',
          '  });',
          '',
          "  it('add commutes with the seed', () => {",
          '    fc.assert(fc.property(fc.integer(), (a) => add(a, seed) === add(seed, a)));',
          '  });',
          '',
          "  it('double of a natural is not smaller', () => {",
          '    fc.assert(fc.property(fc.nat(), (n) => double(n) >= n));',
          '  });',
          '',
          "  it('double is the identity, wrongly', () => {",
          '    fc.assert(fc.property(fc.integer(), (n) => double(n) === n));',
          '  });',
          '});',
          '',
        ].join('\n'),
      );
      const report = migrate({ cwd, from: 'node', files: ['src/ops.test.ts'], write: true });
      assert.equal(report.files[0]!.written, 'written');
      const file = join(cwd, 'src', 'ops.laws.ts');
      assert.deepEqual(
        lowerLawFile('src/ops.laws.ts', readFileSync(file, 'utf8')).laws.flatMap((l) => l.problems),
        [],
      );
      const opts: CheckOptions = {
        files: ['src/ops.laws.ts'],
        cwd,
        runs: 100,
        compiler: 'builtin',
        lockFile: join(cwd, 'tsc-laws.lock'),
        noProve: true,
        // Law names such as `ops > double` are not valid file names on Windows, where the corpus keeps one file per law.
        noRegressions: true,
        bound: 4,
        proofTimeoutMs: 5000,
      };
      // The temporary project's own lock, written here: no accept, and no lock of a real project.
      writeLock(opts.lockFile, readManifest('builtin', opts.files, cwd));
      const result = await check(opts, true);
      assert.equal(result.compileOk, true, result.compileDiagnostics);
      const status = Object.fromEntries(result.results.map((r) => [r.name, r.status]));
      assert.deepEqual(
        status,
        {
          'ops > add commutes with the seed': 'tested',
          'ops > double of a natural is not smaller': 'tested',
          'ops > double is the identity, wrongly': 'failed',
        },
        JSON.stringify(result.results.map((r) => r.message)),
      );
    });
  });
});
