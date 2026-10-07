import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { resolve } from 'node:path';
import { checkerSources, sourceIdentity } from './source-identity.mjs';

const compiler = resolve('node_modules/scriptc/bin/scriptc.exe');
const version = spawnSync(compiler, ['--version'], { encoding: 'utf8' });
if (version.status !== 0 || version.stdout.trim() !== '0.2.5') {
  throw new Error('This port requires scriptc v0.2.5. Run npm install.');
}
mkdirSync('dist', { recursive: true });
const result = spawnSync(compiler, ['build', 'src/cli.ts', '--optimization=release', '--strip', '-o', 'dist/tsts'], { stdio: 'inherit' });
process.exitCode = result.status ?? 1;
if (result.status === 0) {
  const llvm = readFileSync('dist/cli.ll', 'utf8');
  // v0.2.5 can widen recursive numeric arguments into boxed unions. Keep the
  // measured call path scalar; TypeScript annotations alone do not guarantee it.
  for (const [className, method, count] of [['Checker', 'isTypeAssignableTo', 2], ['Checker', 'isRelatedTo', 2], ['Checker', 'isSimpleTypeRelatedTo', 4], ['Checker', 'structuredTypeRelatedTo', 2], ['Checker', 'conditionalRelatedTo', 2], ['TypeArena', 'enumRelated', 2], ['TemplateTypes', 'matches', 2], ['TemplateTypes', 'infer', 2], ['TemplateTypes', 'constrained', 2], ['IndexSignatures', 'applicable', 2]]) {
    const declaration = llvm.split('\n').find(line => line.startsWith('define internal ') && line.includes(`_${className}_${method}(`));
    const parameters = declaration?.slice(declaration.indexOf('(') + 1, declaration.indexOf(')')).split(', ');
    if (!parameters || parameters.length !== count + 1 || parameters.slice(1).some(parameter => !parameter.startsWith('double '))) {
      throw new Error(`Boxed numeric arguments in ${className}.${method}; wrap the values in Number(...)`);
    }
  }
  const numericReturns = {
    Checker: ['conditionalRelatedTo', 'indexSignaturesRelatedTo'],
    TypeArena: ['instantiate', 'combine', 'tail', 'restTail', 'substitution', 'noInfer', 'substitutionIntersection', 'optionalType', 'removeOptional', 'positionKey', 'array', 'tuple', 'literal'],
    TemplateTypes: ['instantiate', 'create', 'construct', 'constraint', 'constrained'],
    StringMappings: ['instantiate', 'create', 'construct', 'constraint'],
    TupleTypes: ['fixed', 'end', 'totalFixed', 'knownKeys', 'instantiate', 'create', 'normalize', 'shape', 'elementSlice', 'slice', 'constraint'],
    SignatureInference: ['widen', 'common', 'reverseObject', 'reverseValue', 'inferValue'],
    IndexedTypes: ['simplify', 'keyof', 'access', 'constraint', 'baseConstraint', 'intersectKeys'],
    MappedTypes: ['root', 'instantiate', 'construct', 'withSubject', 'mapTuple', 'value', 'name', 'element', 'access', 'apparent', 'apparentKeys', 'keys', 'lowerBound', 'optionality'],
    ConditionalTypes: ['root', 'parameter', 'permissive', 'restrictive', 'instantiate', 'construct', 'branch', 'tail', 'evaluate', 'defaultConstraint', 'distributiveConstraint', 'constraint', 'simplify'],
    VarianceInference: ['marker'],
  };
  for (const [className, methods] of Object.entries(numericReturns)) for (const method of methods) {
    const declaration = llvm.split('\n').find(line => line.startsWith('define internal ') && line.includes(`_${className}_${method}(`));
    if (!declaration?.startsWith('define internal double ')) throw new Error(`Boxed numeric return in ${className}.${method}; wrap the values in Number(...)`);
  }
  writeFileSync('dist/build.json', JSON.stringify({ scriptc: '0.2.5', sourceSha256: sourceIdentity(checkerSources), arch: process.arch }) + '\n');
}
