// Accessibility laws: `accessible()` audits a mounted component with axe-core. Needs Chrome, Edge or Chromium (or
// TSLAWS_BROWSER), axe-core in node_modules, the built compiler in TSC_LAWS_BIN, and `npm run build` for dist/.
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { after, describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';
import { check } from '../dist/check.js';
import { readManifest } from '../dist/compile.js';
import { writeLock } from '../dist/lock.js';
import type { CheckOptions, LawResult } from '../dist/types.js';

const compiler = process.env.TSC_LAWS_BIN;
const here = dirname(fileURLToPath(import.meta.url));
const root = mkdtempSync(join(here, '..', '.tmp-a11y-'));

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

function hasAxe(): boolean {
  try {
    createRequire(join(here, '..', 'package.json')).resolve('axe-core');
    return true;
  } catch {
    return false;
  }
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
    runs: 5,
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

const skip =
  compiler === undefined
    ? 'needs TSC_LAWS_BIN'
    : !hasBrowser()
      ? 'needs Chrome, Edge or Chromium (or TSLAWS_BROWSER)'
      : !hasAxe()
        ? 'needs axe-core in node_modules (npm i -D axe-core)'
        : false;

const lawFile = [
  "import { assume } from 'tslaws';",
  "import type { int } from 'tslaws';",
  "import { accessible, mount } from 'tslaws/browser';",
  "import { render } from './ui';",
  'export async law imageIsAccessible(n: int) {',
  '  assume(n >= 0 && n <= 1);',
  '  return await accessible(render(mount()));',
  '}',
  '',
].join('\n');

const component = (img: string): string =>
  [
    'export function render(el: HTMLElement): HTMLElement {',
    `  el.innerHTML = '${img}';`,
    '  return el;',
    '}',
    '',
  ].join('\n');

describe('accessibility laws', { skip }, () => {
  it('fail on an image without alt text', async () => {
    const opts = project('bad', {
      'src/ui.ts': component('<img src="data:image/gif;base64,R0lGODlhAQABAAAAACw=">'),
      'src/ui.browser.laws.ts': lawFile,
    });
    const { results, ok } = await check(opts, true);
    const r = byName(results, 'imageIsAccessible');
    assert.equal(r.status, 'failed', JSON.stringify(r));
    assert.equal(ok, false);
  });

  it('pass once the image has alt text', async () => {
    const opts = project('good', {
      'src/ui.ts': component('<img alt="A pixel" src="data:image/gif;base64,R0lGODlhAQABAAAAACw=">'),
      'src/ui.browser.laws.ts': lawFile,
    });
    const { results, ok } = await check(opts, true);
    const r = byName(results, 'imageIsAccessible');
    assert.equal(r.status, 'tested', JSON.stringify(r));
    assert.equal(r.method, 'browser');
    assert.equal(ok, true, JSON.stringify(results));
  });

  it('report the violation through a11y()', async () => {
    const opts = project('detail', {
      'src/ui.ts': component('<img src="data:image/gif;base64,R0lGODlhAQABAAAAACw=">'),
      'src/ui.browser.laws.ts': [
        "import { assume } from 'tslaws';",
        "import type { int } from 'tslaws';",
        "import { a11y, mount } from 'tslaws/browser';",
        "import { render } from './ui';",
        'export async law reportsImageAlt(n: int) {',
        '  assume(n >= 0 && n <= 1);',
        '  const { violations } = await a11y(render(mount()));',
        "  return violations.length === 1 && violations[0]!.id === 'image-alt' && violations[0]!.nodes[0]!.startsWith('<img');",
        '}',
        '',
      ].join('\n'),
    });
    const { results } = await check(opts, true);
    assert.equal(byName(results, 'reportsImageAlt').status, 'tested', JSON.stringify(results));
  });
});
