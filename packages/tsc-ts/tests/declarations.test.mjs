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

test(
  'expando assignments with late-bound names in a script match tsgo',
  { skip: !existsSync(tsgo) && 'needs packages/tsgo/dist/tsgo' },
  async () => {
    // Without type checking, nothing has bound the host functions' members before declaration emit.
    // tsgo needs JavaScript output here: with --emitDeclarationOnly it panics.
    const dir = tempDir('tsc-ts-declarations-expando-');
    const source = join(dir, 'a.ts');
    writeFileSync(
      source,
      [
        'const t = "test" as const;',
        'const k = "key";',
        'const f = () => {};',
        'f[t] = true;',
        'function g() {}',
        'g[t] = "s";',
        'const h = function () {};',
        'h[k] = 1;',
        'h[k] = 2;',
        'h.other = f[t];',
        '',
      ].join('\n'),
    );
    const args = [...baseFlags, '--declaration', '--rootDir', dir];
    const [theirs, mine] = await Promise.all([
      run([tsgo, ...args, '--outDir', join(dir, 'expected'), source]),
      run([...command, ...args, '--outDir', join(dir, 'actual'), source]),
    ]);
    assert.equal(mine.stderr.toString(), '');
    // The emit driver doesn't report the missing global types --noLib causes.
    const errors = (r) =>
      r.stdout
        .toString()
        .split('\n')
        .filter((line) => line !== '' && !line.includes('TS2318'));
    assert.deepEqual(errors(mine), errors(theirs));
    const expected = readFileSync(join(dir, 'expected/a.d.ts'), 'utf8');
    assert.match(expected, /declare namespace f \{\n {4}var test: boolean;\n\}/);
    assert.equal(readFileSync(join(dir, 'actual/a.d.ts'), 'utf8'), expected);
  },
);

/** Emits declarations for `files` (name to lines) with tsgo and tsc-ts, and returns both outputs of `name`. */
async function emitBoth(files, name, flags) {
  const dir = tempDir('tsc-ts-declarations-undefined-');
  const sources = Object.entries(files).map(([file, lines]) => {
    writeFileSync(join(dir, file), [...lines, ''].join('\n'));
    return join(dir, file);
  });
  const args = [...flags, '--declaration', '--emitDeclarationOnly', '--rootDir', dir];
  const [, mine] = await Promise.all([
    run([tsgo, ...args, '--outDir', join(dir, 'expected'), ...sources]),
    run([...command, ...args, '--outDir', join(dir, 'actual'), ...sources]),
  ]);
  assert.equal(mine.stderr.toString(), '');
  const read = (out) => readFileSync(join(dir, out, name), 'utf8');
  return { expected: read('expected'), actual: read('actual') };
}

