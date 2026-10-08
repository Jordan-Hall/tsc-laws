// Expression checking: types of expressions and the errors they produce.
import {
  type ArrayLiteralExpression,
  type BinaryExpression,
  type ComputedPropertyName,
  type ConditionalExpression,
  type ElementAccessExpression,
  type Identifier,
  type Node,
  type PrefixUnaryExpression,
  type PostfixUnaryExpression,
  type PropertyAccessExpression,
  type PropertyAssignment,
  type QualifiedName,
  type SpreadElement,
  type TemplateExpression,
  type TypeReferenceNode,
  getExpression,
  getInitializer,
  getName,
  getSymbol,
  getText,
  SourceFile,
  ModifierFlags,
  NodeFlags,
  PropertyDeclaration,
  VariableDeclaration,
  ForInOrOfStatement,
  VariableDeclarationList,
  TypeQueryNode,
  getProperties,
  getType,
} from './ast.js';
import {
  declarationNameToString,
  getAssignmentTarget,
  getSourceFileOfNode,
  getThisContainer,
  isEntityNameExpression,
  isStatic,
  skipParentheses,
  isClassLike,
  getNameOfDeclaration,
  getRootDeclaration,
  hasSyntacticModifier,
  isFunctionExpressionOrArrowFunction,
  isObjectLiteralOrClassExpressionMethodOrAccessor,
  isPartOfTypeQuery,
  isOptionalChain,
} from './binder-utilities.js';
import { type DiagnosticMessage, Diagnostics } from './diagnostics.js';
import { getSpellingSuggestion } from './spelling.js';
import { CheckFlags, type Symbol, SymbolFlags } from './symbol.js';
import { SyntaxKind } from './syntax-kind.js';
import { type Checker, createDiagnosticForNode } from './checker.js';
import {
  AccessFlags,
  CheckMode,
  type IndexInfo,
  type LiteralType,
  ObjectFlags,
  type Type,
  TypeFlags,
  UnionType,
  TypeParameter,
} from './checker-types.js';
import {
  createAnonymousType,
  createArrayType,
  createTupleTypeEx,
  getBigIntLiteralType,
  getFreshTypeOfLiteralType,
  getNumberLiteralType,
  getRegularTypeOfLiteralType,
  getStringLiteralType,
  getUnionType,
  getUnionTypeEx,
  getWidenedLiteralType,
  isErrorType,
  isTupleType,
  newIndexInfo,
  someType,
  typesOf,
  UnionReduction,
  getPropagatingFlagsOfTypes,
  getBaseTypeOfLiteralType,
} from './checker-type-factory.js';
import { ElementFlags, TupleElementInfo } from './checker-types.js';
import {
  getApparentType,
  getApplicableIndexInfoForName,
  getBaseConstraintOfType,
  getPropertiesOfType,
  getPropertyOfType,
  getIndexInfoOfType,
  getIndexInfosOfType,
} from './checker-members.js';
import {
  getExportSymbolOfValueSymbolIfExported,
  getMergedSymbol,
  getSymbolOfDeclaration,
  resolveName,
  getCannotFindNameDiagnosticForName,
  getDeclarationOfAliasSymbol,
} from './checker-symbols.js';
import {
  getTypeOfSymbol,
  getWidenedType,
  isReadonlySymbol,
  getOptionalType,
  removeMissingType,
} from './checker-symbol-types.js';
import { getDeclaredTypeOfClassOrInterface } from './checker-declared-types.js';
import { getTypeFromTypeNode } from './checker-type-nodes.js';
import {
  getIndexedAccessTypeEx,
  isGenericObjectType,
  getIndexedAccessTypeOrUndefinedEx,
} from './checker-type-operators.js';
import { TypeFacts, getTypeFacts, getTypeWithFacts, getNonNullableType } from './checker-flow.js';
import { checkTypeAssignableTo, checkTypeComparableTo, isTypeAssignableTo, isTypeComparableTo } from './relations.js';
import { isTypeAssignableToKindEx as isTypeAssignableToKind } from './checker-type-operators.js';
import { typeToString, symbolToString } from './type-printer.js';
import { isTypeUsableAsPropertyName, getPropertyNameFromType, maybeTypeOfKind } from './checker-utilities.js';
import { getContextualType, getContextualSignatureForFunctionLikeDeclaration } from './checker-contextual.js';
import {
  checkCallExpression,
  checkNewExpression,
  checkTaggedTemplateExpression,
  getOptionalExpressionType,
  propagateOptionalTypeMarker,
} from './checker-calls.js';
import {
  checkFunctionExpressionOrObjectLiteralMethod,
  checkAwaitExpression,
  getTypeOfObjectLiteralMethod,
} from './checker-functions.js';
import { checkClassExpression } from './checker-classes.js';
import { checkJsxExpression } from './checker-jsx.js';
import { getRegularTypeOfObjectLiteral } from './checker-literals.js';
import { getSignatureFromDeclaration, getThisTypeOfSignature } from './checker-signatures.js';
import { isAssignmentOperator, isFunctionLike } from './ast-utilities.js';
import {
  AssignmentKind,
  convertAutoToAny,
  getAssignmentTargetKind,
  getControlFlowContainer,
  isConstantVariable,
  isInCompoundLikeAssignment,
  isMutableLocalVariableDeclaration,
  isParameterOrMutableLocalVariable,
  isPastLastAssignment,
  isSymbolAssignedDefinitely,
  getFlowTypeOfReference,
} from './checker-narrowing.js';

export {
  getContextuallyTypedParameterType,
  isContextSensitiveFunctionOrObjectLiteralMethod,
} from './checker-contextual.js';

// ---- Entry points

export function checkExpression(c: Checker, node: Node): Type {
  return checkExpressionEx(c, node, CheckMode.Normal);
}

export function checkExpressionEx(c: Checker, node: Node, checkMode: CheckMode): Type {
  const saveCurrentNode = c.currentNode;
  c.currentNode = node;
  const t = checkExpressionWorker(c, node, checkMode);
  c.currentNode = saveCurrentNode;
  return t;
}

/** The type of `node`, computed once. */
export function checkExpressionCached(c: Checker, node: Node): Type {
  const links = c.nodeLinks(node);
  if (links.resolvedType === undefined) links.resolvedType = checkExpression(c, node);
  return links.resolvedType;
}

/** The type of an initializer in a position where literals widen unless the context wants them. */
export function checkExpressionForMutableLocation(c: Checker, node: Node): Type {
  const t = checkExpression(c, node);
  if (isConstContext(node)) return getRegularTypeOfLiteralType(c, t);
  return getWidenedLiteralLikeTypeForContextualType(c, t, getContextualType(c, node));
}

export function checkDeclarationInitializer(c: Checker, declaration: Node): Type {
  const initializer = getInitializer(declaration)!;
  return checkExpressionCached(c, initializer);
}

export function checkComputedPropertyName(c: Checker, node: Node): Type {
  const links = c.nodeLinks((node as ComputedPropertyName).expression);
  if (links.resolvedType === undefined) {
    const t = checkExpression(c, (node as ComputedPropertyName).expression);
    links.resolvedType = t;
    if (
      (t.flags & TypeFlags.Any) === 0 &&
      !isTypeAssignableToKind(c, t, TypeFlags.StringLike | TypeFlags.NumberLike | TypeFlags.ESSymbolLike, false) &&
      !isTypeAssignableTo(c, t, c.stringNumberSymbolType)
    )
      c.error(node, Diagnostics.A_computed_property_name_must_be_of_type_string_number_symbol_or_any);
  }
  return links.resolvedType;
}

/** The type of the expression in a `typeof` type query. */
export function checkTypeQueryExpression(c: Checker, node: Node): Type {
  const exprName = (node as TypeQueryNode).exprName;
  if (exprName.kind === SyntaxKind.Identifier) return checkIdentifier(c, exprName as Identifier);
  if (exprName.kind === SyntaxKind.QualifiedName) return checkQualifiedName(c, exprName as QualifiedName);
  if (exprName.kind === SyntaxKind.ThisKeyword) return checkThisExpression(c, exprName);
  return c.errorType;
}

/** The symbol an identifier refers to as a value; reports unresolved names. */
export function getResolvedSymbol(c: Checker, node: Node): Symbol {
  const links = c.nodeLinks(node);
  if (links.resolvedSymbol === undefined) {
    let symbol = c.unknownSymbol;
    if (getText(node) !== '') {
      const text = getText(node);
      const found = resolveName(
        c,
        node,
        text,
        SymbolFlags.Value | SymbolFlags.ExportValue,
        getCannotFindNameDiagnosticForName(c, node),
        true,
        false,
      );
      if (found !== undefined) symbol = found;
    }
    links.resolvedSymbol = symbol;
  }
  return links.resolvedSymbol;
}

// ---- Dispatch

