// A run that names laws files compares the lock only for the laws of those files: a locked law in any other file is
// neither removed nor checked. A law removed from a named file still is, and so is one in a full run.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { after, describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';
import { check } from '../dist/check.js';
import { acceptCommand, runDelegateCommand } from '../dist/cli.js';
import { readManifest } from '../dist/compile.js';
import { realRoot } from '../dist/delegation.js';
import { compareLock, lawHash, lawKey, mergeScoped, readLock, scopeOf, writeLock } from '../dist/lock.js';
import type { ManifestLaw } from '../dist/types.js';

const compiler = process.env.TSC_LAWS_BIN;
const here = dirname(fileURLToPath(import.meta.url));
const bin = join(here, '..', 'bin', 'tslaws.js');
const scratch = mkdtempSync(join(here, '..', '.tmp-partial-'));
after(() => rmSync(scratch, { recursive: true, force: true }));

const source = 'export const dbl = (a: number): number => a + a;\n';
const head = "import { dbl } from './f';\n";
const lawA = 'export law dblIsTwice(a: number) => Object.is(dbl(a), a * 2);\n';
const lawA2 = 'export law dblIsSum(a: number) => Object.is(dbl(a), a + a);\n';
const lawB = 'export law dblKeepsParity(a: number) => Object.is(dbl(a), a + a);\n';
const fast = ['--no-prove', '--no-regressions'];

let counter = 0;
function project(files: Record<string, string>): string {
  const root = realRoot(mkdtempSync(join(scratch, `p${(counter += 1)}-`)))!;
  for (const [file, content] of Object.entries(files)) {
    mkdirSync(dirname(join(root, file)), { recursive: true });
    writeFileSync(join(root, file), content);
  }
  return root;
}

/** The lock a person would have accepted for these laws files of `dir`. */
function lock(dir: string, ...files: string[]): void {
  writeLock(join(dir, 'tsc-laws.lock'), readManifest(compiler!, files, dir));
}

function tslaws(cwd: string, ...args: string[]): { status: number | null; stdout: string; stderr: string } {
  const run = spawnSync('node', [bin, ...args], {
    cwd,
    encoding: 'utf8',
    timeout: 300_000,
    killSignal: 'SIGKILL',
    env: { ...process.env, TSC_LAWS_BIN: compiler },
  });
  return { status: run.status, stdout: run.stdout, stderr: run.stderr };
}

const twoFiles = (): string =>
  project({
    'src/f.ts': source,
    'src/a.laws.ts': head + lawA,
    'src/b.laws.ts': head + lawB,
  });

describe('compareLock with a scope', () => {
  const law = (file: string, name: string): ManifestLaw =>
    ({ file, name, text: `export law ${name}() => true;`, proved: false, problems: [] }) as unknown as ManifestLaw;
  const locked = {
    [lawKey('src/a.laws.ts', 'one')]: lawHash(law('src/a.laws.ts', 'one')),
    [lawKey('src/a.laws.ts', 'two')]: 'x',
    [lawKey('src/b.laws.ts', 'three')]: 'y',
  };

  it('reports a removal only for a file in the scope', () => {
    const laws = [law('src/a.laws.ts', 'one')];
    assert.deepEqual(
      compareLock(locked, laws, undefined, scopeOf(['src/a.laws.ts'])).map((v) => `${v.reason} ${v.key}`),
      ['removed src/a.laws.ts::two'],
    );
    assert.deepEqual(
      compareLock(locked, laws).map((v) => v.key),
      ['src/a.laws.ts::two', 'src/b.laws.ts::three'],
      'without a scope every locked law not found is removed',
    );
  });

  it('writes a scoped accept over the files it covered and keeps the lock of the rest', () => {
    const next = {
      laws: { 'src/a.laws.ts::one': 'new' },
      exempt: ['src/f.ts::x'],
      levels: { 'src/a.laws.ts': 'node' },
    };
    const merged = mergeScoped(
      {
        laws: locked,
        exempt: ['src/g.ts::y'],
        levels: { 'src/a.laws.ts': 'node', 'src/b.laws.ts': 'browser' },
        certificates: {
          'src/b.laws.ts::three': { law: 'y', problemHash: 'p', proofHash: 'q', verdictHash: 'r' },
        } as never,
      },
      scopeOf(['src/a.laws.ts']),
      next,
    );
    assert.deepEqual(merged.laws, { 'src/a.laws.ts::one': 'new', 'src/b.laws.ts::three': 'y' });
    assert.deepEqual(merged.levels, { 'src/a.laws.ts': 'node', 'src/b.laws.ts': 'browser' });
    assert.deepEqual([...merged.exempt].sort(), ['src/f.ts::x', 'src/g.ts::y']);
    assert.deepEqual(Object.keys(merged.certificates ?? {}), ['src/b.laws.ts::three']);
  });
});

