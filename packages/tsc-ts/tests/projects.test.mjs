// Compiles small projects reduced from real-world code through tsgo (packages/tsgo/dist/tsgo) and
// tsc-ts (the Node build, or TSC_TS_BIN), and compares stdout, stderr and exit status.
// Set PROJECTS_FILTER to a substring of project names to run only those.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { tempDir } from './temp.mjs';
import { tscTs, tscTsMissing } from './toolchain.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, '../../..');
const tsgo = join(root, 'packages/tsgo/dist/tsgo');
const bundledLibs = join(root, 'upstream/typescript-go/internal/bundled/libs');
const skip = (!existsSync(tsgo) && 'needs packages/tsgo/dist/tsgo') || tscTsMissing;

const base = { target: 'ES2022', strict: true, noEmit: true, types: [] };

const nestedKeyOf =
  'export type NestedKeyOf<T, K = keyof T> = K extends keyof T & (string | number)\n' +
  '  ? `${K}` | (T[K] extends object ? `${K}.${NestedKeyOf<T[K]>}` : never)\n' +
  '  : never;\n';

/** Projects as `[name, files, args]`; files without a tsconfig.json get one with `base` options. */
const projects = [
  [
    'JSON default import',
    {
      'a.ts':
        'import data from "./data.json";\nimport * as ns from "./data.json";\n' +
        'export const n: number = data;\nexport const m: number = ns.labels.paste;\n',
      'data.json': '{ "labels": { "paste": "Paste", "count": 1 }, "list": [1, 2] }\n',
      'tsconfig.json': JSON.stringify({
        compilerOptions: { ...base, module: 'ESNext', moduleResolution: 'bundler', resolveJsonModule: true },
        files: ['a.ts'],
      }),
    },
  ],
  [
    'nested keys of a JSON module',
    {
      'a.ts':
        'import data from "./en.json";\n' +
        nestedKeyOf +
        'export type Keys = NestedKeyOf<typeof data>;\n' +
        'export const t = (path: Keys) => path;\nt("labels.paste");\nt("labels.missing");\n',
      'en.json': '{ "labels": { "paste": "Paste", "copy": "Copy" }, "empty": {}, "title": "Title" }\n',
      'tsconfig.json': JSON.stringify({
        compilerOptions: { ...base, module: 'ESNext', moduleResolution: 'bundler', resolveJsonModule: true },
        files: ['a.ts'],
      }),
    },
  ],
  [
    'object literal returned by a contextually generic arrow',
    {
      'a.ts':
        'declare function walker<N>(visit: <U>(f: (data: N) => U) => { get: () => U[] }): N;\n' +
        'export const make = <N>(m: <U>(f: (data: N) => U) => U[]): N =>\n' +
        '  walker((f) => ({ get: () => m((data) => f(data)) }));\n' +
        'export const wrong = <N>(m: <U>(f: (data: N) => U) => U[]): N =>\n' +
        '  walker((f) => ({ get: () => m((data) => String(f(data))) }));\n',
    },
  ],
  [
    'iterable walker built from a generic iterator factory',
    {
      'a.ts':
        'export class Walker<T, N> {\n' +
        '  constructor(readonly visit: <U>(f: (index: T, data: N) => U) => Iterable<U>) {}\n' +
        '}\n' +
        'export const walk = <N>(\n' +
        '  make: <U>(f: (index: number, data: N) => U) => Iterator<U>,\n' +
        '): Walker<number, N> =>\n' +
        '  new Walker((f) => ({ [Symbol.iterator]: () => make((index, data) => f(index, data)) }));\n' +
        'export const nodes = <N>(data: N[]): Walker<number, N> =>\n' +
        '  walk<N>((f) => {\n' +
        '    let i = 0;\n' +
        '    return {\n' +
        '      next() {\n' +
        '        if (i < data.length) return { done: false, value: f(i, data[i++]!) };\n' +
        '        return { done: true, value: undefined } as const;\n' +
        '      },\n' +
        '    };\n' +
        '  });\n',
      'tsconfig.json': JSON.stringify({
        compilerOptions: { ...base, lib: ['ES2022'], exactOptionalPropertyTypes: true },
        files: ['a.ts'],
      }),
    },
  ],
  [
    'asserted unique symbol in an inferred object literal',
    {
      'a.ts':
        'export const TypeId: unique symbol = Symbol.for("x");\n' +
        'export type TypeId = typeof TypeId;\n' +
        'interface Client { readonly [TypeId]: TypeId; config: string; other: number }\n' +
        'declare function identity<A>(a: A): A;\n' +
        'declare function assign<T, U>(t: T, u: U): T & U;\n' +
        'declare const base: { other: number };\n' +
        'export const c = identity<Client>(assign(base, { [TypeId]: TypeId as TypeId, config: "x" }));\n' +
        'export const d = identity<Client>(assign(base, { [TypeId]: (<TypeId>TypeId), config: "x" }));\n' +
        'export const e = identity<Client>(assign(base, { [TypeId]: TypeId, config: "x" }));\n' +
        'export const f = assign(base, { n: 1 as 1, s: "s" as "s" });\n' +
        'export const g: { n: 1 } = f;\n',
      'tsconfig.json': JSON.stringify({ compilerOptions: { ...base, lib: ['ES2022'] }, files: ['a.ts'] }),
    },
  ],
  [
    'narrowing a NoInfer parameter',
    {
      'a.ts':
        'declare function transform<T, E>(o: { readonly decode: (input: E) => T }): { readonly decode: (e: E) => T };\n' +
        'type Decode<E, T> = { readonly decode: (e: NoInfer<E>) => NoInfer<T> };\n' +
        'export const x: Decode<ArrayBuffer | Uint8Array, Uint8Array> = transform({\n' +
        '  decode: (value) => (value instanceof ArrayBuffer ? new Uint8Array(value) : value),\n' +
        '});\n' +
        'export const y: Decode<ArrayBuffer | Uint8Array, Uint8Array> = transform({ decode: (value) => value });\n' +
        'export function f<T>(v: NoInfer<T | undefined>, d: T): T {\n' +
        '  return v === undefined ? d : v;\n' +
        '}\n',
      'tsconfig.json': JSON.stringify({ compilerOptions: { ...base, lib: ['ES2022'] }, files: ['a.ts'] }),
    },
  ],
  [
    'JSON required from checked JavaScript',
    {
      'a.js':
        'const data = require("./data.json");\n/** @type {number} */\nconst n = data.name;\nmodule.exports = n;\n',
      'data.json': '{ "name": "x", "version": 1 }\n',
      'empty.json': '',
      'tsconfig.json': JSON.stringify({
        compilerOptions: {
          ...base,
          module: 'CommonJS',
          allowJs: true,
          checkJs: true,
          resolveJsonModule: true,
        },
        files: ['a.js'],
      }),
    },
  ],
];

