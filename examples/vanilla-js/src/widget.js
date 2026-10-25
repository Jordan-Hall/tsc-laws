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

// The look of the converter, in the widget so that a browser law mounts what a user sees.
const look = `
.converter { --ink: #1f2937; --muted: #4b5563; --line: #e5e7eb; --accent: #b45309; --accent-soft: #fef3c7;
  box-sizing: border-box; max-width: 26rem; margin: 2rem auto; padding: 1.25rem 1.5rem; background: #fff; color: var(--ink);
  border: 1px solid var(--line); border-radius: 16px; box-shadow: 0 10px 30px rgba(31, 41, 55, .10);
  font: 16px/1.5 system-ui, -apple-system, 'Segoe UI', Roboto, sans-serif; }
.converter form { display: grid; gap: .75rem; }
.converter label { display: grid; gap: .25rem; font-weight: 600; font-size: .9rem; }
.converter input, .converter select { font: 400 1rem/1.4 inherit; padding: .5rem .7rem; border: 1px solid #9ca3af; border-radius: 10px; background: #fff; color: var(--ink); }
.converter input:focus-visible, .converter select:focus-visible, .converter button:focus-visible { outline: 3px solid #fcd34d; outline-offset: 2px; }
.converter p { margin: 0; padding: .75rem 1rem; background: var(--accent-soft); border-radius: 10px; color: #78350f; font-size: 1.1rem; }
.converter output { font-weight: 700; }
.converter button { font: inherit; cursor: pointer; padding: .5rem .9rem; border-radius: 10px; border: 1px solid transparent; background: var(--accent); color: #fff; justify-self: start; }
.converter button:hover:not(:disabled) { filter: brightness(1.12); }
.converter button:disabled { cursor: not-allowed; opacity: .5; }
.converter h2 { margin: .5rem 0 0; font-size: 1rem; color: var(--muted); }
.converter ul { list-style: none; margin: 0; padding: 0; display: grid; gap: .25rem; }
.converter li { display: flex; justify-content: space-between; align-items: center; padding: .35rem .7rem; border: 1px solid var(--line); border-radius: 10px; }
.converter li button { background: transparent; color: #b91c1c; padding: .15rem .5rem; }
`;

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
  root.classList.add('converter');
  const style = document.createElement('style');
  style.textContent = look;
  root.append(style, form);

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
