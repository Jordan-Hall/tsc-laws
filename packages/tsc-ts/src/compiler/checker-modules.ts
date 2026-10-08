// External modules: resolving module specifiers, alias targets of imports and exports, module
// exports, import types, dynamic imports, and the semantic checks of import and export declarations.
//
// Module-not-found errors are reported on every resolution with an error node, as tsgo does: an
// unresolved `import { a } from "m"` reports once for the declaration and again for each use of `a`.
import { checkDeprecatedImportSpecifier } from './checker-deprecation.js';
import {
  type BinaryExpression,
  type CallExpression,
  type ExportAssignment,
  type ExportDeclaration,
  type HeritageClause,
  type Identifier,
  type ImportAttribute,
  type ImportAttributes,
  type ImportClause,
  type ImportDeclaration,
  type ImportEqualsDeclaration,
  type ImportTypeNode,
  type LiteralTypeNode,
  type MetaProperty,
  type ModuleDeclaration,
  type NamedExports,
  type NamedImports,
  type Node,
  NodeFlags,
  type ObjectLiteralExpression,
  type QualifiedName,
  type SourceFile,
  ModifierFlags,
  getExpression,
  getInitializer,
  getIsTypeOnly,
  getLocals,
  getModuleSpecifier,
  getName,
  getPropertyName,
  getSymbol,
  getText,
  getType,
} from './ast.js';
import {
  getExternalModuleName,
  isAmbientModule,
  isImportCall,
  isFunctionLike,
  isInJSFile,
  isLiteralImportTypeNode,
  isStringLiteralLike,
  nodeIsMissing,
} from './ast-utilities.js';
import {
  declarationNameToString,
  getRootDeclaration,
  getSourceTextOfNode,
  getThisContainer,
  getSourceFileOfNode,
  hasSyntacticModifier,
  isGlobalSourceFile,
  isModuleAugmentationExternal,
  isPartOfTypeQuery,
  isVariableDeclarationInitializedToRequire,
  moduleExportNameIsDefault,
} from './binder-utilities.js';
import { type Diagnostic, type DiagnosticMessage, Diagnostics } from './diagnostics.js';
import { ModuleKind, getEmitModuleKind, getResolveJsonModule } from './options.js';
import { isNodeCoreModule } from './parser.js';
import { isExternalModuleNameRelative } from './path.js';
import { InternalSymbolName, type Symbol, SymbolFlags, type SymbolTable } from './symbol.js';
import { SyntaxKind } from './syntax-kind.js';
import { isExpressionNode } from './transformers/alias-references.js';
import { type Checker, createDiagnosticForNode } from './checker.js';
import { ObjectFlags, type Type, TypeFlags, SignatureKind } from './checker-types.js';
import {
  createAnonymousType,
  getRegularTypeOfLiteralType,
  getStringLiteralType,
  isErrorType,
} from './checker-type-factory.js';
import {
  getFullyQualifiedName,
  getMergedSymbol,
  getSpellingSuggestionForName,
  getSymbolFlags,
  getSymbolOfDeclaration,
  getSymbolOfMeaning,
  getDeclarationOfAliasSymbol,
  getExportSymbolOfValueSymbolIfExported,
  getExportsOfModule,
  getExportsOfSymbol,
  resolveAlias,
  resolveEntityName,
  resolveName,
  resolveSymbol,
  resolveSymbolEx,
  isNonLocalAlias,
  getCachedGlobalType,
} from './checker-symbols.js';
import { getTypeOfSymbol, getNullableType } from './checker-symbol-types.js';
import {
  getPropertyOfType,
  getPropertyOfTypeEx,
  getSignaturesOfStructuredType,
  resolveStructuredTypeMembers,
} from './checker-members.js';
import { getTypeFromTypeNode, getTypeReferenceType } from './checker-type-nodes.js';
import { checkExpression, checkExpressionCached, getResolvedSymbol } from './checker-expressions.js';
import { isTypeAssignableTo, checkTypeAssignableTo } from './relations.js';
import { getSpreadType } from './checker-object-literals.js';
import { checkExternalModuleExports } from './checker-declarations.js';
import { checkTypeNameIsReserved } from './checker-classes.js';
import { getDeclaredTypeOfSymbol } from './checker-declared-types.js';
import { isValidSpreadType } from './checker-destructuring.js';
import { createPromiseType } from './checker-iteration.js';
import { symbolToString, typeToString } from './type-printer.js';
import { checkTypeAssignableToAndOptionallyElaborate } from './checker-expressions.js';

// ---- Resolution

/** The module symbol `moduleReference` names, reporting it when it isn't found unless `ignoreErrors`. */
export function resolveExternalModuleName(
  c: Checker,
  location: Node,
  moduleReference: Node | undefined,
  ignoreErrors: boolean,
): Symbol | undefined {
  const message = getCannotResolveModuleNameError(c, moduleReference);
  return resolveExternalModuleNameWorker(
    c,
    location,
    moduleReference,
    ignoreErrors ? undefined : message,
    ignoreErrors,
    false,
  );
}

/** Node core modules suggest installing `@types/node`. */
function getCannotResolveModuleNameError(c: Checker, moduleReference: Node | undefined): DiagnosticMessage {
  if (
    moduleReference !== undefined &&
    moduleReference.kind === SyntaxKind.StringLiteral &&
    isNodeCoreModule(getText(moduleReference))
  ) {
    const types = c.compilerOptions.types;
    return types !== undefined && types.includes('*')
      ? Diagnostics.Cannot_find_name_0_Do_you_need_to_install_type_definitions_for_node_Try_npm_i_save_dev_types_Slashnode
      : Diagnostics.Cannot_find_name_0_Do_you_need_to_install_type_definitions_for_node_Try_npm_i_save_dev_types_Slashnode_and_then_add_node_to_the_types_field_in_your_tsconfig;
  }
  return Diagnostics.Cannot_find_module_0_or_its_corresponding_type_declarations;
}

export function resolveExternalModuleNameWorker(
  c: Checker,
  location: Node,
  moduleReference: Node | undefined,
  moduleNotFoundError: DiagnosticMessage | undefined,
  ignoreErrors: boolean,
  isForAugmentation: boolean,
): Symbol | undefined {
  if (moduleReference === undefined || !isStringLiteralLike(moduleReference)) return undefined;
  return resolveExternalModule(
    c,
    location,
    getText(moduleReference),
    moduleNotFoundError,
    ignoreErrors ? undefined : moduleReference,
    isForAugmentation,
  );
}

export function resolveExternalModule(
  c: Checker,
  location: Node,
  moduleReference: string,
  moduleNotFoundError: DiagnosticMessage | undefined,
  errorNode: Node | undefined,
  _isForAugmentation: boolean,
): Symbol | undefined {
  if (errorNode !== undefined && moduleReference.startsWith('@types/'))
    c.error(
      errorNode,
      Diagnostics.Cannot_import_type_declaration_files_Consider_importing_0_instead_of_1,
      moduleReference.substring(7),
      moduleReference,
    );
  const ambient = tryFindAmbientModule(c, moduleReference, true);
  if (ambient !== undefined) return ambient;
  const file = c.host.getSourceFileForModuleName(getSourceFileOfNode(location), moduleReference);
  if (file !== undefined) {
    if (file.symbol !== undefined) return getMergedSymbol(c, file.symbol);
    if (errorNode !== undefined && moduleNotFoundError !== undefined && !isSideEffectImport(errorNode))
      c.error(errorNode, Diagnostics.File_0_is_not_a_module, file.fileName);
    return undefined;
  }
  // The pattern with the longest prefix wins.
  let best: Symbol | undefined;
  let bestPrefix = -1;
  for (const pattern of c.patternAmbientModules) {
    if (pattern.matches(moduleReference) && pattern.starIndex > bestPrefix) {
      bestPrefix = pattern.starIndex;
      best = pattern.symbol;
    }
  }
  if (best !== undefined) return getMergedSymbol(c, c.patternAmbientModuleAugmentations.get(moduleReference) ?? best);
  if (errorNode === undefined || moduleNotFoundError === undefined) return undefined;
  if (!getResolveJsonModule(c.compilerOptions) && moduleReference.endsWith('.json'))
    c.error(
      errorNode,
      Diagnostics.Cannot_find_module_0_Consider_using_resolveJsonModule_to_import_module_with_json_extension,
      moduleReference,
    );
  else c.error(errorNode, moduleNotFoundError, moduleReference);
  return undefined;
}

function isSideEffectImport(node: Node): boolean {
  let current: Node | undefined = node;
  while (current !== undefined && current.kind !== SyntaxKind.ImportDeclaration) current = current.parent;
  return current !== undefined && (current as ImportDeclaration).importClause === undefined;
}

export function tryFindAmbientModule(c: Checker, moduleName: string, withAugmentations: boolean): Symbol | undefined {
  if (isExternalModuleNameRelative(moduleName)) return undefined;
  const symbol = getSymbolOfMeaning(c, c.globals, '"' + moduleName + '"', SymbolFlags.ValueModule);
  return symbol !== undefined && withAugmentations ? getMergedSymbol(c, symbol) : symbol;
}

/** The `export =` target of a module, or the module itself. */
export function resolveExternalModuleSymbol(
  c: Checker,
  moduleSymbol: Symbol | undefined,
  dontResolveAlias: boolean,
): Symbol | undefined {
  if (moduleSymbol === undefined) return undefined;
  const exportEquals = moduleSymbol.exports?.get(InternalSymbolName.ExportEquals);
  if (exportEquals === undefined) return moduleSymbol;
  return getMergedSymbol(c, resolveSymbolEx(c, exportEquals, dontResolveAlias));
}

/** The module as a namespace: removes call and construct signatures, or wraps it with a synthetic default. */
export function resolveESModuleSymbol(
  c: Checker,
  moduleSymbol: Symbol | undefined,
  node: Node,
  moduleSpecifier: Node,
): Symbol | undefined {
  let symbol = resolveExternalModuleSymbol(c, moduleSymbol, true);
  if (symbol !== undefined && isNonLocalAlias(symbol, SymbolFlags.Value | SymbolFlags.Type | SymbolFlags.Namespace)) {
    const source = getSymbolOfDeclaration(c, node);
    symbol = getMergedSymbol(
      c,
      source !== undefined ? resolveIndirectionAlias(c, source, symbol) : resolveAlias(c, symbol),
    );
  }
  if (symbol === undefined || moduleSymbol === undefined) return symbol;
  const referenceParent = moduleSpecifier.parent!;
  const namespaceImport =
    referenceParent.kind === SyntaxKind.ImportDeclaration ? getNamespaceImport(referenceParent) : undefined;
  if (namespaceImport === undefined && !isImportCall(referenceParent)) return symbol;
  const reference = isImportCall(referenceParent)
    ? (referenceParent as CallExpression).arguments.nodes[0]!
    : getModuleSpecifier(referenceParent)!;
  const type = getTypeOfSymbol(c, symbol);
  if (hasSignatures(c, type) || getPropertyOfTypeEx(c, type, InternalSymbolName.Default, true, false) !== undefined) {
    const moduleType =
      (type.flags & TypeFlags.StructuredType) !== 0
        ? getTypeWithSyntheticDefaultImportType(c, type, symbol, moduleSymbol, reference)
        : createDefaultPropertyWrapperForModule(c, symbol, symbol.parent, undefined);
    return cloneTypeAsModuleType(c, symbol, moduleType);
  }
  return symbol;
}

function getNamespaceImport(declaration: Node): Node | undefined {
  const clause = (declaration as ImportDeclaration).importClause;
  const bindings = clause?.namedBindings;
  return bindings !== undefined && bindings.kind === SyntaxKind.NamespaceImport ? bindings : undefined;
}

function hasSignatures(c: Checker, type: Type): boolean {
  return (
    getSignaturesOfStructuredType(c, type, SignatureKind.Call).length > 0 ||
    getSignaturesOfStructuredType(c, type, SignatureKind.Construct).length > 0
  );
}

/** `type` with a `default` member for the module, when the module may not have a real one. */
function getTypeWithSyntheticDefaultImportType(
  c: Checker,
  type: Type,
  symbol: Symbol,
  originalSymbol: Symbol,
  moduleSpecifier: Node,
): Type {
  if (isErrorType(c, type)) return type;
  const key = 'synthetic:' + type.id;
  const cached = c.moduleTypeCache.get(key);
  if (cached !== undefined) return cached;
  const file = getSourceFileDeclaration(originalSymbol);
  let result = type;
  if (canHaveSyntheticDefault(c, file, originalSymbol, false, moduleSpecifier)) {
    const anonymousSymbol = c.newSymbol(SymbolFlags.TypeLiteral, InternalSymbolName.Type);
    const defaultContainingObject = createDefaultPropertyWrapperForModule(c, symbol, originalSymbol, anonymousSymbol);
    c.symbolLinks(anonymousSymbol).type = defaultContainingObject;
    result = isValidSpreadType(c, type)
      ? getSpreadType(c, type, defaultContainingObject, anonymousSymbol, ObjectFlags.None, false)
      : defaultContainingObject;
  }
  c.moduleTypeCache.set(key, result);
  return result;
}

