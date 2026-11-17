// Project discovery: which directories count as projects, from which source, and how the root and the flags narrow them.
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { after, describe, it } from 'node:test';
import { discoverProjects, isMonorepoRoot, pnpmPackages } from '../dist/projects.js';

const temps: string[] = [];
after(() => {
  for (const dir of temps) rmSync(dir, { recursive: true, force: true });
});

/** A fresh repository with the given files (a string is written as is, anything else as JSON). */
function repo(files: Record<string, unknown>): string {
  const root = mkdtempSync(join(tmpdir(), 'tslaws-projects-'));
  temps.push(root);
  for (const [path, content] of Object.entries(files)) {
    mkdirSync(dirname(join(root, path)), { recursive: true });
    writeFileSync(join(root, path), typeof content === 'string' ? content : JSON.stringify(content));
  }
  return root;
}

const paths = (root: string, opts?: Parameters<typeof discoverProjects>[1]) =>
  discoverProjects(root, opts).map((p) => p.path);

describe('discoverProjects sources', () => {
  it('reads the `projects` globs of the root tslaws.json', () => {
    const root = repo({
      'tslaws.json': { projects: ['packages/*', 'tools/cli'] },
      'packages/b/tslaws.json': {},
      'packages/a/tslaws.json': {},
      'packages/none/package.json': {},
      'tools/cli/tslaws.json': {},
      'tools/other/tslaws.json': {},
    });
    assert.deepEqual(paths(root), ['packages/a', 'packages/b', 'tools/cli']);
    const [first] = discoverProjects(root);
    assert.equal(first!.dir, join(root, 'packages', 'a'));
  });

  it('reads package.json workspaces as an array', () => {
    const root = repo({
      'package.json': { workspaces: ['packages/*'] },
      'packages/a/tslaws.json': {},
      'packages/b/package.json': {},
    });
    assert.deepEqual(paths(root), ['packages/a']);
  });

  it('reads package.json workspaces as { packages }', () => {
    const root = repo({
      'package.json': { workspaces: { packages: ['apps/*'] } },
      'apps/web/tslaws.json': {},
    });
    assert.deepEqual(paths(root), ['apps/web']);
  });

  it('reads pnpm-workspace.yaml, with quotes, comments and negations', () => {
    const root = repo({
      'pnpm-workspace.yaml': [
        'packages:',
        "  - 'packages/*'   # the libraries",
        '  - "apps/*"',
        '  - tools/*',
        "  - '!apps/legacy'",
        'catalog:',
        '  - nothing/*',
        '',
      ].join('\n'),
      'packages/a/tslaws.json': {},
      'apps/web/tslaws.json': {},
      'apps/legacy/tslaws.json': {},
      'tools/x/tslaws.json': {},
      'nothing/y/tslaws.json': {},
    });
    assert.deepEqual(paths(root), ['apps/web', 'packages/a', 'tools/x']);
  });

  it('parses the one-line pnpm list', () => {
    assert.deepEqual(pnpmPackages('packages: [\'a/*\', "b"]\n'), ['a/*', 'b']);
  });

  it('prefers `projects` over the package manager lists', () => {
    const root = repo({
      'tslaws.json': { projects: ['packages/a'] },
      'package.json': { workspaces: ['packages/*'] },
      'packages/a/tslaws.json': {},
      'packages/b/tslaws.json': {},
    });
    assert.deepEqual(paths(root), ['packages/a']);
  });

  it('applies negations in workspaces', () => {
    const root = repo({
      'package.json': { workspaces: ['packages/*', '!packages/skip'] },
      'packages/a/tslaws.json': {},
      'packages/skip/tslaws.json': {},
    });
    assert.deepEqual(paths(root), ['packages/a']);
  });

  it('finds nested projects and skips node_modules, .git and dist', () => {
    const root = repo({
      'package.json': { workspaces: ['packages/**'] },
      'packages/a/tslaws.json': {},
      'packages/a/inner/tslaws.json': {},
      'packages/a/node_modules/dep/tslaws.json': {},
      'packages/a/dist/tslaws.json': {},
      'packages/.git/tslaws.json': {},
    });
    assert.deepEqual(paths(root), ['packages/a', 'packages/a/inner']);
  });

  it('finds nothing when no source lists a project', () => {
    const root = repo({ 'package.json': { name: 'x' }, 'packages/a/tslaws.json': {} });
    assert.deepEqual(paths(root), []);
    assert.deepEqual(paths(repo({})), []);
  });

  it('rejects a malformed `projects` list', () => {
    const root = repo({ 'tslaws.json': { projects: 'packages/*' } });
    assert.throws(() => discoverProjects(root), /"projects" must be an array/);
  });
});

