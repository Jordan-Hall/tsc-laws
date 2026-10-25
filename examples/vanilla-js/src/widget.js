// The converter widget: a form, a result and a history list, built with the DOM API alone.
import { DISPLAY_DIGITS, UNITS, convert, formatValue } from './convert.js';
import { History } from './history.js';

/**
 * @typedef {object} Widget
 * @property {HTMLInputElement} input
 * @property {HTMLSelectElement} from
 * @property {HTMLSelectElement} to
 * @property {HTMLOutputElement} output
 * @property {HTMLButtonElement} save
 * @property {HTMLButtonElement} clear
 * @property {HTMLUListElement} list
 * @property {History} history
 */

/**
 * @param {string} label
 * @param {HTMLElement} control
 * @returns {HTMLLabelElement}
 */
function labelled(label, control) {
  const wrapper = document.createElement('label');
  wrapper.append(`${label} `, control);
  return wrapper;
}

/**
 * @param {import('./convert.js').Unit} selected
 * @returns {HTMLSelectElement}
 */
function unitSelect(selected) {
  const select = document.createElement('select');
  for (const unit of UNITS) {
    const option = document.createElement('option');
    option.value = unit;
    option.textContent = unit;
    select.append(option);
  }
  select.value = selected;
  return select;
}

/**
 * Builds the widget inside `root` and keeps the result and history list in step with the controls.
 * @param {HTMLElement} root
 * @param {History} [history]
 * @returns {Widget}
 */
export function createWidget(root, history = new History(5)) {
  const form = document.createElement('form');
  form.setAttribute('aria-label', 'Length converter');
  form.addEventListener('submit', (event) => event.preventDefault());

  const input = document.createElement('input');
  input.type = 'number';
  input.step = 'any';
  input.value = '1';
  const from = unitSelect('m');
  const to = unitSelect('ft');
  const output = document.createElement('output');
  output.setAttribute('aria-live', 'polite');
  const save = document.createElement('button');
  save.type = 'button';
  save.textContent = 'Save to history';
  const heading = document.createElement('h2');
  heading.textContent = 'History';
  const list = document.createElement('ul');
  const clear = document.createElement('button');
  clear.type = 'button';
  clear.textContent = 'Clear history';

  const result = document.createElement('p');
  result.append('Result: ', output);
  form.append(labelled('Value', input), labelled('From', from), labelled('To', to), result, save, heading, list, clear);
  root.append(form);

  /** The current conversion as text, or undefined while the value is not a number. */
  const current = () => {
    if (input.value.trim() === '' || !Number.isFinite(input.valueAsNumber)) return undefined;
    const converted = convert(
      input.valueAsNumber,
      /** @type {import('./convert.js').Unit} */ (from.value),
      /** @type {import('./convert.js').Unit} */ (to.value),
    );
    return `${formatValue(input.valueAsNumber, DISPLAY_DIGITS)} ${from.value} = ${formatValue(converted, DISPLAY_DIGITS)} ${to.value}`;
  };

  const update = () => {
    const text = current();
    output.textContent = text === undefined ? '' : (text.split(' = ')[1] ?? '');
  };

  const renderHistory = () => {
    list.replaceChildren(
      ...history.entries.map((entry) => {
        const item = document.createElement('li');
        item.dataset.id = String(entry.id);
        const text = document.createElement('span');
        text.textContent = entry.label;
        const remove = document.createElement('button');
        remove.type = 'button';
        remove.textContent = 'Remove';
        remove.setAttribute('aria-label', `Remove ${entry.label}`);
        remove.addEventListener('click', () => {
          history.remove(entry.id);
          renderHistory();
        });
        item.append(text, ' ', remove);
        return item;
      }),
    );
    clear.disabled = history.entries.length === 0;
  };

  for (const control of [input, from, to]) {
    control.addEventListener('input', update);
    control.addEventListener('change', update);
  }
  save.addEventListener('click', () => {
    const text = current();
    if (text === undefined) return;
    history.add(text);
    renderHistory();
  });
  clear.addEventListener('click', () => {
    history.clear();
    renderHistory();
  });

  update();
  renderHistory();
  return { input, from, to, output, save, clear, list, history };
}