function createDefaultPropertyWrapperForModule(
  c: Checker,
  symbol: Symbol,
  originalSymbol: Symbol | undefined,
  anonymousSymbol: Symbol | undefined,
): Type {
  const defaultSymbol = c.newSymbol(SymbolFlags.Alias, InternalSymbolName.Default);
  defaultSymbol.parent = originalSymbol;
  const links = c.symbolLinks(defaultSymbol);
  links.nameType = getStringLiteralType(c, 'default');
  links.aliasTarget = resolveSymbol(c, symbol);
  const members: SymbolTable = new Map<string, Symbol>();
  members.set(InternalSymbolName.Default, defaultSymbol);
  return createAnonymousType(c, anonymousSymbol, members, [], [], []);
}

function cloneTypeAsModuleType(c: Checker, symbol: Symbol, moduleType: Type): Symbol {
  const result = c.newSymbol(symbol.flags, symbol.name);
  result.declarations = symbol.declarations.slice();
  result.valueDeclaration = symbol.valueDeclaration;
  if (symbol.members !== undefined) result.members = new Map(symbol.members);
  if (symbol.exports !== undefined) result.exports = new Map(symbol.exports);
  result.parent = symbol.parent;
  const resolved = resolveStructuredTypeMembers(c, moduleType);
  c.symbolLinks(result).type = createAnonymousType(c, result, resolved.members, [], [], resolved.indexInfos);
  return result;
}

function getSourceFileDeclaration(symbol: Symbol | undefined): SourceFile | undefined {
  if (symbol === undefined) return undefined;
  for (const d of symbol.declarations) if (d.kind === SyntaxKind.SourceFile) return d as SourceFile;
  return undefined;
}

/** The module syntax of the import or export containing `usage`, or `None` for non-literals. */
function getEmitSyntaxForModuleSpecifierExpression(c: Checker, usage: Node): ModuleKind {
  return isStringLiteralLike(usage)
    ? c.host.getEmitSyntaxForUsageLocation(getSourceFileOfNode(usage), usage)
    : ModuleKind.None;
}

/** Whether a default import of the module gets the module itself, as interop helpers make it. */
function canHaveSyntheticDefault(
  c: Checker,
  file: SourceFile | undefined,
  moduleSymbol: Symbol,
  dontResolveAlias: boolean,
  usage: Node,
): boolean {
  const usageMode = file !== undefined ? getEmitSyntaxForModuleSpecifierExpression(c, usage) : ModuleKind.None;
  if (file !== undefined && usageMode !== ModuleKind.None) {
    const targetMode = c.host.getImpliedNodeFormatForEmit(file);
    const moduleKind = getEmitModuleKind(c.compilerOptions);
    // In Node.js, CommonJS modules always have a synthetic default when imported into ESM.
    if (
      usageMode === ModuleKind.ESNext &&
      targetMode === ModuleKind.CommonJS &&
      moduleKind >= ModuleKind.Node16 &&
      moduleKind <= ModuleKind.NodeNext
    )
      return true;
    // Two ES modules never have a synthetic default.
    if (usageMode === ModuleKind.ESNext && targetMode === ModuleKind.ESNext) return false;
  }
  if (file === undefined || file.isDeclarationFile) {
    // A syntactic default export or an `__esModule` marker rules it out.
    const defaultExport = resolveExportByName(c, moduleSymbol, InternalSymbolName.Default, undefined, true);
    if (defaultExport !== undefined && hasSyntacticDefault(defaultExport)) return false;
    return resolveExportByName(c, moduleSymbol, '__esModule', undefined, dontResolveAlias) === undefined;
  }
  // TypeScript files are emitted with `__esModule` unless they use `export =`.
  if (!isInJSFile(file)) return hasExportAssignmentSymbol(moduleSymbol);
  // JavaScript files without ES module syntax or an `__esModule` marker have one.
  return (
    (file.externalModuleIndicator === undefined || file.externalModuleIndicator === file) &&
    resolveExportByName(c, moduleSymbol, '__esModule', undefined, dontResolveAlias) === undefined
  );
}

function hasSyntacticDefault(symbol: Symbol): boolean {
  for (const d of symbol.declarations) if (isSyntacticDefault(d)) return true;
  return false;
}

function isSyntacticDefault(node: Node): boolean {
  return (
    (node.kind === SyntaxKind.ExportAssignment && !(node as ExportAssignment).isExportEquals) ||
    hasSyntacticModifier(node, ModifierFlags.Default) ||
    node.kind === SyntaxKind.ExportSpecifier ||
    node.kind === SyntaxKind.NamespaceExport
  );
}

function hasExportAssignmentSymbol(moduleSymbol: Symbol): boolean {
  return moduleSymbol.exports?.get(InternalSymbolName.ExportEquals) !== undefined;
}

function isShorthandAmbientModuleSymbol(symbol: Symbol | undefined): boolean {
  const d = symbol?.valueDeclaration;
  return d !== undefined && d.kind === SyntaxKind.ModuleDeclaration && (d as ModuleDeclaration).body === undefined;
}

// ---- Alias targets

/** The symbol an alias declaration refers to, without resolving further aliases. */
export function getTargetOfAliasDeclaration(c: Checker, node: Node | undefined): Symbol | undefined {
  if (node === undefined) return undefined;
  switch (node.kind) {
    case SyntaxKind.ImportEqualsDeclaration:
    case SyntaxKind.VariableDeclaration:
      return getTargetOfImportEqualsDeclaration(c, node);
    case SyntaxKind.ImportClause:
      return getTargetOfImportClause(c, node);
    case SyntaxKind.NamespaceImport:
      return getTargetOfNamespaceImport(c, node);
    case SyntaxKind.NamespaceExport:
      return getTargetOfNamespaceExport(c, node);
    case SyntaxKind.ImportSpecifier:
    case SyntaxKind.BindingElement:
      return getTargetOfImportSpecifier(c, node);
    case SyntaxKind.ExportSpecifier:
      return getTargetOfExportSpecifier(c, node, SymbolFlags.Value | SymbolFlags.Type | SymbolFlags.Namespace, true);
    case SyntaxKind.ExportAssignment:
      return withTypeOnlyMark(c, node, getTargetOfAliasLikeExpression(c, getExpression(node)!));
    case SyntaxKind.BinaryExpression:
      return withTypeOnlyMark(c, node, getTargetOfAliasLikeExpression(c, (node as BinaryExpression).right));
    case SyntaxKind.NamespaceExportDeclaration: {
      const resolved = resolveExternalModuleSymbol(c, getSymbol(node.parent!), true);
      markSymbolOfAliasDeclarationIfTypeOnly(c, node, undefined);
      return resolved;
    }
    case SyntaxKind.ShorthandPropertyAssignment:
      return resolveEntityName(
        c,
        getName(node)!,
        SymbolFlags.Value | SymbolFlags.Type | SymbolFlags.Namespace,
        true,
        true,
        undefined,
      );
    case SyntaxKind.PropertyAssignment:
      return getTargetOfAliasLikeExpression(c, getInitializer(node)!);
    case SyntaxKind.ElementAccessExpression:
    case SyntaxKind.PropertyAccessExpression: {
      const parent = node.parent;
      if (
        parent !== undefined &&
        parent.kind === SyntaxKind.BinaryExpression &&
        (parent as BinaryExpression).left === node &&
        (parent as BinaryExpression).operatorToken.kind === SyntaxKind.EqualsToken
      )
        return getTargetOfAliasLikeExpression(c, (parent as BinaryExpression).right);
      return undefined;
    }
  }
  return undefined;
}

function withTypeOnlyMark(c: Checker, node: Node, resolved: Symbol | undefined): Symbol | undefined {
  markSymbolOfAliasDeclarationIfTypeOnly(c, node, undefined);
  return resolved;
}

function getTargetOfImportEqualsDeclaration(c: Checker, node: Node): Symbol | undefined {
  if (node.kind === SyntaxKind.VariableDeclaration || isExternalModuleImportEquals(node)) {
    const moduleReference = isVariableDeclarationInitializedToRequire(node)
      ? (getInitializer(node) as CallExpression).arguments.nodes[0]!
      : getExpression((node as ImportEqualsDeclaration).moduleReference);
    const immediate = resolveExternalModuleName(c, node, moduleReference, false);
    const resolved = resolveExternalModuleSymbol(c, immediate, true);
    const moduleKind = getEmitModuleKind(c.compilerOptions);
    if (resolved !== undefined && moduleKind >= ModuleKind.Node20 && moduleKind <= ModuleKind.NodeNext) {
      const moduleExports = getExportOfModule(c, resolved, InternalSymbolName.ModuleExports, node, true);
      if (moduleExports !== undefined) return moduleExports;
    }
    markSymbolOfAliasDeclarationIfTypeOnly(c, node, undefined);
    return resolved;
  }
  const resolved = getSymbolOfPartOfRightHandSideOfImportEquals(c, (node as ImportEqualsDeclaration).moduleReference);
  checkAndReportErrorForResolvingImportAliasToTypeOnlySymbol(c, node as ImportEqualsDeclaration);
  return resolved;
}

function isExternalModuleImportEquals(node: Node): boolean {
  return (
    node.kind === SyntaxKind.ImportEqualsDeclaration &&
    (node as ImportEqualsDeclaration).moduleReference.kind === SyntaxKind.ExternalModuleReference
  );
}

/**
 * Resolves the entity name of `import a = b.c`: `b` alone or the left part of a longer name is a
 * namespace, the whole name any meaning.
 */
export function getSymbolOfPartOfRightHandSideOfImportEquals(c: Checker, entityName: Node): Symbol | undefined {
  if (
    entityName.kind === SyntaxKind.Identifier &&
    entityName.parent !== undefined &&
    entityName.parent.kind === SyntaxKind.QualifiedName &&
    (entityName.parent as QualifiedName).right === entityName
  )
    entityName = entityName.parent;
  if (entityName.kind === SyntaxKind.Identifier || entityName.parent!.kind === SyntaxKind.QualifiedName)
    return resolveEntityName(c, entityName, SymbolFlags.Namespace, false, true, undefined);
  return resolveEntityName(
    c,
    entityName,
    SymbolFlags.Value | SymbolFlags.Type | SymbolFlags.Namespace,
    false,
    true,
    undefined,
  );
}

function checkAndReportErrorForResolvingImportAliasToTypeOnlySymbol(c: Checker, node: ImportEqualsDeclaration): void {
  let name: Node = node.moduleReference;
  for (;;) {
    const typeOnlyDeclaration = getTypeOnlyDeclarationOfEntityName(c, name);
    if (typeOnlyDeclaration !== undefined) {
      const isExport =
        typeOnlyDeclaration.kind === SyntaxKind.ExportSpecifier ||
        typeOnlyDeclaration.kind === SyntaxKind.ExportDeclaration;
      const diagnostic = c.error(
        node.moduleReference,
        isExport
          ? Diagnostics.An_import_alias_cannot_reference_a_declaration_that_was_exported_using_export_type
          : Diagnostics.An_import_alias_cannot_reference_a_declaration_that_was_imported_using_import_type,
      );
      const typeOnlyName =
        typeOnlyDeclaration.kind === SyntaxKind.ExportDeclaration ? '*' : getText(getName(typeOnlyDeclaration)!);
      diagnostic.addRelatedInfo(
        createDiagnosticForNode(
          typeOnlyDeclaration,
          isExport ? Diagnostics.X_0_was_exported_here : Diagnostics.X_0_was_imported_here,
          [typeOnlyName],
        ),
      );
      return;
    }
    if (name.kind !== SyntaxKind.QualifiedName) return;
    name = (name as QualifiedName).left;
  }
}

function getTypeOnlyDeclarationOfEntityName(c: Checker, name: Node): Node | undefined {
  if (name.kind !== SyntaxKind.Identifier && name.kind !== SyntaxKind.QualifiedName) return undefined;
  const symbol = resolveEntityName(
    c,
    name,
    SymbolFlags.Value | SymbolFlags.Type | SymbolFlags.Namespace,
    true,
    true,
    undefined,
  );
  return symbol !== undefined ? getTypeOnlyAliasDeclaration(c, symbol) : undefined;
}

