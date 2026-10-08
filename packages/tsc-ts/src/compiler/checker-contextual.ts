// Contextual typing: the type an expression's position implies, and contextual signatures.
import {
  type ArrayLiteralExpression,
  type BinaryExpression,
  type ConditionalExpression,
  type Node,
  type ParameterDeclaration,
  type PropertyAssignment,
  getInitializer,
  getName,
  getParameters,
  getType,
  getArguments,
  getText,
} from './ast.js';
import { isFunctionExpressionOrArrowFunction, isObjectLiteralMethod } from './binder-utilities.js';
import { SyntaxKind } from './syntax-kind.js';
import type { Checker } from './checker.js';
import { type Signature, SignatureKind, type Type, TypeFlags } from './checker-types.js';
import { getElementTypes, isTupleType, typesOf, getUnionType, mapType } from './checker-type-factory.js';
import {
  getApplicableIndexInfoForName,
  getApparentType,
  getIndexInfoOfType,
  getSignaturesOfType,
  getTypeOfPropertyOfType,
} from './checker-members.js';
import { getTypeFromTypeNode } from './checker-type-nodes.js';
import {
  getReturnTypeOfSignature,
  getRestTypeAtPosition,
  getSignatureFromDeclaration,
  tryGetTypeAtPosition,
} from './checker-signatures.js';
import {
  checkExpressionCached,
  getPropertyNameOfObjectLiteralElement,
  isConstTypeReference,
} from './checker-expressions.js';
import { resolveCallSignatureForContext } from './checker-calls.js';
import { getFunctionFlags, FunctionFlags } from './checker-utilities.js';
import { getAwaitedTypeNoAlias } from './checker-functions.js';

/** The type implied by `node`'s position, if any. */
export function getContextualType(c: Checker, node: Node): Type | undefined {
  const parent = node.parent;
  if (parent === undefined) return undefined;
  switch (parent.kind) {
    case SyntaxKind.VariableDeclaration:
    case SyntaxKind.Parameter:
    case SyntaxKind.PropertyDeclaration:
    case SyntaxKind.PropertySignature:
    case SyntaxKind.BindingElement:
      if (getInitializer(parent) !== node) return undefined;
      return getContextualTypeForInitializer(c, parent);
    case SyntaxKind.ArrowFunction: {
      const t = getContextualReturnType(c, parent);
      if (t === undefined) return undefined;
      return (getFunctionFlags(parent) & FunctionFlags.Async) !== 0 ? getAwaitedTypeNoAlias(c, t) : t;
    }
    case SyntaxKind.ReturnStatement: {
      const func = getContainingFunctionForReturn(parent);
      if (func === undefined) return undefined;
      const t = getContextualReturnType(c, func);
      if (t === undefined) return undefined;
      return (getFunctionFlags(func) & FunctionFlags.Async) !== 0 ? getAwaitedTypeNoAlias(c, t) : t;
    }
    case SyntaxKind.CallExpression:
    case SyntaxKind.NewExpression:
      return getContextualTypeForArgument(c, parent, node);
    case SyntaxKind.AsExpression:
    case SyntaxKind.TypeAssertionExpression: {
      const typeNode = getType(parent)!;
      return isConstTypeReference(typeNode) ? getContextualType(c, parent) : getTypeFromTypeNode(c, typeNode);
    }
    case SyntaxKind.SatisfiesExpression:
      return getTypeFromTypeNode(c, getType(parent)!);
    case SyntaxKind.BinaryExpression:
      return getContextualTypeForBinaryOperand(c, parent as BinaryExpression, node);
    case SyntaxKind.PropertyAssignment:
    case SyntaxKind.ShorthandPropertyAssignment:
      if (parent.kind === SyntaxKind.PropertyAssignment && (parent as PropertyAssignment).initializer !== node)
        return undefined;
      return getContextualTypeForObjectLiteralElement(c, parent);
    case SyntaxKind.ObjectLiteralExpression:
      return node.kind === SyntaxKind.MethodDeclaration ? getContextualTypeForObjectLiteralElement(c, node) : undefined;
    case SyntaxKind.SpreadAssignment:
      return getContextualType(c, parent.parent!);
    case SyntaxKind.ArrayLiteralExpression: {
      const arrayType = getApparentTypeOfContextualType(c, parent);
      if (arrayType === undefined) return undefined;
      return getContextualTypeForElement(c, arrayType, (parent as ArrayLiteralExpression).elements.nodes.indexOf(node));
    }
    case SyntaxKind.SpreadElement:
      return getContextualType(c, parent);
    case SyntaxKind.ConditionalExpression: {
      const cond = parent as ConditionalExpression;
      return node === cond.condition ? undefined : getContextualType(c, parent);
    }
    case SyntaxKind.ParenthesizedExpression:
    case SyntaxKind.NonNullExpression:
      return getContextualType(c, parent);
  }
  return undefined;
}

