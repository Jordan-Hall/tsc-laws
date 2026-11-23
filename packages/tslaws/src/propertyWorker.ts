import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join } from 'node:path';
import { parentPort } from 'node:worker_threads';
import { evictLoaded, installLawRuntime, runtimeFile, type LawRuntime } from './lawRuntime.ts';
import { arbitraryOf, type Plan } from './plan.ts';
import { jsPath, runLaw, summarise } from './propertyRun.ts';
import { installLoaderHooks, setImportMetaEnv, type ImportMetaEnv } from './runtimeEnv.ts';
import type { CheckOptions, ManifestLaw } from './types.ts';

// Property tests run here so that a law over code that never terminates costs a timeout, not the whole check.
// The main process read the types and sends the generators as plans, so a worker never loads the TypeScript compiler.
// Compiled laws are CommonJS (see `build` in compile.ts), loaded with `require` so that a recompiled law can be dropped
// from `require.cache` and loaded again; an `import()` of it could not be forgotten.
const require = createRequire(import.meta.url);
installLoaderHooks();
const loadedBuildKeys = new Map<string, string>();

parentPort!.on(
  'message',
  async (request: {
    outDir: string;
    law: ManifestLaw;
    plans: Plan[];
    options: CheckOptions;
    env: ImportMetaEnv;
    buildKey?: string;
  }) => {
    try {
      const { outDir, law, plans, options, env, buildKey } = request;
      setImportMetaEnv(env);
      const generators = plans.map(arbitraryOf);
      const sameBuild = buildKey !== undefined && loadedBuildKeys.get(outDir) === buildKey;
      if (!sameBuild) {
        // The build left the project's module resolution beside the output (aliases from its tsconfig, TypeScript sources).
        installLawRuntime(JSON.parse(readFileSync(join(outDir, runtimeFile), 'utf8')) as LawRuntime);
        // The worker outlives a check, and the code may have been recompiled since the last one. Files a plugin loaded go too.
        evictLoaded(require.cache, outDir);
        if (buildKey !== undefined) loadedBuildKeys.set(outDir, buildKey);
        else loadedBuildKeys.delete(outDir);
      }
      const fn = (require(jsPath(outDir, law.file)) as Record<string, (...args: unknown[]) => unknown>)[
        law.symbol ?? law.name
      ]!;
      parentPort!.postMessage({ ok: summarise(await runLaw(fn, generators, options), options) });
    } catch (error) {
      parentPort!.postMessage({ error: (error as Error).message });
    }
  },
);
