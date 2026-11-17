// `extends` in tslaws.json: merging, array replacement, path rebasing, chains, and the errors for cycles and gaps.
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { after, describe, it } from 'node:test';
import { parseConfig, readConfig } from '../dist/coverage.js';

const temps: string[] = [];
after(() => {
  for (const dir of temps) rmSync(dir, { recursive: true, force: true });
});

function repo(files: Record<string, unknown>): string {
  const root = mkdtempSync(join(tmpdir(), 'tslaws-extends-'));
  temps.push(root);
  mkdirSync(join(root, '.git')); // a checkout: the directory no `extends` may leave
  for (const [path, content] of Object.entries(files)) {
    mkdirSync(dirname(join(root, path)), { recursive: true });
    writeFileSync(join(root, path), JSON.stringify(content));
  }
  return root;
}

describe('parseConfig', () => {
  it('accepts `projects` and `extends` and leaves them out of the result', () => {
    const config = parseConfig({ projects: ['packages/*'], extends: './base.json', runs: 3 });
    assert.deepEqual(config, { runs: 3 });
  });

  it('rejects wrong types for them', () => {
    assert.throws(() => parseConfig({ projects: 'packages/*' }), /"projects" must be an array/);
    assert.throws(() => parseConfig({ projects: [1] }), /"projects" must be an array/);
    assert.throws(() => parseConfig({ extends: 3 }), /"extends" must be a path/);
  });

  it('names the file in a message', () => {
    assert.throws(() => parseConfig({ runs: 0 }, '../base.json'), /^Error: \.\.\/base\.json: "runs"/);
  });
});