function getTargetOfImportClause(c: Checker, node: Node): Symbol | undefined {
  const moduleSymbol = resolveExternalModuleName(c, node, getModuleSpecifier(node.parent!), false);
  return moduleSymbol !== undefined ? getTargetOfModuleDefault(c, moduleSymbol, node, true) : undefined;
}

function getTargetOfModuleDefault(
  c: Checker,
  moduleSymbol: Symbol,
  node: Node,
  dontResolveAlias: boolean,
): Symbol | undefined {
  const file = getSourceFileDeclaration(moduleSymbol);
  const specifier = getModuleSpecifierForImportOrExport(node);
  const exportDefaultSymbol = isShorthandAmbientModuleSymbol(moduleSymbol)
    ? undefined
    : resolveExportByName(c, moduleSymbol, InternalSymbolName.Default, node, dontResolveAlias);
  if (specifier === undefined) return exportDefaultSymbol;
  const hasSyntheticDefault = canHaveSyntheticDefault(c, file, moduleSymbol, dontResolveAlias, specifier);
  if (exportDefaultSymbol === undefined && !hasSyntheticDefault) {
    if (node.kind === SyntaxKind.ImportClause) reportNonDefaultExport(c, moduleSymbol, node);
    else {
      const name =
        node.kind === SyntaxKind.ImportSpecifier || node.kind === SyntaxKind.ExportSpecifier
          ? getPropertyNameOrName(node)
          : getName(node)!;
      errorNoModuleMemberSymbol(c, moduleSymbol, moduleSymbol, node, name);
    }
  } else if (hasSyntheticDefault) {
    // A synthetic default overrides a real `default` member without an `__esModule` marker.
    const resolved =
      resolveExternalModuleSymbol(c, moduleSymbol, dontResolveAlias) ??
      resolveSymbolEx(c, moduleSymbol, dontResolveAlias);
    markSymbolOfAliasDeclarationIfTypeOnly(c, node, undefined);
    return resolved;
  }
  markSymbolOfAliasDeclarationIfTypeOnly(c, node, undefined);
  return exportDefaultSymbol;
}

function reportNonDefaultExport(c: Checker, moduleSymbol: Symbol, node: Node): void {
  const local = getSymbol(node)!;
  if (moduleSymbol.exports?.get(local.name) !== undefined) {
    c.error(
      node,
      Diagnostics.Module_0_has_no_default_export_Did_you_mean_to_use_import_1_from_0_instead,
      symbolToString(c, moduleSymbol),
      symbolToString(c, local),
    );
    return;
  }
  const diagnostic = c.error(
    getName(node),
    Diagnostics.Module_0_has_no_default_export,
    symbolToString(c, moduleSymbol),
  );
  const exportStar = moduleSymbol.exports?.get(InternalSymbolName.ExportStar);
  if (exportStar === undefined) return;
  for (const d of exportStar.declarations) {
    const specifier = getModuleSpecifier(d);
    if (d.kind !== SyntaxKind.ExportDeclaration || specifier === undefined) continue;
    const resolved = resolveExternalModuleName(c, d, specifier, false);
    if (resolved !== undefined && resolved.exports?.get(InternalSymbolName.Default) !== undefined) {
      diagnostic.addRelatedInfo(
        createDiagnosticForNode(d, Diagnostics.X_export_Asterisk_does_not_re_export_a_default, []),
      );
      return;
    }
  }
}

function resolveExportByName(
  c: Checker,
  moduleSymbol: Symbol,
  name: string,
  sourceNode: Node | undefined,
  dontResolveAlias: boolean,
): Symbol | undefined {
  const exportValue = moduleSymbol.exports?.get(InternalSymbolName.ExportEquals);
  const exportSymbol =
    exportValue !== undefined
      ? getPropertyOfTypeEx(c, getTypeOfSymbol(c, exportValue), name, true, false)
      : moduleSymbol.exports?.get(name);
  const resolved = exportSymbol !== undefined ? resolveSymbolEx(c, exportSymbol, dontResolveAlias) : undefined;
  markSymbolOfAliasDeclarationIfTypeOnly(c, sourceNode, undefined);
  return resolved;
}

function getTargetOfNamespaceImport(c: Checker, node: Node): Symbol | undefined {
  const moduleSpecifier = getModuleSpecifierForImportOrExport(node)!;
  const immediate = resolveExternalModuleName(c, node, moduleSpecifier, false);
  const resolved = resolveESModuleSymbol(c, immediate, node, moduleSpecifier);
  markSymbolOfAliasDeclarationIfTypeOnly(c, node, undefined);
  return resolved;
}

function getTargetOfNamespaceExport(c: Checker, node: Node): Symbol | undefined {
  const moduleSpecifier = getModuleSpecifierForImportOrExport(node);
  if (moduleSpecifier === undefined) return undefined;
  const immediate = resolveExternalModuleName(c, node, moduleSpecifier, false);
  const resolved = resolveESModuleSymbol(c, immediate, node, moduleSpecifier);
  markSymbolOfAliasDeclarationIfTypeOnly(c, node, undefined);
  return resolved;
}

function getTargetOfImportSpecifier(c: Checker, node: Node): Symbol | undefined {
  const name = getPropertyNameOrName(node);
  if (node.kind === SyntaxKind.ImportSpecifier && moduleExportNameIsDefault(name)) {
    const specifier = getModuleSpecifierForImportOrExport(node);
    if (specifier !== undefined) {
      const moduleSymbol = resolveExternalModuleName(c, node, specifier, false);
      if (moduleSymbol !== undefined) return getTargetOfModuleDefault(c, moduleSymbol, node, true);
    }
  }
  const root = node.kind === SyntaxKind.BindingElement ? getRootDeclaration(node) : node.parent!.parent!.parent!;
  const resolved = getExternalModuleMember(c, root, node, true);
  markSymbolOfAliasDeclarationIfTypeOnly(c, node, undefined);
  return resolved;
}

/** The export `specifier` names from the module of the import or export declaration `node`. */
export function getExternalModuleMember(
  c: Checker,
  node: Node,
  specifier: Node,
  dontResolveAlias: boolean,
): Symbol | undefined {
  const moduleSpecifier = isVariableDeclarationInitializedToRequire(node)
    ? (getInitializer(node) as CallExpression).arguments.nodes[0]!
    : getExternalModuleName(node);
  const moduleSymbol = resolveExternalModuleName(c, node, moduleSpecifier, false);
  const name =
    specifier.kind === SyntaxKind.PropertyAccessExpression ? getName(specifier)! : getPropertyNameOrName(specifier);
  if (name.kind !== SyntaxKind.Identifier && name.kind !== SyntaxKind.StringLiteral) return undefined;
  const nameText = getText(name);
  const targetSymbol =
    moduleSpecifier !== undefined ? resolveESModuleSymbol(c, moduleSymbol, specifier, moduleSpecifier) : undefined;
  // The empty string is a valid module export name.
  if (
    targetSymbol === undefined ||
    moduleSymbol === undefined ||
    (nameText === '' && name.kind !== SyntaxKind.StringLiteral)
  )
    return undefined;
  if (isShorthandAmbientModuleSymbol(moduleSymbol)) return moduleSymbol;
  // An `export =` module exports the members of its target's type.
  const exportEquals = hasExportAssignmentSymbol(moduleSymbol);
  let symbolFromVariable = exportEquals
    ? getPropertyOfTypeEx(c, getTypeOfSymbol(c, targetSymbol), nameText, true, false)
    : getPropertyOfVariable(c, targetSymbol, nameText);
  if (symbolFromVariable !== undefined) symbolFromVariable = resolveSymbolEx(c, symbolFromVariable, dontResolveAlias);
  // Types and namespaces of an `export =` module live on the module symbol.
  let symbolFromModule = getExportOfModule(
    c,
    exportEquals ? moduleSymbol : targetSymbol,
    nameText,
    specifier,
    dontResolveAlias,
  );
  if (
    symbolFromModule === undefined &&
    nameText === InternalSymbolName.Default &&
    canHaveSyntheticDefault(c, getSourceFileDeclaration(moduleSymbol), moduleSymbol, dontResolveAlias, moduleSpecifier!)
  )
    symbolFromModule =
      resolveExternalModuleSymbol(c, moduleSymbol, dontResolveAlias) ??
      resolveSymbolEx(c, moduleSymbol, dontResolveAlias);
  const symbol =
    symbolFromModule === undefined
      ? symbolFromVariable
      : symbolFromVariable === undefined
        ? symbolFromModule
        : combineValueAndTypeSymbols(c, symbolFromVariable, symbolFromModule);
  if (symbol === undefined) errorNoModuleMemberSymbol(c, moduleSymbol, targetSymbol, node, name);
  return symbol;
}

function getPropertyOfVariable(c: Checker, symbol: Symbol, name: string): Symbol | undefined {
  if ((symbol.flags & SymbolFlags.Variable) === 0) return undefined;
  const declaration = symbol.valueDeclaration;
  const typeAnnotation = declaration !== undefined ? getType(declaration) : undefined;
  if (typeAnnotation === undefined) return undefined;
  return resolveSymbol(c, getPropertyOfType(c, getTypeFromTypeNode(c, typeAnnotation), name));
}

/** A symbol with the value side of `valueSymbol` and the type and namespace sides of `typeSymbol`. */
function combineValueAndTypeSymbols(c: Checker, valueSymbol: Symbol, typeSymbol: Symbol): Symbol {
  if (valueSymbol === c.unknownSymbol && typeSymbol === c.unknownSymbol) return c.unknownSymbol;
  if ((typeSymbol.flags & SymbolFlags.Value) !== 0) return typeSymbol;
  if ((valueSymbol.flags & (SymbolFlags.Type | SymbolFlags.Namespace)) !== 0) return valueSymbol;
  const result = c.newSymbol(valueSymbol.flags | typeSymbol.flags, valueSymbol.name);
  const declarations = valueSymbol.declarations.slice();
  for (const d of typeSymbol.declarations) if (!declarations.includes(d)) declarations.push(d);
  result.declarations = declarations;
  result.parent = valueSymbol.parent ?? typeSymbol.parent;
  result.valueDeclaration = valueSymbol.valueDeclaration;
  if (typeSymbol.members !== undefined) result.members = new Map(typeSymbol.members);
  if (valueSymbol.exports !== undefined) result.exports = new Map(valueSymbol.exports);
  return result;
}

function getExportOfModule(
  c: Checker,
  symbol: Symbol,
  nameText: string,
  specifier: Node,
  dontResolveAlias: boolean,
): Symbol | undefined {
  if ((symbol.flags & SymbolFlags.Module) === 0) return undefined;
  const exportSymbol = getExportsOfSymbol(c, symbol).get(nameText);
  const resolved = exportSymbol !== undefined ? resolveSymbolEx(c, exportSymbol, dontResolveAlias) : undefined;
  const exportStarDeclaration = c.symbolLinks(symbol).typeOnlyExportStarMap?.get(nameText);
  markSymbolOfAliasDeclarationIfTypeOnly(c, specifier, exportStarDeclaration);
  return resolved;
}

function errorNoModuleMemberSymbol(
  c: Checker,
  moduleSymbol: Symbol,
  targetSymbol: Symbol,
  node: Node,
  name: Node,
): void {
  const moduleName = getFullyQualifiedName(c, moduleSymbol);
  const declarationName = declarationNameToString(getSourceFileOfNode(name), name);
  const suggestion =
    name.kind === SyntaxKind.Identifier
      ? getSpellingSuggestionForName(
          c,
          getText(name),
          Array.from(getExportsOfModule(c, targetSymbol).values()),
          SymbolFlags.ModuleMember,
        )
      : undefined;
  if (suggestion !== undefined) {
    const suggestionName = symbolToString(c, suggestion);
    const diagnostic = c.error(
      name,
      Diagnostics.X_0_has_no_exported_member_named_1_Did_you_mean_2,
      moduleName,
      declarationName,
      suggestionName,
    );
    if (suggestion.valueDeclaration !== undefined)
      diagnostic.addRelatedInfo(
        createDiagnosticForNode(suggestion.valueDeclaration, Diagnostics.X_0_is_declared_here, [suggestionName]),
      );
    return;
  }
  if (moduleSymbol.exports?.get(InternalSymbolName.Default) !== undefined) {
    c.error(
      name,
      Diagnostics.Module_0_has_no_exported_member_1_Did_you_mean_to_use_import_1_from_0_instead,
      moduleName,
      declarationName,
    );
    return;
  }
  reportNonExportedMember(c, name, declarationName, moduleSymbol, moduleName);
}

