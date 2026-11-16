// `--changed <ref>`: which projects a change reaches in a git repository with a workspace graph, and how the CLI uses it.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { after, describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';
import { affectedProjects, changedSince } from '../dist/projects.js';

const bin = join(dirname(fileURLToPath(import.meta.url)), '..', 'bin', 'tslaws.js');
const temps: string[] = [];
after(() => {
  for (const dir of temps) rmSync(dir, { recursive: true, force: true });
});

function git(cwd: string, ...args: string[]): string {
  const run = spawnSync(
    'git',
    ['-c', 'user.name=t', '-c', 'user.email=t@example.com', '-c', 'commit.gpgsign=false', ...args],
    { cwd, encoding: 'utf8' },
  );
  assert.equal(run.status, 0, `git ${args.join(' ')}: ${run.stderr}`);
  return run.stdout;
}

function write(root: string, files: Record<string, unknown>): void {
  for (const [path, content] of Object.entries(files)) {
    mkdirSync(dirname(join(root, path)), { recursive: true });
    writeFileSync(join(root, path), typeof content === 'string' ? content : `${JSON.stringify(content, null, 2)}\n`);
  }
}

const pkg = (name: string, deps: Record<string, string> = {}, extra: Record<string, unknown> = {}) => ({
  name,
  version: '1.0.0',
  ...extra,
  dependencies: deps,
});

/**
 * A workspace, committed on `main`:
 *   shared <- app <- web        (package.json dependencies, so web depends on shared through app)
 *   shared <- viz               (tsconfig `paths` only, no dependency listed)
 *   util <- tool                (util has no tslaws.json: it is a package, not a project)
 *   leaf                        (depends on nothing)
 *   ext                         (its tslaws.json extends tslaws.base.json at the root)
 */
function workspace(): string {
  const root = mkdtempSync(join(tmpdir(), 'tslaws-changed-'));
  temps.push(root);
  write(root, {
    'package.json': { name: 'root', private: true, workspaces: ['packages/*'] },
    'tslaws.json': { projects: ['packages/*'] },
    'tslaws.base.json': { runs: 50 },
    'tsconfig.base.json': { compilerOptions: { strict: true } },
    'README.md': 'docs\n',
    '.gitignore': 'dist/\n',
    'packages/shared/package.json': pkg('@w/shared'),
    'packages/shared/tslaws.json': {},
    'packages/shared/src/s.ts': 'export const s = 1;\n',
    'packages/app/package.json': pkg('@w/app', { '@w/shared': '*' }),
    'packages/app/tslaws.json': {},
    'packages/app/src/a.ts': 'export const a = 1;\n',
    'packages/web/package.json': pkg('@w/web', { '@w/app': '*' }),
    'packages/web/tslaws.json': {},
    'packages/web/src/w.ts': 'export const w = 1;\n',
    'packages/viz/package.json': pkg('@w/viz'),
    'packages/viz/tslaws.json': {},
    'packages/viz/tsconfig.json': { compilerOptions: { paths: { '@s/*': ['../shared/src/*'] } } },
    'packages/util/package.json': pkg('@w/util'),
    'packages/util/src/u.ts': 'export const u = 1;\n',
    'packages/tool/package.json': pkg('@w/tool', {}, { devDependencies: { '@w/util': '*' } }),
    'packages/tool/tslaws.json': {},
    'packages/leaf/package.json': pkg('@w/leaf'),
    'packages/leaf/tslaws.json': {},
    'packages/leaf/src/l.ts': 'export const l = 1;\n',
    'packages/ext/package.json': pkg('@w/ext'),
    'packages/ext/tslaws.json': { extends: '../../tslaws.base.json' },
  });
  git(root, 'init', '-q', '-b', 'main');
  git(root, 'add', '-A');
  git(root, 'commit', '-q', '-m', 'base');
  return root;
}

const all = ['ext', 'leaf', 'shared', 'tool', 'viz', 'web', 'app'].map((name) => `packages/${name}`).sort();

/** The paths of the projects selected after writing `files` into a fresh workspace. */
function selected(files: Record<string, unknown>, root = workspace()): string[] {
  write(root, files);
  return affectedProjects(root, changedSince(root, 'main').files).map((a) => a.project.path);
}

