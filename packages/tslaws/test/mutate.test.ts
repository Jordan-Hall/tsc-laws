// End to end: mutate a tiny project and see whether its laws kill the mutants.
// Needs the built compiler in TSC_LAWS_BIN and `npm run build` for dist/.
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { after, describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';
import { mutantsOf, mutate, renderMutation } from '../dist/mutate.js';

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
});
