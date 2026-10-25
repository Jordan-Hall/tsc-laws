# Laws for TypeScript

`tsc-laws` is a fork of [tsc-ts](https://github.com/vercel-labs/tsc-ts) that adds one statement to TypeScript, `law`, and
`tslaws`, a checker that holds your code to those laws. It exists so that people can say what code must do, let coding
agents write the code, and get a machine verdict instead of a code review. The idea is Bend 2's: the person writes the
laws, the agent writes the program and its proofs, and a checker the agent cannot talk round gates every change. The
difference is that it stays TypeScript, so any human can read, run and fix everything.

## What it offers

| Offer                            | What you get                                                                                                                                                                           |
| -------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **`law` declarations**           | A statement of the language, type-checked like a function, that says what must hold for all inputs.                                                                                    |
| **Verdicts, not opinions**       | Each law ends `proved`, `bounded`, `tested`, `failed`, `open`, `uncovered`, `tampered` or `error`. One exit status.                                                                    |
| **Real proofs**                  | Z3 proves laws over exact integers, bigints, booleans, strings and records, and over IEEE doubles where it can decide. Loop invariants extend this to loops for every iteration count. |
| **Bounded proofs**               | Arrays, plain loops and recursion are checked exhaustively up to a stated bound.                                                                                                       |
| **Property tests as the floor**  | Anything the prover cannot lower is tested with `fast-check`; inputs are generated from your declared types, and failures shrink to a minimal counterexample with a seed.              |
| **Laws the agent cannot weaken** | `tsc-laws.lock` hashes every law. Changing, adding or removing one, or exempting code, fails the check until a person runs `tslaws accept`, which refuses to run without a terminal.   |
| **Coverage**                     | Every exported function and class must be reached by a law, so new code cannot slip through unchecked.                                                                                 |
| **Agent ergonomics**             | `tslaws init` scaffolds the rules and a Claude Code hook; `--json` and `--summary` give structured, compact output with a next-action `hint` per result; `--watch` re-checks on save.  |
| **Human ergonomics**             | A VS Code grammar for `law`, plain TypeScript output, and counterexamples you can paste into a test.                                                                                   |

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

Name a law file `*.browser.laws.ts` and its laws run in a real browser (Chrome, Edge or Chromium; `TSLAWS_BROWSER` points at
another executable). Node still generates the inputs from the declared types and shrinks failures; each input is sent to a
page where your compiled code and the law run against a live DOM. A law there may be `async`.

```ts
// src/counter.browser.laws.ts
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
// src/button.browser.laws.ts
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

Laws stay in `*.browser.laws.ts` and import components from `.tsx` files; an exported function component that no law
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

## End-to-end laws

There are three levels of law. All laws that need a browser share one suffix, `*.browser.laws.ts`; the import selects the level.

|             | Node laws                       | Component laws                                 | End-to-end laws                                             |
| ----------- | ------------------------------- | ---------------------------------------------- | ----------------------------------------------------------- |
| File        | `*.laws.ts`                     | `*.browser.laws.ts` importing `tslaws/browser` | `*.browser.laws.ts` importing `tslaws/e2e`                  |
| Runs        | in Node                         | inside one page of a real browser              | in Node, driving a real browser from outside                |
| Sees        | functions and values            | one component and its DOM                      | the whole running app: pages, forms, network, cookies, tabs |
| Speed       | fastest, thousands of inputs    | fast, tens of inputs                           | slowest; 10 inputs by default                               |
| Typical use | logic, parsers, reducers        | a widget with generated props                  | a purchase flow, login, a form across pages                 |
| Status      | `proved`, `bounded` or `tested` | `tested`                                       | `tested` (method `e2e`)                                     |

A file that imports both `tslaws/browser` and `tslaws/e2e` is an `error`: it is either component level or end-to-end, not
both. `*.e2e.laws.ts` is accepted as an alias that always means end-to-end.

An end-to-end law starts from a running app and a Playwright `Page`. Inputs are generated from the parameter types and a
failure is shrunk to a minimal counterexample, like every other law. Every generated input gets a fresh browser context
and page, closed after it, so cookies and storage never leak between inputs.

```ts
// e2e/cart.browser.laws.ts
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

In a browser law the operations are clicks and `apply` waits for the page to settle:

```ts
// src/counter.browser.laws.ts
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

`packages/vscode-tslaws` is a VS Code extension with no bundled dependencies. Above each `law` in a `*.laws.ts` file it shows a
CodeLens with the last status (`proved`, `bounded`, `tested`, `open`, `failed`, `uncovered`, `tampered`, `error` or `not run`),
a `Run` lens, and for a failure the shrunk counterexample. Failed, open, tampered and error laws appear as problems on the
law's line with the message, counterexample and hint. A status-bar item shows totals (`laws: 3 proved, 1 failed`) and opens
the dashboard. Commands: `tslaws.check`, `tslaws.runFile`, `tslaws.openDashboard` (runs `tslaws ui --no-open --port 0`), and
`tslaws.accept`, which only types `npx tslaws accept` into a terminal; a person presses Enter. Settings: `tslaws.runOnSave`
(default on), `tslaws.executable` and `tslaws.args`. It runs `node_modules/.bin/tslaws`, else `npx tslaws`.

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
   `TSLAWS_AGENT` set.
2. **No code escapes.** Every exported function or class in the covered modules must be reached by a law, directly or
   through the functions a law calls. Covered modules are the `cover` globs of `tslaws.json`
   (`{ "cover": ["src/**/*.ts", "!src/**/*.test.ts"] }`), or, without that file, every module the laws import. A function
   marked `@tslaws-exempt` in its doc comment is exempt only once the exemption is in the lock.
3. **Agents propose, people promote.** Agents write candidate laws in `*.proposed.laws.ts` and try them with
   `tslaws check --proposed` (no lock, no coverage gate). A person moves them into a `*.laws.ts` file and accepts.
4. **The gate runs by itself.** `tslaws init` installs a Claude Code hook (`hooks/claude-hook.mjs`) that blocks
   `git commit` and sends the agent back to work when the check fails, plus rules for `AGENTS.md`
   (`hooks/AGENTS.snippet.md`).

## Commands

```
tslaws init [--force]
tslaws accept [files...]
tslaws regressions [list|clear]
tslaws mutate [files...] [--max N] [--seed N] [--runs N] [--bound N] [--proof-timeout MS] [--property-timeout MS] [--json]
tslaws check [files...] [--json] [--summary] [--watch] [--runs N] [--seed N] [--no-prove] [--no-regressions] [--bound N]
             [--proof-timeout MS] [--proposed] [--compiler PATH]
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

| Tool                    | Does                                                                                                        |
| ----------------------- | ----------------------------------------------------------------------------------------------------------- |
| `tslaws_check`          | `check --json` with hints; `files` limits it, `summary` keeps only the laws that do not pass and the totals |
| `tslaws_check_proposed` | `check --proposed`                                                                                          |
| `tslaws_explain`        | a law's source, its last result in this session with the hint, and the next action                          |
| `tslaws_propose`        | writes a law into a `*.proposed.laws.ts` file (a same-named law there is replaced) and returns its check    |

**Property: the server cannot weaken accepted laws.** No tool accepts laws, writes `tsc-laws.lock`, promotes a proposal
or edits a `*.laws.ts` file that is not a `*.proposed.laws.ts`. `tslaws_propose` refuses any other path, an absolute path,
a path outside the project root (also through a symlinked directory) and the `node_modules`, `.tslaws` and `.git`
directories, and accepts only imports and `law` declarations as source. The server sets `TSLAWS_AGENT=1`, so nothing it
spawns can run `accept` or `promote`. A proposed law is still code that `check --proposed` runs, as with any law file.

## Promoting proposed laws

`tslaws promote [file] [--all]` is the person's step after an agent proposes laws. Like `accept`, it refuses without a
terminal, under `CI`, or with `TSLAWS_AGENT` set. Name one `*.proposed.laws.ts` file, or pass `--all` for every one. For
each law it shows the name, the source and the current `check --proposed` result, then asks `promote? [y/N]`. Approved
laws are appended to the matching accepted file (`foo.proposed.laws.ts` to `foo.laws.ts`, created if missing; imports are
added once) and removed from the proposed file, which is deleted when no law is left. A name the accepted file already
has is refused. `promote` never writes the lock: review the diff, then run `tslaws accept`.

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
commit the corpus. `tslaws check --no-regressions` neither reads nor writes it. `tslaws regressions list` prints each law and
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

`tslaws.json` takes optional run settings besides `cover`, `compilerOptions` and `e2e`:

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

For a test report, redirect JUnit output: `npx tslaws check --reporter junit > tslaws-junit.xml`.

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
| `packages/vscode-tslaws/`                                | VS Code grammar for `law`                                                                               |
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

[docs/media/tslaws-intro.mp4](media/tslaws-intro.mp4) is a 79-second narrated recording: the law typed out, the real dashboard running the real laws in `examples/basic`, `examples/react` and `examples/e2e`, and the real `tslaws check` output, including the tamper failure after a law is edited. The voice is [Kokoro](https://huggingface.co/hexgrad/Kokoro-82M) (`scripts/demo/voice.mjs`, open neural text to speech, offline); the music bed and sound cues are synthesised by `scripts/demo/mix.mjs`; `scripts/demo/record.mjs` records the screen. `scripts/demo/captures/` holds the recorded command output.
