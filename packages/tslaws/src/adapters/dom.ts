/// <reference lib="dom" />
import type { Adapter } from '../component.ts';

/** A vanilla component: a function from props to a node or markup. */
// oxlint-disable-next-line typescript/no-explicit-any
export type DomComponent<P = any> = (props: P) => Node | string;

function fill(container: HTMLElement, content: Node | string): void {
  if (typeof content === 'string') container.innerHTML = content;
  else container.replaceChildren(content);
}

/** Renders a `(props) => Node | string` function into the container; a rerender replaces the content. */
// oxlint-disable-next-line typescript/no-explicit-any
export const domAdapter: Adapter<DomComponent, any> = {
  render(container, component, props) {
    fill(container, component(props));
    return {
      update: (next) => fill(container, component(next)),
      unmount: () => container.replaceChildren(),
    };
  },
};
