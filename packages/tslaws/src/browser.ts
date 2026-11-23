// Runs browser laws in a real browser over a local HTTP ESM origin (see browserServer.ts) with parallel BrowserContext
// isolation: top-level `page` mode by default (`window.top === window.self`, isolated cookies/localStorage/IndexedDB)
// or opt-in `iframe` mode (Vitest style). Supports in-browser fast-check execution (zero per-input IPC), trusted
// Playwright interactions (`user.*`) and network mocking (`mock()`) via `exposeBinding`, headed debugging, and
// optional Playwright traces on failure.
import { existsSync, mkdirSync } from 'node:fs';
import { createRequire } from 'node:module';
import { delimiter, join } from 'node:path';
import type { Browser, BrowserContext, BrowserType, Frame, Page, Route } from 'playwright-core';
import type * as fc from 'fast-check';
import { bundleLawFile, closeBrowserServer, ensureBrowserServer } from './browserServer.ts';
import { readConfig, type BrowserConfig } from './coverage.ts';
import { toWire } from './generators.ts';
import type { Plan } from './plan.ts';
import { runProperty, summarise, type PropertyOutcome } from './property.ts';
import type { CheckOptions } from './types.ts';

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
    candidates.push(engineType('chromium').executablePath());
  } catch {
    // Playwright has no browser of its own installed.
  }
  return candidates.find((c) => existsSync(c));
}

/**
 * Playwright, loaded when a browser law needs it. It probes the machine when it loads (for WSL, by reading `/proc` and
 * `/run`), which a law process in the sandbox may not do, and a node law has no use for it.
 */
let playwright: typeof import('playwright-core') | undefined;
const engineType = (engine: BrowserEngine): BrowserType =>
  (playwright ??= createRequire(import.meta.url)('playwright-core') as typeof import('playwright-core'))[engine];

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
      path = engineType(engine).executablePath();
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

const browsers = new Map<string, Promise<Browser>>();

