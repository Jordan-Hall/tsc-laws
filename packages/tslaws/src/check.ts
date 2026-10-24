import { createRequire } from 'node:module';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import * as fc from 'fast-check';
import ts from 'typescript';
import { build, readManifest } from './compile.ts';
import { GeneratorFactory, UnsupportedType } from './generators.ts';
import { compareLock, lawKey, readLock } from './lock.ts';
import { proveLaw, type Shape } from './smt.ts';
import type { CheckOptions, LawResult, ManifestLaw } from './types.ts';

export interface CheckReport {
  results: LawResult[];
  compileDiagnostics: string;
  compileOk: boolean;
  lockMissing: boolean;
  /** Whether every law holds and nothing is open, failed or tampered with. */
  ok: boolean;
}

interface LawTypes {
  generators: fc.Arbitrary<unknown>[];
  shapes: Shape[];
}

function dtsPath(outDir: string, file: string): string {
  return join(outDir, file.replace(/\.(ts|mts|cts)$/, '.d.ts'));
}

function jsPath(outDir: string, file: string): string {
  return join(outDir, file.replace(/\.(ts|mts|cts)$/, '.js'));
}

/** What the prover models of `type`: numbers, booleans and records of them. */
function shapeOf(checker: ts.TypeChecker, type: ts.Type): Shape {
  if (type.flags & ts.TypeFlags.Number) return 'number';
  if (type.flags & ts.TypeFlags.Boolean) return 'boolean';
  if (!(type.flags & ts.TypeFlags.Object) || checker.isArrayType(type) || checker.isTupleType(type)) return undefined;
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

function typesOf(program: ts.Program, outDir: string, law: ManifestLaw): LawTypes {
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

function isDiscard(error: unknown): boolean {
  return error instanceof Error && error.name === 'LawDiscard';
}

function runLaw(
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

export async function check(options: CheckOptions, enforceLock: boolean): Promise<CheckReport> {
  const laws = readManifest(options.compiler, options.files, options.cwd);
  const results: LawResult[] = [];
  const blocked = new Set<string>();
  const add = (law: ManifestLaw, status: LawResult['status'], method: string, extra: Partial<LawResult> = {}): void => {
    results.push({ file: law.file, name: law.name, line: law.line, status, method, ...extra });
    blocked.add(lawKey(law.file, law.name));
  };

  let lockMissing = false;
  if (enforceLock) {
    const lock = readLock(options.lockFile);
    lockMissing = lock === undefined;
    const byKey = new Map(laws.map((l) => [lawKey(l.file, l.name), l]));
    for (const violation of compareLock(lock, laws)) {
      const law = byKey.get(violation.key);
      if (law === undefined) {
        const [file, name] = violation.key.split('::') as [string, string];
        results.push({
          file,
          name,
          line: 0,
          status: 'tampered',
          method: 'lock',
          message: 'law was removed since the lock was accepted',
        });
      } else {
        add(law, 'tampered', 'lock', {
          message:
            violation.reason === 'added'
              ? 'law is not in the lock; a person must run `tslaws accept`'
              : 'law changed since the lock was accepted',
        });
      }
    }
  }

  for (const law of laws) {
    if (law.problems.length > 0 && !blocked.has(lawKey(law.file, law.name)))
      add(law, 'error', 'manifest', { message: law.problems.join('; ') });
  }

  const built = build(options.compiler, options.files, options.cwd);
  const program = ts.createProgram(
    options.files.map((f) => dtsPath(built.outDir, f)).filter((p) => existsSync(p)),
    {
      skipLibCheck: true,
      strict: true,
      target: ts.ScriptTarget.ES2022,
      module: ts.ModuleKind.CommonJS,
      moduleResolution: ts.ModuleResolutionKind.Bundler,
      types: [],
    },
  );
  const require = createRequire(import.meta.url);

  for (const law of laws) {
    if (blocked.has(lawKey(law.file, law.name))) continue;
    let types: LawTypes;
    try {
      types = typesOf(program, built.outDir, law);
    } catch (error) {
      add(law, 'error', 'generators', { message: (error as Error).message });
      continue;
    }
    let fn: ((...args: unknown[]) => unknown) | undefined;
    try {
      fn = (require(jsPath(built.outDir, law.file)) as Record<string, (...args: unknown[]) => unknown>)[law.name];
    } catch (error) {
      add(law, 'error', 'load', { message: `cannot load compiled law: ${(error as Error).message}` });
      continue;
    }
    if (typeof fn !== 'function') {
      add(law, 'error', 'load', { message: 'compiled module does not export the law' });
      continue;
    }
    const details = runLaw(fn, types.generators, options);
    if (details.failed) {
      const message = details.errorInstance instanceof Error ? details.errorInstance.message : undefined;
      if (details.counterexample === null) {
        add(law, 'open', 'property', {
          runs: details.numRuns,
          seed: details.seed,
          message: 'assume() discards nearly every generated input',
        });
      } else {
        add(law, 'failed', 'property', {
          runs: details.numRuns,
          seed: details.seed,
          counterexample: fc.stringify(details.counterexample),
          message: message === undefined || message.startsWith('Property failed by returning false') ? 'returned false' : `threw: ${message}`,
        });
      }
      continue;
    }
    if (options.noProve) {
      add(law, law.proved ? 'open' : 'tested', 'property', {
        runs: details.numRuns,
        seed: details.seed,
        message: law.proved ? 'marked proved but proving is disabled' : undefined,
      });
      continue;
    }
    const holds = (inputs: unknown[]): boolean => {
      try {
        return fn(...inputs) !== false;
      } catch (error) {
        return isDiscard(error);
      }
    };
    const proof = await proveLaw({
      law,
      shapes: types.shapes,
      jsFile: jsPath(built.outDir, law.file),
      model: options.numbers,
      timeoutMs: options.proofTimeoutMs,
      holds,
    });
    if (proof.kind === 'proved') add(law, 'proved', `smt:${proof.model}`, { runs: details.numRuns, seed: details.seed });
    else if (proof.kind === 'refuted')
      add(law, 'failed', 'smt', { counterexample: proof.model, message: 'refuted by the prover' });
    else if (law.proved)
      add(law, 'open', 'smt', {
        runs: details.numRuns,
        seed: details.seed,
        message: `marked proved but not proved: ${proof.reason}`,
      });
    else add(law, 'tested', 'property', { runs: details.numRuns, seed: details.seed, message: proof.reason });
  }

  const ok = built.ok && !lockMissing && results.every((r) => r.status === 'proved' || r.status === 'tested');
  return { results, compileDiagnostics: built.diagnostics, compileOk: built.ok, lockMissing, ok };
}
