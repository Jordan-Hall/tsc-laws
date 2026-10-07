import { execFileSync } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { cpus } from 'node:os';
import { resolve } from 'node:path';
import { primitives, primitiveNames, objects, objectNames, matrix, variadicSignatures, variadicSignatureNames, noInferSignatures, noInferSignatureNames, enumRelations, enumRelationNames, templateSignatures, templateSignatureNames, patternIndexes, patternIndexNames, stringMappingSignatures, stringMappingSignatureNames } from '../tests/cases.mjs';
import { checkerSources, oracleSources, sourceIdentity } from './source-identity.mjs';

const oracle = resolve('dist/tsgo-oracle');
const native = resolve('dist/tsts');
const nativeBuild = JSON.parse(readFileSync('dist/build.json', 'utf8'));
const oracleBuild = JSON.parse(readFileSync('dist/oracle-build.json', 'utf8'));
if (nativeBuild.sourceSha256 !== sourceIdentity(checkerSources)) throw new Error('Native executable is stale; run npm run build');
if (oracleBuild.sourceSha256 !== sourceIdentity(oracleSources)) throw new Error('Go oracle is stale; run npm run build:oracle');
if (nativeBuild.arch !== process.arch || oracleBuild.arch !== process.arch) throw new Error('Build architecture does not match this host');
mkdirSync('benchmarks/generated', { recursive: true });
const cases = [
  { name: 'string-mappings', source: stringMappingSignatures, queries: matrix(stringMappingSignatureNames), rounds: 2000 },
  { name: 'patterned-indexes', source: patternIndexes, queries: matrix(patternIndexNames), rounds: 2000 },
  { name: 'template-types', source: templateSignatures, queries: matrix(templateSignatureNames), rounds: 2000 },
  { name: 'enums', source: enumRelations, queries: matrix(enumRelationNames), rounds: 2000 },
  { name: 'no-infer', source: noInferSignatures, queries: matrix(noInferSignatureNames), rounds: 2000 },
  { name: 'variadic-tuples', source: variadicSignatures, queries: matrix(variadicSignatureNames), rounds: 2000 },
  { name: 'primitives', source: primitives, queries: matrix(primitiveNames), rounds: 10000 },
  { name: 'structural', source: primitives + objects, queries: matrix(objectNames.slice(0, 22)), rounds: 2000 },
  { name: 'signatures', source: primitives + objects, queries: matrix(objectNames.slice(31)), rounds: 20000 },
  { name: 'generics', source: 'type Identity = <T>(x: T) => T; type NumberIdentity = <T extends number>(x: T) => T; type FixedNumber = (x: number) => number; type FixedString = (x: string) => string; type ArrayId = <T>(x: T[]) => T[]; type NumberArray = (x: number[]) => number[]; type BoxId = <T>(x: { value: T }) => { value: T }; type NumberBox = (x: { value: number }) => { value: number }; type Callback = <T>(fn: (x: T) => T, x: T) => T; type NumberCallback = (fn: (x: number) => number, x: number) => number;', queries: matrix(['Identity', 'NumberIdentity', 'FixedNumber', 'FixedString', 'ArrayId', 'NumberArray', 'BoxId', 'NumberBox', 'Callback', 'NumberCallback']), rounds: 2000 },
  { name: 'array-methods', source: 'type Num = number[]; type Str = string[]; type Ro = readonly number[]; type Pair = [number, number]; type Empty = []; type PushNum = { push(...items: number[]): number }; type PopNum = { pop(): number | undefined }; type SliceNum = { slice(start?: number, end?: number): number[] }; type Every = { every(predicate: (value: number) => unknown): boolean }; type Some = { some(predicate: (value: number) => unknown): boolean };', queries: matrix(['Num', 'Str', 'Ro', 'Pair', 'Empty', 'PushNum', 'PopNum', 'SliceNum', 'Every', 'Some']), rounds: 2000 },
  { name: 'indexed-types', source: 'type Get = <T, K extends keyof T>(x: T, k: K) => T[K]; type Constrained = <T extends { value: number }, K extends keyof T>(x: T, k: K) => T[K]; type NumberGet = (x: { value: number }, k: "value") => number; type StringGet = (x: { value: string }, k: "value") => string; type BadGet = (x: { value: number }, k: "value") => string; type UnionGet = (x: { a: number; b: string }, k: "a" | "b") => number | string; type Key = <T>(x: T) => keyof T; type NumberKey = (x: { value: number }) => "value"; interface View<T> { key: keyof T; value: T[keyof T] } type Keys = View<{ a: number; b: string }>; type Values = View<{ a: number; common: boolean } | { b: string; common: boolean }>; type PlainKeys = { key: "a" | "b"; value: number | string }; type PlainValues = { key: "common"; value: boolean };', queries: matrix(['Get', 'Constrained', 'NumberGet', 'StringGet', 'BadGet', 'UnionGet', 'Key', 'NumberKey', 'Keys', 'Values', 'PlainKeys', 'PlainValues']), rounds: 2000 },
  { name: 'mapped-types', source: 'type Clone = <T>(x: T) => { [P in keyof T]: T[P] }; type PartialOut = <T>(x: T) => Partial<T>; type RequiredOut = <T>(x: T) => Required<T>; type Reverse = <T>(x: { [P in keyof T]: { value: T[P] } }) => T; type PickReverse = <T, K extends keyof T>(x: { [P in K]: { value: T[P] } }) => T; type Fixed = (x: { a: number; b: string }) => { a: number; b: string }; type Optional = (x: { a: number; b: string }) => { a?: number; b?: string }; type Boxed = (x: { a: { value: number }; b: { value: string } }) => { a: number; b: string }; type WrongBoxed = (x: { a: { value: number }; b: { value: string } }) => { a: string; b: number }; interface Part<T> { value: Partial<T> } type Native = Part<{ a: number; b: string }>; type Plain = { value: { a?: number; b?: string } };', queries: matrix(['Clone', 'PartialOut', 'RequiredOut', 'Reverse', 'PickReverse', 'Fixed', 'Optional', 'Boxed', 'WrongBoxed', 'Native', 'Plain']), rounds: 2000 },
  { name: 'conditional-types', source: 'type Choose = <T>(x: T) => T extends number ? string : boolean; type Wrapped = <T>(x: T) => [T] extends [number] ? string : boolean; type ElementOf = <T>(x: T) => T extends readonly (infer U)[] ? U : never; type Flatten<T> = T extends readonly (infer U)[] ? Flatten<U> : T; type Flat = <T>(x: T) => Flatten<T>; type NumberChoice = (x: number) => string; type StringChoice = (x: string) => boolean; type UnionChoice = (x: number | string) => string | boolean; type NumberElement = (x: number[]) => number; type FlatElement = (x: readonly number[][]) => number; type Wrong = (x: number) => boolean; interface Select<T> { value: Extract<T, number> } type Native = Select<number | string>; type Plain = { value: number };', queries: matrix(['Choose', 'Wrapped', 'ElementOf', 'Flat', 'NumberChoice', 'StringChoice', 'UnionChoice', 'NumberElement', 'FlatElement', 'Wrong', 'Native', 'Plain']), rounds: 2000 },
];
const results = [];
for (const workload of cases) {
  for (const cold of [false, true]) {
    const input = resolve(`benchmarks/generated/${workload.name}-${cold ? 'cold' : 'warm'}.input.json`);
    const graphPath = input.replace('.input.json', '.graph.json');
    writeFileSync(input, JSON.stringify({ ...workload, cold }));
    const samples = [];
    for (let sample = 0; sample < 5; sample++) {
      // Time inside each native executable: no process, parsing, graph export, or IPC overhead.
      const go = JSON.parse(execFileSync(oracle, [input], { encoding: 'utf8', maxBuffer: 32 * 1024 * 1024 }));
      if (go.benchmark.arch !== (process.arch === 'x64' ? 'amd64' : process.arch)) throw new Error('Baseline architecture does not match the native port');
      writeFileSync(graphPath, JSON.stringify(go.graph));
      const ts = JSON.parse(execFileSync(native, [graphPath, '--rounds', String(workload.rounds), ...(cold ? ['--cold'] : [])], { encoding: 'utf8' }));
      if (ts.checksum !== go.benchmark.checksum) throw new Error('Benchmark checksums differ');
      for (let i = 0; i < ts.results.length; i++) if (ts.results[i] !== go.graph.queries[i].expected) throw new Error('Benchmark relation mismatch: ' + go.graph.queries[i].label);
      samples.push({ tsgoMs: go.benchmark.elapsedMs, tstsMs: ts.elapsedMs, checks: ts.checks, checksum: ts.checksum, goVersion: go.benchmark.goVersion });
    }
    const median = values => [...values].sort((a,b)=>a-b)[Math.floor(values.length/2)];
    const tsgoMs = median(samples.map(s=>s.tsgoMs));
    const tstsMs = median(samples.map(s=>s.tstsMs));
    const result = { workload: workload.name, cold, rounds: workload.rounds, checks: samples[0].checks, tsgoMs, tstsMs, tstsOverTsgo: tstsMs / tsgoMs, samples };
    results.push(result);
    console.log(`${workload.name} ${cold ? 'cold' : 'warm'}: tsgo ${tsgoMs.toFixed(2)} ms; tsts ${tstsMs.toFixed(2)} ms; tsts/tsgo ${(tstsMs/tsgoMs).toFixed(2)}x`);
  }
}
writeFileSync('benchmarks/latest.json', JSON.stringify({
  date: new Date().toISOString(), cpu: cpus()[0].model, arch: process.arch, platform: process.platform,
  scriptc: '0.2.5', revision: '89d5d5b2849a0db0957065889ca58536fa6d2e4a',
  portSourceSha256: nativeBuild.sourceSha256, oracleSourceSha256: oracleBuild.sourceSha256,
  scope: 'Resolved-type assignability only; excludes parsing, binding, initial type construction/resolution, graph export, IPC, and startup. Cold generic relations include contextual inference; warm generic relations reuse relation caches. Neither result is a whole-compiler benchmark.',
  timing: 'Five samples; median; one unmeasured warm-up per process. Cold clears type-relation caches and native contextual-inference memoization between rounds, retaining resolved types and instantiated signatures.',
  results,
}, null, 2) + '\n');
