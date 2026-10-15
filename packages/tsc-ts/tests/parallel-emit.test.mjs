// Emit with checker threads (parallel-check.ts `checkersEmit`) writes what one checker writes: each
// checker emits the files it checks, the main thread the files no checker checks (JSON, unchecked
// JavaScript), and the program reports the files in program order with the same diagnostics. Runs the
// tsc-ts under test (the Node build, or TSC_TS_BIN) with --singleThreaded and with checker threads in
// one directory, and compares stdout (with --listEmittedFiles), the exit status and every output.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { tempDir } from './temp.mjs';
import { tscTs, tscTsMissing } from './toolchain.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const bundledLibs = join(resolve(here, '../../..'), 'upstream/typescript-go/internal/bundled/libs');

const files = {
  'src/shapes.ts':
    'export interface Shape { kind: string; size: number }\n' +
    'export const shapes = [{ kind: "a", size: 1 }, { kind: "b", size: 2, extra: true }];\n',
  'src/area.ts':
    'import { Shape, shapes } from "./shapes";\nexport function area(s: Shape) { return s.size * 2; }\n' +
    'export const total = shapes.map(area).reduce((a, b) => a + b, 0);\n',
  'src/hidden.ts': 'export const instance = new (class { private secret = 1; open = 2 })();\n',
  'src/wrong.ts': 'export const n: number = "not a number";\n',
  'src/decorated.ts':
    'declare function d(...args: any[]): any;\nexport type Name = `n${string}`;\n' +
    'export class Model { @d name!: Name; @d run(@d at: Date): Promise<void> { return Promise.resolve(); } }\n',
  'src/data.json': '{ "name": "data", "values": [1, 2, 3] }\n',
  'src/plain.js': 'export function plain(a) { return a + 1; }\n',
  'src/index.ts':
    'import data from "./data.json";\nimport { plain } from "./plain.js";\nimport { total } from "./area";\n' +
    'export * from "./hidden";\nexport * from "./decorated";\n' +
    'export const summary = { name: data.name, total, next: plain(total) };\n',
  'tsconfig.json': JSON.stringify({
    compilerOptions: {
      target: 'ES2022',
      strict: true,
      types: [],
      module: 'commonjs',
      esModuleInterop: true,
      resolveJsonModule: true,
      allowJs: true,
      experimentalDecorators: true,
      emitDecoratorMetadata: true,
      declaration: true,
      declarationMap: true,
      sourceMap: true,
      listEmittedFiles: true,
      rootDir: 'src',
      outDir: 'out',
    },
    include: ['src'],
  }),
};

function readOutputs(dir, root = dir, outputs = {}) {
  if (!existsSync(dir)) return outputs;
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) readOutputs(path, root, outputs);
    else outputs[relative(root, path)] = readFileSync(path, 'utf8');
  }
  return outputs;
}

function run(cwd, args) {
  rmSync(join(cwd, 'out'), { recursive: true, force: true });
  let stdout;
  let status = 0;
  try {
    stdout = execFileSync(tscTs[0], [...tscTs.slice(1), '-p', '.', '--pretty', 'false', ...args], {
      cwd,
      env: { PATH: process.env.PATH ?? '', TSC_TS_LIB_DIR: bundledLibs },
      encoding: 'utf8',
    });
  } catch (error) {
    stdout = error.stdout;
    status = error.status;
  }
  return { stdout, status, outputs: readOutputs(join(cwd, 'out')) };
}

test('emit on checker threads matches emit on one checker', { skip: tscTsMissing }, () => {
  const cwd = tempDir('tsc-ts-parallel-emit-');
  for (const [path, content] of Object.entries(files)) {
    mkdirSync(dirname(join(cwd, path)), { recursive: true });
    writeFileSync(join(cwd, path), content);
  }
  const expected = run(cwd, ['--singleThreaded']);
  assert.ok(expected.stdout.includes('TS4094'), 'a declaration error is reported');
  assert.ok(expected.stdout.includes('TS2322'), 'a type error is reported');
  assert.equal(Object.keys(expected.outputs).length, 27);
  for (const checkers of ['3']) {
    const actual = run(cwd, ['--checkers', checkers]);
    assert.equal(actual.stdout, expected.stdout, `stdout with --checkers ${checkers}`);
    assert.equal(actual.status, expected.status, `status with --checkers ${checkers}`);
    assert.deepEqual(actual.outputs, expected.outputs, `outputs with --checkers ${checkers}`);
  }
});
