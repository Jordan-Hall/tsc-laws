// Framework support: tslaws.json compilerOptions and .tsx sources, with tiny local stand-ins for a JSX factory and a
// decorator library. Needs Chrome, Edge or Chromium (or TSLAWS_BROWSER), TSC_LAWS_BIN, and `npm run build` for dist/.
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { after, describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';
import { check } from '../dist/check.js';
import { readManifest } from '../dist/compile.js';
import { writeLock } from '../dist/lock.js';
import type { CheckOptions, LawResult } from '../dist/types.js';

const compiler = process.env.TSC_LAWS_BIN;
const here = dirname(fileURLToPath(import.meta.url));
const root = mkdtempSync(join(here, '..', '.tmp-frameworks-'));

function hasBrowser(): boolean {
  if (process.env.TSLAWS_BROWSER !== undefined) return existsSync(process.env.TSLAWS_BROWSER);
  const bases = [process.env.PROGRAMFILES, process.env['PROGRAMFILES(X86)'], process.env.LOCALAPPDATA];
  const found = bases.some(
    (b) =>
      b !== undefined &&
      (existsSync(join(b, 'Google/Chrome/Application/chrome.exe')) ||
        existsSync(join(b, 'Microsoft/Edge/Application/msedge.exe'))),
  );
  return (
    found ||
    existsSync('/Applications/Google Chrome.app') ||
    ['/usr/bin/google-chrome', '/usr/bin/chromium', '/usr/bin/chromium-browser'].some(existsSync)
  );
}

after(() => {
  rmSync(root, { recursive: true, force: true });
  setTimeout(() => process.exit(process.exitCode ?? 0), 100).unref();
});

function project(name: string, files: Record<string, string>): CheckOptions {
  const cwd = join(root, name);
  for (const [file, text] of Object.entries(files)) {
    mkdirSync(dirname(join(cwd, file)), { recursive: true });
    writeFileSync(join(cwd, file), text);
  }
  const options: CheckOptions = {
    files: ['src/ui.browser.laws.ts'],
    cwd,
    runs: 20,
    compiler: compiler!,
    lockFile: join(cwd, 'tsc-laws.lock'),
    noProve: false,
    bound: 4,
    proofTimeoutMs: 5000,
    propertyTimeoutMs: 20000,
  };
  writeLock(options.lockFile, readManifest(compiler!, options.files, cwd));
  return options;
}

function byName(results: LawResult[], name: string): LawResult {
  const found = results.find((r) => r.name === name);
  assert.ok(found, `no result for ${name}: ${JSON.stringify(results)}`);
  return found;
}

const json = (value: unknown): string => JSON.stringify(value);

// A ten-line stand-in for React.createElement.
const factory = [
  'export function h(tag: string, props: Record<string, string> | null, ...kids: (string | Node)[]): HTMLElement {',
  '  const el = document.createElement(tag);',
  '  for (const [k, v] of Object.entries(props ?? {})) el.setAttribute(k, v);',
  '  el.append(...kids);',
  '  return el;',
  '}',
  'declare global {',
  '  namespace JSX {',
  '    type Element = HTMLElement;',
  '    interface IntrinsicElements { [tag: string]: Record<string, string>; }',
  '  }',
  '}',
  '',
].join('\n');

const component = [
  "import { h } from './h';",
  'export function Greeting(props: { name: string }): HTMLElement {',
  '  return <p class="greeting">Hello, {props.name}</p>;',
  '}',
  '',
].join('\n');

const jsxLaws = [
  "import { mount } from 'tslaws/browser';",
  "import { Greeting } from './Greeting';",
  'export async law greetingShowsName(name: string) {',
  '  const el = mount();',
  '  el.append(Greeting({ name }));',
  '  return el.textContent === `Hello, ${name}`;',
  '}',
  '',
].join('\n');

const decorator = [
  'export function tagged(target: object, key: string): void {',
  '  (target as { tag?: string }).tag = key;',
  '}',
  'export class Widget {',
  '  @tagged',
  '  label(): string { return "widget"; }',
  '}',
  '',
].join('\n');

const decoratorLaws = [
  "import { mount } from 'tslaws/browser';",
  "import { Widget, tagged } from './widget';",
  'export async law decoratorRan(n: string) {',
  '  const el = mount();',
  '  el.textContent = new Widget().label();',
  '  return (Widget.prototype as unknown as { tag: string }).tag === "label" && el.textContent === "widget" && typeof tagged === "function";',
  '}',
  '',
].join('\n');

describe(
  'framework support',
  { skip: compiler === undefined || !hasBrowser() ? 'needs TSC_LAWS_BIN and a browser' : false },
  () => {
    it('tests a .tsx component with a custom JSX factory', async () => {
      const opts = project('jsx', {
        'tslaws.json': json({
          cover: ['src/**/*.ts', 'src/**/*.tsx'],
          compilerOptions: { jsx: 'react', jsxFactory: 'h' },
        }),
        'src/h.ts': factory,
        'src/Greeting.tsx': component,
        'src/ui.browser.laws.ts': jsxLaws,
      });
      const { results, compileDiagnostics } = await check(opts, true);
      assert.equal(compileDiagnostics, '');
      const r = byName(results, 'greetingShowsName');
      assert.equal(r.status, 'tested', JSON.stringify(r));
      assert.equal(r.method, 'browser');
      assert.equal(
        results.some((x) => x.status === 'uncovered'),
        false,
        JSON.stringify(results),
      );
    });

    it('reports an exported component no law reaches as uncovered', async () => {
      const opts = project('uncovered', {
        'tslaws.json': json({
          cover: ['src/**/*.ts', 'src/**/*.tsx'],
          compilerOptions: { jsx: 'react', jsxFactory: 'h' },
        }),
        'src/h.ts': factory,
        'src/Greeting.tsx': component,
        'src/ui.browser.laws.ts': [
          "import { mount } from 'tslaws/browser';",
          "import { h } from './h';",
          'export async law hMakesElements(tag: string) {',
          '  return mount(h("p", null, "x")).textContent === "x" && tag === tag;',
          '}',
          '',
        ].join('\n'),
      });
      const { results } = await check(opts, true);
      const missing = results.filter((r) => r.status === 'uncovered');
      assert.deepEqual(
        missing.map((r) => `${r.file}:${r.name}`),
        ['src/Greeting.tsx:Greeting'],
        JSON.stringify(results),
      );
    });

    it('tests a decorated class with experimentalDecorators, and fails to compile without it', async () => {
      const files = { 'src/widget.ts': decorator, 'src/ui.browser.laws.ts': decoratorLaws };
      const on = project('decorators', {
        ...files,
        'tslaws.json': json({ cover: ['src/**/*.ts'], compilerOptions: { experimentalDecorators: true } }),
      });
      const done = await check(on, true);
      assert.equal(done.compileDiagnostics, '');
      assert.equal(byName(done.results, 'decoratorRan').status, 'tested', JSON.stringify(done.results));

      const off = project('no-decorators', { ...files, 'tslaws.json': json({ cover: ['src/**/*.ts'] }) });
      const failed = await check(off, true);
      assert.match(failed.compileDiagnostics, /decorator/i);
      assert.equal(failed.compileOk, false);
    });

    it('fails to compile JSX without the jsx option', async () => {
      const opts = project('no-jsx', {
        'tslaws.json': json({ cover: ['src/**/*.ts', 'src/**/*.tsx'] }),
        'src/h.ts': factory,
        'src/Greeting.tsx': component,
        'src/ui.browser.laws.ts': jsxLaws,
      });
      const { compileDiagnostics, compileOk } = await check(opts, true);
      assert.match(compileDiagnostics, /jsx/i);
      assert.equal(compileOk, false);
    });

    it('rejects an unknown compilerOptions key naming the supported ones', async () => {
      const opts = project('unknown', {
        'tslaws.json': json({ compilerOptions: { outFile: 'x.js' } }),
        'src/h.ts': factory,
        'src/ui.browser.laws.ts': 'export law ok(n: string) { return n === n; }\n',
      });
      await assert.rejects(check(opts, true), /unsupported option "outFile".*jsxFactory.*experimentalDecorators/s);
    });

    // A plain JavaScript module with JSDoc types, and a law (in TypeScript) that calls one of its two functions.
    const plainJs = [
      '/** @param {number} n @returns {number} */',
      'export function double(n) { return n * 2; }',
      '/** @param {number} n @returns {number} */',
      'export function spare(n) { return n + 1; }',
      '',
    ].join('\n');
    const plainJsLaws = [
      "import { mount } from 'tslaws/browser';",
      "import { double } from './util.js';",
      'export async law doubleIsEven(n: number) {',
      '  return mount().isConnected && double(n) === n * 2;',
      '}',
      '',
    ].join('\n');

    it('tests a plain JavaScript module with allowJs and reports its unreached function as uncovered', async () => {
      const opts = project('allow-js', {
        'tslaws.json': json({ cover: ['src/**/*.js'], compilerOptions: { allowJs: true, checkJs: true } }),
        'src/util.js': plainJs,
        'src/ui.browser.laws.ts': plainJsLaws,
      });
      const { results, compileDiagnostics } = await check(opts, true);
      assert.equal(compileDiagnostics, '');
      const r = byName(results, 'doubleIsEven');
      assert.equal(r.status, 'tested', JSON.stringify(r));
      assert.deepEqual(
        results.filter((x) => x.status === 'uncovered').map((x) => `${x.file}:${x.name}`),
        ['src/util.js:spare'],
        JSON.stringify(results),
      );
    });

    it('fails to compile a law that imports a JavaScript module without allowJs', async () => {
      const opts = project('no-allow-js', {
        'tslaws.json': json({ cover: ['src/**/*.js'] }),
        'src/util.js': plainJs,
        'src/ui.browser.laws.ts': plainJsLaws,
      });
      const { compileDiagnostics, compileOk } = await check(opts, true);
      assert.match(compileDiagnostics, /util\.js/);
      assert.equal(compileOk, false);
    });
  },
);
