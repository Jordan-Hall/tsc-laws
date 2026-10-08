// Statements.
import {
  type CaseOrDefaultClause,
  type CatchClause,
  type DoStatement,
  type ForInOrOfStatement,
  type ForStatement,
  type IfStatement,
  type LabeledStatement,
  type Node,
  type ReturnStatement,
  type SwitchStatement,
  type TryStatement,
  type VariableDeclarationList,
  type WhileStatement,
  getExpression,
  getStatements,
  getType,
} from './ast.js';
import { Diagnostics } from './diagnostics.js';
import { SyntaxKind } from './syntax-kind.js';
import type { Checker } from './checker.js';
import { CheckMode, type Type, TypeFlags } from './checker-types.js';
import { isErrorType } from './checker-type-factory.js';
import { getReturnTypeOfSignature, getSignatureFromDeclaration } from './checker-signatures.js';
import {
  checkExpression,
  checkExpressionCached,
  checkTypeAssignableToAndOptionallyElaborate,
  getIteratedTypeOrElementType,
} from './checker-expressions.js';
import { checkTestingKnownTruthyType, checkTruthinessExpression } from './checker-operators.js';
import { checkTypeAssignableTo } from './relations.js';
import { isTypeAssignableToKindEx as isTypeAssignableToKind } from './checker-type-operators.js';
import { checkSourceElement } from './checker-source-file.js';
import { checkVariableDeclarationList, checkVariableLikeDeclaration } from './checker-declarations.js';
import { getAwaitedTypeNoAlias } from './checker-functions.js';
import { getFunctionFlags, FunctionFlags } from './checker-utilities.js';
import { typeToString } from './type-printer.js';
import { getNonNullableType } from './checker-flow.js';

export function checkBlock(c: Checker, node: Node): void {
  for (const s of getStatements(node)!.nodes) checkSourceElement(c, s);
}

export function checkExpressionStatement(c: Checker, node: Node): void {
  checkExpression(c, getExpression(node)!);
}

export function checkIfStatement(c: Checker, node: Node): void {
  const s = node as IfStatement;
  const t = checkTruthinessExpression(c, s.expression, CheckMode.Normal);
  checkTestingKnownTruthyType(c, s.expression, t, s.thenStatement);
  checkSourceElement(c, s.thenStatement);
  if (s.thenStatement.kind === SyntaxKind.EmptyStatement)
    c.error(s.thenStatement, Diagnostics.The_body_of_an_if_statement_cannot_be_the_empty_statement);
  checkSourceElement(c, s.elseStatement);
}

export function checkDoStatement(c: Checker, node: Node): void {
  const s = node as DoStatement;
  checkSourceElement(c, s.statement);
  checkTruthinessExpression(c, s.expression, CheckMode.Normal);
}

export function checkWhileStatement(c: Checker, node: Node): void {
  const s = node as WhileStatement;
  checkTruthinessExpression(c, s.expression, CheckMode.Normal);
  checkSourceElement(c, s.statement);
}

export function checkForStatement(c: Checker, node: Node): void {
  const s = node as ForStatement;
  const initializer = s.initializer;
  if (initializer !== undefined) {
    if (initializer.kind === SyntaxKind.VariableDeclarationList) checkVariableDeclarationList(c, initializer);
    else checkExpression(c, initializer);
  }
  if (s.condition !== undefined) checkTruthinessExpression(c, s.condition, CheckMode.Normal);
  if (s.incrementor !== undefined) checkExpression(c, s.incrementor);
  checkSourceElement(c, s.statement);
}

export function checkForInStatement(c: Checker, node: Node): void {
  const s = node as ForInOrOfStatement;
  if (s.initializer.kind === SyntaxKind.VariableDeclarationList) {
    for (const d of (s.initializer as VariableDeclarationList).declarations.nodes) checkVariableLikeDeclaration(c, d);
  } else checkExpression(c, s.initializer);
  const rightType = getNonNullableType(c, checkExpression(c, s.expression));
  if (
    (rightType.flags & TypeFlags.Never) !== 0 ||
    !isTypeAssignableToKind(c, rightType, TypeFlags.NonPrimitive | TypeFlags.InstantiableNonPrimitive, false)
  )
    c.error(
      s.expression,
      Diagnostics.The_right_hand_side_of_a_for_in_statement_must_be_of_type_any_an_object_type_or_a_type_parameter_but_here_has_type_0,
      typeToString(c, rightType),
    );
  checkSourceElement(c, s.statement);
}

