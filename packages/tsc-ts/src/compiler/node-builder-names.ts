// Naming symbols in built nodes: the chain of symbols reaching a symbol from the enclosing
// declaration, written as an entity name, `import("…")` type, indexed access or expression.
import {
  ComputedPropertyName,
  ElementAccessExpression,
  ExpressionWithTypeArguments,
  Identifier,
  ImportAttributes,
  ImportTypeNode,
  IndexedAccessTypeNode,
  LiteralTypeNode,
  type Node,
  type NodeList,
  NodeFlags,
  ParenthesizedTypeNode,
  PrefixUnaryExpression,
  PropertyAccessExpression,
  QualifiedName,
  SourceFile,
  StringLiteral,
  TypeQueryNode,
  TypeReferenceNode,
  getExpression,
  getName,
} from './ast.js';
import {
  declarationNameToString,
  getDeclarationOfKind,
  getNameOfDeclaration,
  getSourceFileOfNode,
} from './binder-utilities.js';
import { isAmbientModule } from './ast-utilities.js';
import { checkExpression } from './checker-expressions.js';
import { getExportsOfSymbol, getMembersOfSymbol, isAmbientModuleSymbolName, resolveAlias } from './checker-symbols.js';
import { compareSymbols } from './checker-type-factory.js';
import { TypeFlags, type LiteralType } from './checker-types.js';
import { isLateBoundName } from './checker-utilities.js';
import {
  getDirectoryPath,
  getNormalizedAbsolutePath,
  getRelativePathFromDirectory,
  isExternalModuleNameRelative,
  removeFileExtension,
} from './path.js';
import type { Checker } from './checker.js';
import { getAllowedEndingsInPreferredOrder, processEnding } from './module-specifier-endings.js';
import { ModuleKind } from './options.js';
import { getDefaultResolutionModeForFile } from './program-utilities.js';
import { EmitFlags } from './printer/emit-flags.js';
import { isIdentifierText } from './scanner.js';
import {
  CheckFlags,
  InternalSymbolName,
  type Symbol,
  SymbolFlags,
  escapeInternalSymbolName,
  getSymbolId,
} from './symbol.js';
import {
  getAccessibleSymbolChain,
  getAliasForSymbolInContainer,
  getContainersOfSymbol,
  getFileSymbolIfFileSymbolExportEqualsContainer,
  getQualifiedLeftMeaning,
  getSymbolIfSameReference,
  hasNonGlobalAugmentationExternalModuleSymbol,
  needsQualification,
} from './symbol-accessibility.js';
import { SyntaxKind } from './syntax-kind.js';
import { NodeBuilderFlags, NodeBuilderInternalFlags } from './transformers/declarations-resolver.js';
import { TokenFlags } from './types.js';
import { type NodeBuilder, classifyPropertyName, isNumericLiteralName } from './node-builder.js';
import { getMergedSymbol } from './checker-symbols.js';

// ---- Symbol chains

/** The chain of symbols naming `symbol`, reported to the tracker. */
export function lookupSymbolChain(
  b: NodeBuilder,
  symbol: Symbol,
  meaning: SymbolFlags,
  yieldModuleSymbol: boolean,
): Symbol[] {
  b.trackSymbol(symbol, b.enclosingDeclaration, meaning);
  // Qualified only with somewhere to qualify from, and never for type parameters.
  if (
    (symbol.flags & SymbolFlags.TypeParameter) === 0 &&
    (b.enclosingDeclaration !== undefined || (b.flags & NodeBuilderFlags.UseFullyQualifiedType) !== 0) &&
    (b.internalFlags & NodeBuilderInternalFlags.DoNotIncludeSymbolChain) === 0
  )
    return getSymbolChain(b, symbol, meaning, true, yieldModuleSymbol)!;
  return [symbol];
}