function checkExpressionWorker(c: Checker, node: Node, checkMode: CheckMode): Type {
  switch (node.kind) {
    case SyntaxKind.Identifier:
      return checkIdentifier(c, node as Identifier);
    case SyntaxKind.PrivateIdentifier:
      return c.errorType;
    case SyntaxKind.ThisKeyword:
      return checkThisExpression(c, node);
    case SyntaxKind.SuperKeyword:
      return c.anyType;
    case SyntaxKind.NullKeyword:
      return c.nullWideningType;
    case SyntaxKind.TrueKeyword:
      return c.trueType;
    case SyntaxKind.FalseKeyword:
      return c.falseType;
    case SyntaxKind.StringLiteral:
    case SyntaxKind.NoSubstitutionTemplateLiteral:
      return getFreshTypeOfLiteralType(c, getStringLiteralType(c, getText(node)));
    case SyntaxKind.NumericLiteral:
      return getFreshTypeOfLiteralType(c, getNumberLiteralType(c, Number(getText(node))));
    case SyntaxKind.BigIntLiteral:
      return getFreshTypeOfLiteralType(c, getBigIntLiteralType(c, parseBigIntText(getText(node))));
    case SyntaxKind.TemplateExpression:
      return checkTemplateExpression(c, node as TemplateExpression);
    case SyntaxKind.RegularExpressionLiteral:
      return c.globalRegExpType;
    case SyntaxKind.ArrayLiteralExpression:
      return checkArrayLiteral(c, node as ArrayLiteralExpression, checkMode);
    case SyntaxKind.ObjectLiteralExpression:
      return checkObjectLiteral(c, node, checkMode);
    case SyntaxKind.PropertyAccessExpression:
      return checkPropertyAccessExpression(c, node as PropertyAccessExpression, checkMode);
    case SyntaxKind.QualifiedName:
      return checkQualifiedName(c, node as QualifiedName);
    case SyntaxKind.ElementAccessExpression:
      return checkElementAccessExpression(c, node as ElementAccessExpression, checkMode);
    case SyntaxKind.CallExpression:
      return checkCallExpression(c, node, checkMode);
    case SyntaxKind.NewExpression:
      return checkNewExpression(c, node, checkMode);
    case SyntaxKind.TaggedTemplateExpression:
      return checkTaggedTemplateExpression(c, node, checkMode);
    case SyntaxKind.ParenthesizedExpression:
      return checkExpressionEx(c, getExpression(node)!, checkMode);
    case SyntaxKind.ClassExpression:
      return checkClassExpression(c, node);
    case SyntaxKind.FunctionExpression:
    case SyntaxKind.ArrowFunction:
      return checkFunctionExpressionOrObjectLiteralMethod(c, node, checkMode);
    case SyntaxKind.TypeOfExpression:
      checkExpression(c, getExpression(node)!);
      return c.typeofType;
    case SyntaxKind.TypeAssertionExpression:
    case SyntaxKind.AsExpression:
      return checkAssertion(c, node, checkMode);
    case SyntaxKind.NonNullExpression:
      return getNonNullableType(c, checkExpressionEx(c, getExpression(node)!, checkMode));
    case SyntaxKind.ExpressionWithTypeArguments:
      return checkExpressionEx(c, getExpression(node)!, checkMode);
    case SyntaxKind.SatisfiesExpression:
      return checkSatisfiesExpression(c, node, checkMode);
    case SyntaxKind.MetaProperty:
      return c.anyType;
    case SyntaxKind.DeleteExpression:
      checkExpression(c, getExpression(node)!);
      return c.booleanType;
    case SyntaxKind.VoidExpression:
      checkExpression(c, getExpression(node)!);
      return c.undefinedWideningType;
    case SyntaxKind.AwaitExpression:
      return checkAwaitExpression(c, node);
    case SyntaxKind.PrefixUnaryExpression:
      return checkPrefixUnaryExpression(c, node as PrefixUnaryExpression);
    case SyntaxKind.PostfixUnaryExpression:
      return checkPostfixUnaryExpression(c, node as PostfixUnaryExpression);
    case SyntaxKind.BinaryExpression:
      return checkBinaryExpression(c, node as BinaryExpression, checkMode);
    case SyntaxKind.ConditionalExpression:
      return checkConditionalExpression(c, node as ConditionalExpression, checkMode);
    case SyntaxKind.SpreadElement:
      return checkSpreadExpression(c, node as SpreadElement, checkMode);
    case SyntaxKind.OmittedExpression:
      return c.undefinedWideningType;
    case SyntaxKind.YieldExpression: {
      const operand = getExpression(node);
      if (operand !== undefined) checkExpression(c, operand);
      return c.anyType;
    }
    case SyntaxKind.SyntheticExpression:
      return c.anyType;
    case SyntaxKind.JsxExpression:
    case SyntaxKind.JsxElement:
    case SyntaxKind.JsxSelfClosingElement:
    case SyntaxKind.JsxFragment:
    case SyntaxKind.JsxAttributes:
    case SyntaxKind.JsxOpeningElement:
      return checkJsxExpression(c, node);
  }
  return c.errorType;
}

function parseBigIntText(text: string): string {
  let digits = text.endsWith('n') ? text.substring(0, text.length - 1) : text;
  digits = digits.split('_').join('');
  if (digits.length > 2 && digits.charCodeAt(0) === 0x30) {
    const radix = digits.charCodeAt(1) | 0x20;
    if (radix === 0x78 || radix === 0x6f || radix === 0x62) return BigInt(digits).toString();
  }
  let i = 0;
  while (i < digits.length - 1 && digits.charCodeAt(i) === 0x30) i++;
  return digits.substring(i);
}

// ---- Identifiers and `this`

export function checkIdentifier(c: Checker, node: Identifier): Type {
  const symbol = getResolvedSymbol(c, node);
  if (symbol === c.unknownSymbol) return c.errorType;
  if (symbol === c.argumentsSymbol) return getTypeOfSymbol(c, symbol);
  const localOrExportSymbol = getExportSymbolOfValueSymbolIfExported(c, symbol);
  let declaration = localOrExportSymbol.valueDeclaration;
  const immediateDeclaration = declaration;
  let t = getTypeOfSymbol(c, localOrExportSymbol);
  const assignmentKind = getAssignmentTargetKind(node);
  if (assignmentKind !== AssignmentKind.None) {
    if ((localOrExportSymbol.flags & SymbolFlags.Variable) === 0) {
      let message = Diagnostics.Cannot_assign_to_0_because_it_is_not_a_variable;
      if ((localOrExportSymbol.flags & SymbolFlags.Enum) !== 0)
        message = Diagnostics.Cannot_assign_to_0_because_it_is_an_enum;
      else if ((localOrExportSymbol.flags & SymbolFlags.Class) !== 0)
        message = Diagnostics.Cannot_assign_to_0_because_it_is_a_class;
      else if ((localOrExportSymbol.flags & SymbolFlags.Module) !== 0)
        message = Diagnostics.Cannot_assign_to_0_because_it_is_a_namespace;
      else if ((localOrExportSymbol.flags & SymbolFlags.Function) !== 0)
        message = Diagnostics.Cannot_assign_to_0_because_it_is_a_function;
      else if ((localOrExportSymbol.flags & SymbolFlags.Alias) !== 0)
        message = Diagnostics.Cannot_assign_to_0_because_it_is_an_import;
      c.error(node, message, symbolToString(c, symbol));
      return c.errorType;
    }
    if (isReadonlySymbol(c, localOrExportSymbol)) {
      c.error(node, Diagnostics.Cannot_assign_to_0_because_it_is_a_constant, symbolToString(c, symbol));
      return c.errorType;
    }
  }
  const isAlias = (localOrExportSymbol.flags & SymbolFlags.Alias) !== 0;
  // Only variables and parameters outside assignment targets are narrowed.
  if ((localOrExportSymbol.flags & SymbolFlags.Variable) !== 0) {
    if (assignmentKind === AssignmentKind.Definite)
      return isInCompoundLikeAssignment(node) ? getBaseTypeOfLiteralType(c, t) : t;
  } else if (isAlias) declaration = getDeclarationOfAliasSymbol(symbol);
  else return t;
  if (declaration === undefined) return t;
  const isParameter = getRootDeclaration(declaration).kind === SyntaxKind.Parameter;
  const declarationContainer = getControlFlowContainer(declaration);
  let flowContainer = getControlFlowContainer(node);
  const isOuterVariable = flowContainer !== declarationContainer;
  const typeIsAutomatic = t === c.autoType || t === c.autoArrayType;
  const isAutomaticTypeInNonNull = typeIsAutomatic && node.parent!.kind === SyntaxKind.NonNullExpression;
  // Closures see narrowings of constants, and of variables past their last assignment.
  while (
    flowContainer !== declarationContainer &&
    (isFunctionExpressionOrArrowFunction(flowContainer) ||
      isObjectLiteralOrClassExpressionMethodOrAccessor(flowContainer)) &&
    ((isConstantVariable(c, localOrExportSymbol) && t !== c.autoArrayType) ||
      (isParameterOrMutableLocalVariable(c, localOrExportSymbol) && isPastLastAssignment(c, localOrExportSymbol, node)))
  )
    flowContainer = getControlFlowContainer(flowContainer);
  const isNeverInitialized =
    immediateDeclaration !== undefined &&
    immediateDeclaration.kind === SyntaxKind.VariableDeclaration &&
    immediateDeclaration.parent!.parent!.kind !== SyntaxKind.ForInStatement &&
    immediateDeclaration.parent!.parent!.kind !== SyntaxKind.ForOfStatement &&
    getInitializer(immediateDeclaration) === undefined &&
    (immediateDeclaration as VariableDeclaration).exclamationToken === undefined &&
    isMutableLocalVariableDeclaration(immediateDeclaration) &&
    !isSymbolAssignedDefinitely(c, localOrExportSymbol);
  const assumeInitialized =
    isParameter ||
    isAlias ||
    (isOuterVariable && !isNeverInitialized) ||
    declaration.kind === SyntaxKind.BindingElement ||
    (t !== c.autoType &&
      t !== c.autoArrayType &&
      (!c.strictNullChecks ||
        (t.flags & (TypeFlags.AnyOrUnknown | TypeFlags.Void)) !== 0 ||
        isPartOfTypeQuery(node) ||
        isInAmbientOrTypeNode(node) ||
        node.parent!.kind === SyntaxKind.ExportSpecifier)) ||
    node.parent!.kind === SyntaxKind.NonNullExpression ||
    (declaration.kind === SyntaxKind.VariableDeclaration &&
      (declaration as VariableDeclaration).exclamationToken !== undefined) ||
    (declaration.flags & NodeFlags.Ambient) !== 0;
  let initialType: Type;
  if (isAutomaticTypeInNonNull) initialType = c.undefinedType;
  else if (assumeInitialized) initialType = t;
  else if (typeIsAutomatic) initialType = c.undefinedType;
  else initialType = getOptionalType(c, t, false);
  let flowType = getFlowTypeOfReference(c, node, t, initialType, flowContainer);
  if (isAutomaticTypeInNonNull) flowType = getNonNullableType(c, flowType);
  if (typeIsAutomatic) {
    if (flowType === c.autoType || flowType === c.autoArrayType) {
      if (c.noImplicitAny) {
        c.error(
          getNameOfDeclaration(declaration),
          Diagnostics.Variable_0_implicitly_has_type_1_in_some_locations_where_its_type_cannot_be_determined,
          symbolToString(c, symbol),
          typeToString(c, flowType),
        );
        c.error(
          node,
          Diagnostics.Variable_0_implicitly_has_an_1_type,
          symbolToString(c, symbol),
          typeToString(c, flowType),
        );
      }
      return convertAutoToAny(c, flowType);
    }
  } else if (!assumeInitialized && !containsUndefinedType(c, t) && containsUndefinedType(c, flowType)) {
    c.error(node, Diagnostics.Variable_0_is_used_before_being_assigned, symbolToString(c, symbol));
    return t;
  }
  return assignmentKind !== AssignmentKind.None ? getBaseTypeOfLiteralType(c, flowType) : flowType;
}

function containsUndefinedType(c: Checker, t: Type): boolean {
  const u = (t.flags & TypeFlags.Union) !== 0 ? (t as UnionType).types[0] : t;
  return (u.flags & TypeFlags.Undefined) !== 0 && u !== c.missingType;
}

