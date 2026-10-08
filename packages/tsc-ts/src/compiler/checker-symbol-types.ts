// Types of value symbols: variables, parameters, properties, accessors, functions, classes,
// enums, modules and aliases; optionality and widening.
import {
  ModifierFlags,
  type Node,
  NodeFlags,
  getInitializer,
  getName,
  getParameters,
  getType,
  getBody,
  getSymbol,
  getDotDotDotToken,
  getElements,
  getExpression,
  getQuestionToken,
  getText,
} from './ast.js';
import {
  declarationNameToString,
  getCombinedModifierFlags,
  getCombinedNodeFlags,
  getNameOfDeclaration,
  getRootDeclaration,
  getSourceFileOfNode,
  hasStaticModifier,
  isCatchClauseVariableDeclarationOrBindingElement,
} from './binder-utilities.js';
import { type DiagnosticMessage, Diagnostics } from './diagnostics.js';
import { CheckFlags, type Symbol, SymbolFlags } from './symbol.js';
import { SyntaxKind } from './syntax-kind.js';
import { type Checker, createDiagnosticForNode } from './checker.js';
import {
  type InterfaceType,
  ObjectFlags,
  type Type,
  TypeFlags,
  type UnionType,
  IndexInfo,
  TypeReference,
} from './checker-types.js';
import {
  UnionReduction,
  createAnonymousType,
  createTypeReference,
  getIntersectionType,
  getUnionType,
  getUnionTypeEx,
  getWidenedLiteralType,
  isArrayOrTupleType,
  isEmptyObjectType,
  newObjectType,
  removeType,
  filterType,
  typesOf,
  getTypeArguments,
} from './checker-type-factory.js';
import {
  getDeclarationOfAliasSymbol,
  getParentOfSymbol,
  getSymbolFlags,
  getSymbolOfDeclaration,
  popTypeResolution,
  pushTypeResolution,
  reportCircularityError,
  resolveAlias,
  resolveExternalModuleSymbol,
  TypeSystemPropertyName,
} from './checker-symbols.js';
import {
  getBaseConstructorTypeOfClass,
  getDeclaredTypeOfClassOrInterface,
  getDeclaredTypeOfEnumMember,
  getDeclaredTypeOfSymbol,
} from './checker-declared-types.js';
import { getTypeFromTypeNode } from './checker-type-nodes.js';
import { instantiateType } from './instantiation.js';
import { getIndexInfosOfType, getPropertiesOfObjectType } from './checker-members.js';
import { typeToString, symbolToString } from './type-printer.js';
import { getTypeOfMappedSymbol, getIndexType } from './checker-type-operators.js';
import {
  getReturnTypeOfSignature,
  getSignatureFromDeclaration,
  getTypeOfParameter as getTypeOfParameterOfSignature,
} from './checker-signatures.js';
import { getReturnTypeFromBody } from './checker-functions.js';
import {
  checkDeclarationInitializer,
  getContextuallyTypedParameterType,
  checkExpressionCached,
} from './checker-expressions.js';
import { getTypeForBindingElement, getTypeFromBindingPattern } from './checker-destructuring.js';
import { checkRightHandSideOfForOf } from './checker-statements.js';
import { getTypeWithFacts, TypeFacts } from './checker-flow.js';

export function getTypeOfSymbol(c: Checker, symbol: Symbol): Type {
  const checkFlags = symbol.checkFlags;
  if ((checkFlags & CheckFlags.DeferredType) !== 0) return getTypeOfSymbolWithDeferredType(c, symbol);
  if ((checkFlags & CheckFlags.Instantiated) !== 0) return getTypeOfInstantiatedSymbol(c, symbol);
  if ((checkFlags & CheckFlags.Mapped) !== 0) return getTypeOfMappedSymbol(c, symbol);
  if ((checkFlags & CheckFlags.ReverseMapped) !== 0) return c.symbolLinks(symbol).type ?? c.errorType;
  const flags = symbol.flags;
  if ((flags & SymbolFlags.Accessor) !== 0) return getTypeOfAccessors(c, symbol);
  if ((flags & (SymbolFlags.Variable | SymbolFlags.Property)) !== 0)
    return getTypeOfVariableOrParameterOrProperty(c, symbol);
  if (
    (flags &
      (SymbolFlags.Function | SymbolFlags.Method | SymbolFlags.Class | SymbolFlags.Enum | SymbolFlags.ValueModule)) !==
    0
  )
    return getTypeOfFuncClassEnumModule(c, symbol);
  if ((flags & SymbolFlags.EnumMember) !== 0) return getTypeOfEnumMember(c, symbol);
  if ((flags & SymbolFlags.Alias) !== 0) return getTypeOfAlias(c, symbol);
  return c.errorType;
}

