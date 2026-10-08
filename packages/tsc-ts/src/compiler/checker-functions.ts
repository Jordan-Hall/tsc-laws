// Functions: function expressions and arrows, bodies, inferred return types, `await`.
import {
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
import { getContextualReturnType, hasContextSensitiveParameters } from './checker-contextual.js';
import { checkNodeDeferred, checkSourceElement, checkTypeNodeIfPresent } from './checker-source-file.js';
import { checkTypeParameters, checkVariableLikeDeclaration } from './checker-declarations.js';
import { getFunctionFlags, FunctionFlags } from './checker-utilities.js';
import { CheckMode, ObjectFlags, type Signature, SignatureFlags, SignatureKind } from './checker-types.js';
import type { Symbol } from './symbol.js';
import { createAnonymousType, getWidenedLiteralType } from './checker-type-factory.js';
import { createSymbolWithType, getSignaturesOfType } from './checker-members.js';
import {
  getEffectiveRestType,
  getRestTypeAtPosition,
  getTypeAtPosition,
  isOptionalDeclaration,
  tryGetTypeAtPosition,
} from './checker-signatures.js';
import { addOptionality } from './checker-symbol-types.js';
import { getTypeFromTypeNode } from './checker-type-nodes.js';
import {
  checkDeclarationInitializer,
  checkExpressionEx,
  checkTypeAssignableToAndOptionallyElaborate,
} from './checker-expressions.js';
import { isTypeAssignableTo } from './relations.js';
import { type InferenceContext, InferencePriority, inferTypes } from './checker-inference.js';
import { couldContainTypeVariables, instantiateSignature } from './instantiation.js';
import { getContextualSignatureForFunctionLikeDeclaration, getInferenceContext } from './checker-contextual.js';

export function checkFunctionExpressionOrObjectLiteralMethod(c: Checker, node: Node, checkMode: CheckMode): Type {
  checkNodeDeferred(c, node);
  if (node.kind === SyntaxKind.GetAccessor || node.kind === SyntaxKind.SetAccessor) return c.anyType;
  if ((checkMode & CheckMode.SkipContextSensitive) !== 0 && isContextSensitive(c, node)) {
    // Skip parameters, but keep a return type with the non-contextual parts so that inferences can
    // be drawn early.
    if (getType(node) === undefined && !hasContextSensitiveParameters(node)) {
      const contextualSignature = getContextualSignatureForFunctionLikeDeclaration(c, node);
      if (
        contextualSignature !== undefined &&
        couldContainTypeVariables(c, getReturnTypeOfSignature(c, contextualSignature))
      ) {
        const links = c.nodeLinks(node);
        if (links.contextFreeType !== undefined) return links.contextFreeType;
        const returnType = getReturnTypeFromBodyEx(c, node, checkMode);
        const returnOnlySignature = c.newSignature(
          SignatureFlags.IsNonInferrable,
          undefined,
          [],
          undefined,
          [],
          returnType,
          0,
        );
        const returnOnlyType = createAnonymousType(
          c,
          getSymbolOfDeclaration(c, node),
          undefined,
          [returnOnlySignature],
          [],
          [],
        );
        returnOnlyType.objectFlags |= ObjectFlags.NonInferrableType;
        links.contextFreeType = returnOnlyType;
        return returnOnlyType;
      }
    }
    return c.anyFunctionType;
  }
  contextuallyCheckFunctionExpressionOrObjectLiteralMethod(c, node, checkMode);
  const symbol = getSymbolOfDeclaration(c, node);
  return symbol !== undefined ? getTypeOfSymbol(c, symbol) : c.anyType;
}

/** Assigns contextual parameter types and the return type of a function expression, once. */
function contextuallyCheckFunctionExpressionOrObjectLiteralMethod(c: Checker, node: Node, checkMode: CheckMode): void {
  const links = c.nodeLinks(node);
  if ((links.flags & NodeCheckFlags.ContextChecked) !== 0) return;
  const contextualSignature = getContextualSignatureForFunctionLikeDeclaration(c, node);
  // Obtaining the contextual signature may have come back here through overload resolution.
  if ((links.flags & NodeCheckFlags.ContextChecked) !== 0) return;
  links.flags |= NodeCheckFlags.ContextChecked;
  const symbol = getSymbolOfDeclaration(c, node);
  if (symbol === undefined) return;
  const signatures = getSignaturesOfType(c, getTypeOfSymbol(c, symbol), SignatureKind.Call);
  if (signatures.length === 0) return;
  const signature = signatures[0];
  if (isContextSensitive(c, node)) {
    if (contextualSignature !== undefined) {
      const inferenceContext = getInferenceContext(c, node);
      let instantiatedContextualSignature: Signature | undefined = undefined;
      if ((checkMode & CheckMode.Inferential) !== 0 && inferenceContext !== undefined) {
        inferFromAnnotatedParametersAndReturn(c, signature, contextualSignature, inferenceContext);
        const restType = getEffectiveRestType(c, contextualSignature);
        if (restType !== undefined && (restType.flags & TypeFlags.TypeParameter) !== 0)
          instantiatedContextualSignature = instantiateSignature(
            c,
            contextualSignature,
            inferenceContext.nonFixingMapper,
          );
      }
      if (instantiatedContextualSignature === undefined)
        instantiatedContextualSignature =
          inferenceContext !== undefined
            ? instantiateSignature(c, contextualSignature, inferenceContext.mapper)
            : contextualSignature;
      assignContextualParameterTypes(c, signature, instantiatedContextualSignature);
    } else assignNonContextualParameterTypes(c, node);
  } else if (
    contextualSignature !== undefined &&
    getTypeParameters(node) === undefined &&
    contextualSignature.parameters.length > getParameters(node)!.nodes.length
  ) {
    const inferenceContext = getInferenceContext(c, node);
    if ((checkMode & CheckMode.Inferential) !== 0 && inferenceContext !== undefined)
      inferFromAnnotatedParametersAndReturn(c, signature, contextualSignature, inferenceContext);
  }
  if (contextualSignature !== undefined && getType(node) === undefined && signature.resolvedReturnType === undefined) {
    const returnType = getReturnTypeFromBodyEx(c, node, checkMode);
    if (signature.resolvedReturnType === undefined) signature.resolvedReturnType = returnType;
  }
}

function inferFromAnnotatedParametersAndReturn(
  c: Checker,
  sig: Signature,
  context: Signature,
  inferenceContext: InferenceContext,
): void {
  const length = sig.parameters.length - (sig.hasRestParameter() ? 1 : 0);
  for (let i = 0; i < length; i++) {
    const declaration = sig.parameters[i].valueDeclaration;
    const typeNode = declaration !== undefined ? getType(declaration) : undefined;
    if (typeNode !== undefined) {
      const source = addOptionality(c, getTypeFromTypeNode(c, typeNode), false, isOptionalDeclaration(declaration!));
      inferTypes(
        c,
        inferenceContext.inferences,
        source,
        getTypeAtPosition(c, context, i),
        InferencePriority.None,
        false,
      );
    }
  }
  const declaration = sig.declaration;
  const returnTypeNode = declaration !== undefined ? getType(declaration) : undefined;
  if (returnTypeNode !== undefined)
    inferTypes(
      c,
      inferenceContext.inferences,
      getTypeFromTypeNode(c, returnTypeNode),
      getReturnTypeOfSignature(c, context),
      InferencePriority.None,
      false,
    );
}

function assignContextualParameterTypes(c: Checker, sig: Signature, context: Signature): void {
  if (context.typeParameters.length !== 0) {
    // A contextual inference was already performed and cached on this signature.
    if (sig.typeParameters.length !== 0) return;
    sig.typeParameters = context.typeParameters;
  }
  if (context.thisParameter !== undefined) {
    const parameter = sig.thisParameter;
    if (
      parameter === undefined ||
      (parameter.valueDeclaration !== undefined && getType(parameter.valueDeclaration) === undefined)
    ) {
      if (parameter === undefined) sig.thisParameter = createSymbolWithType(c, context.thisParameter, undefined);
      assignParameterSymbolType(c, sig.thisParameter!, getTypeOfSymbol(c, context.thisParameter));
    }
  }
  const length = sig.parameters.length - (sig.hasRestParameter() ? 1 : 0);
  for (let i = 0; i < length; i++) {
    const parameter = sig.parameters[i];
    const declaration = parameter.valueDeclaration;
    if (declaration === undefined || getType(declaration) !== undefined) continue;
    let t = tryGetTypeAtPosition(c, context, i);
    if (t !== undefined && getInitializer(declaration) !== undefined) {
      let initializerType = checkDeclarationInitializer(c, declaration);
      if (!isTypeAssignableTo(c, initializerType, t)) {
        initializerType = getWidenedLiteralType(c, initializerType);
        if (isTypeAssignableTo(c, t, initializerType)) t = initializerType;
      }
    }
    assignParameterSymbolType(c, parameter, t);
  }
  if (sig.hasRestParameter()) {
    const parameter = sig.parameters[sig.parameters.length - 1];
    const declaration = parameter.valueDeclaration;
    if (declaration !== undefined && getType(declaration) === undefined)
      assignParameterSymbolType(c, parameter, getRestTypeAtPosition(c, context, length, false));
  }
}

function assignNonContextualParameterTypes(c: Checker, func: Node): void {
  for (const param of getParameters(func)!.nodes) assignParameterType(c, param);
}

/** Fixes a parameter's type to `contextualType`, or to its declared type without one. */
function assignParameterSymbolType(c: Checker, parameter: Symbol, contextualType: Type | undefined): void {
  const links = c.symbolLinks(parameter);
  if (links.type !== undefined) return;
  const declaration = parameter.valueDeclaration;
  if (contextualType === undefined) {
    links.type = getTypeOfSymbol(c, parameter);
    return;
  }
  links.type = addOptionality(
    c,
    contextualType,
    false,
    declaration !== undefined && getInitializer(declaration) === undefined && isOptionalDeclaration(declaration),
  );
  if (declaration !== undefined) assignParameterType(c, declaration);
}

export function getTypeOfObjectLiteralMethod(c: Checker, node: Node, checkMode: CheckMode): Type {
  return checkFunctionExpressionOrObjectLiteralMethod(c, node, checkMode);
}

/** Checks a function-like declaration's parameters, return type annotation and body. */
export function checkFunctionLikeBody(c: Checker, node: Node): void {
  const typeParameters = getTypeParameters(node);
  checkTypeParameters(c, typeParameters);
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
        if (!isErrorType(c, target)) checkTypeAssignableToAndOptionallyElaborate(c, source, target, body, body);
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
  return (
    hasContextSensitiveParameters(node) ||
    hasContextSensitiveReturnExpression(c, node) ||
    hasContextSensitiveYieldExpression(c, node)
  );
}

function hasContextSensitiveReturnExpression(c: Checker, node: Node): boolean {
  if (getTypeParameters(node) !== undefined || getType(node) !== undefined) return false;
  const body = getBody(node);
  if (body === undefined) return false;
  if (body.kind !== SyntaxKind.Block) return isContextSensitive(c, body);
  const collector = new ReturnCollector();
  collector.visitStatements(body as Block);
  for (const ret of collector.returns)
    if (ret.expression !== undefined && isContextSensitive(c, ret.expression)) return true;
  return false;
}

function hasContextSensitiveYieldExpression(c: Checker, node: Node): boolean {
  if ((getFunctionFlags(node) & FunctionFlags.Generator) === 0) return false;
  const body = getBody(node);
  if (body === undefined) return false;
  const finder = new YieldFinder(c);
  body.forEachChild(finder);
  return finder.found;
}

/** Finds a context-sensitive `yield` operand, skipping nested functions. */
class YieldFinder extends NodeVisitor {
  readonly c: Checker;
  found = false;

  constructor(c: Checker) {
    super();
    this.c = c;
  }

  visitNode(node: Node): boolean {
    if (node.kind === SyntaxKind.YieldExpression) {
      const expression = getExpression(node);
      if (expression !== undefined && isContextSensitive(this.c, expression)) {
        this.found = true;
        return true;
      }
    }
    if (isFunctionLikeOrClass(node)) return false;
    return node.forEachChild(this);
  }
}

function isFunctionLikeOrClass(node: Node): boolean {
  switch (node.kind) {
    case SyntaxKind.FunctionDeclaration:
    case SyntaxKind.FunctionExpression:
    case SyntaxKind.ArrowFunction:
    case SyntaxKind.MethodDeclaration:
    case SyntaxKind.GetAccessor:
    case SyntaxKind.SetAccessor:
    case SyntaxKind.Constructor:
    case SyntaxKind.ClassDeclaration:
    case SyntaxKind.ClassExpression:
      return true;
  }
  return false;
}

// ---- Return type inference

/** The return type inferred from a function's body. */
export function getReturnTypeFromBody(c: Checker, func: Node): Type {
  return getReturnTypeFromBodyEx(c, func, CheckMode.Normal);
}

function checkExpressionCachedEx(c: Checker, node: Node, checkMode: CheckMode): Type {
  return checkMode !== CheckMode.Normal ? checkExpressionEx(c, node, checkMode) : checkExpressionCached(c, node);
}

export function getReturnTypeFromBodyEx(c: Checker, func: Node, checkMode: CheckMode): Type {
  checkMode &= ~CheckMode.SkipGenericFunctions;
  const body = getBody(func);
  if (body === undefined) return c.errorType;
  const flags = getFunctionFlags(func);
  if ((flags & FunctionFlags.Generator) !== 0) return c.anyType;
  const isAsync = (flags & FunctionFlags.Async) !== 0;
  let returnType: Type;
  if (body.kind !== SyntaxKind.Block) {
    returnType = checkExpressionCachedEx(c, body, checkMode);
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
      let t = checkExpressionCachedEx(c, expr, checkMode);
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
