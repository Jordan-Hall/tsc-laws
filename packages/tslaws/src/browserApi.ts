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

// ---- Native Vitest-Browser-style `page`, `Locator`, `userEvent`, `waitFor`, and `mock` (via Playwright bridge) ----

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
  response?: MockResponse;
}

type BridgeFn = (command: BridgeCommand) => Promise<unknown>;

function bridge(): BridgeFn {
  const fn = (globalThis as { __tslawsBridge?: BridgeFn }).__tslawsBridge;
  if (typeof fn !== 'function')
    throw new Error(
      'trusted browser interactions (`page`, `userEvent`, `user`, `mock`) require running inside `tslaws` browser runner',
    );
  return fn;
}

function wirePattern(text: string | RegExp): WirePattern {
  return typeof text === 'string' ? text : { __re: true, source: text.source, flags: text.flags };
}

export interface LocatorRoleOptions {
  name?: string | RegExp;
  exact?: boolean;
  checked?: boolean;
  disabled?: boolean;
  expanded?: boolean;
  includeHidden?: boolean;
  level?: number;
  pressed?: boolean;
  selected?: boolean;
}

export interface LocatorTextOptions {
  exact?: boolean;
}

export interface LocatorFilterOptions {
  hasText?: string | RegExp;
  hasNotText?: string | RegExp;
  has?: Locator;
  hasNot?: Locator;
}

export interface ClickOptions {
  button?: 'left' | 'right' | 'middle';
  force?: boolean;
}

export interface WaitForLocatorOptions {
  state?: 'visible' | 'hidden' | 'attached' | 'detached';
  timeout?: number;
}

export interface ScreenshotOptions {
  path?: string;
  fullPage?: boolean;
}

export type InteractionTarget = Locator | Element | string;

let targetSeq = 0;

async function withLocatorSteps<T>(target: InteractionTarget, run: (steps: LocatorStep[]) => Promise<T>): Promise<T> {
  if (target instanceof Locator) return run(target.steps);
  if (typeof target === 'string') return run([{ k: 'css', selector: target }]);
  const id = `t${++targetSeq}`;
  target.setAttribute('data-tslaws-uid', id);
  try {
    return await run([{ k: 'css', selector: `[data-tslaws-uid="${id}"]` }]);
  } finally {
    target.removeAttribute('data-tslaws-uid');
  }
}

/**
 * Chainable, auto-waiting Playwright-backed browser locator (`page.getByRole(...)`, `page.getByText(...)`, etc.),
 * providing Vitest Browser Mode ergonomics natively inside `tslaws` with zero external runner or Vite dependency.
 */
export class Locator {
  readonly steps: LocatorStep[];

  constructor(steps: LocatorStep[]) {
    this.steps = steps;
  }

  private next(step: LocatorStep): Locator {
    return new Locator([...this.steps, step]);
  }

  getByRole(role: string, options?: LocatorRoleOptions): Locator {
    const wire =
      options === undefined
        ? undefined
        : {
            ...options,
            ...(options.name === undefined ? {} : { name: wirePattern(options.name) }),
          };
    return this.next({ k: 'role', role, ...(wire === undefined ? {} : { options: wire }) });
  }

  getByText(text: string | RegExp, options?: LocatorTextOptions): Locator {
    return this.next({ k: 'text', text: wirePattern(text), exact: options?.exact });
  }

  getByLabelText(text: string | RegExp, options?: LocatorTextOptions): Locator {
    return this.next({ k: 'label', text: wirePattern(text), exact: options?.exact });
  }

  getByPlaceholder(text: string | RegExp, options?: LocatorTextOptions): Locator {
    return this.next({ k: 'placeholder', text: wirePattern(text), exact: options?.exact });
  }

  getByTestId(testId: string): Locator {
    return this.next({ k: 'testId', testId });
  }

  getByAltText(text: string | RegExp, options?: LocatorTextOptions): Locator {
    return this.next({ k: 'altText', text: wirePattern(text), exact: options?.exact });
  }

  getByTitle(text: string | RegExp, options?: LocatorTextOptions): Locator {
    return this.next({ k: 'title', text: wirePattern(text), exact: options?.exact });
  }

  locator(selector: string): Locator {
    return this.next({ k: 'css', selector });
  }

  first(): Locator {
    return this.next({ k: 'first' });
  }

  last(): Locator {
    return this.next({ k: 'last' });
  }

  nth(index: number): Locator {
    return this.next({ k: 'nth', index });
  }