export function getTypeOfParameter(c: Checker, symbol: Symbol): Type {
  return getTypeOfParameterOfSignature(c, symbol);
}

export function getNonMissingTypeOfSymbol(c: Checker, symbol: Symbol): Type {
  return removeMissingType(c, getTypeOfSymbol(c, symbol), (symbol.flags & SymbolFlags.Optional) !== 0);
}

function getTypeOfSymbolWithDeferredType(c: Checker, symbol: Symbol): Type {
  const links = c.symbolLinks(symbol);
  if (links.type === undefined) {
    const constituents = links.deferralConstituents!;
    links.type =
      (links.deferralParent!.flags & TypeFlags.Union) !== 0
        ? getUnionType(c, constituents)
        : getIntersectionType(c, constituents);
  }
  return links.type;
}

function getWriteTypeOfSymbolWithDeferredType(c: Checker, symbol: Symbol): Type {
  const links = c.symbolLinks(symbol);
  if (links.writeType === undefined) {
    const constituents = links.deferralWriteConstituents;
    if (constituents === undefined) links.writeType = getTypeOfSymbolWithDeferredType(c, symbol);
    else
      links.writeType =
        (links.deferralParent!.flags & TypeFlags.Union) !== 0
          ? getUnionType(c, constituents)
          : getIntersectionType(c, constituents);
  }
  return links.writeType;
}

function getTypeOfInstantiatedSymbol(c: Checker, symbol: Symbol): Type {
  const links = c.symbolLinks(symbol);
  if (links.type === undefined) links.type = instantiateType(c, getTypeOfSymbol(c, links.target!), links.mapper);
  return links.type;
}

export function getWriteTypeOfSymbol(c: Checker, symbol: Symbol): Type {
  if ((symbol.checkFlags & CheckFlags.SyntheticProperty) !== 0) {
    if ((symbol.checkFlags & CheckFlags.DeferredType) !== 0) return getWriteTypeOfSymbolWithDeferredType(c, symbol);
    const links = c.symbolLinks(symbol);
    return links.writeType ?? links.type ?? getTypeOfSymbol(c, symbol);
  }
  if ((symbol.flags & SymbolFlags.Property) !== 0)
    return removeMissingType(c, getTypeOfSymbol(c, symbol), (symbol.flags & SymbolFlags.Optional) !== 0);
  if ((symbol.flags & SymbolFlags.Accessor) !== 0) {
    if ((symbol.checkFlags & CheckFlags.Instantiated) !== 0) {
      const links = c.symbolLinks(symbol);
      if (links.writeType === undefined)
        links.writeType = instantiateType(c, getWriteTypeOfSymbol(c, links.target!), links.mapper);
      return links.writeType;
    }
    return getWriteTypeOfAccessors(c, symbol);
  }
  return getTypeOfSymbol(c, symbol);
}

// ---- Variables, parameters and properties

function getTypeOfVariableOrParameterOrProperty(c: Checker, symbol: Symbol): Type {
  const links = c.symbolLinks(symbol);
  if (links.type !== undefined) return links.type;
  const t = getTypeOfVariableOrParameterOrPropertyWorker(c, symbol);
  // Contextually typed parameters may get their type later; don't cache theirs.
  if (links.type === undefined && !isParameterOfContextSensitiveSignature(c, symbol)) links.type = t;
  return t;
}

function isParameterOfContextSensitiveSignature(c: Checker, symbol: Symbol): boolean {
  let decl = symbol.valueDeclaration;
  if (decl === undefined) return false;
  if (decl.kind === SyntaxKind.BindingElement) decl = getRootDeclaration(decl);
  return decl.kind === SyntaxKind.Parameter && isContextSensitiveFunctionLikeLazy(c, decl.parent!);
}

import { isContextSensitiveFunctionOrObjectLiteralMethod as isContextSensitiveFunctionLikeLazy } from './checker-expressions.js';

