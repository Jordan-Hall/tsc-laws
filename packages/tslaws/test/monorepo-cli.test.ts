// `tslaws` at the root of a monorepo: every project runs in turn, headers and a summary, the project flags, the
// commands that run in one project only, and a shared base through `extends`.
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
const scratch = mkdtempSync(join(here, '..', '.tmp-mono-'));
after(() => rmSync(scratch, { recursive: true, force: true }));

const good = 'export const dbl = (a: number): number => a + a;\n';
const goodLaws = [
  "import { dbl } from './f';",
  'export law dblIsTwice(a: number) => Object.is(dbl(a), a * 2);',
  '',
].join('\n');
const badLaws = ["import { dbl } from './f';", 'export law dblShrinks(a: number) => dbl(a) < a;', ''].join('\n');

function repo(files: Record<string, string | object>): string {
  const root = mkdtempSync(join(scratch, 'r-'));
  for (const [file, content] of Object.entries(files)) {
    mkdirSync(dirname(join(root, file)), { recursive: true });
    writeFileSync(join(root, file), typeof content === 'string' ? content : `${JSON.stringify(content, null, 2)}\n`);
  }
  return root;
}

/** Writes the lock a person would have accepted, so the laws are measured rather than refused. */
function accepted(root: string, ...projects: string[]): void {
  for (const project of projects) {
    const dir = join(root, project);
    writeLock(join(dir, 'tsc-laws.lock'), readManifest(compiler!, ['src/f.laws.ts'], dir));
  }
}

function tslaws(cwd: string, ...args: string[]): { status: number | null; stdout: string; stderr: string } {
  const run = spawnSync('node', [bin, ...args], {
    cwd,
    encoding: 'utf8',
    env: { ...process.env, TSC_LAWS_BIN: compiler ?? join(cwd, 'no-compiler-needed') },
  });
  return { status: run.status, stdout: run.stdout, stderr: run.stderr };
}

const fast = ['--no-prove', '--no-regressions'];

/** Two packages under packages/, the second with a law that fails. */
function twoPackages(extra: Record<string, string | object> = {}): string {
  const root = repo({
    'tslaws.json': { projects: ['packages/*'] },
    'packages/a/tslaws.json': {},
    'packages/a/src/f.ts': good,
    'packages/a/src/f.laws.ts': goodLaws,
    'packages/b/tslaws.json': {},
    'packages/b/src/f.ts': good,
    'packages/b/src/f.laws.ts': badLaws,
    ...extra,
  });
  if (compiler !== undefined) accepted(root, 'packages/a', 'packages/b');
  return root;
}