function isInAmbientOrTypeNode(node: Node): boolean {
  if ((node.flags & NodeFlags.Ambient) !== 0) return true;
  for (let current: Node | undefined = node; current !== undefined; current = current.parent) {
    if (
      current.kind === SyntaxKind.InterfaceDeclaration ||
      current.kind === SyntaxKind.TypeAliasDeclaration ||
      current.kind === SyntaxKind.TypeLiteral
    )
      return true;
  }
  return false;
}

export function checkThisExpression(c: Checker, node: Node): Type {
  let container = getThisContainer(node, true, true);
  let capturedByArrowFunction = false;
  if (container.kind === SyntaxKind.ArrowFunction) {
    container = getThisContainer(container, false, true);
    capturedByArrowFunction = true;
  }
  const t = tryGetThisTypeAt(c, node, container);
  if (c.noImplicitThis) {
    const globalThisType = getTypeOfSymbol(c, c.globalThisSymbol);
    if (t === globalThisType && capturedByArrowFunction)
      c.error(node, Diagnostics.The_containing_arrow_function_captures_the_global_value_of_this);
    else if (t === undefined)
      c.error(node, Diagnostics.X_this_implicitly_has_type_any_because_it_does_not_have_a_type_annotation);
  }
  return t ?? c.anyType;
}

function tryGetThisTypeAt(c: Checker, node: Node, container: Node): Type | undefined {
  if (isFunctionLike(container) && container.kind !== SyntaxKind.Constructor) {
    const thisType =
      getThisTypeOfSignature(c, getSignatureFromDeclaration(c, container)) ??
      getContextualThisParameterType(c, container);
    if (thisType !== undefined) return thisType;
  }
  const parent = container.parent;
  if (parent !== undefined && isClassLike(parent)) {
    const classSymbol = getSymbolOfDeclaration(c, parent);
    if (classSymbol === undefined) return c.anyType;
    if (isStatic(container) || container.kind === SyntaxKind.ClassStaticBlockDeclaration)
      return getTypeOfSymbol(c, classSymbol);
    return getDeclaredTypeOfClassOrInterface(c, getMergedSymbol(c, classSymbol)).thisType ?? c.anyType;
  }
  if (container.kind === SyntaxKind.SourceFile) {
    if ((container as SourceFile).externalModuleIndicator !== undefined) return c.undefinedType;
    return getTypeOfSymbol(c, c.globalThisSymbol);
  }
  return undefined;
}

/** The `this` type of a function expression or method from its context, such as its object literal. */
function getContextualThisParameterType(c: Checker, func: Node): Type | undefined {
  if (func.kind === SyntaxKind.ArrowFunction) return undefined;
  if (
    func.kind !== SyntaxKind.FunctionExpression &&
    func.kind !== SyntaxKind.MethodDeclaration &&
    func.kind !== SyntaxKind.GetAccessor &&
    func.kind !== SyntaxKind.SetAccessor
  )
    return undefined;
  const signature = getContextualSignatureForFunctionLikeDeclaration(c, func);
  if (signature !== undefined) {
    const thisType = getThisTypeOfSignature(c, signature);
    if (thisType !== undefined) return thisType;
  }
  if (!c.noImplicitThis) return undefined;
  const literal = getContainingObjectLiteral(func);
  if (literal === undefined) return undefined;
  // Without ThisType markers or literal types under construction, any containing literal gives `this` a type.
  return c.anyType;
}

function getContainingObjectLiteral(func: Node): Node | undefined {
  const parent = func.parent!;
  if (
    (func.kind === SyntaxKind.MethodDeclaration ||
      func.kind === SyntaxKind.GetAccessor ||
      func.kind === SyntaxKind.SetAccessor) &&
    parent.kind === SyntaxKind.ObjectLiteralExpression
  )
    return parent;
  if (func.kind === SyntaxKind.FunctionExpression && parent.kind === SyntaxKind.PropertyAssignment)
    return parent.parent;
  return undefined;
}

// ---- Literals

function checkTemplateExpression(c: Checker, node: TemplateExpression): Type {
  for (const span of node.templateSpans.nodes) checkExpression(c, getExpression(span)!);
  return c.stringType;
}

function checkSpreadExpression(c: Checker, node: SpreadElement, checkMode: CheckMode): Type {
  const arrayOrIterable = checkExpressionEx(c, node.expression, checkMode);
  return getIteratedTypeOrElementType(c, arrayOrIterable);
}

/** The element type of an array, tuple or string; `any` for other iterables (not yet resolved). */
export function getIteratedTypeOrElementType(c: Checker, t: Type): Type {
  if ((t.flags & TypeFlags.Any) !== 0) return t;
  if ((t.flags & TypeFlags.StringLike) !== 0) return c.stringType;
  if ((t.flags & TypeFlags.Union) !== 0) {
    const types: Type[] = [];
    for (const u of typesOf(t)) types.push(getIteratedTypeOrElementType(c, u));
    return getUnionType(c, types);
  }
  const indexInfo = getApplicableIndexInfoForName(c, getApparentType(c, t), '0');
  if (isTupleType(t) || indexInfo !== undefined) {
    const numberIndex = getIndexedAccessTypeEx(c, t, c.numberType, AccessFlags.None, undefined, undefined);
    if (!isErrorType(c, numberIndex)) return numberIndex;
  }
  return c.anyType;
}

function checkArrayLiteral(c: Checker, node: ArrayLiteralExpression, checkMode: CheckMode): Type {
  const elements = node.elements.nodes;
  const elementTypes: Type[] = [];
  const elementFlags: ElementFlags[] = [];
  const inConstContext = isConstContext(node);
  const contextualType = getContextualType(c, node);
  const inTupleContext =
    inConstContext || (contextualType !== undefined && someType(contextualType, isTupleLikeContext));
  for (const e of elements) {
    if (e.kind === SyntaxKind.SpreadElement) {
      const spreadType = checkExpressionEx(c, (e as SpreadElement).expression, checkMode);
      if (isTupleType(spreadType)) {
        elementTypes.push(spreadType);
        elementFlags.push(ElementFlags.Variadic);
      } else {
        elementTypes.push(getIteratedTypeOrElementType(c, spreadType));
        elementFlags.push(ElementFlags.Rest);
      }
      continue;
    }
    const t =
      e.kind === SyntaxKind.OmittedExpression ? c.undefinedWideningType : checkExpressionForMutableLocation(c, e);
    elementTypes.push(t);
    elementFlags.push(ElementFlags.Required);
  }
  if (inTupleContext)
    return createArrayLiteralType(
      c,
      createTupleTypeEx(
        c,
        elementTypes,
        elementFlags.map((f) => new TupleElementInfo(f, undefined)),
        inConstContext,
      ),
    );
  const types: Type[] = [];
  for (let i = 0; i < elementTypes.length; i++) {
    if ((elementFlags[i] & ElementFlags.Variadic) !== 0)
      types.push(getIndexedAccessTypeEx(c, elementTypes[i], c.numberType, AccessFlags.None, undefined, undefined));
    else types.push(elementTypes[i]);
  }
  const elementType =
    types.length > 0
      ? getUnionTypeEx(c, types, UnionReduction.Subtype, undefined, undefined)
      : c.strictNullChecks
        ? c.implicitNeverType
        : c.undefinedWideningType;
  return createArrayLiteralType(c, createArrayType(c, elementType));
}

function isTupleLikeContext(t: Type): boolean {
  if ((t.flags & TypeFlags.Intersection) !== 0) return typesOf(t).some(isTupleLikeContext);
  return isTupleType(t);
}

function createArrayLiteralType(c: Checker, t: Type): Type {
  if ((t.objectFlags & ObjectFlags.Reference) === 0) return t;
  const key = 'arrayLiteral' + t.id;
  let literal = c.cachedTypes.get(key);
  if (literal === undefined) {
    // Array literal types share the reference but are marked so widening can find them.
    literal = t;
    literal.objectFlags |= ObjectFlags.ArrayLiteral | ObjectFlags.ContainsObjectOrArrayLiteral;
    c.cachedTypes.set(key, literal);
  }
  return literal;
}

/** The name of an object literal element, or undefined when it's computed and not a literal. */
export function getPropertyNameOfObjectLiteralElement(c: Checker, element: Node): string | undefined {
  const name = getName(element);
  if (name === undefined) return undefined;
  switch (name.kind) {
    case SyntaxKind.Identifier:
    case SyntaxKind.PrivateIdentifier:
    case SyntaxKind.StringLiteral:
    case SyntaxKind.NoSubstitutionTemplateLiteral:
      return getText(name);
    case SyntaxKind.NumericLiteral:
      return String(Number(getText(name)));
    case SyntaxKind.BigIntLiteral:
      return parseBigIntText(getText(name));
    case SyntaxKind.ComputedPropertyName: {
      const t = checkComputedPropertyName(c, name);
      return isTypeUsableAsPropertyName(t) ? getPropertyNameFromType(t) : undefined;
    }
  }
  return undefined;
}

