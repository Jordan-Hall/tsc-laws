// End to end: mutate a tiny project and see whether its laws kill the mutants.
// Needs the built compiler in TSC_LAWS_BIN and `npm run build` for dist/.
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { after, describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';
import { readManifest } from '../dist/compile.js';
import { writeLock } from '../dist/lock.js';
import { mutableFiles, mutantsOf, mutate, renderMutation } from '../dist/mutate.js';

const compiler = process.env.TSC_LAWS_BIN;
const here = dirname(fileURLToPath(import.meta.url));
const root = mkdtempSync(join(here, '..', '.tmp-mutate-'));

after(() => {
  rmSync(root, { recursive: true, force: true });
  // Z3's worker threads keep the test process alive.
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

describe('mutantsOf', () => {
  it('generates operator, literal, condition and negation mutants in source order', () => {
    const text =
      'export function f(a: number, b: boolean): number {\n  if (!b && a < 3) { return a + 1; }\n  return 0;\n}\n';
    const found = mutantsOf('f.ts', text).map((m) => `${m.line}:${m.original} -> ${m.mutated}`);
    assert.ok(found.some((s) => s.includes('a < 3 -> a <= 3')));
    assert.ok(found.some((s) => s.includes('&&') && s.includes('||')));
    assert.ok(found.some((s) => s.includes('a + 1 -> a - 1')));
    assert.ok(found.some((s) => s.includes('!b -> b')));
    assert.ok(found.some((s) => s.includes('-> !(')));
    assert.deepEqual(
      mutantsOf('f.ts', text).map((m) => m.line),
      mutantsOf('f.ts', text).map((m) => m.line),
    );
  });
});

describe('mutantsOf JSX', () => {
  it('mutates expressions in .tsx but not JSX text or tag names', () => {
    const text = 'export const A = (p: { n: number }) => <p title="x < y">{p.n > 0 && p.n < 9 ? 1 : 2} a && b</p>;\n';
    const found = mutantsOf('a.tsx', text).map((m) => m.mutated);
    assert.ok(found.some((s) => s.includes('p.n >= 0')));
    assert.ok(found.some((s) => s.includes('||')));
    assert.ok(!found.some((s) => s.includes('a || b')));
    assert.ok(!found.some((s) => s.includes('x <= y')));
    assert.ok(mutantsOf('a.jsx', 'export const B = (p) => <b>{p.n === 1}</b>;\n').length > 0);
  });
});

describe('tslaws mutate', { skip: compiler === undefined ? 'set TSC_LAWS_BIN' : false }, () => {
  const src = 'export function max(a: number, b: number): number {\n  if (a < b) { return b; }\n  return a;\n}\n';

  it('reports survivors when a law is too weak, without touching the source', async () => {
    const cwd = project('weak', {
      'src/m.ts': src,
      'src/m.laws.ts': "import { max } from './m';\nexport law atLeastA(a: number, b: number) => max(a, b) >= a;\n",
    });
    const report = await mutate({ cwd, lawFiles: ['src/m.laws.ts'], compiler: compiler!, max: 40, seed: 1 });
    assert.equal(report.baselineError, undefined);
    assert.ok(report.survived >= 1, JSON.stringify(report.results));
    assert.equal(report.ok, false);
    assert.match(renderMutation(report), /SURVIVED src\/m\.ts:\d+/);
    assert.equal(readFileSync(join(cwd, 'src/m.ts'), 'utf8'), src);
  });

  it('kills every mutant when the law pins the behaviour down', async () => {
    const cwd = project('strong', {
      'src/a.ts': 'export function add(a: number, b: number): number {\n  return a + b;\n}\n',
      'src/a.laws.ts': [
        "import { add } from './a';",
        'export law addIsSum(a: number, b: number) => add(a, b) === a + b;',
        'export law addOne(a: number) => add(a, 1) === a + 1;',
        '',
      ].join('\n'),
    });
    const report = await mutate({ cwd, lawFiles: ['src/a.laws.ts'], compiler: compiler!, max: 40, seed: 1 });
    assert.equal(report.baselineError, undefined);
    assert.ok(report.killed >= 1, JSON.stringify(report.results));
    assert.equal(report.survived, 0, JSON.stringify(report.results));
    assert.equal(report.ok, true);
  });

  const factory = [
    'export function h(tag: string, props: Record<string, string> | null, ...kids: string[]): string {',
    '  return `<${tag}>${kids.join("")}</${tag}>`;',
    '}',
    'declare global {',
    '  namespace JSX {',
    '    type Element = string;',
    '    interface IntrinsicElements { [tag: string]: Record<string, string>; }',
    '  }',
    '}',
    '',
  ].join('\n');

  it('mutates .tsx components with a JSX factory and reports survivors', async () => {
    const cwd = project('tsx', {
      'tslaws.json': JSON.stringify({
        cover: ['src/**/*.ts', 'src/**/*.tsx'],
        compilerOptions: { jsx: 'react', jsxFactory: 'h' },
      }),
      'src/h.ts': factory,
      'src/Badge.tsx': [
        "import { h } from './h';",
        'export function Badge(p: { n: number }): string {',
        "  return <p>{p.n > 0 ? 'pos' : 'neg'}</p>;",
        '}',
        '',
      ].join('\n'),
      'src/ui.laws.ts': [
        "import { Badge } from './Badge';",
        "export law isParagraph(n: number) => Badge({ n }).startsWith('<p>');",
        '',
      ].join('\n'),
    });
    const report = await mutate({ cwd, lawFiles: ['src/ui.laws.ts'], compiler: compiler!, max: 20, seed: 1 });
    assert.equal(report.baselineError, undefined, report.baselineError);
    assert.ok(report.survived >= 1, JSON.stringify(report.results));
    assert.ok(report.results.some((r) => r.file === 'src/Badge.tsx'));
    assert.doesNotMatch(JSON.stringify(report), /cannot find module/i);
  });

  it('passes the baseline and runs mutants in a project with tsc-laws.lock', async () => {
    const cwd = project('locked', {
      'src/m.ts': src,
      'src/m.laws.ts': "import { max } from './m';\nexport law atLeastA(a: number, b: number) => max(a, b) >= a;\n",
    });
    writeLock(join(cwd, 'tsc-laws.lock'), readManifest(compiler!, ['src/m.laws.ts'], cwd));
    const report = await mutate({ cwd, lawFiles: ['src/m.laws.ts'], compiler: compiler!, max: 10, seed: 1 });
    assert.equal(report.baselineError, undefined, report.baselineError);
    assert.ok(report.results.length > 0);
    assert.ok(report.survived >= 1, JSON.stringify(report.results));
  });

  it('with named law files mutates only the sources they reach', async () => {
    const cwd = project('subset', {
      'tslaws.json': JSON.stringify({ cover: ['src/**/*.ts'] }),
      'src/a.ts': 'export function inc(a: number): number {\n  return a + 1;\n}\n',
      'src/b.ts': 'export function dec(a: number): number {\n  return a - 1;\n}\n',
      'src/a.laws.ts': "import { inc } from './a';\nexport law incIsPlusOne(a: number) => inc(a) === a + 1;\n",
      'src/b.laws.ts': "import { dec } from './b';\nexport law decIsMinusOne(a: number) => dec(a) === a - 1;\n",
    });
    assert.deepEqual(mutableFiles(cwd, ['src/a.laws.ts'], true), ['src/a.ts']);
    assert.deepEqual(mutableFiles(cwd, ['src/a.laws.ts']), ['src/a.ts', 'src/b.ts']);
    const report = await mutate({
      cwd,
      lawFiles: ['src/a.laws.ts'],
      lawsNamed: true,
      compiler: compiler!,
      max: 20,
      seed: 1,
    });
    assert.equal(report.baselineError, undefined, report.baselineError);
    assert.ok(report.results.length > 0);
    assert.ok(
      report.results.every((r) => r.file === 'src/a.ts'),
      JSON.stringify(report.results),
    );
  });

  describe('timeouts', () => {
    const slow = {
      'src/s.ts': 'export function id(n: number): number {\n  return n;\n}\n',
      'src/s.laws.ts':
        "import { id } from './s';\nexport law slow(n: number) {\n  const t = Date.now();\n  while (Date.now() - t < 1500) {}\n  return id(n) === n;\n}\n",
    };

    it('takes the property timeout from tslaws.json and names the failing law', async () => {
      const cwd = project('timeout-config', { ...slow, 'tslaws.json': JSON.stringify({ propertyTimeoutMs: 400 }) });
      const report = await mutate({ cwd, lawFiles: ['src/s.laws.ts'], compiler: compiler!, max: 5, runs: 2 });
      assert.match(report.baselineError ?? '', /slow \(src\/s\.laws\.ts:\d+\)/);
      assert.match(report.baselineError ?? '', /raise --proof-timeout or --property-timeout/);
    });

    it('lets an explicit option beat tslaws.json', async () => {
      const cwd = project('timeout-option', { ...slow, 'tslaws.json': JSON.stringify({ propertyTimeoutMs: 400 }) });
      const report = await mutate({
        cwd,
        lawFiles: ['src/s.laws.ts'],
        compiler: compiler!,
        max: 5,
        runs: 2,
        propertyTimeoutMs: 20000,
      });
      assert.equal(report.baselineError, undefined, report.baselineError);
    });
  });
});
