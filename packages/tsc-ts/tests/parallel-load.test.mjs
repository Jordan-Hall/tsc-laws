// Parse threads (parallel-parse.ts) record what their FileLoader found loading each file they
// prepare, and the program's FileLoader takes it instead of resolving the file's references,
// imports and type directives again. The program must be the one it would load on its own: the
// same files in the same order, include reasons, resolutions and diagnostics. Here one parse thread
// object prepares the files on this thread; its batches are published (frozen under Node.js), as
// they are when they come from a thread, so taking them must not write into them.
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { compileSources, tempDir } from './temp.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, '../../..');
const bundledLibs = join(root, 'upstream/typescript-go/internal/bundled/libs');

const out = compileSources('tsc-ts-parallel-load-', ['main.ts']);
const load = (path) => import(pathToFileURL(join(out, path)).href);
const { createNodeSystem, parseThreadOfCommandLine } = await load('drivers/node-system.js');
const { executeCommandLine } = await load('compiler/tsc-cli.js');
const { CheckedProgram } = await load('compiler/program-checker.js');
const { ParseQueue, parallelParse } = await load('compiler/parallel-parse.js');
const { PackageJsonLookup } = await load('compiler/package-json.js');
const { useLazyJSDocTable } = await load('compiler/parser.js');
const { parseLocale } = await load('compiler/diagnostics.js');
const { assignSymbolIdsAtCreation } = await load('compiler/symbol.js');
const { ConfigParser } = await load('compiler/tsconfig.js');
const { CachedFileSystem } = await load('compiler/file-system.js');
const { SystemFileSystem } = await load('compiler/tsc-cli.js');

const Root = 0;
const Library = 2;
const AutomaticTypes = 3;

function project() {
  const dir = tempDir('tsc-ts-parallel-load-project-');
  const files = {
    'tsconfig.json': JSON.stringify({
      compilerOptions: {
        strict: true,
        noEmit: true,
        module: 'nodenext',
        jsx: 'react-jsx',
        importHelpers: true,
        lib: ['es2022', 'dom'],
        types: ['present'],
      },
      include: ['src'],
    }),
    'node_modules/@types/present/package.json': JSON.stringify({ name: '@types/present', types: 'index.d.ts' }),
    'node_modules/@types/present/index.d.ts': 'declare const present: number;\n',
    'node_modules/heavy/package.json': JSON.stringify({ name: 'heavy', version: '1.0.0', types: 'index.d.ts' }),
    'node_modules/heavy/index.d.ts': "export * from './more';\nexport declare const a0: number;\n",
    'node_modules/heavy/more.d.ts': 'export declare const b0: string;\n',
    'node_modules/tslib/package.json': JSON.stringify({ name: 'tslib', version: '2.0.0', types: 'tslib.d.ts' }),
    'node_modules/tslib/tslib.d.ts': 'export declare function __assign(t: any, ...sources: any[]): any;\n',
    'node_modules/react/package.json': JSON.stringify({ name: 'react', version: '19.0.0' }),
    'node_modules/react/jsx-runtime.d.ts':
      'export declare function jsx(type: any, props: any): any;\n' +
      'export declare namespace JSX { interface IntrinsicElements { div: { id?: string } } type Element = any; }\n',
    'src/a.ts':
      '/// <reference types="missing-types" />\n' +
      '/// <reference path="./missing.ts" />\n' +
      '/// <reference path="./ref.ts" />\n' +
      '/// <reference lib="es2023.array" />\n' +
      "import { a0, b0 } from 'heavy';\n" +
      "import { view } from './b.js';\n" +
      "import type {} from 'not-installed';\n" +
      'export const x = { ...{ a0 }, b0, view, present, last: [1].findLast((n) => n > 0) };\n',
    'src/b.tsx': "export const view = <div id='v' />;\nexport const wrong: string = 1;\n",
    'src/ref.ts': 'declare const referenced: string;\n',
  };
  for (const [name, text] of Object.entries(files)) {
    mkdirSync(dirname(join(dir, name)), { recursive: true });
    writeFileSync(join(dir, name), text);
  }
  return dir;
}

