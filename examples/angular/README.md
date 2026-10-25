# Angular example

A small shopping cart (Angular 22, standalone components, signals, zoneless) held to laws. It shows:

- **Node laws** (`src/pricing.laws.ts`) over pure integer-cent money arithmetic, with `law proved` claims the prover
  discharges with Z3 and the rest honestly `tested` or `bounded`.
- **Browser laws with Angular's JIT compiler** (`src/*.browser.laws.ts`): the real components run in headless Chrome or Edge.
- **A stateful UI law** (`cartUiAgreesWithModel`): random sequences of add, remove, set-quantity and clear operations are
  driven through the DOM and compared with a `Map` model after every step (row count, each quantity, line totals, subtotal,
  discount, tax, total and the empty state).
- **A property law** (`typedQuantityScalesSubtotal`): any typed quantity from -20 to 150 gives a subtotal of price times the
  clamped quantity.
- **An accessibility law** (`shopHasNoAccessibilityViolations`): the whole app audited with axe-core after 0 to 4 adds.

```
src/
  pricing.ts                      pure money functions (int cents, discount tiers, tax, clamp, format)
  products.ts                     catalogue and tax rate
  cart.service.ts                 @Injectable holding a signal of items; computed count and order summary
  quantity-input.component.ts     input() / output() quantity field that clamps what is typed
  product-list.component.ts       products with Add buttons
  cart.component.ts               rows, quantity inputs, remove, clear, totals (@for / @if)
  app.component.ts                composes the two lists
  test/mountAngular.ts            the helper browser laws use to bootstrap a component (see below)
  pricing.laws.ts                 node laws
  cart.browser.laws.ts            stateful law against the whole app
  quantity.browser.laws.ts        property laws for the quantity field
  components.browser.laws.ts      each child component mounted alone, with inputs set directly
  a11y.browser.laws.ts            axe-core audit
```

## Run it

```sh
npm i
npx tslaws check      # or: npm run check
npx tslaws ui         # dashboard with live reruns
```

You need the tsc-laws compiler (`TSC_LAWS_BIN` or `tsc-laws` on PATH) and Chrome, Edge or Chromium (`TSLAWS_BROWSER` points
at another). `tsc-laws.lock` is committed here so the example runs as is. `tslaws accept` is for people only, so in your own
project a person should run `npx tslaws accept` after reviewing the laws. The whole check takes a minute or two, mostly the
browser laws.

Expected: `18 laws: 3 proved, 1 bounded, 14 tested, 0 open, 0 failed, 0 tampered, 0 errors`, exit 0. Browser laws report
`tested` with method `browser`; they are never `proved`.

## Why JIT and legacy decorators

tsc-laws compiles TypeScript itself; there is no Angular CLI and no AOT (`ngc`) step. Angular still runs, through its
runtime JIT compiler:

- `tslaws.json` sets `experimentalDecorators: true`, `emitDecoratorMetadata: false` and `useDefineForClassFields: false`, so
  `@Component` and `@Injectable` compile as legacy decorators and class fields are assigned in the constructor.
- `import '@angular/compiler'` (in `src/test/mountAngular.ts`) must run before any component is used. It enables JIT.
- Components are standalone with inline `template` strings; there is no `templateUrl` or `styleUrls` to resolve.
- No metadata is emitted, so services are injected with `inject(...)`, not constructor parameters.
- Zoneless change detection (`provideZonelessChangeDetection()`), so zone.js is not needed. Signals schedule the updates.
- **Signal inputs need one workaround.** The Angular CLI's JIT transform rewrites `input()` and `output()` into decorator
  metadata; without it Angular does not know a signal property is an input and reading it throws `NG0950: Input is
  required but no value is available yet`. `quantity-input.component.ts` adds what that transform would:
  `@Input({ isSignal: true, alias: 'quantity', required: true, transform: undefined } as never)` on each `input()` and
  `@Output('quantityChange')` on the `output()`. (`as never` because `isSignal` is not in the public type.) Components
  that use only `inject()`, signals and `computed()` need nothing.

## The mount helper

`mountAngular(Component, inputs?)` in `src/test/mountAngular.ts`:

1. calls tslaws `mount()` for a container whose cleanup destroys the application (the DOM is reset between inputs);
2. `createApplication({ providers: [provideZonelessChangeDetection()] })`;
3. `createComponent(Component, { environmentInjector, hostElement })`, `setInput` for each entry of `inputs`, and
   `appRef.attachView`;
4. returns `{ container, app, ref, instance, get(Service), flush() }`. `flush()` is `app.tick()`, `await app.whenStable()`,
   then tslaws `settle(0)`. Call it after every click or `type()` before reading the DOM.

Every law gets a fresh application, so `providedIn: 'root'` services start empty each time.

## What the node laws prove

| Law                                                                              | Status                         |
| -------------------------------------------------------------------------------- | ------------------------------ |
| `lineTotalNeverNegative`                                                         | proved                         |
| `discountTierNeverExceedsWholePrice` (`sub * bps <= sub * 10000`)                | proved                         |
| `discountTierIsMonotonic`                                                        | proved                         |
| `subtotalIsSumOfLines`                                                           | bounded (arrays up to 4 items) |
| `discountNeverExceedsSubtotal`, tax rounding, summary, clamp, format, tier edges | tested                         |

The prover cannot decide integer division or `Math.floor(a / b)` (the solver gives up), so the claims that need `/` are
`tested`. The proved discount law is the division-free form of "the discount never exceeds the subtotal": the tier is at
most 10%, so `subtotal * tierBps <= subtotal * 10000`. Imported or exported constants (`MAX_QUANTITY`) also do not lower, so
the clamp law is `tested`.

## Try breaking it

Make an edit, run `npx tslaws check --summary`, then undo it (`npx tslaws regressions clear` forgets the saved counterexamples).

1. In `pricing.ts` change `taxCents` from `+ 5000) / 10000` to `+ 0) / 10000` (floor instead of round half up). Fails:
   `taxIsRoundedHalfUp` (a counterexample like `[715, 7]`) and `cartUiAgreesWithModel` (one tea already shows the wrong total).
2. In `quantity-input.component.ts` delete `field.value = String(next);`. Typing `-5` into a quantity of 1 leaves `-5`
   in the field because the binding sees no change. Fails: `typedQuantityScalesSubtotal`, `quantityInputEmitsClampedValue`
   and `junkQuantityFallsBackToOne`.
3. In `quantity-input.component.ts` delete the `[attr.aria-label]` line. Fails: `shopHasNoAccessibilityViolations` (axe
   rule `label`).
4. In `pricing.ts` change `return 500` to `return 5000` in `discountTierBps`. The prover refutes
   `discountTierNeverExceedsWholePrice` (`sub = 8640`) and `discountTierIsMonotonic`, and `cartUiAgreesWithModel` fails
   too.
5. In `cart.component.ts` change the remove button to `(click)="cart.clear()"`. Fails: `cartUiAgreesWithModel` with a
   shrunk sequence such as add mug, add pen, remove mug.

## Limits

- Browser laws are `tested`, never `proved`. `cartUiAgreesWithModel` is the slowest law (a real page and a flush per step,
  well over 10 s here) and must finish inside the 30 s default property timeout; shorten operation lists or pass
  `--property-timeout` if your machine is slower.
- `tslaws mutate` hard-codes a 5 s property timeout and 1.5 s proof timeout, so a project with Angular browser laws only
  gets a baseline through its API with larger timeouts.
