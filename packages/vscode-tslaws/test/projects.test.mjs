import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';

import { locate, locateIn, labelOf, describeProject, owningFolder } from '../src/projects.js';
import { resolveCommand } from '../src/command.js';
import { createStreamParser } from '../src/parse-report.js';

const at = (...parts) => path.resolve('/w', ...parts);

/** A table of files: `files` maps a path to its text (a tslaws.json or a lock). */
const io = (files) => ({
  fs: {
    existsSync: (p) => Object.hasOwn(files, path.resolve(p)),
    readFileSync: (p) => files[path.resolve(p)],
  },
});

const monorepo = io({
  [at('tslaws.json')]: JSON.stringify({ projects: ['packages/*'] }),
  [at('packages/a/tslaws.json')]: '{}',
  [at('packages/b/tslaws.json')]: '{}',
  [at('packages/b/tsc-laws.lock')]: '{}',
  [at('packages/b/nested/tslaws.json')]: '{}',
});

test('a file belongs to the nearest tslaws.json above it', () => {
  const folders = [at()];
  assert.deepEqual(locate(at('packages/a/src/x.ts'), folders, monorepo), {
    dir: at('packages/a'),
    folder: at(),
    kind: 'project',
  });
  assert.equal(locate(at('packages/b/nested/deep/y.ts'), folders, monorepo).dir, at('packages/b/nested'));
  assert.equal(locate(at('packages/b/src/y.ts'), folders, monorepo).dir, at('packages/b'));
});

test('a file in the root but in no project is the root, which is not a project', () => {
  const found = locate(at('scripts/build.ts'), [at()], monorepo);
  assert.deepEqual(found, { dir: at(), folder: at(), kind: 'root' });
});

test('without a tslaws.json the workspace folder stands in, and the search stops at the folder', () => {
  const none = io({ [path.resolve('/tslaws.json')]: '{}' });
  assert.deepEqual(locate(at('src/x.ts'), [at()], none), { dir: at(), folder: at(), kind: 'folder' });
});

test('a folder that declares package workspaces, with no tslaws.json, is a root that checks every project', () => {
  const npm = io({
    [at('package.json')]: JSON.stringify({ workspaces: ['packages/*'] }),
    [at('packages/a/tslaws.json')]: '{}',
  });
  assert.deepEqual(locate(at('scripts/x.ts'), [at()], npm), { dir: at(), folder: at(), kind: 'root' });
  assert.equal(locate(at('packages/a/src/x.ts'), [at()], npm).kind, 'project');
  const pnpm = io({ [at('pnpm-workspace.yaml')]: 'packages:\n  - packages/*\n' });
  assert.equal(locate(at('x.ts'), [at()], pnpm).kind, 'root');
  const plain = io({ [at('package.json')]: JSON.stringify({ name: 'app' }) });
  assert.equal(locate(at('x.ts'), [at()], plain).kind, 'folder');
});

test('a file outside every workspace folder has no project', () => {
  assert.equal(locate(path.resolve('/elsewhere/x.ts'), [at()], monorepo), undefined);
  assert.equal(locate(at('x.ts'), [], monorepo), undefined);
});

test('several workspace folders each have their own project; nested folders take the deepest', () => {
  const folders = [at('one'), at('two'), at('two/inner')];
  const files = io({ [at('one/tslaws.json')]: '{}', [at('two/tslaws.json')]: '{}' });
  assert.equal(locate(at('one/a.ts'), folders, files).dir, at('one'));
  assert.equal(locate(at('two/b.ts'), folders, files).folder, at('two'));
  assert.equal(locate(at('two/inner/c.ts'), folders, files).folder, at('two/inner'));
  assert.equal(owningFolder(path, at('two/inner/c.ts'), folders), at('two/inner'));
  // A sibling that only shares a prefix is not inside.
  assert.equal(owningFolder(path, at('onebus/x.ts'), folders), undefined);
});

test('a tslaws.json that is mid-edit is still a project boundary', () => {
  const broken = io({ [at('p/tslaws.json')]: '{ "projects": ' });
  assert.equal(locate(at('p/x.ts'), [at()], broken).kind, 'project');
});

test('labels: the path from the folder, the folder name for the folder itself, the folder in front when there are several', () => {
  const one = locate(at('packages/a/x.ts'), [at()], monorepo);
  assert.equal(labelOf(one, [at()]), 'packages/a');
  const folderItself = locateIn(at(), [at()], io({}));
  assert.equal(labelOf(folderItself, [at()]), 'w');
  assert.equal(labelOf(one, [at(), at('other')]), 'w: packages/a');
  assert.equal(labelOf(folderItself, [at(), at('other')]), 'w');
});

test('describeProject says where tslaws runs and whether a lock exists', () => {
  const b = locate(at('packages/b/x.ts'), [at()], monorepo);
  const lines = describeProject(b, [at()], monorepo);
  assert.match(lines[0], /^tslaws project: packages\/b$/);
  assert.equal(lines[1], `runs in ${at('packages/b')}`);
  assert.equal(lines[2], `lock ${at('packages/b/tsc-laws.lock')}`);
  const a = locate(at('packages/a/x.ts'), [at()], monorepo);
  assert.match(describeProject(a, [at()], monorepo)[2], /no tsc-laws.lock yet/);
  const root = locate(at('scripts/x.ts'), [at()], monorepo);
  assert.match(describeProject(root, [at()], monorepo)[0], /monorepo root.*Check all projects/);
});

test('tslaws is found in a parent of the project, up to the workspace folder and no further', () => {
  const entry = at('node_modules/tslaws/bin/tslaws.js');
  const exists = (p) => path.resolve(p) === entry;
  const found = resolveCommand({ root: at('packages/a'), ceiling: at(), exists }, ['check']);
  assert.equal(found.command, 'node');
  assert.equal(path.resolve(found.args[0]), entry);
  // Without a ceiling the lookup is the project directory only, as before.
  assert.match(resolveCommand({ root: at('packages/a'), exists }, ['check']).error, /npm i -D tslaws/);
  // The ceiling stops the climb.
  assert.match(
    resolveCommand({ root: at('packages/a'), ceiling: at('packages'), exists }, ['check']).error,
    /npm i -D/,
  );
  // The nearest install wins.
  const near = at('packages/a/node_modules/tslaws/bin/tslaws.js');
  const both = resolveCommand(
    { root: at('packages/a'), ceiling: at(), exists: (p) => [entry, near].includes(path.resolve(p)) },
    ['check'],
  );
  assert.equal(path.resolve(both.args[0]), near);
});

test('the stream parser passes the project tag of a root run on, and leaves single runs untagged', () => {
  const seen = [];
  const parser = createStreamParser((e) => seen.push(e));
  parser.write(
    `${JSON.stringify({ project: 'packages/a', type: 'plan', laws: [{ file: 'a.laws.ts', name: 'x', line: 1 }] })}\n`,
  );
  parser.write(
    `${JSON.stringify({ project: '.', type: 'result', result: { file: 'a.laws.ts', name: 'x', line: 1, status: 'proved' } })}\n`,
  );
  parser.write(`${JSON.stringify({ type: 'report', results: [], ok: true })}\n`);
  parser.end();
  assert.deepEqual(
    seen.map((e) => [e.type, e.project]),
    [
      ['plan', 'packages/a'],
      ['result', '.'],
      ['report', undefined],
    ],
  );
});