  filter(options: LocatorFilterOptions): Locator {
    return this.next({
      k: 'filter',
      ...(options.hasText === undefined ? {} : { hasText: wirePattern(options.hasText) }),
      ...(options.hasNotText === undefined ? {} : { hasNotText: wirePattern(options.hasNotText) }),
      ...(options.has === undefined ? {} : { has: options.has.steps }),
      ...(options.hasNot === undefined ? {} : { hasNot: options.hasNot.steps }),
    });
  }

  async click(options?: ClickOptions): Promise<void> {
    await bridge()({ action: 'click', locator: this.steps, button: options?.button, force: options?.force });
  }

  async dblClick(options?: ClickOptions): Promise<void> {
    await bridge()({ action: 'dblClick', locator: this.steps, button: options?.button, force: options?.force });
  }

  async tripleClick(options?: ClickOptions): Promise<void> {
    await bridge()({ action: 'tripleClick', locator: this.steps, button: options?.button, force: options?.force });
  }

  async hover(options?: { force?: boolean }): Promise<void> {
    await bridge()({ action: 'hover', locator: this.steps, force: options?.force });
  }

  async unhover(): Promise<void> {
    await bridge()({ action: 'unhover' });
  }

  async focus(): Promise<void> {
    await bridge()({ action: 'focus', locator: this.steps });
  }

  async fill(value: string): Promise<void> {
    await bridge()({ action: 'fill', locator: this.steps, text: value });
  }

  async clear(): Promise<void> {
    await bridge()({ action: 'clear', locator: this.steps });
  }

  async type(value: string): Promise<void> {
    await bridge()({ action: 'type', locator: this.steps, text: value });
  }

  async press(key: string): Promise<void> {
    await bridge()({ action: 'press', locator: this.steps, key });
  }

  async selectOptions(values: string | string[]): Promise<void> {
    await bridge()({ action: 'select', locator: this.steps, values });
  }

  async check(options?: { force?: boolean }): Promise<void> {
    await bridge()({ action: 'check', locator: this.steps, force: options?.force });
  }

  async uncheck(options?: { force?: boolean }): Promise<void> {
    await bridge()({ action: 'uncheck', locator: this.steps, force: options?.force });
  }

  async dropTo(target: InteractionTarget): Promise<void> {
    await withLocatorSteps(target, async (targetLocator) => {
      await bridge()({ action: 'dragAndDrop', locator: this.steps, targetLocator });
    });
  }

  async screenshot(options?: { path?: string }): Promise<string> {
    return (await bridge()({ action: 'screenshot', locator: this.steps, path: options?.path })) as string;
  }

  async count(): Promise<number> {
    return (await bridge()({ action: 'count', locator: this.steps })) as number;
  }

  async isVisible(): Promise<boolean> {
    return (await bridge()({ action: 'isVisible', locator: this.steps })) as boolean;
  }

  async isEnabled(): Promise<boolean> {
    return (await bridge()({ action: 'isEnabled', locator: this.steps })) as boolean;
  }

  async isChecked(): Promise<boolean> {
    return (await bridge()({ action: 'isChecked', locator: this.steps })) as boolean;
  }

  async textContent(): Promise<string | null> {
    return (await bridge()({ action: 'textContent', locator: this.steps })) as string | null;
  }

  async inputValue(): Promise<string> {
    return (await bridge()({ action: 'inputValue', locator: this.steps })) as string;
  }

  async getAttribute(name: string): Promise<string | null> {
    return (await bridge()({ action: 'getAttribute', locator: this.steps, name })) as string | null;
  }

  async waitFor(options?: WaitForLocatorOptions): Promise<void> {
    await bridge()({ action: 'waitFor', locator: this.steps, state: options?.state, timeout: options?.timeout });
  }

  /** Returns all currently matching live DOM elements in the page. */
  async elements(): Promise<Element[]> {
    const token = `f${++targetSeq}`;
    await bridge()({ action: 'markElements', locator: this.steps, token });
    const found = [...document.querySelectorAll(`[data-tslaws-found^="${token}:"]`)];
    for (const el of found) el.removeAttribute('data-tslaws-found');
    return found;
  }

  /** Returns the single matching DOM element, or `null` if none matched (throws if multiple match). */
  async query(): Promise<Element | null> {
    const found = await this.elements();
    if (found.length > 1)
      throw new Error(`locator matched ${found.length} elements; narrow it with .first() or .nth()`);
    return found[0] ?? null;
  }