function getTypeOfVariableOrParameterOrPropertyWorker(c: Checker, symbol: Symbol): Type {
  if ((symbol.flags & SymbolFlags.Prototype) !== 0) return getTypeOfPrototypeProperty(c, symbol);
  if (symbol === c.requireSymbol) return c.anyType;
  const declaration = symbol.valueDeclaration;
  if (declaration === undefined) return c.errorType;
  if (!pushTypeResolution(c, symbol, TypeSystemPropertyName.Type)) return reportCircularityError(c, symbol);
  let result: Type;
  switch (declaration.kind) {
    case SyntaxKind.Parameter:
    case SyntaxKind.PropertyDeclaration:
    case SyntaxKind.PropertySignature:
    case SyntaxKind.VariableDeclaration:
    case SyntaxKind.BindingElement:
      result = getWidenedTypeForVariableLikeDeclaration(c, declaration, true);
      break;
    case SyntaxKind.PropertyAssignment:
    case SyntaxKind.ShorthandPropertyAssignment:
    case SyntaxKind.MethodDeclaration:
    case SyntaxKind.JsxAttribute:
      result = checkExpressionCached(c, declaration);
      break;
    case SyntaxKind.ExportAssignment: {
      const typeNode = getType(declaration);
      result =
        typeNode !== undefined
          ? getTypeFromTypeNode(c, typeNode)
          : widenTypeForVariableLikeDeclaration(
              c,
              checkExpressionCached(c, getExpression(declaration)!),
              declaration,
              false,
            );
      break;
    }
    case SyntaxKind.EnumMember:
      result = getTypeOfEnumMember(c, symbol);
      break;
    default:
      // JS assignment declarations aren't typed yet.
      result = c.anyType;
  }
  if (!popTypeResolution(c)) return reportCircularityError(c, symbol);
  return result;
}

export function getWidenedTypeForVariableLikeDeclaration(c: Checker, declaration: Node, reportErrors: boolean): Type {
  return widenTypeForVariableLikeDeclaration(
    c,
    getTypeForVariableLikeDeclaration(c, declaration, true),
    declaration,
    reportErrors,
  );
}

export function isOptionalDeclaration(node: Node): boolean {
  return getQuestionToken(node) !== undefined;
}

function isEmptyArrayLiteral(node: Node): boolean {
  return node.kind === SyntaxKind.ArrayLiteralExpression && getElements(node)!.nodes.length === 0;
}

function isNullOrUndefined(node: Node): boolean {
  let n = node;
  while (n.kind === SyntaxKind.ParenthesizedExpression) n = getExpression(n)!;
  return n.kind === SyntaxKind.NullKeyword || (n.kind === SyntaxKind.Identifier && getText(n) === 'undefined');
}

function isBindingPattern(node: Node | undefined): boolean {
  return (
    node !== undefined &&
    (node.kind === SyntaxKind.ObjectBindingPattern || node.kind === SyntaxKind.ArrayBindingPattern)
  );
}

/** The declared or inferred type of a variable-like declaration; undefined when nothing can be inferred. */
export function getTypeForVariableLikeDeclaration(
  c: Checker,
  declaration: Node,
  includeOptionality: boolean,
): Type | undefined {
  if (declaration.kind === SyntaxKind.VariableDeclaration) {
    const grandParent = declaration.parent!.parent!;
    if (grandParent.kind === SyntaxKind.ForInStatement) {
      // `for (k in x)` declares k as string, or keyof T for generic x.
      const indexType = getIndexType(c, checkExpressionCached(c, getExpression(grandParent)!));
      return (indexType.flags & (TypeFlags.TypeParameter | TypeFlags.Index)) !== 0 ? c.stringType : c.stringType;
    }
    if (grandParent.kind === SyntaxKind.ForOfStatement) return checkRightHandSideOfForOf(c, grandParent);
  } else if (declaration.kind === SyntaxKind.BindingElement) return getTypeForBindingElement(c, declaration);
  const isProperty =
    (declaration.kind === SyntaxKind.PropertyDeclaration &&
      (getCombinedModifierFlags(declaration) & ModifierFlags.Accessor) === 0) ||
    declaration.kind === SyntaxKind.PropertySignature;
  const isOptional = includeOptionality && isOptionalDeclaration(declaration);
  const typeNode = getType(declaration);
  const declaredType = typeNode !== undefined ? getTypeFromTypeNode(c, typeNode) : undefined;
  if (isCatchClauseVariableDeclarationOrBindingElement(declaration)) {
    if (declaredType !== undefined)
      return (declaredType.flags & TypeFlags.AnyOrUnknown) !== 0 ? declaredType : c.errorType;
    return c.useUnknownInCatchVariables ? c.unknownType : c.anyType;
  }
  if (declaredType !== undefined) return addOptionality(c, declaredType, isProperty, isOptional);
  if (
    c.noImplicitAny &&
    declaration.kind === SyntaxKind.VariableDeclaration &&
    !isBindingPattern(getName(declaration)) &&
    (getCombinedModifierFlags(declaration) & ModifierFlags.Export) === 0 &&
    (declaration.flags & NodeFlags.Ambient) === 0
  ) {
    // Control-flow typed `any` for uninitialized or null/undefined-initialized let and var.
    const initializer = getInitializer(declaration);
    if (
      (getCombinedNodeFlags(declaration) & NodeFlags.Constant) === 0 &&
      (initializer === undefined || isNullOrUndefined(initializer))
    )
      return c.autoType;
    if (initializer !== undefined && isEmptyArrayLiteral(initializer)) return c.autoArrayType;
  }
  if (declaration.kind === SyntaxKind.Parameter) {
    if (getSymbol(declaration) === undefined) return undefined;
    const fn = declaration.parent!;
    // A set accessor parameter takes the getter's type.
    if (fn.kind === SyntaxKind.SetAccessor) {
      const fnSymbol = getSymbolOfDeclaration(c, fn);
      const getter = fnSymbol?.declarations.find((d) => d.kind === SyntaxKind.GetAccessor);
      if (getter !== undefined) return getReturnTypeOfSignature(c, getSignatureFromDeclaration(c, getter));
    }
    const t = getSymbol(declaration)!.name === 'this' ? undefined : getContextuallyTypedParameterType(c, declaration);
    if (t !== undefined) return addOptionality(c, t, false, isOptional);
  }
  const initializer = getInitializer(declaration);
  if (initializer !== undefined) {
    const t = widenTypeInferredFromInitializer(c, declaration, checkDeclarationInitializer(c, declaration));
    return addOptionality(c, t, isProperty, isOptional);
  }
  if (declaration.kind === SyntaxKind.JsxAttribute) return c.trueType;
  if (isBindingPattern(getName(declaration))) return getTypeFromBindingPattern(c, getName(declaration)!, false, true);
  return undefined;
}