export function launch(engine: BrowserEngine, headless = true): Promise<Browser> {
  const key = `${engine}:${headless ? 'headless' : 'headed'}`;
  let open = browsers.get(key);
  if (open === undefined) {
    const type = engineType(engine);
    open = (async () => type.launch({ executablePath: engineExecutable(engine), headless }))();
    open.catch(() => browsers.delete(key));
    browsers.set(key, open);
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
  await closeBrowserServer();
}

export interface BrowserLaw {
  file: string;
  name: string;
  /** The exported function the law lowers to; defaults to `name`. */
  symbol?: string;
  jsFile: string;
  generators: fc.Arbitrary<unknown>[];
  /** Serialized generator plans for zero-IPC in-browser fast-check execution. */
  plans?: Plan[];
}

interface PageOutcome {
  ok?: boolean;
  discarded?: boolean;
  error?: { name?: string; message: string; stack?: string };
}

interface BridgeCommand {
  action:
    | 'click'
    | 'dblClick'
    | 'hover'
    | 'focus'
    | 'fill'
    | 'type'
    | 'press'
    | 'keyboard'
    | 'select'
    | 'setViewport'
    | 'mock'
    | 'resetMocks';
  selector?: string;
  text?: string;
  key?: string;
  values?: string | string[];
  width?: number;
  height?: number;
  urlPattern?: string;
  response?: {
    status?: number;
    body?: string;
    json?: unknown;
    headers?: Record<string, string>;
    contentType?: string;
  };
}

/** Whether `plans` can execute fast-check directly inside the browser (no custom Node-only registered arbitraries). */
function canRunInBrowser(plans: Plan[] | undefined): boolean {
  if (plans === undefined) return false;
  const ok = (p: Plan): boolean => {
    switch (p.k) {
      case 'named':
        // Built-in refinement / primitive named types live in plan.ts; custom user arbitraries may only exist in Node.
        return (
          p.name === 'int' ||
          p.name === 'nat' ||
          p.name === 'posInt' ||
          p.name === 'nonZeroInt' ||
          p.name === 'asciiString' ||
          p.security === true
        );
      case 'array':
      case 'nonEmpty':
      case 'dict':
        return ok(p.of);
      case 'fn':
        return ok(p.returns);
      case 'union':
        return p.of.every(ok);
      case 'template':
        return p.parts.every(ok);
      case 'tuple':
        return p.required.every(ok) && p.optional.every(ok);
      case 'record':
        return Object.values(p.fields).every(ok);
      default:
        return true;
    }
  };
  return plans.every(ok);
}

/** Wires `window.__tslawsBridge` on `page` so browser laws can call trusted Playwright `user.*` and `mock()` helpers. */
async function installBridge(
  context: BrowserContext,
  page: Page,
  targetFrame: () => Frame,
): Promise<() => Promise<void>> {
  const routes: { pattern: string; handler: (route: Route) => Promise<void> }[] = [];
  const clearMocks = async (): Promise<void> => {
    for (const r of routes.splice(0)) {
      await context.unroute(r.pattern, r.handler).catch(() => undefined);
    }
  };
  await page.exposeBinding('__tslawsBridge', async (_source, command: BridgeCommand) => {
    const frame = targetFrame();
    switch (command.action) {
      case 'click':
        await frame.locator(command.selector!).click();
        return;
      case 'dblClick':
        await frame.locator(command.selector!).dblclick();
        return;
      case 'hover':
        await frame.locator(command.selector!).hover();
        return;
      case 'focus':
        await frame.locator(command.selector!).focus();
        return;
      case 'fill':
        await frame.locator(command.selector!).fill(command.text ?? '');
        return;
      case 'type':
        await frame.locator(command.selector!).pressSequentially(command.text ?? '');
        return;
      case 'press':
        await page.keyboard.press(command.key ?? '');
        return;
      case 'keyboard':
        await page.keyboard.type(command.text ?? '');
        return;
      case 'select':
        await frame.locator(command.selector!).selectOption(command.values ?? []);
        return;
      case 'setViewport':
        await page.setViewportSize({ width: command.width ?? 1000, height: command.height ?? 720 });
        return;
      case 'mock': {
        const pattern = command.urlPattern ?? '**/*';
        const resp = command.response ?? {};
        const handler = async (route: Route): Promise<void> => {
          await route.fulfill({
            status: resp.status ?? 200,
            headers: resp.headers,
            contentType: resp.contentType ?? (resp.json !== undefined ? 'application/json' : undefined),
            body: resp.json !== undefined ? JSON.stringify(resp.json) : (resp.body ?? ''),
          });
        };
        routes.push({ pattern, handler });
        await context.route(pattern, handler);
        return;
      }
      case 'resetMocks':
        await clearMocks();
        return;
    }
  });
  return clearMocks;
}

/** Runs the counterexample once more, leaves the DOM as it is, and photographs the page. Best effort. */
async function capture(
  page: Page,
  frame: Frame,
  law: BrowserLaw,
  args: unknown[],
  options: CheckOptions,
): Promise<string | undefined> {
  try {
    await frame.evaluate(
      ([name, input]) =>
        (window as unknown as { __runLaw: (n: string, a: unknown[], keep: boolean) => Promise<unknown> }).__runLaw(
          name as string,
          input as unknown[],
          true,
        ),
      [law.symbol ?? law.name, toWire(args)] as const,
    );
    const relative = `.tslaws/screenshots/${law.name.replace(/[^\w-]/g, '_')}.png`;
    mkdirSync(join(options.cwd, '.tslaws/screenshots'), { recursive: true });
    await page.screenshot({ path: join(options.cwd, relative) });
    return relative;
  } catch {
    return undefined;
  }
}

/** Property-tests one browser law on a real HTTP origin with configurable `page` (default) or `iframe` isolation. */
export async function runBrowserLaw(law: BrowserLaw, options: CheckOptions): Promise<PropertyOutcome | 'timeout'> {
  const browserConfig: BrowserConfig = readConfig(options.cwd).browser ?? {};
  const isolation = options.browserIsolation ?? browserConfig.isolation ?? 'page';
  const headless = options.headed === true ? false : (browserConfig.headless ?? true);
  const viewport = browserConfig.viewport ?? { width: 1000, height: 720 };
  const colorScheme = browserConfig.colorScheme;
  const traceOnFailure = browserConfig.traceOnFailure === true;

  const [bundled, baseUrl] = await Promise.all([
    bundleLawFile(law.jsFile, options.cwd),
    ensureBrowserServer(options.cwd, browserConfig.vite),
  ]);
  const browser = await launch(resolveEngine(options.browser), headless);
  const context = await browser.newContext({ viewport, ...(colorScheme === undefined ? {} : { colorScheme }) });
  if (traceOnFailure) await context.tracing.start({ screenshots: true, snapshots: true }).catch(() => undefined);
  const page = await context.newPage();

  const useInBrowserFc =
    browserConfig.inBrowser !== false &&
    options.onEvent === undefined &&
    !(options.browserPauseMs !== undefined && options.browserPauseMs > 0) &&
    canRunInBrowser(law.plans);

  let activeFrame: Frame = page.mainFrame();
  let calls = 0;
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    void context.close().catch(() => undefined);
  }, options.propertyTimeoutMs ?? 30000);

  const pageErrors: string[] = [];
  page.on('pageerror', (error) => pageErrors.push(error.message));

  // While someone watches (`tslaws ui`), photograph the page a few times a second.
  let framing = false;
  const frames = options.onEvent
    ? setInterval(() => {
        if (framing || page.isClosed()) return;
        framing = true;
        activeFrame
          .evaluate(() => (window as unknown as { __shown?: boolean }).__shown === true)
          .then((shown) => (shown ? page.screenshot({ type: 'jpeg', quality: 55, timeout: 2000 }) : undefined))
          .then((jpeg) =>
            jpeg === undefined ? undefined : options.onEvent?.({ type: 'frame', file: law.file, name: law.name, jpeg }),
          )
          .catch(() => undefined)
          .finally(() => (framing = false));
      }, 120)
    : undefined;

  let clearMocks: (() => Promise<void>) | undefined;
  let failed = false;
  try {
    clearMocks = await installBridge(context, page, () => activeFrame);
    const pageUrl = `${baseUrl}/__tslaws/page?id=${encodeURIComponent(bundled.id)}${useInBrowserFc ? '&fc=1' : ''}`;
    if (isolation === 'iframe') {
      await page.goto(`${baseUrl}/__tslaws/host`, { waitUntil: 'load' });
      await page.evaluate(
        (src) => (window as unknown as { __tslawsMountFrame: (s: string) => Promise<void> }).__tslawsMountFrame(src),
        pageUrl,
      );
      const child = page.frame({ name: 'tslaws-law-frame' });
      if (child === null) throw new Error('failed to mount isolated browser iframe');
      activeFrame = child;
      // Forward bridge calls from the iframe window to the top-level exposed binding.
      await activeFrame.evaluate(() => {
        (window as unknown as { __tslawsBridge?: unknown }).__tslawsBridge = (
          window.parent as unknown as { __tslawsBridge?: unknown }
        ).__tslawsBridge;
      });
    } else {
      await page.goto(pageUrl, { waitUntil: 'load' });
      activeFrame = page.mainFrame();
    }

    if (useInBrowserFc) {
      const outcome = (await activeFrame.evaluate(
        (spec) =>
          (
            window as unknown as {
              __runPropertyInBrowser: (s: unknown) => Promise<PropertyOutcome & { rawCounterexample?: unknown[] }>;
            }
          ).__runPropertyInBrowser(spec),
        {
          symbol: law.symbol ?? law.name,
          plans: law.plans,
          runs: options.runs,
          seed: options.seed,
          regressionExamples: options.regressionExamples,
        },
      )) as PropertyOutcome & { rawCounterexample?: unknown[] };
      if (timedOut) return 'timeout';
      const rawCounterexample = outcome.rawCounterexample;
      delete outcome.rawCounterexample;
      if (outcome.failed && rawCounterexample !== undefined && !page.isClosed()) {
        failed = true;
        outcome.screenshot = await capture(page, activeFrame, law, rawCounterexample, options);
      }
      return outcome;
    }

    const call = async (...args: unknown[]): Promise<unknown> => {
      const outcome = (await activeFrame.evaluate(
        ([name, input, pause]) =>
          (
            window as unknown as {
              __runLaw: (n: string, a: unknown[], keep: boolean, pause: number) => Promise<unknown>;
            }
          ).__runLaw(name as string, input as unknown[], false, pause as number),
        [law.symbol ?? law.name, toWire(args), calls++ < 12 ? (options.browserPauseMs ?? 0) : 0] as const,
      )) as PageOutcome;
      if (outcome.discarded === true) {
        const discard = new Error('law input discarded');
        discard.name = 'LawDiscard';
        throw discard;
      }
      if (outcome.error !== undefined) {
        const error = new Error(outcome.error.message);
        error.name = outcome.error.name ?? 'Error';
        if (outcome.error.stack !== undefined) error.stack = outcome.error.stack;
        throw error;
      }
      return outcome.ok;
    };
    const details = await runProperty(call, law.generators, options);
    if (timedOut) return 'timeout';
    const outcome = summarise(details, options);
    if (details.failed && details.counterexample !== null && !page.isClosed()) {
      failed = true;
      outcome.screenshot = await capture(page, activeFrame, law, details.counterexample, options);
    }
    return outcome;
  } catch (error) {
    if (timedOut) return 'timeout';
    const extra = pageErrors.length > 0 ? ` (page error: ${pageErrors[0]})` : '';
    throw new Error(`${(error as Error).message}${extra}`);
  } finally {
    clearTimeout(timer);
    if (frames !== undefined) clearInterval(frames);
    if (traceOnFailure) {
      if (failed) {
        const traceDir = join(options.cwd, '.tslaws', 'traces');
        mkdirSync(traceDir, { recursive: true });
        await context.tracing
          .stop({ path: join(traceDir, `${law.name.replace(/[^\w-]/g, '_')}.zip`) })
          .catch(() => undefined);
      } else {
        await context.tracing.stop().catch(() => undefined);
      }
    }
    await clearMocks?.().catch(() => undefined);
    await context.close().catch(() => undefined);
  }
}