/** `endOfChain` is false for parents, which may be omitted. */
function getSymbolChain(
  b: NodeBuilder,
  symbol: Symbol,
  meaning: SymbolFlags,
  endOfChain: boolean,
  yieldModuleSymbol: boolean,
): Symbol[] | undefined {
  const c = b.c;
  let chain = getAccessibleSymbolChain(
    c,
    symbol,
    b.enclosingDeclaration,
    meaning,
    (b.flags & NodeBuilderFlags.UseOnlyExternalAliasing) !== 0,
  );
  const qualifierMeaning = chain.length > 1 ? getQualifiedLeftMeaning(meaning) : meaning;
  if (chain.length === 0 || needsQualification(c, chain[0], b.enclosingDeclaration, qualifierMeaning)) {
    // Go up and add the parent.
    const root = chain.length > 0 ? chain[0] : symbol;
    const parents = getContainersOfSymbol(c, root, b.enclosingDeclaration, meaning);
    if (parents.length > 0) {
      const specifiers = parents.map((p) =>
        p.declarations.some(hasNonGlobalAugmentationExternalModuleSymbol) ? getSpecifierForModuleSymbol(b, p) : '',
      );
      const order = parents.map((_p, i) => i);
      order.sort((x, y) => compareByBestName(b, parents[x], specifiers[x], parents[y], specifiers[y]) || x - y);
      for (const index of order) {
        const parent = parents[index];
        const parentChain = getSymbolChain(b, parent, getQualifiedLeftMeaning(meaning), false, yieldModuleSymbol);
        if (parentChain === undefined || parentChain.length === 0) continue;
        const exportEquals = parent.exports?.get(InternalSymbolName.ExportEquals);
        if (exportEquals !== undefined && getSymbolIfSameReference(c, exportEquals, symbol) !== undefined) {
          // The parent's `export =` is the symbol itself: no alias to look up.
          chain = parentChain;
          break;
        }
        const next = chain.length > 0 ? chain : [getAliasForSymbolInContainer(c, parent, symbol) ?? symbol];
        chain = parentChain.concat(next);
        break;
      }
    }
  }
  if (chain.length > 0) return chain;
  // The end of a chain is always written; an anonymous type parent never is.
  if (endOfChain || (symbol.flags & (SymbolFlags.TypeLiteral | SymbolFlags.ObjectLiteral)) === 0) {
    // An external module parent isn't written: `x` rather than `"foo/bar".x`.
    if (!endOfChain && !yieldModuleSymbol && symbol.declarations.some(hasNonGlobalAugmentationExternalModuleSymbol))
      return undefined;
    return [symbol];
  }
  return undefined;
}

function compareByBestName(b: NodeBuilder, a: Symbol, specifierA: string, other: Symbol, specifierB: string): number {
  if (specifierA.length > 0 && specifierB.length > 0) {
    const isBRelative = isExternalModuleNameRelative(specifierB);
    if (isExternalModuleNameRelative(specifierA) === isBRelative)
      return countPathComponents(specifierA) - countPathComponents(specifierB);
    return isBRelative ? -1 : 1;
  }
  return compareSymbols(b.c, a, other);
}

function countPathComponents(path: string): number {
  let count = 0;
  const start = path.startsWith('./') ? 2 : 0;
  for (let i = start; i < path.length; i++) if (path.charCodeAt(i) === 0x2f) count++;
  return count;
}

// ---- Type nodes

/** A type node naming `symbol` with `mask`: a type reference, `typeof`, indexed access or `import("…")`. */
export function symbolToTypeNode(
  b: NodeBuilder,
  symbol: Symbol,
  mask: SymbolFlags,
  typeArguments: NodeList | undefined,
): Node | undefined {
  // Outside the current scope, the module isn't needed.
  const chain = lookupSymbolChain(
    b,
    symbol,
    mask,
    (b.flags & NodeBuilderFlags.UseAliasDefinedOutsideCurrentScope) === 0,
  );
  if (chain.length === 0) return undefined;
  const isTypeOf = mask === SymbolFlags.Value;
  if (chain[0].declarations.some(hasNonGlobalAugmentationExternalModuleSymbol)) {
    // A module root needs an `import` type.
    const nonRootParts =
      chain.length > 1 ? createAccessFromSymbolChain(b, chain, chain.length - 1, 1, typeArguments) : undefined;
    const typeParameterNodes = typeArguments ?? lookupTypeParameterNodes(b, chain, 0);
    const specifier = getSpecifierForModuleSymbol(b, chain[0]);
    let attributes: ImportAttributes | undefined = undefined;
    if ((b.flags & NodeBuilderFlags.AllowNodeModulesRelativePaths) === 0 && specifier.includes('/node_modules/')) {
      // A reference into `node_modules` is likely to break when published.
      b.encounteredError = true;
      b.tracker.reportLikelyUnsafeImportRequiredError(specifier, symbol.name);
    }
    const literal = b.created(new LiteralTypeNode(b.stringLiteral(specifier, false)));
    b.approximateLength += specifier.length + 10;
    if (nonRootParts === undefined || isEntityName(nonRootParts))
      return b.created(new ImportTypeNode(isTypeOf, literal, attributes, nonRootParts, typeParameterNodes));
    const splitNode = getTopmostIndexedAccessType(nonRootParts as IndexedAccessTypeNode);
    const qualifier = (splitNode.objectType as TypeReferenceNode).typeName;
    attributes = undefined;
    return b.created(
      new IndexedAccessTypeNode(
        b.created(new ImportTypeNode(isTypeOf, literal, attributes, qualifier, typeParameterNodes)),
        splitNode.indexType,
      ),
    );
  }
  const entityName = createAccessFromSymbolChain(b, chain, chain.length - 1, 0, typeArguments);
  // Indexed accesses can't be `typeof`.
  if (entityName instanceof IndexedAccessTypeNode) return entityName;
  if (isEntityName(entityName))
    return isTypeOf
      ? b.created(new TypeQueryNode(entityName, undefined))
      : b.created(new TypeReferenceNode(entityName, typeArguments));
  if (isTypeOf && entityName instanceof ExpressionWithTypeArguments)
    return b.created(new TypeQueryNode(entityName.expression.deepClone(), entityName.typeArguments));
  return entityName;
}

