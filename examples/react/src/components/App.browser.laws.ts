import { assume, forall, runModelAsync } from 'tslaws';
import { click, settle } from 'tslaws/browser';
import { visibleTasks, type Filter } from '../model/tasks';
import { addTask, button, items, leftCount, mountApp, pickFilter, titles } from './harness';

type Op = 'add' | 'toggleFirst' | 'toggleLast' | 'removeFirst' | 'clearCompleted' | 'showAll' | 'showActive' | 'showDone';

interface Row {
  id: number;
  title: string;
  done: boolean;
}

interface Model {
  rows: Row[];
  filter: Filter;
  added: number;
}

const filterOf = (op: Op): Filter | undefined =>
  op === 'showAll' ? 'all' : op === 'showActive' ? 'active' : op === 'showDone' ? 'done' : undefined;

// Random operation lists drive the real UI and a plain-array model side by side. After every step the rendered rows,
// their checkboxes and the "N left" counter must match the model. A failing list shrinks to the shortest one.
export async law boardAgreesWithModel(ops: Op[]) {
  assume(ops.length <= 12);
  const el = mountApp();
  await settle(0);
  return runModelAsync<Op, HTMLElement, Model>({
    ops,
    real: el,
    model: { rows: [], filter: 'all', added: 0 },
    apply: async (el, model, op) => {
      const visible = visibleTasks(
        model.rows.map((r) => ({ id: r.id as never, title: r.title, done: r.done })),
        model.filter,
      );
      const target = op === 'toggleLast' ? visible[visible.length - 1] : visible[0];
      if (op === 'add') {
        const title = `task ${model.added + 1}`;
        await addTask(el, title);
        return { ...model, added: model.added + 1, rows: [...model.rows, { id: model.added + 1, title, done: false }] };
      }
      const filter = filterOf(op);
      if (filter !== undefined) {
        await pickFilter(el, filter);
        return { ...model, filter };
      }
      if (op === 'clearCompleted') {
        const clear = button(el, 'Clear completed');
        if (!clear.disabled) click(clear);
        await settle(0);
        return { ...model, rows: model.rows.filter((r) => !r.done) };
      }
      if (target === undefined) return model;
      const li = items(el).find((x) => x.querySelector('.title')?.textContent === target.title)!;
      if (op === 'removeFirst') {
        click(li.querySelector('button')!);
        await settle(0);
        return { ...model, rows: model.rows.filter((r) => r.title !== target.title) };
      }
      click(li.querySelector('input')!);
      await settle(0);
      return { ...model, rows: model.rows.map((r) => (r.title === target.title ? { ...r, done: !r.done } : r)) };
    },
    agree: (el, model) => {
      const shown = model.rows.filter((r) => (model.filter === 'all' ? true : (model.filter === 'done') === r.done));
      const boxes = items(el).map((li) => li.querySelector('input')!.checked);
      return (
        titles(el).join('|') === shown.map((r) => r.title).join('|') &&
        boxes.join() === shown.map((r) => r.done).join() &&
        leftCount(el) === model.rows.filter((r) => !r.done).length
      );
    },
  });
}

// Whatever a user types, the board shows exactly the non-blank titles, trimmed, in order.
export async law addingTitlesRendersTheNonBlankOnes(entries: string[]) {
  assume(entries.length <= 6);
  assume(forall(entries, (s) => s.length <= 16));
  const el = mountApp();
  await settle(0);
  for (const entry of entries) await addTask(el, entry);
  // A text field drops line breaks from what it holds, so that is what the user effectively typed.
  const expected = entries.map((s) => s.replace(/[\r\n]/g, '').trim()).filter((s) => s !== '');
  return titles(el).join('\u0000') === expected.join('\u0000') && leftCount(el) === expected.length;
}