function reportNonExportedMember(
  c: Checker,
  name: Node,
  declarationName: string,
  moduleSymbol: Symbol,
  moduleName: string,
): void {
  const locals = moduleSymbol.valueDeclaration !== undefined ? getLocals(moduleSymbol.valueDeclaration) : undefined;
  const localSymbol = locals?.get(getText(name));
  if (localSymbol === undefined) {
    c.error(name, Diagnostics.Module_0_has_no_exported_member_1, moduleName, declarationName);
    return;
  }
  const exports = moduleSymbol.exports;
  const exportEquals = exports?.get(InternalSymbolName.ExportEquals);
  if (exportEquals !== undefined) {
    if (isSameReference(c, exportEquals, localSymbol))
      reportInvalidImportEqualsExportMember(c, name, declarationName, moduleName);
    else c.error(name, Diagnostics.Module_0_has_no_exported_member_1, moduleName, declarationName);
    return;
  }
  let exportedSymbol: Symbol | undefined;
  if (exports !== undefined)
    for (const s of exports.values())
      if (isSameReference(c, s, localSymbol)) {
        exportedSymbol = s;
        break;
      }
  const diagnostic =
    exportedSymbol !== undefined
      ? c.error(
          name,
          Diagnostics.Module_0_declares_1_locally_but_it_is_exported_as_2,
          moduleName,
          declarationName,
          symbolToString(c, exportedSymbol),
        )
      : c.error(name, Diagnostics.Module_0_declares_1_locally_but_it_is_not_exported, moduleName, declarationName);
  for (let i = 0; i < localSymbol.declarations.length; i++)
    diagnostic.addRelatedInfo(
      createDiagnosticForNode(
        localSymbol.declarations[i]!,
        i === 0 ? Diagnostics.X_0_is_declared_here : Diagnostics.X_and_here,
        [declarationName],
      ),
    );
}

function isSameReference(c: Checker, s1: Symbol, s2: Symbol): boolean {
  return (
    getMergedSymbol(c, resolveSymbol(c, getMergedSymbol(c, s1))!) ===
    getMergedSymbol(c, resolveSymbol(c, getMergedSymbol(c, s2))!)
  );
}

function reportInvalidImportEqualsExportMember(
  c: Checker,
  name: Node,
  declarationName: string,
  moduleName: string,
): void {
  if (getEmitModuleKind(c.compilerOptions) >= ModuleKind.ES2015)
    c.error(name, Diagnostics.X_0_can_only_be_imported_by_using_a_default_import, declarationName);
  else if (isInJSFile(name))
    c.error(
      name,
      Diagnostics.X_0_can_only_be_imported_by_using_a_require_call_or_by_using_a_default_import,
      declarationName,
    );
  else
    c.error(
      name,
      Diagnostics.X_0_can_only_be_imported_by_using_import_1_require_2_or_a_default_import,
      declarationName,
      declarationName,
      moduleName,
    );
}

export function getTargetOfExportSpecifier(
  c: Checker,
  node: Node,
  meaning: SymbolFlags,
  dontResolveAlias: boolean,
): Symbol | undefined {
  const name = getPropertyNameOrName(node);
  if (moduleExportNameIsDefault(name)) {
    const specifier = getModuleSpecifierForImportOrExport(node);
    if (specifier !== undefined) {
      const moduleSymbol = resolveExternalModuleName(c, node, specifier, false);
      if (moduleSymbol !== undefined) return getTargetOfModuleDefault(c, moduleSymbol, node, dontResolveAlias);
    }
  }
  const exportDeclaration = node.parent!.parent!;
  let resolved: Symbol | undefined;
  if ((exportDeclaration as ExportDeclaration).moduleSpecifier !== undefined)
    resolved = getExternalModuleMember(c, exportDeclaration, node, dontResolveAlias);
  else if (name.kind !== SyntaxKind.StringLiteral)
    resolved = resolveEntityName(c, name, meaning, false, dontResolveAlias, undefined);
  markSymbolOfAliasDeclarationIfTypeOnly(c, node, undefined);
  return resolved;
}

function getTargetOfAliasLikeExpression(c: Checker, expression: Node): Symbol | undefined {
  if (expression.kind === SyntaxKind.ClassExpression) return checkExpressionCached(c, expression).symbol;
  if (!isEntityNameOrEntityNameExpression(expression)) return undefined;
  const aliasLike = resolveEntityName(
    c,
    expression,
    SymbolFlags.Value | SymbolFlags.Type | SymbolFlags.Namespace,
    true,
    true,
    undefined,
  );
  if (aliasLike !== undefined) return aliasLike;
  checkExpressionCached(c, expression);
  return c.nodeLinks(expression).resolvedSymbol;
}

function isEntityNameOrEntityNameExpression(node: Node): boolean {
  if (node.kind === SyntaxKind.Identifier) return true;
  if (node.kind === SyntaxKind.QualifiedName) return true;
  if (node.kind === SyntaxKind.PropertyAccessExpression) {
    const name = getName(node);
    return (
      name !== undefined &&
      name.kind === SyntaxKind.Identifier &&
      isEntityNameOrEntityNameExpression(getExpression(node)!)
    );
  }
  return false;
}

function getPropertyNameOrName(node: Node): Node {
  return getPropertyName(node) ?? getName(node)!;
}

function getModuleSpecifierForImportOrExport(node: Node): Node | undefined {
  switch (node.kind) {
    case SyntaxKind.ImportClause:
      return getModuleSpecifierOfDeclaration(node.parent!);
    case SyntaxKind.ImportEqualsDeclaration: {
      const reference = (node as ImportEqualsDeclaration).moduleReference;
      return reference.kind === SyntaxKind.ExternalModuleReference ? getExpression(reference) : undefined;
    }
    case SyntaxKind.NamespaceImport:
      return getModuleSpecifierOfDeclaration(node.parent!.parent!);
    case SyntaxKind.ImportSpecifier:
      return getModuleSpecifierOfDeclaration(node.parent!.parent!.parent!);
    case SyntaxKind.NamespaceExport:
      return getModuleSpecifierOfDeclaration(node.parent!);
    case SyntaxKind.ExportSpecifier:
      return getModuleSpecifierOfDeclaration(node.parent!.parent!);
  }
  return undefined;
}

function getModuleSpecifierOfDeclaration(node: Node): Node | undefined {
  if (node.kind === SyntaxKind.ExportDeclaration) return (node as ExportDeclaration).moduleSpecifier;
  return getModuleSpecifier(node);
}

// ---- Type-only aliases

/** Whether the declaration itself is written `import type` or `export type`. */
export function isTypeOnlyImportOrExportDeclaration(node: Node): boolean {
  switch (node.kind) {
    case SyntaxKind.ImportSpecifier:
      return getIsTypeOnly(node) || isTypeOnlyImportClause(node.parent!.parent!);
    case SyntaxKind.NamespaceImport:
      return isTypeOnlyImportClause(node.parent!);
    case SyntaxKind.ImportClause:
      return isTypeOnlyImportClause(node);
    case SyntaxKind.ImportEqualsDeclaration:
      return getIsTypeOnly(node);
    case SyntaxKind.ExportSpecifier:
      return getIsTypeOnly(node) || getIsTypeOnly(node.parent!.parent!);
    case SyntaxKind.ExportDeclaration: {
      const declaration = node as ExportDeclaration;
      return (
        declaration.isTypeOnly && declaration.moduleSpecifier !== undefined && declaration.exportClause === undefined
      );
    }
    case SyntaxKind.NamespaceExport:
      return getIsTypeOnly(node.parent!);
  }
  return false;
}

function isTypeOnlyImportClause(node: Node): boolean {
  return node.kind === SyntaxKind.ImportClause && (node as ImportClause).phaseModifier === SyntaxKind.TypeKeyword;
}

/**
 * Marks an alias declared `import type`/`export type`, or reached through a type-only `export *`,
 * as type-only; returns whether it is.
 */
function markSymbolOfAliasDeclarationIfTypeOnly(
  c: Checker,
  aliasDeclaration: Node | undefined,
  exportStarDeclaration: Node | undefined,
): boolean {
  if (aliasDeclaration === undefined) return false;
  const sourceSymbol = getSymbol(aliasDeclaration);
  if (sourceSymbol === undefined) return false;
  const links = c.symbolLinks(getMergedSymbol(c, sourceSymbol));
  if (links.typeOnlyDeclaration === undefined && isTypeOnlyImportOrExportDeclaration(aliasDeclaration)) {
    links.typeOnlyDeclaration = aliasDeclaration;
    return true;
  }
  if (links.typeOnlyDeclaration === undefined && exportStarDeclaration !== undefined) {
    links.typeOnlyDeclaration = exportStarDeclaration;
    return true;
  }
  return links.typeOnlyDeclaration !== undefined;
}

/** Marks the alias declaration an entity name is part of, if it is type-only. */
export function markAliasDeclarationOfNameIfTypeOnly(c: Checker, name: Node): void {
  let current = name;
  while (current.parent !== undefined && current.parent.kind === SyntaxKind.QualifiedName) current = current.parent;
  const parent = current.parent;
  if (parent === undefined) return;
  switch (parent.kind) {
    case SyntaxKind.ImportClause:
    case SyntaxKind.ImportSpecifier:
    case SyntaxKind.NamespaceImport:
    case SyntaxKind.ExportSpecifier:
    case SyntaxKind.ExportAssignment:
    case SyntaxKind.ImportEqualsDeclaration:
    case SyntaxKind.NamespaceExport:
      markSymbolOfAliasDeclarationIfTypeOnly(c, parent, undefined);
  }
}

/** Resolves an alias whose target is an alias, carrying over the target's type-only declaration. */
export function resolveIndirectionAlias(c: Checker, source: Symbol, target: Symbol): Symbol {
  const result = getMergedSymbol(c, resolveAlias(c, target));
  const targetDeclaration = c.symbolLinks(target).typeOnlyDeclaration;
  if (targetDeclaration !== undefined) {
    const sourceLinks = c.symbolLinks(source);
    if (sourceLinks.typeOnlyDeclaration === undefined) sourceLinks.typeOnlyDeclaration = targetDeclaration;
  }
  return result;
}

export function getTypeOnlyAliasDeclaration(c: Checker, symbol: Symbol): Node | undefined {
  if ((symbol.flags & SymbolFlags.Alias) === 0) return undefined;
  resolveAlias(c, symbol);
  return c.symbolLinks(symbol).typeOnlyDeclaration;
}

/** The first type-only declaration along the alias chain of `symbol` before one with `meaning`. */
export function getTypeOnlyAliasDeclarationOfMeaning(
  c: Checker,
  symbol: Symbol,
  meaning: SymbolFlags,
): Node | undefined {
  while ((symbol.flags & SymbolFlags.Alias) !== 0 && (symbol.flags & meaning) === 0) {
    const resolved = resolveAlias(c, symbol);
    const declaration = c.symbolLinks(symbol).typeOnlyDeclaration;
    if (declaration !== undefined) return declaration;
    symbol = resolved;
  }
  return undefined;
}

function addTypeOnlyDeclarationRelatedInfo(
  diagnostic: Diagnostic,
  typeOnlyDeclaration: Node | undefined,
  name: string,
): void {
  if (typeOnlyDeclaration === undefined) return;
  const isExport =
    typeOnlyDeclaration.kind === SyntaxKind.ExportSpecifier ||
    typeOnlyDeclaration.kind === SyntaxKind.ExportDeclaration ||
    typeOnlyDeclaration.kind === SyntaxKind.NamespaceExport;
  diagnostic.addRelatedInfo(
    createDiagnosticForNode(
      typeOnlyDeclaration,
      isExport ? Diagnostics.X_0_was_exported_here : Diagnostics.X_0_was_imported_here,
      [name],
    ),
  );
}

/** Reports a value use of a name that only resolves to a value through a type-only import or export. */
export function checkTypeOnlyAliasUse(c: Checker, location: Node, result: Symbol, name: string): void {
  if (
    (result.flags & SymbolFlags.Alias) === 0 ||
    (result.flags & SymbolFlags.Value) !== 0 ||
    isValidTypeOnlyAliasUseSite(location)
  )
    return;
  const typeOnlyDeclaration = getTypeOnlyAliasDeclarationOfMeaning(c, result, SymbolFlags.Value);
  if (typeOnlyDeclaration === undefined) return;
  const isExport =
    typeOnlyDeclaration.kind === SyntaxKind.ExportSpecifier ||
    typeOnlyDeclaration.kind === SyntaxKind.ExportDeclaration ||
    typeOnlyDeclaration.kind === SyntaxKind.NamespaceExport;
  const diagnostic = c.error(
    location,
    isExport
      ? Diagnostics.X_0_cannot_be_used_as_a_value_because_it_was_exported_using_export_type
      : Diagnostics.X_0_cannot_be_used_as_a_value_because_it_was_imported_using_import_type,
    name,
  );
  addTypeOnlyDeclarationRelatedInfo(diagnostic, typeOnlyDeclaration, name);
}