function isEntityName(node: Node): boolean {
  return node.kind === SyntaxKind.Identifier || node.kind === SyntaxKind.QualifiedName;
}

function getTopmostIndexedAccessType(node: IndexedAccessTypeNode): IndexedAccessTypeNode {
  const objectType = node.objectType;
  return objectType instanceof IndexedAccessTypeNode ? getTopmostIndexedAccessType(objectType) : node;
}

function createAccessFromSymbolChain(
  b: NodeBuilder,
  chain: Symbol[],
  index: number,
  stopper: number,
  overrideTypeArguments: NodeList | undefined,
): Node {
  const c = b.c;
  const typeParameterNodes =
    index !== chain.length - 1 ? lookupTypeParameterNodes(b, chain, index) : overrideTypeArguments;
  const symbol = chain[index];
  const parent = index > 0 ? chain[index - 1] : undefined;
  let symbolName = '';
  if (index === 0) {
    b.flags |= NodeBuilderFlags.InInitialEntityName;
    symbolName = getNameOfSymbolAsWritten(b, symbol);
    b.approximateLength += symbolName.length + 1;
    b.flags ^= NodeBuilderFlags.InInitialEntityName;
  } else if (parent !== undefined) {
    // A reference to the symbol within its parent, for export aliases.
    const exports = getExportsOfSymbol(c, parent);
    const direct = exports.get(symbol.name);
    if (
      symbol.name !== InternalSymbolName.ExportEquals &&
      !isLateBoundName(symbol.name) &&
      direct !== undefined &&
      getSymbolIfSameReference(c, direct, symbol) !== undefined
    )
      symbolName = symbol.name;
    else {
      const candidates: Symbol[] = [];
      const names: string[] = [];
      for (const [name, exported] of exports)
        if (
          getSymbolIfSameReference(c, exported, symbol) !== undefined &&
          !isLateBoundName(name) &&
          name !== InternalSymbolName.ExportEquals
        ) {
          candidates.push(exported);
          names.push(name);
        }
      if (candidates.length > 0) {
        let best = 0;
        for (let i = 1; i < candidates.length; i++)
          if (compareSymbols(c, candidates[i], candidates[best]) < 0) best = i;
        symbolName = names[best];
      }
    }
  }
  if (symbolName.length === 0) {
    let name: Node | undefined = undefined;
    for (const d of symbol.declarations) {
      name = getNameOfDeclaration(d);
      if (name !== undefined) break;
    }
    if (name !== undefined && name.kind === SyntaxKind.ComputedPropertyName && isEntityName(getExpression(name)!)) {
      const lhs = createAccessFromSymbolChain(b, chain, index - 1, stopper, overrideTypeArguments);
      if (isEntityName(lhs))
        return b.created(
          new IndexedAccessTypeNode(
            b.created(new ParenthesizedTypeNode(b.created(new TypeQueryNode(lhs, undefined)))),
            b.created(new TypeQueryNode(getExpression(name)!, undefined)),
          ),
        );
      return lhs;
    }
    symbolName = getNameOfSymbolAsWritten(b, symbol);
  }
  b.approximateLength += symbolName.length + 1;
  if ((b.flags & NodeBuilderFlags.ForbidIndexedAccessSymbolReferences) === 0 && parent !== undefined) {
    const member = getMembersOfSymbol(c, parent).get(symbol.name);
    if (member !== undefined && getSymbolIfSameReference(c, member, symbol) !== undefined) {
      // An indexed access.
      const lhs = createAccessFromSymbolChain(b, chain, index - 1, stopper, overrideTypeArguments);
      const literal = b.created(new LiteralTypeNode(b.stringLiteral(symbolName, false)));
      if (lhs instanceof IndexedAccessTypeNode) return b.created(new IndexedAccessTypeNode(lhs, literal));
      return b.created(new IndexedAccessTypeNode(b.created(new TypeReferenceNode(lhs, typeParameterNodes)), literal));
    }
  }
  const identifier = b.identifier(symbolName);
  b.context.addEmitFlags(identifier, EmitFlags.NoAsciiEscaping);
  if (index > stopper) {
    const lhs = createAccessFromSymbolChain(b, chain, index - 1, stopper, overrideTypeArguments);
    if (
      (b.flags & NodeBuilderFlags.UseInstantiationExpressions) === 0 ||
      (isEntityName(lhs) && (typeParameterNodes === undefined || typeParameterNodes.nodes.length === 0))
    )
      return b.created(new QualifiedName(lhs, identifier));
    return createExpressionWithTypeArguments(
      b,
      b.created(new PropertyAccessExpression(createAccessExpression(b, lhs), undefined, identifier, NodeFlags.None)),
      typeParameterNodes,
    );
  }
  return identifier;
}

