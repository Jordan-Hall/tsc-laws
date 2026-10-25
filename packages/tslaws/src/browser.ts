// Runs laws in a real browser. Node generates the inputs (from the declared types, with shrinking, like any law), and
// each input is sent to a page where the compiled law and the code it checks run against a live DOM.
import { existsSync } from 'node:fs';
import { mkdirSync } from 'node:fs';
import { delimiter, join } from 'node:path';
import { build as bundleWith, type Plugin } from 'esbuild';
import { chromium, firefox, webkit, type Browser, type BrowserType, type Page } from 'playwright-core';
import type * as fc from 'fast-check';
import { toWire } from './generators.ts';
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
      candidates.push(
        join(base, 'Google/Chrome/Application/chrome.exe'),
        join(base, 'Microsoft/Edge/Application/msedge.exe'),
      );
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

export type BrowserEngine = 'chromium' | 'firefox' | 'webkit';
const engines: BrowserEngine[] = ['chromium', 'firefox', 'webkit'];

/** The engine to use: the requested one, else `TSLAWS_BROWSER_ENGINE`, else chromium. Throws on an unknown name. */
export function resolveEngine(requested?: string, env: NodeJS.ProcessEnv = process.env): BrowserEngine {
  const name = (requested ?? env.TSLAWS_BROWSER_ENGINE ?? '').trim().toLowerCase();
  if (name === '') return 'chromium';
  if ((engines as string[]).includes(name)) return name as BrowserEngine;
  throw new Error(`unknown browser engine '${name}': use chromium, firefox or webkit`);
}

/**
 * The executable to launch for an engine. Chromium falls back to an installed Chrome or Edge; Firefox and WebKit use
 * TSLAWS_BROWSER or Playwright's own download. Throws, naming the install command, when there is none.
 */
export function engineExecutable(engine: BrowserEngine, env: NodeJS.ProcessEnv = process.env): string {
  if (engine === 'chromium') {
    const found = findBrowser();
    if (found === undefined)
      throw new Error('no browser found: install Chrome, Edge or Chromium, or set TSLAWS_BROWSER to its executable');
    return found;
  }
  const fromEnv = env.TSLAWS_BROWSER;
  let path = fromEnv !== undefined && fromEnv !== '' ? fromEnv : undefined;
  if (path === undefined) {
    try {
      path = (engine === 'firefox' ? firefox : webkit).executablePath();
    } catch {
      // Playwright has no such browser installed.
    }
  }
  if (path === undefined || !existsSync(path))
    throw new Error(
      `no ${engine} installed: run \`npx playwright install ${engine}\` or set TSLAWS_BROWSER to its executable`,
    );
  return path;
}

const browsers = new Map<BrowserEngine, Promise<Browser>>();

export function launch(engine: BrowserEngine): Promise<Browser> {
  let open = browsers.get(engine);
  if (open === undefined) {
    const type: BrowserType = { chromium, firefox, webkit }[engine];
    open = (async () => type.launch({ executablePath: engineExecutable(engine), headless: true }))();
    open.catch(() => browsers.delete(engine));
    browsers.set(engine, open);
  }
  return open;
}

export async function closeBrowser(): Promise<void> {
  const open = [...browsers.values()];
  browsers.clear();
  for (const one of open) {
    try {
      await (await one).close();
    } catch {
      // Already gone.
    }
  }
}

// Runs inside the page: the law, a clean DOM before and after, and a result that survives structured cloning.
const harness = `
window.__runLaw = async (name, args, keep, pause) => {
  const clean = () => {
    for (const undo of (window.__tslawsCleanup || []).splice(0)) { try { undo(); } catch (e) {} }
    document.body.innerHTML = '';
  };
  // Functions cannot cross into the page: generated ones arrive as { $tslawsFn: samples } and are rebuilt here.
  const revive = (v) => {
    if (Array.isArray(v)) return v.map(revive);
    if (v && typeof v === 'object') {
      if (Array.isArray(v.$tslawsFn)) {
        const samples = v.$tslawsFn;
        return (...a) => {
          let key = '';
          try { key = JSON.stringify(a) || ''; } catch (e) {}
          let h = 5381;
          for (let i = 0; i < key.length; i++) h = (Math.imul(h, 33) + key.charCodeAt(i)) | 0;
          return samples[(h >>> 0) % samples.length];
        };
      }
      return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, revive(x)]));
    }
    return v;
  };
  clean();
  try {
    const result = await window.__lawModule[name](...revive(args));
    return { ok: result !== false };
  } catch (error) {
    return { error: { name: error && error.name, message: error && error.message ? error.message : String(error) } };
  } finally {
    if (pause > 0) {
      window.__shown = true;
      await new Promise((done) => setTimeout(done, pause));
      window.__shown = false;
    }
    if (!keep) clean();
  }
};`;