function isValidTypeOnlyAliasUseSite(useSite: Node): boolean {
  return (
    (useSite.flags & (NodeFlags.Ambient | NodeFlags.JSDoc)) !== 0 ||
    isPartOfTypeQuery(useSite) ||
    isIdentifierInNonEmittingHeritageClause(useSite) ||
    isPartOfPossiblyValidTypeOrAbstractComputedPropertyName(useSite) ||
    !(isExpressionNode(useSite) || isShorthandPropertyNameUseSite(useSite))
  );
}

function isIdentifierInNonEmittingHeritageClause(node: Node): boolean {
  if (node.kind !== SyntaxKind.Identifier) return false;
  let parent = node.parent!;
  while (parent.kind === SyntaxKind.PropertyAccessExpression || parent.kind === SyntaxKind.ExpressionWithTypeArguments)
    parent = parent.parent!;
  return (
    parent.kind === SyntaxKind.HeritageClause &&
    ((parent as HeritageClause).token === SyntaxKind.ImplementsKeyword ||
      parent.parent!.kind === SyntaxKind.InterfaceDeclaration)
  );
}

function isPartOfPossiblyValidTypeOrAbstractComputedPropertyName(node: Node): boolean {
  let current = node;
  while (current.kind === SyntaxKind.Identifier || current.kind === SyntaxKind.PropertyAccessExpression)
    current = current.parent!;
  if (current.kind !== SyntaxKind.ComputedPropertyName) return false;
  if (hasSyntacticModifier(current.parent!, ModifierFlags.Abstract)) return true;
  const container = current.parent!.parent!.kind;
  return container === SyntaxKind.InterfaceDeclaration || container === SyntaxKind.TypeLiteral;
}

function isShorthandPropertyNameUseSite(useSite: Node): boolean {
  return (
    useSite.kind === SyntaxKind.Identifier &&
    useSite.parent!.kind === SyntaxKind.ShorthandPropertyAssignment &&
    getName(useSite.parent!) === useSite
  );
}

// ---- Referenced aliases

/** Marks the aliases an identifier in an expression uses as referenced. */
export function markIdentifierAliasReferencedInExpression(c: Checker, node: Node): void {
  if ((node.flags & NodeFlags.Ambient) !== 0 || !shouldMarkIdentifierAliasReferenced(node)) return;
  markIdentifierAliasReferenced(c, node);
}

/** Resolves the alias side of a referenced symbol, which may also be a local variable. */
export function resolveAliasOfReference(c: Checker, symbol: Symbol): void {
  if ((symbol.flags & SymbolFlags.Alias) !== 0 && getDeclarationOfAliasSymbol(symbol) !== undefined)
    resolveAlias(c, symbol);
}

function shouldMarkIdentifierAliasReferenced(node: Node): boolean {
  const parent = node.parent;
  if (parent === undefined) return true;
  // The left of a property access is marked with the property.
  if (parent.kind === SyntaxKind.PropertyAccessExpression && getExpression(parent) === node) return false;
  // Names of type-only exports aren't emitted.
  if (parent.kind === SyntaxKind.ExportSpecifier && getIsTypeOnly(parent)) return false;
  const greatGrandparent = parent.parent?.parent;
  return !(
    greatGrandparent !== undefined &&
    greatGrandparent.kind === SyntaxKind.ExportDeclaration &&
    getIsTypeOnly(greatGrandparent)
  );
}

/**
 * Marks the alias on the left of a property access as referenced, unless the access reads a const
 * enum (or a module of only const enums) that is inlined.
 */
export function markPropertyAliasReferenced(
  c: Checker,
  location: Node,
  prop: Symbol | undefined,
  leftType: Type,
): void {
  if ((location.flags & NodeFlags.Ambient) !== 0 || isPartOfImportEqualsModuleReference(location)) return;
  const left =
    location.kind === SyntaxKind.PropertyAccessExpression ? getExpression(location)! : (location as QualifiedName).left;
  if (left.kind !== SyntaxKind.Identifier || getText(left) === 'this') return;
  const parentSymbol = getResolvedSymbol(c, left);
  if (parentSymbol === c.unknownSymbol) return;
  if (
    c.isolatedModules ||
    (c.preserveConstEnums && isExportOrExportExpression(location)) ||
    (leftType.flags & TypeFlags.Any) !== 0 ||
    leftType === c.silentNeverType
  ) {
    markAliasReferenced(c, parentSymbol, location);
    return;
  }
  if (
    prop !== undefined &&
    (isConstEnumOrConstEnumOnlyModule(prop) ||
      ((prop.flags & SymbolFlags.EnumMember) !== 0 && location.parent!.kind === SyntaxKind.EnumMember))
  )
    return;
  markAliasReferenced(c, parentSymbol, location);
}

function isPartOfImportEqualsModuleReference(location: Node): boolean {
  let importEquals: Node | undefined = location;
  while (importEquals !== undefined && importEquals.kind !== SyntaxKind.ImportEqualsDeclaration)
    importEquals = importEquals.parent;
  if (importEquals === undefined) return false;
  const reference = (importEquals as ImportEqualsDeclaration).moduleReference;
  for (let node: Node | undefined = location; node !== undefined && node !== importEquals; node = node.parent)
    if (node === reference) return true;
  return false;
}

function markIdentifierAliasReferenced(c: Checker, location: Node): void {
  const symbol = getResolvedSymbol(c, location);
  if (symbol !== c.argumentsSymbol && symbol !== c.unknownSymbol) markAliasReferenced(c, symbol, location);
}

function markAliasReferenced(c: Checker, symbol: Symbol, location: Node): void {
  if (!isNonLocalAlias(symbol, SymbolFlags.Value) || isPartOfTypeQuery(location)) return;
  const target = resolveAlias(c, symbol);
  if ((getSymbolFlagsExcludingTypeOnly(c, symbol) & (SymbolFlags.Value | SymbolFlags.ExportValue)) === 0) return;
  // An alias of a const enum can be elided unless the enum is kept.
  if (
    c.isolatedModules ||
    (c.preserveConstEnums && isExportOrExportExpression(location)) ||
    !isConstEnumOrConstEnumOnlyModule(getExportSymbolOfValueSymbolIfExported(c, target))
  )
    markAliasSymbolAsReferenced(c, symbol);
}

/**
 * Marks an alias as referenced; an `import a = b.c` whose target is a value then references `b`,
 * resolving it as a value.
 */
function markAliasSymbolAsReferenced(c: Checker, symbol: Symbol): void {
  const links = c.symbolLinks(symbol);
  if (links.aliasReferenced) return;
  links.aliasReferenced = true;
  const node = getDeclarationOfAliasSymbol(symbol);
  if (
    node !== undefined &&
    node.kind === SyntaxKind.ImportEqualsDeclaration &&
    (node as ImportEqualsDeclaration).moduleReference.kind !== SyntaxKind.ExternalModuleReference &&
    (getSymbolFlags(c, resolveSymbol(c, symbol)!) & SymbolFlags.Value) !== 0
  )
    markIdentifierAliasReferenced(c, getFirstIdentifierOfEntityName((node as ImportEqualsDeclaration).moduleReference));
}

function markExportAsReferenced(c: Checker, node: Node): void {
  const symbol = getSymbolOfDeclaration(c, node);
  if (symbol === undefined) return;
  const target = resolveAlias(c, symbol);
  if (
    target === c.unknownSymbol ||
    ((getSymbolFlagsExcludingTypeOnly(c, symbol) & SymbolFlags.Value) !== 0 &&
      !isConstEnumOrConstEnumOnlyModule(target))
  )
    markAliasSymbolAsReferenced(c, symbol);
}

function markExportSpecifierAliasReferenced(
  c: Checker,
  node: Node,
  symbol: Symbol | undefined,
  exportedName: Node,
): void {
  if ((node.flags & NodeFlags.Ambient) !== 0 || getIsTypeOnly(node) || getIsTypeOnly(node.parent!.parent!)) return;
  let target = symbol;
  if (target !== undefined && (target.flags & SymbolFlags.Alias) !== 0) target = resolveAlias(c, target);
  if (target === undefined || (getSymbolFlags(c, target) & SymbolFlags.Value) !== 0) {
    markExportAsReferenced(c, node);
    markIdentifierAliasReferenced(c, exportedName);
  }
}

function isConstEnumOrConstEnumOnlyModule(symbol: Symbol): boolean {
  return (symbol.flags & (SymbolFlags.ConstEnum | SymbolFlags.ConstEnumOnlyModule)) !== 0;
}

function isExportOrExportExpression(location: Node): boolean {
  for (let n: Node | undefined = location; n !== undefined; n = n.parent) {
    const parent = n.parent;
    if (parent === undefined) return false;
    if (parent.kind === SyntaxKind.ExportAssignment)
      return (
        getExpression(parent) === n && isEntityNameOrEntityNameExpression(n) && n.kind !== SyntaxKind.QualifiedName
      );
    if (parent.kind === SyntaxKind.ExportSpecifier) {
      if (getName(parent) === n || getPropertyName(parent) === n) return true;
    }
  }
  return false;
}

/** `getSymbolFlags`, stopping at the first type-only alias along the chain. */
function getSymbolFlagsExcludingTypeOnly(c: Checker, symbol: Symbol): SymbolFlags {
  return getSymbolFlagsEx(c, symbol, true, false);
}

/** `getSymbolFlags`, optionally stopping at type-only aliases or leaving out the symbol's own flags. */
function getSymbolFlagsEx(
  c: Checker,
  symbol: Symbol,
  excludeTypeOnlyMeanings: boolean,
  excludeLocalMeanings: boolean,
): SymbolFlags {
  const seen = new Set<Symbol>();
  let flags = excludeLocalMeanings ? SymbolFlags.None : symbol.flags;
  while ((symbol.flags & SymbolFlags.Alias) !== 0) {
    if (excludeTypeOnlyMeanings && getTypeOnlyAliasDeclaration(c, symbol) !== undefined) break;
    const target = getExportSymbolOfValueSymbolIfExported(c, resolveAlias(c, symbol));
    if (target === c.unknownSymbol) return SymbolFlags.All;
    if ((target.flags & SymbolFlags.Alias) !== 0) {
      if (target === symbol || seen.has(target)) break;
      seen.add(symbol);
      seen.add(target);
    }
    flags |= target.flags;
    symbol = target;
  }
  return flags;
}

// ---- Module exports

/** Own exports plus those re-exported with `export *`; own exports shadow re-exported ones. */
export function getExportsOfModuleWorker(c: Checker, moduleSymbol: Symbol): SymbolTable {
  const collector = new ExportCollector(c);
  const exportEquals = moduleSymbol.exports?.get(InternalSymbolName.ExportEquals);
  const originalModule =
    exportEquals !== undefined && resolveSymbolEx(c, exportEquals, false) !== undefined ? moduleSymbol : undefined;
  const resolvedModule = resolveExternalModuleSymbol(c, moduleSymbol, false);
  const exports = collector.visit(resolvedModule, undefined, false) ?? new Map<string, Symbol>();
  // A CommonJS module with `export =` may also export types, stored on the original module.
  if (originalModule !== undefined && originalModule.exports !== undefined && originalModule.exports.size > 1) {
    for (const symbol of originalModule.exports.values()) {
      if (symbol.name === InternalSymbolName.ExportEquals || symbol.name === InternalSymbolName.ExportStar) continue;
      const flags = getSymbolFlags(c, symbol);
      if (
        (flags & (SymbolFlags.Type | SymbolFlags.Namespace)) !== 0 &&
        (flags & SymbolFlags.Value) === 0 &&
        !exports.has(symbol.name)
      )
        exports.set(symbol.name, symbol);
    }
  }
  const typeOnlyExportStarMap = collector.typeOnlyExportStarMap;
  if (typeOnlyExportStarMap !== undefined) {
    for (const name of collector.nonTypeOnlyNames) typeOnlyExportStarMap.delete(name);
    c.symbolLinks(moduleSymbol).typeOnlyExportStarMap = typeOnlyExportStarMap;
  }
  return exports;
}

/** A name re-exported by several `export *` declarations. */
class ExportCollision {
  readonly specifierText: string;
  readonly exportsWithDuplicate: Node[] = [];

  constructor(specifierText: string) {
    this.specifierText = specifierText;
  }
}

class ExportCollector {
  readonly c: Checker;
  readonly visited: Symbol[] = [];
  readonly nonTypeOnlyNames = new Set<string>();
  typeOnlyExportStarMap: Map<string, Node> | undefined = undefined;