function writeFiles(dir, files) {
  for (const [path, content] of Object.entries(files)) {
    mkdirSync(dirname(join(dir, path)), { recursive: true });
    writeFileSync(join(dir, path), content);
  }
}

function run(command, files, args) {
  const cwd = tempDir('tsc-ts-projects-');
  writeFiles(cwd, files);
  const env = { PATH: process.env.PATH ?? '', TSC_TS_LIB_DIR: bundledLibs, NO_COLOR: '1' };
  return new Promise((done) => {
    execFile(
      command[0],
      [...command.slice(1), '-p', '.', '--pretty', 'false', ...args],
      { cwd, env, encoding: 'utf8', maxBuffer: 1 << 26 },
      (error, stdout, stderr) => {
        done({ stdout, stderr, status: error ? (typeof error.code === 'number' ? error.code : -1) : 0 });
      },
    );
  });
}

test('projects reduced from real-world code match tsgo', { skip, timeout: 300_000 }, async () => {
  const filter = process.env.PROJECTS_FILTER;
  const failures = [];
  await Promise.all(
    projects
      .filter(([name]) => filter === undefined || name.includes(filter))
      .map(async ([name, source, args = []]) => {
        const files =
          'tsconfig.json' in source
            ? source
            : { ...source, 'tsconfig.json': JSON.stringify({ compilerOptions: base }) };
        const [expected, actual] = await Promise.all([run([tsgo], files, args), run(tscTs, files, args)]);
        const problems = [];
        if (expected.stdout !== actual.stdout)
          problems.push(`stdout\n  tsgo: ${expected.stdout}\n  ours: ${actual.stdout}`);
        if (expected.stderr !== actual.stderr)
          problems.push(`stderr\n  tsgo: ${expected.stderr}\n  ours: ${actual.stderr}`);
        if (expected.status !== actual.status) problems.push(`status tsgo ${expected.status}, ours ${actual.status}`);
        if (problems.length > 0) failures.push(`${name}: ${problems.join('\n')}`);
      }),
  );
  assert.deepEqual(failures, []);
});