// Bare imports resolve from the project's own node_modules first (a JSX runtime, a UI library, axe-core), then the
// usual way. axe-core is an optional peer dependency: without a copy the import stays for the page to fail on (a11y()
// turns that into a clear message), so projects without it still bundle.
function projectModulesPlugin(cwd: string): Plugin {
  return {
    name: 'tslaws-project-modules',
    setup(build) {
      build.onResolve({ filter: /^[^./]/ }, async (args) => {
        if (args.pluginData === 'tslaws' || args.kind === 'entry-point' || /^[a-zA-Z]:/.test(args.path))
          return undefined;
        const found = await build.resolve(args.path, { kind: args.kind, resolveDir: cwd, pluginData: 'tslaws' });
        if (found.errors.length === 0)
          return { path: found.path, external: found.external, sideEffects: found.sideEffects };
        return args.path === 'axe-core' ? { path: 'axe-core', external: true } : undefined;
      });
    },
  };
}

async function bundleOf(jsFile: string, cwd: string): Promise<string> {
  const result = await bundleWith({
    plugins: [projectModulesPlugin(cwd)],
    entryPoints: [jsFile],
    bundle: true,
    write: false,
    format: 'iife',
    globalName: '__lawModule',
    platform: 'browser',
    target: 'es2022',
    absWorkingDir: cwd,
    logLevel: 'silent',
    define: { 'process.env.NODE_ENV': '"development"', global: 'globalThis' },
  });
  return result.outputFiles[0]!.text;
}

export interface BrowserLaw {
  file: string;
  name: string;
  jsFile: string;
  generators: fc.Arbitrary<unknown>[];
}

interface PageOutcome {
  ok?: boolean;
  error?: { name?: string; message: string };
}

/** Runs the counterexample once more, leaves the DOM as it is, and photographs the page. Best effort. */
async function capture(
  page: Page,
  law: BrowserLaw,
  args: unknown[],
  options: CheckOptions,
): Promise<string | undefined> {
  try {
    await page.evaluate(
      ([name, input]) =>
        (window as unknown as { __runLaw: (n: string, a: unknown[], keep: boolean) => Promise<unknown> }).__runLaw(
          name as string,
          input as unknown[],
          true,
        ),
      [law.name, toWire(args)] as const,
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
  const page: Page = await (await launch(resolveEngine(options.browser))).newPage();
  // A watcher needs only the first few runs to linger; the rest should not eat the time limit.
  let calls = 0;
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    void page.close();
  }, options.propertyTimeoutMs ?? 30000);
  const pageErrors: string[] = [];
  page.on('pageerror', (error) => pageErrors.push(error.message));
  // While someone watches, photograph the page a few times a second.
  let framing = false;
  const frames = options.onEvent
    ? setInterval(() => {
        if (framing || page.isClosed()) return;
        framing = true;
        // Only while the law has left the page as it wants it seen, not between runs when it is empty.
        page
          .evaluate(() => (window as unknown as { __shown?: boolean }).__shown === true)
          .then((shown) => (shown ? page.screenshot({ type: 'jpeg', quality: 55, timeout: 2000 }) : undefined))
          .then((jpeg) =>
            jpeg === undefined ? undefined : options.onEvent?.({ type: 'frame', file: law.file, name: law.name, jpeg }),
          )
          .catch(() => undefined)
          .finally(() => (framing = false));
      }, 120)
    : undefined;
  try {
    await page.setContent('<!doctype html><html><head><meta charset="utf-8"></head><body></body></html>');
    await page.addScriptTag({ content: code });
    await page.addScriptTag({ content: harness });
    const call = async (...args: unknown[]): Promise<unknown> => {
      const outcome = (await page.evaluate(
        ([name, input, pause]) =>
          (
            window as unknown as {
              __runLaw: (n: string, a: unknown[], keep: boolean, pause: number) => Promise<unknown>;
            }
          ).__runLaw(name as string, input as unknown[], false, pause as number),
        [law.name, toWire(args), calls++ < 12 ? (options.browserPauseMs ?? 0) : 0] as const,
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
    const outcome = summarise(details, options);
    if (details.failed && details.counterexample !== null && !page.isClosed())
      outcome.screenshot = await capture(page, law, details.counterexample, options);
    return outcome;
  } catch (error) {
    if (timedOut) return 'timeout';
    const extra = pageErrors.length > 0 ? ` (page error: ${pageErrors[0]})` : '';
    throw new Error(`${(error as Error).message}${extra}`);
  } finally {
    clearTimeout(timer);
    if (frames !== undefined) clearInterval(frames);
    if (!page.isClosed()) await page.close();
  }
}
