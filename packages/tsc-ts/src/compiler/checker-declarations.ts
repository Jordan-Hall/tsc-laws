// Declarations: variables, parameters, functions, type aliases, enums, namespaces, imports, exports.
import {
  type BindingElement,
  type EnumDeclaration,
  type ExportDeclaration,
  type ImportClause,
  type ImportDeclaration,
  type ModuleDeclaration,
  type NamedExports,
  type NamedImports,
  type Node,
  type TypeAliasDeclaration,
  type TypeParameterDeclaration,
  type TypeReferenceNode,
  type VariableDeclarationList,
  type VariableStatement,
  getExpression,
  getInitializer,
  getName,
  getType,
  getElements,
  getSymbol,
  ModifierFlags,
  NodeFlags,
  getLocalSymbol,
} from './ast.js';
import {
  declarationNameToString,
  getNameOfDeclaration,
  getSourceFileOfNode,
  ModuleInstanceState,
  getCombinedModifierFlags,
  getDeclarationOfKind,
  getModuleInstanceState,
  isEntityNameExpression,
} from './binder-utilities.js';
import { Diagnostics } from './diagnostics.js';
import { SymbolFlags } from './symbol.js';
import { SyntaxKind } from './syntax-kind.js';
import { type Checker, createDiagnosticForNode } from './checker.js';
import { type Type, newTypeMapper } from './checker-types.js';
import { isErrorType } from './checker-type-factory.js';
import { getTypeFromTypeNode } from './checker-type-nodes.js';
import {
  computeEnumMemberValues,
  getConstraintOfTypeParameter,
  getDeclaredTypeOfClassOrInterface,
  getDeclaredTypeOfSymbol,
  getDeclaredTypeOfTypeParameter,
  fillMissingTypeArguments,
  getMinTypeArgumentCount,
} from './checker-declared-types.js';
import {
  getMergedSymbol,
  getSymbolOfDeclaration,
  resolveAlias,
  resolveExternalModuleName,
  resolveExternalModuleNameWorker,
} from './checker-symbols.js';
import { getTypeOfSymbol, getWidenedTypeForVariableLikeDeclaration } from './checker-symbol-types.js';
import {
  checkComputedPropertyName,
  checkExpressionCached,
  checkTypeAssignableToAndOptionallyElaborate,
} from './checker-expressions.js';
import { isTypeIdenticalTo, checkTypeAssignableTo } from './relations.js';
import { instantiateType } from './instantiation.js';
import { typeToString } from './type-printer.js';
import { checkSourceElement, checkTypeNodeIfPresent } from './checker-source-file.js';
import { checkFunctionLikeBody } from './checker-functions.js';
import { ContainerFlags, getContainerFlags } from './binder.js';
import { isAmbientModule, isGlobalScopeAugmentation } from './ast-utilities.js';
import { getTypeForBindingElementParent } from './checker-destructuring.js';

// ---- Variables and parameters

export function checkVariableStatement(c: Checker, node: Node): void {
  checkVariableDeclarationList(c, (node as VariableStatement).declarationList);
}

export function checkVariableDeclarationList(c: Checker, node: Node): void {
  for (const d of (node as VariableDeclarationList).declarations.nodes) checkVariableLikeDeclaration(c, d);
}

