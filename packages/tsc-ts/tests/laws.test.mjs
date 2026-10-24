// `law` declarations: they parse as flagged function declarations, `law` stays an ordinary identifier
// everywhere else, and --laws-manifest lists them with the problems that stop them running.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { after, describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, '..', '..', '..');
const exe = process.platform === 'win32' ? 'tsc.exe' : 'tsc';
const bin = process.env.TSC_TS_BIN ?? join(here, '..', 'dist', exe);
const scriptcLibs = join(root, 'node_modules', '@scriptc');
const dir = mkdtempSync(join(tmpdir(), 'tsc-ts-laws-'));

after(() => rmSync(dir, { recursive: true, force: true }));

function libDir() {
  if (process.env.TSC_TS_LIB_DIR) return process.env.TSC_TS_LIB_DIR;
  for (const entry of existsSync(scriptcLibs) ? ['cli-win32-x64-msvc', 'cli-linux-x64-gnu', 'cli-darwin-arm64', 'cli-darwin-x64', 'cli-linux-arm64-gnu'] : []) {
    const lib = join(scriptcLibs, entry, 'dist', 'lib', 'typescript', 'lib');
    if (existsSync(join(lib, 'lib.d.ts'))) return lib;
  }
  return undefined;
}

const env = { ...process.env, TSC_TS_LIB_DIR: libDir() };

function write(name, text) {
  const file = join(dir, name);
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, text);
  return file;
}

function manifest(name, text) {
  const file = write(name, text);
  const run = spawnSync(bin, ['--laws-manifest', file], { encoding: 'utf8', env });
  return { status: run.status, laws: JSON.parse(run.stdout).laws };
}

function compile(name, text, flags = []) {
  const file = write(name, text);
  const out = join(dir, `${name}.out`);
  const run = spawnSync(
    bin,
    ['--ignoreConfig', '--target', 'es2022', '--module', 'commonjs', '--outDir', out, ...flags, file],
    { encoding: 'utf8', env },
  );
  return { status: run.status, output: `${run.stdout}${run.stderr}`, out };
}

describe('law declarations', { skip: !existsSync(bin) || libDir() === undefined ? 'build the native compiler first' : false }, () => {
  it('parse in block and expression form and emit plain functions', () => {
    const { status, out } = compile(
      'forms.ts',
      [
        'export law blockForm(a: number, b: number) { return a + b === b + a; }',
        'export law exprForm(a: number) => a === a;',
        'export law proved provedForm(a: number) => a + 0 === a;',
        'export law generic<T extends number>(a: T) => a === a;',
        '',
      ].join('\n'),
    );
    assert.equal(status, 0);
    const js = readFileSync(join(out, 'forms.js'), 'utf8');
    assert.match(js, /function blockForm\(a, b\) \{ return a \+ b === b \+ a; \}/);
    assert.match(js, /function exprForm\(a\) \{\s*return a === a;/);
    assert.match(js, /function provedForm\(a\)/);
    assert.match(js, /exports\.exprForm = exprForm/);
  });

  it('type-check their bodies and parameters', () => {
    const { status, output } = compile('bad.ts', 'export law bad(a: string): number { return a; }\n');
    assert.equal(status, 2);
    assert.match(output, /bad\.ts\(1,\d+\): error TS2322/);
  });

  it('emit declarations with their parameter types', () => {
    const { status, out } = compile('decl.ts', 'export law shape(p: { x: number }) => p.x === p.x;\n', ['--declaration']);
    assert.equal(status, 0);
    assert.match(readFileSync(join(out, 'decl.d.ts'), 'utf8'), /export declare function shape\(p: \{\s*x: number;?\s*\}\): boolean;/);
  });

  it('leave `law` an ordinary identifier elsewhere', () => {
    const { status, output } = compile(
      'identifier.ts',
      [
        'declare function law(x: number): number;',
        'declare const proved: number;',
        'export const a = law(1);',
        'export const b = law',
        '(2);',
        'let law2 = 3;',
        'export const o = { law: 1, proved: 2 };',
        'export function f(law: number) { return law + proved; }',
        'export function g() { var law = 1; law = 2; law += 1; return law; }',
        '',
      ].join('\n'),
    );
    assert.equal(output, '');
    assert.equal(status, 0);
  });

  it('are listed with parameters, flags, line and declaration text', () => {
    const { status, laws } = manifest('list.ts', 'const x = 1;\nexport law one(a: number) => a === a;\nexport law proved two(a: number, b: string) { return true; }\n');
    assert.equal(status, 0);
    assert.deepEqual(
      laws.map((l) => [l.name, l.exported, l.proved, l.line, l.params, l.problems]),
      [
        ['one', true, false, 2, ['a'], []],
        ['two', true, true, 3, ['a', 'b'], []],
      ],
    );
    assert.equal(laws[0].text, 'one(a: number) => a === a;');
  });

  it('report problems that stop a law running', () => {
    const { status, laws } = manifest('problems.ts', 'law hidden(a: number) => true;\nexport law untyped(a) => true;\nexport law destructured({ a }: { a: number }) => true;\n');
    assert.equal(status, 1);
    assert.match(laws[0].problems[0], /exported/);
    assert.match(laws[1].problems[0], /type annotation/);
    assert.match(laws[2].problems[0], /plain identifiers/);
  });

  it('are not listed from ordinary code', () => {
    const { status, laws } = manifest('none.ts', 'export function law2() {}\nexport function plain(a: number) { return a; }\n');
    assert.equal(status, 0);
    assert.deepEqual(laws, []);
  });
});
