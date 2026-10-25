import type { int } from 'tslaws';

export interface Task {
  id: int;
  title: string;
  done: boolean;
}

export interface TaskState {
  tasks: Task[];
  nextId: int;
}

export type Filter = 'all' | 'active' | 'done';

export type Action =
  | { type: 'add'; title: string }
  | { type: 'toggle'; id: int }
  | { type: 'rename'; id: int; title: string }
  | { type: 'remove'; id: int }
  | { type: 'clearCompleted' }
  | { type: 'reorder'; from: int; to: int };

export const emptyState: TaskState = { tasks: [], nextId: 1 as int };

/** The same task with `done` flipped. */
export function toggled(task: Task): Task {
  return { id: task.id, title: task.title, done: !task.done };
}

/** Flips `done` on the task with this id. Other tasks are untouched; an unknown id changes nothing. */
export function toggleTask(tasks: Task[], id: int): Task[] {
  return tasks.map((t) => (t.id === id ? toggled(t) : t));
}

/** Pins an index into `0..length-1`, so a drop past either end of the list lands on the end. */
export function clampIndex(index: int, length: int): int {
  if (index < 0) return 0 as int;
  if (index >= length) return Math.max(length - 1, 0) as int;
  return index;
}

export function removeTask(tasks: Task[], id: int): Task[] {
  return tasks.filter((t) => t.id !== id);
}

/** Drops every finished task. */
export function clearCompleted(tasks: Task[]): Task[] {
  return tasks.filter((t) => !t.done);
}

/** Moves the task at index `from` to index `to` (clamped into the list). An unknown `from` changes nothing. */
export function moveTask(tasks: Task[], from: int, rawTo: int): Task[] {
  const to = clampIndex(rawTo, tasks.length as int);
  if (from < 0 || from >= tasks.length || from === to) return tasks;
  const moved = tasks[from]!;
  const rest = tasks.filter((_, i) => i !== from);
  return [...rest.slice(0, to), moved, ...rest.slice(to)];
}

/** How many tasks are still open: the "N left" counter. */
export function remaining(tasks: Task[]): int {
  return tasks.filter((t) => !t.done).length as int;
}

export function visibleTasks(tasks: Task[], filter: Filter): Task[] {
  if (filter === 'active') return tasks.filter((t) => !t.done);
  if (filter === 'done') return tasks.filter((t) => t.done);
  return tasks;
}

export function tasksReducer(state: TaskState, action: Action): TaskState {
  switch (action.type) {
    case 'add': {
      const title = action.title.trim();
      if (title === '') return state;
      const task: Task = { id: state.nextId, title, done: false };
      return { tasks: [...state.tasks, task], nextId: (state.nextId + 1) as int };
    }
    case 'toggle':
      return { ...state, tasks: toggleTask(state.tasks, action.id) };
    case 'rename': {
      const title = action.title.trim();
      if (title === '') return state;
      return { ...state, tasks: state.tasks.map((t) => (t.id === action.id ? { ...t, title } : t)) };
    }
    case 'remove':
      return { ...state, tasks: removeTask(state.tasks, action.id) };
    case 'clearCompleted':
      return { ...state, tasks: clearCompleted(state.tasks) };
    case 'reorder':
      return { ...state, tasks: moveTask(state.tasks, action.from, action.to) };
  }
}
