// Runs browser laws in a real browser over a local HTTP ESM origin (see browserServer.ts) with parallel BrowserContext
// isolation: top-level `page` mode by default (`window.top === window.self`, isolated cookies/localStorage/IndexedDB)
// or opt-in `iframe` mode (Vitest style). Supports in-browser fast-check execution (zero per-input IPC), trusted
// Playwright interactions (`user.*`) and network mocking (`mock()`) via `exposeBinding`, headed debugging, and
// optional Playwright traces on failure.
import { existsSync, mkdirSync } from 'node:fs';
import { createRequire } from 'node:module';
import { delimiter, dirname, join, resolve } from 'node:path';
import type { Browser, BrowserContext, BrowserType, Frame, Locator as PwLocator, Page, Route } from 'playwright-core';
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

type WirePattern = string | { __re: true; source: string; flags: string };

type LocatorStep =
  | { k: 'css'; selector: string }
  | { k: 'role'; role: string; options?: Record<string, unknown> }
  | { k: 'text'; text: WirePattern; exact?: boolean }
  | { k: 'label'; text: WirePattern; exact?: boolean }
  | { k: 'placeholder'; text: WirePattern; exact?: boolean }
  | { k: 'testId'; testId: string }
  | { k: 'altText'; text: WirePattern; exact?: boolean }
  | { k: 'title'; text: WirePattern; exact?: boolean }
  | { k: 'first' }
  | { k: 'last' }
  | { k: 'nth'; index: number }
  | {
      k: 'filter';
      hasText?: WirePattern;
      hasNotText?: WirePattern;
      has?: LocatorStep[];
      hasNot?: LocatorStep[];
    };

interface BridgeCommand {
  action:
    | 'click'
    | 'dblClick'
    | 'tripleClick'
    | 'hover'
    | 'unhover'
    | 'focus'
    | 'fill'
    | 'clear'
    | 'type'
    | 'press'
    | 'keyboard'
    | 'tab'
    | 'select'
    | 'check'
    | 'uncheck'
    | 'dragAndDrop'
    | 'setViewport'
    | 'screenshot'
    | 'count'
    | 'isVisible'
    | 'isEnabled'
    | 'isChecked'
    | 'textContent'
    | 'inputValue'
    | 'getAttribute'
    | 'waitFor'
    | 'markElements'
    | 'mock'
    | 'resetMocks';
  locator?: LocatorStep[];
  targetLocator?: LocatorStep[];
  selector?: string;
  text?: string;
  key?: string;
  name?: string;
  values?: string | string[];
  shift?: boolean;
  button?: 'left' | 'right' | 'middle';
  force?: boolean;
  width?: number;
  height?: number;
  path?: string;
  fullPage?: boolean;
  state?: 'visible' | 'hidden' | 'attached' | 'detached';
  timeout?: number;
  token?: string;
  urlPattern?: string;
  response?: {
    status?: number;
    body?: string;
    json?: unknown;
    headers?: Record<string, string>;
    contentType?: string;
  };
}

function revivePattern(p: WirePattern): string | RegExp {
  return typeof p === 'string' ? p : new RegExp(p.source, p.flags);
}

function reviveRoleOptions(options: Record<string, unknown> | undefined): Record<string, unknown> | undefined {
  if (options === undefined) return undefined;
  const out: Record<string, unknown> = { ...options };
  if (typeof out.name === 'object' && out.name !== null && '__re' in out.name) {
    out.name = revivePattern(out.name as WirePattern);
  }
  return out;
}