/** `ref`'s names appended to the reference `root`, for an outer type parameter group. */
export function appendReferenceToType(b: NodeBuilder, root: Node, ref: Node): Node {
  if (root instanceof ImportTypeNode) return appendReferenceToImportType(b, root as ImportTypeNode, ref);
  if (root instanceof TypeReferenceNode) return appendReferenceToTypeReference(b, root as TypeReferenceNode, ref);
  let expr = createAccessExpression(b, root);
  for (const id of getAccessStack(ref))
    expr = b.created(new PropertyAccessExpression(expr, undefined, id, NodeFlags.None));
  return expr;
}

function appendReferenceToImportType(b: NodeBuilder, root: ImportTypeNode, ref: Node): Node {
  // Type arguments of the root are dropped, as tsgo does.
  let qualifier = root.qualifier;
  for (const id of getAccessStack(ref))
    qualifier = qualifier === undefined ? id : b.created(new QualifiedName(qualifier, id as Identifier));
  return b.factory.updateImportTypeNode(
    root,
    root.isTypeOf,
    root.argument,
    root.attributes,
    qualifier,
    referenceTypeArguments(ref),
  );
}

function appendReferenceToTypeReference(b: NodeBuilder, root: TypeReferenceNode, ref: Node): Node {
  if (
    (b.flags & NodeBuilderFlags.UseInstantiationExpressions) !== 0 &&
    root.typeArguments !== undefined &&
    root.typeArguments.nodes.length !== 0
  ) {
    let expr = createExpressionWithTypeArguments(b, createAccessExpression(b, root.typeName), root.typeArguments);
    for (const id of getAccessStack(ref))
      expr = b.created(new PropertyAccessExpression(expr, undefined, id, NodeFlags.None));
    return expr;
  }
  let typeName = root.typeName;
  for (const id of getAccessStack(ref)) typeName = b.created(new QualifiedName(typeName, id as Identifier));
  return b.factory.updateTypeReferenceNode(root, typeName, referenceTypeArguments(ref));
}

function referenceTypeArguments(ref: Node): NodeList | undefined {
  return ref instanceof TypeReferenceNode ? (ref as TypeReferenceNode).typeArguments : undefined;
}

function getAccessStack(ref: Node): Node[] {
  let state = (ref as TypeReferenceNode).typeName;
  const ids: Node[] = [];
  while (state instanceof QualifiedName) {
    ids.unshift(state.right);
    state = state.left;
  }
  ids.unshift(state);
  return ids;
}

function createAccessExpression(b: NodeBuilder, node: Node): Node {
  if (node instanceof QualifiedName)
    return b.created(
      new PropertyAccessExpression(
        createAccessExpression(b, node.left),
        undefined,
        node.right.deepClone(),
        NodeFlags.None,
      ),
    );
  return node.deepClone();
}

function createExpressionWithTypeArguments(b: NodeBuilder, expr: Node, typeArguments: NodeList | undefined): Node {
  if (typeArguments === undefined || typeArguments.nodes.length === 0) return expr;
  return b.created(new ExpressionWithTypeArguments(expr, typeArguments));
}

// ---- Entity names and expressions

/** An entity name for `symbol`; with `expectsIdentifier`, a qualified name is an error unless allowed. */
export function symbolToName(b: NodeBuilder, symbol: Symbol, meaning: SymbolFlags, expectsIdentifier: boolean): Node {
  const chain = lookupSymbolChain(b, symbol, meaning, false);
  if (
    expectsIdentifier &&
    chain.length !== 1 &&
    !b.encounteredError &&
    (b.flags & NodeBuilderFlags.AllowQualifiedNameInPlaceOfIdentifier) !== 0
  )
    b.encounteredError = true;
  return createEntityNameFromSymbolChain(b, chain, chain.length - 1);
}

