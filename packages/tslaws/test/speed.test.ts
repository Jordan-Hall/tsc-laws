// Speed laws in a component page: `fast()` holds work to a time budget, `blocking()` measures main-thread blocking.
// Needs Chrome, Edge or Chromium (or TSLAWS_BROWSER), the built compiler in TSC_LAWS_BIN, and `npm run build` for dist/.
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
const root = mkdtempSync(join(here, '..', '.tmp-speed-'));

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
  setTimeout(() => process.exit(process.exitCode ?? 0), 100).unref();
});

function project(name: string, source: string): CheckOptions {
  const cwd = join(root, name);
  mkdirSync(join(cwd, 'src'), { recursive: true });
  writeFileSync(join(cwd, 'src/speed.browser.laws.ts'), source);
  const options: CheckOptions = {
    files: ['src/speed.browser.laws.ts'],
    cwd,
    runs: 3,
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

const skip =
  compiler === undefined
    ? 'needs TSC_LAWS_BIN'
    : !hasBrowser()
      ? 'needs Chrome, Edge or Chromium (or TSLAWS_BROWSER)'
      : false;

const busy = (ms: number): string => `const end = performance.now() + ${ms}; while (performance.now() < end) {}`;

describe('speed laws', { skip }, () => {
  it('pass quick work and fail work over its budget', async () => {
    const opts = project(
      'fast',
      [
        "import { assume } from 'tslaws';",
        "import type { int } from 'tslaws';",
        "import { fast } from 'tslaws/browser';",
        'export async law quickWorkIsFast(n: int) {',
        '  assume(n >= 0 && n <= 1);',
        '  return await fast(() => { let s = 0; for (let i = 0; i < 1000; i++) s += i; return s; }, 100, 3);',
        '}',
        'export async law slowWorkIsOverBudget(n: int) {',
        '  assume(n >= 0 && n <= 1);',
        `  return await fast(() => { ${busy(80)} }, 20, 3);`,
        '}',
        '',
      ].join('\n'),
    );
    const { results } = await check(opts, true);
    assert.equal(byName(results, 'quickWorkIsFast').status, 'tested', JSON.stringify(results));
    assert.equal(byName(results, 'slowWorkIsOverBudget').status, 'failed', JSON.stringify(results));
  });

  it('measure main-thread blocking with blocking()', async () => {
    const opts = project(
      'blocking',
      [
        "import { assume } from 'tslaws';",
        "import type { int } from 'tslaws';",
        "import { blocking, measure } from 'tslaws/browser';",
        'export async law longTaskIsSeen(n: int) {',
        '  assume(n >= 0 && n <= 1);',
        `  return (await blocking(() => { ${busy(200)} })) >= 100;`,
        '}',
        'export async law measureReportsOrderedTimings(n: int) {',
        '  assume(n >= 0 && n <= 1);',
        `  const t = await measure(() => { ${busy(10)} }, 5);`,
        '  return t.runs === 5 && t.min <= t.median && t.median <= t.p95 && t.p95 <= t.max && t.min >= 9;',
        '}',
        '',
      ].join('\n'),
    );
    const { results } = await check(opts, true);
    assert.equal(byName(results, 'longTaskIsSeen').status, 'tested', JSON.stringify(results));
    assert.equal(byName(results, 'measureReportsOrderedTimings').status, 'tested', JSON.stringify(results));
  });
});