  /** Returns the single matching DOM element, throwing if zero or multiple elements match. */
  async element(): Promise<Element> {
    const found = await this.elements();
    if (found.length === 0) throw new Error('locator matched no elements');
    if (found.length > 1)
      throw new Error(`locator matched ${found.length} elements; narrow it with .first() or .nth()`);
    return found[0]!;
  }
}

const rootLocator = new Locator([]);

/**
 * Native Vitest-Browser-style `page` API backed directly by Playwright: auto-retrying accessible locators
 * (`getByRole`, `getByText`, `getByLabelText`, `getByPlaceholder`, `getByTestId`, `getByAltText`, `getByTitle`,
 * `locator`), viewport resizing, and page screenshots.
 */
export const page = {
  getByRole(role: string, options?: LocatorRoleOptions): Locator {
    return rootLocator.getByRole(role, options);
  },
  getByText(text: string | RegExp, options?: LocatorTextOptions): Locator {
    return rootLocator.getByText(text, options);
  },
  getByLabelText(text: string | RegExp, options?: LocatorTextOptions): Locator {
    return rootLocator.getByLabelText(text, options);
  },
  getByPlaceholder(text: string | RegExp, options?: LocatorTextOptions): Locator {
    return rootLocator.getByPlaceholder(text, options);
  },
  getByTestId(testId: string): Locator {
    return rootLocator.getByTestId(testId);
  },
  getByAltText(text: string | RegExp, options?: LocatorTextOptions): Locator {
    return rootLocator.getByAltText(text, options);
  },
  getByTitle(text: string | RegExp, options?: LocatorTextOptions): Locator {
    return rootLocator.getByTitle(text, options);
  },
  locator(selector: string): Locator {
    return rootLocator.locator(selector);
  },
  /** Wraps a live DOM element in a Playwright-backed `Locator`. */
  elementLocator(el: Element): Locator {
    let id = el.getAttribute('data-tslaws-uid');
    if (id === null) {
      id = `e${++targetSeq}`;
      el.setAttribute('data-tslaws-uid', id);
      registry().push(() => el.removeAttribute('data-tslaws-uid'));
    }
    return new Locator([{ k: 'css', selector: `[data-tslaws-uid="${id}"]` }]);
  },
  /** Resizes the browser viewport (for responsive layout and media-query laws). */
  async viewport(width: number, height: number): Promise<void> {
    await bridge()({ action: 'setViewport', width, height });
  },
  /** Takes a real Playwright PNG screenshot of the page (returns base64, and writes to `path` if provided). */
  async screenshot(options?: ScreenshotOptions): Promise<string> {
    return (await bridge()({ action: 'screenshot', path: options?.path, fullPage: options?.fullPage })) as string;
  },
};

/**
 * Trusted browser interactions driven by Playwright (`isTrusted: true`, real hit-testing, `:hover`, `:focus-visible`,
 * native form controls, keyboard navigation, and drag-and-drop), matching Vitest Browser Mode's `userEvent`.
 */