function createEntityNameFromSymbolChain(b: NodeBuilder, chain: Symbol[], index: number): Node {
  const symbol = chain[index];
  if (index === 0) b.flags |= NodeBuilderFlags.InInitialEntityName;
  const symbolName = getNameOfSymbolAsWritten(b, symbol);
  if (index === 0) b.flags ^= NodeBuilderFlags.InInitialEntityName;
  const identifier = b.identifier(symbolName);
  b.context.addEmitFlags(identifier, EmitFlags.NoAsciiEscaping);
  if (index > 0) return b.created(new QualifiedName(createEntityNameFromSymbolChain(b, chain, index - 1), identifier));
  return identifier;
}

/** The symbol's name qualified by its parents' names, without looking up a chain. */
export function symbolToEntityNameNode(b: NodeBuilder, symbol: Symbol): Node {
  const identifier = b.identifier(symbol.name);
  if (symbol.parent !== undefined)
    return b.created(new QualifiedName(symbolToEntityNameNode(b, symbol.parent), identifier));
  return identifier;
}

export function symbolToExpression(b: NodeBuilder, symbol: Symbol, meaning: SymbolFlags): Node {
  const chain = lookupSymbolChain(b, symbol, meaning, false);
  return createExpressionFromSymbolChain(b, chain, chain.length - 1);
}

function createExpressionFromSymbolChain(b: NodeBuilder, chain: Symbol[], index: number): Node {
  const typeParameterNodes = lookupExpressionChainTypeArgumentNodes(b, chain, index);
  const symbol = chain[index];
  if (index === 0) b.flags |= NodeBuilderFlags.InInitialEntityName;
  let symbolName = getNameOfSymbolAsWritten(b, symbol);
  if (index === 0) b.flags ^= NodeBuilderFlags.InInitialEntityName;
  if (startsWithQuote(symbolName) && symbol.declarations.some(hasNonGlobalAugmentationExternalModuleSymbol)) {
    const specifier = getSpecifierForModuleSymbol(b, symbol);
    b.approximateLength += 2 + specifier.length;
    return b.stringLiteral(specifier, false);
  }
  if (index === 0 || canUsePropertyAccess(symbolName)) {
    const identifier = b.identifier(symbolName);
    b.context.addEmitFlags(identifier, EmitFlags.NoAsciiEscaping);
    b.approximateLength += 1 + symbolName.length;
    if (index > 0) {
      const result = b.created(
        new PropertyAccessExpression(
          createExpressionFromSymbolChain(b, chain, index - 1),
          undefined,
          identifier,
          NodeFlags.None,
        ),
      );
      b.context.addEmitFlags(result, EmitFlags.NoIndentation);
      return createExpressionWithTypeArguments(b, result, typeParameterNodes);
    }
    return createExpressionWithTypeArguments(b, identifier, typeParameterNodes);
  }
  if (symbolName.startsWith('[')) symbolName = symbolName.substring(1, symbolName.length - 1);
  let expression: Node | undefined = undefined;
  if (startsWithQuote(symbolName) && (symbol.flags & SymbolFlags.EnumMember) === 0) {
    const literalText = unquote(symbolName);
    b.approximateLength += literalText.length + 2;
    expression = b.stringLiteral(literalText, symbolName.charCodeAt(0) === 0x27);
  } else if (String(Number(symbolName)) === symbolName) {
    b.approximateLength += symbolName.length;
    expression = b.factory.createNumericLiteral(symbolName);
  }
  if (expression === undefined) {
    b.approximateLength += symbolName.length;
    expression = b.identifier(symbolName);
    b.context.addEmitFlags(expression, EmitFlags.NoAsciiEscaping);
  }
  b.approximateLength += 2;
  return createExpressionWithTypeArguments(
    b,
    b.created(
      new ElementAccessExpression(
        createExpressionFromSymbolChain(b, chain, index - 1),
        undefined,
        expression,
        NodeFlags.None,
      ),
    ),
    typeParameterNodes,
  );
}

function canUsePropertyAccess(name: string): boolean {
  if (name.length === 0) return false;
  if (name.startsWith('#')) return name.length > 1 && isIdentifierText(name.substring(1));
  return isIdentifierText(name);
}

function startsWithQuote(s: string): boolean {
  return s.startsWith("'") || s.startsWith('"');
}

function unquote(s: string): string {
  if (
    s.length >= 2 &&
    (s.charCodeAt(0) === 0x22 || s.charCodeAt(0) === 0x27) &&
    s.charCodeAt(s.length - 1) === s.charCodeAt(0)
  )
    return s.substring(1, s.length - 1);
  return s;
}

// ---- Type arguments in qualified names

function shouldWriteTypeParametersInQualifiedName(b: NodeBuilder, chain: Symbol[], index: number): boolean {
  return (b.flags & NodeBuilderFlags.WriteTypeParametersInQualifiedName) !== 0 && index < chain.length - 1;
}

