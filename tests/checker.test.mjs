import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { primitives, primitiveNames, objects, objectNames, matrix, variadicSignatures, variadicSignatureNames, noInferSignatures, noInferSignatureNames, enumRelations, enumRelationNames, templateSignatures, templateSignatureNames, patternIndexes, patternIndexNames, stringMappingSignatures, stringMappingSignatureNames } from './cases.mjs';
import { checkerSources, oracleSources, sourceIdentity } from '../tools/source-identity.mjs';

for (const [path, sources, command] of [['dist/build.json', checkerSources, 'build'], ['dist/oracle-build.json', oracleSources, 'build:oracle']]) {
  const build = JSON.parse(readFileSync(path, 'utf8'));
  if (build.sourceSha256 !== sourceIdentity(sources)) throw new Error('Stale test executable; run npm run ' + command);
  if (build.arch !== process.arch) throw new Error('Test executable architecture does not match this host');
}

const temp = mkdtempSync(join(tmpdir(), 'tsts-tests-'));
const native = resolve('dist/tsts');
const oracle = resolve('dist/tsgo-oracle');
let serial = 0;
let differentialQueries = 0;
after(() => console.log('Differential queries checked: ' + differentialQueries));

export function runCase(source, queries, options = {}) {
  const inputPath = join(temp, `${serial++}-input.json`);
  const graphPath = join(temp, `${serial++}-graph.json`);
  writeFileSync(inputPath, JSON.stringify({ source, queries, ...options }));
  const reference = spawnSync(oracle, [inputPath], { encoding: 'utf8', maxBuffer: 32 * 1024 * 1024 });
  assert.equal(reference.status, 0, reference.error?.message ?? reference.stderr.slice(0, 2000));
  const go = JSON.parse(reference.stdout);
  writeFileSync(graphPath, JSON.stringify(go.graph));
  const result = spawnSync(native, [graphPath, '--rounds', String(options.rounds ?? 1), ...(options.cold ? ['--cold'] : [])], { encoding: 'utf8', maxBuffer: 32 * 1024 * 1024 });
  assert.equal(result.status, 0, result.stderr);
  const tsts = JSON.parse(result.stdout);
  const mismatches = [];
  for (let i = 0; i < queries.length; i++) {
    if (tsts.results[i] !== go.graph.queries[i].expected) mismatches.push({ ...queries[i], expected: go.graph.queries[i].expected, actual: tsts.results[i] });
  }
  assert.deepEqual(mismatches, []);
  assert.equal(tsts.checksum, go.benchmark.checksum);
  differentialQueries += queries.length;
  return go.graph;
}

