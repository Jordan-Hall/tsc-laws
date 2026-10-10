import assert from 'node:assert/strict';
import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import ts from 'typescript';

const root = path.resolve(import.meta.dirname, '../content/docs');
const pages = new Map();
const navigation = new Map();

async function collect(directory) {
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const filename = path.join(directory, entry.name);
    if (entry.isDirectory()) await collect(filename);
    else if (entry.name === 'meta.json') navigation.set(directory, JSON.parse(await readFile(filename, 'utf8')));
    else if (entry.name.endsWith('.mdx')) {
      const relative = path.relative(root, filename).replaceAll(path.sep, '/');
      const route = `/${relative.replace(/\.mdx$/, '').replace(/(^|\/)index$/, '')}`.replace(/\/$/, '') || '/';
      assert.ok(!pages.has(route), `Duplicate route: ${route}`);
      pages.set(route, { filename, content: await readFile(filename, 'utf8') });
    }
  }
}
await collect(root);

test('every local Markdown link resolves to a documentation page', () => {
  for (const [route, { content }] of pages) {
    for (const match of content.matchAll(/\[[^\]]*\]\((\/[^\s)]*)\)/g)) {
      const target = match[1].split(/[?#]/)[0].replace(/\/$/, '') || '/';
      assert.ok(pages.has(target), `${route} links to missing page ${target}`);
    }
  }
});

test('explicit navigation includes every page and folder', async () => {
  for (const [directory, meta] of navigation) {
    const actual = (await readdir(directory, { withFileTypes: true }))
      .filter((entry) => entry.isDirectory() || entry.name.endsWith('.mdx'))
      .map((entry) => entry.name.replace(/\.mdx$/, ''));
    const listed = meta.pages.filter((entry) => !entry.startsWith('---'));
    assert.deepEqual([...listed].sort(), actual.sort(), `${path.relative(root, directory)} has incomplete navigation`);
    assert.equal(new Set(listed).size, listed.length, 'Navigation repeats a page');
  }
  for (const { filename } of pages.values())
    assert.ok(navigation.has(path.dirname(filename)), `Missing meta.json for ${filename}`);
});

test('pages include a title, description, and upstream or project sources', () => {
  for (const [route, { content }] of pages) {
    assert.match(content, /^---\ntitle: .+\ndescription: .+\n---/, `${route}: missing frontmatter`);
    assert.match(content, /https:\/\/(?:www\.typescriptlang\.org|github\.com|tc39\.es)\//, `${route}: missing source`);
  }
});

test('the specification option index covers every recognized compiler, build, and watch option', () => {
  const expected = [
    ...new Set([...ts.optionDeclarations, ...ts.optionsForBuild, ...ts.optionsForWatch].map((option) => option.name)),
  ].sort();
  const content = pages.get('/typescript/projects/compiler-options').content;
  const documented = [...content.matchAll(/^\|\s+`(\w+)`\s+\|/gm)].map((match) => match[1]);
  assert.equal(new Set(documented).size, documented.length, 'Option index repeats a name');
  assert.deepEqual(documented.sort(), expected, 'Review the option index when the compiler edition changes');
  assert.ok(
    pages.get('/typescript').content.includes(`TypeScript ${ts.version}`),
    'Examples and specification must name the same edition',
  );
});
