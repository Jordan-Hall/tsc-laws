# End-to-end example

A small task board run as a whole: `server.mjs` is a Node server that serves the page and keeps the tasks, and the laws in
`src/board.browser.laws.ts` drive it from outside in a real browser (Chrome, Edge or Chromium), so the server, the page, its
script and the network between them all run. `tslaws check` starts the server from `tslaws.json`, runs the laws against it
and stops it.

| Law                      | What it holds                                                                     |
| ------------------------ | --------------------------------------------------------------------------------- |
| `addedTaskIsListed`      | any title typed into the form shows up, and the counter says one is left          |
| `counterCountsTheUndone` | after any number of adds and ticks, the counter equals the tasks not done         |
| `deletedTaskStaysGone`   | a deleted task is gone after a reload, so the server agrees with the page         |
| `boardPageIsAccessible`  | the page, with tasks on it, has no axe-core violation                             |
| `boardPageIsFast`        | paint, layout shift, blocking time, size and load stay within a budget (`fast()`) |

```sh
npm i
npx tslaws check      # or: npm run check
npx tslaws ui         # the dashboard, with live frames of the page while each law runs
npm start             # the app itself, at http://127.0.0.1:4410/
```

The file imports `tslaws/e2e`, which makes it an end-to-end law; a file that imports `tslaws/browser` instead mounts a
component in the page. See [docs/laws.md](../../docs/laws.md).
