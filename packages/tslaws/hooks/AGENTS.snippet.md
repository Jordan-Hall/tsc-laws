## Laws

This project states behaviour as `law` declarations in `*.laws.ts`. They are the person's side of the contract.

- Run `npx tslaws check` before you finish or commit. It must exit 0: every law `proved` or `tested`, none `open`, `failed` or `tampered`.
- Every exported function must be reached by a law (`uncovered` fails). Do not add `@tslaws-exempt` yourself; the lock rejects it. If code needs a law, ask for one or write it in a `*.proposed.laws.ts`.
- A failed law means the code is wrong. Fix the code. Never edit, weaken, delete or add a law in a `*.laws.ts` file, and never run `tslaws accept`; the lock (`tsc-laws.lock`) will reject the change anyway.
- To suggest a law, write it in `<name>.proposed.laws.ts` and run `npx tslaws check --proposed` to see whether it holds. A person promotes it.
- If the `tslaws` MCP server is configured (`npx tslaws mcp`), use its tools `tslaws_check`, `tslaws_check_proposed`, `tslaws_explain` and `tslaws_propose` instead of the shell; they cannot accept laws or change the lock. `tslaws promote` moves proposed laws into the accepted file and is the person's step, like `tslaws accept`; never run either.
- `proved` laws need a proof the prover can find for every input. Keep proved code to `int`/`bigint`/`boolean`/`string`, records and `const`/`if`/`return`/calls; arrays and plain loops only reach `bounded`. To prove a scalar loop for every input, write `invariant(...)` first in its body (it is code, so it is yours to write). Use the `int` type from `tslaws` for whole numbers.
