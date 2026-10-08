// Destructuring: types of binding elements and the types implied by binding patterns.
import { type BindingElement, type Node, getElements, getInitializer } from './ast.js';
import { SymbolFlags, type Symbol } from './symbol.js';
import { SyntaxKind } from './syntax-kind.js';
import type { Checker } from './checker.js';
import {
  AccessFlags,
  ElementFlags,
  type IndexInfo,
  ObjectFlags,
  TupleElementInfo,
  type Type,
  TypeFlags,
} from './checker-types.js';
import {
  createAnonymousType,
  createArrayType,
  createTupleTypeEx,
  getNumberLiteralType,
  getUnionTypeEx,
  isTupleType,
  newIndexInfo,
  UnionReduction,
} from './checker-type-factory.js';
import {
  getIndexedAccessTypeEx,
  getIndexedAccessTypeOrUndefinedEx,
  getLiteralTypeFromPropertyName,
} from './checker-type-operators.js';
import { isArrayLikeType } from './checker-members.js';
import { getSymbolOfDeclaration } from './checker-symbols.js';
import { getTypeForVariableLikeDeclaration, reportImplicitAny, getWidenedType } from './checker-symbol-types.js';
import {
  checkDeclarationInitializer,
  getIteratedTypeOrElementType,
  getWidenedLiteralLikeTypeForContextualType,
} from './checker-expressions.js';
import { TypeFacts, getTypeWithFacts, hasTypeFacts } from './checker-flow.js';
import { sliceTupleType } from './checker-signatures.js';
import { getPropertyNameFromType, isTypeUsableAsPropertyName } from './checker-utilities.js';

function isBindingPatternNode(node: Node | undefined): boolean {
  return (
    node !== undefined &&
    (node.kind === SyntaxKind.ObjectBindingPattern || node.kind === SyntaxKind.ArrayBindingPattern)
  );
}

/** The type of a binding element, from the type of the declaration it destructures. */
export function getTypeForBindingElement(c: Checker, declaration: Node): Type | undefined {
  const pattern = declaration.parent!;
  const parentType = getTypeForBindingElementParent(c, pattern.parent!);
  if (parentType === undefined || parentType === c.errorType) return parentType;
  return getBindingElementTypeFromParentType(c, declaration as BindingElement, parentType);
}

export function getTypeForBindingElementParent(c: Checker, node: Node): Type | undefined {
  const symbol = getSymbolOfDeclaration(c, node);
  if (symbol !== undefined) {
    const cached = c.symbolLinks(symbol).type;
    if (cached !== undefined) return cached;
  }
  return getTypeForVariableLikeDeclaration(c, node, false);
}

function getBindingElementTypeFromParentType(c: Checker, declaration: BindingElement, parentTypeIn: Type): Type {
  if ((parentTypeIn.flags & TypeFlags.Any) !== 0) return parentTypeIn;
  let parentType = parentTypeIn;
  const pattern = declaration.parent!;
  const parentInitializer = getInitializer(pattern.parent!);
  if (
    c.strictNullChecks &&
    parentInitializer !== undefined &&
    !hasTypeFacts(c, checkDeclarationInitializer(c, pattern.parent!), TypeFacts.EQUndefined)
  )
    parentType = getTypeWithFacts(c, parentType, TypeFacts.NEUndefined);
  const accessFlags =
    AccessFlags.ExpressionPosition | (declaration.initializer !== undefined ? AccessFlags.AllowMissing : 0);
  let t: Type;
  if (pattern.kind === SyntaxKind.ObjectBindingPattern) {
    // Object rest elements aren't computed yet.
    if (declaration.dotDotDotToken !== undefined) return c.anyType;
    const name = declaration.propertyName ?? declaration.name!;
    t = getIndexedAccessTypeEx(
      c,
      parentType,
      getLiteralTypeFromPropertyName(c, name) ?? c.errorType,
      accessFlags,
      name,
      undefined,
    );
  } else {
    const elementType = getIteratedTypeOrElementType(c, parentType);
    const index = getElements(pattern)!.nodes.indexOf(declaration);
    if (declaration.dotDotDotToken !== undefined)
      t = isTupleType(parentType) ? sliceTupleType(c, parentType, index, 0) : createArrayType(c, elementType);
    else if (isArrayLikeType(c, parentType))
      t =
        getIndexedAccessTypeOrUndefinedEx(
          c,
          parentType,
          getNumberLiteralType(c, index),
          accessFlags,
          declaration.name,
          undefined,
        ) ?? c.errorType;
    else t = elementType;
  }
  if (declaration.initializer === undefined) return t;
  const initializerType = checkDeclarationInitializer(c, declaration);
  if (c.strictNullChecks && !hasTypeFacts(c, initializerType, TypeFacts.IsUndefined))
    t = getTypeWithFacts(c, t, TypeFacts.NEUndefined);
  return getUnionTypeEx(c, [t, initializerType], UnionReduction.Subtype, undefined, undefined);
}

