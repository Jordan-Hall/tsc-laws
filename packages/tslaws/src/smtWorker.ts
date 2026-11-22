// The Z3 worker thread (see smt.ts): it holds one Z3 instance and answers one query at a time. Its WebAssembly build
// blocks the thread, so the owner stops a runaway query by terminating the worker rather than by a solver timeout.
import { parentPort } from 'node:worker_threads';
import { init } from 'z3-solver';

const ready = init().then((api) => api.Z3);

parentPort!.on('message', async ({ id, query, values }: { id: number; query: string; values: string }) => {
  try {
    const Z3 = await ready;
    const config = Z3.mk_config();
    const ctx = Z3.mk_context(config);
    let out = '';
    let vals = '';
    try {
      out = (await Z3.eval_smtlib2_string(ctx, query)).trim();
      vals = out.startsWith('sat') && values ? (await Z3.eval_smtlib2_string(ctx, values)).trim() : '';
    } finally {
      Z3.del_context(ctx);
      Z3.del_config(config);
    }
    parentPort!.postMessage({ id, out, vals });
  } catch (error) {
    parentPort!.postMessage({ id, error: String((error as Error | undefined)?.message ?? error) });
  }
});