function getContextualTypeForInitializer(c: Checker, declaration: Node): Type | undefined {
  const typeNode = getType(declaration);
  if (typeNode !== undefined) return getTypeFromTypeNode(c, typeNode);
  if (declaration.kind === SyntaxKind.Parameter) {
    const t = getContextuallyTypedParameterTypeOrUndefined(c, declaration);
    if (t !== undefined) return t;
  }
  return undefined;
}

function getContainingFunctionForReturn(node: Node): Node | undefined {
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

/** The return type a function's annotation or contextual signature implies. */
export function getContextualReturnType(c: Checker, func: Node): Type | undefined {
  const typeNode = getType(func);
  if (typeNode !== undefined) {
    if (func.kind === SyntaxKind.Constructor) return undefined;
    return getReturnTypeOfSignature(c, getSignatureFromDeclaration(c, func));
  }
  if (func.kind === SyntaxKind.GetAccessor || func.kind === SyntaxKind.Constructor) return undefined;
  const signature = getContextualSignatureForFunctionLikeDeclaration(c, func);
  return signature !== undefined ? getReturnTypeOfSignature(c, signature) : undefined;
}

function getContextualTypeForArgument(c: Checker, call: Node, arg: Node): Type | undefined {
  const args = getArguments(call);
  if (args === undefined) return undefined;
  const index = args.nodes.indexOf(arg);
  if (index < 0) return undefined;
  const signature = resolveCallSignatureForContext(c, call);
  if (signature === undefined) return c.anyType;
  return tryGetTypeAtPosition(c, signature, index) ?? c.anyType;
}

function getContextualTypeForBinaryOperand(c: Checker, binary: BinaryExpression, node: Node): Type | undefined {
  const op = binary.operatorToken.kind;
  switch (op) {
    case SyntaxKind.EqualsToken:
    case SyntaxKind.AmpersandAmpersandEqualsToken:
    case SyntaxKind.BarBarEqualsToken:
    case SyntaxKind.QuestionQuestionEqualsToken:
      if (node !== binary.right) return undefined;
      return checkExpressionCached(c, binary.left);
    case SyntaxKind.BarBarToken:
    case SyntaxKind.QuestionQuestionToken: {
      const t = getContextualType(c, binary);
      return node === binary.right && t === undefined ? checkExpressionCached(c, binary.left) : t;
    }
    case SyntaxKind.AmpersandAmpersandToken:
    case SyntaxKind.CommaToken:
      return node === binary.right ? getContextualType(c, binary) : undefined;
  }
  return undefined;
}

function getContextualTypeForObjectLiteralElement(c: Checker, element: Node): Type | undefined {
  const objectLiteral = element.parent!;
  const t = getApparentTypeOfContextualType(c, objectLiteral);
  if (t === undefined) return undefined;
  const name = getPropertyNameOfObjectLiteralElement(c, element);
  if (name === undefined) return undefined;
  return getTypeOfPropertyOfContextualType(c, t, name);
}

/** The type of property `name` in a contextual type, through unions and index signatures. */
export function getTypeOfPropertyOfContextualType(c: Checker, t: Type, name: string): Type | undefined {
  if ((t.flags & TypeFlags.Union) !== 0) {
    const types: Type[] = [];
    for (const u of typesOf(t)) {
      const p = getTypeOfPropertyOfContextualType(c, u, name);
      if (p !== undefined) types.push(p);
    }
    if (types.length === 0) return undefined;
    return getUnionType(c, types);
  }
  if ((t.flags & TypeFlags.Object) === 0 && (t.flags & TypeFlags.Intersection) === 0) return undefined;
  const propType = getTypeOfPropertyOfType(c, t, name);
  if (propType !== undefined) return propType;
  if (isTupleType(t) && /^\d+$/.test(name)) {
    const elements = getElementTypes(c, t);
    const index = Number(name);
    return index < elements.length ? elements[index] : undefined;
  }
  return getApplicableIndexInfoForName(c, t, name)?.valueType;
}

function getContextualTypeForElement(c: Checker, arrayType: Type, index: number): Type | undefined {
  if (index < 0) return undefined;
  if ((arrayType.flags & TypeFlags.Union) !== 0) {
    const types: Type[] = [];
    for (const u of typesOf(arrayType)) {
      const e = getContextualTypeForElement(c, u, index);
      if (e !== undefined) types.push(e);
    }
    if (types.length === 0) return undefined;
    return getUnionType(c, types);
  }
  if (isTupleType(arrayType)) {
    const elements = getElementTypes(c, arrayType);
    if (index < elements.length) return elements[index];
    return c.anyType;
  }
  return getIndexInfoOfType(c, arrayType, c.numberType)?.valueType;
}

/** The apparent form of `node`'s contextual type. */
export function getApparentTypeOfContextualType(c: Checker, node: Node): Type | undefined {
  const t = getContextualType(c, node);
  if (t === undefined) return undefined;
  if ((t.flags & TypeFlags.Union) !== 0) {
    // Apparent types of the members; keep the union so that property lookups distribute.
    return mapType(c, t, (u) => getApparentType(c, u));
  }
  return getApparentType(c, t);
}

/** Whether `node` is a function, arrow or object literal method whose parameters may get types from context. */
export function isContextSensitiveFunctionOrObjectLiteralMethod(c: Checker, func: Node): boolean {
  return (
    (isFunctionExpressionOrArrowFunction(func) || isObjectLiteralMethod(func)) &&
    isContextSensitiveFunctionLikeDeclaration(c, func)
  );
}

export function isContextSensitiveFunctionLikeDeclaration(_c: Checker, func: Node): boolean {
  return hasContextSensitiveParameters(func);
}

export function hasContextSensitiveParameters(func: Node): boolean {
  if (func.kind === SyntaxKind.Constructor) return false;
  const params = getParameters(func)!.nodes;
  if (params.length === 0) return false;
  for (const p of params) if (getType(p) === undefined) return true;
  return false;
}

/** The contextual signature of a function expression, arrow or object literal method. */
export function getContextualSignatureForFunctionLikeDeclaration(c: Checker, func: Node): Signature | undefined {
  if (!isFunctionExpressionOrArrowFunction(func) && !isObjectLiteralMethod(func)) return undefined;
  const contextNode = func;
  const t = getApparentTypeOfContextualType(c, contextNode);
  if (t === undefined || (t.flags & TypeFlags.Any) !== 0) return undefined;
  return getContextualCallSignature(c, t);
}

function getContextualCallSignature(c: Checker, t: Type): Signature | undefined {
  const types = (t.flags & TypeFlags.Union) !== 0 ? typesOf(t) : [t];
  let result: Signature | undefined = undefined;
  for (const u of types) {
    const signatures = getSignaturesOfType(c, getApparentType(c, u), SignatureKind.Call);
    if (signatures.length === 0) continue;
    if (signatures.length > 1 || result !== undefined) return undefined;
    result = signatures[0];
  }
  return result;
}

function getContextuallyTypedParameterTypeOrUndefined(c: Checker, parameter: Node): Type | undefined {
  const func = parameter.parent!;
  if (!isContextSensitiveFunctionOrObjectLiteralMethod(c, func)) return undefined;
  const signature = getContextualSignatureForFunctionLikeDeclaration(c, func);
  if (signature === undefined) {
    // Contexts this checker can't resolve precisely yet are treated as `any`.
    const t = getContextualType(c, func);
    if (t === undefined) return undefined;
    if ((t.flags & TypeFlags.Any) !== 0) return c.anyType;
    return getSignaturesOfType(c, getApparentType(c, t), SignatureKind.Call).length === 0 &&
      (t.flags & TypeFlags.Union) === 0
      ? undefined
      : c.anyType;
  }
  const params = getParameters(func)!.nodes;
  let index = params.indexOf(parameter);
  if (params.length > 0) {
    const first = getName(params[0]);
    if (first !== undefined && first.kind === SyntaxKind.Identifier && getText(first) === 'this') index--;
  }
  if ((parameter as ParameterDeclaration).dotDotDotToken !== undefined && index === params.length - 1)
    return getRestTypeAtPosition(c, signature, index, false);
  return tryGetTypeAtPosition(c, signature, index);
}

/** The type a parameter of a context-sensitive function gets from its contextual signature. */
export function getContextuallyTypedParameterType(c: Checker, parameter: Node): Type | undefined {
  return getContextuallyTypedParameterTypeOrUndefined(c, parameter);
}
