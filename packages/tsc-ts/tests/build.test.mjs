// Runs `tsc --build`, `--incremental` and related scenarios through tsgo (packages/tsgo/dist/tsgo) and tsc-ts
// (the Node build, or TSC_TS_BIN), step by step in two copies of a project, and compares output, exit status and
// every file afterwards, .tsbuildinfo included. Times in status lines are masked, as are statistics values.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, utimesSync, writeFileSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { tempDir } from './temp.mjs';
import { tscTs, tscTsMissing } from './toolchain.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, '../../..');
const tsgo = join(root, 'packages/tsgo/dist/tsgo');
const bundledLibs = join(root, 'upstream/typescript-go/internal/bundled/libs');
const skip = (!existsSync(tsgo) && 'needs packages/tsgo/dist/tsgo') || tscTsMissing;

/**
 * @typedef {{ args: string[], edit?: Record<string, string | null>, touch?: string[], cwd?: string }} Step
 * @typedef {{ files: Record<string, string>, steps: Step[] }} Scenario
 */

/** @type {Record<string, Scenario>} */
const scenarios = {
  'references with --verbose, --force, --dry and --clean': {
    files: {
      'a/tsconfig.json': '{"compilerOptions":{"composite":true,"outDir":"out"},"files":["index.ts"]}',
      'a/index.ts': 'export const a: number = 1;\n',
      'b/tsconfig.json': '{"compilerOptions":{"outDir":"out"},"references":[{"path":"../a"}],"files":["index.ts"]}',
      'b/index.ts': 'import { a } from "../a/index";\nexport const b: number = a + 1;\n',
    },
    steps: [
      { args: ['-b', 'b', '--verbose'] },
      { args: ['-b', 'b', '--verbose'] },
      {
        args: ['-b', 'b', '--verbose'],
        edit: { 'b/index.ts': 'import { a } from "../a/index";\nexport const b: string = a;\n' },
      },
      { args: ['-b', 'b', '--verbose'] },
      { args: ['-b', 'b', '-v'], edit: { 'b/index.ts': 'import { a } from "../a/index";\nexport const b = a;\n' } },
      { args: ['-b', 'b', '-v'], edit: { 'a/index.ts': 'export const a: number = 2;\n' } },
      { args: ['-b', 'b', '-v'], edit: { 'a/index.ts': 'export const a: number = 2;\n// changed\n' } },
      { args: ['-b', 'b', '--verbose', '--force'] },
      { args: ['-b', 'b', '--dry'] },
      { args: ['-b', 'b', '--clean', '--dry'] },
      { args: ['-b', 'b', '--clean'] },
      { args: ['-b', 'b', '--dry'] },
      { args: ['-b', 'b', '--pretty'] },
    ],
  },
  'upstream errors, --stopBuildOnErrors, solutions and missing references': {
    files: {
      'tsconfig.json': '{"files":[],"references":[{"path":"./b"},{"path":"./c"}]}',
      'a/tsconfig.json': '{"compilerOptions":{"composite":true},"files":["index.ts"]}',
      'a/index.ts': 'export const a: number = "one";\n',
      'b/tsconfig.json': '{"compilerOptions":{"composite":true},"references":[{"path":"../a"}],"files":["index.ts"]}',
      'b/index.ts': 'import { a } from "../a/index";\nexport const b: number = a;\n',
      'c/tsconfig.json': '{"references":[{"path":"../missing"}],"files":["index.ts"]}',
      'c/index.ts': 'export const c: number = 3;\n',
    },
    steps: [
      { args: ['-b', '-v'] },
      { args: ['-b', '-v', '--stopBuildOnErrors'] },
      { args: ['-b', '-v'], edit: { 'a/index.ts': 'export const a: number = 1;\n' } },
      { args: ['-b', '-v'] },
      { args: ['-b', 'missing', 'c'] },
    ],
  },
  'circular references': {
    files: {
      'a/tsconfig.json': '{"compilerOptions":{"composite":true},"references":[{"path":"../b"}],"files":["a.ts"]}',
      'a/a.ts': 'export const a = 1;\n',
      'b/tsconfig.json': '{"compilerOptions":{"composite":true},"references":[{"path":"../a"}],"files":["b.ts"]}',
      'b/b.ts': 'export const b = 1;\n',
    },
    steps: [{ args: ['-b', 'a', '-v'] }, { args: ['-b', 'a', 'b'] }],
  },
  'incremental emit, errors and option changes': {
    files: {
      'tsconfig.json':
        '{"compilerOptions":{"incremental":true,"outDir":"out","declaration":true,"strict":true},"include":["src"]}',
      'src/a.ts': 'export const a: number = 1;\nexport function f(x: number): number { return x; }\n',
      'src/b.ts': 'import { a, f } from "./a";\nexport const b: number = f(a);\nlet x: string = 1;\n',
      'src/c.ts': 'import { b } from "./b";\nexport const c: number = b;\n',
      'src/g.ts': 'declare const g: number;\n',
    },
    steps: [
      { args: ['--listEmittedFiles'] },
      { args: ['--listEmittedFiles'] },
      {
        args: ['--listEmittedFiles'],
        edit: { 'src/b.ts': 'import { a, f } from "./a";\nexport const b: number = f(a);\n' },
      },
      {
        args: ['--listEmittedFiles'],
        edit: {
          'src/a.ts': 'export const a: number = 1;\nexport function f(x: number): string { return String(x); }\n',
        },
      },
      { args: ['--listEmittedFiles'] },
      {
        args: ['--listEmittedFiles'],
        edit: { 'src/a.ts': 'export const a: number = 1;\nexport function f(x: number): number { return x; }\n// c\n' },
      },
      { args: ['--listEmittedFiles', '--sourceMap'] },
      { args: ['--listEmittedFiles'], edit: { 'src/g.ts': 'declare const g: string;\n' } },
      { args: ['--listEmittedFiles'], edit: { 'src/c.ts': null } },
      { args: ['--listEmittedFiles', '--noEmit'], edit: { 'src/c.ts': 'export const c: number = "x";\n' } },
      { args: ['--listEmittedFiles'] },
      { args: ['--listFiles', '--pretty'] },
    ],
  },
  'composite, node16 packages, tsBuildInfoFile and noEmitOnError': {
    files: {
      'tsconfig.json':
        '{"compilerOptions":{"composite":true,"module":"nodenext","declarationMap":true,' +
        '"tsBuildInfoFile":"build/info.json","noEmitOnError":true},"include":["*.ts","*.mts"]}',
      'package.json': '{"name":"p","type":"module"}',
      'node_modules/foo/package.json': '{"name":"foo","types":"index.d.ts"}',
      'node_modules/foo/index.d.ts': 'export declare const foo: number;\n',
      'a.ts': 'import { foo } from "foo";\nexport const enum E { A = 1 }\nexport const a: number = foo;\n',
      'b.ts':
        'import { E, a } from "./a.js";\nexport const b: number = E.A + a;\ndeclare module "foo" { export const z: 1; }\n',
      'c.mts': 'import type { b } from "./b.js";\nexport type C = typeof b;\n',
      'amb.d.ts': 'declare module "amb" { export const q: number; }\n',
    },
    steps: [
      { args: ['--listEmittedFiles'] },
      { args: ['--listEmittedFiles'] },
      {
        args: ['--listEmittedFiles'],
        edit: { 'a.ts': 'import { foo } from "foo";\nexport const enum E { A = 2 }\nexport const a: number = foo;\n' },
      },
      {
        args: ['--listEmittedFiles'],
        edit: {
          'c.mts':
            'import type { b } from "./b.js";\nexport type C = typeof b;\nexport const i: { x: string } = { x: 1 };\n',
        },
      },
      { args: ['--listEmittedFiles'] },
      {
        args: ['--listEmittedFiles', '--declarationMap', 'false'],
        edit: { 'c.mts': 'export const i: { x: string } = { x: "" };\n' },
      },
      { args: ['--listEmittedFiles'] },
      { args: ['-b', '-v'] },
      { args: ['-b', '-v'], touch: ['a.ts'] },
      { args: ['-b', '-v'], touch: ['package.json'] },
      { args: ['-b', '-v', '--diagnostics'] },
    ],
  },
  'explainFiles and statistics': {
    files: {
      'tsconfig.json': '{"compilerOptions":{"outDir":"out"},"files":["a.ts"]}',
      'a.ts': 'import "./b";\nexport const a = 1;\n',
      'b.ts': 'export {};\n',
    },
    steps: [{ args: ['--explainFiles'] }, { args: ['--diagnostics'] }, { args: ['--extendedDiagnostics', '--noEmit'] }],
  },
};

