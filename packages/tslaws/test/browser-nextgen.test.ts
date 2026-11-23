// Next-gen browser runner (Phase 3): real HTTP origin (localStorage, History API, window.top === window.self),
// parallel BrowserContext pool, `page` vs `iframe` isolation modes, in-browser fast-check execution,
// trusted Playwright `user.*` interactions (`isTrusted: true`), and `mock()` network interception.
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { after, describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';
import { check } from '../dist/check.js';
import { readManifest } from '../dist/compile.js';
import { parseConfig } from '../dist/coverage.js';
import { writeLock } from '../dist/lock.js';
import type { CheckOptions, LawResult } from '../dist/types.js';

const here = dirname(fileURLToPath(import.meta.url));
const root = mkdtempSync(join(here, '..', '.tmp-browser-nextgen-'));

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

after(() => {
  rmSync(root, { recursive: true, force: true });
});

function project(name: string, files: Record<string, string>, extra: Partial<CheckOptions> = {}): CheckOptions {
  const cwd = join(root, name);
  for (const [file, text] of Object.entries(files)) {
    mkdirSync(dirname(join(cwd, file)), { recursive: true });
    writeFileSync(join(cwd, file), text);
  }
  const lawFiles = Object.keys(files).filter((f) => f.endsWith('.laws.ts'));
  const options: CheckOptions = {
    files: lawFiles,
    cwd,
    runs: 15,
    compiler: 'builtin',
    lockFile: join(cwd, 'tsc-laws.lock'),
    noProve: false,
    bound: 4,
    proofTimeoutMs: 5000,
    propertyTimeoutMs: 25000,
    ...extra,
  };
  writeLock(options.lockFile, readManifest('builtin', options.files, cwd));
  return options;
}

function byName(results: LawResult[], name: string): LawResult {
  const found = results.find((r) => r.name === name);
  assert.ok(found, `no result for ${name}: ${JSON.stringify(results)}`);
  return found;
}

describe('"browser" config validation', () => {
  it('accepts valid browser options and rejects invalid ones', () => {
    const ok = parseConfig({
      browser: {
        isolation: 'page',
        headless: true,
        viewport: { width: 1280, height: 800 },
        colorScheme: 'dark',
        vite: 'auto',
        inBrowser: true,
        traceOnFailure: false,
      },
    });
    assert.equal(ok.browser?.isolation, 'page');
    assert.equal(ok.browser?.colorScheme, 'dark');
    assert.throws(() => parseConfig({ browser: { isolation: 'shadow' } }), /"browser\.isolation"/);
    assert.throws(() => parseConfig({ browser: { unknownKey: true } }), /"browser\.unknownKey"/);
    assert.throws(() => parseConfig({ browser: { viewport: { width: 0, height: 100 } } }), /"browser\.viewport"/);
  });
});

describe('next-gen browser runner', { skip: !hasBrowser() ? 'needs Chrome, Edge or Chromium' : false }, () => {
  it('runs page mode on a real HTTP origin with top-level window, localStorage, History API and isolated storage', async () => {
    const opts = project('real-origin', {
      'src/app.browser.laws.ts': [
        "import { law, type intRange } from 'tslaws';",
        "import { mount } from 'tslaws/browser';",
        "law('runs as a real top-level page on an HTTP origin', (n: intRange<1, 10>) => {",
        '  if (window.top !== window.self) return false;',
        "  if (!window.location.origin.startsWith('http://127.0.0.1:')) return false;",
        '  // localStorage starts clean on every generated input.',
        "  if (localStorage.getItem('k') !== null) return false;",
        "  localStorage.setItem('k', String(n));",
        "  history.pushState({ n }, '', `/step/${n}`);",
        '  const el = mount(`<p>${window.location.pathname}</p>`);',
        "  return localStorage.getItem('k') === String(n) && el.textContent === `/step/${n}`;",
        '});',
        '',
      ].join('\n'),
    });
    const report = await check(opts, true);
    assert.equal(report.compileDiagnostics, '');
    const r = byName(report.results, 'runs as a real top-level page on an HTTP origin');
    assert.equal(r.status, 'tested', JSON.stringify(r));
    assert.equal(r.method, 'browser');
    assert.equal(report.ok, true);
  });

  it('supports opt-in Vitest-style iframe isolation mode', async () => {
    const opts = project(
      'iframe-mode',
      {
        'src/frame.browser.laws.ts': [
          "import { law, type intRange } from 'tslaws';",
          "import { mount } from 'tslaws/browser';",
          "law('runs inside an isolated iframe when requested', (n: intRange<1, 5>) => {",
          '  const el = mount(`<span>${n}</span>`);',
          '  return window.top !== window.self && el.textContent === String(n);',
          '});',
          '',
        ].join('\n'),
      },
      { browserIsolation: 'iframe' },
    );
    const report = await check(opts, true);
    const r = byName(report.results, 'runs inside an isolated iframe when requested');
    assert.equal(r.status, 'tested', JSON.stringify(r));
    assert.equal(report.ok, true);
  });

  it('supports trusted Playwright user.* interactions (isTrusted === true) and mock() network routing', async () => {
    const opts = project('trusted-and-mock', {
      'src/interactions.browser.laws.ts': [
        "import { law, type intRange } from 'tslaws';",
        "import { mock, mount, user } from 'tslaws/browser';",
        "law('user.click fires real trusted events and user.fill updates inputs', async (n: intRange<1, 5>) => {",
        '  const root = mount(`<button id="btn">Go</button><input id="inp" type="text" />`);',
        '  const state = { trusted: false };',
        "  const btn = root.querySelector('#btn') as HTMLButtonElement;",
        "  const inp = root.querySelector('#inp') as HTMLInputElement;",
        "  btn.addEventListener('click', (e) => { state.trusted = e.isTrusted; });",
        '  await user.click(btn);',
        '  await user.fill(inp, `val-${n}`);',
        '  return state.trusted === true && inp.value === `val-${n}`;',
        '});',
        "law('mock intercepts fetch requests in browser laws', async (stock: intRange<1, 50>) => {",
        "  await mock('**/api/stock', { json: { stock } });",
        "  const res = await fetch('/api/stock');",
        '  const data = (await res.json()) as { stock: number };',
        '  return res.ok && data.stock === stock;',
        '});',
        '',
      ].join('\n'),
    });
    const report = await check(opts, true);
    assert.equal(report.compileDiagnostics, '');
    assert.equal(
      byName(report.results, 'user.click fires real trusted events and user.fill updates inputs').status,
      'tested',
    );
    assert.equal(byName(report.results, 'mock intercepts fetch requests in browser laws').status, 'tested');
    assert.equal(report.ok, true);
  });

  it('shrinks failing in-browser property tests and captures a screenshot', async () => {
    const opts = project('inbrowser-fail', {
      'src/fail.browser.laws.ts': [
        "import { law, type intRange } from 'tslaws';",
        "import { mount } from 'tslaws/browser';",
        "law('fails at 3 or above', (n: intRange<0, 8>) => {",
        '  mount(`<h1>${n}</h1>`);',
        '  return n < 3;',
        '});',
        '',
      ].join('\n'),
    });
    const report = await check(opts, true);
    const r = byName(report.results, 'fails at 3 or above');
    assert.equal(r.status, 'failed', JSON.stringify(r));
    assert.equal(r.counterexample, '[3]');
    assert.ok(r.screenshot !== undefined && existsSync(join(opts.cwd, r.screenshot)));
  });
});
