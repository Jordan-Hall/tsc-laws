import type { int } from 'tslaws';
import { assume } from 'tslaws';
import { accessible, a11y, settle } from 'tslaws/browser';
import type { Filter, Task } from '../model/tasks';
import { addTask, mountApp, pickFilter } from './harness';

const sample = (n: int, doneEvery: int): Task[] =>
  Array.from({ length: n }, (_, i) => ({ id: (i + 1) as int, title: `Task ${i + 1}`, done: doneEvery > 0 && i % doneEvery === 0 }));

// axe-core finds no violation in the board, empty or full, with some tasks finished, under any filter.
export async law boardIsAccessible(n: int, doneEvery: int, filter: Filter) {
  // Fold the generated ints into small ranges instead of discarding most of them.
  const el = mountApp(sample((Math.abs(n) % 6) as int, (Math.abs(doneEvery) % 4) as int));
  await settle(0);
  await pickFilter(el, filter);
  return await accessible(el);
}

// ... and still none after a user has typed and added a task.
export async law boardStaysAccessibleAfterAdding(title: string) {
  assume(title.trim() !== '');
  const el = mountApp();
  await settle(0);
  await addTask(el, title);
  const report = await a11y(el);
  return report.ok;
}