describe('tslaws check at a monorepo root', { skip: compiler === undefined ? 'set TSC_LAWS_BIN' : false }, () => {
  it('runs every project under its own header and names the failure in the summary', () => {
    const root = twoPackages();
    const run = tslaws(root, 'check', ...fast);
    assert.equal(run.status, 1, run.stderr);
    assert.match(run.stdout, /── packages\/a ──/);
    assert.match(run.stdout, /── packages\/b ──/);
    assert.match(run.stdout, /FAILED +dblShrinks/);
    assert.match(run.stdout, /^2 projects, 1 failed \(packages\/b\)$/m);
  });

  it('exits 0 when every project passes', () => {
    const root = twoPackages({ 'packages/b/src/f.laws.ts': goodLaws });
    accepted(root, 'packages/b');
    const run = tslaws(root, 'check', ...fast);
    assert.equal(run.status, 0, run.stdout + run.stderr);
    assert.match(run.stdout, /^2 projects, 0 failed$/m);
  });

  it('runs only the projects named with --project (repeatable, comma lists)', () => {
    const root = twoPackages();
    const one = tslaws(root, 'check', '--project', 'packages/a', ...fast);
    assert.equal(one.status, 0, one.stdout + one.stderr);
    assert.match(one.stdout, /── packages\/a ──/);
    assert.doesNotMatch(one.stdout, /packages\/b/);
    assert.match(one.stdout, /^1 project, 0 failed$/m);
    const both = tslaws(root, 'check', '--project', 'packages/a,packages/b', ...fast);
    assert.equal(both.status, 1);
    assert.match(both.stdout, /^2 projects, 1 failed \(packages\/b\)$/m);
    const twice = tslaws(root, 'check', '--project', './packages/b/', '--project', 'packages/a', ...fast);
    assert.match(twice.stdout, /^2 projects, 1 failed/m);
  });

  it('narrows by path glob with --filter', () => {
    const root = twoPackages();
    const run = tslaws(root, 'check', '--filter', 'packages/b', ...fast);
    assert.equal(run.status, 1);
    assert.doesNotMatch(run.stdout, /packages\/a/);
    assert.match(run.stdout, /^1 project, 1 failed \(packages\/b\)$/m);
    const not = tslaws(root, 'check', '--filter', 'packages/*', '--filter', '!packages/b', ...fast);
    assert.equal(not.status, 0, not.stdout + not.stderr);
    assert.match(not.stdout, /^1 project, 0 failed$/m);
  });

  it('prints one JSON object keyed by project path, and stays valid', () => {
    const root = twoPackages();
    const run = tslaws(root, 'check', '--json', ...fast);
    assert.equal(run.status, 1);
    const keyed = JSON.parse(run.stdout) as Record<string, { ok: boolean }>;
    assert.deepEqual(Object.keys(keyed), ['packages/a', 'packages/b']);
    assert.equal(keyed['packages/a']!.ok, true);
    assert.equal(keyed['packages/b']!.ok, false);
    assert.match(run.stderr, /2 projects, 1 failed \(packages\/b\)/);
  });

  it('tags ndjson lines with their project', () => {
    const root = twoPackages();
    const run = tslaws(root, 'check', '--reporter', 'ndjson', '--project', 'packages/a', ...fast);
    const events = run.stdout
      .split('\n')
      .filter((line) => line.trim() !== '')
      .map((line) => JSON.parse(line) as { project: string; type: string });
    assert.ok(events.length > 1);
    assert.ok(events.every((e) => e.project === 'packages/a'));
    assert.equal(events.at(-1)!.type, 'report');
  });

  it('applies a shared base through extends to every project, its globs relative to each package', () => {
    const root = twoPackages({
      'tslaws.json': { projects: ['packages/*'], runs: 7 },
      'tslaws.base.json': { cover: ['src/**/*.ts', '!src/**/*.laws.ts'] },
      'packages/a/tslaws.json': { extends: '../../tslaws.base.json' },
      'packages/b/tslaws.json': { extends: '../../tslaws.base.json' },
      'packages/b/src/f.laws.ts': goodLaws,
      // Uncovered by any law: only a base that really reaches this package's own src/ can notice.
      'packages/b/src/extra.ts': 'export const triple = (a: number): number => a * 3;\n',
    });
    accepted(root, 'packages/a', 'packages/b');
    const run = tslaws(root, 'check', '--json', ...fast);
    const keyed = JSON.parse(run.stdout) as Record<
      string,
      { ok: boolean; results: { name: string; status: string }[] }
    >;
    assert.equal(keyed['packages/a']!.ok, true, run.stdout);
    assert.equal(keyed['packages/b']!.ok, false, run.stdout);
    assert.ok(
      keyed['packages/b']!.results.some((r) => r.name === 'triple' && r.status === 'uncovered'),
      run.stdout,
    );
    assert.equal(run.status, 1);
  });
});

