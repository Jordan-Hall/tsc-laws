// The parser creates a `ReferenceIdentifier`, which holds the binder's flow node, for every
// identifier the checker can read as a reference, and a plain `Identifier` for names. The binder
// tests leave the plain identifiers' flow nodes out of tsgo's output, so they can't tell a
// reference created as a plain identifier. This test lists the positions that decide it.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { compileSources } from './temp.mjs';

const out = compileSources('tsc-ts-identifier-classes-', ['main.ts']);
const load = (path) => import(pathToFileURL(join(out, path)).href);
const { Identifier, NodeVisitor, ReferenceIdentifier } = await load('compiler/ast.js');
const { parseSourceFile } = await load('compiler/parser.js');

/** `text@parent` for each identifier of the file, with `ref` or `plain`, in source order. */
function classes(fileName, text) {
  const result = [];
  const walk = (node, parent) => {
    if (node instanceof Identifier)
      result.push(`${node.text}@${parent.constructor.name} ${node instanceof ReferenceIdentifier ? 'ref' : 'plain'}`);
    node.forEachChild(
      new (class extends NodeVisitor {
        visitNode(child) {
          walk(child, node);
          return false;
        }
      })(),
    );
  };
  walk(parseSourceFile(fileName, text), undefined);
  return result;
}

test('object literal element names are references only in shorthand properties', () => {
  assert.deepEqual(
    classes('a.ts', 'o = { a, b: 1, c() {}, d<T>() {}, get, get g() { return 1; } }; ({ e = 1 } = o);'),
    [
      'o@BinaryExpression ref',
      'a@ShorthandPropertyAssignment ref',
      'b@PropertyAssignment plain',
      'c@MethodDeclaration plain',
      'd@MethodDeclaration plain',
      'T@TypeParameterDeclaration plain',
      'get@ShorthandPropertyAssignment ref',
      'g@GetAccessorDeclaration plain',
      'e@ShorthandPropertyAssignment ref',
      'o@BinaryExpression ref',
    ],
  );
});

test('type queries, export assignments, decorators and heritage expressions are references', () => {
  assert.deepEqual(classes('a.ts', 'let t: typeof a.b; export = c; @d.e class K extends B {}'), [
    't@VariableDeclaration plain',
    'a@QualifiedName ref',
    'b@QualifiedName plain',
    'c@ExportAssignment ref',
    'd@PropertyAccessExpression ref',
    'e@PropertyAccessExpression plain',
    'K@ClassDeclaration plain',
    'B@ExpressionWithTypeArguments ref',
  ]);
});

test('JSX tag names are references and attribute names are plain', () => {
  assert.deepEqual(classes('a.tsx', '<Foo.Bar baz={qux} />;'), [
    'Foo@PropertyAccessExpression ref',
    'Bar@PropertyAccessExpression plain',
    'baz@JsxAttribute plain',
    'qux@JsxExpression ref',
  ]);
});
