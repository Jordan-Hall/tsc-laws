# Laws for TypeScript

`tsc-laws` is a fork of [tsc-ts](https://github.com/vercel-labs/tsc-ts) that adds one statement to TypeScript, `law`, and
`tslaws`, a checker that holds your code to those laws. It exists so that people can say what code must do, let coding
agents write the code, and get a machine verdict instead of a code review. The idea is Bend 2's: the person writes the
laws, the agent writes the program and its proofs, and a checker the agent cannot talk round gates every change. The
difference is that it stays TypeScript, so any human can read, run and fix everything.

## What it offers

| Offer                            | What you get                                                                                                                                                                                                                                                                       |
| -------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **`law` declarations**           | A statement of the language, type-checked like a function, that says what must hold for all inputs.                                                                                                                                                                                |
| **Verdicts, not opinions**       | Each law ends `proved`, `bounded`, `tested`, `failed`, `open`, `uncovered`, `tampered` or `error`. One exit status.                                                                                                                                                                |
| **Real proofs**                  | Z3 proves laws over exact integers, bigints, booleans, strings and records, and over IEEE doubles where it can decide. Loop invariants extend this to loops for every iteration count.                                                                                             |
| **Bounded proofs**               | Arrays, plain loops and recursion are checked exhaustively up to a stated bound.                                                                                                                                                                                                   |
| **Property tests as the floor**  | Anything the prover cannot lower is tested with `fast-check`; inputs are generated from your declared types, and failures shrink to a minimal counterexample with a seed.                                                                                                          |
| **Laws the agent cannot weaken** | `tsc-laws.lock` hashes every law. Changing, adding or removing one, or exempting code, fails the check until a person runs `tslaws accept`, which refuses to run without a terminal unless that person has lent it for a limited time ([delegation](#lending-accept-to-an-agent)). |
| **Coverage**                     | Every exported function and class must be reached by a law, so new code cannot slip through unchecked.                                                                                                                                                                             |
| **Agent ergonomics**             | `tslaws init` scaffolds the rules and a Claude Code hook; `--json` and `--summary` give structured, compact output with a next-action `hint` per result; `--watch` re-checks on save.                                                                                              |
| **Human ergonomics**             | A VS Code grammar for `law`, plain TypeScript output, and counterexamples you can paste into a test.                                                                                                                                                                               |

## How it compares with Bend 2

|                             | Bend 2                                             | tsc-laws                                                                                                                         |
| --------------------------- | -------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------- |
| Language                    | A new language                                     | TypeScript with one added statement                                                                                              |
| Who writes what             | Person: `LAWS.bend`. Agent: code and `PROOF.bend`. | Person: `*.laws.ts`. Agent: code, and loop `invariant`s inside it.                                                               |
| Checker                     | The type checker is the proof checker              | Z3 over symbolic execution of the real code, plus property tests where proof is out of reach                                     |
| Strength of "pass"          | A proof for all inputs                             | `proved` (all inputs), `bounded` (all inputs within a stated bound) or `tested` (no counterexample found); the status says which |
| Agent cannot cheat the laws | Human reviews the laws file                        | Lock file plus coverage gate; agents propose in `*.proposed.laws.ts`                                                             |
| Escape hatch for humans     | Learn Bend                                         | Read the code, run it, fix it                                                                                                    |

The honest difference: a Bend proof is checked by the type system for every program it accepts. Here, proof covers the part
of TypeScript that lowers to SMT (see [The prover](#the-prover)), and the rest is tested. Every result says which it is.

## Laws versus unit tests

A unit test checks examples you chose: `sort([3,1,2])` gives `[1,2,3]`. A law states a property of all inputs: for any
array, the result is ordered and has the same length. Both are TypeScript the agent must satisfy, but they differ in what
they can promise and who controls them.

|                       | Unit test                                                           | Law                                                                                                |
| --------------------- | ------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------- |
| Says                  | "for this input, this output"                                       | "for every input of this type, this holds"                                                         |
| Inputs                | Written by hand; the agent can pick easy ones                       | Generated from the declared types, biased to edge cases, shrunk to a minimal counterexample        |
| Strongest verdict     | Passed on the cases written                                         | `proved` for all inputs, or `bounded` for all inputs within a stated bound, or `tested`            |
| Who can change it     | Anyone, including the agent that is being checked                   | Only a person: the lock fails the check on any change, addition or removal                         |
| Missing code          | An untested function is invisible                                   | An exported function no law reaches fails as `uncovered`                                           |
| Can the agent game it | Yes: edit the test, delete it, assert less, special-case the inputs | Not by editing: the lock catches it. Special-casing is caught by generated inputs and by the proof |
| Feedback              | "expected 3, got 2"                                                 | A minimal failing input, the seed, and a next-action hint                                          |
| Cost to write         | Cheap per case, many cases                                          | One statement per behaviour, but you must be able to state the behaviour                           |

They also fit together: laws say what must always hold, and unit tests still pin down specific examples, regressions and
integration behaviour. Use laws for the properties you would otherwise review the agent's code for (ordering, bounds,
round-trips, "never negative", "same length", "idempotent"), and keep example tests for everything that is a case rather
than a rule.

## Quick start

```sh
npm i -D tslaws                 # plus the tsc-laws compiler binary, see "Build" below
npx tslaws init                 # config, agent rules, Claude Code hook; never writes the lock
# write src/foo.laws.ts, then, as a person at a terminal:
npx tslaws accept               # records the laws (and any coverage exemptions) in tsc-laws.lock
npx tslaws check                # exit 0 only when everything holds
npx tslaws check --watch        # re-check on every save
```

A law file:

```ts
// src/math.laws.ts
import { assume } from 'tslaws';
import type { int } from 'tslaws';
import { clamp, sortNumbers } from './math';

// Expression form: holds when it returns anything but false and does not throw.
export law addCommutes(a: number, b: number) => a + b === b + a;

// Block form, with a precondition. `proved` demands a proof for every input.
export law proved clampWithinBounds(x: number, lo: number, hi: number) {
  assume(lo <= hi);
  const y = clamp(x, lo, hi);
  return y >= lo && y <= hi;
}

// Arrays are checked exhaustively up to --bound (default 4), exactly like a bounded model checker.
export law sortOrders(xs: int[]) {
  const s = sortNumbers(xs);
  for (let i = 1; i < s.length; i++) if (s[i - 1] > s[i]) return false;
  return true;
}
```

## The language

`law` is a contextual keyword: it starts a statement only as `law name(` or `law proved name(` on one line, optionally
after `export`. Everywhere else it is an ordinary identifier, so existing code with variables or functions named `law`
keeps compiling.

```
law [proved] name<T>(a: A, b: B)  { block }
law [proved] name<T>(a: A, b: B)  => expression;
```

A law compiles to an ordinary exported function, so it type-checks and appears in declaration output.

### What the language does that a package cannot

`law` is part of the compiler, not a convention of a test library. The fork parses it and the **checker enforces the rules
of a specification**, as ordinary compile errors in your editor and in `tsc-laws` output:

| Code   | Rule                                                                                                                                 |
| ------ | ------------------------------------------------------------------------------------------------------------------------------------ |
| TS9101 | A law returns `boolean` or `void` (a promise of either, when it is `async`). Anything else is not a claim.                           |
| TS9102 | A law is exported, so the runner can load it.                                                                                        |
| TS9103 | Every parameter has a type annotation, because the type generates the inputs.                                                        |
| TS9104 | A law is not a generator or a default export.                                                                                        |
| TS9105 | Only another law may call a law. Application code cannot call a specification, so a law cannot become part of the program it checks. |
| TS9106 | Parameters are plain identifiers (no destructuring), so inputs map one to one.                                                       |

It also fixes what a package cannot: the declaration is a distinct kind of node (`law proved` is a modifier the lock hashes,
not a comment or a naming pattern), `--laws-manifest` lists every law from the syntax tree rather than by regex, and `law`
stays an identifier everywhere else, so no existing code breaks. What stays in the runner is what needs a runtime: running,
generating, proving, locking. Both halves are needed; the compiler makes a malformed or misplaced law impossible to write,
and the runner decides whether the code satisfies it.

Helpers from `tslaws`:

- `assume(cond)`: skip inputs the law does not cover. If it discards nearly every input the law is `open`.
- `int`: a whole number the prover treats exactly. At runtime an ordinary `number`.
- `invariant(cond)`: first statement of a loop body (see below). Throws at runtime if false.
- `arbitrary(typeName, fc.Arbitrary)`: a generator for a type the runner cannot derive.

## Browser laws

A laws file that imports `tslaws/browser` (or an adapter under `tslaws/adapters/`), directly or through its own helper modules, runs its laws in a real browser (Chrome, Edge or Chromium; `TSLAWS_BROWSER` points at
another executable). No file name is needed; see [Laws files, levels and proposals](#laws-files-levels-and-proposals). Node still generates the inputs from the declared types and shrinks failures; each input is sent to a
page where your compiled code and the law run against a live DOM. A law there may be `async`.

```ts
// src/counter.laws.ts
import type { int } from 'tslaws';
import { assume } from 'tslaws';
import { click, mount, settle } from 'tslaws/browser';
import { createCounter } from './counter';

export async law counterCountsClicks(clicks: int) {
  assume(clicks >= 0 && clicks <= 5);
  const { button, label } = createCounter(mount());
  for (let i = 0; i < clicks; i++) click(button);
  await settle();
  return label.textContent === String(clicks);
}
```

It is framework-agnostic: the law talks to the DOM. `mount(content)` takes markup, a node, or a function that renders into
the container (React's `createRoot(el).render(...)`, Vue's `createApp(...).mount(el)`, Svelte, Lit, or plain DOM) and may
return what undoes it. The page is cleaned between inputs. `tslaws/browser` also has `settle`, `click`, `type` and `fire`.

Browser laws are `tested` (method `browser`), never `proved`: Z3 cannot model a DOM or an `await`. A page that never
settles is stopped after `--property-timeout` and reported `error`. They sit under the same lock and coverage gate as any law.
To test a single component with props generated from its type, see [Component testing](#component-testing). To drive a whole
running app from outside, a file in the same suffix that imports `tslaws/e2e` runs as an [end-to-end law](#end-to-end-laws).

### Component testing

The laws above mount a whole app and drive it. To test **one component in isolation**, with its props generated from its props
type, use `mountComponent` with an adapter for your framework. tslaws has no framework dependency: you pass the framework's own
functions to the adapter.

```ts
// src/button.laws.ts
import { createElement } from 'react';
import { flushSync } from 'react-dom';
import { createRoot } from 'react-dom/client';
import { mountComponent, reactAdapter } from 'tslaws/browser';
import { Button, type ButtonProps } from './Button';

const react = reactAdapter({ createRoot, createElement, flushSync });

export async law labelRendersForAnyProps(props: ButtonProps) {
  const m = await mountComponent(react, Button, props);
  return m.query.byRole('button').textContent === props.label;
}
```

`mountComponent(adapter, component, props)` renders into a fresh `mount()` container, waits for `settle()`, and unmounts at the
end of the law. It returns `{ el, props, rerender(next), unmount(), query }`; `rerender` renders again with new props and
settles, and `query` is a set of queries bound to `el`.

**Adapters**, each exported from `tslaws/browser` and from `tslaws/adapters/<name>`:

- `reactAdapter({ createRoot, createElement, flushSync? })`: `component` is a React component; a rerender calls `root.render`
  again, unmount calls `root.unmount`, and `flushSync` (when given) commits each render synchronously.
- `angularAdapter({ createApplication, createComponent, provideZonelessChangeDetection?, setInput?, providers? })`: `component`
  is a standalone component class; props are set with `ref.setInput`, a rerender sets them again and runs `appRef.tick()` and
  `whenStable()`, unmount calls `appRef.destroy()`.
- `domAdapter`: `component` is `(props) => Node | string`; a rerender replaces the content.
- `elementAdapter(tagName, { attributes? })`: `component` is the custom element's class (defined under `tagName` if it is not yet)
  or `undefined`; props are assigned as properties, and as attributes with `attributes: true`.

The injected functions come straight from the framework (their shapes are the exported interfaces `ReactFunctions` and
`AngularFunctions`):

```ts
// React
import { createElement } from 'react';
import { flushSync } from 'react-dom';
import { createRoot } from 'react-dom/client';
const react = reactAdapter({ createRoot, createElement, flushSync });

// Angular (standalone component, zoneless so no zone.js)
import { createComponent, provideZonelessChangeDetection } from '@angular/core';
import { createApplication } from '@angular/platform-browser';
const angular = angularAdapter({ createApplication, createComponent, provideZonelessChangeDetection });
const m = await mountComponent(angular, CounterComponent, props); // props are set with ref.setInput
```

Without `provideZonelessChangeDetection` Angular needs zone.js; import it in the law's module. The adapters are thin: a framework
that is not listed needs only an object with `render(container, component, props)` that returns an unmount function, or
`{ update?, unmount? }` (it may return a promise).

**Function-typed props.** A parameter or property whose type has a call signature is generated: `props: ButtonProps` with
`onClick: () => void` just works. The function returns values generated from its return type (`void` gives `undefined`) and
gives the same result for the same arguments, like `fc.func`; in a browser law it is rebuilt in the page. Such a function cannot
be observed. To check that a callback was called, create it inside the law with `spy()`:

```ts
export async law clickCallsOnce(label: string) {
  const onClick = spy();
  const m = await mountComponent(react, Button, { label, onClick });
  click(m.query.byRole('button'));
  return onClick.count === 1;
}
```

`spy(impl?)` returns a function with `calls` (the argument lists) and `count`.

**`rendersSame(adapter, component, a, b)`** is the classic component law, rendering is a pure function of props: it renders with
`a`, rerenders with `b`, and compares the markup with a fresh render of `b`, ignoring whitespace, comment nodes and framework
bookkeeping attributes. A component that keeps stale state fails, with the two props as the counterexample.

```ts
export async law buttonRendersSame(a: ButtonProps, b: ButtonProps) {
  return await rendersSame(react, Button, a, b);
}
```

**Queries** look like Testing Library's, with no dependency: `byRole(role, { name?, pressed?, checked?, disabled? })`, `byText`,
`byLabel`, `byTestId` (`data-testid`) and `allBy...` variants, on `m.query` or as `within(el)`; `text(el)` collapses whitespace.
Roles are approximated from the tag (button, link, textbox, checkbox, heading, list, listitem, img, navigation, main, form, ...) or
an explicit `role`; names come from `aria-labelledby`, `aria-label`, a `label`, `alt`, `value` or the content. A query that finds
nothing, or several, throws an error that lists what exists, so a failing law says why.

Component laws differ from end-to-end laws in what they pin down: the component alone gets generated props and a fresh
container for every input, with nothing else of the app around it, so a failure points at that component and its props type.

### Accessibility laws

`a11y(root?, { rules?, ignore? })` audits an element (default: the page) with [axe-core](https://github.com/dequelabs/axe-core) and
returns `{ violations, ok }`, each violation being `{ id, impact, help, nodes }` with `nodes` the offending elements' HTML trimmed to
200 characters. `accessible(root?, options?)` returns just `ok`, so a law can `return await accessible(el)`. `rules` runs only those
axe rule ids and `ignore` skips some. When `root` is an element, page-level rules (`region`, `landmark-one-main`,
`page-has-heading-one`) are skipped.

```ts
export async law cardIsAccessible(n: int) {
  assume(n >= 0 && n <= 3);
  return await accessible(renderCard(mount(), n));
}
```

`axe-core` is an optional peer dependency, resolved from your project and bundled into the page only when a law reaches it:
`npm i -D axe-core`. Without it `a11y()` throws `a11y() needs axe-core: npm i -D axe-core`.

### Speed laws

Speed is measured in the browser, at both levels.

In a component law (`tslaws/browser`): `measure(work, runs = 7)` times `work` (sync or async, after a warm-up) and returns
`{ runs, min, median, p95, max }` in milliseconds; `fast(work, budgetMs, runs)` is true when the median is within the budget;
`blocking(work)` returns the milliseconds the main thread was blocked by long tasks (over 50 ms each) while `work` ran (Chromium).

```ts
export async law addingATaskIsFast(n: int) {
  const el = mountApp(sample(Math.abs(n) % 200));
  await settle(0);
  return await fast(() => addTask(el, 'Write the speed law'), 150, 3);
}
```

In an end-to-end law (`tslaws/e2e`): `vitals(page?)` reports what the browser measured for the loaded page (`fcp`, `lcp`, `cls`,
`blocking`, `domContentLoaded`, `load`, `domNodes`, `bytes`); `speed(budget, page?)` checks it against a budget and returns
`{ vitals, violations, ok }`, each violation naming the measure that is over; `fast(budget, page?)` returns just `ok`. A measure
the browser cannot report (LCP, CLS and long tasks are Chromium only) counts as over budget.

```ts
export async law shopPageIsFast(n: int) {
  await open('/');
  await settle();
  return await fast({ lcp: 2500, cls: 0.1, blocking: 200, bytes: 500_000 });
}
```

Timings depend on the machine, so set budgets with room: a speed law that fails only on a loaded CI runner is noise.

### Engines

Chromium is the default. `--browser firefox` or `--browser webkit` (or `TSLAWS_BROWSER_ENGINE`) runs the laws in that engine
instead. Install Playwright's build with `npx playwright install firefox` (or `webkit`), or point `TSLAWS_BROWSER` at an
executable of that engine; with neither, the run fails naming that command. Chromium still uses `TSLAWS_BROWSER` or an installed
Chrome, Edge or Chromium.

### Frameworks

Any DOM library works: the browser bundle resolves bare imports (`react`, `react/jsx-runtime`, a UI library) from your
project's `node_modules`, and `.tsx` sources can be covered. The compiler runs with fixed flags; `tslaws.json` can change a
few of them with `compilerOptions`:

```json
{
  "cover": ["src/**/*.ts", "src/**/*.tsx"],
  "compilerOptions": { "jsx": "react-jsx", "lib": ["es2022", "dom"] }
}
```

Supported keys: `jsx` (`react`, `react-jsx`, `react-jsxdev`, `preserve`), `jsxFactory`, `jsxFragmentFactory`,
`jsxImportSource`, `experimentalDecorators`, `emitDecoratorMetadata`, `useDefineForClassFields`, `strict`,
`noUncheckedIndexedAccess`, `exactOptionalPropertyTypes`, `allowJs`, `checkJs` (booleans), `lib` and `types` (arrays of strings). Values replace the
fixed defaults where they clash (`strict`). An unknown key is an error that lists these; nothing else reaches the compiler.
`jsx: "preserve"` type-checks but emits `.jsx`, which the runner cannot load, so use `react` or `react-jsx` for laws.

Plain JavaScript: set `allowJs` (and `checkJs` to type-check it). The compiler then emits the `.js` sources and a `.d.ts` for
each, so laws, still written in TypeScript, import `.js` modules with typed generators; JSDoc `@param`, `@returns` and
`@typedef` supply the types. `cover` globs match `.js` files only when `allowJs` is true (declarations, laws and
`node_modules` stay excluded), and the prover reads the emitted JavaScript, so JS sources can be proved like TypeScript ones.
Without `allowJs`, importing a `.js` file from a law is a compile error. See `examples/vanilla-js`.

Laws stay in browser laws files and import components from `.tsx` files; an exported function component that no law
reaches is `uncovered` like any other function.

React:

```json
{ "cover": ["src/**/*.tsx"], "compilerOptions": { "jsx": "react-jsx", "types": [] } }
```

```ts
import { mount, click, settle } from 'tslaws/browser';
import { createElement } from 'react';
import { createRoot } from 'react-dom/client';
import { Counter } from './Counter';
export async law countsClicks(n: int) {
  assume(n >= 0 && n <= 5);
  const el = mount((root) => { const r = createRoot(root); r.render(createElement(Counter)); return () => r.unmount(); });
  // ... click, await settle(), read el.textContent
}
```

The law file is `.ts`, so it calls `createElement` rather than writing JSX; `Counter.tsx` can use JSX. Angular:

```json
{ "cover": ["src/**/*.ts"], "compilerOptions": { "experimentalDecorators": true, "useDefineForClassFields": false } }
```

Bootstrap the component inside `mount(...)` as you do in your app; decorators and metadata are emitted by the compiler.

### Bundler plugins

The browser bundler is esbuild, which loads `.ts`, `.tsx`, `.js` and `.json`. A project that writes components in another source
format (`.tsrx`, `.svelte`, `.vue`) teaches the bundler that format with an esbuild plugin, listed in `tslaws.json`:

```json
{ "bundlerPlugins": ["./tools/tsrx-plugin.mjs"] }
```

Paths are relative to `tslaws.json`. Each module default-exports an esbuild `Plugin`, or a function (sync or async) that takes
`{ cwd }`, the project root, and returns one:

```js
import { readFileSync } from 'node:fs';
import { compile } from './my-compiler.mjs';

export default ({ cwd }) => ({
  name: 'my-format',
  setup(build) {
    build.onLoad({ filter: /\.tsrx$/ }, (args) => ({
      contents: compile(readFileSync(args.path, 'utf8'), args.path),
      loader: 'js',
      resolveDir: cwd,
    }));
  },
});
```

A plugin for `.tsrx` templates compiled by the public `@tsrx/ripple` compiler is in `packages/tslaws/test/fixtures/tsrx/tsrx-plugin.mjs`.

The plugins run before the built-in resolver and apply to every browser law (`check`, `ui`, `mcp`), including the
component laws that mount a component. End-to-end laws bundle nothing: they drive your running app. `mutate` copies only
compiled output, so a file the compiler does not emit (a template, a stylesheet) resolves to the file beside the source. Keep in mind that laws
are compiled to CommonJS, so a bare import reaches the bundler as `require()`: a package whose `exports` offer only the `import`
condition needs the plugin to resolve it (`build.resolve(path, { kind: 'import-statement', resolveDir })`).

A stylesheet a law imports (directly or through a template) is added to the page in a `<style>` element before the law's script runs, and an image or font it imports (`.png`, `.jpg`, `.svg`, `.woff2` and so on) is inlined as a data URL, so computed styles and images match the app.

A plugin that cannot be loaded, or whose factory throws, makes each browser law of the run report `error`, naming the setting and
the module. Without a plugin for the extension, a law that imports such a file reports an `error` that names the extension and
the `bundlerPlugins` setting. The compiler does not know the format either: it reports the import as TS2307 in `compileDiagnostics`, which does not stop the bundle from running, and the imported value is untyped in the law.

## End-to-end laws

There are three levels of law. By default the file name selects the level (`*.browser.laws.ts`, `*.e2e.laws.ts`, anything else is a Node law). With `"levels": "imports"` in `tslaws.json`, what the file imports selects it instead (see [Levels](#levels-names-by-default-imports-opt-in)); the Imports row below is what decides in that mode.

|             | Node laws                       | Component laws                          | End-to-end laws                                             |
| ----------- | ------------------------------- | --------------------------------------- | ----------------------------------------------------------- |
| Imports     | neither of the two APIs         | `tslaws/browser` or `tslaws/adapters/*` | `tslaws/e2e`                                                |
| Runs        | in Node                         | inside one page of a real browser       | in Node, driving a real browser from outside                |
| Sees        | functions and values            | one component and its DOM               | the whole running app: pages, forms, network, cookies, tabs |
| Speed       | fastest, thousands of inputs    | fast, tens of inputs                    | slowest; 10 inputs by default                               |
| Typical use | logic, parsers, reducers        | a widget with generated props           | a purchase flow, login, a form across pages                 |
| Status      | `proved`, `bounded` or `tested` | `tested`                                | `tested` (method `e2e`)                                     |

A file that reaches both APIs is an `error`: it is either component level or end-to-end, not both. The refusal names how
each API is reached. See [Laws files, levels and proposals](#laws-files-levels-and-proposals) for how "reaches" is decided
and for the old `.browser.laws.ts` and `.e2e.laws.ts` names.

An end-to-end law starts from a running app and a Playwright `Page`. Inputs are generated from the parameter types and a
failure is shrunk to a minimal counterexample, like every other law. Every generated input gets a fresh browser context
and page, closed after it, so cookies and storage never leak between inputs.

```ts
// e2e/cart.laws.ts
import type { int } from 'tslaws';
import { assume } from 'tslaws';
import { open, page } from 'tslaws/e2e';

export async law totalMatchesQuantity(qty: int) {
  assume(qty >= 1 && qty <= 20);
  await open('/');
  await page().fill('#qty', String(qty));
  await page().click('text=Add to cart');
  await page().waitForURL('**/cart?items=*');
  return (await page().textContent('#total')) === `Total: ${7 * qty}`;
}
```

`tslaws/e2e` exports `page()` (the current page), `context()`, `baseURL()`, `open(path)` (goes to the base URL plus the path
and waits for load), `newPage()` (a second tab in the same context), `route(pattern, handler)` (network mocking),
`settle()` (network idle plus two animation frames) and `accessible()` / `a11y()` (axe-core, looked up in your project's
`node_modules`: `npm i -D axe-core`). `Page`, `Locator`, `BrowserContext` and `Route` are re-exported as types from
Playwright. A law returns `false` or throws to fail, as always.

### Configuring the app

The runner starts your dev server, waits for it, runs the laws and stops it. In `tslaws.json`:

```json
{
  "e2e": {
    "baseURL": "http://localhost:4173",
    "server": {
      "command": "npm run preview",
      "url": "http://localhost:4173",
      "timeoutMs": 60000,
      "reuseExisting": true,
      "cwd": "."
    },
    "runs": 10,
    "timeoutMs": 120000
  }
}
```

- `server.command` runs through the shell, from `server.cwd` (default the project). `server.url` is polled until it answers
  with any status below 500, or the check fails with an `error` that shows the server's last output.
- `reuseExisting: true` uses a server that already answers at `server.url` and starts nothing. Without it, an answering URL is
  an error rather than a silent test of the wrong server. A server the runner started is stopped after the check, on errors
  and on Ctrl+C, with its whole process tree.
- `baseURL` defaults to `server.url`. Leave out `server` to test an app you run yourself.
- `runs` (default 10) and `timeoutMs` (default 120000 per law, reported as `error` past it) apply to end-to-end laws unless
  `--runs` or `--property-timeout` is given. Unknown keys are an error.

A Vite app (`vite build` first, then serve the build; or use `npm run dev` with `url` `http://localhost:5173`):

```json
{
  "e2e": {
    "server": {
      "command": "npm run build && npm run preview -- --port 4173 --strictPort",
      "url": "http://localhost:4173"
    }
  }
}
```

An Angular app:

```json
{ "e2e": { "server": { "command": "npx ng serve --port 4200", "url": "http://localhost:4200", "timeoutMs": 180000 } } }
```

**Security.** `server.command` executes a command from your project's `tslaws.json`, exactly as `npm run` executes a script
from `package.json`. Only run `tslaws check` on a project whose configuration you trust.

### Screenshots and the live view

When an end-to-end law fails, the shrunk counterexample is run once more with the page left open and photographed to
`.tslaws/screenshots/<law>.png`; the report and the dashboard show it. While a law runs, `tslaws ui` shows the app live,
refreshed about every 120 ms from the newest page, as for component laws. Counterexamples join the regression corpus and are
replayed first on the next check. `--browser firefox|webkit` picks the engine.

Not covered: file uploads, reusing a signed-in state across inputs, and running inputs in parallel (one browser, one input at a time).

## Stateful laws

Stores, components and caches are tested by driving them with a sequence of operations and comparing them with a simple
model. A law can already take an array of a union type, so the operations are an ordinary input: the runner derives the
generator from the type and fast-check shrinks a failing array to the shortest one.

```ts
import { runModel } from 'tslaws';
import { Counter } from './counter';

export law counterAgreesWithModel(ops: ('inc' | 'dec' | 'reset')[]) {
  return runModel({
    ops,
    real: new Counter(), // the thing under test, already created
    model: 0, // the reference model's initial state
    apply: (counter, model, op) => {
      // do the op on the real thing, return the next model state
      if (op === 'inc') { counter.inc(); return model + 1; }
      if (op === 'dec') { counter.dec(); return model - 1; }
      counter.reset();
      return 0;
    },
    agree: (counter, model) => counter.n === model, // checked before the first op and after every op
  });
}
```

`runModel` returns false at the first disagreement. `modelFailure()` (from `tslaws`) then gives `{ step, op }` for the latest
call (`step` is -1 when real and model disagreed before any op), which is useful in a helper or a debugger; the report
format is unchanged. `runModelAsync` is the same with `apply` and `agree` allowed to return promises. Both are plain code
with no Node-only imports, so they work in browser bundles.

Because the operations are the law's input, a bug that needs a particular history is found by random search and then
shrunk. If `reset` fails to reset when the count is exactly 3, the counterexample is `[["inc","inc","inc","reset"]]`, not
the long sequence that first failed. Keep the operation union small so shrinking can reach a minimal sequence. Stateful
laws are `tested`: the prover does not model `apply` callbacks.

What shrinking guarantees for an array input such as the operations, for the same seed always giving the same result: a
failing array of up to 12 elements shrinks to a shortest failing subsequence of it, because every subset of its elements
is tried, fewest remaining first. A longer array shrinks until removing any one run of consecutive elements, or any two
separate runs, no longer fails, which is checked in full up to 33 elements; beyond that the search is cut at 50,000 smaller
arrays for each step, so the result may be longer than a two-run minimum. The generators produce up to 8 elements for an array type, so
there the result is always a shortest failing subsequence.

In a browser law the operations are clicks and `apply` waits for the page to settle:

```ts
// src/counter.laws.ts
import { runModelAsync } from 'tslaws';
import { click, mount, settle } from 'tslaws/browser';
import { createCounter } from './counter';

export async law counterUiAgreesWithModel(ops: ('inc' | 'dec')[]) {
  const ui = createCounter(mount());
  return runModelAsync({
    ops,
    real: ui,
    model: 0,
    apply: async (ui, model, op) => {
      click(op === 'inc' ? ui.incButton : ui.decButton);
      await settle();
      return op === 'inc' ? model + 1 : model - 1;
    },
    agree: (ui, model) => ui.label.textContent === String(model),
  });
}
```

## The dashboard

`tslaws ui` opens a local dashboard: a sidebar tree of files and laws with status icons, filters
(All, Failed, Open, Passed), search, and a detail pane with the report (message, counterexample, a copyable reproduce command,
the next step), the law's source with its lines highlighted, and the compiler output. It reruns on save and has a Run all button
(`r`; `/` focuses search; `Esc` clears the selection); hovering a file shows a button that reruns just that file. When a browser law fails, the page is photographed at the shrunk counterexample (`.tslaws/screenshots/`) and the image appears in the report. `--port N` picks the port (default 51205, another if busy);
`--no-open` keeps it from opening a browser.

Laws appear as the run proceeds: waiting, running (pulsing), then their result, with a progress bar and a Running filter. For browser laws the dashboard shows the page itself, live: while a law runs, the first runs linger for a moment (`browserPauseMs`) and the page is photographed a few times a second, so you see the component the law is driving; afterwards the last frame stays on the law's report.

Each law is timed from its start to its result: the duration shows in the law's header and as a tag in the tree, and the overview lists the five slowest laws. The overview also keeps the last 20 runs of the whole project as a row of small squares (green for a run where every law held, red otherwise, newest on the right; hover one for its time, duration and counts). The dashboard remembers each law's last five statuses across those full runs and marks a law `flaky` when they include both a passing (proved, bounded, tested) and a failing (failed, error, open) one; a `Flaky` filter chip counts them. History and flakiness live in the dashboard's memory only. A law's row has a hover button, and its header a Run button, that rerun just that law (`POST /api/run?file=<file>&law=<name>`, with the same protections as other reruns); only that law's entry is replaced, and the rerun adds nothing to the history.

It listens on 127.0.0.1 only, rejects requests whose Host or Origin is not loopback and the page itself, and cannot accept
laws: `tslaws accept` stays a person's act at a terminal.

## Editor integration

**The `law` keyword.** The extension ships a TypeScript server plugin, so VS Code's own TypeScript understands `law` declarations: no
squiggles on `law`, the name or the parameters, with hover, go to definition, rename, references and completions on your text, and
the compiler's TS9101 to TS9106 in the Problems view after a run. How it works and its limits are in
[editor-law-syntax.md](editor-law-syntax.md).

`packages/vscode-tslaws` is a VS Code extension with no bundled dependencies. When a law fails it says so, as you work, on the
law and on the code the law exercises.

- **Laws files come from tslaws.** The extension asks `tslaws list --json` which files are laws files (so a file named by the `laws` setting counts, and the level of each comes from its name, or from its imports with `"levels": "imports"`) instead of matching names; with an older `tslaws`, or an untrusted workspace, it falls back to `*.laws.ts`. It asks again when `tslaws.json` or a proposal changes and when you save a file that declares a law or imports the browser or end-to-end API.
- **Explorer badges.** Each laws file shows its level in the Explorer: `N` Node, `B` browser, `E` end to end, and `P` for a proposal (an in-tree `*.proposed.laws.ts`, or one in `.tslaws/proposals/`). The tooltip says it in words and notes a file that is not in `tsc-laws.lock` yet. In names mode it repeats the cue the `.browser.laws.ts` suffix gives; in imports mode it is the only cue.
- **Run on change.** A debounced run of only the laws that cover the changed file: a laws file runs itself; a source file runs the
  laws that reached it in the last report (`exercises`); else the laws file beside it, or the nearest folder's; else every law.
  `tslaws.run` is `onSave` (default), `onType` or `manual`. A newer change kills the run that is going. The status bar counts
  results as they stream (`laws: running 2/5 - 1 proved, 1 failed`). On save is the default because a check compiles and starts the
  prover, which takes seconds; `onType` runs on a copy of the project in `.tslaws/shadow` that holds the unsaved text, so no
  file of yours is written.
- **Both ends.** A failed law is a diagnostic on the law's name and another on the name of the function it exercises, from the
  report's `exercises`. Each message has the shrunk counterexample under the law's parameter names, the method, runs and seed,
  and the command that reproduces it. Each end is `relatedInformation` of the other, and both have the code `tslaws/<law name>`.
  If the stack named the function it is marked as an error; if the law calls several functions and none is named, each is
  a warning. Ranges are re-resolved against the buffer, so they follow edits between runs. Both clear when the law passes.
  `open`, `tampered` and `error` laws are marked on the law; `uncovered` functions on their names.
- **CodeLens, hover, quick fixes.** Above a law: its state, counts and the time of the last run; click to rerun. Above a function a
  law reaches: `covered by 2 laws, 1 failing`. The hover shows the shrunk input and the reproduce command. Quick fixes: re-run
  this law, open the failing law, go to the code it exercises, copy the reproduce command. The counterexample also ends the failing
  line in the theme's error colour, with a gutter mark.
- **Test Explorer.** Laws are tests in the Testing view, with `Run`, `Rerun failed` and `Run without the prover` profiles (no
  debug profile). A failure is reported at the law and at the function.
- **Commands.** `tslaws.check`, `tslaws.runFile`, `tslaws.cancel`, `tslaws.openDashboard` (runs `tslaws ui --no-open --port 0`), and
  `tslaws.accept`, which only types `npx tslaws accept` into a terminal; a person presses Enter. The extension never accepts laws.

- **Live results.** `tslaws.liveBackground` (default `auto`: on when the project has a `tslaws.json`) runs the covering laws in the
  background as you type, with a status after each function (`proved`, `tested 24 runs`, `failing: counterexample (price=0, coupon=1)`,
  `stale`), a Laws view in the Explorer, a status bar count, a CPU and run-time guard and _pause/resume live results_. The last report
  is cached in `.tslaws/last-report.json`. An exported function no law reaches shows `uncovered` as a hint with _Write a law for this
  function_, which only ever writes a `*.proposed.laws.ts` file.
- **Navigation.** _Go to Laws_, _Peek Laws_ (suggested Alt+L and Alt+Shift+L), Go to Implementation and Find All References on a function
  (they list its laws, from the report or from imports), F12 on a law name, laws in the Outline and in Ctrl+T as `law:<name>`, and
  _Go to law..._.

Settings: `tslaws.liveBackground`, `tslaws.liveCpuLimit`, `tslaws.liveMaxSeconds`, `tslaws.run`, `tslaws.debounceMs`, `tslaws.runOnOpen`, `tslaws.inlineCounterexample`, `tslaws.executable` and
`tslaws.args`. `tslaws.runOnSave` is deprecated and counts only while `tslaws.run` is not set (`false` means `manual`). The extension
runs `node_modules/tslaws/bin/tslaws.js` (or `tslaws.executable`) with `check --reporter ndjson`, and `--json` for an older
`tslaws`. See `packages/vscode-tslaws/README.md`.

## Statuses

| Status      | Meaning                                                                                                           | Passes? |
| ----------- | ----------------------------------------------------------------------------------------------------------------- | ------- |
| `proved`    | No input breaks the law; no bound involved.                                                                       | yes     |
| `bounded`   | No input breaks it within the stated bounds (array length, loop iterations, recursion depth, `int` within ±2^26). | yes     |
| `tested`    | `fast-check` found nothing in `--runs` inputs; the code does not lower to the prover.                             | yes     |
| `open`      | `law proved` that was not proved for every input, or `assume` discards nearly everything.                         | no      |
| `failed`    | A counterexample, minimal, with the seed to reproduce.                                                            | no      |
| `uncovered` | Exported code no law reaches.                                                                                     | no      |
| `tampered`  | A law changed, was added or removed since the lock was accepted, or a coverage exemption is not in the lock.      | no      |
| `error`     | The law cannot run: not exported, untyped parameter, no generator, load failure.                                  | no      |

## Inputs

The compiler emits declarations and `tslaws` reads each parameter's type from them, so the whole type system drives input
generation: primitives and literals, unions, enums, template literals, arrays, tuples, interfaces and type literals,
optional properties, index signatures, `Date`, and type parameters through their constraints. Parameters typed `number`
are finite doubles. Failures shrink, and the report prints the seed: `tslaws check --seed N` reproduces it.

## The prover

`tslaws` symbolically executes the compiled JavaScript of the law, inlining the project functions it calls, and asks Z3
for an input that returns `false` or breaks an obligation. A model is replayed in JavaScript; only a reproduced failure is
reported as `failed`.

- **Numbers are IEEE doubles**, so rounding, overflow and `-0` are real and `(a + b) + c === a + (b + c)` is refuted. Z3
  cannot decide most double arithmetic, so those laws stay `tested`; commutative `+` and `*` are normalised, so
  `a + b === b + a` proves.
- **`int` is exact.** Integer arithmetic carries the obligation that results stay within ±(2^53 − 1). When the full range
  fails only on that obligation the proof is retried with `int` in ±2^26 and reported `bounded`. `bigint` is exact with no
  bound.
- **Arrays, loops and recursion** unroll up to `--bound` (default 4) and give `bounded`. Supported: `length`, indexing,
  literals and spread, `push`, `map`, `filter`, `every`, `some`, `reduce`, `includes`, `indexOf`, `slice(n)`, `concat`,
  `reverse`, `sort(comparator)`, `[...new Set(xs)]`, `for`, `while`, `for…of`, `break`, `continue`. Mutation is allowed
  only on arrays no second name can reach.
- **Strings** are SMT strings restricted to the BMP: `+`, templates, `length`, `charAt`, indexing, `slice`, `substring`,
  `includes`, `startsWith`, `endsWith`, `indexOf`, comparisons.
- **Records**, `typeof`, `Math.abs/sign/min/max/floor/ceil/trunc`, ternaries, `const`/`let`, `assume`. `Math.min` and
  `Math.max` take any number of arguments.
- **Integer division is exact.** For `int` operands, `Math.floor/ceil/trunc/round(a / b)`, `(a / b) | 0` (which also needs
  the result in 32 bits) and `a % b` lower to exact integer arithmetic with JavaScript's meaning: floor, ceiling,
  truncation toward zero, round half up, and a remainder with the sign of the dividend. The divisor must be a non-zero
  literal or provably non-zero (`assume(b !== 0)`); otherwise the proof is not given and the reason says so. For the
  rounded quotients `a` and `b` must stay within ±2^52, so the double JavaScript divides first cannot round across an
  integer. A plain `a / b` that is not wrapped in one of these stays on the double path.
- **Module constants.** `const NAME = <literal or arithmetic over other constants>` at file scope, `exports.NAME` in the
  same file and `module_1.NAME` through an import read as values (an integer literal stays an `int`). Only `const`
  declarations and exports assigned once count, and the initializer may not call anything.
- **Number predicates:** `Number.isFinite`, `Number.isInteger` and `Number.isNaN` over `int` and doubles (`bigint` gives
  `false`, as in JavaScript).
- **Loop invariants** give a proof for every iteration count. Put `invariant(cond)` first in a loop body. The prover proves
  it on entry, assumes it at the top of an arbitrary iteration, proves it again at the end, and gives the code after the
  loop an arbitrary state where the invariant holds and the condition is false:

  ```ts
  export function sumTo(n: int): int {
    let s = 0,
      i = 0;
    while (i < n) {
      invariant(0 <= i && i <= n);
      invariant(2 * s === i * (i - 1));
      s += i;
      i += 1;
    }
    return s as int;
  }
  // law proved: assume(n >= 0 && n < 1_000_000); return 2 * sumTo(n) === n * (n - 1);
  ```

  Invariants live in the implementation, so the agent writes them; the laws stay yours. The loop may change numbers,
  booleans, strings, arrays and records, and may `return`, `break` or `continue`. A changed array keeps the room it had,
  so such a proof is `bounded` by that length. This is partial correctness.

- **Quantifiers:** `forall(xs, (x, i) => cond)` and `exists(xs, (x, i) => cond)` (from `tslaws`) say that every, or some,
  element satisfies a condition. They run as loops in property tests. The prover lowers them over the array's slots:
  `forall` is the conjunction of `k < length => cond(xs[k], k)` and `exists` the disjunction of `k < length && cond(xs[k], k)`.
  Use them in `assume(...)`, in a law's result and in `invariant(...)`; the predicate may use outer variables and the index.
  Like any array claim, a proof that uses them is `bounded` by `--bound`, never `proved`. The predicate must be an arrow
  function the prover can lower, or the law stays `tested`:

  ```ts
  export law allPositiveSumPositive(xs: int[]) { assume(forall(xs, (x) => x > 0)); return sum(xs) >= 0; }
  ```

Anything else leaves the law `tested`, or a `law proved` `open`, with the reason. Z3 runs in a worker that is terminated if
a query outlives its timeout (`--proof-timeout`, default 5000 ms). `TSLAWS_DEBUG=1` keeps each query as an `.smt2` file
under `.tslaws/out/smt`.

## Keeping agents honest

1. **Laws are the person's.** `tsc-laws.lock` holds a hash of every law declaration and every coverage exemption. Any
   difference fails the check as `tampered`. `tslaws accept` refuses to run without a terminal, under `CI`, or with
   `TSLAWS_AGENT` set, unless a person has lent it to agents for a limited time with `tslaws delegate grant`
   ([below](#lending-accept-to-an-agent)). Under `CI` it never runs.
2. **No code escapes.** Every exported function or class in the covered modules must be reached by a law, directly or
   through the functions a law calls. Covered modules are the `cover` globs of `tslaws.json`
   (`{ "cover": ["src/**/*.ts", "!src/**/*.test.ts"] }`), or, without that file, every module the laws import. A function
   marked `@tslaws-exempt` in its doc comment is exempt only once the exemption is in the lock.
3. **Agents propose, people promote.** Agents write candidate laws into in-tree `*.proposed.laws.ts` files, the normal way,
   and try them with `tslaws check --proposed` (no lock, no coverage gate). Optionally, `tslaws propose` (or the MCP tool)
   writes them into `.tslaws/proposals/` instead (outside the tree, git-ignored). A person moves a proposal into the tree
   with `tslaws promote` and accepts. A proposal is never counted by the lock or the coverage gate: it protects nothing,
   and a person accepts. Every `*.laws.ts` file in the tree must be in the lock, so no edit to the tree can turn an
   accepted law into a proposal (see [why proposals can live outside the tree](#why-proposals-live-outside-the-tree)).
4. **The gate runs by itself.** `tslaws init` installs a Claude Code hook (`hooks/claude-hook.mjs`) that blocks
   `git commit` and sends the agent back to work when the check fails, plus rules for `AGENTS.md`
   (`hooks/AGENTS.snippet.md`).

## Commands

```
tslaws init [--force]
tslaws accept [files...]
tslaws delegate grant [--for 1h|8h|1d|7d] [--root DIR]
tslaws delegate revoke [--root DIR]
tslaws delegate status
tslaws list [--json]
tslaws propose <file.ts> [--from PATH]
tslaws promote <proposal> [--to PATH]
tslaws regressions [list|clear]
tslaws mutate [files...] [--max N] [--seed N] [--runs N] [--bound N] [--proof-timeout MS] [--property-timeout MS] [--json]
tslaws check [files...] [--json] [--summary] [--watch] [--runs N] [--seed N] [--no-prove] [--no-regressions] [--bound N]
             [--proof-timeout MS] [--proposed] [--compiler PATH] [--reporter text|json|junit|github|ndjson] [--law NAME[,NAME]]
```

Exit status is 0 only when every law is `proved`, `bounded` or `tested`, nothing is `uncovered`, the files compile and the
lock matches. `--json` adds a `hint` to each result: the concrete next action for an agent. `--summary` prints only the
results that do not pass, and the totals.

The compiler is `--compiler`, `TSC_LAWS_BIN`, or `tsc-laws` on `PATH`. It finds its lib files through `TSC_TS_LIB_DIR`, or
the TypeScript 7 libs scriptc installs in `node_modules/@scriptc/*`. `tsc-ts --laws-manifest <files>` lists the laws of
files as JSON.

## Agent integration (MCP)

`tslaws mcp` serves the Model Context Protocol over stdio (JSON-RPC 2.0, one message per line, no dependency), so an
agent calls the checker as tools instead of parsing terminal output. Add it to Claude Code with a `.mcp.json` at the
project root:

```json
{ "mcpServers": { "tslaws": { "command": "npx", "args": ["tslaws", "mcp"] } } }
```

The compiler is found as for the CLI: `--compiler PATH`, then `TSC_LAWS_BIN`, then the bundled one. The server uses stdout
only for protocol messages.

| Tool                    | Does                                                                                                            |
| ----------------------- | --------------------------------------------------------------------------------------------------------------- |
| `tslaws_check`          | `check --json` with hints; `files` limits it, `summary` keeps only the laws that do not pass and the totals     |
| `tslaws_check_proposed` | `check --proposed`: every proposal in `.tslaws/proposals/`                                                      |
| `tslaws_list`           | `list --json`: each laws file and proposal, its level and whether it is accepted, unaccepted or proposed        |
| `tslaws_explain`        | a law's source, its last result in this session with the hint, and the next action                              |
| `tslaws_propose`        | writes a law into a proposal in `.tslaws/proposals/` (a same-named law there is replaced) and returns its check |

**Property: the server cannot weaken accepted laws.** No tool accepts laws, writes `tsc-laws.lock`, promotes a proposal
or edits any file of the tree. The only files `tslaws_propose` writes are plain `.ts` files directly inside
`.tslaws/proposals/`. It refuses any other path, an absolute path, a name with `..`, a nested path, an in-tree
`*.proposed.laws.ts` name, a `.tslaws` or `proposals` directory that is a link (or junction) leading out of the project, and
a proposal file that is itself a link. It accepts only imports and `law` declarations as source. The server sets
`TSLAWS_AGENT=1`, so nothing it spawns can run `accept` or `promote`. A proposal is still code that `check --proposed`
runs, as with any law file.

## Laws files, levels and proposals

### Which files are laws files

Every file named `*.laws.ts` is a laws file. A project that wants other names lists globs in `tslaws.json`:

```json
{ "laws": ["specs/**/*.ts", "!specs/helpers/**"] }
```

A file the globs match that declares a top-level `export law` is then a laws file too (a leading `!` excludes). Files that
match but declare no law are ordinary sources. The default is `*.laws.ts` only, so nothing existing changes. `"laws"` is
validated like the other settings: an array of non-empty, project-relative globs. A laws file found this way is excluded from
the covered sources, as a `*.laws.ts` file is. `tslaws list` shows what was found.

Every laws file of the tree is locked. A laws file that is not in `tsc-laws.lock` fails `check` as `tampered`; so does a
changed or a removed one, until a person runs `tslaws accept`. There is no mode that only reports unaccepted files.

### Levels: names by default, imports opt-in

`tslaws.json` has an optional `"levels"` setting, `"names"` (the default) or `"imports"`. Any other value is an error.

```json
{ "levels": "imports" }
```

With `"names"` (the default) the level comes from the file name:

| File name                                  | Level                                        |
| ------------------------------------------ | -------------------------------------------- |
| `*.laws.ts`                                | Node laws                                    |
| `*.browser.laws.ts`                        | browser (component) laws, run in the browser |
| `*.browser.laws.ts` importing `tslaws/e2e` | end-to-end laws, run in Node against an app  |
| `*.e2e.laws.ts`                            | end-to-end laws                              |
| imports both `tslaws/browser` and e2e      | `error`: one file, one level                 |

The proposed names (`*.proposed.laws.ts`, `*.browser.proposed.laws.ts`, `*.e2e.proposed.laws.ts`) have the level of the file they propose. Nothing else about a project changes with this setting left out, and its lock keeps the format it has always had.

With `"imports"` the level comes from the import graph; names are still recognised as hints:

| The file reaches                                                  | Level                                        |
| ----------------------------------------------------------------- | -------------------------------------------- |
| `tslaws/browser` or `tslaws/adapters/{dom,react,angular,element}` | browser (component) laws, run in the browser |
| `tslaws/e2e`                                                      | end-to-end laws, run in Node against an app  |
| both                                                              | `error`: one file, one level                 |
| neither                                                           | Node laws                                    |

"Reaches" follows the project's own import graph, the same way for check, `list` and the editor: static imports,
re-exports (`export * from`), `require` and dynamic `import()`, through every project module (relative imports, and
anything the bundler resolution finds). A law that calls a helper whose module imports `tslaws/browser` is a browser law. An
import used only as a type (`import type`, `export type`, a clause whose names are all `type`) loads nothing and does not
count, and modules inside `node_modules` are not followed. The error for both levels names the chain of files for each.

In imports mode the names `*.browser.laws.ts` and `*.e2e.laws.ts` are hints that must agree with the imports. Agreement
says nothing. A disagreement is reported once per file, as a `notice` in the text, JSON and MCP reports (it does not fail the
check):

- the name says browser (or end-to-end) and nothing the file imports is that API: the name is used as the level, because a
  law may use the page's globals directly, and the notice asks you to import `tslaws/browser` (or `tslaws/e2e`);
- `*.browser.laws.ts` that reaches `tslaws/e2e` runs end to end;
- `*.e2e.laws.ts` that reaches only the browser API is an `error`: rename it or fix its imports.

**The lock and levels.** In imports mode `tsc-laws.lock` also records the resolved level of each laws file (a `levels`
section). A change in the resolved level, for example a helper module that starts importing `tslaws/browser`, reports the
laws of that file as `tampered` until a person runs `tslaws accept` again. So does switching a project to imports mode, until
it is accepted once. In names mode the lock has no `levels` section and verifies exactly as before.

### Proposals

The normal proposal is an in-tree `*.proposed.laws.ts` file next to the code (see
[In-tree proposed names](#in-tree-proposed-names)). The `.tslaws/proposals/` directory is an optional alternative. A
proposal there is a laws file at the project root next to `tslaws.json`. The directory is owned by the tool and
git-ignored (`tslaws propose` adds it to `.gitignore` the first time it writes there; `tslaws init` does not); the editor,
the MCP server and the coverage gate ignore it. Any plain file name ending `.ts` works. Its level follows the
[levels setting](#levels-names-by-default-imports-opt-in): in imports mode from its imports; in names mode from its name
(give a browser proposal a `.browser.laws.ts` name), so a plain `cart.ts` runs in Node.

```
tslaws propose cart.ts < idea.txt          # or --from PATH; anyone, agents included
tslaws check --proposed                    # runs every proposal: no lock, no coverage gate
tslaws promote cart.ts [--to src/cart.laws.ts]   # a person, at a terminal
tslaws accept                              # records the promoted laws in tsc-laws.lock
```

`propose` writes only inside `.tslaws/proposals/` (a name or `.tslaws/proposals/name.ts`) and refuses every other path and
any link out of the project. It merges into an existing proposal (a same-named law is replaced) and never touches the lock or
any file of the tree. `check --proposed` prints every law of every proposal with its status.

Imports in a proposal that start with `./` are written relative to the project root: `import { total } from './src/cart'`.
`propose` stores them relative to the proposal file (`../../src/cart`), so the stored file is ordinary TypeScript that
resolves, type-checks and runs where it is; `check --proposed` does the same for a file someone placed there by hand.
`../` and package imports are left alone. `promote` rewrites the stored imports again for the directory the law moves to.

`tslaws promote <proposal> [--to PATH]` is the person's step. It refuses without a terminal, under `CI`, as an agent, and
with `TSLAWS_AGENT` set; a delegation of `accept` does not cover it. It shows each law with its `check --proposed` result,
then asks where to put them: the suggested path is `<directory of the source the proposal imports>/<name>.laws.ts`
(otherwise `laws/<name>.laws.ts`), or `--to`; Enter takes it, another path replaces it, `n` cancels. The path must be
inside the project, not in `node_modules`, `.tslaws` or `.git`, not a link, and a name a laws file has (`*.laws.ts`, or
one a `laws` glob matches). If the file exists the laws are merged into it (imports added once; a law name already there is
refused). The proposal is removed. `promote` never writes the lock: until a person runs `tslaws accept`, `check` fails the
new laws as not in the lock.

### Why proposals can live outside the tree

The lock hashes every laws file in the tree, so the tree has no way to hold a law that is "proposed": whatever is there is
either accepted or fails `check`. The old design marked a proposal by its name (`*.proposed.laws.ts`), so the file that
separated what is locked from what is not was a name an agent could choose. The threats:

- An agent renames or copies an accepted law into a name that the check treats as unlocked, then edits it. Now a laws file in
  the tree is locked whatever it is called; renaming it removes the old file (`tampered`) and adds a new one (`tampered`).
- An agent writes laws that go unchecked by the lock and passes them off as accepted. Proposals are outside the tree and
  never count for the lock or coverage, so a proposal can neither satisfy the coverage gate nor change what `check`
  accepts.
- An agent uses the proposal channel to write elsewhere. `propose` and the MCP tool write one directory only, refusing
  other paths, `..`, nested paths and links that leave the project; they never write the lock.
- An agent promotes its own proposal. `promote` needs a person at a terminal and is not covered by a delegation; `accept`
  still needs a person (or a live delegation the person gave).

A proposal is code that `check --proposed` runs, as any law file is. It is not sandboxed from your project, so review it
before you run it.

### In-tree proposed names

`*.proposed.laws.ts`, `*.browser.proposed.laws.ts` and `*.e2e.proposed.laws.ts` in the tree are the normal way to propose a
law. They work through `check --proposed` and `promote` (asked per law, into the accepted file with the proposal's name
minus `.proposed`). Being in the tree they are not locked as laws files. `tslaws propose` and `tslaws_propose` do not write
them; they write `.tslaws/proposals/`.

## Lending accept to an agent

A person can lend `accept` to agents for a limited time, without removing the guard for anyone else.

```
tslaws delegate grant [--for 1h|8h|1d|7d] [--root DIR]   # default 8h, never more than 7d
tslaws delegate revoke [--root DIR]
tslaws delegate status
```

`grant` and `revoke` need a terminal and refuse under `CI` or with `TSLAWS_AGENT` set, exactly as `accept` does. `status`
only reads, so it works anywhere. The grant is written to `<home>/.tslaws/delegation.json`, in the person's home directory
and never in the project, so nothing an agent can edit in the repository can create one:

```json
{ "grants": [{ "root": "/abs/real/path/of/project", "expires": "2030-01-01T08:00:00.000Z", "note": "optional" }] }
```

With a live grant for the project's real path, `accept` runs without a terminal or with `TSLAWS_AGENT` set. It skips the
`ACCEPT` prompt, appends a line to `<project>/.tslaws/accept.log` (time, `delegated`, the grant expiry, the lock hash
before and after) and prints a `DELEGATED ACCEPT` line. An expired, missing, malformed or other-project grant refuses and
points to `tslaws delegate grant`. Under `CI`, `accept` refuses even with a grant. `promote`, the MCP server and the editor
extension never use a grant.

Hardening: the file is rejected on POSIX when group or others can write it, or another user owns it; a grant that names a
symlink never matches, and `grant` refuses to record one; roots are compared by real path; the grant is never read from the
project or from any environment variable or flag. The home directory comes from the operating system's user record
(`getpwuid` on POSIX, the profile directory of the user token on Windows), never from `HOME` or `USERPROFILE`; if the record
gives none, `accept` refuses. The `.tslaws` directory in it must resolve to a real path inside that home, and a home that is
the project root or inside it is refused.

A grant is a person's decision, bounded in time, outside the repo, audited in `accept.log`. It is not a defence against code running as the same operating-system user as the person, which can write the
file itself; it stops an agent from creating the grant through `tslaws` or the repository.

Promoting a proposal is described under [Proposals](#proposals). Neither the MCP server, the editor extension nor a
delegation can promote.

## Regression corpus

Every counterexample that a property test finds (node laws and browser laws) is saved to
`.tslaws/regressions/<law file, with / written as __>/<law>.json`. Values are stored in a lossless tagged JSON, so `NaN`,
`-0`, `Infinity`, `undefined`, `bigint` and `Date` come back exactly. A law keeps at most 20 distinct examples, newest first.
Only a real counterexample is saved: not a law whose `assume` discards nearly every input, not a timeout, not a prover model.

On the next run, every stored example of a law is replayed before the random search. If one still fails, the law fails with
`regression: a previously found counterexample still fails` and the counterexample, whatever the seed or `--runs`. An example
that now passes stays in the corpus and keeps guarding the law. A fixed bug therefore cannot return unnoticed, even though the
random search would rarely find it again.

`tslaws init` ignores `.tslaws/out`, `.tslaws/mutants` and `.tslaws/screenshots` but not `.tslaws/regressions`, so a team may
commit the corpus. (`.tslaws/proposals` is added by `tslaws propose` on first use.) `tslaws check --no-regressions` neither reads nor writes it. `tslaws regressions list` prints each law and
its example count per file; `tslaws regressions clear` deletes the directory.

## Mutation testing

`tslaws mutate [files...] [--max N] [--seed N] [--runs N] [--proof-timeout MS] [--property-timeout MS] [--json]` asks whether the laws are strong enough. It changes the covered
source in small ways (relational, arithmetic and logical operators, `true`/`false`, numeric literals, negated `if`
conditions, removed `!`), re-runs the laws against each mutant in a scratch copy under `.tslaws/mutants/`, and reports each
mutant as killed (a law failed, errored or timed out) or survived (every law still held, so the laws cannot tell the change
apart). Your files are never written. A `*.laws.ts` argument chooses the laws; other files limit which sources are mutated.
Without arguments it uses every laws file and every covered module. `--max` (default 50) and `--seed` sample a subset.

It prints each survivor as `file:line  original  ->  mutated` with a hint, and the mutation score. Exit status is 0 only when
every tried mutant is killed. It first checks the unmutated code and stops if the laws do not pass. Mutants that do not
compile are skipped and not counted. Some survivors are equivalent mutants (for example `<` to `<=` where both sides are
equal); strengthen a law only when the survivor is a real behaviour change.

`.tsx` and `.jsx` sources are copied and mutated too, through the same operators (`&&`, ternaries and comparisons inside JSX
expressions); JSX text and tag names are never mutated. `tsc-laws.lock`, `tslaws.json` and `tsconfig.json` go into the
scratch copy so the project is complete, but the lock is not enforced on mutants. When `*.laws.ts` files are named, only the
sources those laws reach are mutated. Mutate takes the run settings of `check`: `--runs`, `--bound`, `--proof-timeout`,
`--property-timeout` and `--browser`, then the [Settings](#settings) of `tslaws.json`, then its own defaults (30 runs; the
`check` timeouts of 5000 ms for proofs and 30000 ms per property test). If the unmutated laws fail, the message names the
first failing law; raise the timeouts when it timed out.

## Settings

`tslaws.json` takes optional run settings besides `cover`, `compilerOptions`, `bundlerPlugins` and `e2e`:

| Key                 | Meaning                                    | Default (`check`) |
| ------------------- | ------------------------------------------ | ----------------- |
| `runs`              | Property-test runs per law                 | 200 (mutate: 30)  |
| `bound`             | Longest array, loop count, recursion depth | 4                 |
| `proofTimeoutMs`    | Time limit of one proof                    | 5000              |
| `propertyTimeoutMs` | Time limit of one law's property test      | 30000             |

Each is an integer of at least 1; another type, a smaller value or an unknown top-level key is an error naming the key.
Precedence is the command line flag (`--runs`, `--bound`, `--proof-timeout`, `--property-timeout`), then `tslaws.json`, then
the built-in default. It applies to `check`, `ui`, `mutate` and `mcp`. End-to-end laws keep the `runs` and `timeoutMs` of the
`e2e` section unless a flag is given.

## CI reporters

`tslaws check --reporter <name>` chooses the output. The exit status does not change: 0 only when the check passes.

- `text` (default) is the console report; `json` is the same as `--json`.
- `junit` writes JUnit XML to stdout: one `<testsuite>` per law file and one `<testcase classname=file name=law>` per law. `failed`,
  `open`, `tampered`, `error` and `uncovered` results carry a `<failure>` with the message, counterexample and hint.
- `github` writes GitHub Actions workflow commands: `::error file=...,line=...,title=<law> <status>::...` for each failing
  result and a `::notice` for `bounded` and `tested` ones. When `GITHUB_STEP_SUMMARY` is set, it also appends a markdown table
  of the results to that file.

```yaml
- run: npx tslaws check --reporter github
```

- `ndjson` is for editors. It writes one JSON object per line as the check proceeds: `{"type":"plan","laws":[...]}`, then
  for each law `{"type":"start",...}` and `{"type":"result","result":{...}}`, then `{"type":"report",...}`, the same as `--json`.

For a test report, redirect JUnit output: `npx tslaws check --reporter junit > tslaws-junit.xml`.

`--law NAME[,NAME]` runs only the laws with those names in the files chosen (the others are skipped, not reported).

### Where a failure lives

Every result of a law that ran carries `exercises` in the JSON and `ndjson` reports: the project functions the law reaches, in the
order it names them and then the ones those use (the same reach the coverage rule uses; it follows imports and re-exports
through the sources, not the type checker). Each entry has the function's `name`, its `declaration` (the name where it is
declared) and, for a function the law names itself, `call` (the first reference in the law). Ranges are
`{file, line, column, endLine, endColumn}`, 1-based, the end exclusive, with `file` relative to the project. When the law threw,
the entry whose function is in the error's stack also has `failing: true`; a law that returned `false` has no stack, so no entry
is marked. An `uncovered` result's `line` is the function's declaration line.

## Build

```sh
npm ci
npm run fetch:upstream
npm run build:native -w tsc-ts           # needs clang (and zig on Windows); build:native:dev is faster to build
npm run build -w tslaws
TSC_LAWS_BIN=packages/tsc-ts/dist/tsc npm test -w tslaws
TSC_TS_BIN=packages/tsc-ts/dist/tsc node --test packages/tsc-ts/tests/laws.test.mjs
```

On Windows the native build is `dist/tsc`; copy it to `tsc.exe` to run it.

## What is where

| Path                                                     | Contents                                                                                                |
| -------------------------------------------------------- | ------------------------------------------------------------------------------------------------------- |
| `packages/tsc-ts/src/compiler/parser.ts`                 | `law` parsing: `isLawDeclarationStart`, `parseLawDeclaration`; `NodeFlags.Law` and `Proved` in `ast.ts` |
| `packages/tsc-ts/src/laws/manifest.ts`                   | `--laws-manifest`                                                                                       |
| `packages/tslaws/src/symbolic.ts`, `smt.ts`              | the symbolic executor and the Z3 driver                                                                 |
| `packages/tslaws/src/check.ts`, `coverage.ts`, `lock.ts` | the check, the coverage gate, the tamper lock                                                           |
| `packages/tslaws/src/generators.ts`                      | generators from declared types                                                                          |
| `packages/tslaws/src/init.ts`, `hints.ts`, `cli.ts`      | scaffolding, agent hints, commands                                                                      |
| `packages/tslaws/hooks/`                                 | Claude Code hook, settings example, agent rules                                                         |
| `packages/vscode-tslaws/`                                | VS Code extension: grammar for `law`, live diagnostics, CodeLens, Test Explorer                         |
| `examples/basic/`                                        | a small project with a failing law, a lock and coverage                                                 |

## Limits

- Laws over arrays are bounded: Z3 holds an array as a fixed number of slots. Unbounded claims about every element need
  quantifiers, which Z3 does not decide reliably; put the claim in a loop `invariant` over scalars and the array's length.
- Laws over plain `number` mostly stay `tested`: SMT floating point arithmetic is decidable but usually too slow. Use `int`
  or `bigint` where you want a proof.
- Loop invariants prove partial correctness (a loop that never ends is not flagged), and an array that grows past its room
  is outside the claim.
- Browser and async laws are tested, not proved.
- Browser laws need an installed browser: Chrome, Edge or Chromium by default, or Playwright's Firefox or WebKit with `--browser`.
- The compiler needs a native toolchain to build; the `laws-v*` release workflow publishes builds for macOS, Linux and Windows.

## Intro video

[docs/media/tslaws-explained.mp4](media/tslaws-explained.mp4) is a 103-second illustrated explainer of what tslaws is and what it offers: the problem with agent-written code, the law, the gate, a checkout story (a coupon makes a negative total, the law catches it, the fix is proved), the lock, and where it runs. `scripts/demo/explain.mjs` makes it from `scripts/demo/explainer.json`, with the real code from `examples/checkout` and the real output in `scripts/demo/captures/`.

[docs/media/tslaws-delegation-explainer.mp4](media/tslaws-delegation-explainer.mp4) is a 123-second illustrated explainer of what tslaws offers in one picture, why laws help a migration, and how a person can lend `accept` to an agent for a limited time with `tslaws delegate grant`. It says plainly that a grant is a decision bounded in time and audited, not a sandbox. The command output in it is real, from `examples/checkout` (`scripts/demo/captures/`); the grant file and log lines are labelled illustration drawn from this document. `NARRATION=explainer-delegation.json node scripts/demo/explain.mjs` makes it from `scripts/demo/explainer-delegation.json`.

[docs/media/tslaws-intro.mp4](media/tslaws-intro.mp4) is a 79-second narrated recording: the law typed out, the real dashboard running the real laws in `examples/basic`, `examples/react` and `examples/e2e`, and the real `tslaws check` output, including the tamper failure after a law is edited. The voice is [Kokoro](https://huggingface.co/hexgrad/Kokoro-82M) (`scripts/demo/voice.mjs`, open neural text to speech, offline); the music bed and sound cues are synthesised by `scripts/demo/mix.mjs`; `scripts/demo/record.mjs` records the screen. `scripts/demo/captures/` holds the recorded command output.

## Migrating from other test frameworks

`tslaws migrate <from> [files...] [--write] [--out DIR]` reads existing tests and writes them as laws in call style.
`<from>` is `vitest`, `jest`, `rstest`, `bun`, `node` (`node:test`), `fast-check` or `playwright`. Without files it searches the
current directory for `*.test.*` and `*.spec.*` files of that framework. It reads the TypeScript syntax tree, never the text.

By default it is a dry run: it prints which files it would write, how many laws each holds, and every construct it could not
convert, as `file:line`. `--write` creates `<name>.laws.ts` next to each test (Playwright tests become `<name>.browser.laws.ts`),
or under `--out DIR` with the same folders. It never overwrites a file and never deletes a test. The new laws are not in
`tsc-laws.lock`: read them, run `tslaws check`, and have a person run `tslaws accept`.

| Source                                   | Becomes                                                                                                                                                                                                                                                                                                                          |
| ---------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `it`, `test`                             | `law('describe > nested > test', () => { ... })`; the body is kept, `expect` is imported from its package                                                                                                                                                                                                                        |
| `beforeEach`, `afterEach`                | inlined at the start (and in a `finally` at the end) of each law; `beforeAll` and `afterAll` too, with a note                                                                                                                                                                                                                    |
| `.skip`, `.todo`, `.only`                | listed in the report; skipped laws are not written, `.only` is dropped                                                                                                                                                                                                                                                           |
| `test.each` tables                       | one law per row, named from the title with `%s`, `%i` and `$name` filled in                                                                                                                                                                                                                                                      |
| `fc.assert(fc.property(...))`, `it.prop` | a typed law when every arbitrary has a type: `integer` is `int`, `nat` is `int` plus `assume(n >= 0)`, `string`, `boolean`, `array(x)` is `x[]`, `float` and `double` are `number`; limits such as `min` and `max` become `assume` lines. Otherwise the `fc.assert` is kept in a law with no parameters, and the report says why |
| Playwright `test(...)`                   | an end-to-end law: `page`, `context` and `baseURL` fixtures become `e2e.page()`, `e2e.context()` and `e2e.baseURL()`, and a relative `page.goto('/x')` becomes `e2e.open('/x')`; fixtures such as `request`, `test.use` and `testInfo` are reported, not guessed                                                                 |

Matchers are not reimplemented: a converted file keeps importing `expect` from `vitest`, `@jest/globals`, `@rstest/core`,
`bun:test` or `@playwright/test`, so that package must stay installed.
