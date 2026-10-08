// Functions: function expressions and arrows, bodies, inferred return types, `await`.
import {
  type ArrowFunction,
  type Block,
  type ConditionalExpression,
  type BinaryExpression,
  type Node,
  NodeVisitor,
  NodeFlags,
  type ReturnStatement,
  getBody,
  getExpression,
  getInitializer,
  getParameters,
  getProperties,
  getElements,
  getStatements,
  getType,
  getTypeParameters,
  ModifierFlags,
  getName,
} from './ast.js';
import {
  isFunctionExpressionOrArrowFunction,
  isObjectLiteralMethod,
  hasSyntacticModifier,
} from './binder-utilities.js';
import { Diagnostics } from './diagnostics.js';
import { SyntaxKind } from './syntax-kind.js';
import type { Checker } from './checker.js';
import { type Type, TypeFlags, type TypeReference, NodeCheckFlags } from './checker-types.js';
import {
  getUnionTypeEx,
  isErrorType,
  UnionReduction,
  getTypeArguments,
  typesOf,
  mapType,
} from './checker-type-factory.js';
import { getTypeOfSymbol, getWidenedType, reportImplicitAny } from './checker-symbol-types.js';
import { getSymbolOfDeclaration } from './checker-symbols.js';
import { getReturnTypeOfSignature, getSignatureFromDeclaration } from './checker-signatures.js';
import { getGlobalPromiseLikeType, getGlobalPromiseType, createPromiseType } from './checker-globals.js';
import { checkExpressionCached, getWidenedLiteralLikeTypeForContextualType } from './checker-expressions.js';
import { checkTypeAssignableTo } from './relations.js';
import {
  getContextualReturnType,
  hasContextSensitiveParameters,
  isContextSensitiveFunctionOrObjectLiteralMethod,
} from './checker-contextual.js';
import { checkNodeDeferred, checkSourceElement, checkTypeNodeIfPresent } from './checker-source-file.js';
import { checkVariableLikeDeclaration } from './checker-declarations.js';
import { getFunctionFlags, FunctionFlags } from './checker-utilities.js';
import { CheckMode } from './checker-types.js';

export function checkFunctionExpressionOrObjectLiteralMethod(c: Checker, node: Node, _checkMode: CheckMode): Type {
  checkNodeDeferred(c, node);
  if (node.kind === SyntaxKind.GetAccessor || node.kind === SyntaxKind.SetAccessor) return c.anyType;
  assignContextualParameterTypes(c, node);
  const symbol = getSymbolOfDeclaration(c, node);
  return symbol !== undefined ? getTypeOfSymbol(c, symbol) : c.anyType;
}

export function getTypeOfObjectLiteralMethod(c: Checker, node: Node, checkMode: CheckMode): Type {
  return checkFunctionExpressionOrObjectLiteralMethod(c, node, checkMode);
}

/** Checks a function-like declaration's parameters, return type annotation and body. */
export function checkFunctionLikeBody(c: Checker, node: Node): void {
  const typeParameters = getTypeParameters(node);
  if (typeParameters !== undefined) for (const tp of typeParameters.nodes) checkSourceElement(c, tp);
  const params = getParameters(node);
  if (params !== undefined) for (const p of params.nodes) checkVariableLikeDeclaration(c, p);
  const returnTypeNode = getType(node);
  checkTypeNodeIfPresent(c, returnTypeNode);
  const body = getBody(node);
  if (
    returnTypeNode === undefined &&
    body === undefined &&
    node.kind !== SyntaxKind.Constructor &&
    !isPrivateWithinAmbient(node)
  )
    reportImplicitAny(c, node, c.anyType);
  if (body === undefined) return;
  if (body.kind === SyntaxKind.Block) {
    for (const s of getStatements(body)!.nodes) checkSourceElement(c, s);
    if (returnTypeNode !== undefined) checkAllCodePathsReturn(c, node, returnTypeNode, body as Block);
  } else {
    const exprType = checkExpressionCached(c, body);
    if (returnTypeNode !== undefined) {
      const flags = getFunctionFlags(node);
      if ((flags & FunctionFlags.Generator) === 0) {
        const returnType = getReturnTypeOfSignature(c, getSignatureFromDeclaration(c, node));
        const target = (flags & FunctionFlags.Async) !== 0 ? getAwaitedTypeNoAlias(c, returnType) : returnType;
        const source = (flags & FunctionFlags.Async) !== 0 ? getAwaitedTypeNoAlias(c, exprType) : exprType;
        if (!isErrorType(c, target)) checkTypeAssignableTo(c, source, target, body, undefined);
      }
    }
  }
}