export function checkForOfStatement(c: Checker, node: Node): void {
  const s = node as ForInOrOfStatement;
  if (s.initializer.kind === SyntaxKind.VariableDeclarationList) {
    for (const d of (s.initializer as VariableDeclarationList).declarations.nodes) checkVariableLikeDeclaration(c, d);
  } else checkExpression(c, s.initializer);
  checkRightHandSideOfForOf(c, s);
  checkSourceElement(c, s.statement);
}

/** The element type a `for...of` produces. */
export function checkRightHandSideOfForOf(c: Checker, statement: Node): Type {
  const s = statement as ForInOrOfStatement;
  const exprType = checkExpressionCached(c, s.expression);
  const elementType = getIteratedTypeOrElementType(c, exprType);
  return s.awaitModifier !== undefined ? getAwaitedTypeNoAlias(c, elementType) : elementType;
}

export function checkReturnStatement(c: Checker, node: Node): void {
  const s = node as ReturnStatement;
  const func = getContainingFunction(node);
  if (s.expression === undefined) return;
  const exprType = checkExpressionCached(c, s.expression);
  if (func !== undefined && func.kind === SyntaxKind.SetAccessor) {
    c.error(node, Diagnostics.Setters_cannot_return_a_value);
    return;
  }
  if (func !== undefined && func.kind === SyntaxKind.Constructor) {
    const instanceType = getReturnTypeOfSignature(c, getSignatureFromDeclaration(c, func));
    if (!checkTypeAssignableTo(c, exprType, instanceType, node, undefined))
      c.error(
        node,
        Diagnostics.Return_type_of_constructor_signature_must_be_assignable_to_the_instance_type_of_the_class,
      );
    return;
  }
  if (func === undefined || getType(func) === undefined) return;
  const flags = getFunctionFlags(func);
  if ((flags & FunctionFlags.Generator) !== 0) return;
  if (func.kind === SyntaxKind.Constructor || func.kind === SyntaxKind.SetAccessor) return;
  const returnType = getReturnTypeOfSignature(c, getSignatureFromDeclaration(c, func));
  if (isErrorType(c, returnType) || (returnType.flags & TypeFlags.Any) !== 0) return;
  const target = (flags & FunctionFlags.Async) !== 0 ? getAwaitedTypeNoAlias(c, returnType) : returnType;
  const source = (flags & FunctionFlags.Async) !== 0 ? getAwaitedTypeNoAlias(c, exprType) : exprType;
  if ((target.flags & TypeFlags.Void) !== 0 && (source.flags & (TypeFlags.Void | TypeFlags.Undefined)) === 0)
    return checkVoidReturn(c, s, source, target);
  checkTypeAssignableToAndOptionallyElaborate(c, source, target, node, s.expression);
}

function checkVoidReturn(c: Checker, s: ReturnStatement, source: Type, target: Type): void {
  checkTypeAssignableTo(c, source, target, s, undefined);
}

function getContainingFunction(node: Node): Node | undefined {
  let current = node.parent;
  while (current !== undefined) {
    switch (current.kind) {
      case SyntaxKind.FunctionDeclaration:
      case SyntaxKind.FunctionExpression:
      case SyntaxKind.ArrowFunction:
      case SyntaxKind.MethodDeclaration:
      case SyntaxKind.GetAccessor:
      case SyntaxKind.SetAccessor:
      case SyntaxKind.Constructor:
        return current;
      case SyntaxKind.ClassStaticBlockDeclaration:
      case SyntaxKind.SourceFile:
        return undefined;
    }
    current = current.parent;
  }
  return undefined;
}

export function checkSwitchStatement(c: Checker, node: Node): void {
  const s = node as SwitchStatement;
  checkExpression(c, s.expression);
  for (const clause of s.caseBlock.clauses.nodes) {
    const caseClause = clause as CaseOrDefaultClause;
    if (caseClause.expression !== undefined) checkExpression(c, caseClause.expression);
    for (const statement of caseClause.statements.nodes) checkSourceElement(c, statement);
  }
}

export function checkLabeledStatement(c: Checker, node: Node): void {
  checkSourceElement(c, (node as LabeledStatement).statement);
}

export function checkThrowStatement(c: Checker, node: Node): void {
  const expr = getExpression(node);
  if (expr !== undefined) checkExpression(c, expr);
}

export function checkTryStatement(c: Checker, node: Node): void {
  const s = node as TryStatement;
  checkBlock(c, s.tryBlock);
  const catchClause: CatchClause | undefined = s.catchClause;
  if (catchClause !== undefined) {
    if (catchClause.variableDeclaration !== undefined) {
      const typeNode = getType(catchClause.variableDeclaration);
      if (typeNode !== undefined) checkSourceElement(c, typeNode);
    }
    checkBlock(c, catchClause.block);
  }
  if (s.finallyBlock !== undefined) checkBlock(c, s.finallyBlock);
}
