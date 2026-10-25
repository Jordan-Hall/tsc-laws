import type { int } from 'tslaws';
import { assume } from 'tslaws';
import {
  clampIndex,
  clearCompleted,
  moveTask,
  remaining,
  removeTask,
  tasksReducer,
  toggled,
  toggleTask,
  visibleTasks,
  emptyState,
  type Action,
  type Task,
} from './tasks';

// Scalar laws: no arrays, so the prover can settle them for every input.
export law proved toggledTwiceIsTheSameTask(task: Task) {
  const twice = toggled(toggled(task));
  return twice.done === task.done && twice.id === task.id && twice.title === task.title;
}

export law proved toggledAlwaysDiffers(task: Task) => toggled(task).done !== task.done;

export law proved clampIndexStaysInList(index: int, length: int) {
  assume(length > 0);
  const i = clampIndex(index, length);
  return i >= 0 && i < length;
}

export law proved clampIndexKeepsValidIndices(index: int, length: int) {
  assume(index >= 0 && index < length);
  return clampIndex(index, length) === index;
}

export law clearCompletedNeverGrows(tasks: Task[]) => clearCompleted(tasks).length <= tasks.length;

export law clearCompletedLeavesNothingDone(tasks: Task[]) => clearCompleted(tasks).every((t) => !t.done);

export law toggleKeepsLength(tasks: Task[], id: int) => toggleTask(tasks, id).length === tasks.length;

export law removeNeverGrows(tasks: Task[], id: int) => removeTask(tasks, id).length <= tasks.length;

export law clearCompletedKeepsRemaining(tasks: Task[]) =>
  remaining(clearCompleted(tasks)) === remaining(tasks);

export law toggleTwiceRestoresFlags(tasks: Task[], id: int) {
  const twice = toggleTask(toggleTask(tasks, id), id);
  return twice.length === tasks.length && twice.every((t, i) => t.done === tasks[i]!.done && t.id === tasks[i]!.id);
}

export law moveKeepsEveryTask(tasks: Task[], from: int, to: int) {
  assume(new Set(tasks.map((t) => t.id)).size === tasks.length);
  const moved = moveTask(tasks, from, to);
  return moved.length === tasks.length && tasks.every((t) => moved.some((m) => m.id === t.id));
}

export law filtersPartitionTasks(tasks: Task[]) =>
  visibleTasks(tasks, 'active').length + visibleTasks(tasks, 'done').length === tasks.length &&
  visibleTasks(tasks, 'all').length === tasks.length;

export law remainingMatchesActiveFilter(tasks: Task[]) => remaining(tasks) === visibleTasks(tasks, 'active').length;

export law addTrimsAndSkipsBlank(title: string) {
  const next = tasksReducer(emptyState, { type: 'add', title });
  if (title.trim() === '') return next.tasks.length === 0;
  return next.tasks.length === 1 && next.tasks[0]!.title === title.trim() && !next.tasks[0]!.done;
}

export law idsStayUnique(actions: Action[]) {
  let state = emptyState;
  for (const action of actions) state = tasksReducer(state, action);
  const ids = state.tasks.map((t) => t.id);
  return new Set(ids).size === ids.length && ids.every((id) => id < state.nextId);
}

export law renameTrimsAndKeepsOldTitleWhenBlank(title: string, renamed: string) {
  assume(title.trim() !== '');
  const added = tasksReducer(emptyState, { type: 'add', title });
  const id = added.tasks[0]!.id;
  const next = tasksReducer(added, { type: 'rename', id, title: renamed });
  const expected = renamed.trim() === '' ? title.trim() : renamed.trim();
  return next.tasks.length === 1 && next.tasks[0]!.title === expected && next.tasks[0]!.id === id;
}
