import { Worker } from 'node:worker_threads';
import { readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import * as fc from 'fast-check';
import ts from 'typescript';
import { GeneratorFactory, UnsupportedType } from './generators.ts';
import type { Shape } from './smt.ts';
import type { CheckOptions, ManifestLaw } from './types.ts';


export interface LawTypes {
  generators: fc.Arbitrary<unknown>[];
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
  return join(outDir, file.replace(/\.(ts|mts|cts)$/, '.d.ts'));
}

export function jsPath(outDir: string, file: string): string {
  return join(outDir, file.replace(/\.(ts|mts|cts)$/, '.js'));
}

/** What the prover models of `type`: numbers, `int`s, bigints, strings, booleans, arrays and records of them. */
export function shapeOf(checker: ts.TypeChecker, type: ts.Type): Shape {
  if ((type.aliasSymbol ?? type.getSymbol())?.getName() === 'int' && type.flags & (ts.TypeFlags.Intersection | ts.TypeFlags.Number))
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
    moduleSymbol === undefined ? undefined : checker.getExportsOfModule(moduleSymbol).find((s) => s.getName() === law.name);
  if (exported === undefined) throw new UnsupportedType(`law ${law.name} is not in the declaration output`);
  const signature = checker.getTypeOfSymbol(exported).getCallSignatures()[0];
  if (signature === undefined) throw new UnsupportedType(`law ${law.name} is not a function`);
  const factory = new GeneratorFactory(checker);
  const generators: fc.Arbitrary<unknown>[] = [];
  const shapes: Shape[] = [];
  for (const parameter of signature.getParameters()) {
    const declaration = parameter.valueDeclaration ?? parameter.declarations?.[0];
    if (declaration === undefined) throw new UnsupportedType(`parameter ${parameter.getName()} has no declaration`);
    const type = checker.getTypeOfSymbolAtLocation(parameter, declaration);
    shapes.push(shapeOf(checker, type));
    const optional = (parameter.flags & ts.SymbolFlags.Optional) !== 0;
    generators.push(factory.of(optional ? checker.getNonNullableType(type) : type));
  }
  return { generators, shapes };
}

export function isDiscard(error: unknown): boolean {
  return error instanceof Error && error.name === 'LawDiscard';
}

export function runLaw(
  fn: (...args: unknown[]) => unknown,
  generators: fc.Arbitrary<unknown>[],
  options: CheckOptions,
): fc.RunDetails<unknown[]> {
  const property = fc.property(...(generators as [fc.Arbitrary<unknown>]), (...args: unknown[]) => {
    try {
      return fn(...args) !== false;
    } catch (error) {
      if (isDiscard(error)) {
        fc.pre(false);
        return true;
      }
      throw error;
    }
  });
  return fc.check(property as unknown as fc.IProperty<unknown[]>, {
    numRuns: options.runs,
    seed: options.seed,
    maxSkipsPerRun: 100,
  }) as fc.RunDetails<unknown[]>;
}

export const compilerOptions: ts.CompilerOptions = {
  skipLibCheck: true,
  strict: true,
  target: ts.ScriptTarget.ES2022,
  module: ts.ModuleKind.CommonJS,
  moduleResolution: ts.ModuleResolutionKind.Bundler,
  types: [],
};

/** The outcome of a law's property test, without the generated values' prototypes so it can cross a thread. */
export interface PropertyOutcome {
  failed: boolean;
  numRuns: number;
  seed: number;
  /** Absent when the law failed because `assume` discarded nearly every input. */
  counterexample?: string;
  message?: string;
}

export function summarise(details: fc.RunDetails<unknown[]>): PropertyOutcome {
  const message = details.errorInstance instanceof Error ? details.errorInstance.message : undefined;
  return {
    failed: details.failed,
    numRuns: details.numRuns,
    seed: details.seed,
    counterexample: details.counterexample === null ? undefined : fc.stringify(details.counterexample),
    message,
  };
}

let worker: Worker | undefined;

/** Runs the property test of `law` in a worker, giving up on it after `options.propertyTimeoutMs`. */
export function runLawGuarded(outDir: string, law: ManifestLaw, options: CheckOptions): Promise<PropertyOutcome | 'timeout'> {
  const ext = import.meta.url.endsWith('.ts') ? '.ts' : '.js';
  if (worker === undefined) {
    worker = new Worker(new URL(`./propertyWorker${ext}`, import.meta.url));
    worker.unref();
  }
  const current = worker;
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      if (worker === current) worker = undefined;
      void current.terminate();
      resolve('timeout');
    }, options.propertyTimeoutMs ?? 30000);
    current.once('message', (message: { ok?: PropertyOutcome; error?: string }) => {
      clearTimeout(timer);
      if (message.ok !== undefined) resolve(message.ok);
      else reject(new Error(message.error));
    });
    current.postMessage({ outDir, law, options });
  });
}
