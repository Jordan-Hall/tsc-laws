import { createRequire } from 'node:module';
import { parentPort } from 'node:worker_threads';
import { arbitraryOf, type Plan } from './plan.ts';
import { jsPath, runLaw, summarise } from './propertyRun.ts';
import type { CheckOptions, ManifestLaw } from './types.ts';

// Property tests run here so that a law over code that never terminates costs a timeout, not the whole check.
// The main process read the types and sends the generators as plans, so a worker never loads the TypeScript compiler.
const require = createRequire(import.meta.url);

parentPort!.on(
  'message',
  async (request: { outDir: string; law: ManifestLaw; plans: Plan[]; options: CheckOptions }) => {
    try {
      const { outDir, law, plans, options } = request;
      const generators = plans.map(arbitraryOf);
      // The worker outlives a check, and the code may have been recompiled since the last one.
      for (const loaded of Object.keys(require.cache)) if (loaded.startsWith(outDir)) delete require.cache[loaded];
      const fn = (require(jsPath(outDir, law.file)) as Record<string, (...args: unknown[]) => unknown>)[
        law.symbol ?? law.name
      ]!;
      parentPort!.postMessage({ ok: summarise(await runLaw(fn, generators, options), options) });
    } catch (error) {
      parentPort!.postMessage({ error: (error as Error).message });
    }
  },
);
