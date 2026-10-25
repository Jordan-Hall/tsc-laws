import { assume, runModel, type int } from 'tslaws';
import {
  addNote,
  countWords,
  deleteNote,
  emptyStore,
  indexOfId,
  renameNote,
  searchNotes,
  setBody,
  type Note,
  type Store,
} from './notes-store';

export law addGrowsByOne(store: Store, title: string, body: string) {
  assume(store.notes.length <= 3);
  const next = addNote(store, title, body);
  return next.notes.length === store.notes.length + 1 && next.nextId === store.nextId + 1;
}

export law indexOfIdStaysInRange(notes: Note[], id: int) {
  const at = indexOfId(notes, id);
  return at >= -1 && at < notes.length;
}

export law proved wordCountIsBoundedByLength(text: string) {
  const n = countWords(text);
  return n >= 0 && n <= text.length;
}

export law wordsAreCountedBySplitting(words: ('alpha' | 'beta' | 'gamma')[]) {
  assume(words.length <= 8);
  return countWords(words.join(' ')) === words.length;
}

export law searchOnlyFiltersNotes(notes: Note[], query: string) {
  const found = searchNotes(notes, query);
  return found.length <= notes.length && found.every((n) => notes.includes(n));
}

export law searchFindsTheTitleItWasGiven(title: string) {
  assume(title.trim() !== '');
  const store = addNote(emptyStore(), title, '');
  return searchNotes(store.notes, title).length === 1;
}

export law deleteRemovesExactlyThatNote(store: Store, id: int) {
  const next = deleteNote(store, id);
  return (
    next.notes.every((n) => n.id !== id) &&
    next.notes.length === store.notes.filter((n) => n.id !== id).length &&
    next.nextId === store.nextId
  );
}

export law storeAgreesWithModel(ops: ('add' | 'rename' | 'edit' | 'deleteFirst')[]) {
  return runModel({
    ops,
    real: { store: emptyStore() },
    model: [] as { id: number; title: string; body: string }[],
    apply: (real, model, op, step) => {
      const first = real.store.notes[0];
      if (op === 'add') {
        real.store = addNote(real.store, `n${step}`, '');
        return [...model, { id: real.store.nextId - 1, title: `n${step}`, body: '' }];
      }
      if (first === undefined) return model;
      if (op === 'rename') {
        real.store = renameNote(real.store, first.id, `r${step}`);
        return model.map((m, i) => (i === 0 ? { ...m, title: `r${step}` } : m));
      }
      if (op === 'edit') {
        real.store = setBody(real.store, first.id, `b${step}`);
        return model.map((m, i) => (i === 0 ? { ...m, body: `b${step}` } : m));
      }
      real.store = deleteNote(real.store, first.id);
      return model.slice(1);
    },
    agree: (real, model) =>
      JSON.stringify(real.store.notes) === JSON.stringify(model) &&
      new Set(real.store.notes.map((n) => n.id)).size === real.store.notes.length,
  });
}
