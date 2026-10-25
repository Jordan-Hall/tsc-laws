import { assume } from 'tslaws';
import { settle } from 'tslaws/browser';
import type { Filter } from '../model/tasks';
import { mountApp, pickFilter } from './harness';

const labelOf: Record<Filter, string> = { all: 'All', active: 'Active', done: 'Done' };

// Whatever the user clicks, exactly one filter button is pressed, and it is the one clicked last (All at the start).
export async law exactlyOneFilterIsPressed(clicks: Filter[]) {
  assume(clicks.length <= 10);
  const el = mountApp();
  await settle(0);
  const pressed = () => [...el.querySelectorAll('[role="group"] button[aria-pressed="true"]')].map((b) => b.textContent);
  if (pressed().join() !== 'All') return false;
  for (const filter of clicks) {
    await pickFilter(el, filter);
    if (pressed().join() !== labelOf[filter]) return false;
  }
  return el.querySelectorAll('[role="group"] button[aria-pressed]').length === 3;
}
