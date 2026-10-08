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
  type QualifiedName,
  type SpreadElement,
  type TemplateExpression,
  type TemplateSpan,
  type TypeReferenceNode,
  getExpression,
  getInitializer,
  getName,
  getText,
  SourceFile,
  ModifierFlags,
  NodeFlags,
  PropertyDeclaration,
  VariableDeclaration,
  ForInOrOfStatement,
  VariableDeclarationList,
  TypeQueryNode,
  getTagName,
  getType,
} from './ast.js';
import {
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
  isAssignmentTarget,
} from './binder-utilities.js';
import { Diagnostics } from './diagnostics.js';
import { type Symbol, SymbolFlags } from './symbol.js';
import { SyntaxKind } from './syntax-kind.js';
import { type Checker } from './checker.js';
import {
  AccessFlags,
  CheckMode,
  ObjectFlags,
  type Type,
  TypeFlags,
  UnionType,
  TypeParameter,
  type MappedType,
  type TypeReference,
} from './checker-types.js';
import {
  createTupleTypeEx,
  getBigIntLiteralType,
  getFreshTypeOfLiteralType,
  getNumberLiteralType,
  getRegularTypeOfLiteralType,
  getStringLiteralType,
  getUnionTypeEx,
  getWidenedLiteralType,
  isErrorType,
  isTupleType,
  someType,
  typesOf,
  UnionReduction,
  getBaseTypeOfLiteralType,
  cloneTypeReference,
  createArrayTypeEx,
  everyType,
  getTemplateLiteralType,
  isMutableArrayOrTuple,
  mapType,
} from './checker-type-factory.js';
import { ElementFlags, TupleElementInfo } from './checker-types.js';
import {
  getBaseConstraintOfType,
  getPropertyOfType,
  getIndexInfoOfType,
  getIndexInfosOfType,
  getIndexTypeOfType,
  getTypeOfPropertyOfType,
  isArrayLikeType,
  getBaseConstraintOrType,
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
  addOptionality,
} from './checker-symbol-types.js';
import { getDeclaredTypeOfClassOrInterface } from './checker-declared-types.js';
import { getTypeFromTypeNode } from './checker-type-nodes.js';
import {
  isGenericObjectType,
  getIndexedAccessTypeOrUndefinedEx,
  getHomomorphicTypeVariable,
  isGenericIndexType,
  isGenericMappedType,
  isGenericType,
} from './checker-type-operators.js';
import { TypeFacts, getTypeFacts, getNonNullableType } from './checker-flow.js';
import { checkTypeAssignableTo, checkTypeComparableTo, isTypeAssignableTo, isTypeComparableTo } from './relations.js';
import { isTypeAssignableToKindEx as isTypeAssignableToKind } from './checker-type-operators.js';
import { typeToString, symbolToString } from './type-printer.js';
import { isTypeUsableAsPropertyName, getPropertyNameFromType, maybeTypeOfKind } from './checker-utilities.js';
import {
  getApparentTypeOfContextualType,
  getContextualType,
  getContextualSignatureForFunctionLikeDeclaration,
} from './checker-contextual.js';
import {
  checkCallExpression,
  checkNewExpression,
  checkTaggedTemplateExpression,
  getOptionalExpressionType,
  instantiateTypeWithSingleGenericCallSignature,
  propagateOptionalTypeMarker,
} from './checker-calls.js';
import {
  checkAwaitExpression,
  checkFunctionExpressionOrObjectLiteralMethod,
  checkYieldExpression,
} from './checker-functions.js';
import { IterationUse, checkIteratedTypeOrElementType, getIteratedTypeOrElementType } from './checker-iteration.js';
import { checkClassExpression } from './checker-classes.js';
import { padTupleType } from './checker-destructuring.js';
import { checkObjectLiteral } from './checker-object-literals.js';
import { EvaluatedKind, evaluate } from './checker-evaluator.js';
import {
  checkPrivateIdentifierExpression,
  checkPropertyAccessExpressionOrQualifiedName,
} from './checker-property-access.js';
import {
  checkBinaryExpression,
  checkConditionalExpression,
  checkDeleteExpression,
  checkPostfixUnaryExpression,
  checkPrefixUnaryExpression,
} from './checker-operators.js';
import { checkJsx } from './checker-jsx.js';
import { getRegularTypeOfObjectLiteral } from './checker-literals.js';
import { getSignatureFromDeclaration, getThisTypeOfSignature } from './checker-signatures.js';
import { isFunctionLike } from './ast-utilities.js';
import {
  AssignmentKind,
  convertAutoToAny,
  isEvolvingArrayOperationTarget,
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

import { ContextFlags, getInferenceContext, instantiateContextualType } from './checker-contextual.js';
import { addIntraExpressionInferenceSite } from './checker-inference.js';
import { checkTypeRelatedToAndOptionallyElaborate } from './checker-elaboration.js';
import { isContextSensitive } from './checker-functions.js';
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
  const t = instantiateTypeWithSingleGenericCallSignature(
    c,
    node,
    checkExpressionWorker(c, node, checkMode),
    checkMode,
  );
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
  return checkExpressionForMutableLocationEx(c, node, CheckMode.Normal);
}

