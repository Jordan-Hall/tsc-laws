/// <reference lib="dom" />
// Component-level testing: render ONE component in isolation with generated props, through a thin adapter for the
// framework (or none). tslaws has no framework dependency: the adapters take the framework's functions.
import { mount, settle } from './browserApi.ts';
import { within, type Queries } from './queries.ts';

/** What `render` hands back: nothing, an unmount function, or an object that can update and unmount. */
export type Rendered<P> = void | (() => void) | { update?(props: P): void | Promise<void>; unmount?(): void };

/** Teaches `mountComponent` one framework. `render` may be async (Angular bootstraps asynchronously). */
export interface Adapter<C, P> {
  render(container: HTMLElement, component: C, props: P): Rendered<P> | Promise<Rendered<P>>;
}

export interface Mounted<P> {
  /** The container the component rendered into. */
  el: HTMLElement;
  /** The props of the latest render. */
  props: P;
  /** Renders again with new props and waits for the DOM to settle. */
  rerender(next: P): Promise<void>;
  /** Unmounts now; the end of the law does it anyway. */
  unmount(): void;
  /** Queries bound to `el`. */
  query: Queries;
}

/**
 * Renders `component` with `props` into a fresh container (see `mount`), waits for the DOM to settle, and unmounts at
 * the end of the law.
 */
export async function mountComponent<C, P>(adapter: Adapter<C, P>, component: C, props: P): Promise<Mounted<P>> {
  // Registered with the same per-law cleanup as mount(): the container is removed and the component unmounted.
  const el = mount(() => () => unmount());
  let handle: Exclude<Rendered<P>, void | (() => void)> = {};
  let pending: Promise<unknown> = Promise.resolve();
  let live = true;
  const adopt = (rendered: Rendered<P>): void => {
    handle = typeof rendered === 'function' ? { unmount: rendered } : (rendered ?? {});
  };
  function unmount(): void {
    if (!live) return;
    live = false;
    handle.unmount?.();
  }
  const start = (p: P): void => {
    const rendered = adapter.render(el, component, p);
    if (rendered instanceof Promise) pending = rendered.then(adopt);
    else adopt(rendered);
  };
  start(props);
  await pending;
  await settle();
  const mounted: Mounted<P> = {
    el,
    props,
    query: within(el),
    unmount,
    async rerender(next: P): Promise<void> {
      if (handle.update !== undefined) await handle.update(next);
      else {
        handle.unmount?.();
        el.replaceChildren();
        start(next);
        await pending;
      }
      mounted.props = next;
      await settle();
    },
  };
  return mounted;
}

/** A callback you can observe: records the arguments of each call. `impl` runs and its result is returned. */
export function spy<A extends unknown[], R>(impl?: (...a: A) => R): ((...a: A) => R) & { calls: A[]; count: number } {
  const calls: A[] = [];
  const fn = ((...a: A): R => {
    calls.push(a);
    return impl?.(...a) as R;
  }) as ((...a: A) => R) & { calls: A[]; count: number };
  fn.calls = calls;
  Object.defineProperty(fn, 'count', { get: () => calls.length, enumerable: true });
  return fn;
}

// Markup with the noise removed that differs between a fresh render and an updated one: comment nodes, empty text,
// whitespace runs and the bookkeeping attributes frameworks add.
function normalisedHtml(el: HTMLElement): string {
  const copy = el.cloneNode(true) as HTMLElement;
  const walker = document.createTreeWalker(copy, NodeFilter.SHOW_COMMENT | NodeFilter.SHOW_TEXT);
  const drop: Node[] = [];
  for (let node = walker.nextNode(); node !== null; node = walker.nextNode()) {
    if (node.nodeType === Node.COMMENT_NODE || (node.textContent ?? '').trim() === '') drop.push(node);
  }
  for (const node of drop) node.parentNode?.removeChild(node);
  for (const node of [copy, ...Array.from(copy.querySelectorAll('*'))]) {
    for (const name of node.getAttributeNames()) {
      if (/^(ng-reflect-|_ng(content|host)-|ng-version$|data-reactroot$|data-react)/.test(name))
        node.removeAttribute(name);
    }
  }
  return copy.innerHTML.replace(/\s+/g, ' ').replace(/> </g, '><').trim();
}

/**
 * The classic component law: rendering is a pure function of props. Renders with `a`, rerenders with `b`, and compares
 * the markup with a fresh render of `b`.
 */
export async function rendersSame<C, P>(adapter: Adapter<C, P>, component: C, a: P, b: P): Promise<boolean> {
  const updated = await mountComponent(adapter, component, a);
  await updated.rerender(b);
  const first = normalisedHtml(updated.el);
  updated.unmount();
  const fresh = await mountComponent(adapter, component, b);
  const second = normalisedHtml(fresh.el);
  fresh.unmount();
  return first === second;
}