describe('tslaws check <files>', { skip: compiler === undefined ? 'set TSC_LAWS_BIN' : false }, () => {
  it('passes on the named file and does not call the locked laws of another file removed', () => {
    const dir = twoFiles();
    lock(dir, 'src/a.laws.ts', 'src/b.laws.ts');
    const run = tslaws(dir, 'check', 'src/a.laws.ts', ...fast);
    assert.equal(run.status, 0, run.stdout + run.stderr);
    assert.ok(!/removed/.test(run.stdout + run.stderr), run.stdout);
    assert.ok(!/dblKeepsParity/.test(run.stdout), 'the laws of the other file are not part of the run');
  });

  it('reports a law removed from the named file', () => {
    const dir = project({ 'src/f.ts': source, 'src/a.laws.ts': head + lawA + lawA2, 'src/b.laws.ts': head + lawB });
    lock(dir, 'src/a.laws.ts', 'src/b.laws.ts');
    writeFileSync(join(dir, 'src', 'a.laws.ts'), head + lawA);
    const run = tslaws(dir, 'check', 'src/a.laws.ts', ...fast);
    assert.equal(run.status, 1, run.stdout);
    assert.match(run.stdout, /dblIsSum/);
    assert.match(run.stdout, /removed/);
    assert.ok(!/dblKeepsParity/.test(run.stdout));
  });

  it('still reports the locked laws of a deleted file in a full run', () => {
    const dir = twoFiles();
    lock(dir, 'src/a.laws.ts', 'src/b.laws.ts');
    rmSync(join(dir, 'src', 'b.laws.ts'));
    const run = tslaws(dir, 'check', ...fast);
    assert.equal(run.status, 1, run.stdout);
    assert.match(run.stdout, /dblKeepsParity/);
    assert.match(run.stdout, /removed/);
  });

  it('keeps the JSON report free of removals the run never looked for', () => {
    const dir = twoFiles();
    lock(dir, 'src/a.laws.ts', 'src/b.laws.ts');
    const run = tslaws(dir, 'check', 'src/a.laws.ts', '--json', ...fast);
    assert.equal(run.status, 0, run.stdout + run.stderr);
    const report = JSON.parse(run.stdout) as { ok: boolean; results: { name: string; status: string }[] };
    assert.equal(report.ok, true);
    assert.deepEqual(
      report.results.map((r) => r.name),
      ['dblIsTwice'],
    );
  });

  it('in a monorepo, names files inside one project: its other locked laws are not removed', () => {
    const dir = project({
      'tslaws.json': JSON.stringify({ projects: ['packages/*'] }),
      'packages/a/tslaws.json': '{}',
      'packages/a/src/f.ts': source,
      'packages/a/src/a.laws.ts': head + lawA,
      'packages/a/src/b.laws.ts': head + lawB,
      'packages/b/tslaws.json': '{}',
      'packages/b/src/f.ts': source,
      'packages/b/src/a.laws.ts': head + lawA,
    });
    lock(join(dir, 'packages', 'a'), 'src/a.laws.ts', 'src/b.laws.ts');
    lock(join(dir, 'packages', 'b'), 'src/a.laws.ts');
    const inside = tslaws(join(dir, 'packages', 'a'), 'check', 'src/a.laws.ts', ...fast);
    assert.equal(inside.status, 0, inside.stdout + inside.stderr);
    assert.ok(!/removed/.test(inside.stdout + inside.stderr), inside.stdout);
    // From the root, files across several projects stay refused: a path means one project.
    const root = tslaws(dir, 'check', 'packages/a/src/a.laws.ts', ...fast);
    assert.equal(root.status, 1);
    assert.match(root.stderr, /name files only inside one project/);
  });

  it('the check function leaves out of scope locks alone only when the run is partial', async () => {
    const dir = twoFiles();
    lock(dir, 'src/a.laws.ts', 'src/b.laws.ts');
    const base = {
      files: ['src/a.laws.ts'],
      cwd: dir,
      runs: 20,
      compiler: compiler!,
      lockFile: join(dir, 'tsc-laws.lock'),
      noProve: true,
      bound: 4,
      proofTimeoutMs: 1000,
      noRegressions: true,
    };
    const partial = await check({ ...base, partial: true }, true);
    assert.equal(partial.ok, true, JSON.stringify(partial.results));
    const full = await check(base, true);
    assert.equal(full.ok, false, 'the same files without partial still call the rest removed');
    assert.ok(full.results.some((r) => r.name === 'dblKeepsParity' && r.method === 'lock'));
  });
});