export function checkExpressionForMutableLocationEx(c: Checker, node: Node, checkMode: CheckMode): Type {
  const t = checkExpressionEx(c, node, checkMode);
  if (isConstContext(node)) return getRegularTypeOfLiteralType(c, t);
  return getWidenedLiteralLikeTypeForContextualType(
    c,
    t,
    instantiateContextualType(c, getContextualType(c, node), node, ContextFlags.None),
  );
}

export function checkDeclarationInitializer(c: Checker, declaration: Node): Type {
  const initializer = getInitializer(declaration)!;
  const t = checkExpressionCached(c, initializer);
  // A parameter's array pattern pads its tuple initializer with the elements it binds past the end.
  const name = getName(declaration);
  if (
    name !== undefined &&
    name.kind === SyntaxKind.ArrayBindingPattern &&
    isTupleType(t) &&
    getRootDeclaration(declaration).kind === SyntaxKind.Parameter
  )
    return padTupleType(c, t, name);
  return t;
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
      return checkPrivateIdentifierExpression(c, node);
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
      return checkDeleteExpression(c, node);
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
    case SyntaxKind.YieldExpression:
      return checkYieldExpression(c, node);
    case SyntaxKind.SyntheticExpression:
      return c.anyType;
    case SyntaxKind.JsxExpression:
    case SyntaxKind.JsxElement:
    case SyntaxKind.JsxSelfClosingElement:
    case SyntaxKind.JsxFragment:
    case SyntaxKind.JsxAttributes:
      return checkJsx(c, node, checkMode);
  }
  return c.errorType;
}