describe('changedSince', () => {
  it('sees nothing in a clean tree', () => {
    const root = workspace();
    assert.deepEqual(changedSince(root, 'main').files, []);
  });

  it('counts unstaged, staged and untracked files, and skips ignored ones', () => {
    const root = workspace();
    write(root, {
      'packages/leaf/src/l.ts': 'export const l = 2;\n',
      'packages/app/src/a.ts': 'export const a = 2;\n',
      'packages/web/src/new.ts': 'export const n = 1;\n',
      'packages/web/dist/out.js': '',
    });
    git(root, 'add', 'packages/app/src/a.ts');
    assert.deepEqual(changedSince(root, 'main').files, [
      'packages/app/src/a.ts',
      'packages/leaf/src/l.ts',
      'packages/web/src/new.ts',
    ]);
  });

  it('compares with the merge-base, so what landed on the base after branching is not a change', () => {
    const root = workspace();
    git(root, 'branch', 'topic');
    write(root, { 'packages/leaf/src/l.ts': 'export const l = 2;\n' });
    git(root, 'commit', '-q', '-am', 'main moves on');
    git(root, 'checkout', '-q', 'topic');
    write(root, { 'packages/app/src/a.ts': 'export const a = 2;\n' });
    git(root, 'commit', '-q', '-am', 'topic work');
    assert.deepEqual(changedSince(root, 'main').files, ['packages/app/src/a.ts']);
  });

  it('names the problem for an unknown ref', () => {
    assert.throws(() => changedSince(workspace(), 'no-such-ref'), /--changed no-such-ref: .*fetch-depth: 0/);
    assert.throws(() => changedSince(workspace(), ''), /needs a base ref/);
  });
});

describe('affectedProjects', () => {
  it('selects only the leaf for a change to a leaf', () => {
    assert.deepEqual(selected({ 'packages/leaf/src/l.ts': 'export const l = 2;\n' }), ['packages/leaf']);
  });

  it('selects the project and everything that depends on it, transitively and through paths', () => {
    assert.deepEqual(selected({ 'packages/shared/src/s.ts': 'export const s = 2;\n' }), [
      'packages/app',
      'packages/shared',
      'packages/viz',
      'packages/web',
    ]);
  });

  it('follows a package without a tslaws.json to the projects that depend on it', () => {
    assert.deepEqual(selected({ 'packages/util/src/u.ts': 'export const u = 2;\n' }), ['packages/tool']);
  });

  it('counts a changed lock, tslaws.json and laws file as a change in the project', () => {
    assert.deepEqual(selected({ 'packages/leaf/tsc-laws.lock': '{}\n' }), ['packages/leaf']);
    assert.deepEqual(selected({ 'packages/leaf/tslaws.json': { runs: 10 } }), ['packages/leaf']);
    assert.deepEqual(selected({ 'packages/leaf/src/l.laws.ts': 'export {};\n' }), ['packages/leaf']);
  });

  it('counts an untracked file', () => {
    assert.deepEqual(selected({ 'packages/web/src/brand-new.ts': 'export {};\n' }), ['packages/web']);
  });

  it('selects every project for a change to the root config, a lockfile or an extends base', () => {
    const edits: Record<string, unknown> = {
      'tslaws.json': { projects: ['packages/*'], runs: 5 },
      'package.json': { name: 'root', private: true, workspaces: ['packages/*'], version: '2.0.0' },
      'package-lock.json': '{}\n',
      'tsconfig.base.json': { compilerOptions: { strict: false } },
      'tslaws.base.json': { runs: 60 },
    };
    for (const [file, content] of Object.entries(edits)) assert.deepEqual(selected({ [file]: content }), all, file);
  });

  it('ignores a file that belongs to no project', () => {
    assert.deepEqual(selected({ 'README.md': 'changed\n' }), []);
  });

  it('says why each project runs', () => {
    const root = workspace();
    write(root, { 'packages/shared/src/s.ts': 'export const s = 2;\n' });
    const reasons = Object.fromEntries(
      affectedProjects(root, changedSince(root, 'main').files).map((a) => [a.project.path, a.reason]),
    );
    assert.equal(reasons['packages/shared'], 'contains changed file packages/shared/src/s.ts');
    assert.equal(reasons['packages/app'], 'depends on packages/shared, which has changes');
    assert.equal(reasons['packages/web'], 'depends on packages/app, which is affected');
  });
});