function checkObjectLiteral(c: Checker, node: Node, checkMode: CheckMode): Type {
  const inConstContext = isConstContext(node);
  const members = new Map<string, Symbol>();
  const propertyTypes: Type[] = [];
  let objectFlags = ObjectFlags.FreshLiteral;
  let hasComputedString = false;
  let hasComputedNumber = false;
  let hasComputedSymbol = false;
  let spread: Type | undefined = undefined;
  const nodeSymbol = getSymbol(node);
  for (const member of getProperties(node)!.nodes) {
    let memberSymbol = getSymbol(member);
    if (
      member.kind === SyntaxKind.PropertyAssignment ||
      member.kind === SyntaxKind.ShorthandPropertyAssignment ||
      member.kind === SyntaxKind.MethodDeclaration
    ) {
      let t: Type;
      if (member.kind === SyntaxKind.PropertyAssignment)
        t = checkPropertyAssignment(c, member as PropertyAssignment, checkMode);
      else if (member.kind === SyntaxKind.ShorthandPropertyAssignment) {
        const name = getName(member)!;
        t = checkExpressionForMutableLocationOf(c, name, checkIdentifier(c, name as Identifier), member);
      } else t = getTypeOfObjectLiteralMethod(c, member, checkMode);
      objectFlags |= t.objectFlags & ObjectFlags.PropagatingFlags;
      const name = getName(member)!;
      const computedType =
        name.kind === SyntaxKind.ComputedPropertyName ? checkComputedPropertyName(c, name) : undefined;
      if (computedType !== undefined && !isTypeUsableAsPropertyName(computedType)) {
        if (isTypeAssignableTo(c, computedType, c.stringNumberSymbolType)) {
          if (isTypeAssignableTo(c, computedType, c.numberType)) hasComputedNumber = true;
          else if (isTypeAssignableTo(c, computedType, c.esSymbolType)) hasComputedSymbol = true;
          else hasComputedString = true;
          propertyTypes.push(t);
        }
        continue;
      }
      if (memberSymbol === undefined) continue;
      const prop = c.newSymbolWithCheckFlags(
        SymbolFlags.Property | (memberSymbol.flags & SymbolFlags.Optional),
        memberSymbol.name,
        inConstContext ? CheckFlags.Readonly : 0,
      );
      prop.declarations = memberSymbol.declarations;
      prop.parent = memberSymbol.parent;
      prop.valueDeclaration = memberSymbol.valueDeclaration;
      const links = c.symbolLinks(prop);
      links.type = t;
      links.target = memberSymbol;
      if (computedType !== undefined) links.nameType = computedType;
      members.set(prop.name, prop);
      propertyTypes.push(t);
    } else if (member.kind === SyntaxKind.SpreadAssignment) {
      const spreadType = checkExpression(c, getExpression(member)!);
      spread = spread === undefined ? spreadType : c.anyType;
      if ((spreadType.flags & (TypeFlags.Object | TypeFlags.Intersection)) === 0 || isGenericObjectType(c, spreadType))
        spread = c.anyType;
      else spread = c.anyType;
    } else if (member.kind === SyntaxKind.GetAccessor || member.kind === SyntaxKind.SetAccessor) {
      checkFunctionExpressionOrObjectLiteralMethod(c, member, checkMode);
      if (memberSymbol === undefined) continue;
      memberSymbol = getMergedSymbol(c, memberSymbol);
      if (!members.has(memberSymbol.name)) {
        members.set(memberSymbol.name, memberSymbol);
        propertyTypes.push(getTypeOfSymbol(c, memberSymbol));
      }
    }
  }
  if (spread !== undefined) return spread;
  const indexInfos: IndexInfo[] = [];
  if (hasComputedString)
    indexInfos.push(newIndexInfo(c.stringType, getUnionType(c, propertyTypes), inConstContext, undefined));
  if (hasComputedNumber)
    indexInfos.push(newIndexInfo(c.numberType, getUnionType(c, propertyTypes), inConstContext, undefined));
  if (hasComputedSymbol)
    indexInfos.push(newIndexInfo(c.esSymbolType, getUnionType(c, propertyTypes), inConstContext, undefined));
  const result = createAnonymousType(c, nodeSymbol, members, [], [], indexInfos);
  result.objectFlags |= objectFlags | ObjectFlags.ObjectLiteral | ObjectFlags.ContainsObjectOrArrayLiteral;
  result.objectFlags |= getPropagatingFlagsOfTypes(propertyTypes, TypeFlags.None) & ObjectFlags.PropagatingFlags;
  return result;
}

function checkPropertyAssignment(c: Checker, node: PropertyAssignment, _checkMode: CheckMode): Type {
  if (node.name.kind === SyntaxKind.ComputedPropertyName) checkComputedPropertyName(c, node.name);
  return checkExpressionForMutableLocation(c, node.initializer);
}

function checkExpressionForMutableLocationOf(c: Checker, _expr: Node, t: Type, position: Node): Type {
  if (isConstContext(position)) return getRegularTypeOfLiteralType(c, t);
  return getWidenedLiteralLikeTypeForContextualType(c, t, getContextualType(c, position));
}

/** Whether `node` is in an `as const` context, where literals keep their types. */
export function isConstContext(node: Node): boolean {
  const parent = node.parent;
  if (parent === undefined) return false;
  switch (parent.kind) {
    case SyntaxKind.AsExpression:
    case SyntaxKind.TypeAssertionExpression:
      return isConstTypeReference(getType(parent)!);
    case SyntaxKind.ParenthesizedExpression:
    case SyntaxKind.ArrayLiteralExpression:
    case SyntaxKind.SpreadElement:
    case SyntaxKind.SatisfiesExpression:
      return isConstContext(parent);
    case SyntaxKind.PropertyAssignment:
    case SyntaxKind.ShorthandPropertyAssignment:
      return isConstContext(parent.parent!);
    case SyntaxKind.TemplateSpan:
      return isConstContext(parent.parent!);
    case SyntaxKind.ConditionalExpression:
      return (parent as ConditionalExpression).condition !== node && isConstContext(parent);
  }
  return false;
}

export function isConstTypeReference(node: Node): boolean {
  if (node.kind !== SyntaxKind.TypeReference) return false;
  const ref = node as TypeReferenceNode;
  return (
    ref.typeName.kind === SyntaxKind.Identifier && getText(ref.typeName) === 'const' && ref.typeArguments === undefined
  );
}

/** Widens a literal type unless the contextual type calls for literals of its kind. */
export function getWidenedLiteralLikeTypeForContextualType(
  c: Checker,
  t: Type,
  contextualType: Type | undefined,
): Type {
  if (!isLiteralOfContextualType(c, t, contextualType)) return getWidenedLiteralType(c, t);
  return getRegularTypeOfLiteralType(c, t);
}

export function isLiteralOfContextualType(c: Checker, candidate: Type, contextualType: Type | undefined): boolean {
  if (contextualType === undefined) return false;
  if ((contextualType.flags & TypeFlags.UnionOrIntersection) !== 0) {
    for (const t of typesOf(contextualType)) if (isLiteralOfContextualType(c, candidate, t)) return true;
    return false;
  }
  if ((contextualType.flags & TypeFlags.InstantiableNonPrimitive) !== 0) {
    const constraint = getBaseConstraintOfType(c, contextualType) ?? c.unknownType;
    return (
      (maybeTypeOfKind(constraint, TypeFlags.String) && maybeTypeOfKind(candidate, TypeFlags.StringLiteral)) ||
      (maybeTypeOfKind(constraint, TypeFlags.Number) && maybeTypeOfKind(candidate, TypeFlags.NumberLiteral)) ||
      (maybeTypeOfKind(constraint, TypeFlags.BigInt) && maybeTypeOfKind(candidate, TypeFlags.BigIntLiteral)) ||
      (maybeTypeOfKind(constraint, TypeFlags.ESSymbol) && maybeTypeOfKind(candidate, TypeFlags.UniqueESSymbol)) ||
      isLiteralOfContextualType(c, candidate, constraint)
    );
  }
  return (
    ((contextualType.flags &
      (TypeFlags.StringLiteral | TypeFlags.Index | TypeFlags.TemplateLiteral | TypeFlags.StringMapping)) !==
      0 &&
      maybeTypeOfKind(candidate, TypeFlags.StringLiteral)) ||
    ((contextualType.flags & TypeFlags.NumberLiteral) !== 0 && maybeTypeOfKind(candidate, TypeFlags.NumberLiteral)) ||
    ((contextualType.flags & TypeFlags.BigIntLiteral) !== 0 && maybeTypeOfKind(candidate, TypeFlags.BigIntLiteral)) ||
    ((contextualType.flags & TypeFlags.BooleanLiteral) !== 0 && maybeTypeOfKind(candidate, TypeFlags.BooleanLiteral)) ||
    ((contextualType.flags & TypeFlags.UniqueESSymbol) !== 0 && maybeTypeOfKind(candidate, TypeFlags.UniqueESSymbol))
  );
}

// ---- Property and element access

/**
 * The type of an expression used as an object, with `null` and `undefined` removed. Without
 * narrowing, nullability errors are only reported where no narrowing could apply.
 */
export function checkNonNullExpression(c: Checker, node: Node): Type {
  return checkNonNullType(c, checkExpression(c, node), node);
}

export function checkNonNullType(c: Checker, t: Type, node: Node): Type {
  if (c.strictNullChecks && (t.flags & TypeFlags.Unknown) !== 0) {
    if (isEntityNameExpression(node, false)) {
      const nodeText = entityNameToString(node);
      if (nodeText.length < 100) {
        c.error(node, Diagnostics.X_0_is_of_type_unknown, nodeText);
        return c.errorType;
      }
    }
    c.error(node, Diagnostics.Object_is_of_type_unknown);
    return c.errorType;
  }
  const facts = getTypeFacts(c, t, TypeFacts.IsUndefinedOrNull);
  if ((facts & TypeFacts.IsUndefinedOrNull) !== 0) {
    reportObjectPossiblyNullOrUndefinedError(c, node, facts);
    const nonNullable = getNonNullableType(c, t);
    return (nonNullable.flags & (TypeFlags.Nullable | TypeFlags.Never)) !== 0 ? c.errorType : nonNullable;
  }
  return t;
}

function reportObjectPossiblyNullOrUndefinedError(c: Checker, node: Node, facts: TypeFacts): void {
  if (node.kind === SyntaxKind.NullKeyword) {
    c.error(node, Diagnostics.The_value_0_cannot_be_used_here, 'null');
    return;
  }
  const nodeText = isEntityNameExpression(node, false) ? entityNameToString(node) : '';
  if (nodeText !== '' && nodeText.length < 100) {
    if (node.kind === SyntaxKind.Identifier && nodeText === 'undefined') {
      c.error(node, Diagnostics.The_value_0_cannot_be_used_here, 'undefined');
      return;
    }
    c.error(
      node,
      (facts & TypeFacts.IsUndefined) !== 0
        ? (facts & TypeFacts.IsNull) !== 0
          ? Diagnostics.X_0_is_possibly_null_or_undefined
          : Diagnostics.X_0_is_possibly_undefined
        : Diagnostics.X_0_is_possibly_null,
      nodeText,
    );
  } else {
    c.error(
      node,
      (facts & TypeFacts.IsUndefined) !== 0
        ? (facts & TypeFacts.IsNull) !== 0
          ? Diagnostics.Object_is_possibly_null_or_undefined
          : Diagnostics.Object_is_possibly_undefined
        : Diagnostics.Object_is_possibly_null,
    );
  }
}

function entityNameToString(node: Node): string {
  switch (node.kind) {
    case SyntaxKind.Identifier:
      return getText(node);
    case SyntaxKind.ThisKeyword:
      return 'this';
    case SyntaxKind.PropertyAccessExpression: {
      const access = node as PropertyAccessExpression;
      return entityNameToString(access.expression) + '.' + entityNameToString(access.name);
    }
    case SyntaxKind.QualifiedName: {
      const q = node as QualifiedName;
      return entityNameToString(q.left) + '.' + q.right.text;
    }
  }
  return getText(node);
}

function checkPropertyAccessExpression(c: Checker, node: PropertyAccessExpression, _checkMode: CheckMode): Type {
  if (!isOptionalChain(node))
    return checkPropertyAccessWorker(c, node, node.expression, checkNonNullExpression(c, node.expression), node.name);
  const leftType = checkExpression(c, node.expression);
  const nonOptional = getOptionalExpressionType(c, leftType, node.expression);
  const t = checkPropertyAccessWorker(
    c,
    node,
    node.expression,
    checkNonNullType(c, nonOptional, node.expression),
    node.name,
  );
  return propagateOptionalTypeMarker(c, t, node, nonOptional !== leftType);
}

