// `bundlerPlugins` for node laws: a law that imports source which imports a template or stylesheet loads it through the
// project's plugins, in the main process and in a property worker, with `require` and with `import()`. The plugin here
// is a fake format (`.tpl`), so the tests need nothing but `npm run build`.
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { after, describe, it } from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { build, readManifest } from '../dist/compile.js';
import { check } from '../dist/check.js';
import { writeLock } from '../dist/lock.js';
import type { CheckOptions, LawResult } from '../dist/types.js';

const here = dirname(fileURLToPath(import.meta.url));
// Inside the package so `tslaws` and `fast-check` resolve through its node_modules.
const root = mkdtempSync(join(here, '..', '.tmp-bundler-node-'));

after(() => {
  rmSync(root, { recursive: true, force: true, maxRetries: 5 });
  // Z3's worker threads keep the test process alive.
  setTimeout(() => process.exit(process.exitCode ?? 0), 100).unref();
});

/** A fake component format: `<p class="{{kind}}">{{text}}</p>` becomes a function from props to an HTML string. */
const fakePlugin = [
  "import { readFileSync } from 'node:fs';",
  'const compile = (template) =>',
  '  `const esc = (v) => String(v).replace(/[&<>"]/g, (c) => "&#" + c.charCodeAt(0) + ";");\n` +',
  '  `export default (props) => ${JSON.stringify(template)}.replace(/[{][{]([a-z]+)[}][}]/g, (_, key) => esc(props[key]));\n`;',
  'export default () => ({',
  "  name: 'fake-tpl',",
  '  setup(build) {',
  "    build.onLoad({ filter: /\\.tpl$/ }, (args) => ({ contents: compile(readFileSync(args.path, 'utf8')), loader: 'js' }));",
  "    build.onLoad({ filter: /\\.css$/ }, () => ({ contents: '', loader: 'css' }));",
  '  },',
  '});',
  '',
].join('\n');

const props = 'Record<string, unknown>';
const sources: Record<string, string> = {
  'src/globals.d.ts': [
    `declare module '*.tpl' { const render: (props: ${props}) => string; export default render; }`,
    "declare module '*.css' { const styles: object; export default styles; }",
    "declare module '*.vue' { const component: unknown; export default component; }",
    "declare module '*.svelte' { const component: unknown; export default component; }",
    '',
  ].join('\n'),
  'src/alert.tpl': '<p class="{{kind}}">{{text}}</p>',
  'src/alert.css': '.warn { color: red; }',
  'src/alert.ts': [
    '/// <reference path="./globals.d.ts" />',
    "import './alert.css';",
    "import template from './alert.tpl';",
    'type Props = { kind: string; text: string };',
    'export const renderAlert = (props: Props): string => template(props);',
    '',
  ].join('\n'),
};

function project(name: string, files: Record<string, string>, config?: Record<string, unknown>): string {
  const dir = join(root, name);
  const all = { ...(config === undefined ? {} : { 'tslaws.json': JSON.stringify(config) }), ...files };
  for (const [file, text] of Object.entries(all)) {
    mkdirSync(dirname(join(dir, file)), { recursive: true });
    writeFileSync(join(dir, file), text);
  }
  return dir;
}

function options(cwd: string, files: string[]): CheckOptions {
  const opts: CheckOptions = {
    files,
    cwd,
    runs: 25,
    compiler: 'builtin',
    lockFile: join(cwd, 'tsc-laws.lock'),
    noProve: true,
    bound: 4,
    proofTimeoutMs: 5000,
    propertyTimeoutMs: 20000,
  };
  writeLock(opts.lockFile, readManifest('builtin', files, cwd));
  return opts;
}

const byName = (results: LawResult[], name: string): LawResult => {
  const found = results.find((r) => r.name === name);
  assert.ok(found, `no result for ${name}: ${JSON.stringify(results)}`);
  return found;
};

describe('bundlerPlugins in node laws', () => {
  const configured = { bundlerPlugins: ['./tools/fake-plugin.mjs'] };
  const withPlugin = (name: string, files: Record<string, string>): string =>
    project(name, { 'tools/fake-plugin.mjs': fakePlugin, ...sources, ...files }, configured);

  it('runs a law over a component the plugin compiles', async () => {
    const cwd = withPlugin('component', {
      'src/alert.laws.ts': [
        "import { law } from 'tslaws';",
        "import { renderAlert } from './alert';",
        "law('an alert renders its text in a paragraph', () => renderAlert({ kind: 'warn', text: 'low disk' }) === '<p class=\"warn\">low disk</p>');",
        "law('markup in the text is escaped', () => !renderAlert({ kind: 'k', text: '<b>' }).includes('<b>'));",
        "law('the plugin output is what runs', () => renderAlert({ kind: 'warn', text: 'low disk' }) === '<p>low disk</p>');",
        '',
      ].join('\n'),
    });
    const { results } = await check(options(cwd, ['src/alert.laws.ts']), true);
    for (const name of ['an alert renders its text in a paragraph', 'markup in the text is escaped'])
      assert.equal(byName(results, name).status, 'tested', JSON.stringify(byName(results, name)));
    // A law that disagrees with the plugin's output fails: the template really ran.
    assert.equal(byName(results, 'the plugin output is what runs').status, 'failed');
  });

  it('runs a server rendering law: the same props give the same HTML string', async () => {
    const cwd = withPlugin('ssr', {
      'src/ssr.laws.ts': [
        "import { law } from 'tslaws';",
        "import { renderAlert } from './alert';",
        "law('the same props give the same html string', (kind: string, text: string) => {",
        '  const props = { kind, text };',
        '  return renderAlert(props) === renderAlert({ ...props });',
        '});',
        "law('rendering reads no browser global', (kind: string, text: string) => {",
        '  renderAlert({ kind, text });',
        "  return typeof (globalThis as { window?: unknown }).window === 'undefined';",
        '});',
        '',
      ].join('\n'),
    });
    const { results } = await check(options(cwd, ['src/ssr.laws.ts']), true);
    for (const name of ['the same props give the same html string', 'rendering reads no browser global'])
      assert.equal(byName(results, name).status, 'tested', JSON.stringify(byName(results, name)));
  });

  it('loads the file for require and for import(), as a module of the kind the importer is', async () => {
    const cwd = withPlugin('both', {
      'src/esm.mjs': "import render from './alert.tpl';\nexport const html = render({ kind: 'e', text: 'esm' });\n",
      'src/laws.laws.ts': [
        "import { law } from 'tslaws';",
        "import { renderAlert } from './alert';",
        "law('ok', () => renderAlert({ kind: 'a', text: 'b' }) !== '');",
        '',
      ].join('\n'),
    });
    const built = build('builtin', ['src/laws.laws.ts'], cwd);
    assert.equal(built.ok, true, built.diagnostics);
    // The compiled output holds no template: the hooks look beside the source.
    const viaRequire = createRequire(join(cwd, '.tslaws', 'out', 'src', 'x.js'))('./alert.js') as {
      renderAlert: (props: { kind: string; text: string }) => string;
    };
    assert.equal(viaRequire.renderAlert({ kind: 'r', text: 'cjs' }), '<p class="r">cjs</p>');
    const viaImport = (await import(pathToFileURL(join(cwd, 'src', 'esm.mjs')).href)) as { html: string };
    assert.equal(viaImport.html, '<p class="e">esm</p>');
  });
});

