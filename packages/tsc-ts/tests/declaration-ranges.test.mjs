// Checker threads check a large declaration file in statement ranges (parallel-check.ts `rangeUnits`). A file whose
// ranges find no diagnostics has none; otherwise it is checked whole, since the diagnostics of ranges can differ from
// the file's. TSC_TS_RANGES=all checks every checked declaration file in ranges, so these small projects go through
// the same paths as lib.dom.d.ts in a small program, and must report what tsgo reports.
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

const options = { target: 'ES2022', strict: true, noEmit: true, types: [], skipDefaultLibCheck: true };

/** `count` declarations that check cleanly, to spread a file's statements over several ranges. */
function filler(prefix, count) {
  let text = '';
  for (let i = 0; i < count; i++)
    text += `interface ${prefix}${i} extends ${prefix}Base { value${i}: ${prefix}${i > 0 ? i - 1 : 'Base'} }\n`;
  return `interface ${prefix}Base { id: number }\n${text}`;
}

/** Projects as `[name, files]`, each checked with `options` unless it has its own tsconfig.json. */
const projects = [
  [
    'a declaration file without diagnostics',
    { 'types.d.ts': filler('A', 200), 'a.ts': 'export const n: number = 1;\n' },
  ],
  [
    'an error in a file next to a declaration file without diagnostics',
    { 'types.d.ts': filler('A', 200), 'a.ts': 'declare const x: A199;\nexport const n: string = x.value199.id;\n' },
  ],
  [
    'a union whose members print in the order the checker created them',
    {
      'types.d.ts':
        'declare const early: 3n;\n' +
        filler('B', 100) +
        'interface G<T extends 1n | 2n | 3n> { t: T }\n' +
        filler('C', 100) +
        'type Bad = G<0n>;\n',
      'a.ts': 'export {};\n',
    },
  ],
  [
    'a check that the first of merged declarations runs, which reports on all of them',
    {
      'types.d.ts': 'export interface I { a: number }\n' + filler('D', 150) + 'interface I { b: number }\n',
      'a.ts': 'import type { I } from "./types";\nexport const i: I = { a: 1, b: 2 };\n',
    },
  ],
  [
    'an unused @ts-expect-error in a declaration file without other diagnostics',
    {
      'types.d.ts': filler('E', 100) + '// @ts-expect-error\ninterface Fine { ok: true }\n' + filler('F', 100),
      'a.ts': 'export {};\n',
    },
  ],
];

function run(command, files, extraArgs, env) {
  const cwd = tempDir('tsc-ts-declaration-ranges-');
  for (const [path, content] of Object.entries(files)) {
    mkdirSync(dirname(join(cwd, path)), { recursive: true });
    writeFileSync(join(cwd, path), content);
  }
  return new Promise((done) => {
    execFile(
      command[0],
      [...command.slice(1), '-p', '.', '--pretty', 'false', ...extraArgs],
      {
        cwd,
        env: { PATH: process.env.PATH ?? '', TSC_TS_LIB_DIR: bundledLibs, NO_COLOR: '1', ...env },
        encoding: 'utf8',
      },
      (error, stdout, stderr) =>
        done({ stdout, stderr, status: error ? (typeof error.code === 'number' ? error.code : -1) : 0 }),
    );
  });
}

test('declaration files checked in statement ranges report what tsgo reports', { skip, timeout: 300_000 }, async () => {
  const failures = [];
  await Promise.all(
    projects.map(async ([name, source]) => {
      const files = { ...source, 'tsconfig.json': JSON.stringify({ compilerOptions: options }) };
      const expected = await run([tsgo], files, [], {});
      for (const checkers of ['1', '4']) {
        const actual = await run(tscTs, files, ['--checkers', checkers], { TSC_TS_RANGES: 'all' });
        if (expected.stdout !== actual.stdout || expected.status !== actual.status)
          failures.push(
            `${name} (--checkers ${checkers}):\n  tsgo ${expected.status}: ${expected.stdout}\n  ours ${actual.status}: ${actual.stdout}${actual.stderr}`,
          );
      }
    }),
  );
  assert.deepEqual(failures, []);
});
