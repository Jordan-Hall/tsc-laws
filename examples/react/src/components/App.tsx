import { useState } from 'react';
import { useTasks } from '../hooks/useTasks';
import { visibleTasks, type Filter, type Task } from '../model/tasks';
import { AddTaskForm } from './AddTaskForm';
import { FilterBar } from './FilterBar';
import { TaskList } from './TaskList';
import { css } from './styles';

export interface AppProps {
  initialTasks?: Task[];
}

export function App({ initialTasks = [] }: AppProps) {
  const { tasks, left, add, toggle, remove, clearCompleted } = useTasks(initialTasks);
  const [filter, setFilter] = useState<Filter>('all');
  const hasDone = tasks.some((t) => t.done);

  return (
    <main className="board">
      <style>{css}</style>
      <h1>Task board</h1>
      <AddTaskForm onAdd={add} />
      <FilterBar filter={filter} onChange={setFilter} />
      <TaskList tasks={visibleTasks(tasks, filter)} onToggle={toggle} onRemove={remove} />
      <footer>
        <span className="left" aria-live="polite">
          {left} left
        </span>
        <button type="button" disabled={!hasDone} onClick={clearCompleted}>
          Clear completed
        </button>
      </footer>
    </main>
  );
}
