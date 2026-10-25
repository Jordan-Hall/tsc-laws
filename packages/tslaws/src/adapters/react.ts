/// <reference lib="dom" />
import type { Adapter } from '../component.ts';

/** The part of React's `createRoot` result the adapter uses. */
export interface ReactRootLike {
  render(node: unknown): void;
  unmount(): void;
}

/**
 * The functions to pass, all from React itself:
 *
 * ```ts
 * import { createElement } from 'react';
 * import { createRoot } from 'react-dom/client';
 * import { flushSync } from 'react-dom';
 * reactAdapter({ createRoot, createElement, flushSync });
 * ```
 */
export interface ReactFunctions {
  // oxlint-disable-next-line typescript/no-explicit-any
  createRoot(container: any): ReactRootLike;
  // oxlint-disable-next-line typescript/no-explicit-any
  createElement(type: any, props: any): unknown;
  /** When given, renders are committed synchronously. */
  flushSync?(callback: () => void): void;
}

/** Renders a React component with `createRoot`; a rerender calls `root.render`, unmount calls `root.unmount`. */
// oxlint-disable-next-line typescript/no-explicit-any
export function reactAdapter<P extends object = any>(react: ReactFunctions): Adapter<unknown, P> {
  const sync = (work: () => void): void => (react.flushSync !== undefined ? react.flushSync(work) : work());
  return {
    render(container, component, props) {
      const root = react.createRoot(container);
      sync(() => root.render(react.createElement(component, props)));
      return {
        update: (next) => sync(() => root.render(react.createElement(component, next))),
        unmount: () => sync(() => root.unmount()),
      };
    },
  };
}