export const userEvent = {
  /** Performs a real pointer/mouse click with hit-testing and focus. */
  async click(target: InteractionTarget, options?: ClickOptions): Promise<void> {
    await withLocatorSteps(target, async (locator) => {
      await bridge()({ action: 'click', locator, button: options?.button, force: options?.force });
    });
  },
  /** Performs a real double click. */
  async dblClick(target: InteractionTarget, options?: ClickOptions): Promise<void> {
    await withLocatorSteps(target, async (locator) => {
      await bridge()({ action: 'dblClick', locator, button: options?.button, force: options?.force });
    });
  },
  /** Performs a real triple click. */
  async tripleClick(target: InteractionTarget, options?: ClickOptions): Promise<void> {
    await withLocatorSteps(target, async (locator) => {
      await bridge()({ action: 'tripleClick', locator, button: options?.button, force: options?.force });
    });
  },
  /** Moves the real pointer over `target`, triggering `:hover` and pointer events. */
  async hover(target: InteractionTarget, options?: { force?: boolean }): Promise<void> {
    await withLocatorSteps(target, async (locator) => {
      await bridge()({ action: 'hover', locator, force: options?.force });
    });
  },
  /** Moves the pointer away from the hovered element. */
  async unhover(): Promise<void> {
    await bridge()({ action: 'unhover' });
  },
  /** Focuses `target` through the browser engine. */
  async focus(target: InteractionTarget): Promise<void> {
    await withLocatorSteps(target, async (locator) => {
      await bridge()({ action: 'focus', locator });
    });
  },
  /** Clears and fills an input/textarea with real browser input events. */
  async fill(target: InteractionTarget, value: string): Promise<void> {
    await withLocatorSteps(target, async (locator) => {
      await bridge()({ action: 'fill', locator, text: value });
    });
  },
  /** Clears an input/textarea value. */
  async clear(target: InteractionTarget): Promise<void> {
    await withLocatorSteps(target, async (locator) => {
      await bridge()({ action: 'clear', locator });
    });
  },
  /** Types `value` keystroke by keystroke into `target`. */
  async type(target: InteractionTarget, value: string): Promise<void> {
    await withLocatorSteps(target, async (locator) => {
      await bridge()({ action: 'type', locator, text: value });
    });
  },
  /** Presses a keyboard key (for example `'Enter'`, `'Escape'`, `'Tab'`, `'ArrowDown'`). */
  async press(key: string): Promise<void> {
    await bridge()({ action: 'press', key });
  },
  /** Types text and special key sequences (e.g. `'hello{Enter}'`, `'{Shift>}a{/Shift}'`) through the browser keyboard. */
  async keyboard(keys: string): Promise<void> {
    await bridge()({ action: 'keyboard', text: keys });
  },
  /** Moves focus via the Tab key (`{ shift: true }` for Shift+Tab). */
  async tab(options?: { shift?: boolean }): Promise<void> {
    await bridge()({ action: 'tab', shift: options?.shift });
  },
  /** Selects one or more `<option>` values on a `<select>` element. */
  async selectOptions(target: InteractionTarget, values: string | string[]): Promise<void> {
    await withLocatorSteps(target, async (locator) => {
      await bridge()({ action: 'select', locator, values });
    });
  },
  /** Checks a checkbox or radio control. */
  async check(target: InteractionTarget, options?: { force?: boolean }): Promise<void> {
    await withLocatorSteps(target, async (locator) => {
      await bridge()({ action: 'check', locator, force: options?.force });
    });
  },
  /** Unchecks a checkbox control. */
  async uncheck(target: InteractionTarget, options?: { force?: boolean }): Promise<void> {
    await withLocatorSteps(target, async (locator) => {
      await bridge()({ action: 'uncheck', locator, force: options?.force });
    });
  },
  /** Drags `source` onto `target` with real browser pointer/drag events. */
  async dragAndDrop(source: InteractionTarget, target: InteractionTarget): Promise<void> {
    await withLocatorSteps(source, async (locator) => {
      await withLocatorSteps(target, async (targetLocator) => {
        await bridge()({ action: 'dragAndDrop', locator, targetLocator });
      });
    });
  },
};

/** Backwards-compatible alias for `userEvent`, also exposing `select` and `setViewport`. */
export const user = {
  ...userEvent,
  select: userEvent.selectOptions,
  setViewport: page.viewport,
};

/** Polls `predicate` until it returns a truthy value (or non-throwing result), failing after `timeout` ms. */
export async function waitFor<T>(
  predicate: () => T | Promise<T>,
  options: { timeout?: number; interval?: number } = {},
): Promise<T> {
  const timeout = options.timeout ?? 5000;
  const interval = options.interval ?? 50;
  const deadline = Date.now() + timeout;
  let lastError: unknown;
  for (;;) {
    try {
      const value = await predicate();
      if (value !== false && value !== null && value !== undefined) return value;
    } catch (error) {
      lastError = error;
    }
    if (Date.now() >= deadline) {
      if (lastError !== undefined) throw lastError;
      throw new Error(`waitFor timed out after ${timeout}ms`);
    }
    await new Promise<void>((done) => setTimeout(done, interval));
  }
}

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
export async function mock(urlPattern: string, response: MockResponse): Promise<void> {
  await bridge()({ action: 'mock', urlPattern, response });
}

/** Clears all active `mock()` network routes for the current law run. */
export async function clearMocks(): Promise<void> {
  await bridge()({ action: 'resetMocks' });
}

export interface ElementAssertionMatchers {
  /** Auto-retries until the element is visible. */
  toBeVisible(): Promise<true>;
  /** Auto-retries until the element is hidden or absent. */
  toBeHidden(): Promise<true>;
  /** Auto-retries until at least one matching element exists in the document. */
  toBeInTheDocument(): Promise<true>;
  /** Auto-retries until the element is enabled. */
  toBeEnabled(): Promise<true>;
  /** Auto-retries until the element is disabled. */
  toBeDisabled(): Promise<true>;
  /** Auto-retries until the checkbox/radio is checked. */
  toBeChecked(): Promise<true>;
  /** Auto-retries until `textContent` matches `expected` (substring or RegExp). */
  toHaveTextContent(expected: string | RegExp): Promise<true>;
  /** Auto-retries until the form control's value matches `expected`. */
  toHaveValue(expected: string | RegExp): Promise<true>;
  /** Auto-retries until attribute `name` exists (and matches `expected` when given). */
  toHaveAttribute(name: string, expected?: string | RegExp): Promise<true>;
  /** Auto-retries until exactly `count` elements match. */
  toHaveCount(count: number): Promise<true>;
}