function checkAllCodePathsReturn(c: Checker, func: Node, returnTypeNode: Node, body: Block): void {
  if ((func.flags & NodeFlags.HasImplicitReturn) === 0 || (func.flags & NodeFlags.HasExplicitReturn) !== 0) return;
  const flags = getFunctionFlags(func);
  if ((flags & FunctionFlags.Generator) !== 0) return;
  const declared = getReturnTypeOfSignature(c, getSignatureFromDeclaration(c, func));
  const returnType = (flags & FunctionFlags.Async) !== 0 ? getAwaitedTypeNoAlias(c, declared) : declared;
  if (
    (returnType.flags & (TypeFlags.AnyOrUnknown | TypeFlags.Void | TypeFlags.Undefined | TypeFlags.Never)) !== 0 ||
    isErrorType(c, returnType)
  )
    return;
  if ((returnType.flags & TypeFlags.Union) !== 0) {
    for (const t of typesOf(returnType))
      if ((t.flags & (TypeFlags.AnyOrUnknown | TypeFlags.Void | TypeFlags.Undefined)) !== 0) return;
  }
  // Without reachability analysis, a trailing call may never return.
  const statements = body.statements.nodes;
  if (statements.length > 0) {
    const last = statements[statements.length - 1];
    if (
      last.kind === SyntaxKind.ExpressionStatement ||
      last.kind === SyntaxKind.SwitchStatement ||
      last.kind === SyntaxKind.TryStatement
    )
      return;
  }
  c.error(
    returnTypeNode,
    Diagnostics.A_function_whose_declared_type_is_neither_undefined_void_nor_any_must_return_a_value,
  );
}

export function checkAwaitExpression(c: Checker, node: Node): Type {
  const operandType = checkExpressionCached(c, getExpression(node)!);
  return getAwaitedTypeNoAlias(c, operandType);
}

/** The type `await` produces: the promised type of promise-likes, recursively. */
export function getAwaitedTypeNoAlias(c: Checker, t: Type): Type {
  if ((t.flags & TypeFlags.AnyOrUnknown) !== 0) return t;
  // Self-referencing promise types stop at the first repeat.
  if (c.awaitedTypeStack.includes(t.id)) return t;
  c.awaitedTypeStack.push(t.id);
  let result = t;
  if ((t.flags & TypeFlags.Union) !== 0) result = mapType(c, t, (u) => getAwaitedTypeNoAlias(c, u));
  else {
    const promised = getPromisedTypeOfPromise(c, t);
    if (promised !== undefined) result = getAwaitedTypeNoAlias(c, promised);
  }
  c.awaitedTypeStack.pop();
  return result;
}

export function getPromisedTypeOfPromise(c: Checker, t: Type): Type | undefined {
  if ((t.flags & TypeFlags.Object) === 0) return undefined;
  const target = (t as TypeReference).target;
  if (target !== undefined && (target === getGlobalPromiseType(c) || target === getGlobalPromiseLikeType(c)))
    return getTypeArguments(c, t)[0];
  return undefined;
}

// ---- Context sensitivity