function widenTypeInferredFromInitializer(c: Checker, declaration: Node, t: Type): Type {
  return getWidenedLiteralTypeForInitializer(c, declaration, t);
}

export function getWidenedLiteralTypeForInitializer(c: Checker, declaration: Node, t: Type): Type {
  if ((getCombinedNodeFlags(declaration) & NodeFlags.Constant) !== 0 || isDeclarationReadonly(declaration)) return t;
  return getWidenedLiteralType(c, t);
}

function isDeclarationReadonly(declaration: Node): boolean {
  return (
    (getCombinedModifierFlags(declaration) & ModifierFlags.Readonly) !== 0 && declaration.kind !== SyntaxKind.Parameter
  );
}

export function widenTypeForVariableLikeDeclaration(
  c: Checker,
  t: Type | undefined,
  declaration: Node,
  reportErrors: boolean,
): Type {
  if (t !== undefined) {
    if (reportErrors) reportErrorsFromWidening(c, declaration, t);
    // A unique symbol type from another declaration widens.
    if (
      (t.flags & TypeFlags.UniqueESSymbol) !== 0 &&
      (declaration.kind === SyntaxKind.BindingElement || getType(declaration) === undefined) &&
      t.symbol !== getSymbolOfDeclaration(c, declaration)
    )
      t = c.esSymbolType;
    return getWidenedType(c, t);
  }
  // Rest parameters default to any[], others to any.
  const isRest = declaration.kind === SyntaxKind.Parameter && getDotDotDotToken(declaration) !== undefined;
  const result = isRest ? c.anyArrayType : c.anyType;
  if (reportErrors && !declarationBelongsToPrivateAmbientMember(declaration)) reportImplicitAny(c, declaration, result);
  return result;
}

function declarationBelongsToPrivateAmbientMember(declaration: Node): boolean {
  const root = getRootDeclaration(declaration);
  const member = root.kind === SyntaxKind.Parameter ? root.parent! : root;
  return isPrivateWithinAmbient(member);
}

function isPrivateWithinAmbient(node: Node): boolean {
  return (
    ((getCombinedModifierFlags(node) & ModifierFlags.Private) !== 0 || isPrivateIdentifierClassElement(node)) &&
    (node.flags & NodeFlags.Ambient) !== 0
  );
}

function isPrivateIdentifierClassElement(node: Node): boolean {
  const name = getName(node);
  return name !== undefined && name.kind === SyntaxKind.PrivateIdentifier;
}

/** Implicit-any widening of null/undefined, which strictNullChecks avoids. */
function reportErrorsFromWidening(_c: Checker, _declaration: Node, _t: Type): void {}