/** Checks a variable, parameter, property or binding element declaration. */
export function checkVariableLikeDeclaration(c: Checker, node: Node): void {
  const typeNode = getType(node);
  checkTypeNodeIfPresent(c, typeNode);
  const name = getName(node);
  if (name !== undefined && name.kind === SyntaxKind.ComputedPropertyName) checkComputedPropertyName(c, name);
  const initializer = getInitializer(node);
  if (
    name !== undefined &&
    (name.kind === SyntaxKind.ObjectBindingPattern || name.kind === SyntaxKind.ArrayBindingPattern)
  ) {
    if (initializer !== undefined) checkExpressionCached(c, initializer);
    for (const element of getElements(name)!.nodes) {
      if (element.kind === SyntaxKind.OmittedExpression) continue;
      checkBindingElement(c, element as BindingElement);
    }
    return;
  }
  const symbol = getSymbolOfDeclaration(c, node);
  if (symbol === undefined) {
    if (initializer !== undefined) checkExpressionCached(c, initializer);
    return;
  }
  const t = getTypeOfSymbol(c, symbol);
  if (
    node.kind !== SyntaxKind.PropertyDeclaration &&
    node.kind !== SyntaxKind.PropertySignature &&
    node.kind !== SyntaxKind.Parameter
  )
    checkExportsOnMergedDeclarations(c, node);
  if (node === symbol.valueDeclaration) {
    if (initializer !== undefined) {
      const initType = checkExpressionCached(c, initializer);
      if (typeNode !== undefined && !isErrorType(c, t))
        checkTypeAssignableToAndOptionallyElaborate(c, initType, t, node, initializer);
    }
    return;
  }
  // A redeclaration: types must be identical.
  const declarationType = getWidenedTypeForVariableLikeDeclaration(c, node, false);
  if (
    !isErrorType(c, t) &&
    !isErrorType(c, declarationType) &&
    !isTypeIdenticalTo(c, t, declarationType) &&
    (symbol.flags & SymbolFlags.Assignment) === 0
  )
    errorNextVariableOrPropertyDeclarationMustHaveSameType(c, symbol.valueDeclaration, t, node, declarationType);
  if (initializer !== undefined) {
    const initType = checkExpressionCached(c, initializer);
    if (!isErrorType(c, declarationType))
      checkTypeAssignableToAndOptionallyElaborate(c, initType, declarationType, node, initializer);
  }
}

function checkBindingElement(c: Checker, element: BindingElement): void {
  if (element.propertyName !== undefined && element.propertyName.kind === SyntaxKind.ComputedPropertyName)
    checkComputedPropertyName(c, element.propertyName);
  // Like tsgo, the parent type is computed here (for accessibility checks) as well as for the symbol.
  getTypeForBindingElementParent(c, element.parent!.parent!);
  const name = element.name;
  if (
    name !== undefined &&
    (name.kind === SyntaxKind.ObjectBindingPattern || name.kind === SyntaxKind.ArrayBindingPattern)
  ) {
    for (const e of getElements(name)!.nodes)
      if (e.kind !== SyntaxKind.OmittedExpression) checkBindingElement(c, e as BindingElement);
  } else {
    const symbol = getSymbolOfDeclaration(c, element);
    if (symbol !== undefined) getTypeOfSymbol(c, symbol);
  }
  if (element.initializer !== undefined) checkExpressionCached(c, element.initializer);
}

function errorNextVariableOrPropertyDeclarationMustHaveSameType(
  c: Checker,
  firstDeclaration: Node | undefined,
  firstType: Type,
  nextDeclaration: Node,
  nextType: Type,
): void {
  const nextDeclarationName = getNameOfDeclaration(nextDeclaration);
  const message =
    nextDeclaration.kind === SyntaxKind.PropertyDeclaration || nextDeclaration.kind === SyntaxKind.PropertySignature
      ? Diagnostics.Subsequent_property_declarations_must_have_the_same_type_Property_0_must_be_of_type_1_but_here_has_type_2
      : Diagnostics.Subsequent_variable_declarations_must_have_the_same_type_Variable_0_must_be_of_type_1_but_here_has_type_2;
  const declName = declarationNameToString(getSourceFileOfNode(nextDeclaration), nextDeclarationName);
  const err = c.error(nextDeclarationName, message, declName, typeToString(c, firstType), typeToString(c, nextType));
  if (firstDeclaration !== undefined)
    err.addRelatedInfo(
      createDiagnosticForNode(
        getNameOfDeclaration(firstDeclaration) ?? firstDeclaration,
        Diagnostics.X_0_was_also_declared_here,
        [declName],
      ),
    );
}

// ---- Functions

export function checkFunctionDeclaration(c: Checker, node: Node): void {
  const symbol = getSymbolOfDeclaration(c, node);
  if (symbol !== undefined) getTypeOfSymbol(c, symbol);
  checkFunctionLikeBody(c, node);
}