function checkQualifiedName(c: Checker, node: QualifiedName): Type {
  const leftType = checkNonNullExpressionOfEntity(c, node.left);
  return checkPropertyAccessWorker(c, node, node.left, leftType, node.right);
}

function checkNonNullExpressionOfEntity(c: Checker, node: Node): Type {
  if (node.kind === SyntaxKind.Identifier) return checkNonNullType(c, checkIdentifier(c, node as Identifier), node);
  return checkNonNullType(c, checkQualifiedName(c, node as QualifiedName), node);
}

function checkPropertyAccessWorker(c: Checker, node: Node, left: Node, leftType: Type, right: Node): Type {
  if (isErrorType(c, leftType) || (leftType.flags & TypeFlags.Any) !== 0)
    return leftType === c.errorType ? c.errorType : c.anyType;
  if (right.kind === SyntaxKind.PrivateIdentifier) return c.anyType;
  const assignmentTarget = getAssignmentTarget(node);
  const apparentType = getApparentType(
    c,
    assignmentTarget !== undefined || isMethodAccessForCall(node) ? getWidenedType(c, leftType) : leftType,
  );
  if (isErrorType(c, apparentType) || (apparentType.flags & TypeFlags.Any) !== 0) return apparentType;
  const name = getText(right);
  const prop = getPropertyOfType(c, apparentType, name);
  if (prop === undefined) {
    const indexInfo = getApplicableIndexInfoForName(c, apparentType, name);
    if (indexInfo !== undefined) {
      c.nodeLinks(node).resolvedSymbol = undefined;
      if (indexInfo.isReadonly && assignmentTarget !== undefined)
        c.error(node, Diagnostics.Index_signature_in_type_0_only_permits_reading, typeToString(c, apparentType));
      return indexInfo.valueType;
    }
    if ((leftType.flags & TypeFlags.Never) !== 0 && left.kind !== SyntaxKind.ThisKeyword) {
      c.error(right, Diagnostics.Property_0_does_not_exist_on_type_1, name, typeToString(c, leftType));
      return c.errorType;
    }
    if (leftType.symbol === c.globalThisSymbol) return c.anyType;
    if (isTypeParameterLike(leftType)) return c.anyType;
    reportNonexistentProperty(c, right, isThisTypeParameterLike(leftType) ? apparentType : leftType);
    return c.errorType;
  }
  if (
    assignmentTarget !== undefined &&
    isReadonlySymbol(c, prop) &&
    !isAssignmentToReadonlyInConstructor(c, node, prop)
  ) {
    c.error(right, Diagnostics.Cannot_assign_to_0_because_it_is_a_read_only_property, name);
    return c.errorType;
  }
  return getFlowTypeOfAccessExpression(c, node, prop, getTypeOfSymbol(c, prop), right);
}

function getFlowTypeOfAccessExpression(
  c: Checker,
  node: Node,
  prop: Symbol | undefined,
  propTypeIn: Type,
  errorNode: Node,
): Type {
  const propType = propTypeIn;
  const assignmentKind = getAssignmentTargetKind(node);
  if (assignmentKind === AssignmentKind.Definite)
    return removeMissingType(c, propType, prop !== undefined && (prop.flags & SymbolFlags.Optional) !== 0);
  if (
    prop !== undefined &&
    (prop.flags & (SymbolFlags.Variable | SymbolFlags.Property | SymbolFlags.Accessor)) === 0 &&
    !((prop.flags & SymbolFlags.Method) !== 0 && (propType.flags & TypeFlags.Union) !== 0)
  )
    return propType;
  if (propType === c.autoType) return c.anyType;
  // `this.x` in the constructor of x's class starts out uninitialized under strictPropertyInitialization.
  let assumeUninitialized = false;
  const expression = getExpression(node);
  if (
    c.strictNullChecks &&
    c.strictPropertyInitialization &&
    expression !== undefined &&
    expression.kind === SyntaxKind.ThisKeyword &&
    prop !== undefined
  ) {
    const declaration = prop.valueDeclaration;
    if (declaration !== undefined && isPropertyWithoutInitializer(declaration) && !isStatic(declaration)) {
      const flowContainer = getControlFlowContainer(node);
      assumeUninitialized =
        flowContainer.kind === SyntaxKind.Constructor &&
        flowContainer.parent === declaration.parent &&
        (declaration.flags & NodeFlags.Ambient) === 0;
    }
  }
  const initialType = assumeUninitialized ? getOptionalType(c, propType, false) : propType;
  const flowType = getFlowTypeOfReference(c, node, propType, initialType, undefined);
  if (assumeUninitialized && !containsUndefinedType(c, propType) && containsUndefinedType(c, flowType)) {
    c.error(errorNode, Diagnostics.Property_0_is_used_before_being_assigned, symbolToString(c, prop!));
    return propType;
  }
  return assignmentKind !== AssignmentKind.None ? getBaseTypeOfLiteralType(c, flowType) : flowType;
}

function isPropertyWithoutInitializer(node: Node): boolean {
  return (
    node.kind === SyntaxKind.PropertyDeclaration &&
    !hasSyntacticModifier(node, ModifierFlags.Abstract) &&
    (node as PropertyDeclaration).postfixToken === undefined &&
    getInitializer(node) === undefined
  );
}

function isTypeParameterLike(t: Type): boolean {
  return (t.flags & TypeFlags.TypeParameter) !== 0 && (t.flags & TypeFlags.Any) === 0 && false;
}

function isThisTypeParameterLike(t: Type): boolean {
  return (t.flags & TypeFlags.TypeParameter) !== 0;
}

function isAssignmentToReadonlyInConstructor(c: Checker, node: Node, prop: Symbol): boolean {
  // Readonly properties may be assigned through `this` in their class's constructor.
  if ((prop.flags & (SymbolFlags.Property | SymbolFlags.Accessor)) === 0) return false;
  const expr = getExpression(node);
  if (expr === undefined || expr.kind !== SyntaxKind.ThisKeyword) return false;
  let container = getThisContainer(node, true, false);
  while (container.kind === SyntaxKind.ArrowFunction) container = getThisContainer(container, true, false);
  if (container.kind !== SyntaxKind.Constructor && container.kind !== SyntaxKind.PropertyDeclaration) return false;
  const decl = prop.valueDeclaration;
  if (decl === undefined) return false;
  const declClass = decl.kind === SyntaxKind.Parameter ? decl.parent!.parent : decl.parent;
  return declClass === container.parent;
}

function isMethodAccessForCall(node: Node): boolean {
  let current = node;
  while (current.parent !== undefined && current.parent.kind === SyntaxKind.ParenthesizedExpression)
    current = current.parent;
  return (
    current.parent !== undefined &&
    current.parent.kind === SyntaxKind.CallExpression &&
    getExpression(current.parent) === current
  );
}

function reportNonexistentProperty(c: Checker, propNode: Node, containingType: Type): void {
  const links = c.nodeLinks(propNode);
  if ((links.flags & 1) !== 0) return;
  links.flags |= 1;
  const name = declarationNameToString(getSourceFileOfNode(propNode), propNode);
  const container = typeToString(c, containingType);
  const suggestion = getSuggestedSymbolForNonexistentProperty(c, getText(propNode), containingType);
  if (suggestion !== undefined) {
    const diagnostic = createDiagnosticForNode(
      propNode,
      Diagnostics.Property_0_does_not_exist_on_type_1_Did_you_mean_2,
      [name, container, suggestion.name],
    );
    if (suggestion.valueDeclaration !== undefined)
      diagnostic.addRelatedInfo(
        createDiagnosticForNode(suggestion.valueDeclaration, Diagnostics.X_0_is_declared_here, [suggestion.name]),
      );
    c.addDiagnostic(diagnostic);
    return;
  }
  c.error(propNode, Diagnostics.Property_0_does_not_exist_on_type_1, name, container);
}

function getSuggestedSymbolForNonexistentProperty(c: Checker, name: string, containingType: Type): Symbol | undefined {
  const props = getPropertiesOfType(c, containingType);
  const candidates: string[] = [];
  const symbols: Symbol[] = [];
  for (const p of props) {
    const n = p.name;
    if (n.length === 0 || n.charCodeAt(0) === 0x22 || n.charCodeAt(0) === 0xfffe) continue;
    if ((p.flags & SymbolFlags.Value) === 0) continue;
    candidates.push(n);
    symbols.push(p);
  }
  const best = getSpellingSuggestion(name, candidates);
  if (best === '') return undefined;
  return symbols[candidates.indexOf(best)];
}

function checkElementAccessExpression(c: Checker, node: ElementAccessExpression, _checkMode: CheckMode): Type {
  let exprType = checkExpression(c, node.expression);
  let wasOptional = false;
  if (isOptionalChain(node)) {
    const nonOptional = getOptionalExpressionType(c, exprType, node.expression);
    wasOptional = nonOptional !== exprType;
    exprType = checkNonNullType(c, nonOptional, node.expression);
  } else exprType = checkNonNullType(c, exprType, node.expression);
  const indexExpression = node.argumentExpression;
  const indexType = checkExpression(c, indexExpression);
  if (isErrorType(c, exprType) || exprType === c.silentNeverType) return exprType;
  const isAssignment = getAssignmentTargetKind(node) !== AssignmentKind.None;
  const objectType = isAssignment ? getWidenedType(c, exprType) : exprType;
  if (isConstEnumObjectTypeLocal(objectType) && !isStringLiteralLike(indexExpression)) {
    c.error(indexExpression, Diagnostics.A_const_enum_member_can_only_be_accessed_using_a_string_literal);
    return c.errorType;
  }
  const effectiveIndexType = isForInVariableForNumericPropertyNames(c, indexExpression) ? c.numberType : indexType;
  const accessFlags = isAssignment
    ? AccessFlags.Writing |
      (isGenericObjectType(c, objectType) && !isThisTypeParameter(objectType) ? AccessFlags.NoIndexSignatures : 0)
    : AccessFlags.ExpressionPosition;
  const indexedAccessType =
    getIndexedAccessTypeOrUndefinedEx(c, objectType, effectiveIndexType, accessFlags, node, undefined) ?? c.errorType;
  const t = getFlowTypeOfAccessExpression(
    c,
    node,
    c.nodeLinks(node).resolvedSymbol,
    indexedAccessType,
    indexExpression,
  );
  return propagateOptionalTypeMarker(c, t, node, wasOptional);
}

function isStringLiteralLike(node: Node): boolean {
  return node.kind === SyntaxKind.StringLiteral || node.kind === SyntaxKind.NoSubstitutionTemplateLiteral;
}

