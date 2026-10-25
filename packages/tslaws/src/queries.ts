/// <reference lib="dom" />
// Small testing-library-style queries over an element: by role (with an approximated accessible name), text, label and
// test id. No dependencies, so they bundle into any browser law.

export interface RoleOptions {
  /** The accessible name: a string matches exactly (whitespace-normalised), a RegExp is tested. */
  name?: string | RegExp;
  pressed?: boolean;
  checked?: boolean;
  disabled?: boolean;
}

export type Matcher = string | RegExp;

/** The queries, bound to one root element. `Mounted.query` is one of these. */
export interface Queries {
  byRole(role: string, options?: RoleOptions): HTMLElement;
  allByRole(role: string, options?: RoleOptions): HTMLElement[];
  byText(text: Matcher): HTMLElement;
  allByText(text: Matcher): HTMLElement[];
  byLabel(label: Matcher): HTMLElement;
  allByLabel(label: Matcher): HTMLElement[];
  byTestId(id: string): HTMLElement;
  allByTestId(id: string): HTMLElement[];
  /** The root's text with whitespace collapsed. */
  text(): string;
}

/** Text with runs of whitespace collapsed to one space and the ends trimmed. */
export function text(el: Node): string {
  return (el.textContent ?? '').replace(/\s+/g, ' ').trim();
}

const inputRoles: Record<string, string> = {
  button: 'button',
  submit: 'button',
  reset: 'button',
  image: 'button',
  checkbox: 'checkbox',
  radio: 'radio',
  range: 'slider',
  number: 'spinbutton',
  search: 'searchbox',
  email: 'textbox',
  tel: 'textbox',
  text: 'textbox',
  url: 'textbox',
  password: '',
};

/** The element's role: an explicit `role`, else the implicit role of its tag. Empty string when it has none. */
export function roleOf(el: Element): string {
  const explicit = el.getAttribute('role')?.trim().split(/\s+/)[0];
  if (explicit) return explicit;
  const tag = el.tagName.toLowerCase();
  switch (tag) {
    case 'button':
    case 'summary':
      return 'button';
    case 'a':
    case 'area':
      return el.hasAttribute('href') ? 'link' : '';
    case 'input':
      return inputRoles[(el.getAttribute('type') ?? 'text').toLowerCase()] ?? 'textbox';
    case 'select':
      return el.hasAttribute('multiple') || Number(el.getAttribute('size') ?? 0) > 1 ? 'listbox' : 'combobox';
    case 'textarea':
      return 'textbox';
    case 'h1':
    case 'h2':
    case 'h3':
    case 'h4':
    case 'h5':
    case 'h6':
      return 'heading';
    case 'li':
      return 'listitem';
    case 'ul':
    case 'ol':
      return 'list';
    case 'img':
      return el.getAttribute('alt') === '' ? 'presentation' : 'img';
    case 'nav':
      return 'navigation';
    case 'main':
      return 'main';
    case 'form':
      return 'form';
    case 'header':
      return 'banner';
    case 'footer':
      return 'contentinfo';
    case 'aside':
      return 'complementary';
    case 'table':
      return 'table';
    case 'tr':
      return 'row';
    case 'td':
      return 'cell';
    case 'th':
      return 'columnheader';
    case 'dialog':
      return 'dialog';
    case 'progress':
      return 'progressbar';
    case 'option':
      return 'option';
    case 'article':
      return 'article';
    case 'hr':
      return 'separator';
    case 'section':
      return el.hasAttribute('aria-label') || el.hasAttribute('aria-labelledby') ? 'region' : '';
    default:
      return '';
  }
}

function idText(el: Element, ids: string): string {
  const doc = el.ownerDocument;
  return ids
    .split(/\s+/)
    .map((id) => doc.getElementById(id))
    .filter((x): x is HTMLElement => x !== null)
    .map(text)
    .join(' ');
}

function labelsOf(el: Element): string[] {
  const labels: string[] = [];
  const doc = el.ownerDocument;
  if (el.id) for (const l of Array.from(doc.querySelectorAll('label'))) if (l.htmlFor === el.id) labels.push(text(l));
  const wrapping = el.closest('label');
  if (wrapping !== null) labels.push(text(wrapping));
  return labels;
}

