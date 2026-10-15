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
const { useLazyJSDocTable } = await load('compiler/parser.js');
const { parseLocale } = await load('compiler/diagnostics.js');
const { assignSymbolIdsAtCreation } = await load('compiler/symbol.js');

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
  }

  const shared = executeCommandLine(createNodeSystem(bundledLibs, ''), args);
  assert.equal(shared.kind, 'compile');
  const files = shared.program.getSourceFiles().length;
  assert.equal(parallelParse.used, files);
  assert.equal(recorded, parallelParse.files.size);
  assert.equal(describe(shared.program), expected);
  // The fixture exercises what loading records: a JSX runtime import, import helpers, missing
  // references and type directives, a library reference and a package.
  assert.match(expected, /react\/jsx-runtime\.d\.ts/);
  assert.match(expected, /tslib\.d\.ts/);
  assert.match(expected, /lib\.es2023\.array\.d\.ts/);
  assert.match(expected, /include .*a\.ts:\d+-\d+:2688:missing-types/);
  assert.match(expected, /include .*a\.ts:\d+-\d+:6053:/);
});