describe('discoverProjects root rule', () => {
  it('counts the root when its tslaws.json has no `projects` key', () => {
    const root = repo({
      'tslaws.json': {},
      'package.json': { workspaces: ['packages/*'] },
      'packages/a/tslaws.json': {},
    });
    assert.deepEqual(paths(root), ['', 'packages/a']);
    assert.equal(discoverProjects(root)[0]!.dir, root);
  });

  it('does not count a root that only lists projects', () => {
    const root = repo({ 'tslaws.json': { projects: ['packages/*'] }, 'packages/a/tslaws.json': {} });
    assert.deepEqual(paths(root), ['packages/a']);
  });

  it('counts a listing root that has a lock file', () => {
    const root = repo({
      'tslaws.json': { projects: ['packages/*'] },
      'tsc-laws.lock': '{}',
      'packages/a/tslaws.json': {},
    });
    assert.deepEqual(paths(root), ['', 'packages/a']);
  });

  it('counts a listing root with a laws file outside the projects, not inside them', () => {
    const outside = repo({
      'tslaws.json': { projects: ['packages/*'] },
      'laws/core.laws.ts': '',
      'packages/a/tslaws.json': {},
    });
    assert.deepEqual(paths(outside), ['', 'packages/a']);
    const inside = repo({
      'tslaws.json': { projects: ['packages/*'] },
      'packages/a/tslaws.json': {},
      'packages/a/x.laws.ts': '',
      'node_modules/dep/y.laws.ts': '',
    });
    assert.deepEqual(paths(inside), ['packages/a']);
  });

  it('never counts a root without tslaws.json', () => {
    const root = repo({ 'package.json': { workspaces: ['a'] }, 'a/tslaws.json': {}, 'tsc-laws.lock': '{}' });
    assert.deepEqual(paths(root), ['a']);
  });
});

describe('discoverProjects narrowing', () => {
  const root = repo({
    'tslaws.json': {},
    'package.json': { workspaces: ['packages/*', 'apps/*'] },
    'packages/a/tslaws.json': {},
    'packages/b/tslaws.json': {},
    'apps/web/tslaws.json': {},
  });

  it('`only` matches paths exactly, ignoring ./ and a trailing /', () => {
    assert.deepEqual(paths(root, { only: ['./packages/a/', 'apps/web'] }), ['apps/web', 'packages/a']);
    assert.deepEqual(paths(root, { only: ['packages'] }), []);
    assert.deepEqual(paths(root, { only: ['./'] }), ['']);
  });

  it('`filter` globs the path, with negations', () => {
    assert.deepEqual(paths(root, { filter: ['packages/*'] }), ['packages/a', 'packages/b']);
    assert.deepEqual(paths(root, { filter: ['**', '!packages/b'] }), ['', 'apps/web', 'packages/a']);
  });

  it('combines both', () => {
    assert.deepEqual(paths(root, { only: ['packages/a', 'apps/web'], filter: ['packages/*'] }), ['packages/a']);
  });
});

describe('isMonorepoRoot', () => {
  it('is true without a tslaws.json when workspaces hold projects', () => {
    assert.equal(isMonorepoRoot(repo({ 'package.json': { workspaces: ['p/*'] }, 'p/a/tslaws.json': {} })), true);
  });

  it('is false without a tslaws.json and without projects', () => {
    assert.equal(isMonorepoRoot(repo({ 'package.json': { workspaces: ['p/*'] } })), false);
    assert.equal(isMonorepoRoot(repo({})), false);
  });

  it('is true when tslaws.json has `projects`, false when it does not', () => {
    assert.equal(isMonorepoRoot(repo({ 'tslaws.json': { projects: [] } })), true);
    assert.equal(
      isMonorepoRoot(repo({ 'tslaws.json': {}, 'package.json': { workspaces: ['p/*'] }, 'p/a/tslaws.json': {} })),
      false,
    );
  });
});
