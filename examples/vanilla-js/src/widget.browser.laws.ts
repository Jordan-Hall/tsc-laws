import { assume, runModelAsync, type int } from 'tslaws';
import { accessible, click, mount, settle, type } from 'tslaws/browser';
import { start } from './app.js';
import { DISPLAY_DIGITS, convert, formatValue, type Unit } from './convert.js';
import { createWidget } from './widget.js';

const items = (list: HTMLElement) => [...list.querySelectorAll('li')];

export async law resultMatchesConvert(value: int, from: Unit, to: Unit) {
  assume(value >= -1000 && value <= 1000);
  const w = createWidget(mount());
  w.from.value = from;
  w.to.value = to;
  type(w.input, String(value));
  await settle();
  return w.output.textContent === `${formatValue(convert(value, from, to), DISPLAY_DIGITS)} ${to}`;
}

export async law emptyValueClearsResult(unit: Unit) {
  const w = createWidget(mount());
  w.from.value = unit;
  type(w.input, '');
  await settle();
  w.save.click();
  await settle();
  return w.output.textContent === '' && items(w.list).length === 0;
}

export async law historyListAgreesWithModel(ops: ('save' | 'removeNewest' | 'clear' | 'edit')[]) {
  const w = createWidget(mount());
  let edits = 0;
  return runModelAsync({
    ops,
    real: w,
    model: [] as string[],
    apply: async (ui, model, op) => {
      let next = model;
      if (op === 'edit') {
        edits += 1;
        type(ui.input, String(edits));
      } else if (op === 'save') {
        const label = `${formatValue(Number(ui.input.value), DISPLAY_DIGITS)} m = ${ui.output.textContent}`;
        click(ui.save);
        next = [label, ...model].slice(0, 5);
      } else if (op === 'removeNewest') {
        const first = ui.list.querySelector('li button');
        if (first !== null) click(first);
        next = model.slice(1);
      } else {
        click(ui.clear);
        next = [];
      }
      await settle(0);
      return next;
    },
    agree: (ui, model) =>
      items(ui.list).map((li) => li.querySelector('span')?.textContent).join('|') === model.join('|') &&
      ui.clear.disabled === (model.length === 0),
  });
}

export async law appStartsFocusedAndAccessible(value: int) {
  assume(value >= 0 && value <= 100);
  const root = mount();
  const w = start(root);
  if (w === undefined) return false;
  type(w.input, String(value));
  click(w.save);
  await settle();
  return document.activeElement === w.input && (await accessible(root));
}