export function parseBigIntText(text: string): string {
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
  // In `const [a, b = a + 1] = [2]`, `a` is `any` while computing the contextual type of `[2]`.
  if (
    declaration !== undefined &&
    declaration.kind === SyntaxKind.BindingElement &&
    c.contextualBindingPatterns.includes(declaration.parent!) &&
    isDescendantOf(node, declaration.parent!)
  )
    return c.nonInferrableAnyType;
  let t = getNarrowableTypeForReference(c, getTypeOfSymbol(c, localOrExportSymbol), node);
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
  if (!isEvolvingArrayOperationTarget(c, node) && typeIsAutomatic) {
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

/**
 * A reference's type with union constraints substituted for generic types where only the
 * constraint matters, so narrowing can apply: in constraint positions like `x.p`, or with a
 * non-generic contextual type.
 */
function getNarrowableTypeForReference(c: Checker, t: Type, reference: Node): Type {
  const substituteConstraints =
    someType(t, (u) => isGenericTypeWithUnionConstraint(c, u)) &&
    (isConstraintPosition(c, t, reference) || hasContextualTypeWithNoGenericTypes(c, reference));
  return substituteConstraints ? mapType(c, t, (u) => getBaseConstraintOrType(c, u)) : t;
}

function isConstraintPosition(c: Checker, t: Type, node: Node): boolean {
  const parent = node.parent!;
  // `obj[x]` keeps `T[K]` when both are generic and obj's constraint isn't nullable.
  return (
    parent.kind === SyntaxKind.PropertyAccessExpression ||
    parent.kind === SyntaxKind.QualifiedName ||
    ((parent.kind === SyntaxKind.CallExpression || parent.kind === SyntaxKind.NewExpression) &&
      getExpression(parent) === node) ||
    (parent.kind === SyntaxKind.ElementAccessExpression &&
      getExpression(parent) === node &&
      !(
        someType(t, (u) => isGenericTypeWithoutNullableConstraint(c, u)) &&
        isGenericIndexType(c, checkExpressionCached(c, (parent as ElementAccessExpression).argumentExpression))
      ))
  );
}

function isGenericTypeWithUnionConstraint(c: Checker, t: Type): boolean {
  if ((t.flags & TypeFlags.Intersection) !== 0) return typesOf(t).some((u) => isGenericTypeWithUnionConstraint(c, u));
  return (
    (t.flags & TypeFlags.Instantiable) !== 0 &&
    (getBaseConstraintOrType(c, t).flags & (TypeFlags.Nullable | TypeFlags.Union)) !== 0
  );
}

function isGenericTypeWithoutNullableConstraint(c: Checker, t: Type): boolean {
  if ((t.flags & TypeFlags.Intersection) !== 0)
    return typesOf(t).some((u) => isGenericTypeWithoutNullableConstraint(c, u));
  return (
    (t.flags & TypeFlags.Instantiable) !== 0 && !maybeTypeOfKind(getBaseConstraintOrType(c, t), TypeFlags.Nullable)
  );
}

function hasContextualTypeWithNoGenericTypes(c: Checker, node: Node): boolean {
  // JSX tag names are excluded: their contextual type resolves the tag itself.
  if (
    node.kind !== SyntaxKind.Identifier &&
    node.kind !== SyntaxKind.PropertyAccessExpression &&
    node.kind !== SyntaxKind.ElementAccessExpression
  )
    return false;
  const parent = node.parent!;
  if (
    (parent.kind === SyntaxKind.JsxOpeningElement || parent.kind === SyntaxKind.JsxSelfClosingElement) &&
    getTagName(parent) === node
  )
    return false;
  const contextualType = getContextualType(c, node);
  return contextualType !== undefined && !isGenericType(c, contextualType);
}

function containsUndefinedType(c: Checker, t: Type): boolean {
  const u = (t.flags & TypeFlags.Union) !== 0 ? (t as UnionType).types[0] : t;
  return (u.flags & TypeFlags.Undefined) !== 0 && u !== c.missingType;
}

function isDescendantOf(node: Node, ancestor: Node): boolean {
  for (let current: Node | undefined = node; current !== undefined; current = current.parent)
    if (current === ancestor) return true;
  return false;
}

export function isInAmbientOrTypeNode(node: Node): boolean {
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
export function getContextualThisParameterType(c: Checker, func: Node): Type | undefined {
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
  const texts = [getText(node.head)];
  const types: Type[] = [];
  for (const span of node.templateSpans.nodes) {
    const expression = getExpression(span)!;
    const t = checkExpression(c, expression);
    if (
      maybeTypeOfKind(t, TypeFlags.ESSymbolLike) ||
      maybeTypeOfKind(getBaseConstraintOrType(c, t), TypeFlags.ESSymbolLike)
    )
      c.error(
        expression,
        Diagnostics.Implicit_conversion_of_a_symbol_to_a_string_will_fail_at_runtime_Consider_wrapping_this_expression_in_String,
      );
    texts.push(getText((span as TemplateSpan).literal));
    types.push(isTypeAssignableTo(c, t, c.templateConstraintType) ? t : c.stringType);
  }
  if (node.parent!.kind !== SyntaxKind.TaggedTemplateExpression) {
    const evaluated = evaluate(c, node, node);
    if (evaluated.kind === EvaluatedKind.String)
      return getFreshTypeOfLiteralType(c, getStringLiteralType(c, evaluated.stringValue));
  }
  if (
    isConstContext(node) ||
    isTemplateLiteralContext(node) ||
    someType(getContextualType(c, node) ?? c.unknownType, (t) => isTemplateLiteralContextualType(c, t))
  )
    return getTemplateLiteralType(c, texts, types);
  return c.stringType;
}

function isTemplateLiteralContext(node: Node): boolean {
  const parent = node.parent!;
  return (
    (parent.kind === SyntaxKind.ParenthesizedExpression && isTemplateLiteralContext(parent)) ||
    (parent.kind === SyntaxKind.ElementAccessExpression &&
      (parent as ElementAccessExpression).argumentExpression === node)
  );
}

function isTemplateLiteralContextualType(c: Checker, t: Type): boolean {
  return (
    (t.flags & (TypeFlags.StringLiteral | TypeFlags.TemplateLiteral)) !== 0 ||
    ((t.flags & TypeFlags.InstantiableNonPrimitive) !== 0 &&
      maybeTypeOfKind(getBaseConstraintOfType(c, t) ?? c.unknownType, TypeFlags.StringLike))
  );
}

function checkSpreadExpression(c: Checker, node: SpreadElement, checkMode: CheckMode): Type {
  const arrayOrIterableType = checkExpressionEx(c, node.expression, checkMode);
  return checkIteratedTypeOrElementType(c, IterationUse.Spread, arrayOrIterableType, c.undefinedType, node.expression);
}

function checkArrayLiteral(c: Checker, node: ArrayLiteralExpression, checkMode: CheckMode): Type {
  const elements = node.elements.nodes;
  const elementTypes: Type[] = [];
  const elementInfos: TupleElementInfo[] = [];
  const inDestructuringPattern = isAssignmentTarget(node);
  const inConstContext = isConstContext(node);
  const contextualType = getApparentTypeOfContextualType(c, node);
  const inTupleContext =
    isSpreadIntoCallOrNew(node) ||
    (contextualType !== undefined && someType(contextualType, (t) => isTupleLikeContext(c, t)));
  let hasOmittedExpression = false;
  for (const e of elements) {
    if (e.kind === SyntaxKind.SpreadElement) {
      const spreadType = checkExpressionEx(c, (e as SpreadElement).expression, checkMode);
      if (isArrayLikeType(c, spreadType)) {
        elementTypes.push(spreadType);
        elementInfos.push(new TupleElementInfo(ElementFlags.Variadic, undefined));
      } else if (inDestructuringPattern) {
        // `[...c] = ...` makes `c` a rest target that only provides a contextual type, so it's not
        // checked as iterable.
        const restElementType =
          getIndexTypeOfType(c, spreadType, c.numberType) ??
          getIteratedTypeOrElementType(c, IterationUse.Destructuring, spreadType, c.undefinedType, undefined, false) ??
          c.unknownType;
        elementTypes.push(restElementType);
        elementInfos.push(new TupleElementInfo(ElementFlags.Rest, undefined));
      } else {
        elementTypes.push(
          checkIteratedTypeOrElementType(
            c,
            IterationUse.Spread,
            spreadType,
            c.undefinedType,
            (e as SpreadElement).expression,
          ),
        );
        elementInfos.push(new TupleElementInfo(ElementFlags.Rest, undefined));
      }
    } else if (c.exactOptionalPropertyTypes && e.kind === SyntaxKind.OmittedExpression) {
      hasOmittedExpression = true;
      elementTypes.push(c.undefinedOrMissingType);
      elementInfos.push(new TupleElementInfo(ElementFlags.Optional, undefined));
    } else {
      const t =
        e.kind === SyntaxKind.OmittedExpression
          ? c.undefinedWideningType
          : checkExpressionForMutableLocationEx(c, e, checkMode);
      if (
        contextualType !== undefined &&
        (checkMode & CheckMode.Inferential) !== 0 &&
        (checkMode & CheckMode.SkipContextSensitive) === 0 &&
        isContextSensitive(c, e)
      ) {
        // Inferences flowing between context-sensitive elements are made before fixing.
        const inferenceContext = getInferenceContext(c, node);
        if (inferenceContext !== undefined) addIntraExpressionInferenceSite(inferenceContext, e, t);
      }
      elementTypes.push(addOptionality(c, t, true, hasOmittedExpression));
      elementInfos.push(
        new TupleElementInfo(hasOmittedExpression ? ElementFlags.Optional : ElementFlags.Required, undefined),
      );
    }
  }
  if (inDestructuringPattern) return createTupleTypeEx(c, elementTypes, elementInfos, false);
  if (inConstContext || inTupleContext || (checkMode & CheckMode.ForceTuple) !== 0)
    return createArrayLiteralType(
      c,
      createTupleTypeEx(
        c,
        elementTypes,
        elementInfos,
        inConstContext &&
          !(contextualType !== undefined && someType(contextualType, (t) => isMutableArrayLikeType(c, t))),
      ),
    );
  let elementType: Type;
  if (elementTypes.length > 0) {
    for (let i = 0; i < elementTypes.length; i++)
      if ((elementInfos[i].flags & ElementFlags.Variadic) !== 0)
        elementTypes[i] =
          getIndexedAccessTypeOrUndefinedEx(c, elementTypes[i], c.numberType, AccessFlags.None, undefined, undefined) ??
          c.anyType;
    elementType = getUnionTypeEx(c, elementTypes, UnionReduction.Subtype, undefined, undefined);
  } else elementType = c.strictNullChecks ? c.implicitNeverType : c.undefinedWideningType;
  return createArrayLiteralType(c, createArrayTypeEx(c, elementType, inConstContext));
}

function isSpreadIntoCallOrNew(node: Node): boolean {
  let parent = node.parent!;
  while (parent.kind === SyntaxKind.ParenthesizedExpression) parent = parent.parent!;
  return (
    parent.kind === SyntaxKind.SpreadElement &&
    (parent.parent!.kind === SyntaxKind.CallExpression || parent.parent!.kind === SyntaxKind.NewExpression)
  );
}

function isTupleLikeContext(c: Checker, t: Type): boolean {
  if (isTupleLikeType(c, t)) return true;
  if (!isGenericMappedType(c, t)) return false;
  const mapped = t as MappedType;
  if (mapped.nameType !== undefined) return false;
  const target = mapped.target;
  return getHomomorphicTypeVariable(c, target !== undefined ? (target as MappedType) : mapped) !== undefined;
}

export function isTupleLikeType(c: Checker, t: Type): boolean {
  if (isTupleType(t) || getPropertyOfType(c, t, '0') !== undefined) return true;
  if (!isArrayLikeType(c, t)) return false;
  const lengthType = getTypeOfPropertyOfType(c, t, 'length');
  return lengthType !== undefined && everyType(lengthType, (u) => (u.flags & TypeFlags.NumberLiteral) !== 0);
}

/** Whether `t` is a mutable array, a mutable tuple, or assignable to `any[]`. */
export function isMutableArrayLikeType(c: Checker, t: Type): boolean {
  return (
    isMutableArrayOrTuple(c, t) ||
    ((t.flags & (TypeFlags.Any | TypeFlags.Nullable)) === 0 && isTypeAssignableTo(c, t, c.anyArrayType))
  );
}

function createArrayLiteralType(c: Checker, t: Type): Type {
  if ((t.objectFlags & ObjectFlags.Reference) === 0) return t;
  const key = 'arrayLiteral' + t.id;
  let literal = c.cachedTypes.get(key);
  if (literal === undefined) {
    literal = cloneTypeReference(c, t as TypeReference);
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

/** `checkNonNullType`, also reporting a `void` type as possibly undefined. */
export function checkNonNullNonVoidType(c: Checker, t: Type, node: Node): Type {
  const nonNullType = checkNonNullType(c, t, node);
  if ((nonNullType.flags & TypeFlags.Void) === 0) return nonNullType;
  if (isEntityNameExpression(node, false)) {
    const nodeText = entityNameToString(node);
    if (node.kind === SyntaxKind.Identifier && nodeText === 'undefined') {
      c.error(node, Diagnostics.The_value_0_cannot_be_used_here, nodeText);
      return nonNullType;
    }
    if (nodeText.length < 100) {
      c.error(node, Diagnostics.X_0_is_possibly_undefined, nodeText);
      return nonNullType;
    }
  }
  c.error(node, Diagnostics.Object_is_possibly_undefined);
  return nonNullType;
}

export function entityNameToString(node: Node): string {
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
    return checkPropertyAccessExpressionOrQualifiedName(
      c,
      node,
      node.expression,
      checkNonNullExpression(c, node.expression),
      node.name,
    );
  const leftType = checkExpression(c, node.expression);
  const nonOptional = getOptionalExpressionType(c, leftType, node.expression);
  const t = checkPropertyAccessExpressionOrQualifiedName(
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
  return checkPropertyAccessExpressionOrQualifiedName(c, node, node.left, leftType, node.right);
}

function checkNonNullExpressionOfEntity(c: Checker, node: Node): Type {
  if (node.kind === SyntaxKind.Identifier) return checkNonNullType(c, checkIdentifier(c, node as Identifier), node);
  return checkNonNullType(c, checkQualifiedName(c, node as QualifiedName), node);
}

export function getFlowTypeOfAccessExpression(
  c: Checker,
  node: Node,
  prop: Symbol | undefined,
  propTypeIn: Type,
  errorNode: Node,
): Type {
  let propType = propTypeIn;
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
  propType = getNarrowableTypeForReference(c, propType, node);
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

/** Reports `source` not assignable to `target` at `errorNode`. */
export function checkTypeAssignableToAndOptionallyElaborate(
  c: Checker,
  source: Type,
  target: Type,
  errorNode: Node,
  expr: Node | undefined,
): boolean {
  return checkTypeRelatedToAndOptionallyElaborate(
    c,
    source,
    target,
    c.assignableRelation,
    errorNode,
    expr,
    undefined,
    undefined,
  );
}