/** An approximation of the accessible name: aria-labelledby, aria-label, a label, alt, value or content, then title. */
export function nameOf(el: Element): string {
  const by = el.getAttribute('aria-labelledby');
  if (by) {
    const joined = idText(el, by);
    if (joined) return joined;
  }
  const aria = el.getAttribute('aria-label')?.trim();
  if (aria) return aria;
  const tag = el.tagName.toLowerCase();
  if (tag === 'input' || tag === 'select' || tag === 'textarea') {
    const labels = labelsOf(el);
    if (labels[0]) return labels[0];
    const type = (el.getAttribute('type') ?? '').toLowerCase();
    if (tag === 'input' && ['button', 'submit', 'reset'].includes(type)) {
      return (el as HTMLInputElement).value || (type === 'submit' ? 'Submit' : type === 'reset' ? 'Reset' : '');
    }
    const placeholder = el.getAttribute('placeholder');
    if (placeholder) return placeholder;
  }
  if (tag === 'img' || (tag === 'input' && el.getAttribute('type') === 'image')) {
    const alt = el.getAttribute('alt');
    if (alt) return alt.trim();
  }
  const content = text(el);
  if (content) return content;
  return el.getAttribute('title')?.trim() ?? '';
}

function matches(actual: string, wanted: Matcher): boolean {
  if (typeof wanted === 'string') return actual === wanted.replace(/\s+/g, ' ').trim();
  wanted.lastIndex = 0;
  return wanted.test(actual);
}

function describeMatcher(wanted: Matcher): string {
  return typeof wanted === 'string' ? JSON.stringify(wanted) : String(wanted);
}

function hidden(el: Element): boolean {
  return el.hasAttribute('hidden') || el.getAttribute('aria-hidden') === 'true';
}

function elements(root: Element): HTMLElement[] {
  return Array.from(root.querySelectorAll<HTMLElement>('*')).filter((e) => !hidden(e));
}

function isChecked(el: Element): boolean {
  if (el instanceof HTMLInputElement && (el.type === 'checkbox' || el.type === 'radio')) return el.checked;
  return el.getAttribute('aria-checked') === 'true';
}

function isDisabled(el: Element): boolean {
  return (el as HTMLButtonElement).disabled === true || el.getAttribute('aria-disabled') === 'true';
}

function describeOptions(options: RoleOptions): string {
  const parts: string[] = [];
  if (options.name !== undefined) parts.push(`name ${describeMatcher(options.name)}`);
  for (const key of ['pressed', 'checked', 'disabled'] as const)
    if (options[key] !== undefined) parts.push(`${key} ${options[key]}`);
  return parts.length > 0 ? ` with ${parts.join(', ')}` : '';
}

function summary(root: Element, pick: (el: HTMLElement) => string | undefined): string {
  const lines = elements(root)
    .map(pick)
    .filter((s): s is string => s !== undefined);
  const shown = lines.slice(0, 20).map((l) => `  ${l}`);
  if (lines.length > 20) shown.push(`  ... and ${lines.length - 20} more`);
  return shown.length > 0 ? shown.join('\n') : '  (nothing)';
}

function one<T>(found: T[], what: string, listing: () => string): T {
  if (found.length === 0) throw new Error(`no element ${what}. Found:\n${listing()}`);
  if (found.length > 1) throw new Error(`${found.length} elements ${what}; use the all* query or be more specific`);
  return found[0]!;
}

export function allByRole(root: Element, role: string, options: RoleOptions = {}): HTMLElement[] {
  return elements(root).filter((el) => {
    if (roleOf(el) !== role) return false;
    if (options.name !== undefined && !matches(nameOf(el), options.name)) return false;
    if (options.pressed !== undefined && (el.getAttribute('aria-pressed') === 'true') !== options.pressed) return false;
    if (options.checked !== undefined && isChecked(el) !== options.checked) return false;
    if (options.disabled !== undefined && isDisabled(el) !== options.disabled) return false;
    return true;
  });
}