export interface ElementAssertions extends ElementAssertionMatchers {
  /** Negated auto-retrying assertions (like Vitest Browser Mode's `expect.element(loc).not`). */
  readonly not: ElementAssertionMatchers;
}

function matchesText(actual: string | null, expected: string | RegExp): boolean {
  if (actual === null) return false;
  return typeof expected === 'string' ? actual.includes(expected) : expected.test(actual);
}

function toLocator(target: InteractionTarget): Locator {
  if (target instanceof Locator) return target;
  if (typeof target === 'string') return page.locator(target);
  return page.elementLocator(target);
}

/**
 * Auto-retrying Playwright-backed DOM assertions matching Vitest Browser Mode's `expect.element(locator)`:
 * polls until the condition holds (up to `timeout`, default 5000 ms), returning `true` or throwing a descriptive error.
 */
export function expectElement(
  target: InteractionTarget,
  options: { timeout?: number; interval?: number } = {},
): ElementAssertions {
  const loc = toLocator(target);
  const timeout = options.timeout ?? 5000;
  const interval = options.interval ?? 50;

  const makeMatchers = (negate: boolean): ElementAssertionMatchers => {
    const check = async (description: string, probe: () => Promise<{ ok: boolean; detail: string }>): Promise<true> => {
      let lastDetail = '';
      try {
        await waitFor(
          async () => {
            const { ok, detail } = await probe();
            lastDetail = detail;
            return negate ? !ok : ok;
          },
          { timeout, interval },
        );
        return true;
      } catch {
        const prefix = negate ? 'expected element NOT ' : 'expected element ';
        throw new Error(`${prefix}${description} (timed out after ${timeout}ms; last observed: ${lastDetail})`);
      }
    };
    return {
      toBeVisible: () =>
        check('to be visible', async () => {
          const v = await loc.isVisible();
          return { ok: v, detail: `visible=${v}` };
        }),
      toBeHidden: () =>
        check('to be hidden', async () => {
          const v = await loc.isVisible();
          return { ok: !v, detail: `visible=${v}` };
        }),
      toBeInTheDocument: () =>
        check('to be in the document', async () => {
          const c = await loc.count();
          return { ok: c > 0, detail: `count=${c}` };
        }),
      toBeEnabled: () =>
        check('to be enabled', async () => {
          const e = await loc.isEnabled();
          return { ok: e, detail: `enabled=${e}` };
        }),
      toBeDisabled: () =>
        check('to be disabled', async () => {
          const e = await loc.isEnabled();
          return { ok: !e, detail: `enabled=${e}` };
        }),
      toBeChecked: () =>
        check('to be checked', async () => {
          const c = await loc.isChecked();
          return { ok: c, detail: `checked=${c}` };
        }),
      toHaveTextContent: (expected) =>
        check(`to have text content ${String(expected)}`, async () => {
          const actual = await loc.textContent();
          return { ok: matchesText(actual, expected), detail: JSON.stringify(actual) };
        }),
      toHaveValue: (expected) =>
        check(`to have value ${String(expected)}`, async () => {
          const actual = await loc.inputValue();
          const ok = typeof expected === 'string' ? actual === expected : expected.test(actual);
          return { ok, detail: JSON.stringify(actual) };
        }),
      toHaveAttribute: (name, expected) =>
        check(`to have attribute "${name}"${expected === undefined ? '' : `=${String(expected)}`}`, async () => {
          const actual = await loc.getAttribute(name);
          const ok =
            actual !== null &&
            (expected === undefined
              ? true
              : typeof expected === 'string'
                ? actual === expected
                : expected.test(actual));
          return { ok, detail: JSON.stringify(actual) };
        }),
      toHaveCount: (count) =>
        check(`to have count ${count}`, async () => {
          const actual = await loc.count();
          return { ok: actual === count, detail: `count=${actual}` };
        }),
    };
  };

  const pos = makeMatchers(false);
  return { ...pos, not: makeMatchers(true) };
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
