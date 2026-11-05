import { statSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join } from 'node:path';
import { parentPort } from 'node:worker_threads';
import ts from 'typescript';
import { compilerOptions, declarationFiles, jsPath, runLaw, summarise, typesOf } from './property.ts';
import type { CheckOptions, ManifestLaw } from './types.ts';

// Property tests run here so that a law over code that never terminates costs a timeout, not the whole check.
const require = createRequire(import.meta.url);
let programOf: { stamp: string; program: ts.Program } | undefined;

/** Names one build of `outDir`: `build` writes a fresh package.json there each time, so a new build is a new stamp. */
function stampOf(outDir: string): string {
  const built = statSync(join(outDir, 'package.json'));
  return `${outDir}|${built.birthtimeMs}|${built.mtimeMs}`;
}

parentPort!.on('message', async (request: { outDir: string; law: ManifestLaw; options: CheckOptions }) => {
  try {
    const { outDir, law, options } = request;
    // The worker outlives a check: a program of an earlier build would not know files added since (a new proposal).
    const stamp = stampOf(outDir);
    if (programOf?.stamp !== stamp)
      programOf = { stamp, program: ts.createProgram(declarationFiles(outDir), compilerOptions) };
    const types = typesOf(programOf.program, outDir, law);
    // The worker outlives a check, and the code may have been recompiled since the last one.
    for (const loaded of Object.keys(require.cache)) if (loaded.startsWith(outDir)) delete require.cache[loaded];
    const fn = (require(jsPath(outDir, law.file)) as Record<string, (...args: unknown[]) => unknown>)[law.name]!;
    parentPort!.postMessage({ ok: summarise(await runLaw(fn, types.generators, options), options) });
  } catch (error) {
    parentPort!.postMessage({ error: (error as Error).message });
  }
});
