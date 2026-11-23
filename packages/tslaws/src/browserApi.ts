/// <reference lib="dom" />
// Helpers for laws that run in a browser (`*.browser.laws.ts`). They touch only the DOM, so they work the same with
// any framework or none: mount your component however you normally do, inside `mount(...)`.

type Cleanup = () => void;
const registry = (): Cleanup[] => ((globalThis as { __tslawsCleanup?: Cleanup[] }).__tslawsCleanup ??= []);

/**
 * A fresh container in the page, removed after the law. Pass markup, a node, or a function that renders into the
 * container (a framework's `render` call) and may return what undoes it (an `unmount`).
 */
export function mount(content?: string | Node | ((container: HTMLElement) => void | Cleanup)): HTMLElement {
  const container = document.createElement('div');
  document.body.appendChild(container);
  registry().push(() => container.remove());
  if (typeof content === 'string') container.innerHTML = content;
  else if (content instanceof Node) container.appendChild(content);
  else if (typeof content === 'function') {
    const undo = content(container);
    if (typeof undo === 'function') registry().push(undo);
  }
  return container;
}

/** Waits until pending microtasks, timers and animation frames have run, so the DOM has caught up. */
export async function settle(frames = 2): Promise<void> {
  await Promise.resolve();
  await new Promise<void>((done) => setTimeout(done, 0));
  for (let i = 0; i < frames; i++) await new Promise<void>((done) => requestAnimationFrame(() => done()));
}

/** Dispatches a bubbling event. */
export function fire(target: EventTarget, type: string, init: EventInit = {}): boolean {
  return target.dispatchEvent(new Event(type, { bubbles: true, cancelable: true, ...init }));
}

/** A real click: pointer events, then `click`. */
export function click(target: Element): void {
  const init = { bubbles: true, cancelable: true, composed: true };
  target.dispatchEvent(new PointerEvent('pointerdown', init));
  target.dispatchEvent(new MouseEvent('mousedown', init));
  target.dispatchEvent(new PointerEvent('pointerup', init));
  target.dispatchEvent(new MouseEvent('mouseup', init));
  target.dispatchEvent(new MouseEvent('click', init));
}

/** Sets a field's value the way typing does, so frameworks that track `input` events notice. */
export function type(field: HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement, text: string): void {
  const proto = Object.getPrototypeOf(field) as object;
  Object.getOwnPropertyDescriptor(proto, 'value')?.set?.call(field, text);
  fire(field, 'input');
  fire(field, 'change');
}

// ---- Trusted Playwright-backed interactions & network mocking (via the browser bridge) ----

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
    | 'mock';
  selector?: string;
  text?: string;
  key?: string;
  values?: string | string[];
  width?: number;
  height?: number;
  urlPattern?: string;
  response?: MockResponse;
}

type BridgeFn = (command: BridgeCommand) => Promise<void>;

function bridge(): BridgeFn {
  const fn = (globalThis as { __tslawsBridge?: BridgeFn }).__tslawsBridge;
  if (typeof fn !== 'function')
    throw new Error('trusted browser interactions (`user`, `mock`) require running inside `tslaws` browser runner');
  return fn;
}

let targetSeq = 0;

async function withSelector<T>(target: Element | string, run: (selector: string) => Promise<T>): Promise<T> {
  if (typeof target === 'string') return run(target);
  const id = `t${++targetSeq}`;
  target.setAttribute('data-tslaws-uid', id);
  try {
    return await run(`[data-tslaws-uid="${id}"]`);
  } finally {
    target.removeAttribute('data-tslaws-uid');
  }
}

/**
 * Trusted browser interactions driven by Playwright (`isTrusted: true`, real hit-testing, `:hover`, `:focus-visible`,
 * native form controls and keyboard navigation), analogous to Vitest Browser Mode's `userEvent`.
 */
export const user = {
  /** Performs a real pointer/mouse click with hit-testing and focus. */
  click(target: Element | string): Promise<void> {
    return withSelector(target, (selector) => bridge()({ action: 'click', selector }));
  },
  /** Performs a real double click. */
  dblClick(target: Element | string): Promise<void> {
    return withSelector(target, (selector) => bridge()({ action: 'dblClick', selector }));
  },
  /** Moves the real pointer over `target`, triggering `:hover` and pointer events. */
  hover(target: Element | string): Promise<void> {
    return withSelector(target, (selector) => bridge()({ action: 'hover', selector }));
  },
  /** Focuses `target` through the browser engine. */
  focus(target: Element | string): Promise<void> {
    return withSelector(target, (selector) => bridge()({ action: 'focus', selector }));
  },
  /** Clears and fills an input/textarea with real browser input events. */
  fill(target: Element | string, value: string): Promise<void> {
    return withSelector(target, (selector) => bridge()({ action: 'fill', selector, text: value }));
  },
  /** Types `value` keystroke by keystroke into `target`. */
  type(target: Element | string, value: string): Promise<void> {
    return withSelector(target, (selector) => bridge()({ action: 'type', selector, text: value }));
  },
  /** Presses a keyboard key (for example `'Enter'`, `'Escape'`, `'Tab'`, `'ArrowDown'`). */
  press(key: string): Promise<void> {
    return bridge()({ action: 'press', key });
  },
  /** Types raw text through the browser keyboard. */
  keyboard(keys: string): Promise<void> {
    return bridge()({ action: 'keyboard', text: keys });
  },
  /** Selects one or more `<option>` values on a `<select>` element. */
  select(target: Element | string, values: string | string[]): Promise<void> {
    return withSelector(target, (selector) => bridge()({ action: 'select', selector, values }));
  },
  /** Resizes the browser viewport (for responsive layout and media-query laws). */
  setViewport(width: number, height: number): Promise<void> {
    return bridge()({ action: 'setViewport', width, height });
  },
};

