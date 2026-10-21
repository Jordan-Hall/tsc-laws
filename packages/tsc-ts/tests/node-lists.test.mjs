// Empty parsed lists share one nodes array, so reparsing must never add to a parsed list.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { compileSources } from './temp.mjs';

const out = compileSources('tsc-ts-node-lists-', ['main.ts']);
const load = (path) => import(pathToFileURL(join(out, path)).href);
const { ClassDeclaration, FunctionDeclaration } = await load('compiler/ast.js');
const { parseSourceFile } = await load('compiler/parser.js');

test('an @implements tag on a class with an empty implements clause leaves other empty lists empty', () => {
  const js = parseSourceFile('a.js', '/** @implements {I} */\nclass A implements {}\n');
  const cls = js.statements.nodes[0];
  assert.ok(cls instanceof ClassDeclaration);
  const types = cls.heritageClauses.nodes[0].types.nodes;
  assert.deepEqual(
    types.map((t) => t.expression.text),
    ['I'],
  );
  const ts = parseSourceFile('b.ts', 'function f() {}\n');
  const fn = ts.statements.nodes[0];
  assert.ok(fn instanceof FunctionDeclaration);
  assert.equal(fn.parameters.nodes.length, 0);
});

test('an @implements tag adds a clause after an existing extends clause', () => {
  const js = parseSourceFile('a.js', '/** @implements {I} */\nclass A extends B {}\n');
  const cls = js.statements.nodes[0];
  assert.deepEqual(
    cls.heritageClauses.nodes.map((c) => c.types.nodes.map((t) => t.expression.text)),
    [['B'], ['I']],
  );
});
