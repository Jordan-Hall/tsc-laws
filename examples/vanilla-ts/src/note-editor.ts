// The editor: a title field, a textarea, a live preview and a save button.
import { markdown } from './markdown';
import type { Note } from './notes-store';
import './word-counter-element';

export class NoteEditor {
  readonly title = document.createElement('input');
  readonly textarea = document.createElement('textarea');
  readonly preview = document.createElement('div');
  readonly save = document.createElement('button');
  readonly counter = document.createElement('word-counter');

  constructor(
    root: HTMLElement,
    private readonly onSave: (title: string, body: string) => void,
  ) {
    const titleLabel = document.createElement('label');
    titleLabel.append('Title ', this.title);
    const bodyLabel = document.createElement('label');
    bodyLabel.append('Note ', this.textarea);
    this.save.type = 'button';
    this.save.textContent = 'Save';
    this.preview.setAttribute('aria-label', 'Preview');
    this.preview.setAttribute('role', 'region');
    root.append(titleLabel, bodyLabel, this.preview, this.counter, this.save);
    this.textarea.addEventListener('input', () => this.refresh());
    this.save.addEventListener('click', () => this.onSave(this.title.value, this.textarea.value));
    this.load(undefined);
  }

  /** Shows `note` for editing, or empties and disables the editor when there is none. */
  load(note: Note | undefined): void {
    this.title.value = note?.title ?? '';
    this.textarea.value = note?.body ?? '';
    this.title.disabled = this.textarea.disabled = this.save.disabled = note === undefined;
    this.refresh();
  }

  private refresh(): void {
    this.preview.innerHTML = markdown(this.textarea.value);
    this.counter.setAttribute('text', this.textarea.value);
  }
}