/** Everything about a program that loading decides, as text. */
function describe(program) {
  const locale = parseLocale('en');
  const diagnostic = (d) => `${d.file?.fileName ?? ''}:${d.pos}-${d.end}:${d.code}:${d.args.join(',')}`;
  const checked = new CheckedProgram(program);
  const lines = [program.explainFiles(locale)];
  for (const d of program.getProgramDiagnostics()) lines.push('program ' + diagnostic(d));
  for (const file of program.getSourceFiles()) {
    lines.push('file ' + file.fileName + ' ' + JSON.stringify(program.sourceFileMetadata(file.path)));
    const resolutions = program.processed.resolvedModules.get(file.path);
    for (const [key, resolved] of resolutions?.entries() ?? [])
      lines.push(`  module ${key} ${resolved.resolvedFileName} ${resolved.isExternalLibraryImport}`);
    const types = program.processed.typeResolutionsInFile.get(file.path);
    for (const [key, resolved] of types?.entries() ?? []) lines.push(`  types ${key} ${resolved.resolvedFileName}`);
    for (const d of program.getIncludeProcessorDiagnostics(file)) lines.push('  include ' + diagnostic(d));
    for (const d of checked.semanticDiagnosticsOfFile(file)) lines.push('  semantic ' + diagnostic(d));
  }
  return lines.join('\n');
}

test('the program takes what parse threads found loading their files and is the same program', () => {
  const dir = project();
  const args = ['-p', dir];
  const plain = executeCommandLine(createNodeSystem(bundledLibs, ''), args);
  assert.equal(plain.kind, 'compile');
  const expected = describe(plain.program);

  // Load every file ahead on one parse thread object, as startParallelParse hands them out.
  assignSymbolIdsAtCreation();
  useLazyJSDocTable();
  const thread = parseThreadOfCommandLine(args, join(dir, 'tsconfig.json'), bundledLibs);
  const queue = new ParseQueue();
  for (const name of ['src/a.ts', 'src/b.tsx', 'src/ref.ts']) queue.push(Root, join(dir, name), 0);
  queue.push(Library, 'lib.es2022.d.ts', 0);
  queue.push(Library, 'lib.dom.d.ts', 0);
  queue.push(AutomaticTypes, '', 0);
  let recorded = 0;
  for (let chunk = queue.next(1); chunk !== undefined; chunk = queue.next(1)) {
    const batch = thread.load(chunk);
    assert.ok(Object.isFrozen(batch));
    for (const prepared of batch.files) {
      parallelParse.files.set(prepared.fileName, prepared);
      if (prepared.loaded !== undefined) recorded++;
    }
    for (let k = 0; k < batch.added.names.length; k++)
      queue.push(batch.added.kinds[k], batch.added.names[k], batch.added.depths[k]);
    const lookups = batch.packageJsons;
    for (let k = 0; k < lookups.directories.length; k++)
      parallelParse.packageJsons.push(
        new PackageJsonLookup(lookups.directories[k], lookups.exists[k], lookups.directoryExists[k]),
      );
  }

  const shared = executeCommandLine(createNodeSystem(bundledLibs, ''), args);
  assert.equal(shared.kind, 'compile');
  const files = shared.program.getSourceFiles().length;
  assert.equal(parallelParse.used, files);
  assert.equal(recorded, parallelParse.files.size);
  assert.equal(describe(shared.program), expected);
  // The program took every prepared file, so with the parse thread's lookups it has the
  // \`package.json\` lookups resolving everything itself makes, which build info records.
  const lookups = (program) =>
    [
      ...new Set(program.packageJsonLookups().map((l) => `${l.packageDirectory} ${l.exists} ${l.directoryExists}`)),
    ].sort();
  assert.ok(shared.program.hasAllPackageJsonLookups());
  assert.deepEqual(lookups(shared.program), lookups(plain.program));
  assert.ok(lookups(plain.program).some((l) => l.includes('node_modules/heavy true')));
  // The fixture exercises what loading records: a JSX runtime import, import helpers, missing
  // references and type directives, a library reference and a package.
  assert.match(expected, /react\/jsx-runtime\.d\.ts/);
  assert.match(expected, /tslib\.d\.ts/);
  assert.match(expected, /lib\.es2023\.array\.d\.ts/);
  assert.match(expected, /include .*a\.ts:\d+-\d+:2688:missing-types/);
  assert.match(expected, /include .*a\.ts:\d+-\d+:6053:/);
});