function writeFiles(dir, files) {
  for (const [path, text] of Object.entries(files)) {
    const file = join(dir, path);
    if (text === null) rmSync(file, { force: true });
    else {
      mkdirSync(dirname(file), { recursive: true });
      writeFileSync(file, text);
    }
  }
}

function readFiles(dir) {
  const result = {};
  const walk = (directory) => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const file = join(directory, entry.name);
      if (entry.isDirectory()) walk(file);
      else result[relative(dir, file)] = readFileSync(file, 'utf8');
    }
  };
  walk(dir);
  return result;
}

/**
 * Makes `files` newer than everything else in `dir` and older than anything written next, however long the
 * next build takes: shifts every file 10 s into the past, keeping their order, then dates `files` just after
 * the newest of them.
 */
function touch(dir, files) {
  let newest = 0;
  const walk = (directory) => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const file = join(directory, entry.name);
      if (entry.isDirectory()) walk(file);
      else {
        const time = statSync(file).mtimeMs - 10_000;
        utimesSync(file, new Date(time), new Date(time));
        newest = Math.max(newest, time);
      }
    }
  };
  walk(dir);
  const later = new Date(newest + 1000);
  for (const file of files) utimesSync(join(dir, file), later, later);
}

/** Masks what differs between runs: clock times, durations, memory, and counts that depend on checker internals. */
function normalize(text, dir) {
  return (
    text
      .replaceAll(dir, '<dir>')
      .replace(/\d\d:\d\d:\d\d [AP]M/g, '<time>')
      .replace(/^((?:Aggregate )?[A-Za-z][A-Za-z ]+:) +\S+$/gm, '$1 <value>')
      // Outputs written in the same clock tick have the same time, so which one is oldest varies.
      .replace(/(is older than output )'[^']*'/g, "$1'<output>'")
  );
}