export function reportImplicitAny(c: Checker, declaration: Node, t: Type): void {
  const file = getSourceFileOfNode(declaration);
  if (file.isJS() && file.checkJsDirective === undefined && c.compilerOptions.checkJs !== true) return;
  const typeAsString = typeToString(c, getWidenedType(c, t));
  let message: DiagnosticMessage;
  switch (declaration.kind) {
    case SyntaxKind.BinaryExpression:
    case SyntaxKind.PropertyDeclaration:
    case SyntaxKind.PropertySignature:
      message = c.noImplicitAny
        ? Diagnostics.Member_0_implicitly_has_an_1_type
        : Diagnostics.Member_0_implicitly_has_an_1_type_but_a_better_type_may_be_inferred_from_usage;
      break;
    case SyntaxKind.Parameter: {
      const isRest = getDotDotDotToken(declaration) !== undefined;
      if (isRest)
        message = c.noImplicitAny
          ? Diagnostics.Rest_parameter_0_implicitly_has_an_any_type
          : Diagnostics.Rest_parameter_0_implicitly_has_an_any_type_but_a_better_type_may_be_inferred_from_usage;
      else
        message = c.noImplicitAny
          ? Diagnostics.Parameter_0_implicitly_has_an_1_type
          : Diagnostics.Parameter_0_implicitly_has_an_1_type_but_a_better_type_may_be_inferred_from_usage;
      break;
    }
    case SyntaxKind.BindingElement:
      if (!c.noImplicitAny) return;
      message = Diagnostics.Binding_element_0_implicitly_has_an_1_type;
      break;
    case SyntaxKind.FunctionDeclaration:
    case SyntaxKind.MethodDeclaration:
    case SyntaxKind.MethodSignature:
    case SyntaxKind.GetAccessor:
    case SyntaxKind.SetAccessor:
    case SyntaxKind.FunctionExpression:
    case SyntaxKind.ArrowFunction:
      if (c.noImplicitAny && getName(declaration) === undefined) {
        c.error(
          declaration,
          Diagnostics.Function_expression_which_lacks_return_type_annotation_implicitly_has_an_0_return_type,
          typeAsString,
        );
        return;
      }
      message = c.noImplicitAny
        ? Diagnostics.X_0_which_lacks_return_type_annotation_implicitly_has_an_1_return_type
        : Diagnostics.X_0_implicitly_has_an_1_return_type_but_a_better_type_may_be_inferred_from_usage;
      break;
    case SyntaxKind.MappedType:
      if (c.noImplicitAny) c.error(declaration, Diagnostics.Mapped_object_type_implicitly_has_an_any_template_type);
      return;
    default:
      message = c.noImplicitAny
        ? Diagnostics.Variable_0_implicitly_has_an_1_type
        : Diagnostics.Variable_0_implicitly_has_an_1_type_but_a_better_type_may_be_inferred_from_usage;
  }
  const name = getNameOfDeclaration(declaration);
  c.addErrorOrSuggestion(
    c.noImplicitAny,
    createDiagnosticForNode(declaration, message, [declarationNameToString(file, name), typeAsString]),
  );
}

// ---- Widening

export function getWidenedType(c: Checker, t: Type): Type {
  if ((t.objectFlags & ObjectFlags.RequiresWidening) === 0) return t;
  const key = 'widened' + t.id;
  const cached = c.cachedTypes.get(key);
  if (cached !== undefined) return cached;
  let result: Type | undefined;
  if ((t.flags & (TypeFlags.Any | TypeFlags.Nullable)) !== 0) result = c.anyType;
  else if ((t.objectFlags & ObjectFlags.ObjectLiteral) !== 0 && (t.flags & TypeFlags.Object) !== 0)
    result = getWidenedTypeOfObjectLiteral(c, t);
  else if ((t.flags & TypeFlags.Union) !== 0) {
    const widened = typesOf(t).map((u) => ((u.flags & TypeFlags.Nullable) !== 0 ? u : getWidenedType(c, u)));
    // Widened empty object literals reduce subtypes, e.g. {} | string to {}.
    result = getUnionTypeEx(
      c,
      widened,
      widened.some((u) => isEmptyObjectType(c, u)) ? UnionReduction.Subtype : UnionReduction.Literal,
      undefined,
      undefined,
    );
  } else if ((t.flags & TypeFlags.Intersection) !== 0)
    result = getIntersectionType(
      c,
      typesOf(t).map((u) => getWidenedType(c, u)),
    );
  else if (isArrayOrTupleType(c, t))
    result = createTypeReference(
      c,
      (t as TypeReference).target!,
      getTypeArguments(c, t).map((u) => getWidenedType(c, u)),
    );
  if (result !== undefined) c.cachedTypes.set(key, result);
  return result ?? t;
}

