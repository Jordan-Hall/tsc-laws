import type { Filter } from '../model/tasks';

export interface FilterBarProps {
  filter: Filter;
  onChange: (filter: Filter) => void;
}

const filters: { value: Filter; label: string }[] = [
  { value: 'all', label: 'All' },
  { value: 'active', label: 'Active' },
  { value: 'done', label: 'Done' },
];

export function FilterBar({ filter, onChange }: FilterBarProps) {
  return (
    <div role="group" aria-label="Filter tasks">
      {filters.map(({ value, label }) => (
        <button key={value} type="button" aria-pressed={filter === value} onClick={() => onChange(value)}>
          {label}
        </button>
      ))}
    </div>
  );
}