describe('readConfig extends', () => {
  it('deep-merges objects, replaces arrays and lets the child win', () => {
    const root = repo({
      'base.json': {
        runs: 5,
        bound: 4,
        compilerOptions: { strict: true, allowJs: true },
        laws: ['a/**'],
        e2e: { runs: 2, server: { command: 'dev', url: 'http://localhost:1' } },
      },
      'tslaws.json': {
        extends: './base.json',
        runs: 9,
        compilerOptions: { allowJs: false },
        laws: ['b/**'],
        e2e: { server: { command: 'start', url: 'http://localhost:1' } },
      },
    });
    const config = readConfig(root);
    assert.equal(config.runs, 9);
    assert.equal(config.bound, 4);
    assert.deepEqual(config.compilerOptions, { strict: true, allowJs: false });
    assert.deepEqual(config.laws, ['b/**']);
    assert.equal(config.e2e?.runs, 2);
    assert.equal(config.e2e?.server?.command, 'start');
    assert.equal('extends' in config, false);
  });

  it('drops `projects`, including one from the base', () => {
    const root = repo({
      'base.json': { projects: ['x/*'], runs: 2 },
      'tslaws.json': { extends: './base.json', projects: ['y/*'] },
    });
    assert.deepEqual(readConfig(root), { runs: 2 });
  });

  it('rebases file references but keeps globs relative to the project, for a base in a parent directory', () => {
    const root = repo({
      'tslaws.base.json': {
        cover: ['src/**', '!src/gen/**'],
        laws: ['laws/*.ts'],
        bundlerPlugins: ['./tools/plugin.mjs'],
        e2e: { server: { command: 'dev', url: 'http://localhost:1', cwd: 'app' } },
        compilerOptions: { lib: ['es2022'] },
      },
      'packages/a/tslaws.json': { extends: '../../tslaws.base.json' },
    });
    const config = readConfig(join(root, 'packages', 'a'));
    assert.deepEqual(config.cover, ['src/**', '!src/gen/**']);
    assert.deepEqual(config.laws, ['laws/*.ts']);
    assert.deepEqual(config.bundlerPlugins, ['../../tools/plugin.mjs']);
    assert.equal(config.e2e?.server?.cwd, '../../app');
    assert.deepEqual(config.compilerOptions, { lib: ['es2022'] });
  });

  it('leaves the child paths alone and rebases a base in a subdirectory', () => {
    const root = repo({
      'shared/base.json': { bundlerPlugins: ['plugin.mjs'] },
      'tslaws.json': { extends: './shared/base.json', cover: ['src/**'] },
    });
    const config = readConfig(root);
    assert.deepEqual(config.bundlerPlugins, ['shared/plugin.mjs']);
    assert.deepEqual(config.cover, ['src/**']);
  });

  it('follows a two-level chain, rebasing at each step', () => {
    const root = repo({
      'root.json': { runs: 1, bound: 7, bundlerPlugins: ['p.mjs'] },
      'mid/mid.json': { extends: '../root.json', runs: 2, laws: ['m/*.ts'] },
      'mid/leaf/tslaws.json': { extends: '../mid.json', bound: 8 },
    });
    const config = readConfig(join(root, 'mid', 'leaf'));
    assert.equal(config.runs, 2);
    assert.equal(config.bound, 8);
    assert.deepEqual(config.bundlerPlugins, ['../../p.mjs']);
    assert.deepEqual(config.laws, ['m/*.ts']);
  });

  it('refuses an extends that leaves the repository, by path or through a linked directory', () => {
    const root = repo({ 'repo/packages/a/tslaws.json': { extends: '../../../outside.json' } });
    const checkout = join(root, 'repo');
    mkdirSync(join(checkout, '.git'));
    writeFileSync(join(root, 'outside.json'), JSON.stringify({ runs: 9 }));
    assert.throws(
      () => readConfig(join(checkout, 'packages', 'a')),
      /"extends" "\.\.\/\.\.\/\.\.\/outside\.json" leaves the repository/,
    );
    // Inside the repository a link to a directory outside it is followed by the file system, not by tslaws.
    try {
      symlinkSync(root, join(checkout, 'linked'), 'junction');
    } catch {
      return; // links need privileges on some systems
    }
    writeFileSync(
      join(checkout, 'packages', 'a', 'tslaws.json'),
      JSON.stringify({ extends: '../../linked/outside.json' }),
    );
    assert.throws(() => readConfig(join(checkout, 'packages', 'a')), /leaves the repository/);
  });

  it('does not echo the text of a file that is not JSON', () => {
    const root = repo({});
    writeFileSync(join(root, 'tslaws.json'), '{ "secret-token-text": ');
    const error = (() => {
      try {
        readConfig(root);
      } catch (thrown) {
        return thrown as Error;
      }
      return undefined;
    })();
    assert.match(error?.message ?? '', /tslaws\.json: not valid JSON/);
    assert.doesNotMatch(error?.message ?? '', /secret-token-text/);
  });

  it('reports a cycle with the files in it', () => {
    const root = repo({
      'tslaws.json': { extends: './a.json' },
      'a.json': { extends: './b.json' },
      'b.json': { extends: './a.json' },
    });
    assert.throws(() => readConfig(root), /cycle \(tslaws\.json -> a\.json -> b\.json -> a\.json\)/);
    const self = repo({ 'tslaws.json': { extends: './tslaws.json' } });
    assert.throws(() => readConfig(self), /cycle \(tslaws\.json -> tslaws\.json\)/);
  });

  it('reports a missing base with the chain that reached it', () => {
    const root = repo({ 'tslaws.json': { extends: './a.json' }, 'a.json': { extends: './gone.json' } });
    assert.throws(
      () => readConfig(root),
      /gone\.json: no such file \(reached by extends: tslaws\.json -> a\.json -> gone\.json\)/,
    );
  });

  it('names the base file a bad value came from', () => {
    const root = repo({ 'base.json': { runs: 'many' }, 'tslaws.json': { extends: './base.json' } });
    assert.throws(() => readConfig(root), /base\.json: "runs" must be an integer/);
  });

  it('validates the merged result as a whole', () => {
    const root = repo({
      'base.json': { github: { accept: 'comment' } },
      'tslaws.json': { extends: './base.json', github: { bot: 'my-app[bot]' } },
    });
    assert.equal(readConfig(root).github !== undefined, true);
    const bad = repo({ 'base.json': { github: { accept: 'comment' } }, 'tslaws.json': { extends: './base.json' } });
    assert.throws(() => readConfig(bad), /dedicated GitHub App.*merged from tslaws\.json, base\.json/);
  });
});