/** Whether checking `node` depends on its contextual type. */
export function isContextSensitive(c: Checker, node: Node): boolean {
  switch (node.kind) {
    case SyntaxKind.FunctionExpression:
    case SyntaxKind.ArrowFunction:
    case SyntaxKind.MethodDeclaration:
    case SyntaxKind.FunctionDeclaration:
      return isContextSensitiveFunctionLikeDeclaration(c, node);
    case SyntaxKind.ObjectLiteralExpression:
      for (const p of getProperties(node)!.nodes) if (isContextSensitive(c, p)) return true;
      return false;
    case SyntaxKind.ArrayLiteralExpression:
      for (const e of getElements(node)!.nodes) if (isContextSensitive(c, e)) return true;
      return false;
    case SyntaxKind.ConditionalExpression: {
      const cond = node as ConditionalExpression;
      return isContextSensitive(c, cond.whenTrue) || isContextSensitive(c, cond.whenFalse);
    }
    case SyntaxKind.BinaryExpression: {
      const binary = node as BinaryExpression;
      const op = binary.operatorToken.kind;
      return (
        (op === SyntaxKind.BarBarToken || op === SyntaxKind.QuestionQuestionToken) &&
        (isContextSensitive(c, binary.left) || isContextSensitive(c, binary.right))
      );
    }
    case SyntaxKind.PropertyAssignment:
      return isContextSensitive(c, getInitializer(node)!);
    case SyntaxKind.ParenthesizedExpression:
      return isContextSensitive(c, getExpression(node)!);
  }
  return false;
}

function isContextSensitiveFunctionLikeDeclaration(c: Checker, node: Node): boolean {
  if (hasContextSensitiveParameters(node)) return true;
  if (node.kind !== SyntaxKind.ArrowFunction) return false;
  const arrow = node as ArrowFunction;
  if (arrow.typeParameters !== undefined || arrow.body.kind === SyntaxKind.Block) return false;
  return isContextSensitive(c, arrow.body);
}

// ---- Return type inference

/** The return type inferred from a function's body. */
export function getReturnTypeFromBody(c: Checker, func: Node): Type {
  const body = getBody(func);
  if (body === undefined) return c.errorType;
  const flags = getFunctionFlags(func);
  if ((flags & FunctionFlags.Generator) !== 0) return c.anyType;
  const isAsync = (flags & FunctionFlags.Async) !== 0;
  let returnType: Type;
  if (body.kind !== SyntaxKind.Block) {
    returnType = checkExpressionCached(c, body);
    if (isAsync) returnType = getAwaitedTypeNoAlias(c, returnType);
  } else {
    const types: Type[] = [];
    const collector = new ReturnCollector();
    collector.visitStatements(body as Block);
    let hasReturnWithNoExpression = (func.flags & NodeFlags.HasImplicitReturn) !== 0;
    for (const ret of collector.returns) {
      const expr = ret.expression;
      if (expr === undefined) {
        hasReturnWithNoExpression = true;
        continue;
      }
      let t = checkExpressionCached(c, expr);
      if (isAsync) t = getAwaitedTypeNoAlias(c, t);
      if ((t.flags & TypeFlags.Never) === 0) types.push(t);
    }
    if (types.length === 0 && collector.returns.length === 0) {
      const v = c.voidType;
      return isAsync ? createPromiseType(c, v) : v;
    }
    if (types.length === 0) {
      // Only `return;` statements, or every returned expression is `never`.
      const t = hasReturnWithNoExpression ? c.voidType : c.neverType;
      return isAsync ? createPromiseType(c, t) : t;
    }
    if (hasReturnWithNoExpression && c.strictNullChecks) types.push(c.undefinedType);
    returnType = getUnionTypeEx(c, types, UnionReduction.Subtype, undefined, undefined);
  }
  const contextualReturnType =
    isFunctionExpressionOrArrowFunction(func) || isObjectLiteralMethod(func)
      ? getContextualReturnType(c, func)
      : undefined;
  returnType = getWidenedLiteralLikeTypeForContextualType(c, returnType, contextualReturnType);
  const widened = getWidenedType(c, returnType);
  return isAsync ? createPromiseType(c, widened) : widened;
}

