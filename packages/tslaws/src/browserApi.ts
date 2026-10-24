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