test(
  'a literal that subtype reduction drops gives no property to a missing name',
  { skip: !existsSync(tsgo) && 'needs packages/tsgo/dist/tsgo' },
  async () => {
    // The return type drops the third literal, whose widened type is the first one's, so the second
    // literal's `after?: undefined` and `text?: undefined` take the first literal's properties and come
    // before its own (the third literal's would come after them).
    const { expected, actual } = await emitBoth(
      {
        'a.ts': [
          'export enum E { A, B, C }',
          'export function rule(x: number) {',
          "  if (x === 0) return { before: 'a', after: 'b', action: { kind: E.C, text: ' * ' } };",
          "  if (x === 1) return { previous: 'c', before: 'd', action: { kind: E.B } };",
          "  return { before: 'e', after: 'f', action: { kind: E.C, text: '\\t' } };",
          '}',
        ],
      },
      'a.d.ts',
      baseFlags,
    );
    assert.match(expected, /\| \{\n {4}after\?: undefined;\n {4}previous: string;/);
    assert.match(expected, /action: \{\n {8}text\?: undefined;\n {8}kind: E;/);
    assert.equal(actual, expected);
  },
);

test(
  'optional undefined properties of widened object literals are ordered as in tsgo',
  { skip: !existsSync(tsgo) && 'needs packages/tsgo/dist/tsgo' },
  async () => {
    // A property added for a sibling literal takes the declarations of the property of that name in
    // the file's first union that lacks it in a literal, and is ordered by that one's declaration.
    // `o` is not a union, so g1's `a` comes after its `b`.
    const { expected, actual } = await emitBoth(
      {
        'a.ts': [
          'export const o = { a: 1, d: 1 };',
          'export function g1(x: boolean) {',
          '  if (x) return { b: 1 };',
          '  return { a: 1, b: 2 };',
          '}',
          'export function g2(x: boolean) {',
          '  if (x) return { b: 1 };',
          '  return { b: 2, a: 1 };',
          '}',
          'export function g3(x: boolean) {',
          '  if (x) return { b: 1, c: 1 };',
          '  return { a: 1, c: 2, d: 3, b: 2 };',
          '}',
          'export const g4 = (x: boolean) => (x ? [{ e: { f: 1 } }, { e: {} }] : { e: { g: 1, f: 2 } });',
        ],
      },
      'a.d.ts',
      baseFlags,
    );
    assert.match(expected, /g1\(x: boolean\): \{\n {4}b: number;\n {4}a\?: undefined;/);
    // In g2, `a` comes first: it is g1's `a`, declared before g2's `b`.
    assert.match(expected, /g2\(x: boolean\): \{\n {4}a\?: undefined;\n {4}b: number;/);
    assert.equal(actual, expected);
  },
);

test(
  'optional undefined properties of widened object literals follow the functions a returned call infers first',
  { skip: !existsSync(tsgo) && 'needs packages/tsgo/dist/tsgo' },
  async () => {
    // f1's return type needs g3's, so g3's `a` comes first and g2's `a?: undefined` follows g2's `b`.
    // R.get returns this.later() first, so later's `z` comes first.
    const { expected, actual } = await emitBoth(
      {
        'a.ts': [
          'export function f1(x: boolean) {',
          '  return g3(x);',
          '}',
          'export function g2(x: boolean) {',
          '  if (x) return { b: 1 };',
          '  return { b: 2, a: 1 };',
          '}',
          'export function g3(x: boolean) {',
          '  if (x) return { c: 1 };',
          '  return { c: 2, a: 1 };',
          '}',
          'export class R {',
          '  get = (x: boolean) => {',
          '    if (x) return this.later();',
          '    return this.earlier();',
          '  };',
          '  earlier = () => [{ s: 1 }, { s: 2, z: 0 }];',
          '  later = () => [{ t: 1 }, { t: 2, z: 0 }];',
          '}',
        ],
      },
      'a.d.ts',
      baseFlags,
    );
    assert.match(expected, /g3\(x: boolean\): \{\n {4}c: number;\n {4}a\?: undefined;/);
    assert.equal(actual, expected);
  },
);

test(
  'optional undefined properties of widened object literals follow calls of the functions their names resolve to',
  { skip: !existsSync(tsgo) && 'needs packages/tsgo/dist/tsgo' },
  async () => {
    const g2g3 = [
      'export function g2(x: boolean) {',
      '  if (x) return { b: 1 };',
      '  return { b: 2, a: 1 };',
      '}',
      'export function g3(x: boolean) {',
      '  if (x) return { c: 1 };',
      '  return { c: 2, a: 1 };',
      '}',
    ];
    // f1's `g3` is its parameter, so g2 comes first.
    const shadowed = await emitBoth(
      {
        'a.ts': ['export function f1(g3: (x: boolean) => { c: number }) {', '  return g3(true);', '}', ...g2g3],
      },
      'a.d.ts',
      baseFlags,
    );
    assert.match(shadowed.expected, /g3\(x: boolean\): \{\n {4}a\?: undefined;\n {4}c: number;/);
    assert.equal(shadowed.actual, shadowed.expected);
    // v's initializer infers g2 before f1 infers g3.
    const initializer = await emitBoth(
      {
        'a.ts': ['export const v = g2(true);', 'export function f1(x: boolean) {', '  return g3(x);', '}', ...g2g3],
      },
      'a.d.ts',
      baseFlags,
    );
    assert.match(initializer.expected, /g3\(x: boolean\): \{\n {4}a\?: undefined;\n {4}c: number;/);
    assert.equal(initializer.actual, initializer.expected);
    // f1's type parameter `g3` and type alias `g2` don't hide the functions, so f1 infers g3 first.
    const types = await emitBoth(
      {
        'a.ts': ['export function f1<g3>(x: boolean) {', '  type g2 = number;', '  return g3(x);', '}', ...g2g3],
      },
      'a.d.ts',
      baseFlags,
    );
    assert.match(types.expected, /g3\(x: boolean\): \{\n {4}c: number;\n {4}a\?: undefined;/);
    assert.equal(types.actual, types.expected);
  },
);

test(
  'optional undefined properties of widened object literals keep their order when an importer infers a later function first',
  { skip: !existsSync(tsgo) && 'needs packages/tsgo/dist/tsgo' },
  async () => {
    // b.ts imports a.ts, which imports b.ts, so b.ts comes first and its declarations infer g2
    // before g1. tsgo checks each file on its own checker, from the top.
    const { expected, actual } = await emitBoth(
      {
        'a.ts': [
          'import { r } from "./b";',
          'export function g1(x: boolean) {',
          '  if (x) return { b: 1 };',
          '  return { a: 1, b: 2 };',
          '}',
          'export function g2(x: boolean) {',
          '  if (x) return { b: 1 };',
          '  return { b: 2, a: 1 };',
          '}',
          'export const q = r;',
        ],
        'b.ts': ['import { g2 } from "./a";', 'export const r = g2(true);'],
      },
      'a.d.ts',
      baseFlags.filter((flag) => flag !== '--noResolve'),
    );
    assert.match(expected, /g2\(x: boolean\): \{\n {4}a\?: undefined;\n {4}b: number;/);
    assert.equal(actual, expected);
  },
);

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