test('a source file of a referenced project loaded ahead queues the file it is redirected to', () => {
  const dir = tempDir('tsc-ts-parallel-load-references-');
  const files = {
    'lib/tsconfig.json': JSON.stringify({
      compilerOptions: { composite: true, outDir: 'out', rootDir: 'src', lib: ['es2022'] },
      include: ['src'],
    }),
    'lib/src/index.ts': 'export const v = 1;\n',
    'lib/out/index.d.ts': 'export declare const v = 1;\n',
    'app/tsconfig.json': JSON.stringify({
      compilerOptions: { strict: true, noEmit: true, lib: ['es2022'] },
      include: ['src'],
      references: [{ path: '../lib' }],
    }),
    'app/src/main.ts': "import { v } from '../../lib/src/index';\nexport const w: string = v;\n",
  };
  for (const [name, text] of Object.entries(files)) {
    mkdirSync(dirname(join(dir, name)), { recursive: true });
    writeFileSync(join(dir, name), text);
  }
  const args = ['-p', join(dir, 'app')];
  parallelParse.files.clear();
  parallelParse.used = 0;
  parallelParse.missed = 0;
  parallelParse.unprepared = 0;
  parallelParse.packageJsons.length = 0;
  const plain = executeCommandLine(createNodeSystem(bundledLibs, ''), args);
  assert.equal(plain.kind, 'compile');
  const expected = describe(plain.program);

  const thread = parseThreadOfCommandLine(args, join(dir, 'app/tsconfig.json'), bundledLibs);
  const queue = new ParseQueue();
  queue.push(Root, join(dir, 'app/src/main.ts'), 0);
  queue.push(Library, 'lib.es2022.d.ts', 0);
  queue.push(AutomaticTypes, '', 0);
  const added = [];
  for (let chunk = queue.next(1); chunk !== undefined; chunk = queue.next(1)) {
    const batch = thread.load(chunk);
    for (const prepared of batch.files) {
      parallelParse.files.set(prepared.fileName, prepared);
      for (const reference of prepared.loaded?.references ?? []) assert.ok(reference.reason !== undefined);
    }
    for (let k = 0; k < batch.added.names.length; k++) {
      added.push(batch.added.names[k]);
      queue.push(batch.added.kinds[k], batch.added.names[k], batch.added.depths[k]);
    }
  }
  assert.ok(added.includes(join(dir, 'lib/out/index.d.ts')));
  assert.ok(!parallelParse.files.has(join(dir, 'lib/src/index.ts')));

  const shared = executeCommandLine(createNodeSystem(bundledLibs, ''), args);
  assert.equal(shared.kind, 'compile');
  assert.equal(parallelParse.used, shared.program.getSourceFiles().length);
  assert.equal(describe(shared.program), expected);
  assert.match(expected, /out\/index\.d\.ts/);
  assert.match(expected, /main\.ts:\d+-\d+:2322:/);
});

// Root files go to the parse threads as the config's \`include\` patterns match them
// (\`ConfigParser.beforeRootFiles\`), so that the threads start on them: a file that one of the same
// name with a higher priority extension leaves out of the config is not among them, since the
// program does not load it.
test('root files found while include patterns are matched are the root files of the config', () => {
  const dir = tempDir('tsc-ts-parallel-load-root-files-');
  const files = {
    'tsconfig.json': JSON.stringify({
      compilerOptions: { noEmit: true, allowJs: true, lib: ['es2022'] },
      files: ['src/lit.ts'],
      include: ['src'],
    }),
    'src/a.ts': 'export const a = 1;\n',
    'src/a.tsx': 'export const a = 2;\n',
    'src/a.d.ts': 'export declare const a: number;\n',
    'src/b.tsx': 'export const b = 1;\n',
    'src/b.js': 'export const b = 2;\n',
    'src/c.js': 'export const c = 1;\n',
    'src/c.d.ts': 'export declare const c: number;\n',
    'src/d.jsx': 'export const d = 1;\n',
    'src/lit.ts': 'export const lit = 1;\n',
    'src/lit.tsx': 'export const lit = 2;\n',
    'src/sub/e.ts': 'export const e = 1;\n',
    'src/sub/e.d.ts': 'export declare const e: number;\n',
  };
  for (const [name, text] of Object.entries(files)) {
    mkdirSync(dirname(join(dir, name)), { recursive: true });
    writeFileSync(join(dir, name), text);
  }
  const sys = createNodeSystem(bundledLibs, '');
  const parser = new ConfigParser(new CachedFileSystem(new SystemFileSystem(sys)), sys.currentDirectory);
  const found = [];
  parser.beforeRootFiles = () => (fileName) => found.push(fileName);
  const errors = [];
  const config = parser.parseConfigFile(join(dir, 'tsconfig.json'), undefined, undefined, errors);
  assert.deepEqual(errors, []);
  assert.deepEqual([...found].sort(), [...config.fileNames].sort());
  assert.ok(config.fileNames.some((f) => f.endsWith('src/c.d.ts')));
  assert.ok(!config.fileNames.some((f) => f.endsWith('src/a.tsx') || f.endsWith('src/lit.tsx')));
});