test('static executable was built using scriptc 0.2.5', () => {
  assert.match(execFileSync(native, ['--version'], { encoding: 'utf8' }), /scriptc 0\.2\.5/);
});
test('primitive, literal, union, and empty-object matrix agrees with tsgo', () => {
  runCase(primitives, matrix(primitiveNames));
});
test('structural, recursive, tuple, array, and function matrix agrees with tsgo', () => {
  runCase(primitives + objects, matrix(objectNames));
});
test('non-strict null and function variance rules agree with tsgo', () => {
  runCase(primitives + objects, matrix(['Null', 'Undef', 'Str', 'Num', 'Unknown', 'Never', 'StrNum', 'Empty', 'FNum', 'FOne', 'FVoid', 'FOptional']), { strictNullChecks: false, strictFunctionTypes: false });
});
test('exact optional property types agree with tsgo', () => {
  runCase(primitives + objects, matrix(['X', 'XOptional', 'XOptionalUndefined', 'XUndefined', 'Undef']), { exactOptionalPropertyTypes: true });
});
test('array and tuple lengths and numeric index signatures agree with tsgo', () => {
  runCase(primitives + objects + '\ntype Length = { length: number }; type LengthTwo = { length: 2 }; type NumberIndex = { [n: number]: number }; type StringIndex = { [n: number]: string }; type AnyIndex = { [k: string]: any }; type MixedIndex = { [k: string]: any; [n: number]: number };', matrix(['NumArray', 'LitArray', 'StrArray', 'Pair', 'Short', 'OptionalPair', 'Length', 'LengthTwo', 'NumberIndex', 'StringIndex', 'AnyIndex', 'MixedIndex']));
});
test('rest tuples align required prefixes and suffixes like tsgo', () => {
  const source = 'type Empty = []; type One = [number]; type Pair = [number, number]; type Mixed = [string, number]; type NumArray = number[]; type StrArray = string[]; type NumRest = [...number[]]; type NumPrefix = [number, ...number[]]; type StrPrefix = [string, ...number[]]; type NumSuffix = [...number[], number]; type StrSuffix = [...number[], string]; type Ends = [string, ...number[], string]; type Optional = [number?, ...number[]]; type RoRest = readonly [...number[]]; type RoOne = readonly [number];';
  const queries = matrix(['Empty', 'One', 'Pair', 'Mixed', 'NumArray', 'StrArray', 'NumRest', 'NumPrefix', 'StrPrefix', 'NumSuffix', 'StrSuffix', 'Ends', 'Optional', 'RoRest', 'RoOne']);
  runCase(source, queries);
  runCase(source, queries, { exactOptionalPropertyTypes: true, rounds: 3, cold: true });
});
test('ordinary array methods and tuple methods agree with tsgo', () => {
  runCase('type Num = number[]; type Str = string[]; type Ro = readonly number[]; type Pair = [number, number]; type Empty = []; type PushNum = { push(...items: number[]): number }; type PushStr = { push(...items: string[]): number }; type PopNum = { pop(): number | undefined }; type PopStr = { pop(): string | undefined }; type SliceNum = { slice(start?: number, end?: number): number[] }; type Join = { join(separator?: string): string }; type Every = { every(predicate: (value: number) => unknown): boolean }; type Some = { some(predicate: (value: number) => unknown): boolean };', matrix(['Num', 'Str', 'Ro', 'Pair', 'Empty', 'PushNum', 'PushStr', 'PopNum', 'PopStr', 'SliceNum', 'Join', 'Every', 'Some']));
});
test('primitive and structural cross-relations agree with tsgo', () => {
  runCase(primitives + objects, matrix(['Any', 'Unknown', 'Never', 'Void', 'Undef', 'Null', 'Str', 'Num', 'Bool', 'Obj', 'Empty', 'UnknownLike', 'X', 'XOptional', 'IndexNum', 'NumArray', 'FNum']));
});
test('generated structural cases agree with tsgo in both query orders', () => {
  let state = 0x51a7;
  const next = () => { state = (Math.imul(state, 1664525) + 1013904223) >>> 0; return state; };
  const atoms = ['number', 'string', '1', '"a"', 'boolean', 'number | string', 'null | number'];
  const names = [];
  let source = '';
  for (let i = 0; i < 48; i++) {
    const name = 'Generated' + i;
    names.push(name);
    const properties = [];
    for (const property of ['a', 'b', 'c', 'd', 'e']) {
      if (next() % 3 === 0) continue;
      properties.push(`${property}${next() % 4 === 0 ? '?' : ''}: ${atoms[next() % atoms.length]}`);
    }
    source += `type ${name} = { ${properties.join('; ')} };\n`;
  }
  const queries = matrix(names);
  runCase(source, queries);
  runCase(source, [...queries].reverse());
  runCase(source, queries, { rounds: 5, cold: true });
});
test('lone-surrogate string literals retain byte identity across the oracle boundary', () => {
  runCase('type HighA = "\\uD800"; type HighB = "\\uD801"; type LowA = "\\uDC00"; type LowB = "\\uDC01"; type Scalar = "\\u{1F600}"; type Paired = "\\uD83D\\uDE00"; type Nul = "\\0"; type Empty = ""; type Replacement = "\\uFFFD";', matrix(['HighA', 'HighB', 'LowA', 'LowB', 'Scalar', 'Paired', 'Nul', 'Empty', 'Replacement']));
});
test('lone-surrogate property names and numeric names retain identity', () => {
  runCase('type HighA = { "\\uD800": number }; type HighB = { "\\uD801": number }; type LowA = { "\\uDC00": number }; type Replacement = { "\\uFFFD": number }; type Scalar = { "\\u{1F600}": number }; type Paired = { "\\uD83D\\uDE00": number }; type Numeric = { "1": number; "-1": number; "1e3": string; "NaN": number }; type NumericIndex = { [n: number]: number }; type StringIndex = { [s: string]: number };', matrix(['HighA', 'HighB', 'LowA', 'Replacement', 'Scalar', 'Paired', 'Numeric', 'NumericIndex', 'StringIndex']));
});
test('this parameters, rest parameters, and abstract constructors agree with tsgo', () => {
  runCase('type ThisVoid = (this: void, x: number) => void; type ThisNum = (this: number, x: number) => void; type ThisOne = (this: 1, x: number) => void; type RestNum = (...args: number[]) => void; type FixedNum = (x: number) => void; type RestOne = (...args: 1[]) => void; type ConstructNum = new (x: number) => { value: number }; type ConstructOne = new (x: 1) => { value: 1 }; type AbstractNum = abstract new (x: number) => { value: number };', matrix(['ThisVoid', 'ThisNum', 'ThisOne', 'RestNum', 'FixedNum', 'RestOne', 'ConstructNum', 'ConstructOne', 'AbstractNum']));
});
test('primitive apparent members and boxed interfaces agree with tsgo', () => {
  runCase(primitives + '\ntype Length = { length: number }; type StringIndex = { [n: number]: string }; type ToString = { toString(): string }; type NumberValue = { valueOf(): number }; type StringValue = { valueOf(): string }; type Weak = { missing?: number }; type WeakLength = { length?: number }; type BoxedString = String; type BoxedNumber = Number;', matrix(['Str', 'StrA', 'Num', 'One', 'Big', 'Bool', 'Sym', 'Length', 'StringIndex', 'ToString', 'NumberValue', 'StringValue', 'Weak', 'WeakLength', 'BoxedString', 'BoxedNumber']));
});
test('type predicates and callback return variance agree with tsgo', () => {
  runCase('type StringGuard = (x: unknown) => x is string; type LiteralGuard = (x: unknown) => x is "a"; type NumberGuard = (x: unknown) => x is number; type BooleanTest = (x: unknown) => boolean; type FirstGuard = (x: unknown, y: unknown) => x is string; type SecondGuard = (x: unknown, y: unknown) => y is string; type AssertString = (x: unknown) => asserts x is string; type AssertNumber = (x: unknown) => asserts x is number; type Assert = (x: unknown) => asserts x; type MethodCallbackNum = { method(cb: () => number): void }; type MethodCallbackOne = { method(cb: () => 1): void }; type CallbackNum = (cb: () => number) => void; type CallbackOne = (cb: () => 1) => void;', matrix(['StringGuard', 'LiteralGuard', 'NumberGuard', 'BooleanTest', 'FirstGuard', 'SecondGuard', 'AssertString', 'AssertNumber', 'Assert', 'MethodCallbackNum', 'MethodCallbackOne', 'CallbackNum', 'CallbackOne']));
});
test('top rest signatures agree with tsgo', () => {
  runCase('type AnyRest = (...args: any[]) => any; type NeverRest = (...args: never[]) => unknown; type UnknownRest = (...args: unknown[]) => unknown; type Fixed = (x: number) => number; type ThisRest = (this: number, ...args: any[]) => any; type Generic = <T>(x: T) => T;', [...matrix(['AnyRest', 'NeverRest', 'UnknownRest', 'Fixed', 'ThisRest']), { source: 'Generic', target: 'AnyRest' }, { source: 'Generic', target: 'NeverRest' }]);
});
test('discriminated unions cover every combination of source tags', () => {
  const source = 'type A = { tag: "a"; value: number }; type B = { tag: "b"; value: number }; type AOne = { tag: "a"; value: 1 }; type Both = { tag: "a" | "b"; value: number }; type BothOne = { tag: "a" | "b"; value: 1 }; type Either = A | B; type NarrowEither = AOne | B; type ExtraTag = { tag: "a" | "b" | "c"; value: number }; type MissingValue = { tag: "a" | "b" }; type OptionalTag = { tag?: "a" | "b"; value: number }; type OptionalEither = { tag?: "a"; value: number } | { tag?: "b"; value: number }; type Product = { tag: "a" | "b"; ok: boolean; value: number }; type FullProduct = { tag: "a"; ok: true; value: number } | { tag: "a"; ok: false; value: number } | { tag: "b"; ok: true; value: number } | { tag: "b"; ok: false; value: number }; type IncompleteProduct = { tag: "a"; ok: true; value: number } | { tag: "a"; ok: false; value: number } | { tag: "b"; ok: true; value: number }; type MixedTarget = Either | number;';
  const queries = matrix(['A', 'B', 'AOne', 'Both', 'BothOne', 'Either', 'NarrowEither', 'ExtraTag', 'MissingValue', 'OptionalTag', 'OptionalEither', 'Product', 'FullProduct', 'IncompleteProduct', 'MixedTarget']);
  runCase(source, queries);
  runCase(source, queries, { exactOptionalPropertyTypes: true });
});
test('discriminant cartesian limit agrees with tsgo', () => {
  let source = '';
  const names = [];
  for (const width of [2, 3]) {
    const atoms = Array.from({ length: width }, (_, i) => String(i));
    const members = atoms.flatMap(a => atoms.flatMap(b => atoms.map(c => `{ a: ${a}; b: ${b}; c: ${c} }`)));
    source += `type Product${width} = { a: ${atoms.join(' | ')}; b: ${atoms.join(' | ')}; c: ${atoms.join(' | ')} }; type Target${width} = ${members.join(' | ')};\n`;
    names.push('Product' + width, 'Target' + width);
  }
  runCase(source, matrix(names));
});
test('private declarations and inferred index signature eligibility agree with tsgo', () => {
  runCase(primitives + 'class PrivateA { private value = 0; x = 1; } class PrivateB { private value = 0; x = 1; } class ChildA extends PrivateA {} class PublicX { x = 1; } interface InterfaceX { x: number } type LiteralX = { x: number }; type IndexNum = { [k: string]: number }; type IndexAny = { [k: string]: any }; type NumberAny = { [n: number]: any }; type MixedAny = { [k: string]: any; [n: number]: any };', matrix(['PrivateA', 'PrivateB', 'ChildA', 'PublicX', 'InterfaceX', 'LiteralX', 'Obj', 'Empty', 'Str', 'Num', 'Unknown', 'IndexNum', 'IndexAny', 'NumberAny', 'MixedAny']));
});
test('reference expectations do not supply the native answer and graph references are validated', () => {
  const graph = runCase('type A = { x: number }; type B = { x: 1 };', matrix(['A', 'B']));
  for (const query of graph.queries) query.expected = !query.expected;
  const graphPath = join(temp, 'independent-graph.json');
  writeFileSync(graphPath, JSON.stringify(graph));
  const result = spawnSync(native, [graphPath], { encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(JSON.parse(result.stdout).results, graph.queries.map(query => !query.expected));
  graph.types[0].properties[0].type = graph.types.length;
  writeFileSync(graphPath, JSON.stringify(graph));
  const invalid = spawnSync(native, [graphPath], { encoding: 'utf8' });
  assert.equal(invalid.status, 1);
  assert.match(invalid.stderr, /Invalid referenced type ID/);
});
test('generic identities, constraints, defaults, and return inference agree with tsgo', () => {
  runCase('type Identity = <T>(x: T) => T; type OtherIdentity = <U>(x: U) => U; type NumberIdentity = <T extends number>(x: T) => T; type StringIdentity = <T extends string>(x: T) => T; type DefaultIdentity = <T = number>(x: T) => T; type FixedNumber = (x: number) => number; type FixedOne = (x: 1) => 1; type FixedString = (x: string) => string; type NumberToString = (x: number) => string; type UnknownIdentity = (x: unknown) => unknown; type AnyIdentity = (x: any) => any; type Return = <T>() => T; type ReturnDefault = <T = number>() => T; type ReturnNumber = () => number; type ReturnString = () => string; type Sink = <T>(x: T) => void; type NumberSink = (x: number) => void;', matrix(['Identity', 'OtherIdentity', 'NumberIdentity', 'StringIdentity', 'DefaultIdentity', 'FixedNumber', 'FixedOne', 'FixedString', 'NumberToString', 'UnknownIdentity', 'AnyIdentity', 'Return', 'ReturnDefault', 'ReturnNumber', 'ReturnString', 'Sink', 'NumberSink']), { rounds: 3, cold: true });
});
test('generic array, object, tuple, and callback inference agree with tsgo', () => {
  const source = 'type ArrayId = <T>(x: T[]) => T[]; type NumberArray = (x: number[]) => number[]; type OneArray = (x: 1[]) => 1[]; type StringArray = (x: string[]) => string[]; type ArrayMismatch = (x: number[]) => string[]; type BoxId = <T>(x: { value: T }) => { value: T }; type NumberBox = (x: { value: number }) => { value: number }; type OneBox = (x: { value: 1 }) => { value: 1 }; type StringBox = (x: { value: string }) => { value: string }; type BoxMismatch = (x: { value: number }) => { value: string }; type TupleId = <T>(x: [T, T]) => [T, T]; type NumberTuple = (x: [number, number]) => [number, number]; type LiteralTuple = (x: [1, 2]) => [1, 2]; type MixedTuple = (x: [number, string]) => [number, string]; type Callback = <T>(fn: (x: T) => T, value: T) => T; type NumberCallback = (fn: (x: number) => number, value: number) => number; type OneCallback = (fn: (x: 1) => 1, value: 1) => 1; type MismatchCallback = (fn: (x: number) => string, value: number) => string;';
  const queries = matrix(['ArrayId', 'NumberArray', 'OneArray', 'StringArray', 'ArrayMismatch', 'BoxId', 'NumberBox', 'OneBox', 'StringBox', 'BoxMismatch', 'TupleId', 'NumberTuple', 'LiteralTuple', 'MixedTuple', 'Callback', 'NumberCallback', 'OneCallback', 'MismatchCallback']);
  runCase(source, queries);
  runCase(source, [...queries].reverse(), { rounds: 3, cold: true });
});
test('generic references substitute members and preserve recursive and this types', () => {
  const source = 'interface Box<T> { value: T } interface Link<T> { value: T; next?: Link<T> } interface Fluent<T> { value: T; next(): this } type NumberBox = Box<number>; type OneBox = Box<1>; type StringBox = Box<string>; type NumberLink = Link<number>; type OneLink = Link<1>; type StringLink = Link<string>; type NumberFluent = Fluent<number>; type OneFluent = Fluent<1>; type StringFluent = Fluent<string>; type PlainNumber = { value: number }; type PlainOne = { value: 1 }; type PlainString = { value: string };';
  runCase(source, matrix(['NumberBox', 'OneBox', 'StringBox', 'NumberLink', 'OneLink', 'StringLink', 'NumberFluent', 'OneFluent', 'StringFluent', 'PlainNumber', 'PlainOne', 'PlainString']), { rounds: 5, cold: true });
});
test('generic overload erasure and concrete tuple rest signatures agree with tsgo', () => {
  runCase('type Overload = { <T>(x: T): T; (x: number): number }; type Reverse = { (x: number): number; <T>(x: T): T }; type Fixed = (x: number) => number; type Literal = (x: 1) => 1; type Text = (x: string) => string; type Rest = (...args: [number, ...string[]]) => void; type FixedRest = (x: number, y: string) => void; type OptionalRest = (x: number, y?: string) => void; type WrongRest = (x: string, y: number) => void; type ArrayRest = (...args: (number | string)[]) => void;', matrix(['Overload', 'Reverse', 'Fixed', 'Literal', 'Text', 'Rest', 'FixedRest', 'OptionalRest', 'WrongRest', 'ArrayRest']));
});
test('generic method scopes and library map signatures agree with tsgo', () => {
  const source = 'interface Factory<T> { make<U extends T>(x: U): U } type NumberFactory = Factory<number>; type StringFactory = Factory<string>; type NumberMaker = { make(x: number): number }; type OneMaker = { make(x: 1): 1 }; type StringMaker = { make(x: string): string }; type NumMap = number[]["map"]; type StrMap = string[]["map"]; type RoMap = readonly number[]["map"]; type NumberMap = (f: (x: number) => string) => string[]; type StringMap = (f: (x: string) => number) => number[]; type GenericMap = <U>(f: (x: number) => U) => U[]; type WrongMap = (f: (x: number) => number) => string[];';
  runCase(source, matrix(['NumberFactory', 'StringFactory', 'NumberMaker', 'OneMaker', 'StringMaker', 'NumMap', 'StrMap', 'RoMap', 'NumberMap', 'StringMap', 'GenericMap', 'WrongMap']), { rounds: 5, cold: true });
});
test('generic inference priority, union matching, and literal widening agree with tsgo', () => {
  const source = 'type Value = <T>(x: T, y: T) => T; type Widen = <T>(x: T, y: T) => T[]; type Constrained = <T extends number>(x: T, y: T) => T[]; type Maybe = <T>(x: T | undefined) => T; type Numbers = (x: number, y: number) => number; type Literals = (x: 1, y: 2) => 1 | 2; type LiteralArray = (x: 1, y: 2) => (1 | 2)[]; type WideArray = (x: 1, y: 2) => number[]; type Mixed = (x: number, y: string) => number | string; type Conflict = (x: number, y: number) => string; type Optional = (x: number | undefined) => number; type BoolArray = <T>(x: T) => T[]; type LiteralBoolArray = (x: true) => true[]; type WideBoolArray = (x: true) => boolean[];';
  runCase(source, matrix(['Value', 'Widen', 'Constrained', 'Maybe', 'Numbers', 'Literals', 'LiteralArray', 'WideArray', 'Mixed', 'Conflict', 'Optional', 'BoolArray', 'LiteralBoolArray', 'WideBoolArray']), { rounds: 3, cold: true });
});
test('dependent constraints, defaults, and nested union inference agree with tsgo', () => {
  const source = 'type Dependent = <T extends U, U>(x: T, y: U) => T; type NumberDependent = <T extends U, U extends number>(x: T, y: U) => T; type Default = <T = number, U = T>(x?: T, y?: U) => U; type ArrayMaybe = <T>(x: T[] | undefined) => T[]; type BoxMaybe = <T>(x: { value: T } | undefined) => T; type Numbers = (x: number, y: number) => number; type Literals = (x: 1, y: number) => 1; type Strings = (x: string, y: string) => string; type Mixed = (x: string, y: number) => string; type Optional = (x?: number, y?: number) => number; type NumArrayMaybe = (x: number[] | undefined) => number[]; type StringArrayMaybe = (x: string[] | undefined) => string[]; type NumBoxMaybe = (x: { value: number } | undefined) => number;';
  runCase(source, matrix(['Dependent', 'NumberDependent', 'Default', 'ArrayMaybe', 'BoxMaybe', 'Numbers', 'Literals', 'Strings', 'Mixed', 'Optional', 'NumArrayMaybe', 'StringArrayMaybe', 'NumBoxMaybe']), { rounds: 3, cold: true });
});
test('unconstrained generic values preserve strict null and object rules', () => {
  const source = 'type Box = <T>(x: T) => { value: T }; type EmptyBox = <T>(x: T) => { value: {} }; type ObjectBox = <T extends object>(x: T) => { value: {} }; type UnknownBox = <T>(x: T) => { value: unknown }; type ObjectValue = <T extends object>(x: T) => { value: T };';
  runCase(source, matrix(['Box', 'EmptyBox', 'ObjectBox', 'UnknownBox', 'ObjectValue']));
  runCase(source, matrix(['Box', 'EmptyBox', 'ObjectBox', 'UnknownBox', 'ObjectValue']), { strictNullChecks: false });
});
test('native substituted nullable unions preserve unknown-like semantics', () => {
  const source = 'interface Maybe<T> { value: T | null | undefined } type Empty = {}; type UnknownBox = { value: unknown }; type EmptyBox = Maybe<Empty>; type NumberBox = Maybe<number>; type NumberValue = { value: number };';
  runCase(source, matrix(['Empty', 'UnknownBox', 'EmptyBox', 'NumberBox', 'NumberValue']));
});
test('generic getters and dependent keyof constraints agree with tsgo', () => {
  const source = `type Getter = <T, K extends keyof T>(x: T, k: K) => T[K];
    type OtherGetter = <U, P extends keyof U>(x: U, k: P) => U[P];
    type Constrained = <T extends { value: number }, K extends keyof T>(x: T, k: K) => T[K];
    type Default = <T = { value: number }, K extends keyof T = keyof T>(x: T, k: K) => T[K];
    type NumberGetter = (x: { value: number }, k: "value") => number;
    type LiteralGetter = (x: { value: 1 }, k: "value") => 1;
    type StringGetter = (x: { value: string }, k: "value") => string;
    type WrongGetter = (x: { value: number }, k: "value") => string;
    type UnionGetter = (x: { a: number; b: string }, k: "a" | "b") => number | string;
    type NarrowGetter = (x: { a: number; b: string }, k: "a" | "b") => number;
    type OptionalGetter = (x: { value?: number }, k: "value") => number | undefined;
    type OptionalWrong = (x: { value?: number }, k: "value") => number;
    type KeyGetter = <T>(x: T) => keyof T;
    type NumberKey = (x: { value: number }) => "value";
    type WrongKey = (x: { value: number }) => "missing";`;
  const queries = matrix(['Getter', 'OtherGetter', 'Constrained', 'Default', 'NumberGetter', 'LiteralGetter', 'StringGetter', 'WrongGetter', 'UnionGetter', 'NarrowGetter', 'OptionalGetter', 'OptionalWrong', 'KeyGetter', 'NumberKey', 'WrongKey']);
  runCase(source, queries);
  runCase(source, [...queries].reverse(), { exactOptionalPropertyTypes: true, rounds: 3, cold: true });
});
test('native keyof and indexed-access substitutions preserve union and intersection keys', () => {
  const source = `interface View<T> { key: keyof T; value: T[keyof T] }
    type A = { a: number; common: boolean }; type B = { b: string; common: boolean };
    type UnionView = View<A | B>; type IntersectionView = View<A & B>;
    type AView = View<A>; type BView = View<B>; type EmptyView = View<{}>;
    type AnyView = View<any>; type UnknownView = View<unknown>; type NeverView = View<never>;
    type UnionPlain = { key: "common"; value: boolean };
    type IntersectionPlain = { key: "a" | "b" | "common"; value: number | string | boolean };
    type APlain = { key: "a" | "common"; value: number | boolean };
    type EmptyPlain = { key: never; value: never };
    type AnyPlain = { key: string | number | symbol; value: any };
    type NeverPlain = { key: string | number | symbol; value: never };`;
  runCase(source, matrix(['UnionView', 'IntersectionView', 'AView', 'BView', 'EmptyView', 'AnyView', 'UnknownView', 'NeverView', 'UnionPlain', 'IntersectionPlain', 'APlain', 'EmptyPlain', 'AnyPlain', 'NeverPlain']), { rounds: 3, cold: true });
});
test('keyof inference and nested indexed accesses agree with tsgo', () => {
  const source = `type KeySink = <T>(key: keyof T) => T;
    type Keys = <T>(key: keyof T) => keyof T;
    type Literal = (key: "value") => { value: any };
    type LiteralKeys = (key: "value") => "value";
    type TwoKeys = (key: "a" | "b") => "a" | "b";
    type BroadKeys = (key: string) => string | number;
    interface Box<T> { value: T }
    type Unbox = <T>(x: Box<T>) => Box<T>["value"];
    type NumberUnbox = (x: Box<number>) => number;
    type StringUnbox = (x: Box<string>) => string;
    type WrongUnbox = (x: Box<number>) => string;
    type Element = <T>(x: T[]) => T[][number];
    type NumberElement = (x: number[]) => number;
    type WrongElement = (x: number[]) => string;
    type Nested = <T extends { inner: { value: unknown } }>(x: T) => T["inner"]["value"];
    type NestedNumber = (x: { inner: { value: number } }) => number;
    type NestedWrong = (x: { inner: { value: number } }) => string;`;
  runCase(source, matrix(['KeySink', 'Keys', 'Literal', 'LiteralKeys', 'TwoKeys', 'BroadKeys', 'Unbox', 'NumberUnbox', 'StringUnbox', 'WrongUnbox', 'Element', 'NumberElement', 'WrongElement', 'Nested', 'NestedNumber', 'NestedWrong']), { rounds: 3, cold: true });
});
test('numeric, quoted numeric, symbol, and private keys retain native identity', () => {
  const source = `declare const s: unique symbol; declare const other: unique symbol;
    interface View<T> { key: keyof T; value: T[keyof T] }
    interface Read<T, K extends keyof T> { value: T[K] }
    type Numeric = View<{ 0: number; "1": string }>;
    type NumericPlain = { key: 0 | "1"; value: number | string };
    type Symbolic = View<{ [s]: number; [other]: string }>;
    type SymbolPlain = { key: typeof s | typeof other; value: number | string };
    type SymbolRead = Read<{ [s]: number; [other]: string }, typeof s>;
    type NumberRead = Read<{ 0: number; "1": string }, "0">;
    type SymbolIndex = View<{ [k: symbol]: number }>;
    type SymbolIndexPlain = { key: symbol; value: number };
    type StringIndex = View<{ [k: string]: number }>;
    type StringIndexPlain = { key: string | number; value: number };
    type NumberIndex = View<{ [k: number]: number }>;
    type NumberIndexPlain = { key: number; value: number };
    class Hidden { private secret: string = ""; public value: number = 0 }
    type PublicView = View<Hidden>; type PublicPlain = { key: "value"; value: number };
    type NumberBox = { value: number }; type StringBox = { value: string };`;
  runCase(source, matrix(['Numeric', 'NumericPlain', 'Symbolic', 'SymbolPlain', 'SymbolRead', 'NumberRead', 'SymbolIndex', 'SymbolIndexPlain', 'StringIndex', 'StringIndexPlain', 'NumberIndex', 'NumberIndexPlain', 'PublicView', 'PublicPlain', 'NumberBox', 'StringBox']), { rounds: 3, cold: true });
  runCase('class Hidden { protected hidden: string = ""; value: number = 0 } interface View<T> { key: keyof T; value: T[keyof T] } type Public = View<Hidden>; type Plain = { key: "value"; value: number };', [{ source: 'Public', target: 'Plain' }, { source: 'Plain', target: 'Public' }]);
});
test('native generic-reference variance and explicit annotations agree with tsgo', () => {
  const source = `interface Producer<T> { value: T } interface Consumer<T> { use: (x: T) => void }
    interface Method<T> { use(x: T): void } interface Cell<T> { value: T; use: (x: T) => void }
    interface Phantom<T> { name: string } interface Invariant<in out T> { value: T }
    interface Out<out T> { value: T } interface In<in T> { use: (x: T) => void }
    interface Returns<T> { make(): T } interface Cycle<T> { value: T; next?: Cycle<T> }
    type PNum = Producer<number>; type POne = Producer<1>;
    type CNum = Consumer<number>; type COne = Consumer<1>;
    type MNum = Method<number>; type MOne = Method<1>;
    type CellNum = Cell<number>; type CellOne = Cell<1>;
    type PhantomNum = Phantom<number>; type PhantomStr = Phantom<string>;
    type InvNum = Invariant<number>; type InvOne = Invariant<1>;
    type OutNum = Out<number>; type OutOne = Out<1>;
    type InNum = In<number>; type InOne = In<1>;
    type ReturnNum = Returns<number>; type ReturnVoid = Returns<void>;
    type CycleNum = Cycle<number>; type CycleOne = Cycle<1>;`;
  const queries = matrix(['PNum', 'POne', 'CNum', 'COne', 'MNum', 'MOne', 'CellNum', 'CellOne', 'PhantomNum', 'PhantomStr', 'InvNum', 'InvOne', 'OutNum', 'OutOne', 'InNum', 'InOne', 'ReturnNum', 'ReturnVoid', 'CycleNum', 'CycleOne']);
  runCase(source, queries);
  runCase(source, [...queries].reverse(), { strictFunctionTypes: false, rounds: 3, cold: true });
});
test('string and symbol index signatures check their applicable properties', () => {
  const source = `declare const s: unique symbol; declare const other: unique symbol;
    type SymbolNumber = { [s]: number }; type SymbolString = { [s]: string }; type OtherSymbol = { [other]: number };
    type Mixed = { [s]: string; value: number }; type BadMixed = { [s]: number; value: string };
    type SymbolIndex = { [key: symbol]: number }; type StringIndex = { [key: string]: number };
    type Both = { [key: symbol]: number; [key: string]: number };
    type S = typeof s; type Other = typeof other; type BroadSymbol = symbol;`;
  runCase(source, matrix(['SymbolNumber', 'SymbolString', 'OtherSymbol', 'Mixed', 'BadMixed', 'SymbolIndex', 'StringIndex', 'Both', 'S', 'Other', 'BroadSymbol']));
});
test('optional and lone-surrogate keys survive indexed-access substitution', () => {
  const source = 'interface Read<T, K extends keyof T> { value: T[K] } interface Keys<T> { key: keyof T } type Optional = Read<{ value?: number }, "value">; type Both = Read<{ a: number; b: string }, "a" | "b">; type High = Read<{ "\\ud800": number; "\\ud801": string }, "\\ud800">; type Low = Read<{ "\\udc00": string }, "\\udc00">; type KeyHigh = Keys<{ "\\ud800": number }>; type KeyOther = Keys<{ "\\ud801": number }>; type HighPlain = { key: "\\ud800" }; type NumberBox = { value: number }; type MaybeNumber = { value: number | undefined }; type StringBox = { value: string }; type MixedBox = { value: number | string };';
  const queries = matrix(['Optional', 'Both', 'High', 'Low', 'KeyHigh', 'KeyOther', 'HighPlain', 'NumberBox', 'MaybeNumber', 'StringBox', 'MixedBox']);
  runCase(source, queries);
  runCase(source, queries, { exactOptionalPropertyTypes: true });
  runCase(source, queries, { strictNullChecks: false });
});
test('native access to array, tuple, and primitive members agrees with tsgo', () => {
  const source = `interface Read<T, K extends keyof T> { value: T[K] }
    interface Keys<T> { key: keyof T }
    type ArrayElement = Read<number[], number>; type QuotedElement = Read<number[], "0">;
    type TupleElement = Read<[number, string], 0>; type TupleSecond = Read<[number, string], "1">;
    type TupleAll = Read<[number, string], number>; type TupleLength = Read<[number, string], "length">;
    type OptionalTuple = Read<[number?], "0">; type RestTuple = Read<[number, ...string[]], "2">;
    type StringLength = Read<string, "length">; type ArrayLength = Read<string[], "length">;
    type StringKeys = Keys<string>; type StringKeysPlain = { key: keyof string };
    type TupleKeys = Keys<[number, string]>; type TupleKeysPlain = { key: keyof [number, string] };
    type NumberBox = { value: number }; type StringBox = { value: string };
    type MixedBox = { value: number | string }; type TwoBox = { value: 2 };
    type MaybeBox = { value: number | undefined };`;
  runCase(source, matrix(['ArrayElement', 'QuotedElement', 'TupleElement', 'TupleSecond', 'TupleAll', 'TupleLength', 'OptionalTuple', 'RestTuple', 'StringLength', 'ArrayLength', 'StringKeys', 'StringKeysPlain', 'TupleKeys', 'TupleKeysPlain', 'NumberBox', 'StringBox', 'MixedBox', 'TwoBox', 'MaybeBox']), { rounds: 3, cold: true });
});
test('native never and any indexes select applicable signatures like tsgo', () => {
  const source = `interface Read<T, K extends keyof T> { value: T[K] }
    type NumberNever = Read<{ [k: number]: number }, never>;
    type SymbolNever = Read<{ [k: symbol]: string }, never>;
    type StringNever = Read<{ [k: string]: boolean }, never>;
    type BothNever = Read<{ [k: number]: number; [k: symbol]: string }, never>;
    type BothAny = Read<{ [k: number]: number; [k: symbol]: string }, any>;
    type LiteralNever = Read<{ [k: number]: 1; [k: symbol]: 2 }, never>;
    type NumberAny = Read<{ [k: number]: number }, any>;
    type StringAny = Read<{ [k: string]: string }, any>;
    type EmptyNever = Read<{}, never>; type EmptyAny = Read<{}, any>;
    type NumberBox = { value: number }; type StringBox = { value: string };
    type BooleanBox = { value: boolean }; type NeverBox = { value: never }; type AnyBox = { value: any };`;
  runCase(source, matrix(['NumberNever', 'SymbolNever', 'StringNever', 'BothNever', 'BothAny', 'LiteralNever', 'NumberAny', 'StringAny', 'EmptyNever', 'EmptyAny', 'NumberBox', 'StringBox', 'BooleanBox', 'NeverBox', 'AnyBox']));
});
test('generic union and intersection keyof operations agree with tsgo', () => {
  const source = `type Base = <T>(x: T) => keyof T;
    type Union = <T>(x: T) => keyof (T | { value: number });
    type Intersection = <T>(x: T) => keyof (T & { value: number });
    type Constrained = <T extends { value: number }>(x: T) => keyof T;
    type Optional = <T extends { value?: number }>(x: T) => keyof T;
    type Number = (x: { value: number }) => "value";
    type Other = (x: { other: string }) => "other";
    type Both = (x: { value: number; other: string }) => "value" | "other";
    type ValueOther = (x: { other: string }) => "value" | "other";
    type Empty = (x: {}) => never;`;
  runCase(source, matrix(['Base', 'Union', 'Intersection', 'Constrained', 'Optional', 'Number', 'Other', 'Both', 'ValueOther', 'Empty']), { rounds: 3, cold: true });
});
test('native substituted intersections merge members and reduce disjoint primitives', () => {
  const source = `interface Merge<T, U> { result: T & U }
    type Both = Merge<{ a: number }, { b: string }>;
    type Plain = { result: { a: number; b: string } };
    type AOnly = { result: { a: number } }; type BOnly = { result: { b: string } };
    type Overlap = Merge<{ value: number }, { value: 1 }>;
    type OverlapPlain = { result: { value: 1 } };
    type Disjoint = Merge<number, string>; type DisjointPlain = { result: never };
    type Callable = Merge<(x: number) => number, (x: string) => string>;
    type CallsPlain = { result: { (x: number): number; (x: string): string } };`;
  const queries = matrix(['Both', 'Plain', 'AOnly', 'BOnly', 'Overlap', 'OverlapPlain', 'Disjoint', 'DisjointPlain', 'Callable', 'CallsPlain']);
  runCase(source, queries);
  runCase(source, [...queries].reverse(), { rounds: 3, cold: true });
});
test('native mapped members preserve modifiers, Pick, Record, and key remapping', () => {
  const source = `interface Wrap<T> { value: T }
    interface Transform<T> { value: { [P in keyof T]: T[P] } }
    interface Part<T> { value: Partial<T> }
    interface Req<T> { value: Required<T> }
    interface Read<T> { value: Readonly<T> }
    interface Mutable<T> { value: { -readonly [P in keyof T]: T[P] } }
    interface SelectFields<T, K extends keyof T> { value: Pick<T, K> }
    interface Dictionary<K extends PropertyKey, V> { value: Record<K, V> }
    interface Rename<T> { value: { [P in keyof T as "same"]: T[P] } }
    interface Drop<T> { value: { [P in keyof T as never]: T[P] } }
    type Input = { readonly a?: number; b: string; c?: boolean | undefined };
    type Copy = Transform<Input>; type PartialInput = Part<Input>; type RequiredInput = Req<Input>;
    type ReadonlyInput = Read<Input>; type MutableInput = Mutable<Input>; type PickInput = SelectFields<Input, "a" | "c">;
    type RecordInput = Dictionary<"a" | "b", number>; type Renamed = Rename<Input>; type Dropped = Drop<Input>;
    type Plain = Wrap<Input>; type OptionalPlain = Wrap<{ a?: number; b?: string; c?: boolean | undefined }>;
    type RequiredPlain = Wrap<{ a: number; b: string; c: boolean | undefined }>;
    type RequiredNoUndefined = Wrap<{ a: number; b: string; c: boolean }>;
    type PickPlain = Wrap<{ a?: number; c?: boolean | undefined }>;
    type RecordPlain = Wrap<{ a: number; b: number }>;
    type RenamePlain = Wrap<{ same?: number | string | boolean | undefined }>;
    type Empty = Wrap<{}>;`;
  const queries = matrix(['Copy', 'PartialInput', 'RequiredInput', 'ReadonlyInput', 'MutableInput', 'PickInput', 'RecordInput', 'Renamed', 'Dropped', 'Plain', 'OptionalPlain', 'RequiredPlain', 'RequiredNoUndefined', 'PickPlain', 'RecordPlain', 'RenamePlain', 'Empty']);
  runCase(source, queries);
  runCase(source, [...queries].reverse(), { exactOptionalPropertyTypes: true, rounds: 3, cold: true });
  runCase(source, queries, { strictNullChecks: false });
});
test('native homomorphic mappings preserve primitives, unions, arrays, and tuples', () => {
  const source = `interface Wrap<T> { value: T }
    interface Copy<T> { value: { [P in keyof T]: T[P] } }
    interface Part<T> { value: Partial<T> }
    interface Req<T> { value: Required<T> }
    interface Read<T> { value: Readonly<T> }
    interface Mutable<T> { value: { -readonly [P in keyof T]: T[P] } }
    type Num = Copy<number>; type Text = Copy<string>; type Nullable = Copy<{ a: number } | null | undefined>;
    type Union = Copy<{ a: number } | { b: string }>;
    type Arr = Copy<number[]>; type RoArr = Read<number[]>; type MutArr = Mutable<readonly number[]>;
    type PartialArr = Part<number[]>; type Pair = Copy<[number, string]>;
    type RoPair = Read<[number, string]>; type PartialPair = Part<[number, string]>;
    type RequiredPair = Req<[number?, string?]>; type Rest = Copy<[number, ...string[], boolean]>;
    type PartialRest = Part<[number, ...string[], boolean]>;
    type PlainNum = Wrap<number>; type PlainText = Wrap<string>; type PlainNull = Wrap<{ a: number } | null | undefined>;
    type PlainUnion = Wrap<{ a: number } | { b: string }>; type PlainArr = Wrap<number[]>;
    type PlainRoArr = Wrap<readonly number[]>; type PlainPartialArr = Wrap<(number | undefined)[]>;
    type PlainPair = Wrap<[number, string]>; type PlainRoPair = Wrap<readonly [number, string]>;
    type PlainPartialPair = Wrap<[number?, string?]>; type PlainRest = Wrap<[number, ...string[], boolean]>;
    type OptionalSlots = Wrap<{ 0?: number; 1?: string; length: 0 | 1 | 2 }>;
    type TupleMethods = Wrap<{ pop(): number | string | undefined; slice(): (number | string | undefined)[] }>;
    type RoTupleMethods = Wrap<{ slice(): (number | string | undefined)[] }>;`;
  const queries = matrix(['Num', 'Text', 'Nullable', 'Union', 'Arr', 'RoArr', 'MutArr', 'PartialArr', 'Pair', 'RoPair', 'PartialPair', 'RequiredPair', 'Rest', 'PartialRest', 'PlainNum', 'PlainText', 'PlainNull', 'PlainUnion', 'PlainArr', 'PlainRoArr', 'PlainPartialArr', 'PlainPair', 'PlainRoPair', 'PlainPartialPair', 'PlainRest', 'OptionalSlots', 'TupleMethods', 'RoTupleMethods']);
  runCase(source, queries);
  runCase(source, queries, { exactOptionalPropertyTypes: true, rounds: 3, cold: true });
});
test('generic mapped signatures and reverse inference agree with tsgo', () => {
  const source = `type Clone = <T>(x: T) => { [P in keyof T]: T[P] };
    type OtherClone = <U>(x: U) => { [Q in keyof U]: U[Q] };
    type Identity = <T>(x: T) => T;
    type PartialOut = <T>(x: T) => Partial<T>;
    type RequiredOut = <T>(x: T) => Required<T>;
    type ReadOut = <T>(x: T) => Readonly<T>;
    type Reverse = <T>(x: { [P in keyof T]: { value: T[P] } }) => T;
    type PartialReverse = <T>(x: { [P in keyof T]?: { value: T[P] } }) => T;
    type PickReverse = <T, K extends keyof T>(x: { [P in K]: { value: T[P] } }) => T;
    type RecordReverse = <K extends PropertyKey, V>(x: Record<K, V>) => V;
    type Fixed = (x: { a: number; b: string }) => { a: number; b: string };
    type Optional = (x: { a: number; b: string }) => { a?: number; b?: string };
    type OptionalInput = (x: { a?: number }) => { a: number };
    type Boxed = (x: { a: { value: number }; b: { value: string } }) => { a: number; b: string };
    type WrongBoxed = (x: { a: { value: number }; b: { value: string } }) => { a: string; b: number };
    type ArrayBoxed = (x: { value: number }[]) => number[];
    type TupleBoxed = (x: [{ value: number }, { value: string }]) => [number, string];
    type OptionalBoxed = (x: { a?: { value: number } }) => { a: number };
    type FixedRecord = (x: { a: number; b: number }) => number;
    type WrongRecord = (x: { a: number; b: number }) => string;`;
  const queries = [...matrix(['Clone', 'OtherClone', 'Identity', 'PartialOut', 'RequiredOut', 'ReadOut', 'Reverse', 'PartialReverse', 'PickReverse', 'Fixed', 'Optional', 'OptionalInput', 'Boxed', 'WrongBoxed', 'ArrayBoxed', 'TupleBoxed', 'OptionalBoxed', 'FixedRecord', 'WrongRecord']), ...matrix(['RecordReverse', 'FixedRecord', 'WrongRecord', 'Fixed', 'Boxed'])];
  runCase(source, queries);
  runCase(source, [...queries].reverse(), { exactOptionalPropertyTypes: true, rounds: 3, cold: true });
});
test('mapped key identity, collision templates, indexes, and keyof agree with tsgo', () => {
  const source = `declare const mark: unique symbol;
    interface Wrap<T> { value: T }
    interface Copy<T> { value: { [P in keyof T as P]: T[P] } }
    interface Collision<T> { value: { [P in keyof T as "same"]: [P, T[P]] } }
    interface Dict<K extends PropertyKey, V> { value: { [P in K]: V } }
    interface View<T> { key: keyof { [P in keyof T]: T[P] }; value: { [P in keyof T]: T[P] }[keyof T] }
    type Input = { 1: number; "2": string; "1e3": boolean; "\\uD800": number; [mark]?: boolean };
    type Native = Copy<Input>; type Plain = Wrap<Input>; type Wrong = Wrap<{ "\\uD801": number }>;
    type Numeric = Dict<number, number>; type Text = Dict<string, number>; type Symbolic = Dict<typeof mark, boolean>;
    type NumericPlain = Wrap<{ [n: number]: number }>; type TextPlain = Wrap<{ [s: string]: number }>;
    type SymbolPlain = Wrap<{ [mark]: boolean }>;
    type Collided = Collision<{ a: number; b: string }>;
    type CollidedPlain = Wrap<{ same: ["a" | "b", number | string] }>;
    type Distributed = Wrap<{ same: ["a", number] | ["b", string] }>;
    type Keys = View<{ a: number; b?: string }>;
    type KeysPlain = { key: "a" | "b"; value: number | string | undefined };`;
  const queries = matrix(['Native', 'Plain', 'Wrong', 'Numeric', 'Text', 'Symbolic', 'NumericPlain', 'TextPlain', 'SymbolPlain', 'Collided', 'CollidedPlain', 'Distributed', 'Keys', 'KeysPlain']);
  runCase(source, queries);
  runCase(source, [...queries].reverse(), { exactOptionalPropertyTypes: true, rounds: 3, cold: true });
});
test('recursive mapped templates and nested reverse inference remain finite', () => {
  const source = `type Deep<T> = { [P in keyof T]: Deep<T[P]> };
    interface Transform<T> { value: Deep<T> }
    interface Link<T> { value: T; next?: Link<T> }
    type Native = Transform<Link<number>>; type Literal = Transform<Link<1>>;
    type Wrong = Transform<Link<string>>;
    type Plain = { value: Link<number> }; type PlainLiteral = { value: Link<1> };
    type Nested = <T>(x: { [P in keyof T]: { inner: { [Q in keyof T[P]]: { value: T[P][Q] } } } }) => T;
    type NestedFixed = (x: { a: { inner: { b: { value: number } } } }) => { a: { b: number } };
    type NestedWrong = (x: { a: { inner: { b: { value: number } } } }) => { a: { b: string } };
    type Callback = <T>(x: { [P in keyof T]: (value: T[P]) => T[P] }) => T;
    type CallbackFixed = (x: { a: (value: number) => number }) => { a: number };
    type CallbackWrong = (x: { a: (value: number) => number }) => { a: string };`;
  const queries = [...matrix(['Native', 'Literal', 'Wrong', 'Plain', 'PlainLiteral']), ...matrix(['Nested', 'NestedFixed', 'NestedWrong', 'Callback', 'CallbackFixed', 'CallbackWrong'])];
  const graph = runCase(source, queries, { rounds: 3, cold: true });
  assert.ok(graph.types.length < 5000, 'Recursive mapped export should retain finite declaration templates');
});
test('symbolic mapped access and constrained array mappings agree with tsgo', () => {
  const source = `type Getter = <T, K extends keyof T>(x: T, k: K) => T[K];
    type ReadGetter = <T, K extends keyof T>(x: Readonly<T>, k: K) => Readonly<T>[K];
    type CopyGetter = <T, K extends keyof T>(x: { [P in keyof T]: T[P] }, k: K) => { [P in keyof T]: T[P] }[K];
    type ArrayCopy = <T extends number[]>(x: T) => { [P in keyof T]: T[P] };
    type ArrayRead = <T extends number[]>(x: T) => Readonly<T>;
    type ArrayFixed = (x: number[]) => number[];
    type ArrayReadonly = (x: number[]) => readonly number[];
    type ArrayWrong = (x: number[]) => string[];
    type Fixed = (x: { a: number }, k: "a") => number;
    type Wrong = (x: { a: number }, k: "a") => string;
    type Key = <T>(x: T) => keyof T;
    type MappedKey = <T>(x: T) => keyof { [P in keyof T as P]: T[P] };
    type KeyFixed = (x: { a: number }) => "a";
    type KeyWrong = (x: { a: number }) => "b";`;
  const queries = [...matrix(['Getter', 'ReadGetter', 'CopyGetter', 'Fixed', 'Wrong']), ...matrix(['ArrayCopy', 'ArrayRead', 'ArrayFixed', 'ArrayReadonly', 'ArrayWrong']), ...matrix(['Key', 'MappedKey', 'KeyFixed', 'KeyWrong'])];
  runCase(source, queries);
  runCase(source, [...queries].reverse(), { rounds: 3, cold: true });
});
test('numeric-string patterns used by mapped array constraints agree with tsgo', () => {
  runCase('type Pattern = `${number}`; type Decimal = "42"; type Exponent = "1e3"; type Hex = "0x10"; type Padded = " 1 "; type Empty = ""; type Infinity = "Infinity"; type NaN = "NaN"; type Text = "hello"; type Str = string;', matrix(['Pattern', 'Decimal', 'Exponent', 'Hex', 'Padded', 'Empty', 'Infinity', 'NaN', 'Text', 'Str']));
});
test('conditional branches distribute and instantiate inside native signatures and references', () => {
  const source = `
    type Choose = <T>(x: T) => T extends number ? string : boolean;
    type Wrapped = <T>(x: T) => [T] extends [number] ? string : boolean;
    type NumberChoice = (x: number) => string;
    type StringChoice = (x: string) => boolean;
    type UnionChoice = (x: number | string) => string | boolean;
    type WrappedUnion = (x: number | string) => boolean;
    type AnyChoice = (x: any) => string | boolean;
    type UnknownChoice = (x: unknown) => boolean;
    type NeverChoice = (x: never) => never;
    type NeverWrapped = (x: never) => string;
    type Wrong = (x: number) => boolean;
    interface View<T> { value: T extends number ? { number: T } : { other: T } }
    type NativeNumber = View<1>;
    type PlainNumber = { value: { number: 1 } };
    type NativeUnion = View<1 | "a">;
    type PlainUnion = { value: { number: 1 } | { other: "a" } };
    type WrongUnion = { value: { number: 1 } };
  `;
  const names = ['Choose', 'Wrapped', 'NumberChoice', 'StringChoice', 'UnionChoice', 'WrappedUnion', 'AnyChoice', 'UnknownChoice', 'NeverChoice', 'NeverWrapped', 'Wrong', 'NativeNumber', 'PlainNumber', 'NativeUnion', 'PlainUnion', 'WrongUnion'];
  const graph = runCase(source, matrix(names));
  assert.equal(graph.schema, 'tsts.type-graph.v11');
  const root = graph.types.find(t => t.conditionalCheck >= 0 && t.conditionalDistributive);
  assert.ok(root && root.conditionalTrue >= 0 && root.conditionalFalse >= 0);
  runCase(source, matrix(names).reverse(), { rounds: 3, cold: true });
});
test('conditional infer positions extract arrays, properties, and signature variance', () => {
  const source = `
    type Element = <T>(x: T) => T extends readonly (infer U)[] ? U : never;
    type Return = <T>(x: T) => T extends (...args: any[]) => infer U ? U : never;
    type Argument = <T>(x: T) => T extends (x: infer U) => any ? U : never;
    type Pair = <T>(x: T) => T extends { a: infer U; b: infer U } ? U : never;
    type Contra = <T>(x: T) => T extends { a: (x: infer U) => void; b: (x: infer U) => void } ? U : never;
    type Bound = <T>(x: T) => T extends readonly (infer U extends number)[] ? U : false;
    type ArrayNumber = (x: number[]) => number;
    type ArrayReadonly = (x: readonly (1 | 2)[]) => 1 | 2;
    type ArrayString = (x: string[]) => string;
    type ArrayFalse = (x: string[]) => false;
    type ReturnNumber = (x: (x: string) => number) => number;
    type ArgumentString = (x: (x: string) => number) => string;
    type PairUnion = (x: { a: number; b: string }) => number | string;
    type ContraNever = (x: { a: (x: number) => void; b: (x: string) => void }) => never;
    type Wrong = (x: number[]) => string;
    interface View<T> { value: T extends { nested: { item: infer U } } ? U[] : never }
    type Native = View<{ nested: { item: number } }>;
    type Plain = { value: number[] };
  `;
  const names = ['Element', 'Return', 'Argument', 'Pair', 'Contra', 'Bound', 'ArrayNumber', 'ArrayReadonly', 'ArrayString', 'ArrayFalse', 'ReturnNumber', 'ArgumentString', 'PairUnion', 'ContraNever', 'Wrong', 'Native', 'Plain'];
  runCase(source, matrix(names));
  runCase(source, matrix(names).reverse(), { rounds: 3, cold: true, strictFunctionTypes: false });
});
test('conditional filters, nested evaluation, and mapped templates agree with tsgo', () => {
  const source = `
    type Include = <T>(x: T) => Extract<T, number>;
    type ExcludeNumber = <T>(x: T) => Exclude<T, number>;
    type Nested = <T>(x: T) => T extends number ? T extends 1 ? "one" : "number" : "other";
    type Flatten<T> = T extends readonly (infer U)[] ? Flatten<U> : T;
    type Flat = <T>(x: T) => Flatten<T>;
    type NumberFilter = (x: number | string) => number;
    type StringFilter = (x: number | string) => string;
    type One = (x: 1) => "one";
    type Number = (x: number) => "number";
    type Other = (x: string) => "other";
    type FlatNumber = (x: readonly number[][][]) => number;
    type FlatUnion = (x: (number | string[])[][]) => number | string;
    type Wrong = (x: readonly number[][][]) => string;
    interface Fields<T> { value: { [P in keyof T]: T[P] extends number ? T[P][] : T[P] } }
    type Native = Fields<{ a: number; b: string; c: 1 | "x" }>;
    type Plain = { value: { a: number[]; b: string; c: 1 | "x" } };
    type Filter<T> = { [P in keyof T as T[P] extends number ? P : never]: T[P] };
    interface Keys<T> { value: Filter<T> }
    type NativeKeys = Keys<{ a: number; b: string }>;
    type PlainKeys = { value: { a: number } };
  `;
  const names = ['Include', 'ExcludeNumber', 'Nested', 'Flat', 'NumberFilter', 'StringFilter', 'One', 'Number', 'Other', 'FlatNumber', 'FlatUnion', 'Wrong', 'Native', 'Plain', 'NativeKeys', 'PlainKeys'];
  runCase(source, matrix(names));
  runCase(source, matrix(names).reverse(), { rounds: 3, cold: true });
});
test('deferred conditional relations, constraints, and any branches agree with tsgo', () => {
  const source = `
    type Choice = <T>(x: T) => T extends number ? string : boolean;
    type Same = <U>(x: U) => U extends number ? string : boolean;
    type Wider = <T>(x: T) => T extends number ? string | boolean : boolean;
    type Changed = <T>(x: T) => T extends string ? string : boolean;
    type Constant = <T>(x: T) => string;
    type Both = <T>(x: T) => string | boolean;
    type AnyBranch = <T>(x: T) => T extends number ? any : string;
    type AnyFalse = <T>(x: T) => T extends number ? string : any;
    type NeverBranch = <T>(x: T) => T extends number ? never : string;
    type Filter = <T extends number | string>(x: T) => T extends number ? T : never;
    type FilterNumber = <T extends number | string>(x: T) => number;
    type Exclusion = <T extends number | string>(x: T) => T extends number ? never : T;
    type FilterString = <T extends number | string>(x: T) => string;
    type Constrained = <T extends { value: any }>(x: T) => T extends { value: string } ? string : number;
    type ObjectString = (x: { value: string }) => string;
    type ObjectNumber = (x: { value: number }) => number;
    type ObjectBoth = <T extends { value: any }>(x: T) => string | number;
    type Independent = <T>(x: T) => T extends number ? { common: number; a: string } : { common: number; b: boolean };
    type Common = <T>(x: T) => { common: number };
    type Intersection = <T>(x: T) => { common: number; a: string; b: boolean };
  `;
  const names = ['Choice', 'Same', 'Wider', 'Changed', 'Constant', 'Both', 'AnyBranch', 'AnyFalse', 'NeverBranch', 'Filter', 'FilterNumber', 'Exclusion', 'FilterString', 'Constrained', 'ObjectString', 'ObjectNumber', 'ObjectBoth', 'Independent', 'Common', 'Intersection'];
  runCase(source, matrix(names));
  runCase(source, matrix(names).reverse(), { rounds: 3, cold: true });
});
test('native conditional instantiations cover any, unknown, never, and multiple infer candidates', () => {
  const definitions = {
    Distribute: 'T extends number ? T[] : T',
    Wrapped: '[T] extends [number] ? T[] : T',
    Extract: 'Extract<T, number>',
    Exclude: 'Exclude<T, number>',
    Element: 'T extends readonly (infer U)[] ? U : false',
    Tuple: 'T extends [infer U, infer V] ? [U, V] : false',
    WrappedInfer: '[T] extends [infer U] ? U : false',
    InferBound: 'T extends { a: infer U extends number; b: infer U extends number } ? U : false',
  };
  const inputs = ['any', 'unknown', 'never', 'number', 'string', '1 | "a"', 'number[]', 'readonly [1, 2]', '[number, string]', '{ a: 1; b: 2 }', '{ a: number; b: string }'];
  for (const [name, definition] of Object.entries(definitions)) {
    let source = `interface Conditional${name}<T> { value: ${definition} } type ConditionalAlias<T> = ${definition};\n`;
    const queries = [];
    for (let i = 0; i < inputs.length; i++) {
      const native = `${name}Native${i}`;
      const plain = `${name}Plain${i}`;
      source += `type ${native} = Conditional${name}<${inputs[i]}>;\n`;
      // Plain distributive conditionals must resolve through the same alias,
      // since replacing a naked T with a union disables distribution.
      source += `type ${plain}Resolved = { value: ConditionalAlias<${inputs[i]}> };\n`;
      queries.push({ source: native, target: `${plain}Resolved` }, { source: `${plain}Resolved`, target: native });
    }
    runCase(source, queries);
    runCase(source, queries.reverse(), { rounds: 3, cold: true });
  }
});
test('reverse mapped inference follows conditional branch templates', () => {
  const source = `
    type Reverse = <T>(x: { [P in keyof T]: T[P] extends number ? { value: T[P] } : { other: T[P] } }) => T;
    type NumberReverse = (x: { a: { value: number } }) => { a: number };
    type StringReverse = (x: { a: { other: string } }) => { a: string };
    type MixedReverse = (x: { a: { value: number }; b: { other: string } }) => { a: number; b: string };
    type WrongReturn = (x: { a: { value: number } }) => { a: string };
    type WrongBranch = (x: { a: { other: number } }) => { a: number };
    type AnyReverse = (x: { a: { value: any } | { other: any } }) => { a: any };
  `;
  const names = ['Reverse', 'NumberReverse', 'StringReverse', 'MixedReverse', 'WrongReturn', 'WrongBranch', 'AnyReverse'];
  runCase(source, matrix(names));
  runCase(source, matrix(names).reverse(), { rounds: 3, cold: true });
});
test('intrinsic string mapping signatures and same-mapping inference agree with tsgo', () => {
  const queries = matrix(stringMappingSignatureNames);
  runCase(stringMappingSignatures, queries);
  runCase(stringMappingSignatures, queries.reverse(), { rounds: 3, cold: true });
});
test('intrinsic string mapping domains preserve nested membership, constraints, and numeric patterns', () => {
  const source = `
    type Up = Uppercase<string>; type Low = Lowercase<string>;
    type Cap = Capitalize<string>; type Uncap = Uncapitalize<string>;
    type UpLow = Uppercase<Lowercase<string>>; type LowUp = Lowercase<Uppercase<string>>;
    type CapLow = Capitalize<Lowercase<string>>; type UncapUp = Uncapitalize<Uppercase<string>>;
    type UpAny = Uppercase<any>; type LowAny = Lowercase<any>;
    type Numeric = Uppercase<\`\${number}\`>; type BigNumeric = Lowercase<\`\${bigint}\`>;
    type Str = string; type Any = any; type Never = never;
    type EmptyText = ""; type Digits = "123"; type Exponent = "1e3";
    type UpperText = "ABC"; type LowerText = "abc"; type CapitalText = "Abc"; type UncapitalText = "aBC";
    type Sharp = "ß"; type Expanded = "SS"; type Dotted = "İ"; type DotLower = "i̇";
    type UpperPattern = \`PRE_\${Uppercase<string>}\`; type RawPattern = \`PRE_\${string}\`;
  `;
  const names = ['Up', 'Low', 'Cap', 'Uncap', 'UpLow', 'LowUp', 'CapLow', 'UncapUp', 'UpAny', 'LowAny', 'Numeric', 'BigNumeric', 'Str', 'Any', 'Never', 'EmptyText', 'Digits', 'Exponent', 'UpperText', 'LowerText', 'CapitalText', 'UncapitalText', 'Sharp', 'Expanded', 'Dotted', 'DotLower', 'UpperPattern', 'RawPattern'];
  runCase(source, matrix(names));
  runCase(source, matrix(names).reverse(), { rounds: 3, cold: true });
});
test('native intrinsic casing matches pinned Unicode tables for every mapped scalar', () => {
  const data = readFileSync('upstream/typescript-go/internal/stringutil/js_case_generated.go', 'utf8');
  const scalars = [...data.matchAll(/(0x[0-9A-F]+):\s*\{lower:/g)].map(match => String.fromCodePoint(Number(match[1])));
  scalars.push('', '\uD800', '\uDC00', '\u{1F600}', '\u1C89', '\uA7CB');
  for (let batch = 0; batch < scalars.length; batch += 128) {
    let source = 'interface CaseView<T extends string> { upper: Uppercase<T>; lower: Lowercase<T>; capital: Capitalize<T>; uncapital: Uncapitalize<T> }\n';
    const queries = [];
    for (let i = batch; i < Math.min(batch + 128, scalars.length); i++) {
      const text = JSON.stringify(scalars[i] + 'Foo');
      source += `type Native${i} = CaseView<${text}>; type Plain${i} = { upper: Uppercase<${text}>; lower: Lowercase<${text}>; capital: Capitalize<${text}>; uncapital: Uncapitalize<${text}> };\n`;
      queries.push({ source: 'Native' + i, target: 'Plain' + i }, { source: 'Plain' + i, target: 'Native' + i });
    }
    runCase(source, queries);
  }
});
test('native lowercase preserves final sigma context, Unicode property boundaries, and lone surrogates', () => {
  const texts = ['Σ', 'ΟΣ', 'ΟΣΑ', 'ΟΣͅ', 'ΟΣͅA', 'AΣ.A', 'AΣ A', 'ʕΣ', 'ʰΣ', 'ͅΣ', 'ªΣ', 'ºΣ', 'ⅠΣ', '\u1C89Σ', '\uA7CBΣ', 'ΣⅠ', 'ΣͅA', '\uD800Σ', 'A\uD800Σ', 'AΣ\uDC00', '\u{10400}Σ', 'A\u{1F3FB}Σ', 'AΣ\u{1F3FB}A'];
  let source = 'interface CaseView<T extends string> { value: Lowercase<T> }\n';
  const queries = [];
  for (let i = 0; i < texts.length; i++) {
    const text = JSON.stringify(texts[i]);
    source += `type Native${i} = CaseView<${text}>; type Plain${i} = { value: Lowercase<${text}> };\n`;
    queries.push({ source: 'Native' + i, target: 'Plain' + i }, { source: 'Plain' + i, target: 'Native' + i });
  }
  runCase(source, queries, { rounds: 4, cold: true });
});
test('native template string mappings transform spans, placeholders, unions, and first captures', () => {
  const source = `
    interface View<T extends string> { up: Uppercase<\`pre_\${T}_end\`>; low: Lowercase<\`PRE_\${T}_END\`>; cap: Capitalize<\`pre_\${T}\`>; first: Capitalize<\`\${T}_End\`>; unfirst: Uncapitalize<\`\${T}_End\`>; sigma: Lowercase<\`ΟΣ\${T}\`> }
    type UnicodeView = View<"ßİ">;
    type UnicodePlain = { up: "PRE_SSİ_END"; low: "pre_ßi̇_end"; cap: "Pre_ßİ"; first: "SSİ_End"; unfirst: "ßİ_End"; sigma: "οςßi̇" };
    type EmptyView = View<"">;
    type EmptyPlain = { up: "PRE__END"; low: "pre__end"; cap: "Pre_"; first: "_End"; unfirst: "_End"; sigma: "ος" };
    type BroadView = View<string>;
    type BroadPlain = { up: \`PRE_\${Uppercase<string>}_END\`; low: \`pre_\${Lowercase<string>}_end\`; cap: \`Pre_\${string}\`; first: \`\${Capitalize<string>}_End\`; unfirst: \`\${Uncapitalize<string>}_End\`; sigma: \`ος\${Lowercase<string>}\` };
    type UnionView = View<"a" | "b">; type UnionPlain = View<"a"> | View<"b">;
  `;
  const names = ['UnicodeView', 'UnicodePlain', 'EmptyView', 'EmptyPlain', 'BroadView', 'BroadPlain', 'UnionView', 'UnionPlain'];
  runCase(source, matrix(names));
  runCase(source, matrix(names).reverse(), { rounds: 3, cold: true });
});
test('native intrinsic key remaps preserve Unicode collisions, broad indexes, and readonly modifiers', () => {
  const source = `
    interface View<T> { value: { [K in keyof T as Uppercase<K & string>]: T[K] }; keys: keyof { [K in keyof T as Uppercase<K & string>]: T[K] } }
    interface LowerView<T> { value: { [K in keyof T as Lowercase<K & string>]: T[K] } }
    interface CapitalView<T> { value: { [K in keyof T as Capitalize<K & string>]: T[K] } }
    interface Clone<T> { value: Readonly<T>; partial: Partial<T>; mutable: { -readonly [K in keyof T]: T[K] } }
    type NativeFinite = View<{ a: number; A: string; "ß": boolean; SS: number; 42: string }>;
    type PlainFinite = { value: { A: number | string; SS: number | boolean }; keys: "A" | "SS" };
    type NativeLower = LowerView<{ İ: number; "i̇": string }>;
    type PlainLower = { value: { "i̇": number | string } };
    type NativeCapital = CapitalView<{ "ßfoo": number; SSfoo: string }>;
    type PlainCapital = { value: { SSfoo: number | string } };
    type NativeBroad = View<Record<string, number>>;
    type PlainBroad = { value: { [K: Uppercase<string>]: number }; keys: Uppercase<string> };
    type NativePattern = View<{ [K: \`pre_\${string}\`]: number }>;
    type PlainPattern = { value: { [K: \`PRE_\${Uppercase<string>}\`]: number }; keys: \`PRE_\${Uppercase<string>}\` };
    type Pattern = { readonly [K: Uppercase<string>]: number };
    type NativeClone = Clone<Pattern>;
    type PlainClone = { value: Pattern; partial: { readonly [K: Uppercase<string>]: number | undefined }; mutable: { [K: Uppercase<string>]: number } };
    type Wrong = { value: { [K: Uppercase<string>]: string }; keys: string };
  `;
  const names = ['NativeFinite', 'PlainFinite', 'NativeLower', 'PlainLower', 'NativeCapital', 'PlainCapital', 'NativeBroad', 'PlainBroad', 'NativePattern', 'PlainPattern', 'NativeClone', 'PlainClone', 'Wrong'];
  runCase(source, matrix(names));
  runCase(source, matrix(names).reverse(), { rounds: 3, cold: true, exactOptionalPropertyTypes: true });
});
test('intrinsic index signatures select casing domains and infer matching property values', () => {
  const source = `
    type UpperIndex = { [K: Uppercase<string>]: number };
    type LowerIndex = { [K: Lowercase<string>]: number };
    type CapitalIndex = { [K: Capitalize<string>]: number };
    type RawIndex = { [K: string]: number };
    type Good = { ABC: number }; type Bad = { ABC: string }; type Miss = { abc: string };
    type Optional = { ABC?: number }; interface Declared { ABC: number }
    type Infer = <T>(x: { [K: Uppercase<string>]: T }) => T;
    type Matching = (x: { ABC: number; XYZ: number; ignored: string }) => number;
    type Mixed = (x: { ABC: number; XYZ: string; ignored: boolean }) => number | string;
    type Indexed = (x: UpperIndex) => number;
    type Wrong = (x: UpperIndex) => string;
    interface View<T, K extends keyof T> { value: T[K]; keys: keyof T }
    type Overlap = { [K: Uppercase<string>]: { up: number }; [K: Lowercase<string>]: { low: string }; [K: string]: unknown };
    type BothRead = View<Overlap, "123">; type BothPlain = { value: { up: number; low: string }; keys: string | number };
    type UpperRead = View<Overlap, "ABC">; type UpperPlain = { value: { up: number }; keys: string | number };
    type LowerRead = View<Overlap, "abc">; type LowerPlain = { value: { low: string }; keys: string | number };
    type FallbackRead = View<Overlap, "Abc">; type FallbackPlain = { value: unknown; keys: string | number };
  `;
  const names = ['UpperIndex', 'LowerIndex', 'CapitalIndex', 'RawIndex', 'Good', 'Bad', 'Miss', 'Optional', 'Declared', 'Infer', 'Matching', 'Mixed', 'Indexed', 'Wrong', 'BothRead', 'BothPlain', 'UpperRead', 'UpperPlain', 'LowerRead', 'LowerPlain', 'FallbackRead', 'FallbackPlain'];
  runCase(source, matrix(names));
  runCase(source, matrix(names).reverse(), { rounds: 3, cold: true });
});
test('conditional infer constraints and identity preserve intrinsic mapping kinds', () => {
  const source = `
    type Parse<S extends string> = S extends \`\${infer U extends Uppercase<string>}\` ? U : never;
    type Parser = <S extends string>(x: S) => Parse<S>;
    type Fixed = (x: "ABC") => "ABC"; type Wrong = (x: "Abc") => "Abc"; type Rejected = (x: "Abc") => never;
    type Mapped = <T extends string>(x: Uppercase<T>) => Uppercase<T>;
    type Upper = <T extends string>(x: Uppercase<T>) => Uppercase<T>;
    type Lower = <T extends string>(x: Lowercase<T>) => Lowercase<T>;
    type Equal<X, Y> = (<T>() => T extends X ? 1 : 2) extends (<T>() => T extends Y ? 1 : 2) ? true : false;
    interface Identity<T extends string> { same: Equal<Uppercase<T>, Uppercase<T>>; different: Equal<Uppercase<T>, Lowercase<T>>; repeated: Equal<Uppercase<Uppercase<T>>, Uppercase<T>> }
    type Native = Identity<string>; type Plain = { same: true; different: false; repeated: true };
    type Primitive = string;
  `;
  const names = ['Parser', 'Fixed', 'Wrong', 'Rejected', 'Mapped', 'Upper', 'Lower', 'Native', 'Plain', 'Primitive'];
  runCase(source, matrix(names));
  runCase(source, matrix(names).reverse(), { rounds: 3, cold: true });
});
test('string mapping schema v11 validates kinds and targets and rejects stale v10 graphs', () => {
  const graph = runCase('type A = Uppercase<string>; type B = "ABC";', matrix(['A', 'B']));
  assert.equal(graph.schema, 'tsts.type-graph.v11');
  const type = graph.types.find(t => t.stringMapping > 0);
  assert.equal(type.stringMapping, 1); assert.ok(type.indexObject >= 0);
  const original = { ...type };
  const graphPath = join(temp, 'string-mapping-schema.json');
  for (const [field, value] of [['stringMapping', 0], ['stringMapping', 5], ['stringMapping', 1.5], ['indexObject', -1], ['indexObject', graph.types.length]]) {
    Object.assign(type, original); type[field] = value;
    writeFileSync(graphPath, JSON.stringify(graph));
    const result = spawnSync(native, [graphPath], { encoding: 'utf8' });
    assert.equal(result.status, 1); assert.match(result.stderr, /Invalid string mapping metadata|Invalid referenced type ID/);
  }
  Object.assign(type, original); graph.schema = 'tsts.type-graph.v10';
  writeFileSync(graphPath, JSON.stringify(graph));
  const stale = spawnSync(native, [graphPath], { encoding: 'utf8' });
  assert.equal(stale.status, 1); assert.match(stale.stderr, /Expected tsts.type-graph.v11/);
});
test('template construction and contextual inference agree with tsgo', () => {
  const queries = matrix(templateSignatureNames);
  runCase(templateSignatures, queries);
  runCase(templateSignatures, queries.reverse(), { rounds: 3, cold: true });
});
test('contextual return inference retains active variables in nested tuples, arrays, unions, and templates', () => {
  const source = `
    type Pair = <T>(x: number) => [T, unknown[]];
    type Nested = <T>(x: number) => [T[]];
    type Union = <T>(x: number) => T[] | [T, string];
    type Template = <T extends string>(x: number) => \`pre_\${T}\`;
    type ReadonlyOut = <T>(x: number) => readonly [T?];
    type Boxed = <T>(x: number) => [{ value: T }];
    type FixedPair = (x: number) => [number, unknown[]];
    type FixedNested = (x: number) => [number[]];
    type FixedUnion = (x: number) => number[] | [number, string];
    type FixedTemplate = (x: number) => "pre_a";
    type FixedReadonly = (x: number) => readonly [number?];
    type FixedBoxed = (x: number) => [{ value: number }];
  `;
  const queries = matrix(['Pair', 'Nested', 'Union', 'Template', 'ReadonlyOut', 'Boxed', 'FixedPair', 'FixedNested', 'FixedUnion', 'FixedTemplate', 'FixedReadonly', 'FixedBoxed']);
  runCase(source, queries);
  runCase(source, queries.reverse(), { rounds: 4, cold: true });
});
test('template literal patterns and numeric placeholder spellings agree with tsgo', () => {
  const source = `
    type Text = string; type Num = number; type Any = any; type Never = never;
    type Prefix = \`pre_\${string}\`; type Suffix = \`\${string}_end\`; type Both = \`pre_\${string}_end\`;
    type Numeric = \`\${number}\`; type BigNumeric = \`\${bigint}\`; type PrefixedNum = \`pre_\${number}\`;
    type NumPair = \`\${number}.\${number}\`; type AnyPrefix = \`pre_\${any}\`;
    type AnyPair = \`\${any}\${any}\`; type NumberThenString = \`\${number}\${string}\`;
    type Empty = ""; type Pre = "pre_"; type Ending = "pre__end"; type Word = "pre_a_end";
    type Zero = "0"; type NegZero = "-0"; type Leading = "01"; type FortyTwo = "42";
    type Minus = "-42"; type Plus = "+42"; type Hex = "0x2a"; type Binary = "0b101"; type Octal = "0o77";
    type Space = " "; type SpaceNum = " 42 "; type Nbsp = "\\u00a0"; type LineSpace = "\\u2028";
    type Exponent = "1e3"; type Fraction = ".5"; type Infinite = "Infinity"; type Invalid = "NaN";
    type Separator = "1_000"; type NumberN = "42n"; type Pair = "1.2"; type WrongPair = "a.2";
    type NumPrefix = "pre_42"; type WrongPrefix = "pre_x";
    type Tagged = \`pre_\${string & {}}\`; type Branded = \`pre_\${string & { brand: true }}\`;
    type StrNum = \`pre_\${string | number}\`; type Other = \`other_\${string}\`;
  `;
  const names = ['Text', 'Num', 'Any', 'Never', 'Prefix', 'Suffix', 'Both', 'Numeric', 'BigNumeric', 'PrefixedNum', 'NumPair', 'AnyPrefix', 'AnyPair', 'NumberThenString', 'Empty', 'Pre', 'Ending', 'Word', 'Zero', 'NegZero', 'Leading', 'FortyTwo', 'Minus', 'Plus', 'Hex', 'Binary', 'Octal', 'Space', 'SpaceNum', 'Nbsp', 'LineSpace', 'Exponent', 'Fraction', 'Infinite', 'Invalid', 'Separator', 'NumberN', 'Pair', 'WrongPair', 'NumPrefix', 'WrongPrefix', 'Tagged', 'Branded', 'StrNum', 'Other'];
  runCase(source, matrix(names));
  runCase(source, matrix(names).reverse(), { rounds: 3, cold: true });
});
test('native template substitution expands unions and flattens nested spans', () => {
  const source = `
    enum TemplateEnum { A = 0, B = 2 }
    interface Render<T extends string | number | bigint | boolean | null | undefined> { value: \`<\${T}>\` }
    interface Nested<T extends string | number> { value: \`[\${\`pre_\${T}\`}]\` }
    interface Product<A extends string, B extends string> { value: \`\${A}-\${B}\` }
    type NativeUnion = Render<"a" | "b">; type PlainUnion = { value: "<a>" | "<b>" };
    type NativeBool = Render<boolean>; type PlainBool = { value: "<true>" | "<false>" };
    type NativeNull = Render<null | undefined>; type PlainNull = { value: "<null>" | "<undefined>" };
    type NativeBig = Render<9007199254740993n>; type PlainBig = { value: "<9007199254740993>" };
    type NativeEnum = Render<TemplateEnum>; type PlainEnum = { value: "<0>" | "<2>" };
    type NativeNumber = Nested<number>; type PlainNumber = { value: \`[pre_\${number}]\` };
    type NativeProduct = Product<"a" | "b", "c" | "d">; type PlainProduct = { value: "a-c" | "a-d" | "b-c" | "b-d" };
    type NativeNever = Render<never>; type PlainNever = { value: never };
    type NativeAny = Render<any>; type PlainAny = { value: \`<\${any}>\` };
    type Wrong = { value: "<wrong>" };
  `;
  const names = ['NativeUnion', 'PlainUnion', 'NativeBool', 'PlainBool', 'NativeNull', 'PlainNull', 'NativeBig', 'PlainBig', 'NativeEnum', 'PlainEnum', 'NativeNumber', 'PlainNumber', 'NativeProduct', 'PlainProduct', 'NativeNever', 'PlainNever', 'NativeAny', 'PlainAny', 'Wrong'];
  runCase(source, matrix(names));
  runCase(source, matrix(names), { strictNullChecks: false });
});
test('template captures consume code points and preserve lone surrogates', () => {
  const source = `
    type Split<T extends string> = T extends \`\${infer A}\${infer B}\` ? [A, B] : never;
    interface View<T extends string> { value: Split<T> }
    interface Join<T extends string> { value: \`\\uD83D\${T}\` }
    type Emoji = View<"\\u{1f600}x">; type EmojiPair = { value: ["\\u{1f600}", "x"] };
    type High = View<"\\uD800x">; type HighPair = { value: ["\\uD800", "x"] };
    type Low = View<"\\uDC00x">; type LowPair = { value: ["\\uDC00", "x"] };
    type Combining = View<"a\\u0301">; type CombiningPair = { value: ["a", "\\u0301"] };
    type Nul = View<"\\0x">; type NulPair = { value: ["\\0", "x"] };
    type Empty = View<"">; type NeverPair = { value: never };
    type Joined = Join<"\\uDE00">; type Scalar = { value: "\\u{1f600}" };
    type Unpaired = Join<"x">; type HighX = { value: "\\uD83Dx" };
    type Wrong = { value: ["\\uFFFD", "x"] };
  `;
  const names = ['Emoji', 'EmojiPair', 'High', 'HighPair', 'Low', 'LowPair', 'Combining', 'CombiningPair', 'Nul', 'NulPair', 'Empty', 'NeverPair', 'Joined', 'Scalar', 'Unpaired', 'HighX', 'Wrong'];
  runCase(source, matrix(names));
  runCase(source, matrix(names).reverse(), { rounds: 3, cold: true });
});
test('template numeric infer constraints use canonical number and bigint spellings', () => {
  const source = `
    type ParseN<S extends string> = S extends \`\${infer N extends number}\` ? N : never;
    type ParseB<S extends string> = S extends \`\${infer N extends bigint}\` ? N : never;
    type ParseUnion<S extends string> = S extends \`\${infer N extends number | bigint | boolean | null | undefined}\` ? N : never;
    interface N<S extends string> { value: ParseN<S> }
    interface B<S extends string> { value: ParseB<S> }
    interface U<S extends string> { value: ParseUnion<S> }
  `;
  const spellings = ['42', '-42', '042', ' 42 ', '+42', '-0', '0x2a', '0b101', '0o77', '1e3', '1.5', '1e+21', '0.000001', '1e-7', '9007199254740993', 'true', 'false', 'null', 'undefined', '', 'NaN', 'Infinity', '1_000', '42n'];
  let declarations = source;
  const names = [];
  for (const [index, spelling] of spellings.entries()) for (const parser of ['N', 'B', 'U']) {
    declarations += `type Native${parser}${index} = ${parser}<${JSON.stringify(spelling)}>; type Plain${parser}${index} = { value: ${parser === 'N' ? 'ParseN' : parser === 'B' ? 'ParseB' : 'ParseUnion'}<${JSON.stringify(spelling)}> };\n`;
    names.push(`Native${parser}${index}`, `Plain${parser}${index}`);
  }
  const queries = names.flatMap((name, i) => [{ source: name, target: names[i ^ 1] }, { source: names[i ^ 1], target: name }]);
  runCase(declarations, queries);
  runCase(declarations, queries.reverse(), { rounds: 3, cold: true });
});
test('template inference captures across source placeholder spans', () => {
  const source = `
    type Split = <T extends string>(x: T) => T extends \`<\${infer A}.\${infer B}>\` ? [A, B] : never;
    type Pattern = (x: \`<<\${string}>.<\${number}-\${number}>>\`) => [\`<\${string}>\`, \`<\${number}-\${number}>\`];
    type Wrong = (x: \`<<\${string}>.<\${number}-\${number}>>\`) => [string, number];
    type Head = <T extends string>(x: T) => T extends \`\${infer A}\${infer B}\` ? [A, B] : never;
    type GenericHead = (x: \`\${number}end\`) => [\`\${number}\`, "end"];
    type PrefixHead = (x: \`a\${number}end\`) => ["a", \`\${number}end\`];
  `;
  runCase(source, matrix(['Split', 'Pattern', 'Wrong', 'Head', 'GenericHead', 'PrefixHead']));
});
test('template key remapping constructs native member names and key sets', () => {
  const source = `
    interface EventView<T> { value: { [K in keyof T as \`on_\${K & string}\`]: T[K] }; keys: keyof { [K in keyof T as \`on_\${K & string}\`]: T[K] } }
    type Native = EventView<{ a: number; b?: string; 0: boolean }>;
    type Plain = { value: { on_a: number; on_b?: string }; keys: "on_a" | "on_b" };
    type Wrong = { value: { on_a: string; on_b?: number }; keys: "on_a" | "on_b" };
    type Remap = <T>(x: T) => { [K in keyof T as \`on_\${K & string}\`]: T[K] };
    type Fixed = (x: { a: number; b: string }) => { on_a: number; on_b: string };
    type Bad = (x: { a: number; b: string }) => { a: number; b: string };
  `;
  const names = ['Native', 'Plain', 'Wrong', 'Remap', 'Fixed', 'Bad'];
  runCase(source, matrix(names));
  runCase(source, matrix(names), { exactOptionalPropertyTypes: true });
});
test('template constraints, reference variance, and NoInfer barriers agree with tsgo', () => {
  const source = `
    interface View<T extends string | number | bigint | boolean> { value: \`pre_\${T}\` }
    type NumberView = View<number>; type StringView = View<string>; type BigView = View<bigint>; type OneView = View<1>;
    type GenericNumber = <T extends number>(x: T) => \`pre_\${T}\`;
    type GenericString = <T extends string>(x: T) => \`pre_\${T}\`;
    type GenericOne = <T extends 1>(x: T) => \`pre_\${T}\`;
    type GenericNumeric = <T extends \`pre_\${number}\`>(x: T) => T;
    type FixedOne = (x: 1) => "pre_1";
    type FixedPattern = (x: number) => \`pre_\${number}\`;
    type FixedString = (x: number) => \`pre_\${string}\`;
    type Blocked = <T extends string>(x: T, y: \`pre_\${NoInfer<T>}\`) => T;
    type Ordinary = <T extends string>(x: T, y: \`pre_\${T}\`) => T;
    type Same = (x: "a", y: "pre_a") => "a";
    type Different = (x: "a", y: "pre_b") => "a" | "b";
    type Length = { length: number }; type StringValue = { valueOf(): string };
    type Pattern = \`pre_\${number}\`;
  `;
  const names = ['NumberView', 'StringView', 'BigView', 'OneView', 'GenericNumber', 'GenericString', 'GenericOne', 'GenericNumeric', 'FixedOne', 'FixedPattern', 'FixedString', 'Blocked', 'Ordinary', 'Same', 'Different', 'Length', 'StringValue', 'Pattern'];
  runCase(source, matrix(names));
  runCase(source, matrix(names).reverse(), { rounds: 3, cold: true });
});
test('native prefixed placeholder validation handles numeric edge spellings', () => {
  const spellings = ['', '0', '-0', '-00', '00', '01', '-01', '0x2a', '-0x2a', '0XFF', '0b101', '0o77', '+42', '42', '-42', ' 42 ', ' ', '\u00a0', '\u2028', '\u0085', '\u200b', '1e3', '1e-7', '1e+21', '0.000001', '.5', '1.', '1.0', '1_000', '42n', 'NaN', 'Infinity', '1e999', '90071992547409931234567890'];
  let source = 'type NumberPattern = `pre_${number}`; type BigPattern = `pre_${bigint}`;';
  const names = [];
  for (const [i, spelling] of spellings.entries()) { source += `type Value${i} = ${JSON.stringify('pre_' + spelling)};\n`; names.push('Value' + i); }
  runCase(source, names.flatMap(name => [{ source: name, target: 'NumberPattern' }, { source: name, target: 'BigPattern' }]));
});
test('recursive conditional templates split and reconstruct long Unicode strings', () => {
  const source = `
    type Split<S extends string, R extends string[] = []> = S extends \`\${infer A}\${infer B}\` ? Split<B, [...R, A]> : R;
    type Join<R extends string[], S extends string = ""> = R extends [infer A extends string, ...infer B extends string[]] ? Join<B, \`\${S}\${A}\`> : S;
    interface View<S extends string> { chars: Split<S>; value: Join<Split<S>> }
    type Native = View<${JSON.stringify('😀a'.repeat(70))}>;
    type Plain = { chars: [${Array.from({ length: 70 }, () => '"😀", "a"').join(',')}]; value: ${JSON.stringify('😀a'.repeat(70))} };
    type Wrong = { chars: []; value: "" };
  `;
  runCase(source, matrix(['Native', 'Plain', 'Wrong']), { rounds: 3, cold: true });
});
test('template text spans and placeholder IDs validate schema v9', () => {
  const graph = runCase('type Pattern = `pre_${number}_end`; type Value = "pre_42_end";', [{ source: 'Value', target: 'Pattern' }]);
  assert.equal(graph.schema, 'tsts.type-graph.v11');
  const type = graph.types.find(t => t.templateTexts.length > 0);
  assert.deepEqual(type.templateTexts, ['cHJlXw==', 'X2VuZA==']);
  assert.equal(type.types.length, 1);
  const graphPath = join(temp, 'template-schema.json');
  const original = structuredClone(type);
  for (const [field, value, diagnostic] of [['templateTexts', [''], /Invalid template literal spans/], ['templateTexts', [42, ''], /expected string|Invalid template literal text/], ['templateTexts', ['!!!!', ''], /Invalid template literal text/], ['types', [graph.types.length], /Invalid referenced type ID/]]) {
    Object.assign(type, original, { [field]: value });
    writeFileSync(graphPath, JSON.stringify(graph));
    const result = spawnSync(native, [graphPath], { encoding: 'utf8' });
    assert.equal(result.status, 1); assert.match(result.stderr, diagnostic);
  }
  Object.assign(type, original); graph.schema = 'tsts.type-graph.v8';
  writeFileSync(graphPath, JSON.stringify(graph));
  const stale = spawnSync(native, [graphPath], { encoding: 'utf8' });
  assert.equal(stale.status, 1); assert.match(stale.stderr, /Expected tsts.type-graph.v11/);
});
test('template construction rejects the 100000-member cross-product boundary', () => {
  const left = Array.from({ length: 316 }, (_, i) => JSON.stringify('a' + i)).join(' | ');
  const right = Array.from({ length: 317 }, (_, i) => JSON.stringify('b' + i)).join(' | ');
  const source = 'interface Product<A extends string, B extends string> { value: `${A}-${B}` }' + `type Native = Product<${left}, ${right}>; type Plain = { value: string };`;
  const inputPath = join(temp, 'template-overflow-input.json');
  const graphPath = join(temp, 'template-overflow-graph.json');
  writeFileSync(inputPath, JSON.stringify({ source, queries: [{ source: 'Native', target: 'Plain' }] }));
  const { graph } = JSON.parse(execFileSync(oracle, [inputPath], { encoding: 'utf8', maxBuffer: 32 * 1024 * 1024 }));
  writeFileSync(graphPath, JSON.stringify(graph));
  const result = spawnSync(native, [graphPath], { encoding: 'utf8' });
  assert.equal(result.status, 1); assert.match(result.stderr, /Template union cross-product complexity limit exceeded/);
});
test('template contextual inference finds captures within union parameters', () => {
  const source = `
    type Parse = <T extends string>(x: \`pre_\${T}\` | number) => T;
    type ParseEither = <T extends string>(x: \`pre_\${T}\` | \`post_\${T}\`) => T;
    type ParseArray = <T extends string>(x: (\`pre_\${T}\` | number)[]) => T[];
    type ParseCallback = <T extends string>(x: () => \`pre_\${T}\` | number) => T;
    type Fixed = (x: "pre_a" | number) => "a";
    type Mixed = (x: "pre_a" | "pre_b" | number) => "a" | "b";
    type Either = (x: "pre_a" | "post_b") => "a" | "b";
    type FixedArray = (x: ("pre_a" | number)[]) => "a"[];
    type FixedCallback = (x: () => "pre_a" | number) => "a";
    type Wrong = (x: "pre_a" | number) => "b";
  `;
  const names = ['Parse', 'ParseEither', 'ParseArray', 'ParseCallback', 'Fixed', 'Mixed', 'Either', 'FixedArray', 'FixedCallback', 'Wrong'];
  runCase(source, matrix(names));
  runCase(source, matrix(names).reverse(), { rounds: 3, cold: true });
});
test('patterned index relations select matching domains and preserve inferable index rules', () => {
  const queries = matrix(patternIndexNames);
  runCase(patternIndexes, queries);
  runCase(patternIndexes, queries.reverse(), { rounds: 3, cold: true });
  runCase(patternIndexes, queries, { exactOptionalPropertyTypes: true });
});
test('native patterned reads prefer specific indexes and intersect overlapping values', () => {
  const source = `
    type Prefix = { [K: \`pre_\${string}\`]: number };
    type Overlap = { [K: string]: unknown; [K: \`pre_\${string}\`]: { a: number }; [K: \`\${string}_end\`]: { b: string } };
    type Num = { [K: number]: { a: number }; [K: \`\${number}\`]: { b: string } };
    interface View<T, K extends keyof T> { value: T[K]; keys: keyof T }
    type PrefixRead = View<Prefix, "pre_x">; type PrefixPlain = { value: number; keys: \`pre_\${string}\` };
    type PatternRead = View<Prefix, \`pre_\${string}\`>;
    type OverlapRead = View<Overlap, "pre_x_end">; type OverlapPlain = { value: { a: number; b: string }; keys: string | number };
    type FirstRead = View<Overlap, "pre_x">; type FirstPlain = { value: { a: number }; keys: string | number };
    type FallbackRead = View<Overlap, "other">; type FallbackPlain = { value: unknown; keys: string | number };
    type NumericRead = View<Num, "42">; type NumericPlain = { value: { a: number; b: string }; keys: number | \`\${number}\` };
    type NumberRead = View<Num, 42>; type NumberPlain = { value: { a: number }; keys: number | \`\${number}\` };
    type NumericPatternRead = View<Num, \`\${number}\`>;
    type Wrong = { value: string; keys: never };
  `;
  const names = ['PrefixRead', 'PrefixPlain', 'PatternRead', 'OverlapRead', 'OverlapPlain', 'FirstRead', 'FirstPlain', 'FallbackRead', 'FallbackPlain', 'NumericRead', 'NumericPlain', 'NumberRead', 'NumberPlain', 'NumericPatternRead', 'Wrong'];
  runCase(source, matrix(names));
  runCase(source, matrix(names).reverse(), { rounds: 3, cold: true });
});
test('mapped template indexes construct broad remaps, collisions, and optional values', () => {
  const source = `
    interface View<T> { value: { [K in keyof T as \`pre_\${K & string}\`]: T[K] }; keys: keyof { [K in keyof T as \`pre_\${K & string}\`]: T[K] } }
    interface Collision<T> { value: { [K in keyof T as \`out_\${string}\`]: T[K] } }
    interface Clone<T> { value: { [K in keyof T]: T[K] }; partial: Partial<T>; required: Required<T>; ro: Readonly<T> }
    type Pattern = { [K: \`pre_\${string}\`]: number };
    type Native = View<{ [K: string]: number }>;
    type Plain = { value: Pattern; keys: \`pre_\${string}\` };
    type NativeNested = View<Pattern>; type PlainNested = { value: { [K: \`pre_pre_\${string}\`]: number }; keys: \`pre_pre_\${string}\` };
    type NativeCollision = Collision<{ a: number; b: string }>; type PlainCollision = { value: { [K: \`out_\${string}\`]: number | string } };
    type NativeClone = Clone<Pattern>; type PlainClone = { value: Pattern; partial: { [K: \`pre_\${string}\`]: number | undefined }; required: Pattern; ro: { readonly [K: \`pre_\${string}\`]: number } };
    type Fixed = (x: { [K: string]: number }) => Pattern;
    type Remap = <T>(x: T) => { [K in keyof T as \`pre_\${K & string}\`]: T[K] };
    type Wrong = { value: { [K: \`pre_\${string}\`]: string }; keys: \`pre_\${string}\` };
  `;
  const names = ['Native', 'Plain', 'NativeNested', 'PlainNested', 'NativeCollision', 'PlainCollision', 'NativeClone', 'PlainClone', 'Fixed', 'Remap', 'Wrong'];
  runCase(source, matrix(names));
  runCase(source, matrix(names).reverse(), { rounds: 3, cold: true, exactOptionalPropertyTypes: true });
});
test('contextual inference gathers values from patterned indexes and matching properties', () => {
  const source = `
    type Infer = <T>(x: { [K: \`pre_\${string}\`]: T }) => T;
    type InferNum = <T>(x: { [K: \`pre_\${number}\`]: T }) => T;
    type NumberPattern = (x: { [K: \`pre_\${string}\`]: number }) => number;
    type StringPattern = (x: { [K: \`pre_\${string}\`]: string }) => string;
    type Properties = (x: { pre_a: number; pre_b: number; other: string }) => number;
    type MixedProperties = (x: { pre_a: number; pre_b: string; other: boolean }) => number | string;
    type OptionalProperties = (x: { pre_a?: number }) => number;
    type NumericProperties = (x: { pre_42: number; pre_a: string }) => number;
    type Wrong = (x: { pre_a: number }) => string;
    type InterfaceInput = (x: InterfaceCase) => unknown;
    interface InterfaceCase { pre_a: number }
  `;
  const names = ['Infer', 'InferNum', 'NumberPattern', 'StringPattern', 'Properties', 'MixedProperties', 'OptionalProperties', 'NumericProperties', 'Wrong', 'InterfaceInput'];
  runCase(source, matrix(names));
  runCase(source, matrix(names).reverse(), { rounds: 3, cold: true });
});
test('pattern index schema v10 validates keys, values, and readonly flags', () => {
  const graph = runCase('type A = { readonly [K: `pre_${string}`]: number; readonly [K: number]: string }; type B = { pre_x: number };', [{ source: 'B', target: 'A' }]);
  assert.equal(graph.schema, 'tsts.type-graph.v11');
  const type = graph.types.find(t => t.patternIndexes.length > 0);
  assert.equal(type.patternIndexes.length, 1); assert.equal(type.patternIndexes[0].readonly, true); assert.equal(type.indexReadonly, 2);
  const graphPath = join(temp, 'pattern-index-schema.json');
  const original = structuredClone(type);
  for (const [field, value, diagnostic] of [
    ['indexReadonly', 8, /Invalid index readonly flags/],
    ['patternIndexes', [{ ...type.patternIndexes[0], keyType: graph.types.length }], /Invalid referenced type ID/],
    ['patternIndexes', [{ ...type.patternIndexes[0], type: -1 }], /Invalid referenced type ID/],
    ['patternIndexes', [{ ...type.patternIndexes[0], keyType: type.patternIndexes[0].type }], /Invalid pattern index key/],
    ['patternIndexes', [{ ...type.patternIndexes[0], readonly: 1 }], /expected boolean|Invalid pattern index readonly/],
  ]) {
    Object.assign(type, original, { [field]: value });
    writeFileSync(graphPath, JSON.stringify(graph));
    const result = spawnSync(native, [graphPath], { encoding: 'utf8' });
    assert.equal(result.status, 1); assert.match(result.stderr, diagnostic);
  }
  Object.assign(type, original); graph.schema = 'tsts.type-graph.v9';
  writeFileSync(graphPath, JSON.stringify(graph));
  const stale = spawnSync(native, [graphPath], { encoding: 'utf8' });
  assert.equal(stale.status, 1); assert.match(stale.stderr, /Expected tsts.type-graph.v11/);
});
test('native pattern intersections and unions preserve shared keys and value domains', () => {
  const source = `
    type Prefix = { [K: \`pre_\${string}\`]: { a: number } };
    type Suffix = { [K: \`\${string}_end\`]: { b: string } };
    type Numeric = { [K: \`pre_\${number}\`]: { b: string } };
    interface Intersection<A, B> { value: A & B; keys: keyof (A & B); read: (A & B)["pre_42_end" & keyof (A & B)] }
    interface Union<A, B> { value: A | B; keys: keyof (A | B) }
    type Inter = Intersection<Prefix, Suffix>;
    type PlainInter = { value: Prefix & Suffix; keys: \`pre_\${string}\` | \`\${string}_end\`; read: { a: number; b: string } };
    type Shared = Union<Prefix, Suffix>; type PlainShared = { value: Prefix | Suffix; keys: \`pre_\${string}\` & \`\${string}_end\` };
    type NarrowShared = Union<Prefix, Numeric>; type PlainNarrow = { value: Prefix | Numeric; keys: \`pre_\${number}\` };
    type Tagged = Prefix & { tag: "a" }; type OtherTagged = Prefix & { tag: "b" };
    type Read = <T, K extends keyof T>(x: T, k: K) => T[K];
    type ReadUnion = (x: Prefix & Suffix, k: "pre_x" | "x_end") => { a: number } | { b: string };
    type Wrong = (x: Prefix & Suffix, k: "pre_x_end") => { a: number };
  `;
  const names = ['Inter', 'PlainInter', 'Shared', 'PlainShared', 'NarrowShared', 'PlainNarrow', 'Tagged', 'OtherTagged', 'Read', 'ReadUnion', 'Wrong'];
  runCase(source, matrix(names));
  runCase(source, matrix(names).reverse(), { rounds: 3, cold: true });
});
test('native mapped pattern readonly metadata participates in conditional identity', () => {
  const source = `
    type Equal<X, Y> = (<T>() => T extends X ? 1 : 2) extends (<T>() => T extends Y ? 1 : 2) ? true : false;
    type Mutable<T> = { -readonly [K in keyof T]: T[K] };
    interface Probe<T> { ro: Equal<T, Readonly<T>>; mutable: Equal<T, Mutable<T>> }
    type Pattern = { [K: \`pre_\${string}\`]: number }; type RoPattern = { readonly [K: \`pre_\${string}\`]: number };
    type Native = Probe<Pattern>; type Plain = { ro: false; mutable: true };
    type NativeRo = Probe<RoPattern>; type PlainRo = { ro: true; mutable: false };
    type NativeIntersection = Probe<RoPattern & Pattern>; type NativeMapped = Probe<Readonly<Pattern>>;
    type NativeString = Probe<{ [K: string]: number }>; type NativeRoString = Probe<{ readonly [K: string]: number }>;
    type NativeNumber = Probe<{ [K: number]: number }>; type NativeRoNumber = Probe<{ readonly [K: number]: number }>;
  `;
  const names = ['Native', 'Plain', 'NativeRo', 'PlainRo', 'NativeIntersection', 'NativeMapped', 'NativeString', 'NativeRoString', 'NativeNumber', 'NativeRoNumber'];
  runCase(source, matrix(names));
  runCase(source, matrix(names).reverse(), { rounds: 3, cold: true });
});
test('Unicode pattern index domains preserve supplementary and lone-surrogate keys', () => {
  const source = `
    type High = { [K: \`\\uD800\${string}\`]: number };
    type Low = { [K: \`\\uDC00\${string}\`]: number };
    type Emoji = { [K: \`\\u{1f600}\${string}\`]: number };
    type Paired = { [K: \`\\uD83D\\uDE00\${string}\`]: number };
    type HighProp = { "\\uD800x": number }; type LowProp = { "\\uDC00x": number }; type EmojiProp = { "\\u{1f600}x": number };
    type Replacement = { "\\uFFFDx": string }; type Wrong = { "\\uD800x": string };
    interface Read<T, K extends keyof T> { value: T[K]; keys: keyof T }
    type Native = Read<High, "\\uD800x">; type Plain = { value: number; keys: \`\\uD800\${string}\` };
  `;
  runCase(source, matrix(['High', 'Low', 'Emoji', 'Paired', 'HighProp', 'LowProp', 'EmojiProp', 'Replacement', 'Wrong', 'Native', 'Plain']), { rounds: 3, cold: true });
});
test('Function.call prototype comparisons agree with tsgo', () => {
  runCase('type A = (x: number) => number; type B = { call(x: number): void }; type C = { call(thisArg: unknown, x: number): number };', matrix(['A', 'B', 'C']));
});
test('invalid query IDs and options fail with diagnostics', () => {
  const graphPath = join(temp, 'invalid-graph.json');
  writeFileSync(graphPath, JSON.stringify({ schema: 'tsts.type-graph.v11', revision: '', strictNullChecks: true, strictFunctionTypes: true, exactOptionalPropertyTypes: false, types: [], queries: [{ source: 0, target: 0, label: '', expected: false }] }));
  const badId = spawnSync(native, [graphPath], { encoding: 'utf8' });
  assert.equal(badId.status, 1);
  assert.match(badId.stderr, /Invalid query type ID/);
  const badOption = spawnSync(native, [graphPath, '--rounds'], { encoding: 'utf8' });
  assert.equal(badOption.status, 1);
  assert.match(badOption.stderr, /requires a number/);
});

test('generic variadic rest signatures infer fixed ends and normalize instantiated parameters', () => {
  const queries = matrix(variadicSignatureNames);
  runCase(variadicSignatures, queries);
  runCase(variadicSignatures, [...queries].reverse(), { rounds: 3, cold: true, exactOptionalPropertyTypes: true });
});
test('variadic conditional inference extracts tuple heads, tails, initial elements, and rest parameters', () => {
  const source = `
    type Head<T> = T extends readonly [infer H, ...unknown[]] ? H : never;
    type Tail<T> = T extends readonly [unknown, ...infer R] ? R : never;
    type Last<T> = T extends readonly [...unknown[], infer L] ? L : never;
    type Init<T> = T extends readonly [...infer R, unknown] ? R : never;
    type HeadOp = <T>(x: T) => Head<T>; type TailOp = <T>(x: T) => Tail<T>;
    type LastOp = <T>(x: T) => Last<T>; type InitOp = <T>(x: T) => Init<T>;
    type ParamsOp = <T extends (...args: any[]) => any>(x: T) => Parameters<T>;
    type CtorParamsOp = <T extends abstract new (...args: any[]) => any>(x: T) => ConstructorParameters<T>;
    type NumberHead = (x: [number, string, boolean]) => number;
    type NumberTail = (x: [number, string, boolean]) => [string, boolean];
    type BooleanLast = (x: [number, string, boolean]) => boolean;
    type NumberInit = (x: [number, string, boolean]) => [number, string];
    type ReadonlyTail = (x: readonly [number, string?]) => [string?];
    type RestTail = (x: [number, ...string[]]) => string[];
    type RestInit = (x: [...number[], string]) => number[];
    type UnionTail = (x: [number, string] | [boolean, number]) => [string] | [number];
    type EmptyTail = (x: []) => never;
    type FixedParams = (x: (a: number, b?: string) => boolean) => [number, string?];
    type RestParams = (x: (a: number, ...b: string[]) => boolean) => [number, ...string[]];
    type FixedCtor = (x: abstract new (a: number, b: string) => object) => [number, string];
    type Wrong = (x: [number, string, boolean]) => [boolean, number];
  `;
  const names = ['HeadOp', 'TailOp', 'LastOp', 'InitOp', 'ParamsOp', 'CtorParamsOp', 'NumberHead', 'NumberTail', 'BooleanLast', 'NumberInit', 'ReadonlyTail', 'RestTail', 'RestInit', 'UnionTail', 'EmptyTail', 'FixedParams', 'RestParams', 'FixedCtor', 'Wrong'];
  runCase(source, matrix(names));
  runCase(source, matrix(names).reverse(), { rounds: 3, cold: true });
});
test('native tuple substitution distributes spreads and preserves optional, readonly, any, and never shapes', () => {
  const source = `
    type Concat = <T extends unknown[], U extends unknown[]>(x: T, y: U) => [number, ...T, ...U, boolean];
    type Spread = <T extends unknown[]>(x: T) => [...T];
    type ReadonlySpread = <T extends readonly unknown[]>(x: T) => readonly [...T];
    type Append = <T extends unknown[]>(x: T) => [...T, boolean];
    type SpreadAny = <T>(x: T) => T extends any[] ? [number, ...T, string] : never;
    type Pair = (x: [string], y: [number?]) => [number, string, number | undefined, boolean];
    type Rest = (x: string[], y: number[]) => [number, ...(number | string)[], boolean];
    type Union = (x: [] | [string], y: [] | [number]) => [number, boolean] | [number, string, boolean] | [number, number, boolean] | [number, string, number, boolean];
    type Optional = (x: [number?]) => [number?, boolean?];
    type OptionalRequired = (x: [number?]) => [number | undefined, boolean];
    type Mutable = (x: [number, string?]) => [number, string?];
    type FixedReadonlySpread = (x: readonly [number, string?]) => readonly [number, string?];
    type Any = (x: any) => any[];
    type Never = (x: never) => never;
    type RestAppend = (x: number[]) => [...number[], boolean];
    type Wrong = (x: [number, string?]) => [string, number?];
  `;
  const queries = matrix(['Concat', 'Spread', 'ReadonlySpread', 'Append', 'SpreadAny', 'Pair', 'Rest', 'Union', 'Optional', 'OptionalRequired', 'Mutable', 'FixedReadonlySpread', 'Any', 'Never', 'RestAppend', 'Wrong']);
  runCase(source, queries);
  runCase(source, queries, { rounds: 3, cold: true, exactOptionalPropertyTypes: true });
});
test('homomorphic mapped tuples recursively map generic spreads and keep fixed keys', () => {
  const source = `
    type TupleKeys<T> = { [K in keyof T]: K };
    type TupleBox<T> = { [K in keyof T]: { value: T[K] } };
    type KeysOp = <T extends unknown[]>(x: T) => TupleKeys<[string, ...T, boolean]>;
    type BoxOp = <T extends unknown[]>(x: T) => TupleBox<[string, ...T, boolean]>;
    type PartialOp = <T extends unknown[]>(x: T) => Partial<[string, ...T, boolean]>;
    type RequiredOp = <T extends unknown[]>(x: T) => Required<[string?, ...T]>;
    type ReadonlyOp = <T extends unknown[]>(x: T) => Readonly<[string, ...T]>;
    type FixedKeys = (x: [number, number]) => ["0", "1", "2", "3"];
    type RestKeys = (x: number[]) => ["0", ...number[], number];
    type FixedBox = (x: [number]) => [{ value: string }, { value: number }, { value: boolean }];
    type RestBox = (x: number[]) => [{ value: string }, ...{ value: number }[], { value: boolean }];
    type FixedPartial = (x: [number]) => [string?, number?, boolean?];
    type FixedRequired = (x: [number?]) => [string, number];
    type FixedReadonly = (x: [number]) => readonly [string, number];
    type Wrong = (x: [number]) => ["0", "1"];
  `;
  const queries = matrix(['KeysOp', 'BoxOp', 'PartialOp', 'RequiredOp', 'ReadonlyOp', 'FixedKeys', 'RestKeys', 'FixedBox', 'RestBox', 'FixedPartial', 'FixedRequired', 'FixedReadonly', 'Wrong']);
  runCase(source, queries);
  runCase(source, queries.reverse(), { rounds: 3, cold: true });
});
test('native tuple members preserve this-returning array methods', () => {
  runCase('type Pair = [number, string]; type Optional = [number, string?]; type Empty = []; type Ro = readonly [number, string]; type MixedArray = (number | string)[]; type ReversePair = { reverse(): [number, string] }; type SortPair = { sort(compare?: (a: number | string, b: number | string) => number): [number, string] }; type ReverseArray = { reverse(): (number | string)[] }; type SortArray = { sort(compare?: (a: number | string, b: number | string) => number): (number | string)[] }; type ReverseWrong = { reverse(): [string, number] };', matrix(['Pair', 'Optional', 'Empty', 'Ro', 'MixedArray', 'ReversePair', 'SortPair', 'ReverseArray', 'SortArray', 'ReverseWrong']));
});

test('variadic inference uses fixed tuple constraints to separate adjacent spread and rest elements', () => {
  const source = `
    type Leading = <T extends [unknown, unknown], U>(x: [...T, ...U[]]) => [T, U];
    type Trailing = <T extends [unknown, unknown], U>(x: [...U[], ...T]) => [T, U];
    type LeadingRest = <T extends [unknown, unknown], U>(...args: [...T, ...U[]]) => [T, U];
    type TrailingRest = <T extends [unknown, unknown], U>(...args: [...U[], ...T]) => [T, U];
    type LeadingFixed = (x: [number, string, boolean, boolean]) => [[number, string], boolean];
    type TrailingFixed = (x: [boolean, boolean, number, string]) => [[number, string], boolean];
    type LeadingRestFixed = (a: number, b: string, c: boolean, d: boolean) => [[number, string], boolean];
    type TrailingRestFixed = (a: boolean, b: boolean, c: number, d: string) => [[number, string], boolean];
    type TooShort = (x: [number]) => [[number, string], unknown];
    type Wrong = (x: [number, string, boolean, boolean]) => [[string, number], boolean];
  `;
  const queries = matrix(['Leading', 'Trailing', 'LeadingRest', 'TrailingRest', 'LeadingFixed', 'TrailingFixed', 'LeadingRestFixed', 'TrailingRestFixed', 'TooShort', 'Wrong']);
  runCase(source, queries);
  runCase(source, queries.reverse(), { rounds: 3, cold: true });
});
test('generic tuple relations preserve spread constraints, fixed indexes, and readonly conversions', () => {
  const source = `
    type Spread = <T extends unknown[]>(x: [...T]) => T;
    type Original = <T extends unknown[]>(x: T) => T;
    type Copy = <T extends unknown[]>(x: T) => [...T];
    type RoSpread = <T extends readonly unknown[]>(x: readonly [...T]) => T;
    type RoOriginal = <T extends readonly unknown[]>(x: T) => T;
    type RoCopy = <T extends readonly unknown[]>(x: T) => readonly [...T];
    type Bounded = <T extends number[]>(x: [string, ...T]) => number | string;
    type ToArray = <T extends number[]>(x: [string, ...T]) => (number | string)[];
    type FixedIndex = <T extends unknown[]>(x: T) => [number, ...T][0];
    type VariableIndex = <T extends unknown[]>(x: T) => [number, ...T][number];
    type Pair = (x: [number, string]) => [number, string];
    type RoPair = (x: readonly [number, string]) => readonly [number, string];
    type FixedNumber = (x: [string]) => number;
    type NumberString = (x: [string]) => number | string;
    type BadIndex = (x: [string]) => string;
  `;
  const queries = matrix(['Spread', 'Original', 'Copy', 'RoSpread', 'RoOriginal', 'RoCopy', 'Bounded', 'ToArray', 'FixedIndex', 'VariableIndex', 'Pair', 'RoPair', 'FixedNumber', 'NumberString', 'BadIndex']);
  runCase(source, queries);
  runCase(source, queries.reverse(), { rounds: 3, cold: true });
});

test('generic tuple keyof targets expose fixed positions and array declaration keys', () => {
  const source = `
    type KeysOp = <T extends unknown[]>(x: T) => keyof [number, ...T];
    type RoKeysOp = <T extends readonly unknown[]>(x: T) => keyof readonly [number, ...T];
    type Position = <T extends unknown[]>(x: T) => "0";
    type MaybePosition = <T extends unknown[]>(x: T) => "1";
    type Numeric = <T extends unknown[]>(x: T) => number;
    type Length = <T extends unknown[]>(x: T) => "length";
    type Push = <T extends unknown[]>(x: T) => "push";
    type Slice = <T extends unknown[]>(x: T) => "slice";
    type Iterator = <T extends unknown[]>(x: T) => typeof Symbol.iterator;
    type UnknownKey = <T extends unknown[]>(x: T) => "missing";
    type BroadString = <T extends unknown[]>(x: T) => string;
    type ArrayKeys = <T extends unknown[]>(x: T) => keyof number[];
    type FixedKeys = (x: [string]) => keyof [number, string];
  `;
  const queries = matrix(['KeysOp', 'RoKeysOp', 'Position', 'MaybePosition', 'Numeric', 'Length', 'Push', 'Slice', 'Iterator', 'UnknownKey', 'BroadString', 'ArrayKeys', 'FixedKeys']);
  runCase(source, queries);
  runCase(source, queries.reverse(), { rounds: 3, cold: true });
});
test('optional spread elements retain undefined when a required suffix turns them into required positions', () => {
  const source = `
    type Append = <T extends unknown[]>(x: T) => [...T, boolean];
    type Prepend = <T extends unknown[]>(x: T) => [boolean, ...T];
    type OptionalMember = (x: [number?]) => { "0": number | undefined; "1": boolean };
    type RequiredMember = (x: [number?]) => { "0": number; "1": boolean };
    type Tuple = (x: [number?]) => [number | undefined, boolean];
    type WrongTuple = (x: [number?]) => [number, boolean];
    type OptionalSuffix = (x: [number?]) => { "0": boolean; "1"?: number };
    type RequiredSuffix = (x: [number?]) => { "0": boolean; "1": number | undefined };
  `;
  const queries = matrix(['Append', 'Prepend', 'OptionalMember', 'RequiredMember', 'Tuple', 'WrongTuple', 'OptionalSuffix', 'RequiredSuffix']);
  runCase(source, queries);
  runCase(source, queries.reverse(), { rounds: 3, cold: true, exactOptionalPropertyTypes: true });
});

test('recursive variadic conditional utilities construct their result tuples natively', () => {
  const source = `
    type Reverse<T> = T extends readonly [infer H, ...infer R] ? [...Reverse<R>, H] : [];
    type Zip<T, U> = T extends readonly [infer H, ...infer R] ? U extends readonly [infer J, ...infer S] ? [[H, J], ...Zip<R, S>] : [] : [];
    type ReverseOp = <T>(x: T) => Reverse<T>;
    type ZipOp = <T, U>(x: T, y: U) => Zip<T, U>;
    type ReversePair = (x: [number, string]) => [string, number];
    type ReverseReadonly = (x: readonly [number, string, boolean]) => [boolean, string, number];
    type ReverseEmpty = (x: []) => [];
    type ReverseUnion = (x: [number, string] | [boolean]) => [string, number] | [boolean];
    type ZipPair = (x: [number, string], y: [boolean, number]) => [[number, boolean], [string, number]];
    type ZipUnequal = (x: [number, string, boolean], y: [boolean]) => [[number, boolean]];
    type WrongReverse = (x: [number, string]) => [number, string];
    type WrongZip = (x: [number, string], y: [boolean, number]) => [[boolean, number], [number, string]];
  `;
  const queries = matrix(['ReverseOp', 'ZipOp', 'ReversePair', 'ReverseReadonly', 'ReverseEmpty', 'ReverseUnion', 'ZipPair', 'ZipUnequal', 'WrongReverse', 'WrongZip']);
  runCase(source, queries);
  runCase(source, queries.reverse(), { rounds: 3, cold: true });
});
test('tuple shapes and effective rest templates validate the graph boundary', () => {
  const graph = runCase(variadicSignatures, [{ source: 'VariadicId', target: 'FixedPair' }, { source: 'VariadicId', target: 'FixedWrong' }]);
  assert.equal(graph.schema, 'tsts.type-graph.v11');
  const tuples = graph.types.filter(type => (type.objectFlags & 8) !== 0);
  assert.ok(tuples.some(type => type.tupleFlags.some(flag => (flag & 8) !== 0)));
  for (const type of tuples) { assert.equal(type.target, -1); assert.deepEqual(type.properties, []); }
  const signature = graph.types[graph.queries[0].source].calls[0];
  assert.ok(signature.effectiveRest >= 0);
  const effectiveRest = signature.effectiveRest;
  const graphPath = join(temp, 'rest-schema.json');
  delete signature.effectiveRest;
  writeFileSync(graphPath, JSON.stringify(graph));
  const invalid = spawnSync(native, [graphPath], { encoding: 'utf8' });
  assert.equal(invalid.status, 1); assert.match(invalid.stderr, /effectiveRest.*undefined/);
  signature.effectiveRest = effectiveRest;
  graph.schema = 'tsts.type-graph.v5';
  writeFileSync(graphPath, JSON.stringify(graph));
  const old = spawnSync(native, [graphPath], { encoding: 'utf8' });
  assert.equal(old.status, 1); assert.match(old.stderr, /Expected tsts.type-graph.v11/);
});

test('NoInfer blocks contextual candidates while preserving assignability and defaults', () => {
  const source = noInferSignatures;
  const names = noInferSignatureNames;
  const graph = runCase(source, matrix(names));
  const answer = (source, target) => graph.queries.find(query => query.label === source + ' -> ' + target).expected;
  assert.equal(answer('Plain', 'PairDifferent'), true);
  assert.equal(answer('Blocked', 'PairDifferent'), false);
  assert.equal(answer('DefaultPlain', 'NumberVoid'), true);
  assert.equal(answer('DefaultBlocked', 'NumberVoid'), false);
  runCase(source, matrix(names).reverse(), { rounds: 3, cold: true });
});
test('NoInfer survives object, array, callback, and variadic substitutions without supplying candidates', () => {
  const source = `
    type ObjectPlain = <T>(value: { value: T }) => T;
    type ObjectBlocked = <T = string>(value: NoInfer<{ value: T }>) => void;
    type MemberBlocked = <T = string>(value: { value: NoInfer<T> }) => void;
    type ArrayBlocked = <T = string>(value: NoInfer<T[]>) => void;
    type ElementBlocked = <T = string>(value: NoInfer<T>[]) => void;
    type CallbackBlocked = <T = string>(value: NoInfer<(x: T) => T>) => void;
    type CallbackMemberBlocked = <T = string>(value: (x: NoInfer<T>) => NoInfer<T>) => void;
    type RestBlocked = <T extends unknown[] = [string]>(...args: NoInfer<T>) => void;
    type CopyBlocked = <T extends unknown[] = [string]>(value: NoInfer<[...T]>) => void;
    type Nested = <T>(value: T) => NoInfer<NoInfer<{ value: T }>>;
    type NumObject = (value: { value: number }) => void;
    type StrObject = (value: { value: string }) => void;
    type NumArray = (value: number[]) => void;
    type StrArray = (value: string[]) => void;
    type NumCallback = (value: (x: number) => number) => void;
    type StrCallback = (value: (x: string) => string) => void;
    type NumRest = (value: number) => void;
    type StrRest = (value: string) => void;
    type NumCopy = (value: [number]) => void;
    type StrCopy = (value: [string]) => void;
    type NumNested = (value: number) => { value: number };
    type WrongNested = (value: number) => { value: string };
  `;
  const names = ['ObjectPlain', 'ObjectBlocked', 'MemberBlocked', 'ArrayBlocked', 'ElementBlocked', 'CallbackBlocked', 'CallbackMemberBlocked', 'RestBlocked', 'CopyBlocked', 'Nested', 'NumObject', 'StrObject', 'NumArray', 'StrArray', 'NumCallback', 'StrCallback', 'NumRest', 'StrRest', 'NumCopy', 'StrCopy', 'NumNested', 'WrongNested'];
  runCase(source, matrix(names));
  runCase(source, matrix(names).reverse(), { rounds: 3, cold: true });
});
test('NoInfer keyof and indexed accesses preserve their inference barrier', () => {
  const source = `
    type KeyPlain = <T = { a: number }>(key: keyof T) => void;
    type KeyBlocked = <T = { a: number }>(key: keyof NoInfer<T>) => void;
    type KeyWrapped = <T = { a: number }>(key: NoInfer<keyof T>) => void;
    type Get = <T, K extends keyof T>(value: T, key: K) => NoInfer<T>[K];
    type BlockedGet = <T, K extends keyof T>(value: NoInfer<T>, key: K) => T[K];
    type WrappedGet = <T, K extends keyof T>(value: T, key: K) => NoInfer<T[K]>;
    type KeyA = (key: "a") => void; type KeyB = (key: "b") => void;
    type NumGet = (value: { a: number }, key: "a") => number;
    type StrGet = (value: { a: string }, key: "a") => string;
    type WrongGet = (value: { a: number }, key: "a") => string;
    interface NoInferView<T> { keys: keyof NoInfer<T>; value: NoInfer<T>[keyof T] }
    type Native = NoInferView<{ a: number; b: string }>;
    type Plain = { keys: "a" | "b"; value: number | string };
  `;
  const names = ['KeyPlain', 'KeyBlocked', 'KeyWrapped', 'Get', 'BlockedGet', 'WrappedGet', 'KeyA', 'KeyB', 'NumGet', 'StrGet', 'WrongGet', 'Native', 'Plain'];
  const graph = runCase(source, matrix(names));
  const answer = (source, target) => graph.queries.find(query => query.label === source + ' -> ' + target).expected;
  assert.equal(answer('KeyPlain', 'KeyB'), true);
  assert.equal(answer('KeyBlocked', 'KeyB'), false);
  runCase(source, matrix(names).reverse(), { rounds: 3, cold: true });
});
test('conditional NoInfer extraction and mapped members preserve blocked infer positions', () => {
  const source = `
    type ExtractBlocked<T> = T extends NoInfer<infer U> ? U : never;
    type ExtractPlain<T> = T extends infer U ? U : never;
    type BlockedOp = <T>(value: T) => ExtractBlocked<T>;
    type PlainOp = <T>(value: T) => ExtractPlain<T>;
    type Two<T> = T extends { a: infer U; b: NoInfer<infer U> } ? U : never;
    type TwoOp = <T>(value: T) => Two<T>;
    type NumberExtract = (value: number) => number;
    type UnknownExtract = (value: number) => unknown;
    type NumberTwo = (value: { a: number; b: number }) => number;
    type MismatchTwo = (value: { a: number; b: string }) => never;
    type BlockedMap = <T = { a: string }>(value: { [K in keyof T]: NoInfer<T[K]> }) => void;
    type PlainMap = <T = { a: string }>(value: { [K in keyof T]: T[K] }) => void;
    type NumMap = (value: { a: number }) => void;
    type StrMap = (value: { a: string }) => void;
    interface NoInferMapped<T> { value: { [K in keyof T]: NoInfer<T[K]> } }
    type Native = NoInferMapped<{ a: number; b?: string }>;
    type Shape = { value: { a: number; b?: string } };
  `;
  const names = ['BlockedOp', 'PlainOp', 'TwoOp', 'NumberExtract', 'UnknownExtract', 'NumberTwo', 'MismatchTwo', 'BlockedMap', 'PlainMap', 'NumMap', 'StrMap', 'Native', 'Shape'];
  runCase(source, matrix(names));
  runCase(source, matrix(names).reverse(), { rounds: 3, cold: true });
});

test('NoInfer object wrappers are transparent to concrete relations and member access', () => {
  const source = `
    type Num = number[]; type BlockedNum = NoInfer<number[]>;
    type Pair = [number, string?]; type BlockedPair = NoInfer<[number, string?]>;
    type Shape = { value: number }; type BlockedShape = NoInfer<{ value: number }>;
    type Method = (value: number) => number; type BlockedMethod = NoInfer<(value: number) => number>;
    type Empty = {}; type BlockedEmpty = NoInfer<{}>;
    type Keys = keyof NoInfer<{ value: number; other: string }>;
    type PlainKeys = "value" | "other";
    type Get = <T>(value: T) => NoInfer<{ value: T }>["value"];
    type NumberGet = (value: number) => number;
    type WrongGet = (value: number) => string;
    type ObjectValue = <T>(value: T) => NoInfer<{ value: T }>;
    type NumberValue = (value: number) => { value: number };
    type Ro = readonly number[];
  `;
  const names = ['Num', 'BlockedNum', 'Pair', 'BlockedPair', 'Shape', 'BlockedShape', 'Method', 'BlockedMethod', 'Empty', 'BlockedEmpty', 'Keys', 'PlainKeys', 'Get', 'NumberGet', 'WrongGet', 'ObjectValue', 'NumberValue', 'Ro'];
  runCase(source, matrix(names));
  runCase(source, matrix(names).reverse(), { rounds: 3, cold: true, exactOptionalPropertyTypes: true });
});
test('primitive apparent members participate in conditional and reverse mapped inference', () => {
  const source = `
    type ValueOf<T> = T extends { valueOf(): infer U } ? U : never;
    type LengthOf<T> = T extends { length: infer U } ? U : never;
    type ValueOp = <T>(value: T) => ValueOf<T>;
    type LengthOp = <T>(value: T) => LengthOf<T>;
    type Reverse = <T>(value: { [K in keyof T]: T[K] }) => T;
    type ReverseBlocked = <T>(value: { [K in keyof T]: NoInfer<T[K]> }) => T;
    type VoidReverse = <T = { a: number }>(value: { [K in keyof T]: T[K] }) => void;
    type NumberValue = (value: number) => number;
    type StringValue = (value: string) => string;
    type BooleanValue = (value: boolean) => boolean;
    type BigintValue = (value: bigint) => bigint;
    type SymbolValue = (value: symbol) => symbol;
    type StringLength = (value: string) => number;
    type ArrayLength = (value: number[]) => number;
    type TupleLength = (value: [number, string]) => 2;
    type NumberVoid = (value: number) => void;
    type StringVoid = (value: string) => void;
    type Wrong = (value: number) => string;
  `;
  const names = ['ValueOp', 'LengthOp', 'Reverse', 'ReverseBlocked', 'VoidReverse', 'NumberValue', 'StringValue', 'BooleanValue', 'BigintValue', 'SymbolValue', 'StringLength', 'ArrayLength', 'TupleLength', 'NumberVoid', 'StringVoid', 'Wrong'];
  runCase(source, matrix(names));
  runCase(source, matrix(names).reverse(), { rounds: 3, cold: true });
});
test('NoInfer remains scoped across method generics, this parameters, and dependent defaults', () => {
  const source = `
    interface BlockedScope<T> { method<U = T>(value: NoInfer<U>): void }
    interface PlainScope<T> { method<U = T>(value: U): void }
    type NumScope = BlockedScope<number>; type StrScope = BlockedScope<string>;
    type PlainNumScope = PlainScope<number>;
    type NumMethod = { method(value: number): void }; type StrMethod = { method(value: string): void };
    type ThisBlocked = <T = string>(this: NoInfer<T>, value: NoInfer<T>) => void;
    type ThisPlain = <T = string>(this: T, value: T) => void;
    type NumThis = (this: number, value: number) => void;
    type StrThis = (this: string, value: string) => void;
    type Dependent = <T, U = T>(value: T, hint: NoInfer<U>) => NoInfer<U>;
    type Independent = <T, U = string>(value: T, hint: NoInfer<U>) => NoInfer<U>;
    type NumDependent = (value: number, hint: number) => number;
    type StrDependent = (value: number, hint: string) => string;
    type NumVoid = (value: number, hint: number) => void;
    type StrVoid = (value: number, hint: string) => void;
  `;
  const names = ['NumScope', 'StrScope', 'PlainNumScope', 'NumMethod', 'StrMethod', 'ThisBlocked', 'ThisPlain', 'NumThis', 'StrThis', 'Dependent', 'Independent', 'NumDependent', 'StrDependent', 'NumVoid', 'StrVoid'];
  runCase(source, matrix(names));
  runCase(source, matrix(names).reverse(), { rounds: 3, cold: true });
});

test('conditional true and false tail recursion evaluates beyond 100 construction levels', () => {
  const elements = Array.from({ length: 180 }, () => 'unknown').join(', ');
  const source = `
    type Build<N, A extends unknown[] = []> = A["length"] extends N ? A : Build<N, [...A, unknown]>;
    type Count<T, A extends unknown[] = []> = T extends [unknown, ...infer R] ? Count<R, [...A, unknown]> : A["length"];
    interface Built<N> { value: Build<N> }
    interface Counted<T> { value: Count<T> }
    type NativeBuild = Built<180>; type NativeCount = Counted<[${elements}]>;
    type PlainBuild = { value: [${elements}] }; type PlainCount = { value: 180 };
    type WrongBuild = { value: [] }; type WrongCount = { value: 179 };
  `;
  const queries = [...matrix(['NativeBuild', 'PlainBuild', 'WrongBuild']), ...matrix(['NativeCount', 'PlainCount', 'WrongCount'])];
  runCase(source, queries);
  runCase(source, queries.reverse(), { rounds: 3, cold: true });
});

test('immediately nested conditional false branches evaluate as one chain', () => {
  const chain = Array.from({ length: 120 }, (_, i) => `T extends ${i} ? ${i} : `).join('') + '"missing"';
  const all = Array.from({ length: 120 }, (_, i) => String(i)).join(' | ') + ' | "missing"';
  const source = `
    type Chain<T> = ${chain};
    interface TailSelection<T> { value: Chain<T> }
    type Native = TailSelection<119>; type Missing = TailSelection<120>;
    type Distributed = TailSelection<0 | 119 | 120>;
    type Plain = { value: 119 }; type PlainMissing = { value: "missing" };
    type PlainDistributed = { value: 0 | 119 | "missing" }; type Wrong = { value: number };
    type Ambiguous = TailSelection<any>; type PlainAmbiguous = { value: ${all} };
    type Impossible = TailSelection<never>; type PlainImpossible = { value: never };
  `;
  const names = ['Native', 'Missing', 'Distributed', 'Plain', 'PlainMissing', 'PlainDistributed', 'Wrong', 'Ambiguous', 'PlainAmbiguous', 'Impossible', 'PlainImpossible'];
  // This exercises branch construction, independently of marker variance's
  // separate depth limit when comparing two deferred 120-branch declarations.
  const references = new Set(['Native', 'Missing', 'Distributed', 'Ambiguous', 'Impossible']);
  const queries = matrix(names).filter(q => q.source === q.target || !references.has(q.source) || !references.has(q.target));
  runCase(source, queries);
  runCase(source, queries.reverse(), { rounds: 3, cold: true });
});

test('conditional tail transitions retain distribution, infer scopes, and mutual alias recursion', () => {
  const nested = 'readonly ('.repeat(140) + '(number | string[])' + ')[]'.repeat(140);
  const tuple = Array.from({ length: 181 }, () => 'unknown').join(', ');
  const source = `
    type FlatTail<T> = T extends readonly (infer U)[] ? FlatTail<U> : T;
    type Even<T> = T extends [unknown, ...infer R] ? Odd<R> : true;
    type Odd<T> = T extends [unknown, ...infer R] ? Even<R> : false;
    interface Flattened<T> { value: FlatTail<T> }
    interface Parity<T> { value: Even<T> }
    type Native = Flattened<${nested}>; type Plain = { value: number | string };
    type Wrong = { value: number }; type NativeParity = Parity<[${tuple}]>;
    type PlainParity = { value: false }; type WrongParity = { value: true };
  `;
  const queries = [...matrix(['Native', 'Plain', 'Wrong']), ...matrix(['NativeParity', 'PlainParity', 'WrongParity'])];
  runCase(source, queries);
  runCase(source, queries.reverse(), { rounds: 3, cold: true });
});

test('conditional tail recursion accepts 999 steps and rejects the 1000-step boundary', () => {
  const source = `
    type TailBuild<N, A extends unknown[] = []> = A["length"] extends N ? A : TailBuild<N, [...A, unknown]>;
    interface TailBuilt<N> { value: TailBuild<N> }
    type Accepted = TailBuilt<999>; type Excessive = TailBuilt<1000>;
    type Plain = { value: unknown[] };
  `;
  runCase(source, [{ source: 'Accepted', target: 'Plain' }]);
  const inputPath = join(temp, 'tail-limit-input.json');
  const graphPath = join(temp, 'tail-limit-graph.json');
  writeFileSync(inputPath, JSON.stringify({ source, queries: [{ source: 'Excessive', target: 'Plain' }] }));
  const reference = spawnSync(oracle, [inputPath], { encoding: 'utf8', maxBuffer: 32 * 1024 * 1024 });
  assert.equal(reference.status, 0, reference.stderr);
  writeFileSync(graphPath, JSON.stringify(JSON.parse(reference.stdout).graph));
  const result = spawnSync(native, [graphPath], { encoding: 'utf8' });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /Conditional tail recursion limit exceeded \(1000 steps\)/);
});

test('conditional alias metadata exports and validates conditional alias and nested false metadata', () => {
  const graph = runCase(`
    type TailChoice<T> = T extends number ? number : T extends string ? string : boolean;
    type ChoiceOp = <T>(value: T) => TailChoice<T>;
    type Plain = (value: string) => string;
  `, [{ source: 'ChoiceOp', target: 'Plain' }]);
  assert.equal(graph.schema, 'tsts.type-graph.v11');
  const root = graph.types.find(t => t.conditionalAlias && t.conditionalNestedFalse);
  assert.ok(root);
  const graphPath = join(temp, 'conditional-tail-schema.json');
  delete root.conditionalAlias;
  writeFileSync(graphPath, JSON.stringify(graph));
  const invalid = spawnSync(native, [graphPath], { encoding: 'utf8' });
  assert.equal(invalid.status, 1); assert.match(invalid.stderr, /conditionalAlias.*undefined/);
  root.conditionalAlias = true;
  graph.schema = 'tsts.type-graph.v6';
  writeFileSync(graphPath, JSON.stringify(graph));
  const old = spawnSync(native, [graphPath], { encoding: 'utf8' });
  assert.equal(old.status, 1); assert.match(old.stderr, /Expected tsts.type-graph.v11/);
});

test('numeric, string, heterogeneous, computed, ambient, and const enum relations agree with tsgo', () => {
  const queries = matrix(enumRelationNames);
  const graph = runCase(enumRelations, queries);
  const answer = (source, target) => graph.queries.find(q => q.label === source + ' -> ' + target).expected;
  assert.equal(answer('Zero', 'NumericEnum'), true);
  assert.equal(answer('Invalid', 'NumericEnum'), false);
  assert.equal(answer('NumericA', 'OtherA'), false);
  assert.equal(answer('TextA', 'LiteralA'), true);
  assert.equal(answer('LiteralA', 'TextA'), false);
  assert.equal(answer('CollisionText', 'CollisionNumber'), false);
  assert.equal(answer('CollisionNumber', 'CollisionText'), false);
  runCase(enumRelations, queries.reverse(), { rounds: 3, cold: true });
});

test('same-name enum declarations compare directional member sets and known values', () => {
  const source = `
    namespace EnumLeft { export enum Status { A = 0, B = 1 } }
    namespace EnumRight { export enum Status { A = 0, B = 1 } }
    namespace EnumSmall { export enum Status { A = 0 } }
    namespace EnumChanged { export enum Status { A = 2, B = 1 } }
    namespace EnumText { export enum Status { A = "a", B = "b" } }
    namespace EnumUnknown { export declare enum Status { A, B } }
    namespace EnumConst { export const enum Status { A = 0, B = 1 } }
    type Left = EnumLeft.Status; type Right = EnumRight.Status;
    type Small = EnumSmall.Status; type Changed = EnumChanged.Status;
    type Text = EnumText.Status; type Opaque = EnumUnknown.Status;
    type Constant = EnumConst.Status;
    type LeftA = EnumLeft.Status.A; type RightA = EnumRight.Status.A;
    type SmallA = EnumSmall.Status.A; type ChangedA = EnumChanged.Status.A;
    type TextA = EnumText.Status.A; type OpaqueA = EnumUnknown.Status.A;
    type ConstantA = EnumConst.Status.A;
    type LeftB = EnumLeft.Status.B; type ChangedB = EnumChanged.Status.B;
  `;
  const names = ['Left', 'Right', 'Small', 'Changed', 'Text', 'Opaque', 'Constant', 'LeftA', 'RightA', 'SmallA', 'ChangedA', 'TextA', 'OpaqueA', 'ConstantA', 'LeftB', 'ChangedB'];
  const graph = runCase(source, matrix(names));
  const answer = (source, target) => graph.queries.find(q => q.label === source + ' -> ' + target).expected;
  assert.equal(answer('Left', 'Right'), true);
  assert.equal(answer('Right', 'Left'), true);
  assert.equal(answer('LeftB', 'ChangedB'), false);
  runCase(source, matrix(names).reverse(), { rounds: 3, cold: true });
});

test('enum contextual inference, constraints, defaults, and fresh widening retain their declaration', () => {
  const source = enumRelations + `
    type EnumIdentity = <T extends NumericEnum>(value: T) => T;
    type EnumDefault = <T = NumericEnum>(value: NoInfer<T>) => T;
    type EnumArray = <T>(a: T, b: T) => T[];
    type NumericIdentity = (value: NumericEnum) => NumericEnum;
    type MemberIdentity = (value: NumericEnum.A) => NumericEnum.A;
    type OtherIdentity = (value: OtherNumericEnum) => OtherNumericEnum;
    type NumberIdentity = (value: number) => number;
    type WrongIdentity = (value: NumericEnum) => TextEnum;
    type NumericPair = (a: NumericEnum.A, b: NumericEnum.B) => NumericEnum[];
    type MemberPair = (a: NumericEnum.A, b: NumericEnum.A) => NumericEnum.A[];
    type TextPair = (a: TextEnum.A, b: TextEnum.B) => TextEnum[];
    type MixedPair = (a: NumericEnum.A, b: OtherNumericEnum.A) => (NumericEnum | OtherNumericEnum)[];
    type NumberPair = (a: NumericEnum.A, b: 1) => number[];
    type EnumDefaultNumber = (value: number) => NumericEnum;
    type WrongDefault = (value: number) => TextEnum;
  `;
  const names = ['EnumIdentity', 'EnumDefault', 'EnumArray', 'NumericIdentity', 'MemberIdentity', 'OtherIdentity', 'NumberIdentity', 'WrongIdentity', 'NumericPair', 'MemberPair', 'TextPair', 'MixedPair', 'NumberPair', 'EnumDefaultNumber', 'WrongDefault'];
  runCase(source, matrix(names));
  runCase(source, matrix(names).reverse(), { rounds: 3, cold: true });
});

test('native enum keys, indexed accesses, mapped members, and conditional filters agree with tsgo', () => {
  const source = enumRelations + `
    interface EnumNativeView<T> { keys: keyof T; value: T[keyof T] }
    interface EnumNativeRecord<K extends PropertyKey> { value: Record<K, boolean>; keys: keyof Record<K, boolean> }
    interface EnumNativeFilter<T> { numeric: Extract<T, number>; textual: Extract<T, string>; partial: Partial<T> }
    type NumericView = EnumNativeView<typeof NumericEnum>;
    type NumericPlain = { keys: "A" | "B" | "C"; value: NumericEnum };
    type NumericRecord = EnumNativeRecord<NumericEnum>;
    type NumericRecordPlain = { value: { 0: boolean; 1: boolean; 4: boolean }; keys: 0 | 1 | 4 };
    type TextRecord = EnumNativeRecord<TextEnum>;
    type TextRecordPlain = { value: { a: boolean; b: boolean }; keys: "a" | "b" };
    type MixedFilter = EnumNativeFilter<MixedEnum>;
    type MixedFilterPlain = { numeric: MixedEnum.A; textual: MixedEnum.B; partial: MixedEnum };
    type NumericFilter = EnumNativeFilter<NumericEnum>;
    type NumericFilterPlain = { numeric: NumericEnum; textual: never; partial: NumericEnum };
    type WrongFilter = { numeric: number; textual: string; partial: number };
  `;
  const names = ['NumericView', 'NumericPlain', 'NumericRecord', 'NumericRecordPlain', 'TextRecord', 'TextRecordPlain', 'MixedFilter', 'MixedFilterPlain', 'NumericFilter', 'NumericFilterPlain', 'WrongFilter'];
  runCase(source, matrix(names));
  runCase(source, matrix(names).reverse(), { rounds: 3, cold: true });
});

test('version 8 retains enum declaration identities, member values, and reverse numeric indexes', () => {
  const graph = runCase(enumRelations + 'type Namespace = typeof NumericEnum; type Plain = { A: NumericEnum.A };', [
    { source: 'NumericA', target: 'OtherA' }, { source: 'Namespace', target: 'Plain' },
  ]);
  assert.equal(graph.schema, 'tsts.type-graph.v11');
  const member = graph.types[graph.queries[0].source];
  assert.ok(member.enumOrigin >= 0);
  const declaration = graph.types[member.enumOrigin];
  assert.equal(declaration.enumOrigin, member.enumOrigin);
  assert.equal(declaration.enumRegular, true);
  assert.deepEqual(declaration.enumMembers.map(m => [m.name, m.kind, m.value]), [['QQ==', 1, '0'], ['Qg==', 1, '1'], ['Qw==', 1, '4']]);
  assert.equal(graph.types[graph.queries[1].source].enumNumberIndex, true);
  const graphPath = join(temp, 'enum-schema.json');
  member.enumOrigin = graph.types.length;
  writeFileSync(graphPath, JSON.stringify(graph));
  const invalid = spawnSync(native, [graphPath], { encoding: 'utf8' });
  assert.equal(invalid.status, 1); assert.match(invalid.stderr, /Invalid referenced type ID/);
  member.enumOrigin = declaration.enumOrigin;
  declaration.enumMembers[0].kind = 3;
  writeFileSync(graphPath, JSON.stringify(graph));
  const invalidMember = spawnSync(native, [graphPath], { encoding: 'utf8' });
  assert.equal(invalidMember.status, 1); assert.match(invalidMember.stderr, /Invalid enum member kind/);
});

test('enum declaration compatibility preserves lone-surrogate member names and string values', () => {
  const source = `
    namespace EnumUnicodeA { export enum Byte { "\\ud800" = "\\ud800", Other = "\\udc00" } }
    namespace EnumUnicodeB { export enum Byte { "\\ud800" = "\\ud800", Other = "\\udc00" } }
    namespace EnumUnicodeC { export enum Byte { "\\ud801" = "\\ud800", Other = "\\udc00" } }
    namespace EnumUnicodeD { export enum Byte { "\\ud800" = "\\ud801", Other = "\\udc00" } }
    type SameA = EnumUnicodeA.Byte; type SameB = EnumUnicodeB.Byte;
    type DifferentName = EnumUnicodeC.Byte; type DifferentValue = EnumUnicodeD.Byte;
    type High = (typeof EnumUnicodeA.Byte)["\\ud800"];
    type Low = (typeof EnumUnicodeA.Byte)["Other"];
    type LiteralHigh = "\\ud800"; type LiteralOther = "\\ud801"; type LiteralLow = "\\udc00";
  `;
  const names = ['SameA', 'SameB', 'DifferentName', 'DifferentValue', 'High', 'Low', 'LiteralHigh', 'LiteralOther', 'LiteralLow'];
  runCase(source, matrix(names));
  runCase(source, matrix(names).reverse(), { rounds: 3, cold: true });
});

test('conditional extends identity distinguishes compatible enum declarations', () => {
  const source = `
    namespace EnumIdentityA { export enum Tag { A = 0, B = 1 } }
    namespace EnumIdentityB { export enum Tag { A = 0, B = 1 } }
    type First = <T>(value: T) => T extends EnumIdentityA.Tag.A ? 1 : 2;
    type Second = <T>(value: T) => T extends EnumIdentityB.Tag.A ? 1 : 2;
    type WholeFirst = <T>(value: T) => T extends EnumIdentityA.Tag ? 1 : 2;
    type WholeSecond = <T>(value: T) => T extends EnumIdentityB.Tag ? 1 : 2;
    type Primitive = <T>(value: T) => T extends 0 ? 1 : 2;
    type FirstMember = (value: EnumIdentityA.Tag.A) => 1;
    type SecondMember = (value: EnumIdentityB.Tag.A) => 1;
    type FirstWhole = (value: EnumIdentityA.Tag) => 1;
    type SecondWhole = (value: EnumIdentityB.Tag) => 1;
    type Wrong = (value: EnumIdentityA.Tag.A) => 2;
  `;
  const names = ['First', 'Second', 'WholeFirst', 'WholeSecond', 'Primitive', 'FirstMember', 'SecondMember', 'FirstWhole', 'SecondWhole', 'Wrong'];
  runCase(source, matrix(names));
  runCase(source, matrix(names).reverse(), { rounds: 3, cold: true });
});

test('conditional permissive wildcards keep potentially never-valued object checks deferred', () => {
  const source = `
    type Impossible = <T>(value: T) => { value: T } extends { value: never } ? 1 : 2;
    type OtherImpossible = <U>(value: U) => { value: U } extends { value: never } ? 1 : 2;
    type Wrapped = <T>(value: T) => [T] extends [never] ? 1 : 2;
    type Always = <T>(value: T) => 2;
    type NumberResult = (value: number) => 2;
    type NeverResult = (value: never) => 1;
    type WrongNever = (value: never) => 2;
    type Ambiguous<T, U> = T extends number ? 0 : U extends boolean ? 1 : 2;
    type AmbiguousOp = <T, U>(value: T, other: U) => Ambiguous<T, U>;
    type AmbiguousNumber = (value: number, other: boolean) => 0;
    type AmbiguousAny = (value: any, other: boolean) => 0 | 1;
  `;
  const names = ['Impossible', 'OtherImpossible', 'Wrapped', 'Always', 'NumberResult', 'NeverResult', 'WrongNever', 'AmbiguousOp', 'AmbiguousNumber', 'AmbiguousAny'];
  runCase(source, matrix(names));
  runCase(source, matrix(names).reverse(), { rounds: 3, cold: true });
});