function tslaws(cwd: string, ...args: string[]): { status: number | null; stdout: string; stderr: string } {
  const run = spawnSync('node', [bin, ...args], { cwd, encoding: 'utf8' });
  return { status: run.status, stdout: run.stdout, stderr: run.stderr };
}

describe('tslaws --changed', () => {
  it('runs the affected projects only and prints why on stderr', () => {
    const root = workspace();
    write(root, { 'packages/shared/src/s.ts': 'export const s = 2;\n' });
    const run = tslaws(root, 'list', '--changed', 'main');
    assert.equal(run.status, 0, run.stderr);
    assert.match(run.stderr, /^--changed main \(merge-base [0-9a-f]{8}, 1 changed file\): 4 of 7 projects selected$/m);
    assert.match(run.stderr, /^ {2}packages\/app: depends on packages\/shared, which has changes$/m);
    assert.match(run.stdout, /── packages\/shared ──/);
    assert.match(run.stdout, /── packages\/web ──/);
    assert.doesNotMatch(run.stdout, /packages\/leaf|packages\/tool|packages\/ext/);
  });

  it('exits 0 with a note when nothing is affected', () => {
    const run = tslaws(workspace(), 'list', '--changed', 'main');
    assert.equal(run.status, 0, run.stderr);
    assert.match(run.stderr, /0 of 7 projects selected/);
    assert.equal(run.stdout, '');
  });

  it('prints an empty object for --json when nothing is affected', () => {
    const run = tslaws(workspace(), 'list', '--json', '--changed', 'main');
    assert.equal(run.status, 0, run.stderr);
    assert.deepEqual(JSON.parse(run.stdout), {});
  });

  it('intersects with --filter and --project', () => {
    const root = workspace();
    write(root, { 'packages/shared/src/s.ts': 'export const s = 2;\n' });
    const filtered = tslaws(root, 'list', '--changed', 'main', '--filter', 'packages/a*');
    assert.match(filtered.stdout, /── packages\/app ──/);
    assert.doesNotMatch(filtered.stdout, /packages\/shared|packages\/web/);
    const none = tslaws(root, 'list', '--changed', 'main', '--project', 'packages/leaf');
    assert.equal(none.status, 0, none.stderr);
    assert.match(none.stderr, /0 of 7 projects selected/);
    assert.equal(none.stdout, '');
  });

  it('runs every project when the root config changed', () => {
    const root = workspace();
    write(root, { 'tsconfig.base.json': { compilerOptions: { strict: false } } });
    const run = tslaws(root, 'list', '--changed', 'main');
    assert.match(run.stderr, /7 of 7 projects selected/);
    assert.match(run.stderr, /packages\/leaf: tsconfig\.base\.json changed \(root config\)/);
  });

  it('fails with the git message for an unknown ref', () => {
    const run = tslaws(workspace(), 'list', '--changed', 'no-such-ref');
    assert.equal(run.status, 1);
    assert.match(run.stderr, /--changed no-such-ref:/);
  });

  it('inside one project runs when something there changed, and exits 0 with a note otherwise', () => {
    const root = workspace();
    const leaf = join(root, 'packages', 'leaf');
    write(root, { 'packages/shared/src/s.ts': 'export const s = 2;\n' });
    const idle = tslaws(leaf, 'list', '--changed', 'main');
    assert.equal(idle.status, 0, idle.stderr);
    assert.match(idle.stderr, /nothing changed in this project/);
    assert.equal(idle.stdout, '');
    write(root, { 'packages/leaf/src/l.ts': 'export const l = 2;\n' });
    const busy = tslaws(leaf, 'list', '--changed', 'main');
    assert.equal(busy.status, 0, busy.stderr);
    assert.doesNotMatch(busy.stderr, /nothing changed/);
  });
});
