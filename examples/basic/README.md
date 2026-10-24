# Basic example

A small project held to laws. `src/math.ts` is the code; `src/math.laws.ts` is the person's side; `tsc-laws.lock` records
the laws as accepted.

```sh
# from this directory, with the compiler built (see docs/laws.md) and TSC_LAWS_BIN pointing at it
npx tslaws check
```

Expected: `addCommutes`, `addIdentity`, `clampWithinBounds` and `manhattanSymmetric` are proved or tested, and
`sortKeepsLength` **fails** with a minimal counterexample such as `[[3,3]]`. That is on purpose: `sortNumbers` drops
duplicates, and the law says it must not. Fix the code, not the law, and rerun.

Try these:

- Add `export const sub = (a: number, b: number) => a - b;` to `math.ts`. The check reports `sub` as `uncovered`.
- Edit a law in `math.laws.ts`. The check reports it as `tampered` until a person runs `tslaws accept`.
- Write a candidate law in `src/new.proposed.laws.ts` and run `npx tslaws check --proposed`.
- Use `int` instead of `number` in a law to move from `tested` to `proved` or `bounded`.
