/// <reference lib="dom" />
import type { Adapter } from '../component.ts';

export interface ElementAdapterOptions {
  /** Also set each string, number or boolean prop as an attribute (default: properties only). */
  attributes?: boolean;
}

/**
 * Renders a custom element: props are assigned as properties (and optionally attributes). The `component` argument may
 * be the element's class, defined under `tagName` when it is not yet, or `undefined` when it is already registered.
 */
// oxlint-disable-next-line typescript/no-explicit-any
export function elementAdapter<P extends object = any>(
  tagName: string,
  options: ElementAdapterOptions = {},
): Adapter<CustomElementConstructor | undefined, P> {
  const assign = (el: HTMLElement, props: P): void => {
    for (const [key, value] of Object.entries(props as object)) {
      (el as unknown as Record<string, unknown>)[key] = value;
      if (options.attributes && ['string', 'number', 'boolean'].includes(typeof value)) {
        if (value === false) el.removeAttribute(key);
        else el.setAttribute(key, value === true ? '' : String(value));
      }
    }
  };
  return {
    render(container, component, props) {
      if (component !== undefined && customElements.get(tagName) === undefined)
        customElements.define(tagName, component);
      const el = document.createElement(tagName);
      container.appendChild(el);
      assign(el, props);
      return { update: (next) => assign(el, next), unmount: () => el.remove() };
    },
  };
}
