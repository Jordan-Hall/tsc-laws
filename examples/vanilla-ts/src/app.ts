// Wires the store, the list and the editor together.
import type { int } from 'tslaws';
import { NoteEditor } from './note-editor';
import { NoteList } from './note-list';
import { installStyles } from './styles';
import { addNote, deleteNote, emptyStore, renameNote, searchNotes, setBody, type Store } from './notes-store';

export class App {
  readonly newNote = document.createElement('button');
  readonly count = document.createElement('p');
  readonly list: NoteList;
  readonly editor: NoteEditor;
  private store: Store = emptyStore();
  private selected: int | undefined;
  private query = '';

  constructor(root: HTMLElement) {
    installStyles(root);
    this.newNote.type = 'button';
    this.newNote.textContent = 'New note';
    this.count.setAttribute('role', 'status');
    const listBox = document.createElement('div');
    const editorBox = document.createElement('div');
    root.append(this.newNote, this.count, listBox, editorBox);
    this.list = new NoteList(listBox, {
      select: (id) => this.select(id as int),
      remove: (id) => {
        this.store = deleteNote(this.store, id as int);
        if (this.selected === id) this.selected = undefined;
        this.render();
      },
      filter: (query) => {
        this.query = query;
        this.render(false);
      },
    });
    this.editor = new NoteEditor(editorBox, (title, body) => {
      if (this.selected === undefined) return;
      this.store = setBody(renameNote(this.store, this.selected, title), this.selected, body);
      this.render(false);
    });
    this.newNote.addEventListener('click', () => {
      this.store = addNote(this.store, 'Untitled', '');
      this.select((this.store.nextId - 1) as int);
    });
    this.render();
  }

  private select(id: int): void {
    this.selected = id;
    this.render();
  }

  /** Redraws the list and counter; reloads the editor unless it holds text the person is still typing. */
  private render(reloadEditor = true): void {
    const shown = searchNotes(this.store.notes, this.query);
    this.count.textContent = `${shown.length} of ${this.store.notes.length} notes`;
    this.list.render(shown, this.selected);
    if (reloadEditor) this.editor.load(this.store.notes.find((n) => n.id === this.selected));
  }
}

/** Starts the app in `root`, the element with id "app" when omitted. */
export function start(root: HTMLElement | null = document.getElementById('app')): App | undefined {
  return root === null ? undefined : new App(root);
}

if (document.getElementById('app') !== null) start();
