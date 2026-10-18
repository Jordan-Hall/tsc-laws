// Types of value symbols: variables, parameters, properties, accessors, functions, classes,
// enums, modules and aliases; optionality and widening.
import { checkJsxAttribute } from './checker-jsx.js';
import { getTargetOfAliasDeclaration, resolveExternalModuleSymbol } from './checker-modules.js';
import { CachedTypeKind, cachedTypeKey, CheckMode } from './checker-types.js';
import {
  type ArrayLiteralExpression,
  type BindingElement,
  type BindingPattern,
  type BinaryExpression,
  type Block,
  type ConditionalExpression,
  type ForInOrOfStatement,
  ModifierFlags,
  NodeVisitor,
  type ObjectLiteralExpression,
  type PrefixUnaryExpression,
  type Node,
  NodeFlags,
  getArguments,
  getInitializer,
  getName,
  getParameters,
  getType,
  getBody,
  getSymbol,
  getMembers,
  getDotDotDotToken,
  getElements,
  getExpression,
  getLocals,
  getPostfixToken,
  getQuestionToken,
  getText,
  type PropertyAssignment,
  type ShorthandPropertyAssignment,
  type SourceFile,
  type VariableDeclarationList,
} from './ast.js';
import {
  declarationNameToString,
  findConstructorDeclaration,
  getCombinedModifierFlags,
  getCombinedNodeFlags,
  getNameOfDeclaration,
  getRootDeclaration,
  getSourceFileOfNode,
  hasStaticModifier,
  hasSyntacticModifier,
  isCatchClauseVariableDeclarationOrBindingElement,
  isExternalModule,
  isJsonSourceFile,
  isTypeNodeKind,
  skipParentheses,
} from './binder-utilities.js';
import { identifierToKeywordKind } from './scanner.js';
import { tsgoCheckerSlots } from './symbol-accessibility.js';
import { type DiagnosticMessage, Diagnostics } from './diagnostics.js';
import { CheckFlags, type Symbol, SymbolFlags, getSymbolId } from './symbol.js';
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
  getMergedSymbol,
  TypeSystemPropertyName,
  getGlobalTypeAliasSymbol,
  resolveName,
  getGlobalSymbol,
} from './checker-symbols.js';
import {
  getBaseConstructorTypeOfClass,
  getDeclaredTypeOfClassOrInterface,
  getDeclaredTypeOfEnumMember,
  getDeclaredTypeOfSymbol,
} from './checker-declared-types.js';
import { getESSymbolLikeTypeForNode, getTypeFromTypeNode, getTypeAliasInstantiation } from './checker-type-nodes.js';
import {
  getFlowTypeInConstructor,
  getFlowTypeInStaticBlocks,
  getTypeOfPropertyInBaseClass,
} from './checker-classes.js';
import { instantiateType } from './instantiation.js';
import {
  getIndexInfosOfType,
  getPropertiesOfObjectType,
  getPropertiesOfType,
  getPropertyOfObjectType,
  isObjectLiteralType,
} from './checker-members.js';
import { typeToString, symbolToString } from './type-printer.js';
import { getTypeOfMappedSymbol, getIndexType } from './checker-type-operators.js';
import {
  getReturnTypeOfSignature,
  getSignatureFromDeclaration,
  getTypeOfParameter as getTypeOfParameterOfSignature,
} from './checker-signatures.js';
import {
  getReturnTypeFromBody,
  getTypeOfObjectLiteralMethod,
  ReturnCollector,
  shouldReportErrorsFromWideningWithContextualSignature,
} from './checker-functions.js';
import { getTypeOfReverseMappedSymbol } from './checker-inference.js';
import {
  checkDeclarationInitializer,
  getContextuallyTypedParameterType,
  getContextualThisParameterType,
  checkExpressionCached,
  checkExpressionEx,
  isConstTypeReference,
} from './checker-expressions.js';
import { checkPropertyAssignment, checkShorthandPropertyAssignment } from './checker-object-literals.js';
import { getTypeForBindingElement, getTypeFromBindingPattern } from './checker-destructuring.js';
import { checkRightHandSideOfForOf } from './checker-statements.js';
import { getTypeWithFacts, TypeFacts, hasTypeFacts, getNonNullableType } from './checker-flow.js';
import { getTypeOfModuleExportsSymbol, getWidenedTypeForAssignmentDeclaration } from './checker-javascript.js';

export function getTypeOfSymbol(c: Checker, symbol: Symbol): Type {
  const checkFlags = symbol.checkFlags;
  if ((checkFlags & CheckFlags.DeferredType) !== 0) return getTypeOfSymbolWithDeferredType(c, symbol);
  if ((checkFlags & CheckFlags.Instantiated) !== 0) return getTypeOfInstantiatedSymbol(c, symbol);
  if ((checkFlags & CheckFlags.Mapped) !== 0) return getTypeOfMappedSymbol(c, symbol);
  if ((checkFlags & CheckFlags.ReverseMapped) !== 0) return getTypeOfReverseMappedSymbol(c, symbol);
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
  const id = symbol.id;
  if (c.symbolTypes.get(id) === undefined) {
    const constituents = links.deferralConstituents!;
    c.symbolTypes.set(
      id,
      (links.deferralParent!.flags & TypeFlags.Union) !== 0
        ? getUnionType(c, constituents)
        : getIntersectionType(c, constituents),
    );
  }
  return c.symbolTypes.get(id)!;
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
  const id = getSymbolId(symbol);
  let type = c.symbolTypes.get(id);
  if (type === undefined) {
    type = instantiateType(c, getTypeOfSymbol(c, c.symbolTargets.get(id)!), c.symbolMappers.get(id));
    c.symbolTypes.set(id, type);
  }
  return type;
}

export function getWriteTypeOfSymbol(c: Checker, symbol: Symbol): Type {
  if ((symbol.checkFlags & CheckFlags.SyntheticProperty) !== 0) {
    if ((symbol.checkFlags & CheckFlags.DeferredType) !== 0) return getWriteTypeOfSymbolWithDeferredType(c, symbol);
    const id = getSymbolId(symbol);
    return c.symbolLinkTable.get(id)?.writeType ?? c.symbolTypes.get(id) ?? getTypeOfSymbol(c, symbol);
  }
  if ((symbol.flags & SymbolFlags.Property) !== 0)
    return removeMissingType(c, getTypeOfSymbol(c, symbol), (symbol.flags & SymbolFlags.Optional) !== 0);
  if ((symbol.flags & SymbolFlags.Accessor) !== 0) {
    if ((symbol.checkFlags & CheckFlags.Instantiated) !== 0) {
      const links = c.symbolLinks(symbol);
      const symbolId = symbol.id;
      if (links.writeType === undefined)
        links.writeType = instantiateType(
          c,
          getWriteTypeOfSymbol(c, c.symbolTargets.get(symbolId)!),
          c.symbolMappers.get(symbolId),
        );
      return links.writeType;
    }
    return getWriteTypeOfAccessors(c, symbol);
  }
  return getTypeOfSymbol(c, symbol);
}

// ---- Variables, parameters and properties

