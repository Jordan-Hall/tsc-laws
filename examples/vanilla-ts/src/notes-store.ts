// The notes, as plain data. Every function returns a new store; nothing here touches the DOM.
import { invariant, type int } from 'tslaws';

export interface Note {
  id: int;
  title: string;
  body: string;
}

export interface Store {
  notes: Note[];
  /** The id the next note gets; it only grows, so an id is never reused. */
  nextId: int;
}

export function emptyStore(): Store {
  return { notes: [], nextId: 1 as int };
}

export function addNote(store: Store, title: string, body: string): Store {
  return { notes: [...store.notes, { id: store.nextId, title, body }], nextId: (store.nextId + 1) as int };
}

export function renameNote(store: Store, id: int, title: string): Store {
  return { ...store, notes: store.notes.map((n) => (n.id === id ? { ...n, title } : n)) };
}

export function setBody(store: Store, id: int, body: string): Store {
  return { ...store, notes: store.notes.map((n) => (n.id === id ? { ...n, body } : n)) };
}

export function deleteNote(store: Store, id: int): Store {
  return { ...store, notes: store.notes.filter((n) => n.id !== id) };
}

/** The notes whose title or body contains `query`, ignoring case and surrounding spaces; an empty query keeps all. */
export function searchNotes(notes: Note[], query: string): Note[] {
  const q = query.trim().toLowerCase();
  if (q === '') return notes;
  return notes.filter((n) => n.title.toLowerCase().includes(q) || n.body.toLowerCase().includes(q));
}

/** Where the note with this id sits, or -1. The invariant lets the prover cover lists of any length. */
export function indexOfId(notes: Note[], id: int): int {
  let i = 0;
  while (i < notes.length) {
    invariant(0 <= i && i <= notes.length);
    if (notes[i]!.id === id) return i as int;
    i += 1;
  }
  return -1 as int;
}

/** Words are runs of anything but space, tab and line breaks. */
export function countWords(text: string): int {
  let words = 0;
  let i = 0;
  let inWord = false;
  while (i < text.length) {
    invariant(0 <= i && i <= text.length && 0 <= words && words <= i);
    const c = text.charAt(i);
    const space = c === ' ' || c === '\n' || c === '\t' || c === '\r';
    if (!space && !inWord) words += 1;
    inWord = !space;
    i += 1;
  }
  return words as int;
}
