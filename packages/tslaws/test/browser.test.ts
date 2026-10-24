// Browser laws: node generates inputs, a real browser runs the law against a live DOM. Needs Chrome, Edge or Chromium
// (or TSLAWS_BROWSER), the built compiler in TSC_LAWS_BIN, and `npm run build` for dist/.
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
const root = mkdtempSync(join(here, '..', '.tmp-browser-'));

function hasBrowser(): boolean {
  if (process.env.TSLAWS_BROWSER !== undefined) return existsSync(process.env.TSLAWS_BROWSER);
  const bases = [process.env.PROGRAMFILES, process.env['PROGRAMFILES(X86)'], process.env.LOCALAPPDATA];
  const found = bases.some(
    (b) => b !== undefined && (existsSync(join(b, 'Google/Chrome/Application/chrome.exe')) || existsSync(join(b, 'Microsoft/Edge/Application/msedge.exe'))),
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
    runs: 30,
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

const counter = [
  'export function createCounter(el: HTMLElement): { button: HTMLButtonElement; label: HTMLElement } {',
  "  const label = document.createElement('span');",
  "  const button = document.createElement('button');",
  "  let n = 0;",
  "  label.textContent = '0';",
  "  button.addEventListener('click', () => { n += 1; label.textContent = String(n); });",
  '  el.append(label, button);',
  '  return { button, label };',
  '}',
  'export function greet(name: string): string { return `Hello, ${name}`; }',
  '',
].join('\n');

describe('browser laws', { skip: compiler === undefined || !hasBrowser() ? 'needs TSC_LAWS_BIN and a browser' : false }, () => {
  it('run against a live DOM with inputs generated in node', async () => {
    const opts = project('dom', {
      'src/ui.ts': counter,
      'src/ui.browser.laws.ts': [
        "import type { int } from 'tslaws';",
        "import { assume } from 'tslaws';",
        "import { click, mount, settle } from 'tslaws/browser';",
        "import { createCounter, greet } from './ui';",
        'export async law counterCountsClicks(clicks: int) {',
        '  assume(clicks >= 0 && clicks <= 5);',
        '  const { button, label } = createCounter(mount());',
        '  for (let i = 0; i < clicks; i++) click(button);',
        '  await settle();',
        '  return label.textContent === String(clicks);',
        '}',
        'export async law eachRunStartsClean(n: int) {',
        '  assume(n >= 0 && n <= 3);',
        '  const before = document.body.children.length;',
        '  mount(`<p>${n}</p>`);',
        '  return before === 0 && document.body.children.length === 1;',
        '}',
        'export async law greetsInTheDom(name: string) {',
        '  const el = mount();',
        '  el.textContent = greet(name);',
        '  return el.textContent === `Hello, ${name}` && getComputedStyle(el).display === "block";',
        '}',
        '',
      ].join('\n'),
    });
    const { results, ok, compileDiagnostics } = await check(opts, true);
    assert.equal(compileDiagnostics, '');
    for (const name of ['counterCountsClicks', 'eachRunStartsClean', 'greetsInTheDom']) {
      const r = byName(results, name);
      assert.equal(r.status, 'tested', JSON.stringify(r));
      assert.equal(r.method, 'browser');
    }
    assert.equal(ok, true, JSON.stringify(results));
  });

  it('report a failing browser law with a shrunk counterexample', async () => {
    const opts = project('fail', {
      'src/ui.ts': counter,
      'src/ui.browser.laws.ts': [
        "import type { int } from 'tslaws';",
        "import { assume } from 'tslaws';",
        "import { click, mount } from 'tslaws/browser';",
        "import { createCounter } from './ui';",
        'export law labelNeverShowsThree(clicks: int) {',
        '  assume(clicks >= 0 && clicks <= 5);',
        '  const { button, label } = createCounter(mount());',
        '  for (let i = 0; i < clicks; i++) click(button);',
        "  return label.textContent !== '3';",
        '}',
        '',
      ].join('\n'),
    });
    const { results, ok } = await check(opts, true);
    const r = byName(results, 'labelNeverShowsThree');
    assert.equal(r.status, 'failed', JSON.stringify(r));
    assert.equal(r.counterexample, '[3]');
    assert.ok(r.screenshot !== undefined && existsSync(join(opts.cwd, r.screenshot)), 'a screenshot of the page was kept');
    assert.equal(ok, false);
  });

  it('do not hang on a page that never finishes', async () => {
    const opts = project('hang', {
      'src/ui.ts': counter,
      'src/ui.browser.laws.ts': [
        "import type { int } from 'tslaws';",
        'export async law waitsForever(n: int) {',
        '  await new Promise(() => {});',
        '  return true;',
        '}',
        '',
      ].join('\n'),
    });
    opts.propertyTimeoutMs = 2000;
    const { results } = await check(opts, true);
    const r = byName(results, 'waitsForever');
    assert.equal(r.status, 'error', JSON.stringify(r));
    assert.match(r.message ?? '', /may not terminate/);
  });
});
