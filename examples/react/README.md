# React example

A small task board (add, check off, delete, filter, clear completed) held to laws. It shows:

- **Node laws** on the pure reducer in `src/model/tasks.ts`: `src/model/tasks.laws.ts`. Four are `law proved` and the
  prover settles them for every input (scalar claims about one task and about index clamping); the array laws come out
  `bounded` (the prover unrolls arrays up to `--bound`), and the ones that build sets or run a whole reducer sequence stay
  `tested`.
- **Browser laws with React**: `src/components/*.browser.laws.ts` mount `<App />` with `createRoot` in real headless
  Chrome or Edge, and drive it with `click`, `type` and `settle` like a user.
  - `App.browser.laws.ts`: a **stateful law** (`runModelAsync`). Random lists of add, toggle, remove, clear and filter
    operations run against the real UI and a plain-array model; after every step the rendered `li` rows, their checkboxes
    and the "N left" counter must match the model. A failure shrinks to the shortest list of operations. A second law adds
    any list of strings and expects exactly the non-blank ones, trimmed.
  - `FilterBar.browser.laws.ts`: for any click sequence exactly one filter button has `aria-pressed="true"`, the last one
    clicked.
  - `App.a11y.browser.laws.ts`: an **accessibility law**, `accessible(el)` from axe-core, over empty and full boards, with
    finished tasks, under every filter, and after typing and adding a task.
- `src/components/harness.ts` is shared test plumbing (mount the app, read the DOM). It is plain `.ts`, so the laws can
  call `createElement` and need no JSX.
- `tslaws.json` turns on `jsx: "react-jsx"` and covers `.tsx`; every exported function, component and hook is reached by
  a law or the check reports it `uncovered`.

```sh
npm i
npx tslaws check     # the compiler must be built; set TSC_LAWS_BIN to it (see docs/laws.md)
npx tslaws ui        # the dashboard: watch the board being clicked live
```

Expected: 4 proved, 8 bounded, 9 tested (the 5 browser laws show method `browser`), 0 failed. It takes about a minute: the
browser laws drive a real page 200 times each.

`tsc-laws.lock` records the laws as accepted. The committed lock was generated for this example; for your own project a
person runs `npx tslaws accept` at a terminal (it refuses to run without one).

`npm i` here installs React and axe-core. `tslaws` is a dev dependency; inside this repository it resolves from the
workspace instead.

## Try breaking it

Make one edit, run `npx tslaws check`, and put it back.

1. In `src/model/tasks.ts`, make the `done` filter return everything: change `if (filter === 'done') return tasks.filter((t) => t.done);`
   to `if (filter === 'done') return tasks;`. `boardAgreesWithModel` fails with the shrunk counterexample
   `[["showDone","add"]]`: pick the Done filter, then add a task, and the board shows a task the model says is hidden.
   `filtersPartitionTasks` fails too.
2. In `src/components/FilterBar.tsx`, delete `aria-pressed={filter === value}`. `exactlyOneFilterIsPressed` fails with
   the counterexample `[[]]`: with no clicks at all, no button is pressed.
3. In `src/components/TaskItem.tsx`, change the `<label>` wrapper to a `<div>`. The checkbox loses its name, and
   `boardIsAccessible` and `boardStaysAccessibleAfterAdding` fail (axe rule `label`). The board still works, which is
   why only an accessibility law notices.
4. In `remaining` (`src/model/tasks.ts`) count `t.done` instead of `!t.done`. The "N left" counter is wrong:
   `boardAgreesWithModel` fails with `[["add"]]`, `addingTitlesRendersTheNonBlankOnes` with `["!"]`, and the node laws
   `clearCompletedKeepsRemaining` and `remainingMatchesActiveFilter` fail too.

## Mutation testing

`npx tslaws mutate --max 8 --seed 1` copies the project and mutates the covered code. On the model alone (the `.ts`
files) 6 of 8 mutants are killed (75%). The two survivors are instructive: `nextId` starting at 2 instead of 1 changes no
claim a law makes, and `from > tasks.length` instead of `>=` only differs for an index `moveTask` already handles by
reading `undefined`; both are equivalent mutants for the laws as written.