/** Translates a serialized LocatorStep chain from `browserApi.ts` into a native Playwright Locator on `frame`. */
function resolveLocator(frame: Frame, steps: readonly LocatorStep[]): PwLocator {
  if (steps.length === 0) throw new Error('empty locator chain');
  let current: Frame | PwLocator = frame;
  for (const step of steps) {
    switch (step.k) {
      case 'css':
        current = current.locator(step.selector);
        break;
      case 'role':
        current = current.getByRole(
          step.role as Parameters<Frame['getByRole']>[0],
          reviveRoleOptions(step.options) as Parameters<Frame['getByRole']>[1],
        );
        break;
      case 'text':
        current = current.getByText(
          revivePattern(step.text),
          step.exact === undefined ? undefined : { exact: step.exact },
        );
        break;
      case 'label':
        current = current.getByLabel(
          revivePattern(step.text),
          step.exact === undefined ? undefined : { exact: step.exact },
        );
        break;
      case 'placeholder':
        current = current.getByPlaceholder(
          revivePattern(step.text),
          step.exact === undefined ? undefined : { exact: step.exact },
        );
        break;
      case 'testId':
        current = current.getByTestId(step.testId);
        break;
      case 'altText':
        current = current.getByAltText(
          revivePattern(step.text),
          step.exact === undefined ? undefined : { exact: step.exact },
        );
        break;
      case 'title':
        current = current.getByTitle(
          revivePattern(step.text),
          step.exact === undefined ? undefined : { exact: step.exact },
        );
        break;
      case 'first':
        current = (current as PwLocator).first();
        break;
      case 'last':
        current = (current as PwLocator).last();
        break;
      case 'nth':
        current = (current as PwLocator).nth(step.index);
        break;
      case 'filter':
        current = (current as PwLocator).filter({
          ...(step.hasText === undefined ? {} : { hasText: revivePattern(step.hasText) }),
          ...(step.hasNotText === undefined ? {} : { hasNotText: revivePattern(step.hasNotText) }),
          ...(step.has === undefined ? {} : { has: resolveLocator(frame, step.has) }),
          ...(step.hasNot === undefined ? {} : { hasNot: resolveLocator(frame, step.hasNot) }),
        });
        break;
    }
  }
  return current as PwLocator;
}

const keyAliases: Record<string, string> = {
  Space: ' ',
  Esc: 'Escape',
  Del: 'Delete',
  Ctrl: 'Control',
};

