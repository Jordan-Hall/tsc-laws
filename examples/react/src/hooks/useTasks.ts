import { useCallback, useMemo, useReducer } from 'react';
import type { int } from 'tslaws';
import { remaining, tasksReducer, type Task } from '../model/tasks';

export interface TasksApi {
  tasks: Task[];
  left: int;
  add: (title: string) => void;
  toggle: (id: int) => void;
  rename: (id: int, title: string) => void;
  remove: (id: int) => void;
  clearCompleted: () => void;
  reorder: (from: int, to: int) => void;
}

/** The task list as React state: a reducer behind stable callbacks. */
export function useTasks(initial: Task[] = []): TasksApi {
  const [state, dispatch] = useReducer(tasksReducer, initial, (tasks) => ({
    tasks,
    nextId: (tasks.reduce((max, t) => Math.max(max, t.id), 0) + 1) as int,
  }));
  const add = useCallback((title: string) => dispatch({ type: 'add', title }), []);
  const toggle = useCallback((id: int) => dispatch({ type: 'toggle', id }), []);
  const rename = useCallback((id: int, title: string) => dispatch({ type: 'rename', id, title }), []);
  const remove = useCallback((id: int) => dispatch({ type: 'remove', id }), []);
  const clearCompleted = useCallback(() => dispatch({ type: 'clearCompleted' }), []);
  const reorder = useCallback((from: int, to: int) => dispatch({ type: 'reorder', from, to }), []);
  const left = useMemo(() => remaining(state.tasks), [state.tasks]);
  return { tasks: state.tasks, left, add, toggle, rename, remove, clearCompleted, reorder };
}