function getWidenedTypeOfObjectLiteral(c: Checker, t: Type): Type {
  const members = new Map<string, Symbol>();
  for (const prop of getPropertiesOfObjectType(c, t)) members.set(prop.name, getWidenedProperty(c, prop));
  const infos = getIndexInfosOfType(c, t).map(
    (info) =>
      new IndexInfo(
        info.keyType,
        getWidenedType(c, info.valueType),
        info.isReadonly,
        info.declaration,
        info.components,
      ),
  );
  const result = createAnonymousType(c, t.symbol, members, [], [], infos);
  result.objectFlags |= t.objectFlags & (ObjectFlags.JSLiteral | ObjectFlags.NonInferrableType);
  return result;
}

function getWidenedProperty(c: Checker, prop: Symbol): Symbol {
  if ((prop.flags & SymbolFlags.Property) === 0) return prop;
  const original = getTypeOfSymbol(c, prop);
  const widened = getWidenedType(c, original);
  if (widened === original) return prop;
  const result = c.newSymbolWithCheckFlags(prop.flags, prop.name, prop.checkFlags & CheckFlags.Readonly);
  result.declarations = prop.declarations;
  result.parent = prop.parent;
  result.valueDeclaration = prop.valueDeclaration;
  const links = c.symbolLinks(result);
  links.type = widened;
  links.target = prop;
  links.nameType = c.symbolLinks(prop).nameType;
  return result;
}

// ---- Optionality

export function addOptionality(c: Checker, t: Type, isProperty: boolean, isOptional: boolean): Type {
  return c.strictNullChecks && isOptional ? getOptionalType(c, t, isProperty) : t;
}

export function getOptionalType(c: Checker, t: Type, isProperty: boolean): Type {
  const missingOrUndefined = isProperty ? c.undefinedOrMissingType : c.undefinedType;
  if (t === missingOrUndefined || ((t.flags & TypeFlags.Union) !== 0 && typesOf(t)[0] === missingOrUndefined)) return t;
  return getUnionType(c, [t, missingOrUndefined]);
}

export function addOptionalTypeMarker(c: Checker, t: Type): Type {
  return c.strictNullChecks ? getUnionType(c, [t, c.optionalType]) : t;
}

export function removeOptionalTypeMarker(c: Checker, t: Type): Type {
  return c.strictNullChecks ? removeType(c, t, c.optionalType) : t;
}

export function removeMissingType(c: Checker, t: Type, isOptional: boolean): Type {
  return c.exactOptionalPropertyTypes && isOptional ? removeType(c, t, c.missingType) : t;
}

export function removeMissingOrUndefinedType(c: Checker, t: Type): Type {
  return c.exactOptionalPropertyTypes ? removeType(c, t, c.missingType) : getTypeWithFacts(c, t, TypeFacts.NEUndefined);
}

export function getNullableType(c: Checker, t: Type, flags: TypeFlags): Type {
  const missing = flags & ~t.flags & (TypeFlags.Undefined | TypeFlags.Null);
  if (missing === 0) return t;
  if (missing === TypeFlags.Undefined) return getUnionType(c, [t, c.undefinedType]);
  if (missing === TypeFlags.Null) return getUnionType(c, [t, c.nullType]);
  return getUnionType(c, [t, c.undefinedType, c.nullType]);
}

// ---- Readonly

export function isReadonlySymbol(c: Checker, symbol: Symbol): boolean {
  // Readonly properties, const variables, getters without setters and enum members.
  return (
    (symbol.checkFlags & CheckFlags.Readonly) !== 0 ||
    ((symbol.flags & SymbolFlags.Property) !== 0 &&
      (getDeclarationModifierFlags(c, symbol) & ModifierFlags.Readonly) !== 0) ||
    ((symbol.flags & SymbolFlags.Variable) !== 0 &&
      (getDeclarationNodeFlagsFromSymbol(symbol) & NodeFlags.Constant) !== 0) ||
    ((symbol.flags & SymbolFlags.Accessor) !== 0 && (symbol.flags & SymbolFlags.SetAccessor) === 0) ||
    (symbol.flags & SymbolFlags.EnumMember) !== 0
  );
}

import { getDeclarationModifierFlagsFromSymbol } from './checker-members.js';

function getDeclarationModifierFlags(c: Checker, symbol: Symbol): ModifierFlags {
  return getDeclarationModifierFlagsFromSymbol(c, symbol, false);
}