function run(command, args, cwd) {
  const env = { PATH: process.env.PATH ?? '', TSC_TS_BUNDLED_LIBS: bundledLibs, NO_COLOR: '1' };
  const result = spawnSync(command[0], [...command.slice(1), ...args], { cwd, env, encoding: 'utf8' });
  return { output: result.stdout + result.stderr, status: result.status };
}

for (const [name, scenario] of Object.entries(scenarios)) {
  test(name, { skip }, () => {
    const dirs = { tsgo: tempDir('tsc-ts-build-tsgo-'), ours: tempDir('tsc-ts-build-ours-') };
    for (const dir of Object.values(dirs)) writeFiles(dir, scenario.files);
    const failures = [];
    for (const [index, step] of scenario.steps.entries()) {
      const results = {};
      for (const [which, dir] of Object.entries(dirs)) {
        if (step.edit) writeFiles(dir, step.edit);
        if (step.touch) touch(dir, step.touch);
        const { output, status } = run(which === 'tsgo' ? [tsgo] : tscTs, step.args, join(dir, step.cwd ?? '.'));
        const files = readFiles(dir);
        for (const [file, text] of Object.entries(files)) files[file] = normalize(text, dir);
        results[which] = { output: normalize(output, dir), status, files };
      }
      const label = `step ${index + 1} (tsc ${step.args.join(' ')})`;
      const { tsgo: expected, ours: actual } = results;
      if (expected.output !== actual.output) {
        failures.push(`${label}: output\n--- tsgo\n${expected.output}\n--- ours\n${actual.output}`);
      }
      if (expected.status !== actual.status)
        failures.push(`${label}: status tsgo ${expected.status}, ours ${actual.status}`);
      const files = new Set([...Object.keys(expected.files), ...Object.keys(actual.files)]);
      for (const file of [...files].sort()) {
        if (expected.files[file] === actual.files[file]) continue;
        if (expected.files[file] === undefined || actual.files[file] === undefined) {
          failures.push(`${label}: ${file} written only by ${expected.files[file] === undefined ? 'tsc-ts' : 'tsgo'}`);
        } else {
          failures.push(`${label}: ${file}\n--- tsgo\n${expected.files[file]}\n--- ours\n${actual.files[file]}`);
        }
      }
      if (failures.length > 0) break;
    }
    assert.deepEqual(failures, []);
  });
}

// tsgo's file watching doesn't report changes in every environment, so watch mode is checked against the output
// tsgo prints for the same sequence.
test('--watch rebuilds on changes', { skip: tscTsMissing, timeout: 120_000 }, async () => {
  const dir = tempDir('tsc-ts-watch-');
  writeFiles(dir, {
    'tsconfig.json': '{"compilerOptions":{"outDir":"out","rootDir":"src"},"include":["src"]}',
    'src/a.ts': 'export const a: number = 1;\n',
  });
  const env = { PATH: process.env.PATH ?? '', TSC_TS_BUNDLED_LIBS: bundledLibs, NO_COLOR: '1' };
  const child = spawn(tscTs[0], [...tscTs.slice(1), '--watch', '--preserveWatchOutput'], { cwd: dir, env });
  let output = '';
  child.stdout.on('data', (chunk) => (output += chunk));
  const waitFor = async (count) => {
    const deadline = Date.now() + 60_000;
    while ((output.match(/Watching for file changes/g) ?? []).length < count) {
      if (Date.now() > deadline) throw new Error('timed out; output so far:\n' + output);
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
  };
  try {
    await waitFor(1);
    writeFiles(dir, { 'src/a.ts': 'export const a: string = 1;\n' });
    await waitFor(2);
    writeFiles(dir, { 'src/b.ts': 'export const b = 2;\n' });
    await waitFor(3);
  } finally {
    child.kill();
  }
  const error = "src/a.ts(1,14): error TS2322: Type 'number' is not assignable to type 'string'.\n";
  assert.equal(
    normalize(output, dir),
    '<time> - Starting compilation in watch mode...\n\n' +
      '<time> - Found 0 errors. Watching for file changes.\n\n' +
      '<time> - File change detected. Starting incremental compilation...\n\n' +
      error +
      '<time> - Found 1 error. Watching for file changes.\n\n' +
      '<time> - File change detected. Starting incremental compilation...\n\n' +
      error +
      '<time> - Found 1 error. Watching for file changes.\n\n',
  );
  assert.deepEqual(Object.keys(readFiles(join(dir, 'out'))).sort(), ['a.js', 'b.js']);
});
