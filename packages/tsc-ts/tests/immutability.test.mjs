// Checks that binding is the last write to a program, apart from symbol ids and TypeScript files'
// JSDoc, which are assigned and parsed on first use: deep-freezes every object reachable from the
// bound source files (nodes, symbols, symbol tables, flow nodes, diagnostics), then checks the
// program and emits JavaScript, declarations and source maps. Writes to frozen objects throw in
// strict mode, and Map and Set mutators are replaced by throwing ones. The diagnostics and outputs
// must match those of an unfrozen run.
// Projects: tsc-ts itself, and test cases from TypeScript's compiler and conformance suites.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { tempDir } from './temp.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, '../../..');
const bundledLibs = join(root, 'upstream/typescript-go/internal/bundled/libs');
const cases = join(root, 'upstream/TypeScript/tests/cases');

const out = tempDir('tsc-ts-immutability-');
execFileSync(
  join(root, 'node_modules/.bin/tsc'),
  [
    '--outDir',
    out,
    '--rootDir',
    resolve(here, '../src'),
    '--target',
    'es2024',
    '--module',
    'nodenext',
    '--moduleResolution',
    'nodenext',
    '--strict',
    '--skipLibCheck',
    '--types',
    'node',
    resolve(here, '../src/main.ts'),
  ],
  { stdio: 'inherit', cwd: root },
);
const load = (path) => import(pathToFileURL(join(out, path)).href);
const { createNodeSystem } = await load('drivers/node-system.js');
const { executeCommandLine } = await load('compiler/tsc-cli.js');
const { bindProgram, CheckedProgram } = await load('compiler/program-checker.js');
const { NodeVisitor } = await load('compiler/ast.js');
const { getJSDoc } = await load('compiler/parser.js');
const { Symbol, getSymbolId } = await load('compiler/symbol.js');
const { CompileTimes, OutputWriter, PlainProgram, getDiagnosticsOfProgram } = await load('compiler/compile-program.js');
// `Locale.Default`, a const enum member.
const defaultLocale = 0;

function rejectWrite(name) {
  return () => {
    throw new TypeError(`${name} on a frozen program`);
  };
}

/** Every object reachable from `roots`. */
function reachable(roots) {
  const seen = new Set();
  const stack = [...roots];
  const push = (v) => {
    if (v !== null && typeof v === 'object' && !ArrayBuffer.isView(v) && !seen.has(v)) stack.push(v);
  };
  while (stack.length > 0) {
    const o = stack.pop();
    if (seen.has(o)) continue;
    seen.add(o);
    if (o instanceof Map)
      for (const [k, v] of o) {
        push(k);
        push(v);
      }
    else if (o instanceof Set) for (const v of o) push(v);
    else for (const key of Object.keys(o)) push(o[key]);
  }
  return seen;
}

/**
 * Freezes every object reachable from the source files; returns how many. Symbol ids and the
 * JSDoc comments of TypeScript files, which are created on first use, are created first.
 */
function deepFreeze(files) {
  for (const file of files) {
    const nodes = [file];
    while (nodes.length > 0) {
      const node = nodes.pop();
      getJSDoc(file, node);
      node.forEachChild(collector(nodes));
    }
  }
  const objects = reachable(files);
  for (const o of objects) if (o instanceof Symbol) getSymbolId(o);
  for (const o of objects) {
    if (o instanceof Map) {
      o.set = rejectWrite('Map.set');
      o.delete = rejectWrite('Map.delete');
      o.clear = rejectWrite('Map.clear');
    } else if (o instanceof Set) {
      o.add = rejectWrite('Set.add');
      o.delete = rejectWrite('Set.delete');
      o.clear = rejectWrite('Set.clear');
    }
    Object.freeze(o);
  }
  return objects.size;
}

/** A visitor that pushes each child onto `nodes`. */
function collector(nodes) {
  const visitor = new NodeVisitor();
  visitor.visitNode = (node) => {
    nodes.push(node);
    return false;
  };
  return visitor;
}