export interface MockResponse {
  status?: number;
  body?: string;
  json?: unknown;
  headers?: Record<string, string>;
  contentType?: string;
}

/**
 * Intercepts network requests matching `urlPattern` (e.g. `'**\/api\/user'`) in this browser law via Playwright routing,
 * returning `response`. Automatically cleared after each law input.
 */
export function mock(urlPattern: string, response: MockResponse): Promise<void> {
  return bridge()({ action: 'mock', urlPattern, response });
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

interface AxeApi {
  run: (
    context: Element | Document,
    options: Record<string, unknown>,
  ) => Promise<{
    violations: { id: string; impact?: string | null; help: string; nodes: { html: string }[] }[];
  }>;
}

// Rules about a whole page, which an element on its own cannot satisfy.
const pageRules = ['region', 'page-has-heading-one', 'landmark-one-main'];

/**
 * Audits `root` (default: the whole page) with axe-core. Needs `axe-core` in the project: `npm i -D axe-core`.
 * Page-level rules (landmarks, a level-one heading) are skipped when `root` is an element.
 */
export async function a11y(
  root?: Element,
  options: A11yOptions = {},
): Promise<{ violations: A11yViolation[]; ok: boolean }> {
  let axe: AxeApi;
  try {
    // @ts-ignore axe-core is an optional peer dependency and may not be installed when this file is compiled.
    const loaded = (await import('axe-core')) as unknown as { default?: AxeApi } & Partial<AxeApi>;
    axe = (loaded.default ?? loaded) as AxeApi;
    if (typeof axe.run !== 'function') throw new Error('not axe');
  } catch {
    throw new Error('a11y() needs axe-core: npm i -D axe-core');
  }
  const config: Record<string, unknown> = {};
  if (options.rules !== undefined) config.runOnly = { type: 'rule', values: options.rules };
  const off = [...(options.ignore ?? []), ...(root !== undefined && options.rules === undefined ? pageRules : [])];
  if (off.length > 0) config.rules = Object.fromEntries(off.map((id) => [id, { enabled: false }]));
  const results = await axe.run(root ?? document, config);
  const violations = results.violations.map((v) => ({
    id: v.id,
    impact: v.impact ?? null,
    help: v.help,
    nodes: v.nodes.map((n) => (n.html.length > 200 ? `${n.html.slice(0, 197)}...` : n.html)),
  }));
  return { violations, ok: violations.length === 0 };
}

/** True when `root` has no accessibility violations, so a law can `return await accessible(el)`. */
export async function accessible(root?: Element, options?: A11yOptions): Promise<boolean> {
  return (await a11y(root, options)).ok;
}

// Component-level testing: isolated mounting with generated props, framework adapters and queries.
export { mountComponent, rendersSame, spy } from './component.ts';
export type { Adapter, Mounted, Rendered } from './component.ts';
export {
  allByRole,
  allByText,
  allByLabel,
  allByTestId,
  byRole,
  byText,
  byLabel,
  byTestId,
  text,
  within,
} from './queries.ts';
export type { Matcher, Queries, RoleOptions } from './queries.ts';
export { domAdapter } from './adapters/dom.ts';
export type { DomComponent } from './adapters/dom.ts';
export { elementAdapter } from './adapters/element.ts';
export type { ElementAdapterOptions } from './adapters/element.ts';
export { reactAdapter } from './adapters/react.ts';
export type { ReactFunctions, ReactRootLike } from './adapters/react.ts';
export { angularAdapter } from './adapters/angular.ts';
export type { AngularAppRefLike, AngularComponentRefLike, AngularFunctions } from './adapters/angular.ts';

export interface Timing {
  runs: number;
  min: number;
  median: number;
  p95: number;
  max: number;
}

/** Times `work` (sync or async) over `runs` runs after a warm-up, in milliseconds as the browser clock reads them. */
export async function measure(work: () => unknown, runs = 7): Promise<Timing> {
  await settle();
  await work();
  const times: number[] = [];
  for (let i = 0; i < runs; i++) {
    const start = performance.now();
    await work();
    await settle(1);
    times.push(performance.now() - start);
  }
  times.sort((a, b) => a - b);
  const at = (q: number): number => times[Math.min(times.length - 1, Math.floor(q * times.length))] ?? 0;
  return { runs, min: times[0] ?? 0, median: at(0.5), p95: at(0.95), max: times[times.length - 1] ?? 0 };
}

/** True when `work` takes at most `budgetMs` at the median, so a law can `return await fast(() => click(add), 50)`. */
export async function fast(work: () => unknown, budgetMs: number, runs = 7): Promise<boolean> {
  return (await measure(work, runs)).median <= budgetMs;
}

/** Milliseconds the main thread was blocked by long tasks (over 50 ms) while `work` ran; 0 where the browser has no such API. */
export async function blocking(work: () => unknown): Promise<number> {
  let blocked = 0;
  const add = (entries: PerformanceEntryList): void => {
    for (const entry of entries) blocked += Math.max(0, entry.duration - 50);
  };
  let observer: PerformanceObserver | undefined;
  try {
    observer = new PerformanceObserver((list) => add(list.getEntries()));
    observer.observe({ type: 'longtask' });
  } catch {
    observer = undefined;
  }
  // A task of its own, so that `work` is measured as a task and not as part of the caller's.
  await new Promise<void>((done, fail) =>
    setTimeout(() => {
      Promise.resolve(work()).then(() => done(), fail);
    }, 0),
  );
  await settle();
  // takeRecords flushes the entries the browser has queued for the observer, so there is nothing to wait for.
  if (observer !== undefined) add(observer.takeRecords());
  observer?.disconnect();
  return blocked;
}
