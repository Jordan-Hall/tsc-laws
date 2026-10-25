// Shared by the browser laws: mounts the app and reads the DOM the way a user would.
import { createElement } from 'react';
import { createRoot } from 'react-dom/client';
import { click, mount, settle, type } from 'tslaws/browser';
import type { Filter, Task } from '../model/tasks';
import { App } from './App';

export function mountApp(initialTasks: Task[] = []): HTMLElement {
  return mount((container) => {
    const root = createRoot(container);
    root.render(createElement(App, { initialTasks }));
    return () => root.unmount();
  });
}

export function items(el: HTMLElement): HTMLLIElement[] {
  return [...el.querySelectorAll('li')];
}

export function titles(el: HTMLElement): string[] {
  return items(el).map((li) => li.querySelector('.title')?.textContent ?? '');
}

/** The number in the "N left" counter, or -1 when the counter is not there. */
export function leftCount(el: HTMLElement): number {
  const text = el.querySelector('.left')?.textContent ?? '';
  const match = /^(\d+) left$/.exec(text);
  return match === null ? -1 : Number(match[1]);
}

export function button(el: HTMLElement, name: string): HTMLButtonElement {
  const found = [...el.querySelectorAll('button')].find((b) => b.textContent === name);
  if (found === undefined) throw new Error(`no "${name}" button`);
  return found;
}

export function field(el: HTMLElement): HTMLInputElement {
  const input = el.querySelector('input[aria-label="New task"]');
  if (!(input instanceof HTMLInputElement)) throw new Error('no new-task field');
  return input;
}

/** Types a title and presses Add, as a user would. */
export async function addTask(el: HTMLElement, title: string): Promise<void> {
  type(field(el), title);
  await settle(0);
  const add = button(el, 'Add');
  if (!add.disabled) click(add);
  await settle(0);
}

export async function pickFilter(el: HTMLElement, filter: Filter): Promise<void> {
  click(button(el, filter === 'all' ? 'All' : filter === 'active' ? 'Active' : 'Done'));
  await settle(0);
}