  constructor(c: Checker) {
    this.c = c;
  }

  // Modules may re-export each other circularly.
  visit(symbol: Symbol | undefined, exportStar: Node | undefined, isTypeOnly: boolean): SymbolTable | undefined {
    if (!isTypeOnly && symbol !== undefined && symbol.exports !== undefined)
      // Added before the visited check: `export *` overrides an earlier `export type *` of the same module.
      for (const name of symbol.exports.keys()) this.nonTypeOnlyNames.add(name);
    if (symbol === undefined || symbol.exports === undefined || this.visited.includes(symbol)) return undefined;
    this.visited.push(symbol);
    const symbols: SymbolTable = new Map(symbol.exports);
    const exportStars = symbol.exports.get(InternalSymbolName.ExportStar);
    if (exportStars !== undefined) {
      const nested: SymbolTable = new Map<string, Symbol>();
      const lookupTable = new Map<string, ExportCollision>();
      for (const node of exportStars.declarations) {
        const specifier = (node as ExportDeclaration).moduleSpecifier;
        const resolved = resolveExternalModuleName(this.c, node, specifier, false);
        const exported = this.visit(resolved, node, isTypeOnly || getIsTypeOnly(node));
        this.extendExportSymbols(nested, exported, lookupTable, node);
      }
      for (const [id, collision] of lookupTable) {
        // A module that exports the name itself resolves the ambiguity.
        if (id === InternalSymbolName.ExportEquals || collision.exportsWithDuplicate.length === 0 || symbols.has(id))
          continue;
        for (const node of collision.exportsWithDuplicate)
          this.c.error(
            node,
            Diagnostics.Module_0_has_already_exported_a_member_named_1_Consider_explicitly_re_exporting_to_resolve_the_ambiguity,
            collision.specifierText,
            id,
          );
      }
      this.extendExportSymbols(symbols, nested, undefined, undefined);
    }
    if (exportStar !== undefined && getIsTypeOnly(exportStar)) {
      if (this.typeOnlyExportStarMap === undefined) this.typeOnlyExportStarMap = new Map<string, Node>();
      for (const name of symbols.keys()) this.typeOnlyExportStarMap.set(name, exportStar);
    }
    return symbols;
  }

  extendExportSymbols(
    target: SymbolTable,
    source: SymbolTable | undefined,
    lookupTable: Map<string, ExportCollision> | undefined,
    exportNode: Node | undefined,
  ): void {
    if (source === undefined) return;
    for (const [id, sourceSymbol] of source) {
      if (id === InternalSymbolName.Default) continue;
      const targetSymbol = target.get(id);
      if (targetSymbol === undefined) {
        target.set(id, sourceSymbol);
        if (lookupTable !== undefined && exportNode !== undefined) {
          const specifier = (exportNode as ExportDeclaration).moduleSpecifier!;
          lookupTable.set(id, new ExportCollision(getSourceTextOfNode(getSourceFileOfNode(specifier), specifier)));
        }
      } else if (
        lookupTable !== undefined &&
        exportNode !== undefined &&
        resolveSymbol(this.c, targetSymbol) !== resolveSymbol(this.c, sourceSymbol)
      )
        lookupTable.get(id)?.exportsWithDuplicate.push(exportNode);
    }
  }
}

// ---- Import types and dynamic imports

/** The type of `import("m")`, `import("m").T` or `typeof import("m").v`. */
export function getTypeFromImportTypeNode(c: Checker, node: Node): Type {
  const links = c.nodeLinks(node);
  if (links.resolvedType !== undefined) return links.resolvedType;
  const importType = node as ImportTypeNode;
  if (!isLiteralImportTypeNode(node)) {
    c.error(importType.argument, Diagnostics.String_literal_expected);
    links.resolvedSymbol = c.unknownSymbol;
    links.resolvedType = c.errorType;
    return links.resolvedType;
  }
  const targetMeaning = importType.isTypeOf ? SymbolFlags.Value : SymbolFlags.Type;
  const literal = (importType.argument as LiteralTypeNode).literal;
  const innerModuleSymbol = resolveExternalModuleName(c, node, literal, false);
  if (innerModuleSymbol === undefined) {
    links.resolvedSymbol = c.unknownSymbol;
    links.resolvedType = c.errorType;
    return links.resolvedType;
  }
  const moduleSymbol = resolveExternalModuleSymbol(c, innerModuleSymbol, false)!;
  const qualifier = importType.qualifier;
  if (qualifier !== undefined && !nodeIsMissing(qualifier)) {
    const nameChain = getIdentifierChain(qualifier);
    let currentNamespace = moduleSymbol;
    for (let i = 0; i < nameChain.length; i++) {
      const current = nameChain[i]!;
      const meaning = i === nameChain.length - 1 ? targetMeaning : SymbolFlags.Namespace;
      const merged = getMergedSymbol(c, resolveSymbol(c, currentNamespace)!);
      const text = getText(current);
      const next = importType.isTypeOf
        ? getPropertyOfTypeEx(c, getTypeOfSymbol(c, merged), text, false, true)
        : getSymbolOfMeaning(c, getExportsOfSymbol(c, merged), text, meaning);
      if (next === undefined) {
        c.error(
          current,
          Diagnostics.Namespace_0_has_no_exported_member_1,
          getFullyQualifiedName(c, currentNamespace),
          declarationNameToString(getSourceFileOfNode(current), current),
        );
        links.resolvedType = c.errorType;
        return links.resolvedType;
      }
      c.nodeLinks(current).resolvedSymbol = next;
      c.nodeLinks(current.parent!).resolvedSymbol = next;
      currentNamespace = next;
    }
    links.resolvedType = resolveImportSymbolType(c, node, currentNamespace, targetMeaning);
  } else if ((getSymbolFlags(c, moduleSymbol) & targetMeaning) !== 0) {
    links.resolvedType = resolveImportSymbolType(c, node, moduleSymbol, targetMeaning);
  } else {
    c.error(
      node,
      targetMeaning === SymbolFlags.Value
        ? Diagnostics.Module_0_does_not_refer_to_a_value_but_is_used_as_a_value_here
        : Diagnostics.Module_0_does_not_refer_to_a_type_but_is_used_as_a_type_here_Did_you_mean_typeof_import_0,
      getText(literal),
    );
    links.resolvedSymbol = c.unknownSymbol;
    links.resolvedType = c.errorType;
  }
  return links.resolvedType;
}

function getIdentifierChain(node: Node): Identifier[] {
  if (node.kind === SyntaxKind.Identifier) return [node as Identifier];
  const chain = getIdentifierChain((node as QualifiedName).left);
  chain.push((node as QualifiedName).right);
  return chain;
}

function resolveImportSymbolType(c: Checker, node: Node, symbol: Symbol, meaning: SymbolFlags): Type {
  const resolvedSymbol = resolveSymbol(c, symbol)!;
  c.nodeLinks(node).resolvedSymbol = resolvedSymbol;
  // The alias itself caches the type of a value.
  if (meaning === SymbolFlags.Value) return getTypeOfSymbol(c, symbol);
  return getTypeReferenceType(c, node, resolvedSymbol);
}

/** `import(specifier, options)`: a promise of the module namespace. */
export function checkImportCallExpression(c: Checker, node: Node): Type {
  const args = (node as CallExpression).arguments.nodes;
  if (args.length === 0) return createPromiseReturnType(c, node, c.anyType);
  const specifier = args[0]!;
  const specifierType = checkExpressionCached(c, specifier);
  const optionsType = args.length > 1 ? checkExpressionCached(c, args[1]!) : undefined;
  // Extra arguments are a grammar error; check them for completions.
  for (let i = 2; i < args.length; i++) checkExpressionCached(c, args[i]!);
  if ((specifierType.flags & TypeFlags.Nullable) !== 0 || !isTypeAssignableTo(c, specifierType, c.stringType))
    c.error(
      specifier,
      Diagnostics.Dynamic_import_s_specifier_must_be_of_type_string_but_here_has_type_0,
      typeToString(c, specifierType),
    );
  if (optionsType !== undefined) {
    const importCallOptionsType = getCachedGlobalType(c, 'ImportCallOptions', 0, true);
    if (importCallOptionsType !== c.emptyObjectType)
      checkTypeAssignableTo(
        c,
        optionsType,
        getNullableType(c, importCallOptionsType, TypeFlags.Undefined),
        args[1]!,
        undefined,
      );
    if (args[1]!.kind === SyntaxKind.ObjectLiteralExpression)
      for (const property of (args[1]! as ObjectLiteralExpression).properties.nodes) {
        const name = getName(property);
        if (
          property.kind === SyntaxKind.PropertyAssignment &&
          name !== undefined &&
          name.kind === SyntaxKind.Identifier &&
          getText(name) === 'assert'
        ) {
          c.error(
            name,
            Diagnostics.Import_assertions_have_been_replaced_by_import_attributes_Use_with_instead_of_assert,
          );
          break;
        }
      }
  }
  const moduleSymbol = resolveExternalModuleName(c, node, specifier, false);
  if (moduleSymbol !== undefined) {
    const esModuleSymbol = resolveExternalModuleSymbol(c, moduleSymbol, true);
    if (esModuleSymbol !== undefined)
      return createPromiseReturnType(
        c,
        node,
        getTypeWithSyntheticDefaultImportType(
          c,
          getTypeOfSymbol(c, esModuleSymbol),
          esModuleSymbol,
          moduleSymbol,
          specifier,
        ),
      );
  }
  return createPromiseReturnType(c, node, c.anyType);
}

function createPromiseReturnType(c: Checker, node: Node, promisedType: Type): Type {
  const promiseType = createPromiseType(c, promisedType);
  if (promiseType !== c.unknownType) return promiseType;
  c.error(
    node,
    Diagnostics.A_dynamic_import_call_returns_a_Promise_Make_sure_you_have_a_declaration_for_Promise_or_include_ES2015_in_your_lib_option,
  );
  return c.errorType;
}

// ---- JSDoc links

/** The symbol a `{@link}` name refers to, as an entity or a member of one. */
export function resolveJSDocMemberName(c: Checker, name: Node | undefined): Symbol | undefined {
  if (name === undefined || (name.kind !== SyntaxKind.Identifier && name.kind !== SyntaxKind.QualifiedName))
    return undefined;
  const meaning = SymbolFlags.Type | SymbolFlags.Namespace | SymbolFlags.Value;
  const symbol = resolveEntityName(c, name, meaning, true, true, getHostSignatureFromJSDoc(name));
  if (symbol !== undefined) return symbol;
  if (name.kind !== SyntaxKind.QualifiedName) return undefined;
  const left = resolveJSDocMemberName(c, (name as QualifiedName).left);
  if (left === undefined) return undefined;
  let type: Type | undefined;
  if ((left.flags & SymbolFlags.Value) !== 0) {
    const prototype = getPropertyOfType(c, getTypeOfSymbol(c, left), 'prototype');
    if (prototype !== undefined) type = getTypeOfSymbol(c, prototype);
  }
  return getPropertyOfType(c, type ?? getDeclaredTypeOfSymbol(c, left), (name as QualifiedName).right.text);
}

export function getHostSignatureFromJSDoc(node: Node): Node | undefined {
  let current: Node | undefined = node;
  while (current !== undefined && current.kind !== SyntaxKind.JSDoc) current = current.parent;
  const host = current?.parent;
  return host !== undefined && isFunctionLike(host) ? host : undefined;
}

// ---- Meta properties

/** `import.meta` and `new.target`. */
export function checkMetaProperty(c: Checker, node: Node): Type {
  const meta = node as MetaProperty;
  if (meta.keywordToken === SyntaxKind.NewKeyword) return checkNewTargetMetaProperty(c, node);
  // `import.defer` is only valid as a callee.
  if (meta.name.text === 'defer') return c.errorType;
  const moduleKind = getEmitModuleKind(c.compilerOptions);
  if (moduleKind >= ModuleKind.Node16 && moduleKind <= ModuleKind.NodeNext) {
    if (c.host.getImpliedNodeFormatForEmit(getSourceFileOfNode(node)) === ModuleKind.CommonJS)
      c.error(
        node,
        Diagnostics.The_import_meta_meta_property_is_not_allowed_in_files_which_will_build_into_CommonJS_output,
      );
  } else if (moduleKind < ModuleKind.ES2020 && moduleKind !== ModuleKind.System)
    c.error(
      node,
      Diagnostics.The_import_meta_meta_property_is_only_allowed_when_the_module_option_is_es2020_es2022_esnext_system_node16_node18_node20_or_nodenext,
    );
  return meta.name.text === 'meta' ? getCachedGlobalType(c, 'ImportMeta', 0, true) : c.errorType;
}

