import { assume, runModelAsync, type int } from 'tslaws';
import { accessible, click, mount, settle, type } from 'tslaws/browser';
import { start } from './app';
import { markdown } from './markdown';
import { NoteEditor } from './note-editor';
import { WordCounterElement } from './word-counter-element';

const rows = (root: HTMLElement) => [...root.querySelectorAll('li')];
const rowTitle = (row: HTMLElement) => row.querySelector('button')?.textContent;

// What the preview holds is what markdown() returns for the text, whatever was typed.
export async law previewMatchesMarkdown(text: string) {
  assume(text.length <= 120);
  const editor = new NoteEditor(mount(), () => {});
  editor.load({ id: 1 as int, title: 'a', body: '' });
  type(editor.textarea, text);
  await settle();
  const expected = document.createElement('div');
  expected.innerHTML = markdown(text);
  return editor.preview.innerHTML === expected.innerHTML && editor.preview.querySelector('script') === null;
}

export async law previewNeverRunsMarkup(text: string) {
  assume(text.length <= 60);
  const editor = new NoteEditor(mount(), () => {});
  editor.load({ id: 1 as int, title: 'a', body: '' });
  type(editor.textarea, `<script>window.__pwned = 1</script><img src=x onerror="window.__pwned = 1">${text}`);
  await settle();
  return editor.preview.querySelector('script, img') === null && (globalThis as { __pwned?: number }).__pwned === undefined;
}

export async law appAgreesWithModel(ops: ('add' | 'rename' | 'delete' | 'filterOn' | 'filterOff')[]) {
  const app = start(mount())!;
  type Row = { id: number; title: string };
  return runModelAsync({
    ops,
    real: app,
    model: { notes: [] as Row[], selected: undefined as number | undefined, filter: '', nextId: 1 },
    apply: async (ui, model, op, step) => {
      let { notes, selected, filter, nextId } = model;
      if (op === 'add') {
        click(ui.newNote);
        notes = [...notes, { id: nextId, title: 'Untitled' }];
        selected = nextId;
        nextId += 1;
      } else if (op === 'rename') {
        if (selected !== undefined) {
          type(ui.editor.title, `Note ${step}`);
          click(ui.editor.save);
          notes = notes.map((n) => (n.id === selected ? { ...n, title: `Note ${step}` } : n));
        }
      } else if (op === 'delete') {
        const target = notes.find((n) => n.title.toLowerCase().includes(filter));
        const button = ui.list.list.querySelector<HTMLButtonElement>('li button:last-of-type');
        if (button !== null && target !== undefined) {
          click(button);
          notes = notes.filter((n) => n !== target);
          if (selected === target.id) selected = undefined;
        }
      } else {
        filter = op === 'filterOn' ? 'note' : '';
        type(ui.list.filter, filter);
      }
      await settle(0);
      return { notes, selected, filter, nextId };
    },
    agree: (ui, model) => {
      const shown = model.notes.filter((n) => n.title.toLowerCase().includes(model.filter));
      return (
        rows(ui.list.list).map((r) => rowTitle(r)).join('|') === shown.map((n) => n.title).join('|') &&
        ui.count.textContent === `${shown.length} of ${model.notes.length} notes` &&
        ui.editor.save.disabled === (model.selected === undefined) &&
        (model.selected === undefined ||
          ui.editor.title.value === model.notes.find((n) => n.id === model.selected)?.title)
      );
    },
  });
}

export async law wordCounterFollowsItsAttribute(words: ('a' | 'bc' | 'def')[], then: ('a' | 'bc' | 'def')[]) {
  assume(words.length <= 6 && then.length <= 6);
  const counter = new WordCounterElement();
  mount().append(counter);
  const label = (n: number) => `${n} ${n === 1 ? 'word' : 'words'}`;
  counter.setAttribute('text', words.join(' '));
  await settle(0);
  const first = counter.textContent === label(words.length);
  counter.setAttribute('text', then.join('  '));
  await settle(0);
  const second = counter.textContent === label(then.length);
  counter.removeAttribute('text');
  await settle(0);
  return first && second && counter.textContent === '0 words';
}

export async law typingUpdatesTheCounterInTheEditor(text: string) {
  assume(text.length <= 80);
  const editor = new NoteEditor(mount(), () => {});
  editor.load({ id: 1 as int, title: 'a', body: '' });
  type(editor.textarea, text);
  await settle();
  const n = text.split(/[ \n\t\r]+/).filter((w) => w !== '').length;
  return editor.counter.textContent === `${n} ${n === 1 ? 'word' : 'words'}`;
}

export async law appIsAccessible(notes: int, text: string) {
  assume(notes >= 0 && notes <= 3 && text.length <= 80);
  const root = mount();
  const app = start(root)!;
  for (let i = 0; i < notes; i++) click(app.newNote);
  if (notes > 0) type(app.editor.textarea, text);
  await settle();
  return await accessible(root);
}