export function byRole(root: Element, role: string, options: RoleOptions = {}): HTMLElement {
  return one(allByRole(root, role, options), `with role ${JSON.stringify(role)}${describeOptions(options)}`, () =>
    summary(root, (el) => {
      const r = roleOf(el);
      if (r === '') return undefined;
      const n = nameOf(el);
      return n ? `${r} ${JSON.stringify(n.length > 60 ? `${n.slice(0, 57)}...` : n)}` : r;
    }),
  );
}

// An element's own text: its direct text nodes, so a wrapper does not match its child's text.
function ownText(el: Element): string {
  return Array.from(el.childNodes)
    .filter((n) => n.nodeType === Node.TEXT_NODE)
    .map((n) => n.textContent ?? '')
    .join('')
    .replace(/\s+/g, ' ')
    .trim();
}

export function allByText(root: Element, wanted: Matcher): HTMLElement[] {
  return elements(root).filter((el) => {
    if (['script', 'style'].includes(el.tagName.toLowerCase())) return false;
    const own = ownText(el);
    return own !== '' && matches(own, wanted);
  });
}

export function byText(root: Element, wanted: Matcher): HTMLElement {
  return one(allByText(root, wanted), `with text ${describeMatcher(wanted)}`, () =>
    summary(root, (el) => {
      const own = ownText(el);
      return own === ''
        ? undefined
        : `<${el.tagName.toLowerCase()}> ${JSON.stringify(own.length > 60 ? `${own.slice(0, 57)}...` : own)}`;
    }),
  );
}

export function allByLabel(root: Element, wanted: Matcher): HTMLElement[] {
  const found = new Set<HTMLElement>();
  const doc = root.ownerDocument;
  for (const label of Array.from(root.querySelectorAll('label'))) {
    if (!matches(text(label), wanted)) continue;
    const target = label.control ?? (label.htmlFor ? doc.getElementById(label.htmlFor) : null);
    if (target instanceof HTMLElement) found.add(target);
  }
  for (const el of elements(root)) {
    const aria = el.getAttribute('aria-label');
    if (aria !== null && matches(aria.replace(/\s+/g, ' ').trim(), wanted)) found.add(el);
    const by = el.getAttribute('aria-labelledby');
    if (by && matches(idText(el, by), wanted)) found.add(el);
  }
  return Array.from(found).filter((el) => root.contains(el));
}

export function byLabel(root: Element, wanted: Matcher): HTMLElement {
  return one(allByLabel(root, wanted), `labelled ${describeMatcher(wanted)}`, () => {
    const labels = Array.from(root.querySelectorAll('label')).map((l) => `  label ${JSON.stringify(text(l))}`);
    const aria = elements(root)
      .filter((el) => el.hasAttribute('aria-label'))
      .map((el) => `  aria-label ${JSON.stringify(el.getAttribute('aria-label'))}`);
    const all = [...labels, ...aria];
    return all.length > 0 ? all.join('\n') : '  (no labels)';
  });
}

export function allByTestId(root: Element, id: string): HTMLElement[] {
  return Array.from(root.querySelectorAll<HTMLElement>('[data-testid]')).filter(
    (el) => el.getAttribute('data-testid') === id,
  );
}

export function byTestId(root: Element, id: string): HTMLElement {
  return one(allByTestId(root, id), `with data-testid ${JSON.stringify(id)}`, () => {
    const ids = Array.from(root.querySelectorAll('[data-testid]')).map(
      (el) => `  data-testid ${JSON.stringify(el.getAttribute('data-testid'))}`,
    );
    return ids.length > 0 ? ids.join('\n') : '  (no data-testid)';
  });
}

/** The queries bound to `root`. */
export function within(root: Element): Queries {
  return {
    byRole: (role, options) => byRole(root, role, options),
    allByRole: (role, options) => allByRole(root, role, options),
    byText: (wanted) => byText(root, wanted),
    allByText: (wanted) => allByText(root, wanted),
    byLabel: (wanted) => byLabel(root, wanted),
    allByLabel: (wanted) => allByLabel(root, wanted),
    byTestId: (id) => byTestId(root, id),
    allByTestId: (id) => allByTestId(root, id),
    text: () => text(root),
  };
}