function isConstEnumObjectTypeLocal(t: Type): boolean {
  return (
    (t.objectFlags & ObjectFlags.Anonymous) !== 0 &&
    t.symbol !== undefined &&
    (t.symbol.flags & SymbolFlags.ConstEnum) !== 0
  );
}

function isThisTypeParameter(t: Type): boolean {
  return (t.flags & TypeFlags.TypeParameter) !== 0 && (t as TypeParameter).isThisType;
}

function isForInVariableForNumericPropertyNames(c: Checker, expr: Node): boolean {
  const e = skipParentheses(expr);
  if (e.kind !== SyntaxKind.Identifier) return false;
  const symbol = getResolvedSymbol(c, e);
  if ((symbol.flags & SymbolFlags.Variable) === 0) return false;
  let child = expr;
  let node = expr.parent;
  while (node !== undefined) {
    if (node.kind === SyntaxKind.ForInStatement) {
      const statement = node as ForInOrOfStatement;
      if (
        child === statement.statement &&
        getForInVariableSymbol(c, statement) === symbol &&
        hasNumericPropertyNames(c, checkExpressionCached(c, statement.expression))
      )
        return true;
    }
    child = node;
    node = node.parent;
  }
  return false;
}

function getForInVariableSymbol(c: Checker, node: ForInOrOfStatement): Symbol | undefined {
  const initializer = node.initializer;
  if (initializer.kind === SyntaxKind.VariableDeclarationList) {
    const declarations = (initializer as VariableDeclarationList).declarations.nodes;
    return declarations.length > 0 ? getSymbolOfDeclaration(c, declarations[0]) : undefined;
  }
  return initializer.kind === SyntaxKind.Identifier ? getResolvedSymbol(c, initializer) : undefined;
}

function hasNumericPropertyNames(c: Checker, t: Type): boolean {
  return getIndexInfosOfType(c, t).length === 1 && getIndexInfoOfType(c, t, c.numberType) !== undefined;
}

// ---- Assertions

function checkAssertion(c: Checker, node: Node, checkMode: CheckMode): Type {
  if (isConstTypeReference(getType(node)!)) {
    const exprType = checkExpressionEx(c, getExpression(node)!, checkMode);
    return getRegularTypeOfLiteralType(c, exprType);
  }
  const exprType = checkExpressionEx(c, getExpression(node)!, checkMode);
  const targetType = getTypeFromTypeNode(c, getType(node)!);
  if (!isErrorType(c, targetType)) checkAssertionCompatibility(c, node, exprType, targetType);
  return targetType;
}

function checkAssertionCompatibility(c: Checker, node: Node, exprType: Type, targetType: Type): void {
  const widenedType = getWidenedType(
    c,
    getRegularTypeOfObjectLiteral(c, getBaseTypeOfLiteralTypeForAssertion(c, exprType)),
  );
  if (isErrorType(c, widenedType) || isErrorType(c, targetType)) return;
  if (!isTypeComparableTo(c, targetType, widenedType)) {
    checkTypeComparableTo(
      c,
      exprType,
      targetType,
      node,
      Diagnostics.Conversion_of_type_0_to_type_1_may_be_a_mistake_because_neither_type_sufficiently_overlaps_with_the_other_If_this_was_intentional_convert_the_expression_to_unknown_first,
    );
  }
}

function getBaseTypeOfLiteralTypeForAssertion(c: Checker, t: Type): Type {
  return getWidenedLiteralType(c, t);
}

function checkSatisfiesExpression(c: Checker, node: Node, checkMode: CheckMode): Type {
  const expr = getExpression(node)!;
  const exprType = checkExpressionEx(c, expr, checkMode);
  const targetType = getTypeFromTypeNode(c, getType(node)!);
  if (!isErrorType(c, targetType))
    checkTypeAssignableTo(c, exprType, targetType, node, Diagnostics.Type_0_does_not_satisfy_the_expected_type_1);
  return exprType;
}

// ---- Operators

function checkPrefixUnaryExpression(c: Checker, node: PrefixUnaryExpression): Type {
  const operandType = checkExpression(c, node.operand);
  if (operandType === c.silentNeverType) return c.silentNeverType;
  switch (node.operand.kind) {
    case SyntaxKind.NumericLiteral:
      if (node.operator === SyntaxKind.MinusToken)
        return getFreshTypeOfLiteralType(c, getNumberLiteralType(c, -Number(getText(node.operand))));
      if (node.operator === SyntaxKind.PlusToken)
        return getFreshTypeOfLiteralType(c, getNumberLiteralType(c, Number(getText(node.operand))));
      break;
    case SyntaxKind.BigIntLiteral:
      if (node.operator === SyntaxKind.MinusToken) {
        const value = parseBigIntText(getText(node.operand));
        return getFreshTypeOfLiteralType(c, getBigIntLiteralType(c, value === '0' ? '0' : '-' + value));
      }
      break;
  }
  switch (node.operator) {
    case SyntaxKind.PlusToken:
    case SyntaxKind.MinusToken:
    case SyntaxKind.TildeToken:
      if (maybeTypeOfKind(operandType, TypeFlags.ESSymbolLike))
        c.error(node.operand, Diagnostics.The_0_operator_cannot_be_applied_to_type_symbol, tokenText(node.operator));
      if (node.operator === SyntaxKind.PlusToken) {
        if (maybeTypeOfKind(operandType, TypeFlags.BigIntLike))
          c.error(
            node.operand,
            Diagnostics.Operator_0_cannot_be_applied_to_type_1,
            tokenText(node.operator),
            typeToString(c, getBaseTypeOfLiteralTypeForAssertion(c, operandType)),
          );
        return c.numberType;
      }
      return getUnaryResultType(c, operandType);
    case SyntaxKind.ExclamationToken: {
      const facts = getTypeFacts(c, operandType, TypeFacts.Truthy | TypeFacts.Falsy);
      if (facts === TypeFacts.Truthy) return c.falseType;
      if (facts === TypeFacts.Falsy) return c.trueType;
      return c.booleanType;
    }
    case SyntaxKind.PlusPlusToken:
    case SyntaxKind.MinusMinusToken:
      if (
        checkArithmeticOperandType(
          c,
          node.operand,
          getNonNullableType(c, operandType),
          Diagnostics.An_arithmetic_operand_must_be_of_type_any_number_bigint_or_an_enum_type,
        )
      )
        checkReferenceExpression(c, node.operand);
      return getUnaryResultType(c, operandType);
  }
  return c.errorType;
}

function checkPostfixUnaryExpression(c: Checker, node: PostfixUnaryExpression): Type {
  const operandType = checkExpression(c, node.operand);
  if (operandType === c.silentNeverType) return c.silentNeverType;
  if (
    checkArithmeticOperandType(
      c,
      node.operand,
      getNonNullableType(c, operandType),
      Diagnostics.An_arithmetic_operand_must_be_of_type_any_number_bigint_or_an_enum_type,
    )
  )
    checkReferenceExpression(c, node.operand);
  return getUnaryResultType(c, operandType);
}

function checkReferenceExpression(c: Checker, expr: Node): boolean {
  const node = skipParentheses(expr);
  if (
    node.kind !== SyntaxKind.Identifier &&
    node.kind !== SyntaxKind.PropertyAccessExpression &&
    node.kind !== SyntaxKind.ElementAccessExpression
  ) {
    c.error(
      expr,
      Diagnostics.The_operand_of_an_increment_or_decrement_operator_must_be_a_variable_or_a_property_access,
    );
    return false;
  }
  return true;
}

function getUnaryResultType(c: Checker, operandType: Type): Type {
  if (maybeTypeOfKind(operandType, TypeFlags.BigIntLike)) {
    return isTypeAssignableToKind(c, operandType, TypeFlags.AnyOrUnknown, false) ||
      maybeTypeOfKind(operandType, TypeFlags.NumberLike)
      ? c.numberOrBigIntType
      : c.bigintType;
  }
  return c.numberType;
}

function checkArithmeticOperandType(c: Checker, operand: Node, t: Type, message: DiagnosticMessage): boolean {
  if (!isTypeAssignableTo(c, t, c.numberOrBigIntType)) {
    checkTypeAssignableTo(c, t, c.numberOrBigIntType, operand, message);
    return false;
  }
  return true;
}

function tokenText(kind: SyntaxKind): string {
  switch (kind) {
    case SyntaxKind.PlusToken:
      return '+';
    case SyntaxKind.MinusToken:
      return '-';
    case SyntaxKind.TildeToken:
      return '~';
    case SyntaxKind.ExclamationToken:
      return '!';
    case SyntaxKind.AsteriskToken:
      return '*';
    case SyntaxKind.SlashToken:
      return '/';
    case SyntaxKind.PercentToken:
      return '%';
    case SyntaxKind.AsteriskAsteriskToken:
      return '**';
    case SyntaxKind.LessThanLessThanToken:
      return '<<';
    case SyntaxKind.GreaterThanGreaterThanToken:
      return '>>';
    case SyntaxKind.GreaterThanGreaterThanGreaterThanToken:
      return '>>>';
    case SyntaxKind.AmpersandToken:
      return '&';
    case SyntaxKind.BarToken:
      return '|';
    case SyntaxKind.CaretToken:
      return '^';
    case SyntaxKind.LessThanToken:
      return '<';
    case SyntaxKind.GreaterThanToken:
      return '>';
    case SyntaxKind.LessThanEqualsToken:
      return '<=';
    case SyntaxKind.GreaterThanEqualsToken:
      return '>=';
    case SyntaxKind.EqualsEqualsToken:
      return '==';
    case SyntaxKind.ExclamationEqualsToken:
      return '!=';
    case SyntaxKind.EqualsEqualsEqualsToken:
      return '===';
    case SyntaxKind.ExclamationEqualsEqualsToken:
      return '!==';
    case SyntaxKind.PlusEqualsToken:
      return '+=';
    case SyntaxKind.MinusEqualsToken:
      return '-=';
    case SyntaxKind.AsteriskEqualsToken:
      return '*=';
    case SyntaxKind.SlashEqualsToken:
      return '/=';
    case SyntaxKind.PercentEqualsToken:
      return '%=';
    case SyntaxKind.AsteriskAsteriskEqualsToken:
      return '**=';
    case SyntaxKind.LessThanLessThanEqualsToken:
      return '<<=';
    case SyntaxKind.GreaterThanGreaterThanEqualsToken:
      return '>>=';
    case SyntaxKind.GreaterThanGreaterThanGreaterThanEqualsToken:
      return '>>>=';
    case SyntaxKind.AmpersandEqualsToken:
      return '&=';
    case SyntaxKind.BarEqualsToken:
      return '|=';
    case SyntaxKind.CaretEqualsToken:
      return '^=';
    case SyntaxKind.InKeyword:
      return 'in';
    case SyntaxKind.InstanceOfKeyword:
      return 'instanceof';
  }
  return '';
}

