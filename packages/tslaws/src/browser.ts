// Runs laws in a real browser. Node generates the inputs (from the declared types, with shrinking, like any law), and
// each input is sent to a page where the compiled law and the code it checks run against a live DOM.
import { existsSync } from 'node:fs';
import { mkdirSync } from 'node:fs';
import { delimiter, join } from 'node:path';
import { build as bundleWith } from 'esbuild';
import { chromium, type Browser, type Page } from 'playwright-core';
import type * as fc from 'fast-check';
import { runProperty, summarise, type PropertyOutcome } from './property.ts';
import type { CheckOptions } from './types.ts';

/** `a.browser.laws.ts` runs in a browser. */
export function isBrowserLawFile(file: string): boolean {
  return /\.browser\.laws\.[cm]?ts$/.test(file);
}

function findBrowser(): string | undefined {
  const fromEnv = process.env.TSLAWS_BROWSER;
  if (fromEnv !== undefined && fromEnv !== '') return fromEnv;
  const candidates: string[] = [];
  if (process.platform === 'win32') {
    for (const base of [process.env.PROGRAMFILES, process.env['PROGRAMFILES(X86)'], process.env.LOCALAPPDATA]) {
      if (base === undefined) continue;
      candidates.push(join(base, 'Google/Chrome/Application/chrome.exe'), join(base, 'Microsoft/Edge/Application/msedge.exe'));
    }
  } else if (process.platform === 'darwin') {
    candidates.push(
      '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
      '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge',
      '/Applications/Chromium.app/Contents/MacOS/Chromium',
    );
  } else {
    for (const dir of (process.env.PATH ?? '').split(delimiter)) {
      for (const name of ['google-chrome', 'google-chrome-stable', 'chromium', 'chromium-browser', 'microsoft-edge'])
        candidates.push(join(dir, name));
    }
  }
  try {
    candidates.push(chromium.executablePath());
  } catch {
    // Playwright has no browser of its own installed.
  }
  return candidates.find((c) => existsSync(c));
}

let browser: Promise<Browser> | undefined;

function launch(): Promise<Browser> {
  browser ??= (async () => {
    const executablePath = findBrowser();
    if (executablePath === undefined)
      throw new Error('no browser found: install Chrome, Edge or Chromium, or set TSLAWS_BROWSER to its executable');
    return chromium.launch({ executablePath, headless: true });
  })();
  return browser;
}

export async function closeBrowser(): Promise<void> {
  const open = browser;
  browser = undefined;
  if (open === undefined) return;
  try {
    await (await open).close();
  } catch {
    // Already gone.
  }
}

// Runs inside the page: the law, a clean DOM before and after, and a result that survives structured cloning.
const harness = `
window.__runLaw = async (name, args, keep) => {
  const clean = () => {
    for (const undo of (window.__tslawsCleanup || []).splice(0)) { try { undo(); } catch (e) {} }
    document.body.innerHTML = '';
  };
  clean();
  try {
    const result = await window.__lawModule[name](...args);
    return { ok: result !== false };
  } catch (error) {
    return { error: { name: error && error.name, message: error && error.message ? error.message : String(error) } };
  } finally {
    if (!keep) clean();
  }
};`;

async function bundleOf(jsFile: string, cwd: string): Promise<string> {
  const result = await bundleWith({
    entryPoints: [jsFile],
    bundle: true,
    write: false,
    format: 'iife',
    globalName: '__lawModule',
    platform: 'browser',
    target: 'es2022',
    absWorkingDir: cwd,
    logLevel: 'silent',
    define: { 'process.env.NODE_ENV': '"development"' },
  });
  return result.outputFiles[0]!.text;
}

export interface BrowserLaw {
  name: string;
  jsFile: string;
  generators: fc.Arbitrary<unknown>[];
}

interface PageOutcome {
  ok?: boolean;
  error?: { name?: string; message: string };
}

/** Runs the counterexample once more, leaves the DOM as it is, and photographs the page. Best effort. */
async function capture(page: Page, law: BrowserLaw, args: unknown[], options: CheckOptions): Promise<string | undefined> {
  try {
    await page.evaluate(
      ([name, input]) =>
        (window as unknown as { __runLaw: (n: string, a: unknown[], keep: boolean) => Promise<unknown> }).__runLaw(name as string, input as unknown[], true),
      [law.name, args] as const,
    );
    const relative = `.tslaws/screenshots/${law.name.replace(/[^\w-]/g, '_')}.png`;
    mkdirSync(join(options.cwd, '.tslaws/screenshots'), { recursive: true });
    await page.screenshot({ path: join(options.cwd, relative) });
    return relative;
  } catch {
    return undefined;
  }
}

/** Property-tests one law in a page; `'timeout'` when it does not finish within `options.propertyTimeoutMs`. */
export async function runBrowserLaw(law: BrowserLaw, options: CheckOptions): Promise<PropertyOutcome | 'timeout'> {
  const code = await bundleOf(law.jsFile, options.cwd);
  const page: Page = await (await launch()).newPage();
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    void page.close();
  }, options.propertyTimeoutMs ?? 30000);
  const pageErrors: string[] = [];
  page.on('pageerror', (error) => pageErrors.push(error.message));
  try {
    await page.setContent('<!doctype html><html><head><meta charset="utf-8"></head><body></body></html>');
    await page.addScriptTag({ content: code });
    await page.addScriptTag({ content: harness });
    const call = async (...args: unknown[]): Promise<unknown> => {
      const outcome = (await page.evaluate(
        ([name, input]) =>
          (window as unknown as { __runLaw: (n: string, a: unknown[]) => Promise<unknown> }).__runLaw(name as string, input as unknown[]),
        [law.name, args] as const,
      )) as PageOutcome;
      if (outcome.error !== undefined) {
        const error = new Error(outcome.error.message);
        error.name = outcome.error.name ?? 'Error';
        throw error;
      }
      return outcome.ok;
    };
    const details = await runProperty(call, law.generators, options);
    // Closing the page fails the call in flight, which the property reports as a failure of the law.
    if (timedOut) return 'timeout';
    const outcome = summarise(details);
    if (details.failed && details.counterexample !== null && !page.isClosed())
      outcome.screenshot = await capture(page, law, details.counterexample, options);
    return outcome;
  } catch (error) {
    if (timedOut) return 'timeout';
    const extra = pageErrors.length > 0 ? ` (page error: ${pageErrors[0]})` : '';
    throw new Error(`${(error as Error).message}${extra}`);
  } finally {
    clearTimeout(timer);
    if (!page.isClosed()) await page.close();
  }
}
