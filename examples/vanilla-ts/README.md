# Vanilla TypeScript example

A markdown-lite note editor in plain TypeScript, with no framework, held to laws by `tslaws`. It shows the three kinds of
law side by side:

- **Node laws** (`*.laws.ts`) over the pure code: `src/markdown.ts` (the converter) and `src/notes-store.ts` (the store).
  Properties over any string, a stateful `runModel` law, and laws the prover handles: `wordCountIsBoundedByLength` is
  `proved` for every string and every length through a loop `invariant` in `countWords`; `indexOfIdStaysInRange` and
  `addGrowsByOne` are `bounded`.
- **Browser laws** (`*.browser.laws.ts`) that run the real DOM code in headless Chrome or Edge: the editor preview always
  equals `markdown()` of what was typed, a stateful `runModelAsync` law drives the whole app (add, rename, delete, filter)
  against an array model, a custom element law, and an accessibility law with `accessible()` (axe-core).
- **Coverage**: every exported function and class under `src/` must be reached by some law, or the check reports it
  `uncovered`.

| File                          | What it is                                               |
| ----------------------------- | -------------------------------------------------------- |
| `src/markdown.ts`             | pure: escaping, bold/italic, headings, lists, paragraphs |
| `src/notes-store.ts`          | pure: add, rename, delete, search, word count, int ids   |
| `src/note-editor.ts`          | DOM: title, textarea, live preview, word counter, save   |
| `src/note-list.ts`            | DOM: the list with a filter box                          |
| `src/word-counter-element.ts` | custom element `<word-counter text="...">`               |
| `src/app.ts`                  | wires the store, list and editor together                |
| `src/*.laws.ts`               | the laws (yours; the lock `tsc-laws.lock` records them)  |

## Run it

```sh
npm i
npx tslaws check      # or: npm run check
npx tslaws ui         # dashboard: tree, source, live reruns
```

You need Chrome, Edge or Chromium for the browser laws (`TSLAWS_BROWSER` points at another executable). `tslaws.json`
lists the files to cover and the compiler's `lib` (`dom`); `tsconfig.json` is only for your editor.

Expected: every law `proved`, `bounded` or `tested`, none `failed`, `uncovered` or `tampered`. The browser laws report method
`browser`.

The shipped `tsc-laws.lock` was generated for this folder. For your own project, run `npx tslaws accept` in a terminal
after you have read the laws; it refuses to run without a TTY, so an agent cannot accept its own laws.

Note: `notes-store.ts` imports `invariant` from `tslaws`, which is a real runtime call. A production bundle would either
keep it or replace it with a no-op.

## Try breaking it

Each edit below was made, checked and reverted.

1. In `src/markdown.ts`, make `escapeHtml` return `text` unchanged. `escapedTextHasNoMarkup` fails with the counterexample
   `["<"]`, and the browser law `previewNeverRunsMarkup` fails because a typed `<script>` and `<img onerror>` reach the
   page. (The preview is set with `innerHTML`; these laws are what make that safe.)
2. In `countWords` in `src/notes-store.ts`, change `words += 1` to `words += 2`. The proved law
   `wordCountIsBoundedByLength` fails (`["!"]`), `wordsAreCountedBySplitting` throws `loop invariant violated`, and the
   browser laws about the word counter fail too.
3. In `searchNotes`, drop `.toLowerCase()` from `const q = query.trim().toLowerCase();`. `searchFindsTheTitleItWasGiven`
   fails with `["A"]`.

A real catch while writing this example: the first version of the converter turned a bare `# ` line into an empty
`<h1></h1>`. The accessibility law found it (`[1,"# "]`, axe `empty-heading`), and `noEmptyHeadingsOrItems` now pins the fix.