// ---- Types

export function checkTypeParameter(c: Checker, node: Node): void {
  const tp = node as TypeParameterDeclaration;
  checkTypeNodeIfPresent(c, tp.constraint);
  checkTypeNodeIfPresent(c, tp.defaultType);
  const symbol = getSymbol(node);
  if (symbol === undefined) return;
  const typeParameter = getDeclaredTypeOfTypeParameter(c, symbol);
  getConstraintOfTypeParameter(c, typeParameter);
  if (tp.defaultType !== undefined) {
    const constraint = getConstraintOfTypeParameter(c, typeParameter);
    const defaultType = getTypeFromTypeNode(c, tp.defaultType);
    if (constraint !== undefined && !isErrorType(c, defaultType))
      checkTypeAssignableTo(
        c,
        defaultType,
        instantiateTypeWithSelf(c, constraint),
        tp.defaultType,
        Diagnostics.Type_0_does_not_satisfy_the_constraint_1,
      );
  }
}

function instantiateTypeWithSelf(_c: Checker, t: Type): Type {
  return t;
}

export function checkTypeAliasDeclaration(c: Checker, node: Node): void {
  const alias = node as TypeAliasDeclaration;
  const typeParameters = alias.typeParameters;
  if (typeParameters !== undefined) for (const tp of typeParameters.nodes) checkTypeParameter(c, tp);
  checkExportsOnMergedDeclarations(c, node);
  const symbol = getSymbolOfDeclaration(c, node);
  if (symbol !== undefined) getDeclaredTypeOfSymbol(c, symbol);
  if (alias.type.kind !== SyntaxKind.IntrinsicKeyword) checkSourceElement(c, alias.type);
}

/** Checks the type arguments of a reference to a generic type against their constraints. */
export function checkTypeArgumentConstraintsOfReference(c: Checker, node: Node): void {
  const typeArgumentNodes = (node as TypeReferenceNode).typeArguments;
  if (typeArgumentNodes === undefined) return;
  const symbol = c.nodeLinks(node).resolvedSymbol;
  if (symbol === undefined || symbol === c.unknownSymbol) return;
  let typeParameters: readonly Type[] | undefined = undefined;
  if ((symbol.flags & (SymbolFlags.Class | SymbolFlags.Interface)) !== 0)
    typeParameters = getDeclaredTypeOfClassOrInterface(c, getMergedSymbol(c, symbol)).localTypeParameters();
  else if ((symbol.flags & SymbolFlags.TypeAlias) !== 0) {
    getDeclaredTypeOfSymbol(c, symbol);
    typeParameters = c.symbolLinks(symbol).typeParameters;
  }
  if (typeParameters === undefined || typeParameters.length === 0) return;
  const typeArguments: Type[] = [];
  for (const n of typeArgumentNodes.nodes) {
    const t = getTypeFromTypeNode(c, n);
    if (isErrorType(c, t)) return;
    typeArguments.push(t);
  }
  if (typeArguments.length > typeParameters.length || typeArguments.length < getMinTypeArgumentCount(c, typeParameters))
    return;
  const filled = fillMissingTypeArguments(
    c,
    typeArguments,
    typeParameters,
    getMinTypeArgumentCount(c, typeParameters),
    false,
  );
  const mapper = newTypeMapper(typeParameters.slice(), filled);
  for (let i = 0; i < typeArguments.length; i++) {
    const constraint = getConstraintOfTypeParameter(c, typeParameters[i]);
    if (constraint === undefined) continue;
    checkTypeAssignableTo(
      c,
      typeArguments[i],
      instantiateType(c, constraint, mapper),
      typeArgumentNodes.nodes[i],
      Diagnostics.Type_0_does_not_satisfy_the_constraint_1,
    );
  }
}

export function checkEnumDeclaration(c: Checker, node: Node): void {
  checkExportsOnMergedDeclarations(c, node);
  computeEnumMemberValues(c, node);
  for (const member of (node as EnumDeclaration).members.nodes) {
    const name = getName(member);
    if (name !== undefined && name.kind === SyntaxKind.ComputedPropertyName) checkComputedPropertyName(c, name);
  }
}