describe('tslaws at a monorepo root without a compiler', () => {
  it('lists the laws of every project, keyed by path with --json', () => {
    const root = twoPackages();
    const text = tslaws(root, 'list');
    assert.equal(text.status, 0, text.stderr);
    assert.match(
      text.stdout,
      /── packages\/a ──[\s\S]*src\/f\.laws\.ts[\s\S]*── packages\/b ──[\s\S]*src\/f\.laws\.ts/,
    );
    assert.match(text.stdout, /^2 projects, 0 failed$/m);
    const json = tslaws(root, 'list', '--json', '--project', 'packages/b');
    const keyed = JSON.parse(json.stdout) as Record<string, { files: { file: string }[] }>;
    assert.deepEqual(Object.keys(keyed), ['packages/b']);
    assert.equal(keyed['packages/b']!.files[0]!.file, 'src/f.laws.ts');
  });

  it('refuses ui, mcp and init where the choice of project is open, naming --project', () => {
    const root = twoPackages();
    for (const command of ['ui', 'mcp', 'init']) {
      const run = tslaws(root, command);
      assert.equal(run.status, 1, command);
      assert.match(run.stderr, new RegExp(`tslaws ${command} runs in one project and this repository has 2`), command);
      assert.match(run.stderr, /--project <dir> \(packages\/a, packages\/b\)/, command);
    }
  });

  it('runs github over every project from the root, and says when none has a github section', () => {
    const root = twoPackages();
    const run = tslaws(root, 'github', 'report');
    assert.equal(run.status, 1);
    assert.match(run.stderr, /no project here has a "github" section in tslaws\.json/);
  });

  it('runs a one-project command in the project that --project picks, or the only project there is', () => {
    const root = twoPackages();
    const picked = tslaws(root, 'init', '--project', 'packages/a');
    assert.equal(picked.status, 0, picked.stderr);
    assert.match(picked.stdout, /kept +tslaws\.json/);
    const alone = repo({ 'tslaws.json': { projects: ['only'] }, 'only/tslaws.json': {} });
    assert.match(tslaws(alone, 'init').stdout, /kept +tslaws\.json/);
  });

  it('scaffolds the root itself with init --project .', () => {
    const root = repo({
      'package.json': { workspaces: ['packages/*'] },
      'packages/a/tslaws.json': {},
      'packages/b/tslaws.json': {},
    });
    assert.equal(tslaws(root, 'init').status, 1);
    const scaffolded = tslaws(root, 'init', '--project', '.');
    assert.equal(scaffolded.status, 0, scaffolded.stderr);
    assert.match(scaffolded.stdout, /wrote +tslaws\.json/);
  });

  it('says which project was meant when --project or --filter match nothing, in a monorepo or a single project', () => {
    const root = twoPackages();
    const missing = tslaws(root, 'check', '--project', 'packages/zzz');
    assert.equal(missing.status, 1);
    assert.match(missing.stderr, /no project matches --project packages\/zzz; projects: packages\/a, packages\/b/);
    const nothing = tslaws(root, 'list', '--filter', 'apps/*');
    assert.match(nothing.stderr, /no project matches --filter apps\/\*/);
    const single = repo({ 'tslaws.json': {}, 'src/f.laws.ts': goodLaws });
    assert.match(tslaws(single, 'list', '--project', 'packages/a').stderr, /no project matches --project packages\/a/);
    const ok = tslaws(single, 'list', '--project', '.');
    assert.equal(ok.status, 0, ok.stderr);
    assert.match(ok.stdout, /src\/f\.laws\.ts/);
    assert.doesNotMatch(ok.stdout, /──/);
  });

  it('refuses file arguments at a root and junit output, which cannot join several documents', () => {
    const root = twoPackages();
    const files = tslaws(root, 'check', 'src/f.laws.ts');
    assert.equal(files.status, 1);
    assert.match(files.stderr, /name files only inside one project/);
    const junit = tslaws(root, 'check', '--reporter', 'junit');
    assert.equal(junit.status, 1);
    assert.match(junit.stderr, /junit writes one XML document per project/);
  });

  it('does not run the projects again from a root that has laws of its own', () => {
    const root = twoPackages({
      'tslaws.json': { projects: ['packages/*'] },
      'src/f.ts': good,
      'src/f.laws.ts': goodLaws,
    });
    const run = tslaws(root, 'list', '--json');
    const keyed = JSON.parse(run.stdout) as Record<string, { files: { file: string }[] }>;
    assert.deepEqual(Object.keys(keyed), ['.', 'packages/a', 'packages/b']);
    assert.deepEqual(
      keyed['.']!.files.map((f) => f.file),
      ['src/f.laws.ts'],
    );
  });
});
