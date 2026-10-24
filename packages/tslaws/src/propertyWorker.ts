import { createRequire } from 'node:module';
import { parentPort } from 'node:worker_threads';
import ts from 'typescript';
import { compilerOptions, declarationFiles, jsPath, runLaw, summarise, typesOf } from './property.ts';
import type { CheckOptions, ManifestLaw } from './types.ts';

// Property tests run here so that a law over code that never terminates costs a timeout, not the whole check.
const require = createRequire(import.meta.url);
let programOf: { outDir: string; program: ts.Program } | undefined;

parentPort!.on('message', (request: { outDir: string; law: ManifestLaw; options: CheckOptions }) => {
  try {
    const { outDir, law, options } = request;
    if (programOf?.outDir !== outDir) programOf = { outDir, program: ts.createProgram(declarationFiles(outDir), compilerOptions) };
    const types = typesOf(programOf.program, outDir, law);
    const fn = (require(jsPath(outDir, law.file)) as Record<string, (...args: unknown[]) => unknown>)[law.name]!;
    parentPort!.postMessage({ ok: summarise(runLaw(fn, types.generators, options)) });
  } catch (error) {
    parentPort!.postMessage({ error: (error as Error).message });
  }
});
