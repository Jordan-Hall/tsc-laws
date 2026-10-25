import { useState, type FormEvent } from 'react';

export interface AddTaskFormProps {
  onAdd: (title: string) => void;
}

export function AddTaskForm({ onAdd }: AddTaskFormProps) {
  const [title, setTitle] = useState('');
  const blank = title.trim() === '';

  function submit(event: FormEvent) {
    event.preventDefault();
    if (blank) return;
    onAdd(title.trim());
    setTitle('');
  }

  return (
    <form onSubmit={submit}>
      <input
        aria-label="New task"
        placeholder="What needs doing?"
        value={title}
        onChange={(e) => setTitle(e.target.value)}
      />
      <button type="submit" disabled={blank}>
        Add
      </button>
    </form>
  );
}
