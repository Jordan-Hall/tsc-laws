# Vanilla JavaScript example

A unit converter with a history list, written in **plain JavaScript** (`.js` sources, JSDoc types, no TypeScript syntax) and
held to laws by `tslaws`. The laws are still TypeScript files; they import the `.js` modules.

This works because `tslaws.json` turns on plain-JavaScript support:

```json
{
  "cover": ["src/**/*.js"],
  "compilerOptions": { "lib": ["dom", "dom.iterable", "es2022"], "allowJs": true, "checkJs": true }
}
```

With `allowJs` the compiler emits the `.js` files and a declaration for each, so the laws get typed generators from the JSDoc
(`@param`, `@returns`, `@typedef`), `cover` includes `.js` files, and the prover reads the emitted JavaScript. `checkJs`
type-checks the JavaScript too; a type error in a `.js` file is a compile error in the check.

| File                         | What it is                                                                                     |
| ---------------------------- | ---------------------------------------------------------------------------------------------- |
| `src/convert.js`             | pure: unit conversion, rounding, a clamp over `int`s                                           |
| `src/history.js`             | pure `pushEntry`, `removeEntry`, `keptCount` (loop invariant), `History`                       |
| `src/widget.js`              | DOM: inputs, result, save, history list, clear                                                 |
| `src/app.js`                 | starts the widget in a page                                                                    |
| `src/convert.laws.ts`        | node laws: round trip, identity, sign, proved `int` laws                                       |
| `src/history.laws.ts`        | node laws, a proved loop law, a stateful `runModel` law                                        |
| `src/widget.browser.laws.ts` | browser laws: result text, a stateful `runModelAsync` law for the history list, `accessible()` |

## Run it

```sh
npm i
npx tslaws check      # or: npm run check
npx tslaws ui
```

You need Chrome, Edge or Chromium for the browser laws. Expected: every law `proved`, `bounded` or `tested`; here three are
`proved` (`centimetresAreHundredPerMetre`, `digitsStayInRange`, and `keptCountIsTheSmaller`, which covers every count and
limit through the `invariant` in `keptCount`). `tsconfig.json` is only for your editor.

The shipped `tsc-laws.lock` was generated for this folder; for your own project run `npx tslaws accept` in a terminal after
reading the laws (it refuses to run without one).

`history.js` imports `invariant` from `tslaws`, a runtime call; a production bundle keeps it or swaps in a no-op.

## Try breaking it

Each edit was made, checked and reverted.

1. In `convert`, change `/ METRES_PER[to]` to `* METRES_PER[to]`. `roundTrip` fails (`[1,"mi","km"]`) and so does
   `sameUnitIsIdentity`.
2. In `keptCount`, change `kept += 1` to `kept += 2`. The proved law `keptCountIsTheSmaller` fails (`[3,3]`).
3. In `pushEntry`, change `Math.max(limit, 0)` to `limit + 1`. `pushKeepsNewestFirstAndRespectsLimit`,
   `historyNeverExceedsLimit` and the stateful `historyAgreesWithModel` (`["add","add","add","add"]`) fail.
4. In `labelled` in `widget.js`, change `wrapper.append(`${label} `, control)` to `wrapper.append(control)`. The inputs lose
   their labels and the browser law `appStartsFocusedAndAccessible` fails (axe `label`).

Add `export const nothing = () => 0;` to any covered `.js` file and the check reports it `uncovered`. Remove `allowJs` from
`tslaws.json` and the laws no longer compile, because importing a `.js` file needs it.