function getDeclarationNodeFlagsFromSymbol(symbol: Symbol): NodeFlags {
  return symbol.valueDeclaration !== undefined ? getCombinedNodeFlags(symbol.valueDeclaration) : 0;
}

// ---- Accessors

function getAnnotatedAccessorTypeNode(accessor: Node | undefined): Node | undefined {
  if (accessor === undefined) return undefined;
  if (accessor.kind === SyntaxKind.GetAccessor || accessor.kind === SyntaxKind.PropertyDeclaration)
    return getType(accessor);
  if (accessor.kind === SyntaxKind.SetAccessor) {
    const params = getParameters(accessor)?.nodes ?? [];
    const valueParam = params.length === 2 ? params[1] : params[0];
    return valueParam !== undefined ? getType(valueParam) : undefined;
  }
  return undefined;
}

function getAnnotatedAccessorType(c: Checker, accessor: Node | undefined): Type | undefined {
  const node = getAnnotatedAccessorTypeNode(accessor);
  return node !== undefined ? getTypeFromTypeNode(c, node) : undefined;
}

function getTypeOfAccessors(c: Checker, symbol: Symbol): Type {
  const links = c.symbolLinks(symbol);
  if (links.type !== undefined) return links.type;
  if (!pushTypeResolution(c, symbol, TypeSystemPropertyName.Type)) return c.errorType;
  const getter = symbol.declarations.find((d) => d.kind === SyntaxKind.GetAccessor);
  const setter = symbol.declarations.find((d) => d.kind === SyntaxKind.SetAccessor);
  const accessor = symbol.declarations.find(
    (d) => d.kind === SyntaxKind.PropertyDeclaration && (getCombinedModifierFlags(d) & ModifierFlags.Accessor) !== 0,
  );
  // Getter annotation, setter annotation, accessor annotation, then getter body.
  let t =
    getAnnotatedAccessorType(c, getter) ?? getAnnotatedAccessorType(c, setter) ?? getAnnotatedAccessorType(c, accessor);
  if (t === undefined && getter !== undefined && getBody(getter) !== undefined) t = getReturnTypeFromBody(c, getter);
  if (t === undefined && accessor !== undefined) t = getWidenedTypeForVariableLikeDeclaration(c, accessor, true);
  if (t === undefined) {
    if (setter !== undefined && !isPrivateWithinAmbient(setter))
      c.addErrorOrSuggestion(
        c.noImplicitAny,
        createDiagnosticForNode(
          setter,
          Diagnostics.Property_0_implicitly_has_type_any_because_its_set_accessor_lacks_a_parameter_type_annotation,
          [symbolToString(c, symbol)],
        ),
      );
    else if (getter !== undefined && !isPrivateWithinAmbient(getter))
      c.addErrorOrSuggestion(
        c.noImplicitAny,
        createDiagnosticForNode(
          getter,
          Diagnostics.Property_0_implicitly_has_type_any_because_its_get_accessor_lacks_a_return_type_annotation,
          [symbolToString(c, symbol)],
        ),
      );
    t = c.anyType;
  }
  if (!popTypeResolution(c)) {
    if (getAnnotatedAccessorTypeNode(getter) !== undefined)
      c.error(
        getter,
        Diagnostics.X_0_is_referenced_directly_or_indirectly_in_its_own_type_annotation,
        symbolToString(c, symbol),
      );
    else if (getAnnotatedAccessorTypeNode(setter) !== undefined)
      c.error(
        setter,
        Diagnostics.X_0_is_referenced_directly_or_indirectly_in_its_own_type_annotation,
        symbolToString(c, symbol),
      );
    else if (getter !== undefined && c.noImplicitAny)
      c.error(
        getter,
        Diagnostics.X_0_implicitly_has_return_type_any_because_it_does_not_have_a_return_type_annotation_and_is_referenced_directly_or_indirectly_in_one_of_its_return_expressions,
        symbolToString(c, symbol),
      );
    t = c.anyType;
  }
  if (links.type === undefined) links.type = t;
  return links.type;
}