describe('a node law over a format no plugin handles', () => {
  const failing = (name: string, extension: string): string =>
    project(name, {
      ...sources,
      [`src/page.${extension}`]: 'x',
      'src/page.ts': `import page from './page.${extension}';\nexport const pageOf = (): unknown => page;\n`,
      'src/page.laws.ts': [
        "import { law } from 'tslaws';",
        "import { pageOf } from './page';",
        "law('the page exists', () => pageOf() !== undefined);",
        '',
      ].join('\n'),
    });

  it('reports an error that names the extension and the bundlerPlugins setting', async () => {
    for (const extension of ['vue', 'svelte']) {
      const cwd = failing(`none-${extension}`, extension);
      const { results } = await check(options(cwd, ['src/page.laws.ts']), true);
      const result = byName(results, 'the page exists');
      assert.equal(result.status, 'error', JSON.stringify(result));
      assert.match(result.message ?? '', new RegExp(`"\\.${extension}" files`));
      assert.match(result.message ?? '', /tslaws\.json "bundlerPlugins"/);
    }
  });

  it('does the same when the file is loaded with import()', async () => {
    const cwd = failing('none-import', 'vue');
    writeFileSync(join(cwd, 'src', 'esm.mjs'), "import page from './page.vue';\nexport default page;\n");
    build('builtin', ['src/page.laws.ts'], cwd);
    await assert.rejects(
      import(pathToFileURL(join(cwd, 'src', 'esm.mjs')).href),
      /"\.vue" files.*tslaws\.json "bundlerPlugins"/s,
    );
  });

  it('does the same when plugins are configured but none handles the extension', async () => {
    const cwd = failing('other-plugin', 'vue');
    writeFileSync(join(cwd, 'tslaws.json'), JSON.stringify({ bundlerPlugins: ['./tools/fake-plugin.mjs'] }));
    mkdirSync(join(cwd, 'tools'), { recursive: true });
    writeFileSync(join(cwd, 'tools', 'fake-plugin.mjs'), fakePlugin);
    const { results } = await check(options(cwd, ['src/page.laws.ts']), true);
    const result = byName(results, 'the page exists');
    assert.equal(result.status, 'error', JSON.stringify(result));
    assert.match(result.message ?? '', /"\.vue" files.*bundlerPlugins/);
  });
});

describe('the project a template belongs to', () => {
  const plugin = (word: string): string =>
    [
      'export default () => ({',
      `  name: '${word}',`,
      '  setup(build) {',
      `    build.onLoad({ filter: /[.]word$/ }, () => ({ contents: 'export default "${word}";', loader: 'js' }));`,
      '  },',
      '});',
      '',
    ].join('\n');
  const files = (word: string): Record<string, string> => ({
    'tools/plugin.mjs': plugin(word),
    'src/word.ts': [
      '/// <reference path="./globals.d.ts" />',
      "import w from './w.word';",
      'export default w as string;',
      '',
    ].join('\n'),
    'src/w.word': 'x',
    'src/globals.d.ts': "declare module '*.word' { const w: string; export default w; }\n",
    'src/a.laws.ts': [
      "import { law } from 'tslaws';",
      "import word from './word';",
      "law('has a word', () => word !== '');",
      '',
    ].join('\n'),
  });
  const config = { bundlerPlugins: ['./tools/plugin.mjs'] };

  it('is the closest one, so a nested package uses its own plugins', () => {
    const outer = project('outer', files('root'), config);
    const nested = project(join('outer', 'packages', 'inner'), files('inner'), config);
    for (const cwd of [outer, nested]) {
      const built = build('builtin', ['src/a.laws.ts'], cwd);
      assert.equal(built.ok, true, built.diagnostics);
    }
    const word = (cwd: string): string =>
      (createRequire(join(cwd, '.tslaws', 'out', 'src', 'x.js'))('./word.js') as { default: string }).default;
    assert.equal(word(outer), 'root');
    assert.equal(word(nested), 'inner');
  });
});
