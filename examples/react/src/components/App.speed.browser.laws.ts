import type { int } from 'tslaws';
import { blocking, fast, settle } from 'tslaws/browser';
import type { Task } from '../model/tasks';
import { addTask, mountApp } from './harness';

const sample = (n: int): Task[] =>
  Array.from({ length: n }, (_, i) => ({ id: (i + 1) as int, title: `Task ${i + 1}`, done: i % 3 === 0 }));

// Adding a task to a board of up to 200 tasks takes under 150 ms (the median of three runs, measured in the browser).
export async law addingATaskIsFast(n: int) {
  const el = mountApp(sample((Math.abs(n) % 200) as int));
  await settle(0);
  return await fast(() => addTask(el, 'Write the speed law'), 150, 3);
}

// ... and never blocks the main thread for long: no more than 150 ms beyond the 50 ms a task may take.
export async law addingATaskDoesNotBlock(n: int) {
  const el = mountApp(sample((Math.abs(n) % 200) as int));
  await settle(0);
  return (await blocking(() => addTask(el, 'Write the speed law'))) <= 150;
}