export function checkNewTargetMetaProperty(c: Checker, node: Node): Type {
  const container = getThisContainer(node, false, false);
  if (
    container.kind !== SyntaxKind.Constructor &&
    container.kind !== SyntaxKind.FunctionDeclaration &&
    container.kind !== SyntaxKind.FunctionExpression
  ) {
    c.error(
      node,
      Diagnostics.Meta_property_0_is_only_allowed_in_the_body_of_a_function_declaration_function_expression_or_constructor,
      'new.target',
    );
    return c.errorType;
  }
  const symbol = getSymbolOfDeclaration(c, container.kind === SyntaxKind.Constructor ? container.parent! : container);
  return symbol !== undefined ? getTypeOfSymbol(c, symbol) : c.errorType;
}

// ---- Import and export declarations

/**
 * Whether an import or export with a module specifier is in a valid place with a valid specifier;
 * the grammar checker reports the errors.
 */
function isValidExternalImportOrExportDeclaration(node: Node): boolean {
  const moduleName = getExternalModuleName(node);
  if (moduleName === undefined || nodeIsMissing(moduleName) || moduleName.kind !== SyntaxKind.StringLiteral)
    return false;
  const parent = node.parent!;
  const inAmbientExternalModule = parent.kind === SyntaxKind.ModuleBlock && isAmbientModule(parent.parent!);
  if (parent.kind !== SyntaxKind.SourceFile && !inAmbientExternalModule) return false;
  if (
    inAmbientExternalModule &&
    isExternalModuleNameRelative(getText(moduleName)) &&
    !isModuleAugmentationExternal(parent.parent!)
  )
    return false;
  if (node.kind === SyntaxKind.ImportEqualsDeclaration) return true;
  const attributes = getImportAttributes(node);
  if (attributes === undefined) return true;
  for (const attribute of attributes.attributes.nodes)
    if ((attribute as ImportAttribute).value.kind !== SyntaxKind.StringLiteral) return false;
  return true;
}

function isInModuleElementContext(node: Node): boolean {
  const parent = node.parent!.kind;
  return (
    parent === SyntaxKind.SourceFile || parent === SyntaxKind.ModuleBlock || parent === SyntaxKind.ModuleDeclaration
  );
}

function getImportAttributes(node: Node): ImportAttributes | undefined {
  if (node.kind === SyntaxKind.ImportDeclaration || node.kind === SyntaxKind.JSImportDeclaration)
    return (node as ImportDeclaration).attributes;
  if (node.kind === SyntaxKind.ExportDeclaration) return (node as ExportDeclaration).attributes;
  return undefined;
}

/** Whether the grammar checker reports the import clause, which skips its bindings. */
function hasImportClauseGrammarError(node: ImportClause): boolean {
  const namedBindings = node.namedBindings;
  if (node.phaseModifier === SyntaxKind.TypeKeyword) {
    if ((node.flags & NodeFlags.JSDoc) === 0 && node.name !== undefined && namedBindings !== undefined)
      return !hasParseErrors(node);
    if (namedBindings !== undefined && namedBindings.kind === SyntaxKind.NamedImports)
      for (const specifier of (namedBindings as NamedImports).elements.nodes)
        if (getIsTypeOnly(specifier)) return !hasParseErrors(node);
  } else if (node.phaseModifier === SyntaxKind.DeferKeyword) {
    if (node.name !== undefined) return !hasParseErrors(node);
    if (namedBindings !== undefined && namedBindings.kind === SyntaxKind.NamedImports) return !hasParseErrors(node);
  }
  return false;
}

function hasParseErrors(node: Node): boolean {
  return getSourceFileOfNode(node).diagnostics.length > 0;
}

export function checkImportDeclaration(c: Checker, node: Node): void {
  if (!isInModuleElementContext(node) || !isValidExternalImportOrExportDeclaration(node)) {
    checkImportAttributes(c, node);
    return;
  }
  const declaration = node as ImportDeclaration;
  const clause = declaration.importClause;
  if (clause !== undefined && !hasImportClauseGrammarError(clause)) {
    if (clause.name !== undefined) checkImportBinding(c, clause);
    const namedBindings = clause.namedBindings;
    if (namedBindings !== undefined) {
      if (namedBindings.kind === SyntaxKind.NamespaceImport) checkImportBinding(c, namedBindings);
      else if (resolveExternalModuleName(c, node, declaration.moduleSpecifier, false) !== undefined)
        for (const binding of (namedBindings as NamedImports).elements.nodes) checkImportBinding(c, binding);
    }
  } else if (clause === undefined && c.compilerOptions.noUncheckedSideEffectImports !== false)
    resolveExternalModuleNameWorker(
      c,
      node,
      declaration.moduleSpecifier,
      Diagnostics.Cannot_find_module_or_type_declarations_for_side_effect_import_of_0,
      false,
      false,
    );
  checkImportAttributes(c, node);
}

function checkImportBinding(c: Checker, node: Node): void {
  checkAliasSymbol(c, node);
}

/** Import attributes must be assignable to the global `ImportAttributes`. */
function checkImportAttributes(c: Checker, declaration: Node): void {
  const node = getImportAttributes(declaration);
  if (node === undefined) return;
  const importAttributesType = getCachedGlobalType(c, 'ImportAttributes', 0, true);
  if (importAttributesType !== c.emptyObjectType)
    checkTypeAssignableTo(
      c,
      getTypeFromImportAttributes(c, node),
      getNullableType(c, importAttributesType, TypeFlags.Undefined),
      node,
      undefined,
    );
}

function getTypeFromImportAttributes(c: Checker, node: ImportAttributes): Type {
  const links = c.nodeLinks(node);
  if (links.resolvedType === undefined) {
    const symbol = c.newSymbol(SymbolFlags.ObjectLiteral, InternalSymbolName.ImportAttributes);
    const members: SymbolTable = new Map<string, Symbol>();
    for (const attribute of node.attributes.nodes) {
      const name = getText((attribute as ImportAttribute).name!);
      const member = c.newSymbol(SymbolFlags.Property, name);
      c.symbolLinks(member).type = getRegularTypeOfLiteralType(
        c,
        checkExpression(c, (attribute as ImportAttribute).value),
      );
      members.set(name, member);
    }
    const type = createAnonymousType(c, symbol, members, [], [], []);
    type.objectFlags |= ObjectFlags.ObjectLiteral | ObjectFlags.NonInferrableType;
    links.resolvedType = type;
  }
  return links.resolvedType;
}

export function checkImportEqualsDeclaration(c: Checker, node: Node): void {
  if (!isInModuleElementContext(node)) return;
  const declaration = node as ImportEqualsDeclaration;
  const reference = declaration.moduleReference;
  const isExternal = reference.kind === SyntaxKind.ExternalModuleReference;
  if (c.compilerOptions.erasableSyntaxOnly === true && (node.flags & NodeFlags.Ambient) === 0)
    c.error(node, Diagnostics.This_syntax_is_not_allowed_when_erasableSyntaxOnly_is_enabled);
  if (isExternal && !isValidExternalImportOrExportDeclaration(node)) return;
  checkImportBinding(c, node);
  if (hasSyntacticModifier(node, ModifierFlags.Export) && (node.flags & NodeFlags.Ambient) === 0)
    markExportAsReferenced(c, node);
  if (isExternal) return;
  const target = resolveAlias(c, getSymbolOfDeclaration(c, node)!);
  if (target === c.unknownSymbol) return;
  const targetFlags = getSymbolFlags(c, target);
  if ((targetFlags & SymbolFlags.Value) !== 0) {
    // A value target must not be hidden by a local declaration of the same name.
    const moduleName = getFirstIdentifierOfEntityName(reference);
    const resolved = resolveEntityName(
      c,
      moduleName,
      SymbolFlags.Value | SymbolFlags.Namespace,
      false,
      false,
      undefined,
    );
    if (resolved !== undefined && (resolved.flags & SymbolFlags.Namespace) === 0)
      c.error(
        moduleName,
        Diagnostics.Module_0_is_hidden_by_a_local_declaration_with_the_same_name,
        declarationNameToString(getSourceFileOfNode(moduleName), moduleName),
      );
  }
  if ((targetFlags & SymbolFlags.Type) !== 0)
    checkTypeNameIsReserved(c, declaration.name, Diagnostics.Import_name_cannot_be_0);
}

function getFirstIdentifierOfEntityName(node: Node): Node {
  let current = node;
  while (current.kind === SyntaxKind.QualifiedName) current = (current as QualifiedName).left;
  return current;
}

export function checkExportDeclaration(c: Checker, node: Node): void {
  if (!isInModuleElementContext(node)) return;
  const declaration = node as ExportDeclaration;
  if (declaration.moduleSpecifier === undefined || isValidExternalImportOrExportDeclaration(node)) {
    const clause = declaration.exportClause;
    if (clause !== undefined && clause.kind === SyntaxKind.NamedExports) {
      for (const specifier of (clause as NamedExports).elements.nodes) checkExportSpecifier(c, specifier);
    } else {
      const moduleSymbol = resolveExternalModuleName(c, node, declaration.moduleSpecifier, false);
      if (moduleSymbol !== undefined && hasExportAssignmentSymbol(moduleSymbol))
        c.error(
          declaration.moduleSpecifier,
          Diagnostics.Module_0_uses_export_and_cannot_be_used_with_export_Asterisk,
          symbolToString(c, moduleSymbol),
        );
      else if (clause !== undefined) checkAliasSymbol(c, clause);
    }
  }
  checkImportAttributes(c, node);
}

function checkExportSpecifier(c: Checker, node: Node): void {
  checkAliasSymbol(c, node);
  if ((node.parent!.parent as ExportDeclaration).moduleSpecifier !== undefined) return;
  const exportedName = getPropertyNameOrName(node);
  // `export { "x" }` is a syntax error.
  if (exportedName.kind === SyntaxKind.StringLiteral) return;
  // The immediate symbol of the name, without following aliases.
  const symbol = resolveName(
    c,
    exportedName,
    getText(exportedName),
    SymbolFlags.Value | SymbolFlags.Type | SymbolFlags.Namespace | SymbolFlags.Alias,
    undefined,
    true,
    false,
  );
  if (
    symbol !== undefined &&
    (symbol === c.undefinedSymbol ||
      symbol === c.globalThisSymbol ||
      (symbol.declarations.length > 0 && isGlobalSourceFile(getDeclarationContainer(symbol.declarations[0]!))))
  )
    c.error(
      exportedName,
      Diagnostics.Cannot_export_0_Only_local_declarations_can_be_exported_from_a_module,
      getText(exportedName),
    );
  else markExportSpecifierAliasReferenced(c, node, symbol, exportedName);
}

function getDeclarationContainer(node: Node): Node {
  let current = getRootDeclaration(node);
  for (;;) {
    const parent = current.parent;
    if (parent === undefined) return current;
    switch (current.kind) {
      case SyntaxKind.VariableDeclaration:
      case SyntaxKind.VariableDeclarationList:
      case SyntaxKind.ImportSpecifier:
      case SyntaxKind.NamedImports:
      case SyntaxKind.NamespaceImport:
      case SyntaxKind.ImportClause:
        current = parent;
        continue;
    }
    return parent;
  }
}

