// Component-level browser laws: isolated mounting with props generated from the props type, adapters (with a tiny fake
// React and no real framework), spy, rendersSame, queries and function-typed props. Needs Chrome, Edge or Chromium (or
// TSLAWS_BROWSER), TSC_LAWS_BIN, and `npm run build` for dist/.
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { after, describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';
import { check } from '../dist/check.js';
import { readManifest } from '../dist/compile.js';
import { writeLock } from '../dist/lock.js';
import type { CheckOptions, LawResult } from '../dist/types.js';

const compiler = process.env.TSC_LAWS_BIN;
const here = dirname(fileURLToPath(import.meta.url));
const root = mkdtempSync(join(here, '..', '.tmp-component-'));

function hasBrowser(): boolean {
  if (process.env.TSLAWS_BROWSER !== undefined) return existsSync(process.env.TSLAWS_BROWSER);
  const bases = [process.env.PROGRAMFILES, process.env['PROGRAMFILES(X86)'], process.env.LOCALAPPDATA];
  const found = bases.some(
    (b) =>
      b !== undefined &&
      (existsSync(join(b, 'Google/Chrome/Application/chrome.exe')) ||
        existsSync(join(b, 'Microsoft/Edge/Application/msedge.exe'))),
  );
  return (
    found ||
    existsSync('/Applications/Google Chrome.app') ||
    ['/usr/bin/google-chrome', '/usr/bin/chromium', '/usr/bin/chromium-browser'].some(existsSync)
  );
}

after(() => {
  rmSync(root, { recursive: true, force: true });
  setTimeout(() => process.exit(process.exitCode ?? 0), 100).unref();
});

function project(name: string, lawFile: string, files: Record<string, string>): CheckOptions {
  const cwd = join(root, name);
  for (const [file, text] of Object.entries(files)) {
    mkdirSync(dirname(join(cwd, file)), { recursive: true });
    writeFileSync(join(cwd, file), text);
  }
  const options: CheckOptions = {
    files: [lawFile],
    cwd,
    runs: 20,
    compiler: compiler!,
    lockFile: join(cwd, 'tsc-laws.lock'),
    noProve: true,
    bound: 4,
    proofTimeoutMs: 5000,
    propertyTimeoutMs: 40000,
  };
  writeLock(options.lockFile, readManifest(compiler!, options.files, cwd));
  return options;
}

function byName(results: LawResult[], name: string): LawResult {
  const found = results.find((r) => r.name === name);
  assert.ok(found, `no result for ${name}: ${JSON.stringify(results)}`);
  return found;
}

// A stand-in for React: createElement builds a vnode, createRoot().render rebuilds the container. `useRef` keeps state
// per root across renders, which is all the impure component needs.
const fakeReact = [
  'export interface VNode { type: unknown; props: Record<string, unknown> }',
  'export function createElement(type: unknown, props: Record<string, unknown>): VNode { return { type, props }; }',
  'let current: { refs: { value: unknown }[]; cursor: number } | undefined;',
  'export function useRef<T>(initial: T): { value: T } {',
  '  const slot = current!;',
  '  if (slot.cursor >= slot.refs.length) slot.refs.push({ value: initial });',
  '  return slot.refs[slot.cursor++] as { value: T };',
  '}',
  'function build(node: unknown): Node {',
  "  if (typeof node === 'string') return document.createTextNode(node);",
  '  const v = node as VNode;',
  "  if (typeof v.type === 'function') return build((v.type as (p: unknown) => unknown)(v.props));",
  '  const el = document.createElement(v.type as string);',
  '  for (const [k, x] of Object.entries(v.props)) {',
  "    if (k === 'children') el.append(...([x].flat() as unknown[]).map(build));",
  "    else if (k === 'onClick') el.addEventListener('click', x as () => void);",
  '    else el.setAttribute(k, String(x));',
  '  }',
  '  return el;',
  '}',
  'export function createRoot(container: HTMLElement) {',
  '  const slot = { refs: [] as { value: unknown }[], cursor: 0 };',
  '  return {',
  '    render(node: unknown): void {',
  '      current = slot;',
  '      slot.cursor = 0;',
  '      container.replaceChildren(build(node));',
  '      current = undefined;',
  '    },',
  '    unmount(): void { container.replaceChildren(); },',
  '  };',
  '}',
  '',
].join('\n');

const components = [
  "import type { int } from 'tslaws';",
  "import { createElement, useRef } from './fake-react';",
  'export interface BadgeProps { label: string; count: int; onSelect: () => void }',
  'export function Badge(props: BadgeProps) {',
  "  return createElement('button', { onClick: props.onSelect, children: `${props.label} (${props.count})` });",
  '}',
  'export interface StaleProps { label: string }',
  'export function Stale(props: StaleProps) {',
  '  const first = useRef(props.label);',
  "  return createElement('span', { children: first.value });",
  '}',
  '',
].join('\n');

const lawsPrelude = [
  "import type { int } from 'tslaws';",
  "import { assume } from 'tslaws';",
  "import { click, domAdapter, elementAdapter, mount, mountComponent, reactAdapter, rendersSame, spy, within } from 'tslaws/browser';",
  "import { createElement, createRoot } from './fake-react';",
  "import { Badge, Stale, type BadgeProps, type StaleProps } from './components';",
  'const react = reactAdapter({ createElement, createRoot });',
];

const passing = [
  ...lawsPrelude,
  // (a) props generated from the type, including the function-typed one.
  'export async law badgeRendersAnyProps(props: BadgeProps) {',
  '  const m = await mountComponent(react, Badge, props);',
  '  click(m.query.byRole("button"));',
  '  return typeof props.onSelect === "function" && m.query.byRole("button").textContent === `${props.label} (${props.count})`;',
  '}',
  // (b) rendering is a pure function of props.
  'export async law badgeRendersSame(a: BadgeProps, b: BadgeProps) {',
  '  return await rendersSame(react, Badge, a, b);',
  '}',
  // (c) the dom adapter and the element adapter.
  'const Greeting = (p: { name: string }) => { const s = document.createElement("p"); s.textContent = `Hi ${p.name}`; return s; };',
  'export async law domComponentsRerender(a: { name: string }, b: { name: string }) {',
  '  const m = await mountComponent(domAdapter, Greeting, a);',
  '  const first = m.el.textContent === `Hi ${a.name}`;',
  '  await m.rerender(b);',
  '  return first && m.el.textContent === `Hi ${b.name}` && m.props === b && m.el.querySelectorAll("p").length === 1;',
  '}',
  'class XTag extends HTMLElement {',
  '  _label = "";',
  '  set label(v: string) { this._label = v; this.textContent = `[${v}]`; }',
  '  get label(): string { return this._label; }',
  '}',
  'export async law customElementsGetProps(props: { label: string }) {',
  '  const m = await mountComponent(elementAdapter<{ label: string }>("x-tag"), XTag, props);',
  '  const same = m.el.querySelector("x-tag")!.textContent === `[${props.label}]`;',
  '  await m.rerender({ label: props.label + "!" });',
  '  return same && m.el.querySelector("x-tag")!.textContent === `[${props.label}!]`;',
  '}',
  // (d) spy and queries.
  'export async law spyCountsClicks(n: int) {',
  '  assume(n >= 0 && n <= 4);',
  '  const onSelect = spy();',
  '  const m = await mountComponent(react, Badge, { label: "x", count: 1 as int, onSelect });',
  '  for (let i = 0; i < n; i++) click(m.query.byRole("button", { name: /^x/ }));',
  '  return onSelect.count === n && onSelect.calls.length === n;',
  '}',
  'export async law queriesFindAndExplain(n: int) {',
  '  assume(n >= 0 && n <= 2);',
  '  const el = mount(`<label for="a">Name</label><input id="a"><button aria-pressed="true">Go ${n}</button><h2>Title</h2><div data-testid="t">  spaced   out </div>`);',
  '  const q = within(el);',
  '  const found =',
  '    q.byLabel("Name") === q.byRole("textbox", { name: "Name" }) &&',
  '    q.byRole("button", { pressed: true, name: /^go/i }).textContent === `Go ${n}` &&',
  '    q.allByRole("button", { pressed: false }).length === 0 &&',
  '    q.byRole("heading").textContent === "Title" &&',
  '    q.byText("Title").tagName === "H2" &&',
  '    q.byTestId("t").textContent!.trim() === "spaced   out" &&',
  '    q.byText("spaced out").dataset.testid === "t" &&',
  '    q.text().includes("Title");',
  '  let message = "";',
  '  try { q.byRole("button", { name: "Nope" }); } catch (e) { message = (e as Error).message; }',
  '  let missing = "";',
  '  try { q.byLabel("Nobody"); } catch (e) { missing = (e as Error).message; }',
  '  return found && message.includes("Nope") && message.includes(`button "Go ${n}"`) && missing.includes("label \\"Name\\"");',
  '}',
  // (e) function-typed props.
  'export async law functionPropsReturnInts(props: { f: (n: int) => int; g: () => void }) {',
  '  const r = props.f(1 as int);',
  '  return Number.isInteger(r) && r === props.f(1 as int) && props.g() === undefined;',
  '}',
  '',
];

const impure = [
  ...lawsPrelude,
  'export async law staleComponentRendersSame(a: StaleProps, b: StaleProps) {',
  '  return await rendersSame(react, Stale, a, b);',
  '}',
  '',
];

describe(
  'component laws',
  { skip: compiler === undefined || !hasBrowser() ? 'needs TSC_LAWS_BIN and a browser' : false },
  () => {
    it('mount a component with generated props through the adapters, with spies and queries', async () => {
      const opts = project('pass', 'src/ui.browser.laws.ts', {
        'src/fake-react.ts': fakeReact,
        'src/components.ts': components,
        'src/ui.browser.laws.ts': passing.join('\n'),
      });
      const { results, compileDiagnostics } = await check(opts, true);
      assert.equal(compileDiagnostics, '');
      for (const name of [
        'badgeRendersAnyProps',
        'badgeRendersSame',
        'domComponentsRerender',
        'customElementsGetProps',
        'spyCountsClicks',
        'queriesFindAndExplain',
        'functionPropsReturnInts',
      ]) {
        const r = byName(results, name);
        assert.equal(r.status, 'tested', JSON.stringify(r));
        assert.equal(r.method, 'browser');
      }
    });

    it('fail rendersSame for a component that keeps stale state, with a counterexample', async () => {
      const opts = project('impure', 'src/ui.browser.laws.ts', {
        'src/fake-react.ts': fakeReact,
        'src/components.ts': components,
        'src/ui.browser.laws.ts': impure.join('\n'),
      });
      const { results, ok } = await check(opts, true);
      const r = byName(results, 'staleComponentRendersSame');
      assert.equal(r.status, 'failed', JSON.stringify(r));
      assert.ok(r.counterexample !== undefined && r.counterexample.includes('label'), String(r.counterexample));
      assert.equal(ok, false);
    });

    it('generate function-typed props for laws that run in node too', async () => {
      const opts = project('node-fn', 'src/fn.laws.ts', {
        'src/fn.laws.ts': [
          "import type { int } from 'tslaws';",
          'export law callbacksReturnInts(props: { f: (n: int) => int }) {',
          '  return Number.isInteger(props.f(1 as int));',
          '}',
          '',
        ].join('\n'),
      });
      const { results } = await check(opts, true);
      const r = byName(results, 'callbacksReturnInts');
      assert.equal(r.status, 'tested', JSON.stringify(r));
    });
  },
);