function lookupTypeParameterNodes(b: NodeBuilder, chain: Symbol[], index: number): NodeList | undefined {
  const symbolId = getSymbolId(chain[index]);
  if (b.typeParameterSymbolList.has(symbolId)) return undefined;
  b.typeParameterSymbolList.add(symbolId);
  if (shouldWriteTypeParametersInQualifiedName(b, chain, index)) {
    const typeArgumentNodes = lookupInstantiatedTypeArgumentNodes(b, chain, index);
    if (typeArgumentNodes !== undefined) return typeArgumentNodes;
    const typeParameterNodes = b.typeParametersToTypeParameterDeclarations(chain[index]);
    return typeParameterNodes.length > 0 ? b.list(typeParameterNodes) : undefined;
  }
  return undefined;
}

function lookupInstantiatedTypeArgumentNodes(b: NodeBuilder, chain: Symbol[], index: number): NodeList | undefined {
  if (!shouldWriteTypeParametersInQualifiedName(b, chain, index)) return undefined;
  const symbol = chain[index];
  const nextSymbol = chain[index + 1];
  if ((nextSymbol.checkFlags & CheckFlags.Instantiated) === 0) return undefined;
  const target = (symbol.flags & SymbolFlags.Alias) !== 0 ? resolveAlias(b.c, symbol) : symbol;
  let params = b.getTypeParametersOfClassOrInterface(target);
  const mapper = b.c.symbolLinks(nextSymbol).mapper;
  if (mapper !== undefined) params = params.map((p) => mapper.map(p));
  return b.mapToTypeNodes(params, false);
}

function lookupExpressionChainTypeArgumentNodes(b: NodeBuilder, chain: Symbol[], index: number): NodeList | undefined {
  if (!shouldWriteTypeParametersInQualifiedName(b, chain, index)) return undefined;
  const symbolId = getSymbolId(chain[index]);
  if (b.typeParameterSymbolList.has(symbolId)) return undefined;
  b.typeParameterSymbolList.add(symbolId);
  const typeArgumentNodes = lookupInstantiatedTypeArgumentNodes(b, chain, index);
  if (typeArgumentNodes !== undefined) return typeArgumentNodes;
  const typeParameterNodes = b.typeParametersToTypeParameterDeclarations(chain[index]);
  return typeParameterNodes.length > 0 ? b.list(typeParameterNodes) : undefined;
}

// ---- Names as written

function isDefaultBindingContext(node: Node): boolean {
  return node.kind === SyntaxKind.SourceFile || isAmbientModule(node);
}

function findDefaultBindingContext(node: Node): Node | undefined {
  for (let current: Node | undefined = node; current !== undefined; current = current.parent)
    if (isDefaultBindingContext(current)) return current;
  return undefined;
}

function getNameOfSymbolFromNameType(b: NodeBuilder, symbol: Symbol): string {
  const nameType = b.c.symbolLinks(symbol).nameType;
  if (nameType === undefined) return '';
  if ((nameType.flags & TypeFlags.StringOrNumberLiteral) !== 0) {
    const literal = nameType as LiteralType;
    const name = (nameType.flags & TypeFlags.StringLiteral) !== 0 ? literal.stringValue : String(literal.numberValue);
    if (!isIdentifierText(name) && !isNumericLiteralName(name))
      return (nameType.flags & TypeFlags.StringLiteral) !== 0 ? quoteString(name) : name;
    if (isNumericLiteralName(name) && name.startsWith('-')) return '[' + name + ']';
    return name;
  }
  if ((nameType.flags & TypeFlags.UniqueESSymbol) !== 0)
    return '[' + getNameOfSymbolAsWritten(b, nameType.symbol!) + ']';
  return '';
}

/** A JSON-style double quoted string, as tsgo's `valueToString`. */
function quoteString(s: string): string {
  return JSON.stringify(s);
}

/**
 * A readable name for a symbol, not for the right of a `.`: quoted if from a string literal,
 * and a number as written (`0o11`, not `9`).
 */