export function checkModuleDeclaration(c: Checker, node: Node): void {
  const module = node as ModuleDeclaration;
  if (module.name.kind === SyntaxKind.Identifier && module.keyword === SyntaxKind.ModuleKeyword)
    c.error(
      module.name,
      Diagnostics.A_namespace_declaration_should_not_be_declared_using_the_module_keyword_Please_use_the_namespace_keyword_instead,
    );
  checkExportsOnMergedDeclarations(c, node);
  const body = (node as ModuleDeclaration).body;
  if (body === undefined) return;
  checkSourceElement(c, body);
}

// ---- Imports and exports

export function checkImportDeclaration(c: Checker, node: Node): void {
  const decl = node as ImportDeclaration;
  const clause: ImportClause | undefined = decl.importClause;
  if (clause === undefined) {
    if (c.compilerOptions.noUncheckedSideEffectImports !== false)
      resolveExternalModuleNameWorker(
        c,
        node,
        decl.moduleSpecifier,
        Diagnostics.Cannot_find_module_or_type_declarations_for_side_effect_import_of_0,
        false,
        false,
      );
    return;
  }
  if (clause.name !== undefined) checkAliasSymbol(c, clause);
  const bindings = clause.namedBindings;
  if (bindings !== undefined) {
    if (bindings.kind === SyntaxKind.NamespaceImport) checkAliasSymbol(c, bindings);
    else for (const specifier of (bindings as NamedImports).elements.nodes) checkAliasSymbol(c, specifier);
  }
}

export function checkImportEqualsDeclaration(c: Checker, node: Node): void {
  checkAliasSymbol(c, node);
}

export function checkExportDeclaration(c: Checker, node: Node): void {
  const decl = node as ExportDeclaration;
  if (decl.moduleSpecifier !== undefined) resolveExternalModuleName(c, node, decl.moduleSpecifier, false);
  const clause = decl.exportClause;
  if (clause === undefined) return;
  if (clause.kind === SyntaxKind.NamespaceExport) {
    checkAliasSymbol(c, clause);
    return;
  }
  for (const specifier of (clause as NamedExports).elements.nodes) checkAliasSymbol(c, specifier);
}

export function checkExportAssignment(c: Checker, node: Node): void {
  const expr = getExpression(node)!;
  if (expr.kind === SyntaxKind.Identifier) {
    checkAliasSymbol(c, node);
    return;
  }
  checkExpressionCached(c, expr);
}

function checkAliasSymbol(c: Checker, node: Node): void {
  const symbol = getSymbolOfDeclaration(c, node);
  if (symbol !== undefined) resolveAlias(c, symbol);
}

// ---- Merged declarations

const enum DeclarationSpaces {
  None = 0,
  ExportValue = 1 << 0,
  ExportType = 1 << 1,
  ExportNamespace = 1 << 2,
}

/** Reports merged declarations that mix exported and local (or default-exported) declarations. */
export function checkExportsOnMergedDeclarations(c: Checker, node: Node): void {
  let symbol = getLocalSymbol(node);
  if (symbol === undefined) {
    symbol = getSymbolOfDeclaration(c, node);
    if (symbol === undefined || symbol.exportSymbol === undefined) return;
  }
  if (getDeclarationOfKind(symbol, node.kind) !== node) return;
  let exported = DeclarationSpaces.None;
  let nonExported = DeclarationSpaces.None;
  let defaultExported = DeclarationSpaces.None;
  for (const d of symbol.declarations) {
    const spaces = getDeclarationSpaces(c, d);
    const flags = getEffectiveDeclarationFlags(d, ModifierFlags.Export | ModifierFlags.Default);
    if ((flags & ModifierFlags.Export) !== 0) {
      if ((flags & ModifierFlags.Default) !== 0) defaultExported |= spaces;
      else exported |= spaces;
    } else nonExported |= spaces;
  }
  const nonDefaultExported = exported | nonExported;
  const commonForExportsAndLocals = exported & nonExported;
  const commonForDefaultAndNonDefault = defaultExported & nonDefaultExported;
  if (commonForExportsAndLocals === 0 && commonForDefaultAndNonDefault === 0) return;
  for (const d of symbol.declarations) {
    const spaces = getDeclarationSpaces(c, d);
    const name = getNameOfDeclaration(d);
    const text = declarationNameToString(getSourceFileOfNode(d), name);
    if ((spaces & commonForDefaultAndNonDefault) !== 0)
      c.error(
        name,
        Diagnostics.Merged_declaration_0_cannot_include_a_default_export_declaration_Consider_adding_a_separate_export_default_0_declaration_instead,
        text,
      );
    else if ((spaces & commonForExportsAndLocals) !== 0)
      c.error(
        name,
        Diagnostics.Individual_declarations_in_merged_declaration_0_must_be_all_exported_or_all_local,
        text,
      );
  }
}