/** Executes a Vitest-style `userEvent.keyboard` sequence (supporting `{Enter}`, `{Shift>}a{/Shift}`, and literal text). */
async function runKeyboard(page: Page, input: string): Promise<void> {
  const held: string[] = [];
  let i = 0;
  let literal = '';
  const flushLiteral = async (): Promise<void> => {
    if (literal === '') return;
    await page.keyboard.type(literal);
    literal = '';
  };
  try {
    while (i < input.length) {
      if (input[i] === '{' && input[i + 1] === '{') {
        literal += '{';
        i += 2;
        continue;
      }
      if (input[i] === '}' && input[i + 1] === '}') {
        literal += '}';
        i += 2;
        continue;
      }
      if (input[i] === '{') {
        const close = input.indexOf('}', i + 1);
        if (close !== -1) {
          await flushLiteral();
          const token = input.slice(i + 1, close);
          if (token.startsWith('/')) {
            const raw = token.slice(1);
            const key = keyAliases[raw] ?? raw;
            await page.keyboard.up(key);
            const idx = held.lastIndexOf(key);
            if (idx !== -1) held.splice(idx, 1);
          } else if (token.endsWith('>')) {
            const raw = token.slice(0, -1);
            const key = keyAliases[raw] ?? raw;
            held.push(key);
            await page.keyboard.down(key);
          } else {
            const key = keyAliases[token] ?? token;
            await page.keyboard.press(key);
          }
          i = close + 1;
          continue;
        }
      }
      literal += input[i]!;
      i += 1;
    }
    await flushLiteral();
  } finally {
    for (const key of held.reverse()) await page.keyboard.up(key).catch(() => undefined);
  }
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

/** Wires `window.__tslawsBridge` on `page` so browser laws can drive Playwright locators, `page`, `userEvent`, and `mock()`. */
async function installBridge(
  context: BrowserContext,
  page: Page,
  targetFrame: () => Frame,
  cwd: string,
): Promise<() => Promise<void>> {
  const routes: { pattern: string; handler: (route: Route) => Promise<void> }[] = [];
  const clearMocks = async (): Promise<void> => {
    for (const r of routes.splice(0)) {
      await context.unroute(r.pattern, r.handler).catch(() => undefined);
    }
  };
  const locatorOf = (frame: Frame, command: BridgeCommand): PwLocator => {
    if (command.locator !== undefined) return resolveLocator(frame, command.locator);
    return frame.locator(command.selector!);
  };
  await page.exposeBinding('__tslawsBridge', async (_source, command: BridgeCommand) => {
    const frame = targetFrame();
    switch (command.action) {
      case 'click':
        await locatorOf(frame, command).click({
          ...(command.button === undefined ? {} : { button: command.button }),
          ...(command.force === undefined ? {} : { force: command.force }),
        });
        return;
      case 'dblClick':
        await locatorOf(frame, command).dblclick({
          ...(command.button === undefined ? {} : { button: command.button }),
          ...(command.force === undefined ? {} : { force: command.force }),
        });
        return;
      case 'tripleClick':
        await locatorOf(frame, command).click({
          clickCount: 3,
          ...(command.button === undefined ? {} : { button: command.button }),
          ...(command.force === undefined ? {} : { force: command.force }),
        });
        return;
      case 'hover':
        await locatorOf(frame, command).hover(command.force === undefined ? undefined : { force: command.force });
        return;
      case 'unhover':
        await page.mouse.move(0, 0);
        return;
      case 'focus':
        await locatorOf(frame, command).focus();
        return;
      case 'fill':
        await locatorOf(frame, command).fill(command.text ?? '');
        return;
      case 'clear':
        await locatorOf(frame, command).clear();
        return;
      case 'type':
        await locatorOf(frame, command).pressSequentially(command.text ?? '');
        return;
      case 'press':
        if (command.locator !== undefined || command.selector !== undefined)
          await locatorOf(frame, command).press(command.key ?? '');
        else await page.keyboard.press(command.key ?? '');
        return;
      case 'keyboard':
        await runKeyboard(page, command.text ?? '');
        return;
      case 'tab':
        await page.keyboard.press(command.shift === true ? 'Shift+Tab' : 'Tab');
        return;
      case 'select':
        await locatorOf(frame, command).selectOption(command.values ?? []);
        return;
      case 'check':
        await locatorOf(frame, command).check(command.force === undefined ? undefined : { force: command.force });
        return;
      case 'uncheck':
        await locatorOf(frame, command).uncheck(command.force === undefined ? undefined : { force: command.force });
        return;
      case 'dragAndDrop': {
        const source = locatorOf(frame, command);
        const target = resolveLocator(frame, command.targetLocator!);
        await source.dragTo(target);
        return;
      }
      case 'setViewport':
        await page.setViewportSize({ width: command.width ?? 1000, height: command.height ?? 720 });
        return;
      case 'screenshot': {
        const outPath = command.path === undefined ? undefined : resolve(cwd, command.path);
        if (outPath !== undefined) mkdirSync(dirname(outPath), { recursive: true });
        const buf =
          command.locator !== undefined || command.selector !== undefined
            ? await locatorOf(frame, command).screenshot({ path: outPath })
            : await page.screenshot({ path: outPath, fullPage: command.fullPage === true });
        return buf.toString('base64');
      }
      case 'count':
        return await locatorOf(frame, command).count();
      case 'isVisible':
        return await locatorOf(frame, command).isVisible();
      case 'isEnabled':
        return await locatorOf(frame, command).isEnabled();
      case 'isChecked':
        return await locatorOf(frame, command).isChecked();
      case 'textContent':
        return await locatorOf(frame, command).textContent();
      case 'inputValue':
        return await locatorOf(frame, command).inputValue();
      case 'getAttribute':
        return await locatorOf(frame, command).getAttribute(command.name ?? '');
      case 'waitFor':
        await locatorOf(frame, command).waitFor({
          ...(command.state === undefined ? {} : { state: command.state }),
          ...(command.timeout === undefined ? {} : { timeout: command.timeout }),
        });
        return;
      case 'markElements': {
        const token = command.token ?? 'm';
        return await locatorOf(frame, command).evaluateAll((els, tok) => {
          for (let i = 0; i < els.length; i++) els[i]!.setAttribute('data-tslaws-found', `${tok}:${i}`);
          return els.length;
        }, token);
      }
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

  const [bundled, baseUrl] = await Promise.all([bundleLawFile(law.jsFile, options.cwd), ensureBrowserServer()]);
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
    clearMocks = await installBridge(context, page, () => activeFrame, options.cwd);
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