/** The type implied by a binding pattern, for declarations without annotations or initializers. */
export function getTypeFromBindingPattern(
  c: Checker,
  pattern: Node,
  includePatternInType: boolean,
  reportErrors: boolean,
): Type {
  return pattern.kind === SyntaxKind.ObjectBindingPattern
    ? getTypeFromObjectBindingPattern(c, pattern, includePatternInType, reportErrors)
    : getTypeFromArrayBindingPattern(c, pattern, includePatternInType, reportErrors);
}

function getTypeFromObjectBindingPattern(
  c: Checker,
  pattern: Node,
  includePatternInType: boolean,
  reportErrors: boolean,
): Type {
  const members = new Map<string, Symbol>();
  const indexInfos: IndexInfo[] = [];
  let objectFlags = ObjectFlags.ObjectLiteral | ObjectFlags.ContainsObjectOrArrayLiteral;
  for (const node of getElements(pattern)!.nodes) {
    const e = node as BindingElement;
    if (e.dotDotDotToken !== undefined) {
      indexInfos.push(newIndexInfo(c.stringType, c.anyType, false, undefined));
      continue;
    }
    const exprType = getLiteralTypeFromPropertyName(c, e.propertyName ?? e.name!) ?? c.errorType;
    if (!isTypeUsableAsPropertyName(exprType)) {
      objectFlags |= ObjectFlags.ObjectLiteralPatternWithComputedProperties;
      continue;
    }
    const flags = SymbolFlags.Property | (e.initializer !== undefined ? SymbolFlags.Optional : 0);
    const symbol = c.newSymbol(flags, getPropertyNameFromType(exprType));
    c.symbolLinks(symbol).type = getTypeFromBindingElement(c, e, includePatternInType, reportErrors);
    members.set(symbol.name, symbol);
  }
  const result = createAnonymousType(c, undefined, members, [], [], indexInfos);
  result.objectFlags |= objectFlags;
  return result;
}

function getTypeFromArrayBindingPattern(
  c: Checker,
  pattern: Node,
  includePatternInType: boolean,
  reportErrors: boolean,
): Type {
  const elements = getElements(pattern)!.nodes;
  const last = elements.length > 0 ? elements[elements.length - 1] : undefined;
  const restElement =
    last !== undefined &&
    last.kind === SyntaxKind.BindingElement &&
    (last as BindingElement).dotDotDotToken !== undefined
      ? last
      : undefined;
  if (elements.length === 0 || (elements.length === 1 && restElement !== undefined)) return c.anyArrayType;
  let minLength = 0;
  for (let i = elements.length - 1; i >= 0; i--) {
    const e = elements[i];
    if (!(e === restElement || e.kind === SyntaxKind.OmittedExpression || getInitializer(e) !== undefined)) {
      minLength = i + 1;
      break;
    }
  }
  const types: Type[] = [];
  const infos: TupleElementInfo[] = [];
  for (let i = 0; i < elements.length; i++) {
    const e = elements[i];
    types.push(
      e.kind === SyntaxKind.OmittedExpression
        ? c.anyType
        : getTypeFromBindingElement(c, e as BindingElement, includePatternInType, reportErrors),
    );
    const flags =
      e === restElement ? ElementFlags.Rest : i >= minLength ? ElementFlags.Optional : ElementFlags.Required;
    infos.push(new TupleElementInfo(flags, undefined));
  }
  return createTupleTypeEx(c, types, infos, false);
}

function getTypeFromBindingElement(
  c: Checker,
  element: BindingElement,
  includePatternInType: boolean,
  reportErrors: boolean,
): Type {
  if (element.initializer !== undefined) {
    const t = checkDeclarationInitializer(c, element);
    return getWidenedType(c, getWidenedLiteralLikeTypeForContextualType(c, t, undefined));
  }
  if (isBindingPatternNode(element.name))
    return getTypeFromBindingPattern(c, element.name!, includePatternInType, reportErrors);
  if (reportErrors && c.noImplicitAny) reportImplicitAny(c, element, c.anyType);
  return includePatternInType ? c.nonInferrableAnyType : c.anyType;
}
