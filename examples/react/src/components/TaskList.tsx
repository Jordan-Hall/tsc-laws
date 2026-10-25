import type { int } from 'tslaws';
import type { Task } from '../model/tasks';
import { TaskItem } from './TaskItem';

export interface TaskListProps {
  tasks: Task[];
  onToggle: (id: int) => void;
  onRemove: (id: int) => void;
}

export function TaskList({ tasks, onToggle, onRemove }: TaskListProps) {
  if (tasks.length === 0) return <p className="empty">Nothing here.</p>;
  return (
    <ul aria-label="Tasks">
      {tasks.map((task) => (
        <TaskItem key={task.id} task={task} onToggle={onToggle} onRemove={onRemove} />
      ))}
    </ul>
  );
}
