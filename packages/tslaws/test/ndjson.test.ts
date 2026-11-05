// `tslaws check --reporter ndjson --law NAME`: the stream an editor reads, and the filter it uses to rerun one law.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { after, describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';
import { readManifest } from '../dist/compile.js';
import { writeLock } from '../dist/lock.js';

const compiler = process.env.TSC_LAWS_BIN;
const here = dirname(fileURLToPath(import.meta.url));
const bin = join(here, '..', 'bin', 'tslaws.js');
const root = mkdtempSync(join(here, '..', '.tmp-nd-'));
after(() => rmSync(root, { recursive: true, force: true }));

function project(files: Record<string, string>): string {
  for (const [file, text] of Object.entries(files)) {
    mkdirSync(dirname(join(root, file)), { recursive: true });
    writeFileSync(join(root, file), text);
  }
  return root;
}

function tslaws(args: string[]): { events: Record<string, any>[]; status: number | null; stderr: string } {
  const run = spawnSync('node', [bin, ...args], {
    cwd: root,
    encoding: 'utf8',
    env: { ...process.env, TSC_LAWS_BIN: compiler },
  });
  const events = run.stdout
    .split('\n')
    .filter((line) => line.trim() !== '')
    .map((line) => JSON.parse(line) as Record<string, any>);
  return { events, status: run.status, stderr: run.stderr };
}

describe('check --reporter ndjson', { skip: compiler === undefined ? 'set TSC_LAWS_BIN' : false }, () => {
  project({
    'src/f.ts': 'export const dbl = (a: number): number => a + a;\nexport const bad = (a: number): number => a - 1;\n',
    'src/f.laws.ts': [
      "import { bad, dbl } from './f';",
      'export law dblEven(a: number) => dbl(a) - a === a;',
      'export law badGrows(a: number) => bad(a) > a;',
      '',
    ].join('\n'),
  });

  writeLock(join(root, 'tsc-laws.lock'), readManifest(compiler!, ['src/f.laws.ts'], root));

  it('streams the plan, a start and a result per law, then the report', () => {
    const { events, status } = tslaws([
      'check',
      'src/f.laws.ts',
      '--reporter',
      'ndjson',
      '--no-prove',
      '--no-regressions',
    ]);
    assert.equal(status, 1);
    // Laws run side by side, so the starts may come together; the results still arrive in law order.
    const types = events.map((e) => e.type);
    assert.equal(types[0], 'plan');
    assert.equal(types.at(-1), 'report');
    assert.deepEqual(types.filter((t) => t === 'start').length, 2);
    assert.deepEqual(
      events.filter((e) => e.type === 'result').map((e) => e.result.name),
      ['dblEven', 'badGrows'],
    );
    for (const name of ['dblEven', 'badGrows']) {
      const at = (type: string) => events.findIndex((e) => e.type === type && (e.name ?? e.result?.name) === name);
      assert.ok(at('start') < at('result'), `${name} started before it finished`);
    }
    assert.deepEqual(
      events[0]!.laws.map((l: { name: string }) => l.name),
      ['dblEven', 'badGrows'],
    );
    const failed = events.find((e) => e.type === 'result' && e.result.name === 'badGrows')!;
    assert.equal(failed.result.status, 'failed');
    assert.equal(failed.result.exercises[0].name, 'bad');
    const report = events.at(-1)!;
    assert.equal(report.ok, false);
    assert.equal(report.results.length, 2);
    assert.match(report.results[1].hint, /counterexample/);
  });

  it('runs only the laws named by --law', () => {
    const { events } = tslaws(['check', 'src/f.laws.ts', '--reporter', 'ndjson', '--no-prove', '--law', 'dblEven']);
    const results = events.filter((e) => e.type === 'result').map((e) => e.result.name);
    assert.deepEqual(results, ['dblEven']);
    assert.deepEqual(
      events.at(-1)!.results.map((r: { name: string }) => r.name),
      ['dblEven'],
    );
  });
});
