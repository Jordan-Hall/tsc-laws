## Laws

This project states behaviour as `law` declarations in `*.laws.ts`. They are the person's side of the contract.

- Run `npx tslaws check` before you finish or commit. It must exit 0: every law `proved` or `tested`, none `open`, `failed` or `tampered`.
- Every exported function must be reached by a law (`uncovered` fails). Do not add `@tslaws-exempt` yourself; the lock rejects it. If code needs a law, ask for one or write it in a `*.proposed.laws.ts`.
- A failed law means the code is wrong. Fix the code. Never edit, weaken, delete or add a law in a `*.laws.ts` file, and never run `tslaws accept`; the lock (`tsc-laws.lock`) will reject the change anyway.
- To suggest a law, write it in `<name>.proposed.laws.ts` and run `npx tslaws check --proposed` to see whether it holds. A person promotes it.
- `proved` laws need a proof the prover can find for every input. Keep proved code to `int`/`bigint`/`boolean`/`string`, records and `const`/`if`/`return`/calls; arrays and loops only ever reach `bounded`. Use the `int` type from `tslaws` for whole numbers.
