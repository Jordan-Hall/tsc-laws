// JSX. Not ported yet: JSX expressions are `any` and report nothing.
import type { Node } from './ast.js';
import type { Checker } from './checker.js';
import type { Type } from './checker-types.js';

export function checkJsxExpression(c: Checker, _node: Node): Type {
  return c.anyType;
}