function getWriteTypeOfAccessors(c: Checker, symbol: Symbol): Type {
  const links = c.symbolLinks(symbol);
  if (links.writeType !== undefined) return links.writeType;
  if (!pushTypeResolution(c, symbol, TypeSystemPropertyName.WriteType)) return c.errorType;
  const setter =
    symbol.declarations.find((d) => d.kind === SyntaxKind.SetAccessor) ??
    symbol.declarations.find(
      (d) => d.kind === SyntaxKind.PropertyDeclaration && (getCombinedModifierFlags(d) & ModifierFlags.Accessor) !== 0,
    );
  let writeType = getAnnotatedAccessorType(c, setter);
  if (!popTypeResolution(c)) {
    if (getAnnotatedAccessorTypeNode(setter) !== undefined)
      c.error(
        setter,
        Diagnostics.X_0_is_referenced_directly_or_indirectly_in_its_own_type_annotation,
        symbolToString(c, symbol),
      );
    writeType = c.anyType;
  }
  // Without a setter annotation, the write type is the read type.
  if (links.writeType === undefined) links.writeType = writeType ?? getTypeOfAccessors(c, symbol);
  return links.writeType;
}

// ---- Functions, classes, enums, modules and aliases

function getTypeOfFuncClassEnumModule(c: Checker, symbol: Symbol): Type {
  const links = c.symbolLinks(symbol);
  if (links.type === undefined) links.type = getTypeOfFuncClassEnumModuleWorker(c, symbol);
  return links.type;
}

function getTypeOfFuncClassEnumModuleWorker(c: Checker, symbol: Symbol): Type {
  if ((symbol.flags & SymbolFlags.Module) !== 0 && isShorthandAmbientModuleSymbol(symbol)) return c.anyType;
  if (
    (symbol.flags & SymbolFlags.ValueModule) !== 0 &&
    symbol.valueDeclaration !== undefined &&
    symbol.valueDeclaration.kind === SyntaxKind.SourceFile
  ) {
    const resolvedModule = resolveExternalModuleSymbol(c, symbol, false);
    if (resolvedModule !== symbol) return getTypeOfSymbol(c, resolvedModule);
  }
  const t = newObjectType(c, ObjectFlags.Anonymous, symbol);
  if ((symbol.flags & SymbolFlags.Class) !== 0) {
    const baseTypeVariable = getBaseTypeVariableOfClass(c, symbol);
    return baseTypeVariable !== undefined ? getIntersectionType(c, [t, baseTypeVariable]) : t;
  }
  if (c.strictNullChecks && (symbol.flags & SymbolFlags.Optional) !== 0) return getOptionalType(c, t, true);
  return t;
}

function isShorthandAmbientModuleSymbol(symbol: Symbol): boolean {
  const d = symbol.valueDeclaration;
  return d !== undefined && d.kind === SyntaxKind.ModuleDeclaration && getBody(d) === undefined;
}

function getBaseTypeVariableOfClass(c: Checker, symbol: Symbol): Type | undefined {
  const baseConstructorType = getBaseConstructorTypeOfClass(c, getDeclaredTypeOfClassOrInterface(c, symbol));
  if ((baseConstructorType.flags & TypeFlags.TypeVariable) !== 0) return baseConstructorType;
  if ((baseConstructorType.flags & TypeFlags.Intersection) !== 0)
    return typesOf(baseConstructorType).find((t) => (t.flags & TypeFlags.TypeVariable) !== 0);
  return undefined;
}

function getTypeOfEnumMember(c: Checker, symbol: Symbol): Type {
  const links = c.symbolLinks(symbol);
  if (links.type === undefined) links.type = getDeclaredTypeOfEnumMember(c, symbol);
  return links.type;
}

function getTypeOfAlias(c: Checker, symbol: Symbol): Type {
  const links = c.symbolLinks(symbol);
  if (links.type !== undefined) return links.type;
  if (!pushTypeResolution(c, symbol, TypeSystemPropertyName.Type)) return c.errorType;
  const targetSymbol = resolveAlias(c, symbol);
  // Only values have types.
  if (links.type === undefined)
    links.type =
      (getSymbolFlags(c, targetSymbol) & SymbolFlags.Value) !== 0 ? getTypeOfSymbol(c, targetSymbol) : c.errorType;
  if (!popTypeResolution(c)) {
    reportCircularityError(c, symbol);
    if (links.type === undefined) links.type = c.errorType;
  }
  return links.type;
}

function getTypeOfPrototypeProperty(c: Checker, prototype: Symbol): Type {
  // Every class has a `prototype` of its instance type with `any` type arguments.
  const classType = getDeclaredTypeOfSymbol(c, getParentOfSymbol(c, prototype)!) as InterfaceType;
  const typeParameters = classType.typeParameters();
  return typeParameters.length !== 0
    ? createTypeReference(
        c,
        classType,
        typeParameters.map(() => c.anyType),
      )
    : classType;
}

export { getDeclarationOfAliasSymbol, filterType, hasStaticModifier };
export type { UnionType };