function getTypeOfVariableOrParameterOrProperty(c: Checker, symbol: Symbol): Type {
  const id = getSymbolId(symbol);
  const cached = c.symbolTypes.get(id);
  if (cached !== undefined) return cached;
  const t = getTypeOfVariableOrParameterOrPropertyWorker(c, symbol);
  // Contextually typed parameters may get their type later; don't cache theirs.
  if (c.symbolTypes.get(id) === undefined && !isParameterOfContextSensitiveSignature(c, symbol))
    c.symbolTypes.set(id, t);
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
  // The `export=` symbol of a JSON file has the type of its value.
  if (declaration.kind === SyntaxKind.SourceFile && isJsonSourceFile(declaration as SourceFile)) {
    const statements = (declaration as SourceFile).statements.nodes;
    if (statements.length === 0) return c.emptyObjectType;
    return getWidenedType(c, getWidenedLiteralType(c, checkExpression(c, getExpression(statements[0]!)!)));
  }
  if (!pushTypeResolution(c, symbol, TypeSystemPropertyName.Type)) return reportCircularityError(c, symbol);
  // Like tsgo, the type resolution stays pushed: until popped by an enclosing resolution, its cached
  // type ends cycle detection there, so aliases like `module.exports.b = module.exports.a` resolve.
  if ((symbol.flags & SymbolFlags.ModuleExports) !== 0) return getTypeOfModuleExportsSymbol(c, symbol);
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
      // The declared symbol of an object literal member, as opposed to the checked literal's property.
      if (declaration.kind === SyntaxKind.PropertyAssignment)
        result = checkPropertyAssignment(c, declaration as PropertyAssignment, CheckMode.Normal);
      else if (declaration.kind === SyntaxKind.ShorthandPropertyAssignment)
        result = checkShorthandPropertyAssignment(
          c,
          declaration as ShorthandPropertyAssignment,
          true,
          CheckMode.Normal,
        );
      else result = getTypeOfObjectLiteralMethod(c, declaration, CheckMode.Normal);
      break;
    case SyntaxKind.JsxAttribute:
      result = checkJsxAttribute(c, declaration, CheckMode.Normal);
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
    case SyntaxKind.BinaryExpression:
    case SyntaxKind.CallExpression:
      result = getWidenedTypeForAssignmentDeclaration(c, symbol);
      break;
    default:
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

/** Whether a parameter, property or method is declared with `?`. */
export function isOptionalDeclaration(node: Node): boolean {
  if (getQuestionToken(node) !== undefined) return true;
  // Properties and methods mark optionality with a `?` postfix token.
  const postfix = getPostfixToken(node);
  return postfix !== undefined && postfix.kind === SyntaxKind.QuestionToken;
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
  checkMode: CheckMode = CheckMode.Normal,
): Type | undefined {
  if (declaration.kind === SyntaxKind.VariableDeclaration) {
    const grandParent = declaration.parent!.parent!;
    if (grandParent.kind === SyntaxKind.ForInStatement) {
      // `for (k in x)` declares k as string, or keyof T for generic x.
      let objectType = checkExpressionEx(c, getExpression(grandParent)!, checkMode);
      if (hasTypeFacts(c, objectType, TypeFacts.IsUndefinedOrNull)) objectType = getNonNullableType(c, objectType);
      const indexType = getIndexType(c, objectType);
      return (indexType.flags & (TypeFlags.TypeParameter | TypeFlags.Index)) !== 0
        ? getExtractStringType(c, indexType)
        : c.stringType;
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
      if (getter !== undefined) {
        const getterSignature = getSignatureFromDeclaration(c, getter);
        // An unannotated `this` of a setter takes the getter's `this` type.
        const params = getParameters(fn)!.nodes;
        if (params.length === 2 && params[0] === declaration && getSymbol(declaration)!.name === 'this')
          return getterSignature.thisParameter !== undefined
            ? getTypeOfSymbol(c, getterSignature.thisParameter)
            : c.anyType;
        return getReturnTypeOfSignature(c, getterSignature);
      }
    }
    const fullSignatureType = getParameterTypeOfFullSignature(c, fn, declaration);
    if (fullSignatureType !== undefined) return fullSignatureType;
    const t =
      getSymbol(declaration)!.name === 'this'
        ? getContextualThisParameterType(c, fn)
        : getContextuallyTypedParameterType(c, declaration);
    if (t !== undefined) return addOptionality(c, t, false, isOptional);
  }
  const initializer = getInitializer(declaration);
  if (initializer !== undefined) {
    const t = widenTypeInferredFromInitializer(c, declaration, checkDeclarationInitializer(c, declaration, checkMode));
    return addOptionality(c, t, isProperty, isOptional);
  }
  if (c.noImplicitAny && declaration.kind === SyntaxKind.PropertyDeclaration) {
    // Without an annotation or initializer, the type comes from `this` assignments in the
    // constructor or static blocks.
    const symbol = getSymbol(declaration)!;
    const isAmbient = hasSyntacticModifier(declaration, ModifierFlags.Ambient);
    let t: Type | undefined;
    if (!hasStaticModifier(declaration)) {
      const constructor = findConstructorDeclaration(declaration.parent!);
      if (constructor !== undefined) t = getFlowTypeInConstructor(c, symbol, constructor);
      else if (isAmbient) t = getTypeOfPropertyInBaseClass(c, symbol);
    } else {
      const staticBlocks: Node[] = [];
      for (const member of getMembers(declaration.parent!)!.nodes)
        if (member.kind === SyntaxKind.ClassStaticBlockDeclaration) staticBlocks.push(member);
      if (staticBlocks.length !== 0) t = getFlowTypeInStaticBlocks(c, symbol, staticBlocks);
      else if (isAmbient) t = getTypeOfPropertyInBaseClass(c, symbol);
    }
    return t !== undefined ? addOptionality(c, t, true, isOptional) : undefined;
  }
  if (declaration.kind === SyntaxKind.JsxAttribute) return c.trueType;
  if (isBindingPattern(getName(declaration))) return getTypeFromBindingPattern(c, getName(declaration)!, false, true);
  return undefined;
}

export function widenTypeInferredFromInitializer(c: Checker, declaration: Node, t: Type): Type {
  const widened = getWidenedLiteralTypeForInitializer(c, declaration, t);
  // `null`, `undefined` and `[]` initializers in JavaScript are implicitly `any` and `any[]`.
  if (isInJSFile(declaration)) {
    if (widened === (c.strictNullChecks ? c.implicitNeverType : c.undefinedWideningType)) {
      reportImplicitAny(c, declaration, c.anyType);
      return c.anyType;
    }
    if (isEmptyArrayLiteralType(c, widened)) {
      reportImplicitAny(c, declaration, c.anyArrayType);
      return c.anyArrayType;
    }
  }
  return widened;
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

function isGlobalSymbolConstructor(c: Checker, node: Node): boolean {
  const symbol = getSymbolOfDeclaration(c, node);
  return symbol !== undefined && symbol === getGlobalSymbol(c, 'SymbolConstructor', SymbolFlags.Type, undefined);
}

export function widenTypeForVariableLikeDeclaration(
  c: Checker,
  t: Type | undefined,
  declaration: Node,
  reportErrors: boolean,
): Type {
  if (t !== undefined) {
    // `symbol` properties merged into the global SymbolConstructor are unique symbols, as libraries
    // that predate `unique symbol` declare them.
    if ((t.flags & TypeFlags.ESSymbol) !== 0 && isGlobalSymbolConstructor(c, declaration.parent!))
      t = getESSymbolLikeTypeForNode(c, declaration);
    if (reportErrors) reportErrorsFromWidening(c, declaration, t, WideningKind.Normal);
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

export function declarationBelongsToPrivateAmbientMember(declaration: Node): boolean {
  const root = getRootDeclaration(declaration);
  const member = root.kind === SyntaxKind.Parameter ? root.parent! : root;
  return isPrivateWithinAmbient(member);
}

export function isPrivateWithinAmbient(node: Node): boolean {
  return (
    ((getCombinedModifierFlags(node) & ModifierFlags.Private) !== 0 || isPrivateIdentifierClassElement(node)) &&
    (node.flags & NodeFlags.Ambient) !== 0
  );
}

function isPrivateIdentifierClassElement(node: Node): boolean {
  const name = getName(node);
  return name !== undefined && name.kind === SyntaxKind.PrivateIdentifier;
}

/** What a widened type is the type of, for the implicit any messages. */
export const enum WideningKind {
  Normal,
  FunctionReturn,
  GeneratorNext,
  GeneratorYield,
}

/**
 * Implicit-any widening of null/undefined, which strictNullChecks avoids. A function's inferred
 * types report it only without a contextual signature, or when the contextual type is generic.
 */
export function reportErrorsFromWidening(c: Checker, declaration: Node, t: Type, wideningKind: WideningKind): void {
  if (!c.noImplicitAny || (t.objectFlags & ObjectFlags.ContainsWideningType) === 0) return;
  if (
    wideningKind !== WideningKind.Normal &&
    !(
      isFunctionLikeDeclarationKind(declaration.kind) &&
      shouldReportErrorsFromWideningWithContextualSignature(c, declaration, wideningKind)
    )
  )
    return;
  // Implicit any errors are reported within the type where possible, else on the declaration.
  if (!reportWideningErrorsInType(c, t)) reportImplicitAny(c, declaration, t, wideningKind);
}

function reportWideningErrorsInType(c: Checker, t: Type): boolean {
  let errorReported = false;
  if ((t.objectFlags & ObjectFlags.ContainsWideningType) === 0) return false;
  if ((t.flags & TypeFlags.Union) !== 0) {
    if (someEmptyObjectType(c, typesOf(t))) errorReported = true;
    else for (const s of typesOf(t)) errorReported = errorReported || reportWideningErrorsInType(c, s);
  } else if (isArrayOrTupleType(c, t)) {
    for (const s of getTypeArguments(c, t)) errorReported = errorReported || reportWideningErrorsInType(c, s);
  } else if (isObjectLiteralType(t)) {
    for (const p of getPropertiesOfObjectType(c, t)) {
      const s = getTypeOfSymbol(c, p);
      if ((s.objectFlags & ObjectFlags.ContainsWideningType) === 0) continue;
      errorReported = reportWideningErrorsInType(c, s);
      if (errorReported) continue;
      // Property types can come from object literal normalization in unions.
      let valueDeclaration: Node | undefined;
      for (const d of p.declarations) {
        const v = getSymbol(d)?.valueDeclaration;
        if (v !== undefined && v.parent === t.symbol?.valueDeclaration) {
          valueDeclaration = d;
          break;
        }
      }
      if (valueDeclaration !== undefined) {
        c.error(
          valueDeclaration,
          Diagnostics.Object_literal_s_property_0_implicitly_has_an_1_type,
          symbolToString(c, p),
          typeToString(c, getWidenedType(c, s)),
        );
        errorReported = true;
      }
    }
  }
  return errorReported;
}

export function reportImplicitAny(
  c: Checker,
  declaration: Node,
  t: Type,
  wideningKind: WideningKind = WideningKind.Normal,
): void {
  const file = getSourceFileOfNode(declaration);
  // Only TypeScript files and checked JavaScript files report implicit `any`.
  if (isInJSFile(declaration) && !isCheckJsEnabledForFile(file, c.compilerOptions)) return;
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
      // `(string) => void` most likely meant a parameter of type `string`.
      const name = getName(declaration);
      const parent = declaration.parent!;
      if (
        name !== undefined &&
        name.kind === SyntaxKind.Identifier &&
        (parent.kind === SyntaxKind.CallSignature ||
          parent.kind === SyntaxKind.MethodSignature ||
          parent.kind === SyntaxKind.FunctionType)
      ) {
        const index = getParameters(parent)!.nodes.indexOf(declaration);
        const text = getText(name);
        if (
          index >= 0 &&
          (isTypeNodeKind(identifierToKeywordKind(text)) ||
            resolveName(c, declaration, text, SymbolFlags.Type, undefined, true, false) !== undefined)
        ) {
          c.addErrorOrSuggestion(
            c.noImplicitAny,
            createDiagnosticForNode(declaration, Diagnostics.Parameter_has_a_name_but_no_type_Did_you_mean_0_Colon_1, [
              'arg' + index,
              declarationNameToString(file, name) + (isRest ? '[]' : ''),
            ]),
          );
          return;
        }
      }
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
          wideningKind === WideningKind.GeneratorYield
            ? Diagnostics.Generator_implicitly_has_yield_type_0_Consider_supplying_a_return_type_annotation
            : Diagnostics.Function_expression_which_lacks_return_type_annotation_implicitly_has_an_0_return_type,
          typeAsString,
        );
        return;
      }
      if (c.noImplicitAny && (declaration.flags & NodeFlags.Reparsed) !== 0) {
        c.error(
          declaration,
          Diagnostics.This_overload_implicitly_returns_the_type_0_because_it_lacks_a_return_type_annotation,
          typeAsString,
        );
        return;
      }
      if (!c.noImplicitAny)
        message = Diagnostics.X_0_implicitly_has_an_1_return_type_but_a_better_type_may_be_inferred_from_usage;
      else if (wideningKind === WideningKind.GeneratorYield)
        message = Diagnostics.X_0_which_lacks_return_type_annotation_implicitly_has_an_1_yield_type;
      else message = Diagnostics.X_0_which_lacks_return_type_annotation_implicitly_has_an_1_return_type;
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
  return getWidenedTypeWithContext(c, t, undefined);
}

/** Widening state for the constituents of a union: object literals get each other's missing properties. */
class WideningContext {
  readonly parent: WideningContext | undefined;
  readonly propertyName: string;
  siblings: Type[] | undefined;
  resolvedProperties: Symbol[] | undefined = undefined;
  /** The contexts of the properties, by name, shared by the object literals widened in this one. */
  childContexts: Map<string, WideningContext> | undefined = undefined;
  /** The widened types of the object literals widened in this context, for child contexts. */
  widenedTypes: Map<Type, Type> | undefined = undefined;

  constructor(parent: WideningContext | undefined, propertyName: string, siblings: Type[] | undefined) {
    this.parent = parent;
    this.propertyName = propertyName;
    this.siblings = siblings;
  }

  getChildContext(propertyName: string): WideningContext {
    this.childContexts ??= new Map<string, WideningContext>();
    let result = this.childContexts.get(propertyName);
    if (result === undefined) {
      result = new WideningContext(this, propertyName, undefined);
      this.childContexts.set(propertyName, result);
    }
    return result;
  }
}

function getWidenedTypeWithContext(c: Checker, t: Type, context: WideningContext | undefined): Type {
  if ((t.objectFlags & ObjectFlags.RequiresWidening) === 0) return t;
  const key = cachedTypeKey(CachedTypeKind.Widened, t.id);
  if (context === undefined) {
    const cached = c.cachedTypesById.get(key);
    if (cached !== undefined) return cached;
  }
  let result: Type | undefined;
  if ((t.flags & (TypeFlags.Any | TypeFlags.Nullable)) !== 0) result = c.anyType;
  else if ((t.objectFlags & ObjectFlags.ObjectLiteral) !== 0 && (t.flags & TypeFlags.Object) !== 0)
    result = getWidenedTypeOfObjectLiteral(c, t, context);
  else if ((t.flags & TypeFlags.Union) !== 0) {
    const unionContext = context ?? new WideningContext(undefined, '', typesOf(t));
    const widened: Type[] = [];
    for (const u of typesOf(t))
      widened.push((u.flags & TypeFlags.Nullable) !== 0 ? u : getWidenedTypeWithContext(c, u, unionContext));
    // Widened empty object literals reduce subtypes, e.g. {} | string to {}.
    result = getUnionTypeEx(
      c,
      widened,
      someEmptyObjectType(c, widened) ? UnionReduction.Subtype : UnionReduction.Literal,
      undefined,
      undefined,
    );
  } else if ((t.flags & TypeFlags.Intersection) !== 0) result = getIntersectionType(c, getWidenedTypes(c, typesOf(t)));
  else if (isArrayOrTupleType(c, t))
    result = createTypeReference(c, (t as TypeReference).target!, getWidenedTypes(c, getTypeArguments(c, t)));
  if (result !== undefined && context === undefined) c.cachedTypesById.set(key, result);
  return result ?? t;
}

function getWidenedTypes(c: Checker, types: Type[]): Type[] {
  const result: Type[] = [];
  for (const t of types) result.push(getWidenedType(c, t));
  return result;
}

function someEmptyObjectType(c: Checker, types: Type[]): boolean {
  for (const t of types) if (isEmptyObjectType(c, t)) return true;
  return false;
}

function getWidenedTypeOfObjectLiteral(c: Checker, t: Type, context: WideningContext | undefined): Type {
  const cached = context?.widenedTypes?.get(t);
  if (cached !== undefined) return cached;
  const members = new Map<string, Symbol>();
  for (const prop of getPropertiesOfObjectType(c, t)) members.set(prop.name, getWidenedProperty(c, prop, context));
  if (context !== undefined)
    for (const prop of getPropertiesOfContext(c, context))
      if (!members.has(prop.name)) members.set(prop.name, getUndefinedProperty(c, prop));
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
  // The root context widens each object literal once; a property's context may widen one literal
  // for several siblings.
  if (context !== undefined && context.parent !== undefined) {
    context.widenedTypes ??= new Map<Type, Type>();
    context.widenedTypes.set(t, result);
  }
  return result;
}

function getWidenedProperty(c: Checker, prop: Symbol, context: WideningContext | undefined): Symbol {
  if ((prop.flags & SymbolFlags.Property) === 0) return prop;
  const original = getTypeOfSymbol(c, prop);
  const propContext = context?.getChildContext(prop.name);
  const widened = getWidenedTypeWithContext(c, original, propContext);
  if (widened === original) return prop;
  return createSymbolWithWidenedType(c, prop, widened);
}

function createSymbolWithWidenedType(c: Checker, prop: Symbol, t: Type): Symbol {
  const result = c.newSymbolWithCheckFlags(prop.flags, prop.name, prop.checkFlags & CheckFlags.Readonly);
  result.declarations = prop.declarations;
  result.parent = prop.parent;
  result.valueDeclaration = prop.valueDeclaration;
  const id = getSymbolId(result);
  c.symbolTypes.set(id, t);
  c.symbolTargets.set(id, prop);
  c.symbolNameTypes.set(id, c.symbolNameTypes.get(getSymbolId(prop)));
  return result;
}

/**
 * An optional `undefined` property standing in for `prop`, the last property of that name among the
 * sibling object literals (getPropertiesOfContext). It carries the declarations of the property it is
 * created from, which order it among the members when they are printed.
 *
 * tsgo caches one such symbol per name and checker, so the declarations come from the first literal
 * its checker widened with that name missing in a sibling. Its checkers check the program's files
 * round robin, each file from the top. tsc-ts's checkers take files in another order, and a checker
 * can infer a file's functions for an importer before it checks the file, so the first union is found
 * in the sources of the files tsgo checks with the checker of the property's file, up to that file
 * (`firstSiblingProperty`), which doesn't depend on the order of checking. Without one, the property
 * is cached per sibling property. The order differs from tsgo's where tsgo's checker first infers a
 * function of a file of another checker, or a later function of the file.
 */
function getUndefinedProperty(c: Checker, prop: Symbol): Symbol {
  const member = prop.declarations.length > 0 ? firstSiblingProperty(c, prop.declarations[0]!, prop.name) : undefined;
  const first = member !== undefined ? getSymbol(member) : undefined;
  const source = first ?? prop;
  const key = getSymbolId(source);
  const cached = c.undefinedProperties.get(key);
  if (cached !== undefined) return cached;
  const result = createSymbolWithWidenedType(c, source, c.undefinedOrMissingType);
  result.flags |= SymbolFlags.Optional;
  // The properties of a literal in an `as const` assertion are readonly.
  if (first !== undefined && isInConstAssertion(member!.parent!)) result.checkFlags |= CheckFlags.Readonly;
  c.undefinedProperties.set(key, result);
  return result;
}

/**
 * The property of `name` in the first union of object literals that leaves `name` missing in one of
 * them, among the files tsgo checks with the checker of the declaration's file, up to that file: the
 * last literal's property of that name. tsgo's checker `k` checks files `k`, `k + n`, `k + 2n`, ...
 * in order (`tsgoCheckerSlots`). Unions are those of the returned expressions of a function without
 * a return type, and of the alternatives of an initializer without a type (`?:`, `||`, `??`, array
 * elements, an element access of an array literal, and the values of a property across the literals),
 * of the variables of a `for...of`, of the object of a method call and of the expression of a type
 * assertion. In a file, they are taken in the order a checker checking the file from the top widens
 * them (`SiblingPropertyScan`).
 */
function firstSiblingProperty(c: Checker, declaration: Node, name: string): Node | undefined {
  const file = getSourceFileOfNode(declaration);
  const index = c.fileIndex.get(file);
  if (index === undefined) return siblingPropertiesOfFile(c, file).get(name);
  const slots = tsgoCheckerSlots(c);
  let slot = c.slotSiblingProperties.get(index % slots);
  if (slot === undefined) {
    slot = new SlotSiblingProperties(index % slots);
    c.slotSiblingProperties.set(index % slots, slot);
  }
  for (; slot.next <= index; slot.next += slots)
    for (const [n, member] of siblingPropertiesOfFile(c, c.files[slot.next]!))
      if (!slot.members.has(n)) {
        slot.members.set(n, member);
        slot.fileIndexes.set(n, slot.next);
      }
  const found = slot.fileIndexes.get(name);
  return found !== undefined && found <= index ? slot.members.get(name) : undefined;
}

/**
 * By name, the first property of the unions of `file` that leave the name missing: what a parse thread
 * found (`SourceFile.siblingProperties`), or else the checker's own scan.
 */
function siblingPropertiesOfFile(c: Checker, file: SourceFile): Map<string, Node> {
  // A parse thread's scan takes array literals to have the global Array type.
  if (file.siblingProperties !== undefined && c.globalArrayType !== c.emptyGenericType) return file.siblingProperties;
  let first = c.firstSiblingProperties.get(file);
  if (first === undefined) {
    first = scanSiblingProperties(file, c)!;
    c.firstSiblingProperties.set(file, first);
  }
  return first;
}

/**
 * By name, the first property of the unions of `file`'s object literals that leave the name missing.
 * Without a checker, as on a parse thread, array literals are taken to have the global Array type, and
 * the result is undefined where an enum the scan can't resolve decides which literals subtype reduction
 * leaves out (`enumKeyOfMemberAccess`); the checker then scans the file itself.
 */
export function scanSiblingProperties(file: SourceFile, c: Checker | undefined): Map<string, Node> | undefined {
  if (file.isDeclarationFile) return new Map<string, Node>();
  const scan = new SiblingPropertyScan(c);
  file.forEachChild(scan);
  scan.widenAll();
  return scan.unresolved ? undefined : scan.members;
}

/** The first property of each name among the files of one of tsgo's checkers, scanned in order. */
export class SlotSiblingProperties {
  readonly members = new Map<string, Node>();
  /** The index of the file of each name's property. */
  readonly fileIndexes = new Map<string, number>();
  /** The index of the next file of the checker to scan. */
  next: number;

  constructor(first: number) {
    this.next = first;
  }
}

/** Whether an object literal is in an `as const` assertion, through arrays, spreads and properties. */
function isInConstAssertion(literal: Node): boolean {
  for (let node = literal; node.parent !== undefined; node = node.parent) {
    switch (node.parent.kind) {
      case SyntaxKind.ParenthesizedExpression:
      case SyntaxKind.ArrayLiteralExpression:
      case SyntaxKind.SpreadElement:
      case SyntaxKind.PropertyAssignment:
      case SyntaxKind.ObjectLiteralExpression:
        continue;
      case SyntaxKind.AsExpression:
      case SyntaxKind.TypeAssertionExpression:
        return isConstTypeReference(getType(node.parent)!);
    }
    return false;
  }
  return false;
}

/** An expression whose type is widened, at the position where a checker widens it. */
class WideningRoot {
  constructor(
    readonly position: number,
    /** The function whose returned expressions these are, widened once. */
    readonly func: Node | undefined,
    /** The expressions whose types are unioned and widened. */
    readonly alternatives: Node[],
    /** The expressions whose calls, innermost first, infer their functions' return types before. */
    readonly sources: Node[],
    /** The calls of `sources` that may call a function of the file (`SiblingPropertyScan.callees`). */
    public calls: Node[] | undefined = undefined,
  ) {}
}

/**
 * The unions a checker widens while checking the file's statements or the body of one deferred function, and
 * the deferred functions it queues there.
 */
class CheckScope {
  readonly roots: WideningRoot[] = [];
  readonly deferred: CheckScope[] = [];
  /** The calls by a name (`calleeName`), which infer where they end. */
  readonly calls: Node[] = [];

  constructor(readonly position: number) {}
}

/**
 * Whether a checker checks `node`'s body only as a deferred node: a function expression, arrow
 * function or object literal method or accessor whose return type is written. Without one, the
 * checker infers the return type where it reaches the function, from the returned expressions and
 * what they refer to.
 */
function isDeferredCheck(node: Node): boolean {
  switch (node.kind) {
    case SyntaxKind.FunctionExpression:
    case SyntaxKind.ArrowFunction:
      return getType(node) !== undefined;
    case SyntaxKind.MethodDeclaration:
    case SyntaxKind.GetAccessor:
      return node.parent?.kind === SyntaxKind.ObjectLiteralExpression && getType(node) !== undefined;
    case SyntaxKind.SetAccessor:
      return node.parent?.kind === SyntaxKind.ObjectLiteralExpression;
  }
  return false;
}

/**
 * Finds the unions of a file's object literals in the order a checker widens them: an initializer
 * where it is, and a function's returned expressions at its first `return`, where the checker
 * infers its return type. A call of a function of the file, by a name that resolves to it or as
 * `this.name(...)` in a class, infers that function's return type where the call is, and before the
 * union of the expression the call is in. The bodies of function expressions, arrow functions and
 * object literal methods and accessors with a written return type are checked after the file's
 * statements, so their unions widen then.
 */
class SiblingPropertyScan extends NodeVisitor {
  /** The checker that resolves imported enums, or undefined on a parse thread. */
  readonly c: Checker | undefined;
  /** By name, the property of the first union that leaves the name missing in a literal. */
  readonly members = new Map<string, Node>();
  /**
   * Whether array literals have an array type, whose elements are widened as one union. Without the
   * global Array type (--noLib) an array literal is an empty object type.
   */
  private readonly arrays: boolean;
  /** Whether an enum the scan can't resolve without a checker decided which literals were left out. */
  unresolved = false;
  /** The enums of the members that values refer to, numbered in the order the scan meets them. */
  private readonly enums = new Map<Symbol, number>();
  private readonly fileScope = new CheckScope(0);
  /** The scope of the innermost deferred function around the node being visited. */
  private scope = this.fileScope;
  /** The returned expressions of each function without a return type. */
  private readonly returned = new Map<Node, WideningRoot>();
  /** The names a call can call those functions by (`functionName`). */
  private readonly callees = new Set<string>();
  private readonly widened = new Set<Node>();
  /** The functions and methods of each class, by name. */
  private readonly classFunctions = new Map<Node, Map<string, Node>>();

  constructor(c: Checker | undefined) {
    super();
    this.c = c;
    this.arrays = c === undefined || c.globalArrayType !== c.emptyGenericType;
  }

  /** The key of the values that are members of `symbol`, an enum, in this scan. */
  enumKey(symbol: Symbol): string {
    let id = this.enums.get(symbol);
    if (id === undefined) {
      id = this.enums.size;
      this.enums.set(symbol, id);
    }
    return 'enum ' + id;
  }

  visitNode(node: Node): boolean {
    switch (node.kind) {
      case SyntaxKind.FunctionDeclaration:
      case SyntaxKind.FunctionExpression:
      case SyntaxKind.ArrowFunction:
      case SyntaxKind.MethodDeclaration:
      case SyntaxKind.GetAccessor: {
        const body = getBody(node);
        if (body === undefined || getType(node) !== undefined) break;
        const returned: Node[] = [];
        const sources: Node[] = [];
        let position = body.pos;
        if (body.kind === SyntaxKind.Block) {
          const collector = new ReturnCollector();
          collector.visitStatements(body as Block);
          if (collector.returns.length > 0) position = collector.returns[0]!.pos;
          for (const r of collector.returns)
            if (r.expression !== undefined) {
              addAlternatives(r.expression, returned, this.arrays);
              sources.push(r.expression);
            }
        } else {
          addAlternatives(body, returned, this.arrays);
          sources.push(body);
        }
        if (returned.length === 0) break;
        const root = new WideningRoot(position, node, returned, sources);
        this.returned.set(node, root);
        this.addRoot(root);
        if (node.kind === SyntaxKind.MethodDeclaration || node.kind === SyntaxKind.GetAccessor)
          this.addClassFunction(node, node);
        break;
      }
      case SyntaxKind.VariableDeclaration:
      case SyntaxKind.PropertyDeclaration:
      case SyntaxKind.Parameter: {
        const initializer = getInitializer(node);
        if (initializer === undefined || getType(node) !== undefined) break;
        this.addRoot(
          new WideningRoot(initializer.pos, undefined, addAlternatives(initializer, [], this.arrays), [initializer]),
        );
        const value = skipParentheses(initializer);
        if (
          node.kind === SyntaxKind.PropertyDeclaration &&
          (value.kind === SyntaxKind.ArrowFunction || value.kind === SyntaxKind.FunctionExpression)
        )
          this.addClassFunction(node, value);
        break;
      }
      case SyntaxKind.ExportAssignment:
        if (getType(node) === undefined) {
          const expression = getExpression(node)!;
          this.addRoot(
            new WideningRoot(node.pos, undefined, addAlternatives(expression, [], this.arrays), [expression]),
          );
        }
        break;
      case SyntaxKind.ForOfStatement: {
        // The variable of `for (const x of e)` has the widened type of e's elements, and each element
        // of a binding pattern the widened type of its part of them.
        const statement = node as ForInOrOfStatement;
        if (statement.initializer.kind !== SyntaxKind.VariableDeclarationList) break;
        const declaration = (statement.initializer as VariableDeclarationList).declarations.nodes[0];
        if (declaration === undefined || getType(declaration) !== undefined || !this.arrays) break;
        const elements: Node[] = [];
        for (const array of iteratedArrayLiterals(statement.expression)) addArrayElements(array, elements);
        if (elements.length === 0) break;
        for (const alternatives of bindingAlternatives(getName(declaration)!, elements))
          this.addRoot(new WideningRoot(statement.expression.pos, undefined, alternatives, [statement.expression]));
        break;
      }
      case SyntaxKind.CallExpression: {
        // The object of a method call is widened before the call is resolved.
        const callee = skipParentheses(getExpression(node)!);
        if (
          (callee.kind === SyntaxKind.PropertyAccessExpression || callee.kind === SyntaxKind.ElementAccessExpression) &&
          mayHoldLiterals(getExpression(callee)!)
        )
          this.addExpressionRoot(callee.pos, getExpression(callee)!);
        // Calls elsewhere, as in statements, infer where they end.
        if (calleeName(node) !== undefined) this.scope.calls.push(node);
        break;
      }
    }
    if (isTypeNodeKind(node.kind)) return false;
    if (
      (node.kind === SyntaxKind.AsExpression || node.kind === SyntaxKind.TypeAssertionExpression) &&
      !isConstTypeReference(getType(node)!)
    ) {
      // An assertion widens its expression's type in a deferred check, queued after the expression's.
      node.forEachChild(this);
      const inner = new CheckScope(node.end);
      this.scope.deferred.push(inner);
      const saveScope = this.scope;
      this.scope = inner;
      this.addExpressionRoot(node.end, getExpression(node)!);
      this.scope = saveScope;
      return false;
    }
    if (isDeferredCheck(node)) {
      const inner = new CheckScope(node.pos);
      this.scope.deferred.push(inner);
      const saveScope = this.scope;
      this.scope = inner;
      node.forEachChild(this);
      this.scope = saveScope;
    } else node.forEachChild(this);
    return false;
  }

  private addRoot(root: WideningRoot): void {
    this.scope.roots.push(root);
  }

  /** Adds a root for the widened type of `expression` where it holds object or array literals. */
  private addExpressionRoot(position: number, expression: Node): void {
    const alternatives = addAlternatives(expression, [], this.arrays);
    if (
      alternatives.some(
        (a) => a.kind === SyntaxKind.ObjectLiteralExpression || a.kind === SyntaxKind.ArrayLiteralExpression,
      )
    )
      this.addRoot(new WideningRoot(position, undefined, alternatives, [expression]));
  }

  /** Names `func` in its class by `member`, a method or a property it initializes. */
  private addClassFunction(member: Node, func: Node): void {
    const name = getName(member);
    const parent = member.parent!;
    if (name === undefined || name.kind !== SyntaxKind.Identifier) return;
    if (parent.kind !== SyntaxKind.ClassDeclaration && parent.kind !== SyntaxKind.ClassExpression) return;
    let functions = this.classFunctions.get(parent);
    if (functions === undefined) this.classFunctions.set(parent, (functions = new Map()));
    if (!functions.has(getText(name))) functions.set(getText(name), func);
  }

  /**
   * Widens the unions of the file's statements in order, then those of each deferred node in the
   * order the checker queues them, which includes the deferred nodes queued while checking one.
   */
  widenAll(): void {
    for (const func of this.returned.keys()) {
      const name = functionName(func);
      if (name !== undefined) this.callees.add(name);
    }
    const queue = [this.fileScope];
    for (let i = 0; i < queue.length; i++) {
      const scope = queue[i]!;
      if (this.callees.size !== 0)
        for (const call of scope.calls)
          if (this.callees.has(calleeName(call)!))
            scope.roots.push(new WideningRoot(call.end, undefined, [], [], [call]));
      scope.roots.sort((a, b) => a.position - b.position);
      scope.deferred.sort((a, b) => a.position - b.position);
      let next = 0;
      for (const root of scope.roots) {
        while (next < scope.deferred.length && scope.deferred[next]!.position < root.position)
          queue.push(scope.deferred[next++]!);
        this.widenRoot(root);
      }
      while (next < scope.deferred.length) queue.push(scope.deferred[next++]!);
    }
  }

  /** Widens a root's unions, after the returned expressions of the functions its calls infer. */
  private widenRoot(root: WideningRoot): void {
    if (root.func !== undefined) {
      if (this.widened.has(root.func)) return;
      this.widened.add(root.func);
    }
    if (this.callees.size === 0) {
      this.widen(root.alternatives, true);
      return;
    }
    if (root.calls === undefined) {
      const collector = new CallCollector(this.callees);
      for (const source of root.sources) collector.visitNode(source);
      root.calls = collector.calls;
    }
    for (const call of root.calls) {
      const callee = this.calledFunction(call);
      const returned = callee !== undefined ? this.returned.get(callee) : undefined;
      if (returned !== undefined) this.widenRoot(returned);
    }
    this.widen(root.alternatives, true);
  }

  /**
   * The function a call calls: a function declaration or a variable initialized with a function that
   * the callee's name resolves to (`getLocals` of the scopes around the call), or a method or property
   * of the class for `this.name(...)` in a class member.
   */
  private calledFunction(call: Node): Node | undefined {
    const callee = skipParentheses(getExpression(call)!);
    if (callee.kind === SyntaxKind.Identifier) {
      const name = getText(callee);
      for (let scope = call.parent; scope !== undefined; scope = scope.parent) {
        const symbol = getLocals(scope)?.get(name);
        // A type alias, interface or type parameter of the name doesn't hide a value of an outer scope.
        if (symbol === undefined || (symbol.flags & (SymbolFlags.Value | SymbolFlags.ExportValue)) === 0) continue;
        // An exported declaration's local symbol has no value declaration of its own.
        const declaration =
          symbol.valueDeclaration ??
          symbol.declarations.find(
            (d) => d.kind === SyntaxKind.FunctionDeclaration || d.kind === SyntaxKind.VariableDeclaration,
          );
        if (declaration === undefined) return undefined;
        if (declaration.kind === SyntaxKind.FunctionDeclaration) return declaration;
        const initializer =
          declaration.kind === SyntaxKind.VariableDeclaration ? getInitializer(declaration) : undefined;
        const value = initializer !== undefined ? skipParentheses(initializer) : undefined;
        return value !== undefined &&
          (value.kind === SyntaxKind.ArrowFunction || value.kind === SyntaxKind.FunctionExpression)
          ? value
          : undefined;
      }
      return undefined;
    }
    if (callee.kind !== SyntaxKind.PropertyAccessExpression || getExpression(callee)!.kind !== SyntaxKind.ThisKeyword)
      return undefined;
    const name = getName(callee)!;
    const container = thisClass(call);
    const functions = container !== undefined ? this.classFunctions.get(container) : undefined;
    return functions !== undefined && name.kind === SyntaxKind.Identifier ? functions.get(getText(name)) : undefined;
  }

  /**
   * Records the unions of the alternatives of one widened expression, and of their nested values.
   * With `reduced`, the alternatives make up one union with subtype reduction (the alternatives of an
   * expression, the elements of an array literal), which drops a literal whose widened type is the
   * type of an earlier one (`removeSubtypes` removes the later of two identical types). The values of
   * a property across literals are not reduced: their union is one of each literal's value.
   */
  private widen(alternatives: Node[], reduced: boolean): void {
    let literals: ObjectLiteralExpression[] = [];
    for (const a of alternatives)
      if (a.kind === SyntaxKind.ObjectLiteralExpression) literals.push(a as ObjectLiteralExpression);
      // The elements of a tuple, an array literal in an `as const` assertion, widen separately.
      else if (this.arrays && a.kind === SyntaxKind.ArrayLiteralExpression && !isInConstAssertion(a))
        this.widen(addArrayElements(a as ArrayLiteralExpression, []), true);
    if (literals.length === 0) return;
    if (reduced) literals = withoutRepeatedLiterals(this, literals);
    if (literals.length > 1) this.record(literals);
    const values = new Map<string, Node[]>();
    for (const literal of literals)
      for (const member of literal.properties.nodes) {
        if (member.kind !== SyntaxKind.PropertyAssignment) continue;
        const name = staticPropertyName(member);
        if (name === undefined) continue;
        let list = values.get(name);
        if (list === undefined) values.set(name, (list = []));
        // A value's own alternatives make up one reduced union, one member of the property's values.
        const own = addAlternatives((member as PropertyAssignment).initializer, [], this.arrays);
        for (const value of withoutRepeatedLiterals(this, own)) list.push(value);
      }
    for (const list of values.values()) this.widen(list, false);
  }

  /**
   * Records, for each name that some literal without a spread lacks, the last such literal's property
   * of that name, unless an earlier union has the name.
   */
  private record(literals: ObjectLiteralExpression[]): void {
    const plain: Map<string, Node>[] = [];
    for (const literal of literals) {
      let members: Map<string, Node> | undefined = new Map();
      for (const member of literal.properties.nodes) {
        if (member.kind === SyntaxKind.SpreadAssignment) {
          members = undefined;
          break;
        }
        const name = staticPropertyName(member);
        if (name !== undefined) members.set(name, member);
      }
      if (members !== undefined) plain.push(members);
    }
    const last = new Map<string, Node>();
    for (const members of plain) for (const [name, member] of members) last.set(name, member);
    for (const [name, member] of last) {
      // A method's or accessor's symbol has other flags than the property checkObjectLiteral makes of it.
      if (member.kind !== SyntaxKind.PropertyAssignment && member.kind !== SyntaxKind.ShorthandPropertyAssignment)
        continue;
      if (this.members.has(name) || plain.every((members) => members.has(name))) continue;
      this.members.set(name, member);
    }
  }
}

/**
 * `nodes` without the object literals whose widened types are certainly those of an earlier one:
 * the same property names, each with a value of the same widened type (`widenedTypeKey`). Literals
 * that can have a contextual type are kept: it can keep their properties' literal types.
 */
function withoutRepeatedLiterals<T extends Node>(scan: SiblingPropertyScan, nodes: T[]): T[] {
  let keys: string[] | undefined;
  let result: T[] | undefined;
  for (let i = 0; i < nodes.length; i++) {
    const node = nodes[i]!;
    const key =
      node.kind === SyntaxKind.ObjectLiteralExpression && !mayHaveContextualType(node)
        ? widenedTypeKey(scan, node)
        : undefined;
    if (key !== undefined) {
      if (keys === undefined) keys = [];
      else if (keys.includes(key)) {
        // Without a checker, an enum the scan can't resolve may or may not make the types the same.
        if (key.includes(pendingEnumKey)) scan.unresolved = true;
        if (result === undefined) result = nodes.slice(0, i);
        continue;
      }
      keys.push(key);
    }
    result?.push(node);
  }
  return result ?? nodes;
}

/**
 * A key that two expressions of one file share only when their types widen to the same type, or
 * undefined where that isn't known from the syntax: literals by their widened type, members of an
 * enum by the enum, and object literals by their properties' names and keys. Other references can
 * name different symbols or be narrowed differently.
 */
function widenedTypeKey(scan: SiblingPropertyScan, node: Node): string | undefined {
  switch (node.kind) {
    case SyntaxKind.StringLiteral:
    case SyntaxKind.NoSubstitutionTemplateLiteral:
    case SyntaxKind.TemplateExpression:
      return 'string';
    case SyntaxKind.NumericLiteral:
      return 'number';
    case SyntaxKind.BigIntLiteral:
      return 'bigint';
    case SyntaxKind.TrueKeyword:
    case SyntaxKind.FalseKeyword:
      return 'boolean';
    case SyntaxKind.RegularExpressionLiteral:
      return 'RegExp';
    case SyntaxKind.PrefixUnaryExpression: {
      const unary = node as PrefixUnaryExpression;
      const operand = unary.operand.kind;
      if (unary.operator === SyntaxKind.MinusToken || unary.operator === SyntaxKind.PlusToken) {
        if (operand === SyntaxKind.NumericLiteral) return 'number';
        if (operand === SyntaxKind.BigIntLiteral && unary.operator === SyntaxKind.MinusToken) return 'bigint';
      }
      return undefined;
    }
    case SyntaxKind.PropertyAccessExpression:
      return enumKeyOfMemberAccess(scan, node);
    case SyntaxKind.ObjectLiteralExpression: {
      const members: string[] = [];
      for (const member of (node as ObjectLiteralExpression).properties.nodes) {
        if (member.kind !== SyntaxKind.PropertyAssignment) return undefined;
        const name = staticPropertyName(member);
        const value = widenedTypeKey(scan, (member as PropertyAssignment).initializer);
        if (name === undefined || value === undefined) return undefined;
        members.push(JSON.stringify(name) + ': ' + value);
      }
      members.sort();
      return '{' + members.join(', ') + '}';
    }
  }
  return undefined;
}

/** The key of a member of an enum that the scan can't resolve without a checker. */
const pendingEnumKey = 'enum ?';

/**
 * The key of `E.Member` where `E` names an enum in the scopes around the access (`getLocals`, as
 * `calledFunction` finds names) and `Member` is one of its members, not an export of a namespace merged
 * with it: the key of the enum. With a checker, `E` can be imported. Without one, an import, and a
 * global of a script file (whose enum other files can extend), give `pendingEnumKey`.
 */
function enumKeyOfMemberAccess(scan: SiblingPropertyScan, node: Node): string | undefined {
  const target = getExpression(node)!;
  const member = getName(node)!;
  if (target.kind !== SyntaxKind.Identifier || member.kind !== SyntaxKind.Identifier) return undefined;
  const name = getText(target);
  const c = scan.c;
  for (let scope = node.parent; scope !== undefined; scope = scope.parent) {
    let symbol = getLocals(scope)?.get(name);
    if (
      symbol === undefined ||
      (symbol.flags & (SymbolFlags.Value | SymbolFlags.ExportValue | SymbolFlags.Alias)) === 0
    )
      continue;
    if (c === undefined) {
      if ((symbol.flags & SymbolFlags.Alias) !== 0) return pendingEnumKey;
      if (
        (symbol.flags & (SymbolFlags.Enum | SymbolFlags.Module)) !== 0 &&
        !isExternalModule(getSourceFileOfNode(node))
      )
        return pendingEnumKey;
    }
    if (symbol.exportSymbol !== undefined) symbol = symbol.exportSymbol;
    if (c !== undefined) {
      symbol = getMergedSymbol(c, symbol);
      if ((symbol.flags & SymbolFlags.Alias) !== 0) symbol = resolveAlias(c, symbol);
    }
    if ((symbol.flags & SymbolFlags.Enum) === 0) return undefined;
    // An enum merged with a namespace also exports the namespace's values.
    const memberSymbol = symbol.exports?.get(getText(member));
    return memberSymbol !== undefined && (memberSymbol.flags & SymbolFlags.EnumMember) !== 0
      ? scan.enumKey(symbol)
      : undefined;
  }
  return undefined;
}

/**
 * Whether an object literal of a widened expression can have a contextual type: under `satisfies`,
 * an assertion or an argument, as a parameter's default, or returned from a function that can have
 * a contextual signature (a function expression that doesn't initialize an untyped declaration, or a
 * method of an object literal). Initializers of untyped declarations, the returns of function
 * declarations and class members, and the objects of property and element accesses have none.
 */
function mayHaveContextualType(node: Node): boolean {
  for (let current = node.parent; current !== undefined; current = current.parent) {
    switch (current.kind) {
      case SyntaxKind.ParenthesizedExpression:
      case SyntaxKind.NonNullExpression:
      case SyntaxKind.AwaitExpression:
      case SyntaxKind.ConditionalExpression:
      case SyntaxKind.BinaryExpression:
      case SyntaxKind.ArrayLiteralExpression:
      case SyntaxKind.ObjectLiteralExpression:
      case SyntaxKind.PropertyAssignment:
      case SyntaxKind.ReturnStatement:
      case SyntaxKind.Block:
      case SyntaxKind.IfStatement:
      case SyntaxKind.DoStatement:
      case SyntaxKind.WhileStatement:
      case SyntaxKind.ForStatement:
      case SyntaxKind.ForInStatement:
      case SyntaxKind.ForOfStatement:
      case SyntaxKind.SwitchStatement:
      case SyntaxKind.CaseBlock:
      case SyntaxKind.CaseClause:
      case SyntaxKind.DefaultClause:
      case SyntaxKind.LabeledStatement:
      case SyntaxKind.TryStatement:
      case SyntaxKind.CatchClause:
        continue;
      case SyntaxKind.VariableDeclaration:
      case SyntaxKind.PropertyDeclaration:
      case SyntaxKind.ExportAssignment:
      case SyntaxKind.FunctionDeclaration:
      // The object of a property access, as in a method call, has no contextual type.
      case SyntaxKind.PropertyAccessExpression:
      case SyntaxKind.ElementAccessExpression:
        return false;
      case SyntaxKind.MethodDeclaration:
      case SyntaxKind.GetAccessor: {
        const parent = current.parent!.kind;
        return parent !== SyntaxKind.ClassDeclaration && parent !== SyntaxKind.ClassExpression;
      }
      case SyntaxKind.ArrowFunction:
      case SyntaxKind.FunctionExpression: {
        let outer = current.parent!;
        while (outer.kind === SyntaxKind.ParenthesizedExpression) outer = outer.parent!;
        return (
          (outer.kind !== SyntaxKind.VariableDeclaration && outer.kind !== SyntaxKind.PropertyDeclaration) ||
          getType(outer) !== undefined
        );
      }
      default:
        return true;
    }
  }
  return true;
}

/** Collects the calls by one of `names` in an expression, innermost first, outside the functions in it. */
class CallCollector extends NodeVisitor {
  readonly calls: Node[] = [];

  constructor(private readonly names: Set<string>) {
    super();
  }

  visitNode(node: Node): boolean {
    if (isFunctionLike(node) || node.kind === SyntaxKind.ClassExpression) return false;
    node.forEachChild(this);
    if (node.kind === SyntaxKind.CallExpression) {
      const name = calleeName(node);
      if (name !== undefined && this.names.has(name)) this.calls.push(node);
    }
    return false;
  }
}

/** The name a call calls its function by, `f` in `f(...)` and `this.f(...)`, if the scan can resolve it. */
function calleeName(call: Node): string | undefined {
  const callee = skipParentheses(getExpression(call)!);
  if (callee.kind === SyntaxKind.Identifier) return getText(callee);
  if (callee.kind !== SyntaxKind.PropertyAccessExpression || getExpression(callee)!.kind !== SyntaxKind.ThisKeyword)
    return undefined;
  const name = getName(callee)!;
  return name.kind === SyntaxKind.Identifier ? getText(name) : undefined;
}

/**
 * The name calls can call a function without a return type by: a function declaration's, a method's or
 * accessor's, or that of the variable or property a function expression initializes.
 */
function functionName(func: Node): string | undefined {
  let node = func;
  if (func.kind === SyntaxKind.FunctionExpression || func.kind === SyntaxKind.ArrowFunction) {
    while (node.parent?.kind === SyntaxKind.ParenthesizedExpression) node = node.parent;
    if (node.parent?.kind !== SyntaxKind.VariableDeclaration && node.parent?.kind !== SyntaxKind.PropertyDeclaration)
      return undefined;
    node = node.parent;
  }
  const name = getName(node);
  return name?.kind === SyntaxKind.Identifier ? getText(name) : undefined;
}

/** Whether an expression's alternatives (`addAlternatives`) can hold object or array literals. */
function mayHoldLiterals(node: Node): boolean {
  switch (skipParentheses(node).kind) {
    case SyntaxKind.ObjectLiteralExpression:
    case SyntaxKind.ArrayLiteralExpression:
    case SyntaxKind.ConditionalExpression:
    case SyntaxKind.BinaryExpression:
    case SyntaxKind.NonNullExpression:
    case SyntaxKind.SatisfiesExpression:
    case SyntaxKind.AwaitExpression:
    case SyntaxKind.AsExpression:
    case SyntaxKind.TypeAssertionExpression:
      return true;
  }
  return false;
}

/** The class whose instance `this` is at `node`, through arrow functions, in a member or property initializer. */
function thisClass(node: Node): Node | undefined {
  for (let current = node.parent; current !== undefined; current = current.parent) {
    if (current.kind === SyntaxKind.ArrowFunction) continue;
    if (
      current.kind === SyntaxKind.MethodDeclaration ||
      current.kind === SyntaxKind.GetAccessor ||
      current.kind === SyntaxKind.SetAccessor ||
      current.kind === SyntaxKind.Constructor ||
      current.kind === SyntaxKind.PropertyDeclaration
    ) {
      const parent = current.parent!;
      return parent.kind === SyntaxKind.ClassDeclaration || parent.kind === SyntaxKind.ClassExpression
        ? parent
        : undefined;
    }
    if (isFunctionLike(current) || current.kind === SyntaxKind.SourceFile) return undefined;
  }
  return undefined;
}

/**
 * Adds the expressions whose types make up the type of `node`: both sides of `?:`, `||` and `??`,
 * and the elements of an array literal that `node` indexes when `arrays` (see SiblingPropertyScan).
 */
function addAlternatives(node: Node, out: Node[], arrays: boolean): Node[] {
  switch (node.kind) {
    case SyntaxKind.ParenthesizedExpression:
    case SyntaxKind.NonNullExpression:
    case SyntaxKind.SatisfiesExpression:
    case SyntaxKind.AwaitExpression:
      return addAlternatives(getExpression(node)!, out, arrays);
    case SyntaxKind.AsExpression:
    case SyntaxKind.TypeAssertionExpression:
      // An object literal in an `as const` assertion is still an object literal type, with readonly
      // properties; an array literal in one is a tuple, whose elements widen separately.
      if (isConstAssertion(node) && skipParentheses(getExpression(node)!).kind === SyntaxKind.ObjectLiteralExpression)
        return addAlternatives(getExpression(node)!, out, arrays);
      break;
    case SyntaxKind.ConditionalExpression:
      addAlternatives((node as ConditionalExpression).whenTrue, out, arrays);
      return addAlternatives((node as ConditionalExpression).whenFalse, out, arrays);
    case SyntaxKind.BinaryExpression: {
      const binary = node as BinaryExpression;
      switch (binary.operatorToken.kind) {
        case SyntaxKind.BarBarToken:
        case SyntaxKind.QuestionQuestionToken:
          addAlternatives(binary.left, out, arrays);
          return addAlternatives(binary.right, out, arrays);
        case SyntaxKind.AmpersandAmpersandToken:
        case SyntaxKind.CommaToken:
          return addAlternatives(binary.right, out, arrays);
      }
      break;
    }
    case SyntaxKind.ElementAccessExpression: {
      // `[a, b][i]` has the type of the array's elements, which the declaration widens as one union.
      const array = skipParentheses(getExpression(node)!);
      if (!arrays || array.kind !== SyntaxKind.ArrayLiteralExpression) break;
      for (const e of (array as ArrayLiteralExpression).elements.nodes)
        if (e.kind !== SyntaxKind.SpreadElement) addAlternatives(e, out, arrays);
      return out;
    }
  }
  out.push(node);
  return out;
}

/**
 * The alternatives of the elements of an array literal, whose types make its element type, with those
 * of the array literals that its spread elements spread. Used where array literals have an array type
 * (`SiblingPropertyScan.arrays`), as are `iteratedArrayLiterals` and `bindingAlternatives`.
 */
function addArrayElements(array: ArrayLiteralExpression, out: Node[]): Node[] {
  for (const e of array.elements.nodes)
    if (e.kind !== SyntaxKind.SpreadElement) addAlternatives(e, out, true);
    else
      for (const spread of addAlternatives(getExpression(e)!, [], true))
        if (spread.kind === SyntaxKind.ArrayLiteralExpression) addArrayElements(spread as ArrayLiteralExpression, out);
  return out;
}

/** The array literals whose elements a `for...of` over `expression` iterates, through `as const`. */
function iteratedArrayLiterals(expression: Node): ArrayLiteralExpression[] {
  const arrays: ArrayLiteralExpression[] = [];
  for (const a of addAlternatives(expression, [], true)) {
    const value = isConstAssertion(a) ? skipParentheses(getExpression(a)!) : a;
    if (value.kind === SyntaxKind.ArrayLiteralExpression) arrays.push(value as ArrayLiteralExpression);
  }
  return arrays;
}

function isConstAssertion(node: Node): boolean {
  return (
    (node.kind === SyntaxKind.AsExpression || node.kind === SyntaxKind.TypeAssertionExpression) &&
    isConstTypeReference(getType(node)!)
  );
}

/**
 * The alternatives whose union each variable of a binding name is widened from, given the alternatives
 * of the iterated elements: all of them for an identifier; for an element of an array pattern, its
 * element of each `as const` array literal, or every element of another array literal; for an element
 * of an object pattern, the values of its property in each object literal.
 */
function bindingAlternatives(name: Node, elements: Node[]): Node[][] {
  if (name.kind === SyntaxKind.Identifier) return [elements];
  const result: Node[][] = [];
  const isArrayPattern = name.kind === SyntaxKind.ArrayBindingPattern;
  const bindings = (name as BindingPattern).elements.nodes;
  for (let k = 0; k < bindings.length; k++) {
    const binding = bindings[k]!;
    if (binding.kind !== SyntaxKind.BindingElement) continue;
    const element = binding as BindingElement;
    if (element.dotDotDotToken !== undefined || element.initializer !== undefined) continue;
    if (element.name?.kind !== SyntaxKind.Identifier) continue;
    const alternatives: Node[] = [];
    if (isArrayPattern) {
      for (const e of elements) {
        const value = isConstAssertion(e) ? skipParentheses(getExpression(e)!) : e;
        if (value.kind !== SyntaxKind.ArrayLiteralExpression) continue;
        const array = value as ArrayLiteralExpression;
        if (value !== e || isInConstAssertion(array)) {
          const item = array.elements.nodes[k];
          if (item !== undefined && item.kind !== SyntaxKind.SpreadElement) addAlternatives(item, alternatives, true);
        } else addArrayElements(array, alternatives);
      }
    } else {
      const property = element.propertyName ?? element.name;
      const propertyName = property.kind === SyntaxKind.Identifier ? getText(property) : undefined;
      if (propertyName === undefined) continue;
      for (const e of elements) {
        if (e.kind !== SyntaxKind.ObjectLiteralExpression) continue;
        for (const member of (e as ObjectLiteralExpression).properties.nodes)
          if (member.kind === SyntaxKind.PropertyAssignment && staticPropertyName(member) === propertyName)
            addAlternatives((member as PropertyAssignment).initializer, alternatives, true);
      }
    }
    if (alternatives.length !== 0) result.push(alternatives);
  }
  return result;
}

/** The name of an object literal member with a literal name. */
function staticPropertyName(member: Node): string | undefined {
  switch (member.kind) {
    case SyntaxKind.PropertyAssignment:
    case SyntaxKind.ShorthandPropertyAssignment:
    case SyntaxKind.MethodDeclaration:
    case SyntaxKind.GetAccessor:
    case SyntaxKind.SetAccessor:
      break;
    default:
      return undefined;
  }
  const name = getName(member)!;
  switch (name.kind) {
    case SyntaxKind.Identifier:
    case SyntaxKind.StringLiteral:
    case SyntaxKind.NoSubstitutionTemplateLiteral:
      return getText(name);
    case SyntaxKind.NumericLiteral:
      return String(Number(getText(name)));
  }
  return undefined;
}

function getPropertiesOfContext(c: Checker, context: WideningContext): Symbol[] {
  if (context.resolvedProperties === undefined) {
    const names = new Map<string, Symbol>();
    for (const t of getSiblingsOfContext(c, context))
      if (
        (t.objectFlags & ObjectFlags.ObjectLiteral) !== 0 &&
        (t.flags & TypeFlags.Object) !== 0 &&
        (t.objectFlags & ObjectFlags.ContainsSpread) === 0
      )
        for (const prop of getPropertiesOfType(c, t)) names.set(prop.name, prop);
    context.resolvedProperties = [...names.values()];
  }
  return context.resolvedProperties;
}

function getSiblingsOfContext(c: Checker, context: WideningContext): Type[] {
  if (context.siblings === undefined) {
    const siblings: Type[] = [];
    for (const t of getSiblingsOfContext(c, context.parent!))
      if ((t.objectFlags & ObjectFlags.ObjectLiteral) !== 0 && (t.flags & TypeFlags.Object) !== 0) {
        const prop = getPropertyOfObjectType(c, t, context.propertyName);
        if (prop !== undefined) {
          const propType = getTypeOfSymbol(c, prop);
          if ((propType.flags & TypeFlags.Union) !== 0) for (const u of typesOf(propType)) siblings.push(u);
          else siblings.push(propType);
        }
      }
    context.siblings = siblings;
  }
  return context.siblings;
}

// ---- Optionality

export function addOptionality(c: Checker, t: Type, isProperty: boolean, isOptional: boolean): Type {
  return c.strictNullChecks && isOptional ? getOptionalType(c, t, isProperty) : t;
}

export function getOptionalType(c: Checker, t: Type, isProperty: boolean): Type {
  const missingOrUndefined = isProperty ? c.undefinedOrMissingType : c.undefinedType;
  if (t === missingOrUndefined || ((t.flags & TypeFlags.Union) !== 0 && typesOf(t)[0]! === missingOrUndefined))
    return t;
  const key = cachedTypeKey(isProperty ? CachedTypeKind.OptionalProperty : CachedTypeKind.Optional, t.id);
  let result = c.cachedTypesById.get(key);
  if (result === undefined) {
    result = getUnionType(c, [t, missingOrUndefined]);
    c.cachedTypesById.set(key, result);
  }
  return result;
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
    (symbol.flags & SymbolFlags.EnumMember) !== 0 ||
    someReadonlyAssignmentDeclaration(c, symbol.declarations)
  );
}

function someReadonlyAssignmentDeclaration(c: Checker, declarations: Node[]): boolean {
  for (const d of declarations) if (isReadonlyAssignmentDeclaration(c, d)) return true;
  return false;
}

/** An `Object.defineProperty` call with a value and no `writable: true`, or without a setter. */
function isReadonlyAssignmentDeclaration(c: Checker, node: Node): boolean {
  if (node.kind !== SyntaxKind.CallExpression) return false;
  const args = getArguments(node);
  if (args === undefined || args.nodes.length < 3) return false;
  const descriptorType = checkExpressionCached(c, args.nodes[2]!);
  if (getTypeOfPropertyOfType(c, descriptorType, 'value') !== undefined) {
    const writable = getPropertyOfType(c, descriptorType, 'writable');
    if (writable === undefined) return true;
    const declaration = writable.valueDeclaration;
    const writableType =
      declaration !== undefined && declaration.kind === SyntaxKind.PropertyAssignment
        ? checkExpression(c, getInitializer(declaration)!)
        : getTypeOfSymbol(c, writable);
    return writableType === c.falseType || writableType === c.regularFalseType;
  }
  return getTypeOfPropertyOfType(c, descriptorType, 'set') === undefined;
}

import {
  getDeclarationModifierFlagsFromSymbol,
  getPropertyOfType,
  getTypeOfPropertyOfType,
} from './checker-members.js';
import { checkExpression } from './checker-expressions.js';
import { getParameterTypeOfFullSignature } from './checker-jsdoc.js';
import { isFunctionLike, isFunctionLikeDeclarationKind, isInJSFile } from './ast-utilities.js';
import { isEmptyArrayLiteralType } from './relations.js';
import { isCheckJsEnabledForFile } from './program-utilities.js';

function getDeclarationModifierFlags(c: Checker, symbol: Symbol): ModifierFlags {
  return getDeclarationModifierFlagsFromSymbol(c, symbol, false);
}

function getDeclarationNodeFlagsFromSymbol(symbol: Symbol): NodeFlags {
  return symbol.valueDeclaration !== undefined ? getCombinedNodeFlags(symbol.valueDeclaration) : 0;
}

// ---- Accessors

export function getAnnotatedAccessorTypeNode(accessor: Node | undefined): Node | undefined {
  if (accessor === undefined) return undefined;
  if (accessor.kind === SyntaxKind.GetAccessor || accessor.kind === SyntaxKind.PropertyDeclaration)
    return getType(accessor);
  if (accessor.kind === SyntaxKind.SetAccessor) {
    const params = getParameters(accessor)?.nodes ?? [];
    if (params.length === 0) return undefined;
    return getType(params.length === 2 ? params[1]! : params[0]!);
  }
  return undefined;
}

function getAnnotatedAccessorType(c: Checker, accessor: Node | undefined): Type | undefined {
  const node = getAnnotatedAccessorTypeNode(accessor);
  return node !== undefined ? getTypeFromTypeNode(c, node) : undefined;
}

/** The `accessor` property declaration of `symbol`, if any. */
function getAutoAccessorDeclaration(symbol: Symbol): Node | undefined {
  for (const d of symbol.declarations)
    if (d.kind === SyntaxKind.PropertyDeclaration && (getCombinedModifierFlags(d) & ModifierFlags.Accessor) !== 0)
      return d;
  return undefined;
}

function getTypeOfAccessors(c: Checker, symbol: Symbol): Type {
  const id = getSymbolId(symbol);
  const type = c.symbolTypes.get(id);
  if (type !== undefined) return type;
  if (!pushTypeResolution(c, symbol, TypeSystemPropertyName.Type)) return c.errorType;
  const getter = symbol.declarations.find((d) => d.kind === SyntaxKind.GetAccessor);
  const setter = symbol.declarations.find((d) => d.kind === SyntaxKind.SetAccessor);
  const accessor = getAutoAccessorDeclaration(symbol);
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
  let cached = c.symbolTypes.get(id);
  if (cached === undefined) {
    cached = t;
    c.symbolTypes.set(id, cached);
  }
  return cached;
}

export function getWriteTypeOfAccessors(c: Checker, symbol: Symbol): Type {
  const links = c.symbolLinks(symbol);
  if (links.writeType !== undefined) return links.writeType;
  if (!pushTypeResolution(c, symbol, TypeSystemPropertyName.WriteType)) return c.errorType;
  const setter =
    symbol.declarations.find((d) => d.kind === SyntaxKind.SetAccessor) ?? getAutoAccessorDeclaration(symbol);
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
  const id = getSymbolId(symbol);
  let type = c.symbolTypes.get(id);
  if (type === undefined) {
    type = getTypeOfFuncClassEnumModuleWorker(c, symbol);
    c.symbolTypes.set(id, type);
  }
  return type;
}

function getTypeOfFuncClassEnumModuleWorker(c: Checker, symbol: Symbol): Type {
  if ((symbol.flags & SymbolFlags.Module) !== 0 && isShorthandAmbientModuleSymbol(symbol)) return c.anyType;
  if (
    (symbol.flags & SymbolFlags.ValueModule) !== 0 &&
    symbol.valueDeclaration !== undefined &&
    symbol.valueDeclaration.kind === SyntaxKind.SourceFile
  ) {
    const resolvedModule = resolveExternalModuleSymbol(c, symbol, false);
    if (resolvedModule !== undefined && resolvedModule !== symbol) return getTypeOfSymbol(c, resolvedModule);
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

export function getBaseTypeVariableOfClass(c: Checker, symbol: Symbol): Type | undefined {
  const baseConstructorType = getBaseConstructorTypeOfClass(c, getDeclaredTypeOfClassOrInterface(c, symbol));
  if ((baseConstructorType.flags & TypeFlags.TypeVariable) !== 0) return baseConstructorType;
  if ((baseConstructorType.flags & TypeFlags.Intersection) !== 0)
    return typesOf(baseConstructorType).find((t) => (t.flags & TypeFlags.TypeVariable) !== 0);
  return undefined;
}

function getTypeOfEnumMember(c: Checker, symbol: Symbol): Type {
  const id = getSymbolId(symbol);
  let type = c.symbolTypes.get(id);
  if (type === undefined) {
    type = getDeclaredTypeOfEnumMember(c, symbol);
    c.symbolTypes.set(id, type);
  }
  return type;
}

function getTypeOfAlias(c: Checker, symbol: Symbol): Type {
  const id = getSymbolId(symbol);
  const type = c.symbolTypes.get(id);
  if (type !== undefined) return type;
  if (!pushTypeResolution(c, symbol, TypeSystemPropertyName.Type)) return c.errorType;
  const targetSymbol = resolveAlias(c, symbol);
  const exportSymbol = getTargetOfAliasDeclaration(c, getDeclarationOfAliasSymbol(symbol));
  // Only values have types.
  if (c.symbolTypes.get(id) === undefined)
    c.symbolTypes.set(
      id,
      (getSymbolFlags(c, targetSymbol) & SymbolFlags.Value) !== 0 ? getTypeOfSymbol(c, targetSymbol) : c.errorType,
    );
  if (!popTypeResolution(c)) {
    reportCircularityError(c, exportSymbol ?? symbol);
    if (c.symbolTypes.get(id) === undefined) c.symbolTypes.set(id, c.errorType);
  }
  return c.symbolTypes.get(id)!;
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

/** `Extract<t, string>`, or string without the global `Extract`. */
export function getExtractStringType(c: Checker, t: Type): Type {
  const extract = getGlobalTypeAliasSymbol(c, 'Extract', 2, true);
  return extract !== undefined ? getTypeAliasInstantiation(c, extract, [t, c.stringType], undefined) : c.stringType;
}
