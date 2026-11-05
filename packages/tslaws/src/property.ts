import { Worker } from 'node:worker_threads';
import { readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import type * as fc from 'fast-check';
import ts from 'typescript';
import { GeneratorFactory } from './generators.ts';
import { arbitraryOf, UnsupportedType, type Plan } from './plan.ts';
import { type PropertyOutcome } from './propertyRun.ts';
import { WorkerPool } from './pool.ts';
import type { Shape } from './smt.ts';
import type { CheckOptions, ManifestLaw } from './types.ts';

export { isDiscard, jsPath, runLaw, runProperty, summarise, type PropertyOutcome } from './propertyRun.ts';

export interface LawTypes {
  generators: fc.Arbitrary<unknown>[];
  /** The generators as data, for a worker that does not load TypeScript. */
  plans: Plan[];
  shapes: Shape[];
}

/** Every declaration file the compiler emitted: the laws' own do not import the code they are about. */
export function declarationFiles(outDir: string): string[] {
  const found: string[] = [];
  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir)) {
      const full = join(dir, entry);
      if (statSync(full).isDirectory()) {
        if (entry !== 'smt') walk(full);
      } else if (entry.endsWith('.d.ts')) found.push(full);
    }
  };
  walk(outDir);
  return found;
}

export function dtsPath(outDir: string, file: string): string {
  return join(outDir, file.replace(/\.(ts|tsx|mts|cts)$/, '.d.ts'));
}

/** What the prover models of `type`: numbers, `int`s, bigints, strings, booleans, arrays and records of them. */
export function shapeOf(checker: ts.TypeChecker, type: ts.Type): Shape {
  if (
    (type.aliasSymbol ?? type.getSymbol())?.getName() === 'int' &&
    type.flags & (ts.TypeFlags.Intersection | ts.TypeFlags.Number)
  )
    return 'int';
  if (type.flags & ts.TypeFlags.Number) return 'number';
  if (type.flags & ts.TypeFlags.BigInt) return 'bigint';
  if (type.flags & ts.TypeFlags.String) return 'string';
  if (type.flags & ts.TypeFlags.Boolean) return 'boolean';
  if (checker.isArrayType(type)) {
    const element = shapeOf(checker, checker.getTypeArguments(type as ts.TypeReference)[0]!);
    return element === undefined ? undefined : { array: element };
  }
  if (!(type.flags & ts.TypeFlags.Object) || checker.isTupleType(type)) return undefined;
  if (type.getCallSignatures().length > 0 || checker.getIndexInfosOfType(type).length > 0) return undefined;
  const fields: Record<string, Shape> = {};
  for (const property of checker.getPropertiesOfType(type)) {
    const declaration = property.valueDeclaration ?? property.declarations?.[0];
    if (declaration === undefined || property.flags & ts.SymbolFlags.Optional) return undefined;
    const shape = shapeOf(checker, checker.getTypeOfSymbolAtLocation(property, declaration));
    if (shape === undefined) return undefined;
    fields[property.getName()] = shape;
  }
  return { fields };
}

export function typesOf(program: ts.Program, outDir: string, law: ManifestLaw): LawTypes {
  const checker = program.getTypeChecker();
  const source = program.getSourceFile(dtsPath(outDir, law.file));
  if (source === undefined) throw new UnsupportedType(`no declaration output for ${law.file}`);
  const moduleSymbol = checker.getSymbolAtLocation(source);
  const exported =
    moduleSymbol === undefined
      ? undefined
      : checker.getExportsOfModule(moduleSymbol).find((s) => s.getName() === (law.symbol ?? law.name));
  if (exported === undefined) throw new UnsupportedType(`law ${law.name} is not in the declaration output`);
  const signature = checker.getTypeOfSymbol(exported).getCallSignatures()[0];
  if (signature === undefined) throw new UnsupportedType(`law ${law.name} is not a function`);
  const factory = new GeneratorFactory(checker);
  const plans: Plan[] = [];
  const shapes: Shape[] = [];
  for (const parameter of signature.getParameters()) {
    const declaration = parameter.valueDeclaration ?? parameter.declarations?.[0];
    if (declaration === undefined) throw new UnsupportedType(`parameter ${parameter.getName()} has no declaration`);
    const type = checker.getTypeOfSymbolAtLocation(parameter, declaration);
    shapes.push(shapeOf(checker, type));
    const optional = (parameter.flags & ts.SymbolFlags.Optional) !== 0;
    plans.push(factory.plan(optional ? checker.getNonNullableType(type) : type));
  }
  return { generators: plans.map(arbitraryOf), plans, shapes };
}

export const compilerOptions: ts.CompilerOptions = {
  skipLibCheck: true,
  strict: true,
  target: ts.ScriptTarget.ES2022,
  module: ts.ModuleKind.CommonJS,
  moduleResolution: ts.ModuleResolutionKind.Bundler,
  types: [],
};

const workers = new WorkerPool(() => {
  const ext = import.meta.url.endsWith('.ts') ? '.ts' : '.js';
  const worker = new Worker(new URL(`./propertyWorker${ext}`, import.meta.url));
  worker.unref();
  return worker;
});

/** Runs the property test of `law` in a pooled worker, giving up on it after `options.propertyTimeoutMs`. */
export async function runLawGuarded(
  outDir: string,
  law: ManifestLaw,
  options: CheckOptions,
  plans: Plan[],
): Promise<PropertyOutcome | 'timeout'> {
  const current = await workers.acquire();
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      current.off('message', onMessage);
      workers.discard(current);
      resolve('timeout');
    }, options.propertyTimeoutMs ?? 30000);
    const onMessage = (message: { ok?: PropertyOutcome; error?: string }): void => {
      clearTimeout(timer);
      workers.release(current);
      if (message.ok !== undefined) resolve(message.ok);
      else reject(new Error(message.error));
    };
    current.once('message', onMessage);
    // Functions cannot cross to the worker; it needs only the numbers.
    current.postMessage({ outDir, law, plans, options: { ...options, onEvent: undefined } });
  });
}