describe('tslaws accept <files>', { skip: compiler === undefined ? 'set TSC_LAWS_BIN' : false }, () => {
  it('records the named file and keeps every lock entry of the others', async () => {
    const dir = twoFiles();
    lock(dir, 'src/a.laws.ts', 'src/b.laws.ts');
    const before = readLock(join(dir, 'tsc-laws.lock'))!;
    // A lock entry for a file that no longer exists is kept too: only a run over it can drop it.
    writeFileSync(
      join(dir, 'tsc-laws.lock'),
      JSON.stringify({ version: 1, laws: { ...before.laws, 'src/gone.laws.ts::old': 'z' }, exempt: [] }),
    );
    writeFileSync(join(dir, 'src', 'a.laws.ts'), head + lawA + lawA2);

    const home = realRoot(mkdtempSync(join(scratch, 'home-')))!;
    let output = '';
    const io = { out: () => {}, err: (t: string) => void (output += t) };
    assert.equal(runDelegateCommand(['grant', '--for', '1h'], dir, { isTTY: true, env: {}, home, ...io }), 0, output);
    const code = await acceptCommand(dir, new Map(), ['src/a.laws.ts'], {
      isTTY: false,
      env: { TSLAWS_AGENT: '1' },
      home,
      ...io,
    });
    assert.equal(code, 0, output);
    const after = readLock(join(dir, 'tsc-laws.lock'))!;
    assert.deepEqual(Object.keys(after.laws).sort(), [
      'src/a.laws.ts::dblIsSum',
      'src/a.laws.ts::dblIsTwice',
      'src/b.laws.ts::dblKeepsParity',
      'src/gone.laws.ts::old',
    ]);
    assert.equal(after.laws['src/b.laws.ts::dblKeepsParity'], before.laws['src/b.laws.ts::dblKeepsParity']);
    assert.ok(
      existsSync(join(dir, 'tsc-laws.lock')) && readFileSync(join(dir, 'tsc-laws.lock'), 'utf8').endsWith('\n'),
    );

    // The next partial check of the other file passes with the entries it kept.
    const run = tslaws(dir, 'check', 'src/b.laws.ts', ...fast);
    assert.equal(run.status, 0, run.stdout + run.stderr);
  });
});
