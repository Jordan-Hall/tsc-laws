// The list of notes with a filter box. It draws what it is given and reports clicks.
import type { Note } from './notes-store';

export interface NoteListHandlers {
  select: (id: number) => void;
  remove: (id: number) => void;
  filter: (query: string) => void;
}

export class NoteList {
  readonly filter = document.createElement('input');
  readonly list = document.createElement('ul');

  constructor(
    root: HTMLElement,
    private readonly handlers: NoteListHandlers,
  ) {
    const label = document.createElement('label');
    this.filter.type = 'search';
    label.append('Filter ', this.filter);
    root.append(label, this.list);
    this.filter.addEventListener('input', () => this.handlers.filter(this.filter.value));
  }

  /** Redraws the rows for `notes`, marking the one with id `selected`. */
  render(notes: Note[], selected: number | undefined): void {
    this.list.replaceChildren(
      ...notes.map((note) => {
        const title = note.title === '' ? 'Untitled' : note.title;
        const row = document.createElement('li');
        row.dataset.id = String(note.id);
        const open = document.createElement('button');
        open.type = 'button';
        open.textContent = title;
        open.setAttribute('aria-pressed', String(note.id === selected));
        open.addEventListener('click', () => this.handlers.select(note.id));
        const remove = document.createElement('button');
        remove.type = 'button';
        remove.textContent = 'Delete';
        remove.setAttribute('aria-label', `Delete ${title}`);
        remove.addEventListener('click', () => this.handlers.remove(note.id));
        row.append(open, remove);
        return row;
      }),
    );
  }
}