function getDeclarationSpaces(c: Checker, node: Node): DeclarationSpaces {
  switch (node.kind) {
    case SyntaxKind.InterfaceDeclaration:
    case SyntaxKind.TypeAliasDeclaration:
      return DeclarationSpaces.ExportType;
    case SyntaxKind.ModuleDeclaration:
      return isAmbientModule(node) || getModuleInstanceState(node) !== ModuleInstanceState.NonInstantiated
        ? DeclarationSpaces.ExportNamespace | DeclarationSpaces.ExportValue
        : DeclarationSpaces.ExportNamespace;
    case SyntaxKind.ClassDeclaration:
    case SyntaxKind.EnumDeclaration:
    case SyntaxKind.EnumMember:
      return DeclarationSpaces.ExportType | DeclarationSpaces.ExportValue;
    case SyntaxKind.SourceFile:
      return DeclarationSpaces.ExportType | DeclarationSpaces.ExportValue | DeclarationSpaces.ExportNamespace;
    case SyntaxKind.ExportAssignment: {
      const expression = getExpression(node)!;
      const symbol = getSymbolOfDeclaration(c, node);
      if (
        !isEntityNameExpression(expression, false) ||
        symbol === undefined ||
        (symbol.flags & SymbolFlags.Alias) === 0
      )
        return DeclarationSpaces.ExportValue;
      return getAliasDeclarationSpaces(c, node);
    }
    case SyntaxKind.ImportEqualsDeclaration:
    case SyntaxKind.NamespaceImport:
    case SyntaxKind.ImportClause:
      return getAliasDeclarationSpaces(c, node);
    case SyntaxKind.MethodSignature:
    case SyntaxKind.PropertySignature:
      return DeclarationSpaces.ExportType;
  }
  return DeclarationSpaces.ExportValue;
}

function getAliasDeclarationSpaces(c: Checker, node: Node): DeclarationSpaces {
  const symbol = getSymbolOfDeclaration(c, node);
  if (symbol === undefined) return DeclarationSpaces.None;
  let result = DeclarationSpaces.None;
  for (const d of resolveAlias(c, symbol).declarations) result |= getDeclarationSpaces(c, d);
  return result;
}

function getEffectiveDeclarationFlags(node: Node, flagsToCheck: ModifierFlags): ModifierFlags {
  let flags = getCombinedModifierFlags(node);
  const parent = node.parent!;
  if (
    parent.kind !== SyntaxKind.InterfaceDeclaration &&
    parent.kind !== SyntaxKind.ClassDeclaration &&
    parent.kind !== SyntaxKind.ClassExpression &&
    (node.flags & NodeFlags.Ambient) !== 0
  ) {
    let container = node.parent;
    while (container !== undefined && (getContainerFlags(container) & ContainerFlags.IsContainer) === 0)
      container = container.parent;
    if (
      container !== undefined &&
      (container.flags & NodeFlags.ExportContext) !== 0 &&
      (flags & ModifierFlags.Ambient) === 0 &&
      !(parent.kind === SyntaxKind.ModuleBlock && isGlobalScopeAugmentation(parent.parent!))
    )
      flags |= ModifierFlags.Export;
    flags |= ModifierFlags.Ambient;
  }
  return flags & flagsToCheck;
}
