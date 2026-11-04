// Bundler plugins: tslaws.json `bundlerPlugins` teaches the browser bundler a source format. The unit tests need only
// the build in dist/. The browser tests prove it with Crown's `.tsrx` templates and also need Chrome, Edge or Chromium
// (or TSLAWS_BROWSER), the built compiler in TSC_LAWS_BIN, and CROWN_TSRX_DIST: the `dist` directory of
// packages/framework/tsrx in a Crown checkout, built (its node_modules must hold @crown/framework).
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { after, describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';
import { check } from '../dist/check.js';
import { readManifest } from '../dist/compile.js';
import { explainBundleError, loadBundlerPlugins } from '../dist/bundlerPlugins.js';
import { parseConfig } from '../dist/coverage.js';
import { writeLock } from '../dist/lock.js';
import type { CheckOptions, LawResult } from '../dist/types.js';

const compiler = process.env.TSC_LAWS_BIN;
const here = dirname(fileURLToPath(import.meta.url));
const root = mkdtempSync(join(here, '..', '.tmp-bundler-'));
const fixtures = join(here, 'fixtures', 'tsrx');

after(() => {
  rmSync(root, { recursive: true, force: true });
  setTimeout(() => process.exit(process.exitCode ?? 0), 100).unref();
});

function hasBrowser(): boolean {
  if (process.env.TSLAWS_BROWSER !== undefined) return existsSync(process.env.TSLAWS_BROWSER);
  const bases = [process.env.PROGRAMFILES, process.env['PROGRAMFILES(X86)'], process.env.LOCALAPPDATA];
  return (
    bases.some(
      (b) =>
        b !== undefined &&
        (existsSync(join(b, 'Google/Chrome/Application/chrome.exe')) ||
          existsSync(join(b, 'Microsoft/Edge/Application/msedge.exe'))),
    ) ||
    existsSync('/Applications/Google Chrome.app') ||
    ['/usr/bin/google-chrome', '/usr/bin/chromium', '/usr/bin/chromium-browser'].some(existsSync)
  );
}

function write(dir: string, files: Record<string, string>): void {
  for (const [file, text] of Object.entries(files)) {
    mkdirSync(dirname(join(dir, file)), { recursive: true });
    writeFileSync(join(dir, file), text);
  }
}

describe('loadBundlerPlugins', () => {
  const dir = join(root, 'unit');
  write(dir, {
    'object.mjs': "export default { name: 'as-object', setup() {} };\n",
    'sync.mjs': 'export default ({ cwd }) => ({ name: `sync:${cwd}`, setup() {} });\n',
    'async.mjs': "export default async () => { await null; return { name: 'async', setup() {} }; };\n",
    'throws-on-load.mjs': "throw new Error('boom while loading');\n",
    'throws-in-factory.mjs': "export default () => { throw new Error('boom in factory'); };\n",
    'not-a-plugin.mjs': 'export default 42;\n',
    'no-default.mjs': 'export const plugin = {};\n',
  });

  it('accepts a plugin object, a function and an async function, in order, relative to the config directory', async () => {
    const plugins = await loadBundlerPlugins(dir, ['./object.mjs', 'sync.mjs', './async.mjs']);
    assert.deepEqual(
      plugins.map((p) => p.name),
      ['as-object', `sync:${dir}`, 'async'],
    );
    assert.deepEqual(await loadBundlerPlugins(dir, undefined), []);
  });

  it('names the setting and the module when a plugin throws while loading', async () => {
    await assert.rejects(
      loadBundlerPlugins(dir, ['./throws-on-load.mjs']),
      /bundlerPlugins: cannot use ".\/throws-on-load.mjs".*failed to load: boom while loading/,
    );
    await assert.rejects(
      loadBundlerPlugins(dir, ['./throws-in-factory.mjs']),
      /bundlerPlugins: cannot use .*plugin function threw: boom in factory/,
    );
  });

  it('rejects a missing module and an export that is not a plugin', async () => {
    await assert.rejects(loadBundlerPlugins(dir, ['./nope.mjs']), /no such file; paths are relative to/);
    await assert.rejects(loadBundlerPlugins(dir, ['./not-a-plugin.mjs']), /must be an esbuild plugin/);
    await assert.rejects(loadBundlerPlugins(dir, ['./no-default.mjs']), /must be an esbuild plugin/);
  });

  it('is validated as a list of paths in tslaws.json', () => {
    assert.deepEqual(parseConfig({ bundlerPlugins: ['./a.mjs'] }).bundlerPlugins, ['./a.mjs']);
    assert.throws(
      () => parseConfig({ bundlerPlugins: './a.mjs' }),
      /"bundlerPlugins" must be an array of module paths/,
    );
    assert.throws(() => parseConfig({ bundlerPlugins: [''] }), /"bundlerPlugins" must be an array/);
  });

  it('turns the "no loader" failure of esbuild into advice naming the setting, and leaves other errors alone', async () => {
    write(dir, { 'entry.js': "import './thing.tsrx';\n", 'thing.tsrx': '<x />\n' });
    const failure = await build({
      entryPoints: [join(dir, 'entry.js')],
      bundle: true,
      write: false,
      logLevel: 'silent',
    }).then(
      () => assert.fail('esbuild should refuse a .tsrx file'),
      (error: Error) => error,
    );
    const message = explainBundleError(failure).message;
    assert.match(message, /"\.tsrx" files/);
    assert.match(message, /tslaws\.json "bundlerPlugins"/);
    assert.match(message, /\{ "bundlerPlugins": \["\.\/tools\/tsrx-plugin\.mjs"\] \}/);
    const other = new Error('something else');
    assert.equal(explainBundleError(other), other);
  });
});

const distValue = process.env.CROWN_TSRX_DIST;
const tsrxDist =
  distValue === undefined || distValue === ''
    ? undefined
    : distValue.startsWith('file:')
      ? fileURLToPath(distValue)
      : distValue;
const skip =
  compiler === undefined || !hasBrowser()
    ? 'needs TSC_LAWS_BIN and a browser'
    : tsrxDist === undefined
      ? 'set CROWN_TSRX_DIST to the built dist directory of packages/framework/tsrx in a Crown checkout (not set)'
      : !existsSync(join(tsrxDist, 'index.js'))
        ? `CROWN_TSRX_DIST (${tsrxDist}) has no index.js: build @crown/tsrx first`
        : false;

function project(name: string, config: Record<string, unknown> | undefined): CheckOptions {
  const cwd = join(root, name);
  write(cwd, {
    'src/Badge.tsrx': readFileSync(join(fixtures, 'Badge.tsrx'), 'utf8'),
    'src/badge.browser.laws.ts': [
      "import { mount as render, flushSync } from '@crown/framework/dom';",
      "import { mount } from 'tslaws/browser';",
      "import Badge from './Badge.tsrx';",
      'export law badgeShowsItsLabel(label: string) {',
      '  const holder = mount();',
      "  render(Badge({ classes: 'badge', label }), holder);",
      '  flushSync();',
      "  const span = holder.querySelector('span');",
      "  return span !== null && span.className === 'badge' && span.textContent === label;",
      '}',
      'export law badgeShowsTheWrongText(label: string) {',
      '  const holder = mount();',
      "  render(Badge({ classes: 'badge', label }), holder);",
      '  flushSync();',
      '  return holder.textContent === `Label: ${label}`;',
      '}',
      '',
    ].join('\n'),
  });
  if (config !== undefined) write(cwd, { 'tslaws.json': JSON.stringify(config) });
  const options: CheckOptions = {
    files: ['src/badge.browser.laws.ts'],
    cwd,
    runs: 20,
    compiler: compiler!,
    lockFile: join(cwd, 'tsc-laws.lock'),
    noProve: false,
    bound: 4,
    proofTimeoutMs: 5000,
    propertyTimeoutMs: 30000,
  };
  writeLock(options.lockFile, readManifest(compiler!, options.files, cwd));
  return options;
}

function byName(results: LawResult[], name: string): LawResult {
  const found = results.find((r) => r.name === name);
  assert.ok(found, `no result for ${name}: ${JSON.stringify(results)}`);
  return found;
}

describe('browser laws over .tsrx templates', { skip }, () => {
  const plugin = relative(join(root, 'with-plugin'), join(fixtures, 'tsrx-plugin.mjs')).replaceAll('\\', '/');
  let run: Promise<LawResult[]> | undefined;
  const withPlugin = (): Promise<LawResult[]> =>
    (run ??= check(project('with-plugin', { bundlerPlugins: [plugin] }), true).then((r) => r.results));

  it('run in Chromium and pass when tslaws.json configures the plugin', async () => {
    const r = byName(await withPlugin(), 'badgeShowsItsLabel');
    assert.equal(r.status, 'tested', JSON.stringify(r));
    assert.equal(r.method, 'browser');
  });

  it('report a law that renders the wrong text as failed', async () => {
    const r = byName(await withPlugin(), 'badgeShowsTheWrongText');
    assert.equal(r.status, 'failed', JSON.stringify(r));
    assert.equal(r.method, 'browser');
    assert.equal(r.message, 'returned false');
    assert.ok(r.counterexample !== undefined, 'a counterexample was found');
  });

  it('report an error naming the .tsrx extension and the setting when no plugin is configured', async () => {
    const { results } = await check(project('without-plugin', undefined), true);
    for (const name of ['badgeShowsItsLabel', 'badgeShowsTheWrongText']) {
      const r = byName(results, name);
      assert.equal(r.status, 'error', JSON.stringify(r));
      assert.match(r.message ?? '', /"\.tsrx" files/);
      assert.match(r.message ?? '', /tslaws\.json "bundlerPlugins"/);
    }
  });

  it('report an error, not a crash, when a configured plugin fails to load', async () => {
    const { results } = await check(project('broken-plugin', { bundlerPlugins: ['./missing-plugin.mjs'] }), true);
    const r = byName(results, 'badgeShowsItsLabel');
    assert.equal(r.status, 'error', JSON.stringify(r));
    assert.match(r.message ?? '', /bundlerPlugins: cannot use ".\/missing-plugin.mjs"/);
  });
});