function checkBinaryExpression(c: Checker, node: BinaryExpression, checkMode: CheckMode): Type {
  const operator = node.operatorToken.kind;
  if (
    operator === SyntaxKind.EqualsToken &&
    (node.left.kind === SyntaxKind.ObjectLiteralExpression || node.left.kind === SyntaxKind.ArrayLiteralExpression)
  ) {
    const rightType = checkExpressionEx(c, node.right, checkMode);
    return rightType;
  }
  if (
    operator === SyntaxKind.AmpersandAmpersandToken ||
    operator === SyntaxKind.BarBarToken ||
    operator === SyntaxKind.QuestionQuestionToken
  ) {
    const leftType = checkExpressionCached(c, node.left);
    const rightType = checkExpressionEx(c, node.right, checkMode);
    return checkLogicalOperator(c, operator, leftType, rightType);
  }
  // Assignment targets are cached: contextual typing of the right side reads them too.
  const leftType = isAssignmentOperator(operator)
    ? checkExpressionCached(c, node.left)
    : checkExpressionEx(c, node.left, checkMode);
  const rightType = checkExpressionEx(c, node.right, checkMode);
  return checkBinaryLikeExpressionWorker(c, node, node.left, operator, node.right, leftType, rightType);
}

function checkLogicalOperator(c: Checker, operator: SyntaxKind, leftType: Type, rightType: Type): Type {
  switch (operator) {
    case SyntaxKind.AmpersandAmpersandToken: {
      if ((getTypeFacts(c, leftType, TypeFacts.Truthy) & TypeFacts.Truthy) === 0) return leftType;
      return getUnionType(c, [
        extractDefinitelyFalsyTypes(c, c.strictNullChecks ? leftType : getWidenedLiteralType(c, rightType)),
        rightType,
      ]);
    }
    case SyntaxKind.BarBarToken: {
      if ((getTypeFacts(c, leftType, TypeFacts.Falsy) & TypeFacts.Falsy) === 0) return leftType;
      return getUnionTypeEx(
        c,
        [getNonUndefinedType(c, removeDefinitelyFalsyTypes(c, leftType)), rightType],
        UnionReduction.Subtype,
        undefined,
        undefined,
      );
    }
    case SyntaxKind.QuestionQuestionToken: {
      if ((getTypeFacts(c, leftType, TypeFacts.EQUndefinedOrNull) & TypeFacts.EQUndefinedOrNull) === 0) return leftType;
      return getUnionTypeEx(
        c,
        [getNonNullableType(c, leftType), rightType],
        UnionReduction.Subtype,
        undefined,
        undefined,
      );
    }
  }
  return c.errorType;
}

function getNonUndefinedType(_c: Checker, t: Type): Type {
  return t;
}

function removeDefinitelyFalsyTypes(c: Checker, t: Type): Type {
  return getTypeWithFacts(c, t, TypeFacts.Truthy);
}

function extractDefinitelyFalsyTypes(c: Checker, t: Type): Type {
  if ((t.flags & TypeFlags.Union) !== 0) {
    const types: Type[] = [];
    for (const u of typesOf(t)) types.push(getDefinitelyFalsyPartOfType(c, u));
    return getUnionType(c, types);
  }
  return getDefinitelyFalsyPartOfType(c, t);
}

function getDefinitelyFalsyPartOfType(c: Checker, t: Type): Type {
  if ((t.flags & TypeFlags.String) !== 0) return c.emptyStringType;
  if ((t.flags & TypeFlags.Number) !== 0) return c.zeroType;
  if ((t.flags & TypeFlags.BigInt) !== 0) return c.zeroBigIntType;
  if (
    t === c.regularFalseType ||
    t === c.falseType ||
    (t.flags & (TypeFlags.Void | TypeFlags.Undefined | TypeFlags.Null | TypeFlags.AnyOrUnknown)) !== 0
  )
    return t;
  if ((t.flags & TypeFlags.StringLiteral) !== 0 && (t as LiteralType).stringValue === '') return t;
  if ((t.flags & TypeFlags.NumberLiteral) !== 0 && (t as LiteralType).numberValue === 0) return t;
  if ((t.flags & TypeFlags.BigIntLiteral) !== 0 && (t as LiteralType).stringValue === '0') return t;
  return c.neverType;
}

function isArithmeticOperator(op: SyntaxKind): boolean {
  switch (op) {
    case SyntaxKind.AsteriskToken:
    case SyntaxKind.AsteriskEqualsToken:
    case SyntaxKind.AsteriskAsteriskToken:
    case SyntaxKind.AsteriskAsteriskEqualsToken:
    case SyntaxKind.SlashToken:
    case SyntaxKind.SlashEqualsToken:
    case SyntaxKind.PercentToken:
    case SyntaxKind.PercentEqualsToken:
    case SyntaxKind.MinusToken:
    case SyntaxKind.MinusEqualsToken:
    case SyntaxKind.LessThanLessThanToken:
    case SyntaxKind.LessThanLessThanEqualsToken:
    case SyntaxKind.GreaterThanGreaterThanToken:
    case SyntaxKind.GreaterThanGreaterThanEqualsToken:
    case SyntaxKind.GreaterThanGreaterThanGreaterThanToken:
    case SyntaxKind.GreaterThanGreaterThanGreaterThanEqualsToken:
    case SyntaxKind.BarToken:
    case SyntaxKind.BarEqualsToken:
    case SyntaxKind.CaretToken:
    case SyntaxKind.CaretEqualsToken:
    case SyntaxKind.AmpersandToken:
    case SyntaxKind.AmpersandEqualsToken:
      return true;
  }
  return false;
}

function isCompoundAssignment(op: SyntaxKind): boolean {
  return op >= SyntaxKind.FirstCompoundAssignment && op <= SyntaxKind.LastCompoundAssignment;
}

function checkBinaryLikeExpressionWorker(
  c: Checker,
  node: Node,
  left: Node,
  operator: SyntaxKind,
  right: Node,
  leftType: Type,
  rightType: Type,
): Type {
  if (isArithmeticOperator(operator)) {
    if (leftType === c.silentNeverType || rightType === c.silentNeverType) return c.silentNeverType;
    leftType = checkNonNullType(c, leftType, left);
    rightType = checkNonNullType(c, rightType, right);
    if ((leftType.flags & TypeFlags.BooleanLike) !== 0 && (rightType.flags & TypeFlags.BooleanLike) !== 0) {
      const suggested = getSuggestedBooleanOperator(operator);
      if (suggested !== '') {
        c.error(
          node,
          Diagnostics.The_0_operator_is_not_allowed_for_boolean_types_Consider_using_1_instead,
          tokenText(operator),
          suggested,
        );
        return c.numberType;
      }
    }
    const leftOk = checkArithmeticOperandType(
      c,
      left,
      leftType,
      Diagnostics.The_left_hand_side_of_an_arithmetic_operation_must_be_of_type_any_number_bigint_or_an_enum_type,
    );
    const rightOk = checkArithmeticOperandType(
      c,
      right,
      rightType,
      Diagnostics.The_right_hand_side_of_an_arithmetic_operation_must_be_of_type_any_number_bigint_or_an_enum_type,
    );
    let resultType: Type;
    if (
      (isTypeAssignableToKind(c, leftType, TypeFlags.AnyOrUnknown, false) &&
        isTypeAssignableToKind(c, rightType, TypeFlags.AnyOrUnknown, false)) ||
      !(maybeTypeOfKind(leftType, TypeFlags.BigIntLike) || maybeTypeOfKind(rightType, TypeFlags.BigIntLike))
    ) {
      resultType = c.numberType;
    } else if (bothAreBigIntLike(c, leftType, rightType)) {
      if (
        operator === SyntaxKind.GreaterThanGreaterThanGreaterThanToken ||
        operator === SyntaxKind.GreaterThanGreaterThanGreaterThanEqualsToken
      ) {
        reportOperatorError(c, node, operator, leftType, rightType);
      }
      resultType = c.bigintType;
    } else {
      if (leftOk && rightOk) reportOperatorError(c, node, operator, leftType, rightType);
      resultType = c.errorType;
    }
    if (isCompoundAssignment(operator)) checkAssignmentOperatorResult(c, left, leftType, resultType);
    return resultType;
  }
  switch (operator) {
    case SyntaxKind.PlusToken:
    case SyntaxKind.PlusEqualsToken: {
      if (leftType === c.silentNeverType || rightType === c.silentNeverType) return c.silentNeverType;
      if (
        !isTypeAssignableToKind(c, leftType, TypeFlags.StringLike, false) &&
        !isTypeAssignableToKind(c, rightType, TypeFlags.StringLike, false)
      ) {
        leftType = checkNonNullType(c, leftType, left);
        rightType = checkNonNullType(c, rightType, right);
      }
      let resultType: Type | undefined = undefined;
      if (
        isTypeAssignableToKind(c, leftType, TypeFlags.NumberLike, true) &&
        isTypeAssignableToKind(c, rightType, TypeFlags.NumberLike, true)
      )
        resultType = c.numberType;
      else if (
        isTypeAssignableToKind(c, leftType, TypeFlags.BigIntLike, true) &&
        isTypeAssignableToKind(c, rightType, TypeFlags.BigIntLike, true)
      )
        resultType = c.bigintType;
      else if (
        isTypeAssignableToKind(c, leftType, TypeFlags.StringLike, true) ||
        isTypeAssignableToKind(c, rightType, TypeFlags.StringLike, true)
      )
        resultType = c.stringType;
      else if (isTypeAny(leftType) || isTypeAny(rightType))
        resultType = isErrorType(c, leftType) || isErrorType(c, rightType) ? c.errorType : c.anyType;
      if (resultType === undefined) {
        reportOperatorError(c, node, operator, leftType, rightType);
        return c.anyType;
      }
      if (operator === SyntaxKind.PlusEqualsToken) checkAssignmentOperatorResult(c, left, leftType, resultType);
      return resultType;
    }
    case SyntaxKind.LessThanToken:
    case SyntaxKind.GreaterThanToken:
    case SyntaxKind.LessThanEqualsToken:
    case SyntaxKind.GreaterThanEqualsToken:
      checkNonNullType(c, leftType, left);
      checkNonNullType(c, rightType, right);
      return c.booleanType;
    case SyntaxKind.EqualsEqualsToken:
    case SyntaxKind.ExclamationEqualsToken:
    case SyntaxKind.EqualsEqualsEqualsToken:
    case SyntaxKind.ExclamationEqualsEqualsToken:
      if (isLiteralExpressionOfObject(left) || isLiteralExpressionOfObject(right)) {
        const eqType = operator === SyntaxKind.EqualsEqualsToken || operator === SyntaxKind.EqualsEqualsEqualsToken;
        c.error(
          node,
          Diagnostics.This_condition_will_always_return_0_since_JavaScript_compares_objects_by_reference_not_value,
          eqType ? 'false' : 'true',
        );
      }
      checkNaNEquality(c, node, operator, left, right);
      reportOperatorErrorUnless(c, node, operator, leftType, rightType);
      return c.booleanType;
    case SyntaxKind.InstanceOfKeyword:
      return c.booleanType;
    case SyntaxKind.InKeyword:
      return c.booleanType;
    case SyntaxKind.CommaToken:
      if (c.compilerOptions.allowUnreachableCode !== true && isSideEffectFree(left) && !isIndirectCall(left.parent!))
        c.error(left, Diagnostics.Left_side_of_comma_operator_is_unused_and_has_no_side_effects);
      return rightType;
    case SyntaxKind.EqualsToken:
      checkAssignmentOperator(c, left, right, leftType, rightType);
      return rightType;
    case SyntaxKind.AmpersandAmpersandEqualsToken:
    case SyntaxKind.BarBarEqualsToken:
    case SyntaxKind.QuestionQuestionEqualsToken:
      return getUnionType(c, [leftType, rightType]);
  }
  return c.errorType;
}

