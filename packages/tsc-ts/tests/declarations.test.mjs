import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { cases, listFiles, materialize, run } from './parser-cases.mjs';
import { baseFlags, buildEmitDriver, emittable, tsgo } from './emit-cases.mjs';
import { compareDeclarations, declarationFlagSets, summarize } from './declaration-cases.mjs';
import { tempDir } from './temp.mjs';

const command = buildEmitDriver();

/** Emits declarations for `files` (name to text) and returns the outputs and stdout. */
async function emit(files, flags = []) {
  const dir = tempDir('tsc-ts-declarations-test-');
  const paths = [];
  for (const [name, text] of Object.entries(files)) {
    const path = join(dir, 'src', name);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, text);
    paths.push(path);
  }
  const out = join(dir, 'out');
  const args = [...baseFlags, '--declaration', '--emitDeclarationOnly', ...flags, '--rootDir', join(dir, 'src')];
  const result = await run([...command, ...args, '--outDir', out, ...paths]);
  const read = (name) => {
    const path = join(out, name);
    return existsSync(path) ? readFileSync(path, 'utf8') : undefined;
  };
  return { read, stdout: result.stdout.toString() };
}

test('declarations keep exported shapes and drop implementations', async () => {
  const { read } = await emit({
    'a.ts': [
      'import { Foo } from "./foo";',
      'import type { Bar } from "./bar";',
      'interface Hidden { x: number }',
      'export function f(a: Foo, b = 1): Hidden { return null as any; }',
      "export const c = 1, d = 's', e = -1n, h = 0x10, i = `t`;",
      'export let g = { a: 1, b: [1, 2] as const };',
      'export class K { private x = 1; #y = 2; constructor(public p: string, private q?: number) {} get z(): number { return 1 } set z(v) {} m() { return 1 } }',
      'export default function () {}',
      'namespace N { export const x: number = 1; }',
      '/** doc */',
      'export type T<U> = U[];',
      '',
    ].join('\n'),
  });
  assert.equal(
    read('a.d.ts'),
    [
      'import { Foo } from "./foo";',
      'interface Hidden {',
      '    x: number;',
      '}',
      'export declare function f(a: Foo, b?: number): Hidden;',
      'export declare const c = 1, d = "s", e = -1n, h = 16, i = "t";',
      'export declare let g: {',
      '    a: number;',
      '    b: readonly [1, 2];',
      '};',
      'export declare class K {',
      '    #private;',
      '    p: string;',
      '    private q?;',
      '    private x;',
      '    constructor(p: string, q?: number | undefined);',
      '    get z(): number;',
      '    set z(v: number);',
      '    m(): number;',
      '}',
      'export default function (): void;',
      '/** doc */',
      'export type T<U> = U[];',
      'export {};',
      '',
    ].join('\n'),
  );
});

test('declarations write inferred types from the checker', async () => {
  const { read, stdout } = await emit({
    'e.ts': [
      'function make() { return { a: 1, b: "x" }; }',
      'export const made = make();',
      'export function pick(x: number) { return x > 1 ? "a" : 3; }',
      'class Hidden {}',
      'export const hidden = new Hidden();',
      'export const tuple = [1, "s"] as const;',
      '',
    ].join('\n'),
  });
  assert.equal(
    read('e.d.ts'),
    [
      'export declare const made: {',
      '    a: number;',
      '    b: string;',
      '};',
      'export declare function pick(x: number): "a" | 3;',
      'declare class Hidden {',
      '}',
      'export declare const hidden: Hidden;',
      'export declare const tuple: readonly [1, "s"];',
      'export {};',
      '',
    ].join('\n'),
  );
  assert.equal(stdout, '');
});

test('declarations evaluate enums and keep overload signatures', async () => {
  const { read } = await emit({
    'b.ts': [
      'export enum E { A = 1, B, C = A << 2, D = "x".length, F = "s" }',
      'function g(a: string): string;',
      'function g(a: number): number;',
      'function g(a: any) { return a; }',
      'export { g };',
      'export declare namespace M { const z: number; }',
      '',
    ].join('\n'),
  });
  assert.equal(
    read('b.d.ts'),
    [
      'export declare enum E {',
      '    A = 1,',
      '    B = 2,',
      '    C = 4,',
      '    D,',
      '    F = "s"',
      '}',
      'declare function g(a: string): string;',
      'declare function g(a: number): number;',
      'export { g };',
      'export declare namespace M {',
      '    const z: number;',
      '}',
      '',
    ].join('\n'),
  );
});

test('isolatedDeclarations reports types that need inference and blocks the output', async () => {
  const { read, stdout } = await emit(
    { 'c.ts': 'export function f() { return Math.random(); }\nexport const ok = 1;\n' },
    ['--isolatedDeclarations'],
  );
  assert.equal(read('c.d.ts'), undefined);
  // As tsgo: the returned expression is what needs inference.
  assert.match(stdout, /c\.ts\(1,30\): error TS9013: Expression type can't be inferred with --isolatedDeclarations/);
});

test('stripInternal removes @internal declarations', async () => {
  const { read } = await emit(
    {
      'd.ts':
        'export interface I {\n    /** @internal */ hidden: string;\n    shown: number;\n}\n/** @internal */\nexport function f(): void {}\n',
    },
    ['--stripInternal'],
  );
  assert.equal(read('d.d.ts'), 'export interface I {\n    shown: number;\n}\n');
});

// Every 25th test case.
function sample() {
  return [...listFiles(join(cases, 'compiler')), ...listFiles(join(cases, 'conformance'))].filter(
    (_, i) => i % 25 === 0,
  );
}

test(
  'declarations match tsgo on test cases',
  { skip: (!existsSync(tsgo) || !existsSync(cases)) && 'needs upstream sources and tsgo' },
  async () => {
    const units = materialize(sample(), 'tsc-ts-declarations-test-').paths.filter((unit) => emittable.test(unit.path));
    const root = dirname(dirname(units[0].path));
    const paths = units.map((unit) => unit.path);
    for (const [label, flags] of declarationFlagSets) {
      const s = summarize(await compareDeclarations(command, root, paths, flags, 8));
      assert.ok(s.compared > 500, `${label}: enough units`);
      assert.ok(s.matched >= s.compared * 0.97, `${label}: ${s.matched}/${s.compared} match: ${s.failures.join(', ')}`);
      assert.ok(s.errorsMatched >= s.compared * 0.98, `${label}: ${s.errorFailures.join(', ')}`);
    }
  },
);