/** `export = e` and `export default e`; the grammar checker reports misplaced ones. */
export function checkExportAssignment(c: Checker, node: Node): void {
  if (!isInModuleElementContext(node)) return;
  const declaration = node as ExportAssignment;
  const isExportEquals = declaration.isExportEquals;
  const container = node.parent!.kind === SyntaxKind.SourceFile ? node.parent! : node.parent!.parent!;
  if (container.kind === SyntaxKind.ModuleDeclaration && !isAmbientModule(container)) return;
  const ambient = (node.flags & NodeFlags.Ambient) !== 0;
  if (c.compilerOptions.erasableSyntaxOnly === true && isExportEquals && !ambient)
    c.error(node, Diagnostics.This_syntax_is_not_allowed_when_erasableSyntaxOnly_is_enabled);
  const verbatimModuleSyntax = c.compilerOptions.verbatimModuleSyntax === true;
  const isIllegalExportDefaultInCJS =
    !isExportEquals &&
    !ambient &&
    verbatimModuleSyntax &&
    c.host.getImpliedNodeFormatForEmit(getSourceFileOfNode(node)) === ModuleKind.CommonJS;
  const expression = declaration.expression;
  if (expression.kind === SyntaxKind.Identifier) {
    const id = expression;
    const resolved = resolveEntityName(c, id, SymbolFlags.All, true, true, node);
    if (resolved !== undefined) {
      const sym = getExportSymbolOfValueSymbolIfExported(c, resolved);
      if (!ambient) markAliasReferenced(c, sym, id);
      const typeOnlyDeclaration = getTypeOnlyAliasDeclarationOfMeaning(c, sym, SymbolFlags.Value);
      const name = getText(id);
      // A non-value is exported as a type, like `export { Id as default }`.
      if ((getSymbolFlags(c, sym) & SymbolFlags.Value) !== 0) {
        checkExpressionCached(c, id);
        if (!isIllegalExportDefaultInCJS && !ambient && verbatimModuleSyntax && typeOnlyDeclaration !== undefined)
          c.error(
            id,
            isExportEquals
              ? Diagnostics.An_export_declaration_must_reference_a_real_value_when_verbatimModuleSyntax_is_enabled_but_0_resolves_to_a_type_only_declaration
              : Diagnostics.An_export_default_must_reference_a_real_value_when_verbatimModuleSyntax_is_enabled_but_0_resolves_to_a_type_only_declaration,
            name,
          );
      } else if (!isIllegalExportDefaultInCJS && !ambient && verbatimModuleSyntax)
        c.error(
          id,
          isExportEquals
            ? Diagnostics.An_export_declaration_must_reference_a_value_when_verbatimModuleSyntax_is_enabled_but_0_only_refers_to_a_type
            : Diagnostics.An_export_default_must_reference_a_value_when_verbatimModuleSyntax_is_enabled_but_0_only_refers_to_a_type,
          name,
        );
      if (!isIllegalExportDefaultInCJS && !ambient && c.isolatedModules && (sym.flags & SymbolFlags.Value) === 0)
        checkIsolatedModulesExportAssignment(c, node, sym, typeOnlyDeclaration, isExportEquals);
    } else checkExpressionCached(c, id);
  } else checkExpressionCached(c, expression);
  if (isIllegalExportDefaultInCJS)
    c.error(
      node,
      Diagnostics.ECMAScript_imports_and_exports_cannot_be_written_in_a_CommonJS_file_under_verbatimModuleSyntax_Adjust_the_type_field_in_the_nearest_package_json_to_make_this_file_an_ECMAScript_module_or_adjust_your_verbatimModuleSyntax_module_and_moduleResolution_settings_in_TypeScript,
    );
  checkExternalModuleExports(c, container);
  // A JSDoc `@type` on `export default`.
  const typeNode = getType(node);
  if (typeNode !== undefined) {
    const expr = getExpression(node)!;
    checkTypeAssignableToAndOptionallyElaborate(
      c,
      checkExpressionCached(c, expr),
      getTypeFromTypeNode(c, typeNode),
      expr,
      expr,
    );
  }
}

function checkIsolatedModulesExportAssignment(
  c: Checker,
  node: Node,
  sym: Symbol,
  typeOnlyDeclaration: Node | undefined,
  isExportEquals: boolean,
): void {
  const id = getExpression(node)!;
  const name = getText(id);
  const nonLocalMeanings = getSymbolFlagsEx(c, sym, false, true);
  const sameFile =
    typeOnlyDeclaration !== undefined && getSourceFileOfNode(typeOnlyDeclaration) === getSourceFileOfNode(node);
  if (
    (sym.flags & SymbolFlags.Alias) !== 0 &&
    (nonLocalMeanings & SymbolFlags.Type) !== 0 &&
    (nonLocalMeanings & SymbolFlags.Value) === 0 &&
    !sameFile
  )
    c.error(
      id,
      isExportEquals
        ? Diagnostics.X_0_resolves_to_a_type_and_must_be_marked_type_only_in_this_file_before_re_exporting_when_1_is_enabled_Consider_using_import_type_where_0_is_imported
        : Diagnostics.X_0_resolves_to_a_type_and_must_be_marked_type_only_in_this_file_before_re_exporting_when_1_is_enabled_Consider_using_export_type_0_as_default,
      name,
      getIsolatedModulesLikeFlagName(c),
    );
  else if (typeOnlyDeclaration !== undefined && !sameFile)
    addTypeOnlyDeclarationRelatedInfo(
      c.error(
        id,
        isExportEquals
          ? Diagnostics.X_0_resolves_to_a_type_only_declaration_and_must_be_marked_type_only_in_this_file_before_re_exporting_when_1_is_enabled_Consider_using_import_type_where_0_is_imported
          : Diagnostics.X_0_resolves_to_a_type_only_declaration_and_must_be_marked_type_only_in_this_file_before_re_exporting_when_1_is_enabled_Consider_using_export_type_0_as_default,
        name,
        getIsolatedModulesLikeFlagName(c),
      ),
      typeOnlyDeclaration,
      name,
    );
}

/** Reports aliases that conflict with local declarations, and type-only rules of isolated modules. */
export function checkAliasSymbol(c: Checker, node: Node): void {
  const aliasSymbol = getSymbolOfDeclaration(c, node);
  if (aliasSymbol === undefined) return;
  const target = resolveAlias(c, aliasSymbol);
  if (target === c.unknownSymbol) return;
  // The local symbol merges other local (and exported) declarations, whose meanings the target can't have.
  const symbol = getMergedSymbol(c, aliasSymbol.exportSymbol ?? aliasSymbol);
  const targetFlags = getSymbolFlags(c, target);
  // Type-only imports and exports are grammar errors in JavaScript.
  if (isInJSFile(node) && (targetFlags & SymbolFlags.Value) === 0 && !isTypeOnlyImportOrExportDeclaration(node)) {
    reportJSTypeAlias(c, node, symbol);
    return;
  }
  const excludedMeanings =
    ((symbol.flags & (SymbolFlags.Value | SymbolFlags.ExportValue)) !== 0 ? SymbolFlags.Value : 0) |
    ((symbol.flags & SymbolFlags.Type) !== 0 ? SymbolFlags.Type : 0) |
    ((symbol.flags & SymbolFlags.Namespace) !== 0 ? SymbolFlags.Namespace : 0);
  if ((targetFlags & excludedMeanings) !== 0)
    c.error(
      node,
      node.kind === SyntaxKind.ExportSpecifier
        ? Diagnostics.Export_declaration_conflicts_with_exported_declaration_of_0
        : Diagnostics.Import_declaration_conflicts_with_local_declaration_of_0,
      symbolToString(c, symbol),
    );
  else if (
    node.kind !== SyntaxKind.ExportSpecifier &&
    c.compilerOptions.isolatedModules === true &&
    !isPartOfTypeOnlyImportOrExportDeclaration(node) &&
    (symbol.flags & (SymbolFlags.Value | SymbolFlags.ExportValue)) !== 0
  )
    // A transpiler sees a value import that collides with the local value.
    c.error(
      node,
      Diagnostics.Import_0_conflicts_with_local_value_so_must_be_declared_with_a_type_only_import_when_isolatedModules_is_enabled,
      symbolToString(c, symbol),
      getIsolatedModulesLikeFlagName(c),
    );
  if (c.isolatedModules && !isTypeOnlyImportOrExportDeclaration(node) && (node.flags & NodeFlags.Ambient) === 0)
    checkIsolatedModulesAlias(c, node, symbol, target, targetFlags);
  if (node.kind === SyntaxKind.ImportSpecifier) checkDeprecatedImportSpecifier(c, node, symbol);
}

function reportJSTypeAlias(c: Checker, node: Node, symbol: Symbol): void {
  const errorNode = getPropertyName(node) ?? getName(node) ?? node;
  if (node.kind === SyntaxKind.ExportSpecifier) {
    c.error(errorNode, Diagnostics.Types_cannot_appear_in_export_declarations_in_JavaScript_files);
    return;
  }
  const identifierText = errorNode.kind === SyntaxKind.Identifier ? getText(errorNode) : symbol.name;
  let specifierText = '...';
  let declaration: Node | undefined = node;
  while (
    declaration !== undefined &&
    declaration.kind !== SyntaxKind.ImportDeclaration &&
    declaration.kind !== SyntaxKind.ImportEqualsDeclaration &&
    declaration.kind !== SyntaxKind.VariableDeclaration
  )
    declaration = declaration.parent;
  if (declaration !== undefined) {
    const specifier =
      declaration.kind === SyntaxKind.VariableDeclaration
        ? isVariableDeclarationInitializedToRequire(declaration)
          ? (getInitializer(declaration) as CallExpression).arguments.nodes[0]!
          : undefined
        : getExternalModuleName(declaration);
    if (specifier !== undefined && isStringLiteralLike(specifier)) specifierText = getText(specifier);
  }
  let importText = 'import("' + specifierText + '")';
  if (node.kind === SyntaxKind.ImportSpecifier) importText += '.' + identifierText;
  c.error(
    errorNode,
    Diagnostics.X_0_is_a_type_and_cannot_be_imported_in_JavaScript_files_Use_1_in_a_JSDoc_type_annotation,
    identifierText,
    importText,
  );
}

function checkIsolatedModulesAlias(
  c: Checker,
  node: Node,
  symbol: Symbol,
  target: Symbol,
  targetFlags: SymbolFlags,
): void {
  const verbatimModuleSyntax = c.compilerOptions.verbatimModuleSyntax === true;
  const typeOnlyAlias = getTypeOnlyAliasDeclaration(c, symbol);
  const isType = (targetFlags & SymbolFlags.Value) === 0;
  if (isType || typeOnlyAlias !== undefined) {
    switch (node.kind) {
      case SyntaxKind.ImportClause:
      case SyntaxKind.ImportSpecifier:
      case SyntaxKind.ImportEqualsDeclaration: {
        if (verbatimModuleSyntax) {
          const message =
            node.kind === SyntaxKind.ImportEqualsDeclaration &&
            (node as ImportEqualsDeclaration).moduleReference.kind !== SyntaxKind.ExternalModuleReference
              ? Diagnostics.An_import_alias_cannot_resolve_to_a_type_or_type_only_declaration_when_verbatimModuleSyntax_is_enabled
              : isType
                ? Diagnostics.X_0_is_a_type_and_must_be_imported_using_a_type_only_import_when_verbatimModuleSyntax_is_enabled
                : Diagnostics.X_0_resolves_to_a_type_only_declaration_and_must_be_imported_using_a_type_only_import_when_verbatimModuleSyntax_is_enabled;
          const name = getText(getPropertyNameOrName(node));
          addTypeOnlyDeclarationRelatedInfo(c.error(node, message, name), isType ? undefined : typeOnlyAlias, name);
        }
        if (
          isType &&
          node.kind === SyntaxKind.ImportEqualsDeclaration &&
          hasSyntacticModifier(node, ModifierFlags.Export)
        )
          c.error(
            node,
            Diagnostics.Cannot_use_export_import_on_a_type_or_type_only_namespace_when_0_is_enabled,
            getIsolatedModulesLikeFlagName(c),
          );
        break;
      }
      case SyntaxKind.ExportSpecifier:
        // `import type { A } from './a'; export { A }` is fine: one file shows the export is a type.
        if (
          verbatimModuleSyntax ||
          typeOnlyAlias === undefined ||
          getSourceFileOfNode(typeOnlyAlias) !== getSourceFileOfNode(node)
        ) {
          const name = getText(getPropertyNameOrName(node));
          const diagnostic = isType
            ? c.error(
                node,
                Diagnostics.Re_exporting_a_type_when_0_is_enabled_requires_using_export_type,
                getIsolatedModulesLikeFlagName(c),
              )
            : c.error(
                node,
                Diagnostics.X_0_resolves_to_a_type_only_declaration_and_must_be_re_exported_using_a_type_only_re_export_when_1_is_enabled,
                name,
                getIsolatedModulesLikeFlagName(c),
              );
          addTypeOnlyDeclarationRelatedInfo(diagnostic, isType ? undefined : typeOnlyAlias, name);
        }
        break;
    }
  }
  if (
    verbatimModuleSyntax &&
    (targetFlags & SymbolFlags.ConstEnum) !== 0 &&
    target.valueDeclaration !== undefined &&
    (target.valueDeclaration.flags & NodeFlags.Ambient) !== 0
  )
    c.error(node, Diagnostics.Cannot_access_ambient_const_enums_when_0_is_enabled, getIsolatedModulesLikeFlagName(c));
}

function isPartOfTypeOnlyImportOrExportDeclaration(node: Node): boolean {
  for (let current: Node | undefined = node; current !== undefined; current = current.parent)
    if (isTypeOnlyImportOrExportDeclaration(current)) return true;
  return false;
}

function getIsolatedModulesLikeFlagName(c: Checker): string {
  return c.compilerOptions.verbatimModuleSyntax === true ? 'verbatimModuleSyntax' : 'isolatedModules';
}