function isLiteralExpressionOfObject(node: Node): boolean {
  switch (node.kind) {
    case SyntaxKind.ObjectLiteralExpression:
    case SyntaxKind.ArrayLiteralExpression:
    case SyntaxKind.RegularExpressionLiteral:
    case SyntaxKind.ClassExpression:
    case SyntaxKind.FunctionExpression:
    case SyntaxKind.ArrowFunction:
    case SyntaxKind.NewExpression:
      return true;
  }
  return false;
}

function checkNaNEquality(c: Checker, errorNode: Node, operator: SyntaxKind, left: Node, right: Node): void {
  const isLeftNaN = isGlobalNaN(c, skipParentheses(left));
  const isRightNaN = isGlobalNaN(c, skipParentheses(right));
  if (isLeftNaN || isRightNaN) {
    const err = c.error(
      errorNode,
      Diagnostics.This_condition_will_always_return_0,
      operator === SyntaxKind.EqualsEqualsEqualsToken || operator === SyntaxKind.EqualsEqualsToken ? 'false' : 'true',
    );
    if (isLeftNaN && isRightNaN) return;
    const operatorString =
      operator === SyntaxKind.ExclamationEqualsEqualsToken || operator === SyntaxKind.ExclamationEqualsToken ? '!' : '';
    const location = isLeftNaN ? right : left;
    const expression = skipParentheses(location);
    err.addRelatedInfo(
      createDiagnosticForNode(location, Diagnostics.Did_you_mean_0, [
        operatorString +
          'Number.isNaN(' +
          (isEntityNameExpression(expression, false) ? entityNameToString(expression) : '...') +
          ')',
      ]),
    );
  }
}

function isGlobalNaN(c: Checker, expr: Node): boolean {
  if (expr.kind === SyntaxKind.Identifier && getText(expr) === 'NaN') {
    const globalNaNSymbol = c.globals.get('NaN');
    return globalNaNSymbol !== undefined && getResolvedSymbol(c, expr) === getMergedSymbol(c, globalNaNSymbol);
  }
  return false;
}

function bothAreBigIntLike(c: Checker, left: Type, right: Type): boolean {
  return (
    isTypeAssignableToKind(c, left, TypeFlags.BigIntLike, false) &&
    isTypeAssignableToKind(c, right, TypeFlags.BigIntLike, false)
  );
}

function isTypeAny(t: Type): boolean {
  return (t.flags & TypeFlags.Any) !== 0;
}

function getSuggestedBooleanOperator(operator: SyntaxKind): string {
  switch (operator) {
    case SyntaxKind.BarToken:
    case SyntaxKind.BarEqualsToken:
      return '||';
    case SyntaxKind.CaretToken:
    case SyntaxKind.CaretEqualsToken:
      return '!==';
    case SyntaxKind.AmpersandToken:
    case SyntaxKind.AmpersandEqualsToken:
      return '&&';
  }
  return '';
}

function reportOperatorErrorUnless(
  c: Checker,
  node: Node,
  operator: SyntaxKind,
  leftType: Type,
  rightType: Type,
): void {
  if (!isTypeEqualityComparableTo(c, leftType, rightType) && !isTypeEqualityComparableTo(c, rightType, leftType))
    reportOperatorError(c, node, operator, leftType, rightType);
}

function isTypeEqualityComparableTo(c: Checker, source: Type, target: Type): boolean {
  return (target.flags & TypeFlags.Nullable) !== 0 || isTypeComparableTo(c, source, target);
}

function reportOperatorError(c: Checker, node: Node, operator: SyntaxKind, leftType: Type, rightType: Type): void {
  let leftStr = typeToString(c, leftType);
  let rightStr = typeToString(c, rightType);
  if (leftStr === rightStr) {
    leftStr = typeToString(c, leftType, undefined, 1 << 5);
    rightStr = typeToString(c, rightType, undefined, 1 << 5);
  }
  const errNode =
    (node as BinaryExpression).operatorToken !== undefined && node.kind === SyntaxKind.BinaryExpression ? node : node;
  switch (operator) {
    case SyntaxKind.EqualsEqualsEqualsToken:
    case SyntaxKind.EqualsEqualsToken:
    case SyntaxKind.ExclamationEqualsEqualsToken:
    case SyntaxKind.ExclamationEqualsToken:
      c.error(
        errNode,
        Diagnostics.This_comparison_appears_to_be_unintentional_because_the_types_0_and_1_have_no_overlap,
        leftStr,
        rightStr,
      );
      return;
  }
  c.error(errNode, Diagnostics.Operator_0_cannot_be_applied_to_types_1_and_2, tokenText(operator), leftStr, rightStr);
}

function checkAssignmentOperator(c: Checker, left: Node, right: Node, leftType: Type, rightType: Type): void {
  if (isErrorType(c, leftType)) return;
  if (
    left.kind === SyntaxKind.Identifier ||
    left.kind === SyntaxKind.PropertyAccessExpression ||
    left.kind === SyntaxKind.ElementAccessExpression ||
    left.kind === SyntaxKind.ParenthesizedExpression
  ) {
    checkTypeAssignableToAndOptionallyElaborate(c, rightType, leftType, left, right);
  }
}

function checkAssignmentOperatorResult(c: Checker, left: Node, leftType: Type, resultType: Type): void {
  if (isErrorType(c, resultType)) return;
  if (isErrorType(c, leftType)) return;
  checkTypeAssignableTo(c, resultType, leftType, left, undefined);
}

/** Reports `source` not assignable to `target` at `errorNode`. */
export function checkTypeAssignableToAndOptionallyElaborate(
  c: Checker,
  source: Type,
  target: Type,
  errorNode: Node,
  _expr: Node | undefined,
): boolean {
  return checkTypeAssignableTo(c, source, target, errorNode, undefined);
}

function checkConditionalExpression(c: Checker, node: ConditionalExpression, checkMode: CheckMode): Type {
  checkTruthinessExpression(c, node.condition);
  const type1 = checkExpressionEx(c, node.whenTrue, checkMode);
  const type2 = checkExpressionEx(c, node.whenFalse, checkMode);
  return getUnionTypeEx(c, [type1, type2], UnionReduction.Subtype, undefined, undefined);
}

export function checkTruthinessExpression(c: Checker, node: Node): Type {
  const t = checkExpression(c, node);
  if ((t.flags & TypeFlags.Void) !== 0)
    c.error(node, Diagnostics.An_expression_of_type_void_cannot_be_tested_for_truthiness);
  return t;
}

function isSideEffectFree(expr: Node): boolean {
  const node = skipParentheses(expr);
  switch (node.kind) {
    case SyntaxKind.Identifier:
    case SyntaxKind.StringLiteral:
    case SyntaxKind.RegularExpressionLiteral:
    case SyntaxKind.TaggedTemplateExpression:
    case SyntaxKind.TemplateExpression:
    case SyntaxKind.NoSubstitutionTemplateLiteral:
    case SyntaxKind.NumericLiteral:
    case SyntaxKind.BigIntLiteral:
    case SyntaxKind.TrueKeyword:
    case SyntaxKind.FalseKeyword:
    case SyntaxKind.NullKeyword:
    case SyntaxKind.UndefinedKeyword:
    case SyntaxKind.FunctionExpression:
    case SyntaxKind.ClassExpression:
    case SyntaxKind.ArrowFunction:
    case SyntaxKind.ArrayLiteralExpression:
    case SyntaxKind.ObjectLiteralExpression:
    case SyntaxKind.TypeOfExpression:
    case SyntaxKind.NonNullExpression:
    case SyntaxKind.JsxSelfClosingElement:
    case SyntaxKind.JsxElement:
      return true;
    case SyntaxKind.ConditionalExpression: {
      const cond = node as ConditionalExpression;
      return isSideEffectFree(cond.whenTrue) && isSideEffectFree(cond.whenFalse);
    }
    case SyntaxKind.BinaryExpression: {
      const binary = node as BinaryExpression;
      if (isAssignmentOperator(binary.operatorToken.kind)) return false;
      return isSideEffectFree(binary.left) && isSideEffectFree(binary.right);
    }
    case SyntaxKind.PrefixUnaryExpression:
      switch ((node as PrefixUnaryExpression).operator) {
        case SyntaxKind.ExclamationToken:
        case SyntaxKind.PlusToken:
        case SyntaxKind.MinusToken:
        case SyntaxKind.TildeToken:
          return true;
      }
      return false;
  }
  return false;
}

/** `(0, x.f)(...)` or `(0, eval)(...)`, which call without passing `this`. */
function isIndirectCall(node: Node): boolean {
  const binary = node as BinaryExpression;
  const left = binary.left;
  const right = binary.right;
  const parent = node.parent!;
  if (
    parent.kind !== SyntaxKind.ParenthesizedExpression ||
    left.kind !== SyntaxKind.NumericLiteral ||
    getText(left) !== '0'
  )
    return false;
  const grand = parent.parent!;
  const called =
    (grand.kind === SyntaxKind.CallExpression && getExpression(grand) === parent) ||
    grand.kind === SyntaxKind.TaggedTemplateExpression;
  return (
    called &&
    (right.kind === SyntaxKind.PropertyAccessExpression ||
      right.kind === SyntaxKind.ElementAccessExpression ||
      (right.kind === SyntaxKind.Identifier && getText(right) === 'eval'))
  );
}
