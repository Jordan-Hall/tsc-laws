import type { int } from 'tslaws';
import type { Task } from '../model/tasks';

export interface TaskItemProps {
  task: Task;
  onToggle: (id: int) => void;
  onRemove: (id: int) => void;
}

export function TaskItem({ task, onToggle, onRemove }: TaskItemProps) {
  return (
    <li className={task.done ? 'task done' : 'task'}>
      <label>
        <input type="checkbox" checked={task.done} onChange={() => onToggle(task.id)} />
        <span className="title">{task.title}</span>
      </label>
      <button type="button" aria-label={`Delete ${task.title}`} onClick={() => onRemove(task.id)}>
        Delete
      </button>
    </li>
  );
}