class RecordingWriter extends OutputWriter {
  outputs = [];

  write(fileName, text, declarationDiagnostics) {
    this.outputs.push(fileName + '\n' + text + format(declarationDiagnostics).join('\n'));
    return '';
  }
}

function format(diagnostics) {
  return diagnostics.map(
    (d) => `${d.file?.fileName ?? ''}(${d.pos},${d.end}) TS${d.code}: ${d.localize(defaultLocale)}`,
  );
}

/** Diagnostics and emitted files of the project of `args`, optionally frozen after binding. */
function compile(args, freeze) {
  const sys = createNodeSystem(bundledLibs, '');
  const work = executeCommandLine(sys, args);
  assert.equal(work.kind, 'compile');
  const program = work.program;
  bindProgram(program);
  const frozen = freeze ? deepFreeze(program.getSourceFiles()) : 0;
  const compiled = new PlainProgram(new CheckedProgram(program), new CompileTimes());
  // Semantic and declaration diagnostics of every file, even after syntax errors.
  const diagnostics = format([
    ...getDiagnosticsOfProgram(compiled, true),
    ...compiled.getSemanticDiagnostics(),
    ...compiled.getDeclarationDiagnostics(),
  ]);
  const writer = new RecordingWriter();
  const emitted = compiled.emit(writer);
  return { frozen, diagnostics, outputs: writer.outputs, emitDiagnostics: format(emitted.diagnostics) };
}

function assertImmutable(args) {
  const frozen = compile(args, true);
  assert.ok(frozen.frozen > 100000, `froze only ${frozen.frozen} objects`);
  assert.ok(frozen.outputs.length > 0);
  const plain = compile(args, false);
  assert.deepEqual(frozen.diagnostics, plain.diagnostics);
  assert.deepEqual(frozen.emitDiagnostics, plain.emitDiagnostics);
  assert.deepEqual(frozen.outputs, plain.outputs);
}

const emitOptions = (dir) => ['--noEmit', 'false', '--outDir', dir, '--declaration', '--declarationMap', '--sourceMap'];

test('checking and emitting tsc-ts never writes to its bound program', () => {
  assertImmutable(['-p', resolve(here, '..'), ...emitOptions(tempDir('tsc-ts-immutability-out-'))]);
});

/** Every `step`th single-file test case of `suite`, written as one project. */
function sampleProject(suite, step, offset) {
  const files = [];
  const walk = (dir) => {
    for (const entry of readdirSync(dir, { withFileTypes: true }).sort((a, b) => (a.name < b.name ? -1 : 1))) {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) walk(path);
      else if (/\.tsx?$/.test(entry.name) && !entry.name.endsWith('.d.ts')) files.push(path);
    }
  };
  walk(join(cases, suite));
  const dir = tempDir('tsc-ts-immutability-cases-');
  let count = 0;
  for (let i = offset; i < files.length; i += step) {
    const text = readFileSync(files[i], 'utf8');
    if (/^\s*\/\/\s*@(filename|nolib|lib|types|module|jsx)\b/im.test(text)) continue;
    // Each case is a module of its own, so that their declarations don't collide.
    writeFileSync(join(dir, `case${count++}${files[i].endsWith('x') ? '.tsx' : '.ts'}`), text + '\nexport {};\n');
  }
  return { dir, count };
}

for (const [suite, options] of [
  ['compiler', ['--target', 'es2015', '--jsx', 'react', '--experimentalDecorators', '--emitDecoratorMetadata']],
  ['conformance', ['--target', 'es2016', '--module', 'commonjs', '--esModuleInterop', '--downlevelIteration']],
]) {
  test(`checking and emitting ${suite} test cases never writes to their bound program`, () => {
    const { dir, count } = sampleProject(suite, 12, 0);
    assert.ok(count > 300);
    writeFileSync(join(dir, 'tsconfig.json'), JSON.stringify({ compilerOptions: { strict: true, types: [] } }));
    assertImmutable(['-p', dir, ...options, ...emitOptions(join(dir, 'out'))]);
  });
}