/** Collects the return statements of a function body, skipping nested functions and classes. */
class ReturnCollector {
  readonly returns: ReturnStatement[] = [];

  visitStatements(block: Block): void {
    for (const s of block.statements.nodes) this.visit(s);
  }

  visit(node: Node): void {
    switch (node.kind) {
      case SyntaxKind.ReturnStatement:
        this.returns.push(node as ReturnStatement);
        return;
      case SyntaxKind.FunctionDeclaration:
      case SyntaxKind.FunctionExpression:
      case SyntaxKind.ArrowFunction:
      case SyntaxKind.ClassDeclaration:
      case SyntaxKind.ClassExpression:
      case SyntaxKind.MethodDeclaration:
      case SyntaxKind.GetAccessor:
      case SyntaxKind.SetAccessor:
      case SyntaxKind.Constructor:
      case SyntaxKind.InterfaceDeclaration:
      case SyntaxKind.TypeAliasDeclaration:
      case SyntaxKind.EnumDeclaration:
      case SyntaxKind.ModuleDeclaration:
        return;
    }
    if (isStatementContainer(node)) node.forEachChild(new ReturnVisitor(this));
  }
}

function isStatementContainer(node: Node): boolean {
  switch (node.kind) {
    case SyntaxKind.Block:
    case SyntaxKind.IfStatement:
    case SyntaxKind.DoStatement:
    case SyntaxKind.WhileStatement:
    case SyntaxKind.ForStatement:
    case SyntaxKind.ForInStatement:
    case SyntaxKind.ForOfStatement:
    case SyntaxKind.WithStatement:
    case SyntaxKind.SwitchStatement:
    case SyntaxKind.CaseBlock:
    case SyntaxKind.CaseClause:
    case SyntaxKind.DefaultClause:
    case SyntaxKind.LabeledStatement:
    case SyntaxKind.TryStatement:
    case SyntaxKind.CatchClause:
      return true;
  }
  return false;
}

class ReturnVisitor extends NodeVisitor {
  readonly collector: ReturnCollector;

  constructor(collector: ReturnCollector) {
    super();
    this.collector = collector;
  }

  visitNode(node: Node): boolean {
    this.collector.visit(node);
    return false;
  }
}

function isPrivateWithinAmbient(node: Node): boolean {
  return (
    (hasSyntacticModifier(node, ModifierFlags.Private) || node.kind === SyntaxKind.PrivateIdentifier) &&
    (node.flags & NodeFlags.Ambient) !== 0
  );
}

/** Fixes the types of a context-sensitive function's parameters, once, from its context. */
function assignContextualParameterTypes(c: Checker, func: Node): void {
  const links = c.nodeLinks(func);
  if ((links.flags & NodeCheckFlags.ContextChecked) !== 0) return;
  links.flags |= NodeCheckFlags.ContextChecked;
  if (!isContextSensitiveFunctionOrObjectLiteralMethod(c, func)) return;
  for (const param of getParameters(func)!.nodes) assignParameterType(c, param);
}

function assignParameterType(c: Checker, declaration: Node): void {
  const symbol = getSymbolOfDeclaration(c, declaration);
  if (symbol !== undefined) {
    const symbolLinks = c.symbolLinks(symbol);
    if (symbolLinks.type === undefined) symbolLinks.type = getTypeOfSymbol(c, symbol);
  }
  const name = getName(declaration);
  if (
    name !== undefined &&
    (name.kind === SyntaxKind.ObjectBindingPattern || name.kind === SyntaxKind.ArrayBindingPattern)
  )
    for (const element of getElements(name)!.nodes)
      if (element.kind === SyntaxKind.BindingElement) assignParameterType(c, element);
}
