import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { compiledDir } from './temp.mjs';

const root = resolve(import.meta.dirname, '..');
const repo = resolve(root, '../..');
const libs = join(repo, 'upstream/typescript-go/internal/bundled/libs');
const oracle = join(repo, 'packages/tsgo/dist/check-oracle');

const cases = [
  {
    name: 'assignability, missing properties and arity',
    source: [
      'let x: number = "a";',
      'const y = { a: 1, b: "x" };',
      'y.c;',
      'function f(a: number, b: string): number { return a; }',
      'f(1);',
      'f(1, 2);',
      'const s: string = f(1, "a");',
      'class C { p: number; m() { return this.p; } }',
      'new C().m().toFixed();',
      '[1, 2].map(v => v.toFixed());',
    ],
    expected: [
      "/input.ts 2322 4 1 Type 'string' is not assignable to type 'number'.",
      "/input.ts 2339 51 1 Property 'c' does not exist on type '{ a: number; b: string; }'.",
      '/input.ts 2554 109 1 Expected 2 arguments, but got 1.',
      "/input.ts 2345 120 1 Argument of type 'number' is not assignable to parameter of type 'string'.",
      "/input.ts 2322 130 1 Type 'number' is not assignable to type 'string'.",
      "/input.ts 2564 163 1 Property 'p' has no initializer and is not definitely assigned in the constructor.",
    ],
  },
  {
    name: 'narrowing and definite assignment',
    source: [
      'declare const a: string | undefined;',
      'if (a) a.length;',
      'a.length;',
      'let b: number;',
      'b.toFixed();',
      'function f(x: string | number) {',
      '  if (typeof x === "string") return x.length;',
      '  return x.toFixed();',
      '}',
      'type S = { kind: "a"; a: number } | { kind: "b"; b: string };',
      'function g(s: S) {',
      '  switch (s.kind) {',
      '    case "a": return s.a;',
      '    case "b": return s.b;',
      '  }',
      '}',
    ],
    expected: [
      "/input.ts 18048 54 1 'a' is possibly 'undefined'.",
      "/input.ts 2454 79 1 Variable 'b' is used before being assigned.",
    ],
  },
  {
    name: 'unresolved names with suggestions',
    source: ['const count = 1;', 'cuont;'],
    expected: ["/input.ts 2552 17 5 Cannot find name 'cuont'. Did you mean 'count'?"],
  },
];

test(
  'checker matches tsgo on small cases',
  { skip: !existsSync(libs) && 'needs upstream sources', timeout: 300_000 },
  () => {
    const out = compiledDir('tsc-ts-check-');
    execFileSync(
      join(repo, 'node_modules/.bin/tsc'),
      [
        '--outDir',
        out,
        '--strict',
        '--target',
        'es2024',
        '--module',
        'nodenext',
        '--moduleResolution',
        'nodenext',
        '--types',
        'node',
        '--skipLibCheck',
        join(root, 'src/drivers/check.ts'),
      ],
      { stdio: 'inherit' },
    );
    for (const { name, source, expected } of cases) {
      const file = join(out, 'input.ts');
      writeFileSync(file, source.join('\n') + '\n');
      const actual = execFileSync(process.execPath, ['--stack-size=16000', join(out, 'drivers/check.js'), file, libs], {
        encoding: 'utf8',
      });
      const lines = actual.split('\n').filter((l) => l !== '');
      assert.deepEqual(lines, expected, name);
      if (existsSync(oracle)) {
        const reference = execFileSync(oracle, [file, libs], { encoding: 'utf8' })
          .split('\n')
          .filter((l) => l !== '');
        assert.deepEqual(lines, reference, name + ' (oracle)');
      }
    }
  },
);
