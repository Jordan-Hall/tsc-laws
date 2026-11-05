// Where a law's failure lives in the code it exercises: the declarations a law reaches, their ranges, and the function a
// thrown error's stack names. The first groups need no compiler; the last runs `check` and needs TSC_LAWS_BIN.
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { after, describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';
import { check } from '../dist/check.js';
import { readManifest } from '../dist/compile.js';
import { declarationOf, exercisesOf, frameFunctions, markFailing, Sources } from '../dist/exercises.js';
import { writeLock } from '../dist/lock.js';
import type { CheckOptions, ManifestLaw } from '../dist/types.js';

const here = dirname(fileURLToPath(import.meta.url));
const root = mkdtempSync(join(here, '..', '.tmp-ex-'));
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

/** A manifest law as the compiler reports it, for a law written at `line` of `file`. */
function law(file: string, name: string, line: number, params: string[], text: string): ManifestLaw {
  const body = text.slice(text.indexOf(')') + 1).trim();
  return { file, name, exported: true, proved: false, line, params, body, text, problems: [] };
}

describe('exercisesOf', () => {
  it('finds the function an arrow law names, with the declaration and the reference as ranges', () => {
    const cwd = project('arrow', {
      'src/m.ts': 'export function total(a: number, b: number): number {\n  return a - b;\n}\n',
      'src/m.laws.ts': "import { total } from './m';\nexport law nonNeg(a: number, b: number) => total(a, b) >= 0;\n",
    });
    const found = exercisesOf(
      new Sources(cwd),
      law('src/m.laws.ts', 'nonNeg', 2, ['a', 'b'], 'nonNeg(a: number, b: number) => total(a, b) >= 0;'),
    );
    assert.deepEqual(found, [
      {
        name: 'total',
        declaration: { file: 'src/m.ts', line: 1, column: 17, endLine: 1, endColumn: 22 },
        call: { file: 'src/m.laws.ts', line: 2, column: 44, endLine: 2, endColumn: 49 },
      },
    ]);
  });

  it('finds calls inside a block law on a later line and follows what the callee uses', () => {
    const cwd = project('block', {
      'src/util.ts': 'export const double = (n: number): number => n * 2;\n',
      'src/m.ts':
        "import { double } from './util';\nexport const quad = (n: number): number => double(double(n));\nexport const unused = (): number => 1;\n",
      'src/m.laws.ts': [
        "import { quad } from './m';",
        '',
        'export law grows(n: number) {',
        '  const q = quad(n);',
        '  return q >= n;',
        '}',
        '',
      ].join('\n'),
    });
    const text = 'grows(n: number) {\n  const q = quad(n);\n  return q >= n;\n}';
    const found = exercisesOf(new Sources(cwd), law('src/m.laws.ts', 'grows', 3, ['n'], text));
    assert.deepEqual(
      found.map((e) => [e.name, e.declaration.file, e.call?.line, e.call?.column]),
      [
        ['quad', 'src/m.ts', 4, 13],
        ['double', 'src/util.ts', undefined, undefined],
      ],
    );
  });

  it('resolves namespace imports and re-exports, and ignores law parameters, packages and members', () => {
    const cwd = project('reexport', {
      'src/impl.ts': 'export function area(w: number, h: number): number {\n  return w * h;\n}\n',
      'src/index.ts': "export { area as surface } from './impl';\n",
      'src/other.ts': 'export function area(): number {\n  return 0;\n}\n',
      'src/m.laws.ts': [
        "import * as geo from './index';",
        "import { area } from './other';",
        "import { assume } from 'tslaws';",
        'export law positive(w: number, h: number, area: number) {',
        '  assume(w > 0);',
        '  return geo.surface(w, h) > 0 && area === area && [1].map(Math.abs).length > 0;',
        '}',
        '',
      ].join('\n'),
    });
    const text =
      'positive(w: number, h: number, area: number) {\n  assume(w > 0);\n  return geo.surface(w, h) > 0 && area === area && [1].map(Math.abs).length > 0;\n}';
    const found = exercisesOf(new Sources(cwd), law('src/m.laws.ts', 'positive', 4, ['w', 'h', 'area'], text));
    assert.deepEqual(
      found.map((e) => [e.name, e.declaration.file]),
      [['area', 'src/impl.ts']],
    );
    assert.equal(found[0]?.call?.line, 6);
  });

  it('gives no locations when the law text is not in the file or the file is missing', () => {
    const cwd = project('gone', { 'src/m.laws.ts': 'export law x(a: number) => a === a;\n' });
    assert.deepEqual(exercisesOf(new Sources(cwd), law('src/m.laws.ts', 'y', 1, ['a'], 'y(a: number) => f(a);')), []);
    assert.deepEqual(exercisesOf(new Sources(cwd), law('src/none.laws.ts', 'y', 1, [], 'y() => f();')), []);
  });

  it('says where a function is declared by file and name', () => {
    const cwd = project('decl', {
      'src/m.ts': '/** doc */\nexport const helper = (n: number): number => n;\n',
    });
    assert.deepEqual(declarationOf(new Sources(cwd), 'src/m.ts', 'helper'), {
      file: 'src/m.ts',
      line: 2,
      column: 14,
      endLine: 2,
      endColumn: 20,
    });
    assert.equal(declarationOf(new Sources(cwd), 'src/m.ts', 'nothing'), undefined);
  });
});

describe('the function a stack names', () => {
  const outDir = join('C:', 'w', '.tslaws', 'out');
  const stack = [
    'Error: boom',
    `    at helper (${outDir}/src/m.js:3:11)`,
    `    at Object.parse (${outDir}/src/m.js:9:5)`,
    `    at law (${outDir}/src/m.laws.js:4:12)`,
    '    at node:internal/main:1:1',
  ].join('\n');

  it('lists the project frames, innermost first, by function name', () => {
    assert.deepEqual(frameFunctions(stack, outDir), ['helper', 'parse', 'law']);
  });

  it('marks the innermost frame that is one of the law functions, and none when no frame matches', () => {
    const span = (file: string) => ({ file, line: 1, column: 1, endLine: 1, endColumn: 2 });
    const exercised = [
      { name: 'parse', declaration: span('src/m.ts') },
      { name: 'helper', declaration: span('src/m.ts') },
    ];
    assert.deepEqual(
      markFailing(exercised, stack, outDir).map((e) => [e.name, e.failing]),
      [
        ['parse', undefined],
        ['helper', true],
      ],
    );
    assert.deepEqual(markFailing(exercised, 'Error: x\n    at elsewhere (/other/file.js:1:1)', outDir), exercised);
    assert.deepEqual(markFailing(exercised, undefined, outDir), exercised);
  });
});

const compiler = process.env.TSC_LAWS_BIN;
function options(cwd: string, lawFiles: string[]): CheckOptions {
  return {
    files: lawFiles,
    cwd,
    runs: 100,
    compiler: compiler!,
    lockFile: join(cwd, 'tsc-laws.lock'),
    noProve: false,
    bound: 4,
    proofTimeoutMs: 5000,
  };
}

describe('check reports where a failure lives', { skip: compiler === undefined ? 'set TSC_LAWS_BIN' : false }, () => {
  it('puts the exercised function on a returned-false failure', async () => {
    const cwd = project('check-false', {
      'src/cart.ts': 'export function total(price: number, coupon: number): number {\n  return price - coupon;\n}\n',
      'src/cart.laws.ts':
        "import { total } from './cart';\nexport law nonNeg(price: number, coupon: number) => total(price, coupon) >= 0;\n",
    });
    const opts = options(cwd, ['src/cart.laws.ts']);
    writeLock(opts.lockFile, readManifest(opts.compiler, opts.files, cwd));
    const result = (await check(opts, true)).results.find((r) => r.name === 'nonNeg')!;
    assert.equal(result.status, 'failed');
    assert.equal(result.exercises?.length, 1);
    const [total] = result.exercises!;
    assert.equal(total!.name, 'total');
    assert.deepEqual(total!.declaration, { file: 'src/cart.ts', line: 1, column: 17, endLine: 1, endColumn: 22 });
    assert.equal(total!.call?.file, 'src/cart.laws.ts');
    assert.equal(total!.call?.line, 2);
    assert.equal(total!.failing, undefined, 'a returned false has no stack to name a function');
  });

  it('names the function that threw', async () => {
    const cwd = project('check-throws', {
      'src/parse.ts':
        'export function inner(n: number): number {\n  if (n > 5) throw new Error(`too big ${n}`);\n  return n;\n}\nexport function outer(n: number): number {\n  return inner(n);\n}\nexport function calm(n: number): number {\n  return n;\n}\n',
      'src/parse.laws.ts':
        "import { calm, outer } from './parse';\nexport law fine(n: number) => calm(outer(n)) === n;\n",
    });
    const opts = options(cwd, ['src/parse.laws.ts']);
    writeLock(opts.lockFile, readManifest(opts.compiler, opts.files, cwd));
    const result = (await check(opts, true)).results.find((r) => r.name === 'fine')!;
    assert.equal(result.status, 'failed');
    assert.match(result.message ?? '', /too big/);
    assert.deepEqual(
      result.exercises!.map((e) => [e.name, e.failing]),
      [
        ['calm', undefined],
        ['outer', undefined],
        ['inner', true],
      ],
    );
  });

  it('locates an uncovered function by its declaration line', async () => {
    const cwd = project('check-uncovered', {
      'src/a.ts':
        'export function used(n: number): number {\n  return n;\n}\n\nexport function lonely(n: number): number {\n  return n + 1;\n}\n',
      'src/a.laws.ts': "import { used } from './a';\nexport law same(n: number) => used(n) === n;\n",
    });
    const opts = options(cwd, ['src/a.laws.ts']);
    writeLock(opts.lockFile, readManifest(opts.compiler, opts.files, cwd));
    const report = await check(opts, true);
    const lonely = report.results.find((r) => r.status === 'uncovered' && r.name === 'lonely');
    assert.equal(lonely?.file, 'src/a.ts');
    assert.equal(lonely?.line, 5);
  });
});
