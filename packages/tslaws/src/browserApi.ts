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