export function getNameOfSymbolAsWritten(b: NodeBuilder, symbol: Symbol): string {
  const remapped = b.remappedSymbolReferences.get(getSymbolId(symbol));
  if (remapped !== undefined) symbol = remapped;
  if (
    symbol.name === InternalSymbolName.Default &&
    (b.flags & NodeBuilderFlags.UseAliasDefinedOutsideCurrentScope) === 0 &&
    // Not the first part of an entity name, synthesized, or from another binding context.
    ((b.flags & NodeBuilderFlags.InInitialEntityName) === 0 ||
      symbol.declarations.length === 0 ||
      (b.enclosingDeclaration !== undefined &&
        findDefaultBindingContext(symbol.declarations[0]) !== findDefaultBindingContext(b.enclosingDeclaration)))
  )
    return 'default';
  if (symbol.declarations.length > 0) {
    let name: Node | undefined = undefined;
    for (const d of symbol.declarations) {
      name = getNameOfDeclaration(d);
      if (name !== undefined) break;
    }
    if (name !== undefined) {
      if (name.kind === SyntaxKind.ComputedPropertyName && (symbol.checkFlags & CheckFlags.Late) === 0) {
        const nameType = b.c.symbolLinks(symbol).nameType;
        if (nameType !== undefined && (nameType.flags & TypeFlags.StringOrNumberLiteral) !== 0) {
          const result = getNameOfSymbolFromNameType(b, symbol);
          if (result.length > 0) return result;
        }
      }
      return declarationNameToString(getSourceFileOfNode(name), name);
    }
    const declaration = symbol.declarations[0];
    const parent = declaration.parent;
    if (parent !== undefined && parent.kind === SyntaxKind.VariableDeclaration) {
      const parentName = getName(parent)!;
      return declarationNameToString(getSourceFileOfNode(parentName), parentName);
    }
    switch (declaration.kind) {
      case SyntaxKind.ClassExpression:
      case SyntaxKind.FunctionExpression:
      case SyntaxKind.ArrowFunction:
        if (!b.encounteredError && (b.flags & NodeBuilderFlags.AllowAnonymousIdentifier) === 0)
          b.encounteredError = true;
        return declaration.kind === SyntaxKind.ClassExpression ? '(Anonymous class)' : '(Anonymous function)';
    }
  }
  const name = getNameOfSymbolFromNameType(b, symbol);
  if (name.length > 0) return name;
  return escapeInternalSymbolName(symbol.name);
}

// ---- Property names

function isStringNamed(b: NodeBuilder, d: Node): boolean {
  const name = getNameOfDeclaration(d);
  if (name === undefined) return false;
  if (name instanceof ComputedPropertyName)
    return (checkExpression(b.c, name.expression).flags & TypeFlags.StringLike) !== 0;
  if (name instanceof ElementAccessExpression)
    return (checkExpression(b.c, name.argumentExpression).flags & TypeFlags.StringLike) !== 0;
  return name.kind === SyntaxKind.StringLiteral;
}

function isSingleQuotedStringNamed(d: Node): boolean {
  const name = getNameOfDeclaration(d);
  return name instanceof StringLiteral && (name.tokenFlags & TokenFlags.SingleQuote) !== 0;
}

/** The name node of a property. */
export function getPropertyNameNodeForSymbol(b: NodeBuilder, symbol: Symbol): Node {
  // A private name is the declaration's.
  const valueDeclaration = symbol.valueDeclaration;
  if (valueDeclaration !== undefined) {
    const declarationName = getName(valueDeclaration);
    if (declarationName !== undefined && declarationName.kind === SyntaxKind.PrivateIdentifier)
      return b.cloneSynthesized(declarationName);
  }
  const declarations = symbol.declarations;
  const stringNamed = declarations.length !== 0 && declarations.every((d) => isStringNamed(b, d));
  const singleQuote = declarations.length !== 0 && declarations.every(isSingleQuotedStringNamed);
  const isMethod = (symbol.flags & SymbolFlags.Method) !== 0;
  const fromNameType = getPropertyNameNodeForSymbolFromNameType(b, symbol, singleQuote, stringNamed, isMethod);
  if (fromNameType !== undefined) return fromNameType;
  let name = symbol.name;
  const privateNamePrefix = '￾#';
  if (name.startsWith(privateNamePrefix)) {
    // Symbol ids are unstable: `#123@#x` becomes `__#private@#x`.
    let rest = name.substring(privateNamePrefix.length);
    let i = 0;
    while (i < rest.length && rest.charCodeAt(i) >= 0x30 && rest.charCodeAt(i) <= 0x39) i++;
    rest = rest.substring(i);
    name = '__#private' + rest;
  }
  return createPropertyNameNodeForIdentifierOrLiteral(b, name, singleQuote, stringNamed, isMethod);
}

function createPropertyNameNodeForIdentifierOrLiteral(
  b: NodeBuilder,
  name: string,
  singleQuote: boolean,
  stringNamed: boolean,
  isMethod: boolean,
): Node {
  switch (classifyPropertyName(name, stringNamed, isMethod)) {
    case 0:
      return b.identifier(name);
    case 1:
      return b.factory.createNumericLiteral(name);
  }
  return b.factory.createStringLiteral(name, singleQuote ? TokenFlags.SingleQuote : TokenFlags.None);
}

