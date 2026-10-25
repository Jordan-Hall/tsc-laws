// Helpers for end-to-end laws (`*.e2e.laws.ts`). The law runs in Node and drives a whole running app from outside,
// through a real browser, with a Playwright `Page`. The runner gives every generated input a fresh browser context
// and page; the helpers below find them through async context, so a law needs no argument for them.
import { AsyncLocalStorage } from 'node:async_hooks';
import { createRequire } from 'node:module';
import { join } from 'node:path';
import type { BrowserContext, Locator, Page, Route } from 'playwright-core';

export type { BrowserContext, Locator, Page, Route };

/** What the runner provides to a law while it runs one generated input. */
export interface E2eState {
  context: BrowserContext;
  page: Page;
  baseURL: string;
  /** The project directory, where axe-core is looked up. */
  cwd: string;
  /** Called with each page the law opens, so the runner can photograph the newest. */
  onPage?: (page: Page) => void;
}

// The runner and the law may load this module through different paths (an ESM import and a CommonJS `require`), so
// the storage lives on the global object and both see the same one.
const key = Symbol.for('tslaws.e2e.state');
function storage(): AsyncLocalStorage<E2eState> {
  const holder = globalThis as { [key]?: AsyncLocalStorage<E2eState> };
  return (holder[key] ??= new AsyncLocalStorage<E2eState>());
}

/** For the runner: runs `fn` with `state` as the current run. */
export function withE2e<T>(state: E2eState, fn: () => Promise<T> | T): Promise<T> | T {
  return storage().run(state, fn);
}

function current(): E2eState {
  const state = storage().getStore();
  if (state === undefined) throw new Error('tslaws/e2e helpers only work inside an end-to-end law (*.e2e.laws.ts)');
  return state;
}

/** The Playwright page of the current run: a fresh browser context and page for every generated input. */
export function page(): Page {
  return current().page;
}

/** The browser context of the current run. Cookies and storage are shared by its tabs and gone after the run. */
export function context(): BrowserContext {
  return current().context;
}

/** The address of the app under test: `e2e.baseURL` of tslaws.json. */
export function baseURL(): string {
  return current().baseURL;
}

/** Opens `path` (relative to the base URL) and waits for the page to load. */
export async function open(path = '/'): Promise<Page> {
  const state = current();
  await state.page.goto(new URL(path, state.baseURL).toString(), { waitUntil: 'load' });
  return state.page;
}

/** Opens a second tab in the same context (same cookies and storage). */
export async function newPage(): Promise<Page> {
  const state = current();
  const created = await state.context.newPage();
  state.onPage?.(created);
  return created;
}

/** Answers requests matching `urlPattern` yourself, for network mocking. Lasts until the run ends. */
export async function route(
  urlPattern: string | RegExp | ((url: URL) => boolean),
  handler: (route: Route) => Promise<void> | void,
): Promise<void> {
  await current().context.route(urlPattern, handler);
}

/** Waits until the network is idle and two animation frames have run, so the page has caught up. */
export async function settle(target?: Page): Promise<void> {
  const used = target ?? current().page;
  await used.waitForLoadState('networkidle');
  // Strings, not functions: this file is compiled without the DOM types.
  await used.evaluate('new Promise((done) => requestAnimationFrame(() => requestAnimationFrame(() => done())))');
}

export interface A11yViolation {
  id: string;
  impact: string | null;
  help: string;
  /** Outer HTML of each offending element, trimmed to 200 characters. */
  nodes: string[];
}

export interface A11yOptions {
  /** Run only these axe rule ids. */
  rules?: string[];
  /** Skip these axe rule ids. */
  ignore?: string[];
}

interface AxeResults {
  violations: { id: string; impact?: string | null; help: string; nodes: { html: string }[] }[];
}

/** Audits the page with axe-core, which it looks up in the project (`npm i -D axe-core`). */
export async function a11y(
  target?: Page,
  options: A11yOptions = {},
): Promise<{ violations: A11yViolation[]; ok: boolean }> {
  const state = current();
  const used = target ?? state.page;
  let axePath: string;
  try {
    axePath = createRequire(join(state.cwd, 'package.json')).resolve('axe-core/axe.min.js');
  } catch {
    throw new Error('accessible() needs axe-core: npm i -D axe-core');
  }
  await used.addScriptTag({ path: axePath });
  const results = (await used.evaluate(`axe.run(document, ${JSON.stringify(axeConfig(options))})`)) as AxeResults;
  const violations = results.violations.map((v) => ({
    id: v.id,
    impact: v.impact ?? null,
    help: v.help,
    nodes: v.nodes.map((n) => (n.html.length > 200 ? `${n.html.slice(0, 197)}...` : n.html)),
  }));
  return { violations, ok: violations.length === 0 };
}

function axeConfig(options: A11yOptions): Record<string, unknown> {
  const config: Record<string, unknown> = {};
  if (options.rules !== undefined) config.runOnly = { type: 'rule', values: options.rules };
  if (options.ignore !== undefined && options.ignore.length > 0)
    config.rules = Object.fromEntries(options.ignore.map((id) => [id, { enabled: false }]));
  return config;
}

/** True when the page has no accessibility violations, so a law can `return await accessible()`. */
export async function accessible(target?: Page, options?: A11yOptions): Promise<boolean> {
  return (await a11y(target, options)).ok;
}