function getPropertyNameNodeForSymbolFromNameType(
  b: NodeBuilder,
  symbol: Symbol,
  singleQuote: boolean,
  stringNamed: boolean,
  isMethod: boolean,
): Node | undefined {
  const nameType = b.c.symbolLinks(symbol).nameType;
  if (nameType === undefined) return undefined;
  if ((nameType.flags & TypeFlags.StringOrNumberLiteral) !== 0) {
    const literal = nameType as LiteralType;
    const name = (nameType.flags & TypeFlags.StringLiteral) !== 0 ? literal.stringValue : String(literal.numberValue);
    if (!isIdentifierText(name) && (stringNamed || !isNumericLiteralName(name)))
      return b.factory.createStringLiteral(name, singleQuote ? TokenFlags.SingleQuote : TokenFlags.None);
    if (isNumericLiteralName(name) && name.startsWith('-'))
      return b.created(
        new ComputedPropertyName(
          b.created(
            new PrefixUnaryExpression(SyntaxKind.MinusToken, b.factory.createNumericLiteral(name.substring(1))),
          ),
        ),
      );
    return createPropertyNameNodeForIdentifierOrLiteral(b, name, singleQuote, stringNamed, isMethod);
  }
  if ((nameType.flags & TypeFlags.UniqueESSymbol) !== 0)
    return b.created(new ComputedPropertyName(symbolToExpression(b, nameType.symbol!, SymbolFlags.Value)));
  return undefined;
}

// ---- Module specifiers

/**
 * The specifier an `import("…")` type names a module with: an ambient module's name, the file
 * name without an enclosing file, else a path relative to the enclosing file.
 */
export function getSpecifierForModuleSymbol(b: NodeBuilder, symbol: Symbol): string {
  let file = asSourceFile(getDeclarationOfKind(symbol, SyntaxKind.SourceFile));
  if (file === undefined)
    for (const d of symbol.declarations) {
      const equivalent = getFileSymbolIfFileSymbolExportEqualsContainer(b.c, d, symbol);
      if (equivalent !== undefined) {
        file = asSourceFile(getDeclarationOfKind(equivalent, SyntaxKind.SourceFile));
        break;
      }
    }
  if (file === undefined && isAmbientModuleSymbolName(symbol.name))
    return symbol.name.substring(1, symbol.name.length - 1);
  const moduleFile = file ?? getSourceFileOfModule(symbol);
  if (b.enclosingFile === undefined) {
    if (isAmbientModuleSymbolName(symbol.name)) return symbol.name.substring(1, symbol.name.length - 1);
    return moduleFile === undefined ? '' : moduleFile.fileName;
  }
  if (moduleFile === undefined) return '';
  const key = getSymbolId(getMergedSymbol(b.c, symbol)) + ':' + b.enclosingFile.path;
  const cached = b.specifierCache.get(key);
  if (cached !== undefined) return cached;
  const c = b.c;
  const options = c.compilerOptions;
  const metadata = c.host.getSourceFileMetadata(b.enclosingFile);
  const mode =
    metadata === undefined
      ? ModuleKind.None
      : getDefaultResolutionModeForFile(b.enclosingFile.fileName, metadata, options);
  // Declaration emit prefers `.js` extensions in ES modules.
  const allowedEndings = getAllowedEndingsInPreferredOrder(
    mode === ModuleKind.ESNext,
    options,
    b.enclosingFile,
    mode,
    mode,
  );
  let relative = getRelativePathFromDirectory(getDirectoryPath(b.enclosingFile.fileName), moduleFile.fileName, true);
  if (!relative.startsWith('.')) relative = './' + relative;
  const specifier = processEnding(relative, allowedEndings, options, (path) =>
    isProgramFile(c, getNormalizedAbsolutePath(path, getDirectoryPath(b.enclosingFile!.fileName))),
  );
  b.specifierCache.set(key, specifier);
  return specifier;
}

/** Whether a file of the program has the path `withoutExtension` with some extension. */
function isProgramFile(c: Checker, withoutExtension: string): boolean {
  for (const file of c.files) {
    const name = file.fileName;
    if (name.startsWith(withoutExtension + '.') && removeFileExtension(name) === withoutExtension) return true;
  }
  return false;
}

function asSourceFile(node: Node | undefined): SourceFile | undefined {
  if (node === undefined) return undefined;
  if (node instanceof SourceFile) return node as SourceFile;
  return undefined;
}

function getSourceFileOfModule(symbol: Symbol): SourceFile | undefined {
  const d = symbol.valueDeclaration ?? (symbol.declarations.length > 0 ? symbol.declarations[0] : undefined);
  return d === undefined ? undefined : getSourceFileOfNode(d);
}
