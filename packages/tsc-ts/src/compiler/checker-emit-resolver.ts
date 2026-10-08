// Declaration emit's queries answered by the checker, as tsgo's emit resolver: visibility and
// accessibility from resolved symbols, and type nodes built from types. JavaScript emit's
// queries, enum values and references between files are answered syntactically.
import {
  BigIntLiteral,
  BinaryExpression,
  ElementAccessExpression,
  type EntityName,
  ExportAssignment,
  ExportSpecifier,
  ExpressionStatement,
  type FileReference,
  type Identifier,
  type ImportDeclaration,
  ImportEqualsDeclaration,
  IndexSignatureDeclaration,
  ModifierFlags,
  type Node,
  NodeFlags,
  NodeVisitor,
  PrefixUnaryExpression,
  PropertyAccessExpression,
  PropertyDeclaration,
  SourceFile,
  VariableDeclaration,
  Token,
  getBody,
  getExpression,
  getName,
  getPostfixToken,
  getQuestionToken,
  getText,
  getSymbol,
} from './ast.js';
import { getExternalModuleName, nodeIsPresent } from './ast-utilities.js';
import {
  JSDeclarationKind,
  getAssignmentDeclarationKind,
  getCombinedModifierFlags,
  getCombinedNodeFlags,
  getDeclarationOfKind,
  getSourceFileOfNode,
  isEntityNameExpression,
  isParameterPropertyDeclaration,
  isStringOrNumericLiteralLike,
} from './binder-utilities.js';
import type { Checker } from './checker.js';
import { getEffectiveDeclarationFlags } from './checker-declarations.js';
import { getBaseTypes, getDeclaredTypeOfSymbol } from './checker-declared-types.js';
import { getResolvedSymbol } from './checker-expressions.js';
import { tryGetNameFromEntityNameExpression } from './checker-narrowing.js';
import { getIndexInfosOfType, getIndexSymbol, getPropertiesOfType, getPropertyOfType } from './checker-members.js';
import { getTargetOfExportSpecifier, resolveExternalModuleNameWorker } from './checker-modules.js';
import {
  getIndexInfosOfIndexSymbol,
  getSignatureFromDeclaration,
  getSignaturesOfSymbol,
} from './checker-signatures.js';
import { getTypeOfSymbol, getWidenedType, isReadonlySymbol } from './checker-symbol-types.js';
import {
  getExportsOfModule,
  getFirstIdentifier,
  getGlobalSymbol,
  getMergedSymbol,
  getMembersOfSymbol,
  getSymbolOfDeclaration,
  resolveName,
} from './checker-symbols.js';
import { isFreshLiteralType } from './checker-type-factory.js';
import { type IndexInfo, type LiteralType, TypeFlags } from './checker-types.js';
import { hasLateBindableName } from './checker-utilities.js';
import { NodeBuilder, isEntityNameVisible, isOptionalParameter } from './node-builder.js';
import {
  getRegularTypeOfExpression,
  newPseudoChecker,
  requiresAddingImplicitUndefinedForDeclaration,
} from './node-builder-pseudo.js';
import { symbolToExpression } from './node-builder-names.js';
import { tryReuseExistingNode } from './node-builder-reuse.js';
import type { ModuleKind } from './options.js';
import type { EmitContext } from './printer/emit-context.js';
import { isTypeIdenticalTo } from './relations.js';
import { CheckFlags, type Symbol, SymbolFlags } from './symbol.js';
import {
  beginDeclarationEmitVisibility,
  isDeclarationVisible,
  isSymbolAccessible,
  markDeclarationVisible,
} from './symbol-accessibility.js';
import { SyntaxKind } from './syntax-kind.js';
import {
  DeclarationEmitResolver,
  NodeBuilderFlags,
  NodeBuilderInternalFlags,
  SymbolAccessibility,
  type SymbolAccessibilityResult,
  type SymbolTracker,
} from './transformers/declarations-resolver.js';
import type { SyntacticDeclarationEmitResolver } from './transformers/declarations-syntactic.js';
import type { Evaluation } from './transformers/reference-resolver.js';
import type { TypeReferenceSerializationKind } from './transformers/type-serialization.js';
import { TokenFlags } from './types.js';

const declarationEmitInternalFlags = NodeBuilderInternalFlags.AllowUnresolvedNames;
const aliasMeaning = SymbolFlags.Value | SymbolFlags.Type | SymbolFlags.Namespace | SymbolFlags.Alias;

export class CheckerDeclarationEmitResolver extends DeclarationEmitResolver {
  readonly checker: Checker;
  /** Answers the queries that don't need types. */
  private readonly syntactic: SyntacticDeclarationEmitResolver;
  private readonly aliasesMarked: Set<SourceFile>;

  constructor(checker: Checker, syntactic: SyntacticDeclarationEmitResolver) {
    super();
    this.checker = checker;
    this.syntactic = syntactic;
    this.aliasesMarked = new Set<SourceFile>();
  }

  // JavaScript emit

  markLinkedReferences(file: SourceFile): boolean {
    return this.syntactic.markLinkedReferences(file);
  }

  isReferencedAliasDeclaration(node: Node): boolean {
    return this.syntactic.isReferencedAliasDeclaration(node);
  }

  isValueAliasDeclaration(node: Node): boolean {
    return this.syntactic.isValueAliasDeclaration(node);
  }

  isTopLevelValueImportEqualsWithEntityName(node: Node): boolean {
    return this.syntactic.isTopLevelValueImportEqualsWithEntityName(node);
  }

  getTypeReferenceSerializationKind(typeName: Node, location: Node | undefined): TypeReferenceSerializationKind {
    return this.syntactic.getTypeReferenceSerializationKind(typeName, location);
  }

  getReferencedExportContainer(node: Identifier, prefixLocals: boolean): Node | undefined {
    return this.syntactic.getReferencedExportContainer(node, prefixLocals);
  }

  getReferencedImportDeclaration(node: Identifier): Node | undefined {
    return this.syntactic.getReferencedImportDeclaration(node);
  }

  getReferencedValueDeclaration(node: Identifier): Node | undefined {
    return this.syntactic.getReferencedValueDeclaration(node);
  }

  getReferencedValueDeclarations(node: Identifier): Node[] | undefined {
    return this.syntactic.getReferencedValueDeclarations(node);
  }

  getEnumMemberValue(member: Node): Evaluation {
    return this.syntactic.getEnumMemberValue(member);
  }

  setReferencedImportDeclaration(name: Identifier, declaration: Node): void {
    this.syntactic.setReferencedImportDeclaration(name, declaration);
  }

  getJsxFactoryEntity(file: SourceFile): EntityName | undefined {
    return this.syntactic.getJsxFactoryEntity(file);
  }

  getJsxFragmentFactoryEntity(file: SourceFile): EntityName | undefined {
    return this.syntactic.getJsxFragmentFactoryEntity(file);
  }

  getConstantValue(node: Node): Evaluation {
    return this.syntactic.getConstantValue(node);
  }

  // Visibility

  precalculateDeclarationEmitVisibility(file: SourceFile): boolean {
    beginDeclarationEmitVisibility(this.checker, file);
    if (this.aliasesMarked.has(file)) return false;
    this.aliasesMarked.add(file);
    file.forEachChild(new AliasMarker(this));
    return true;
  }

  /** Marks the declarations an export names visible, following `import x = a.b` chains. */
  markLinkedAliases(node: Node): boolean {
    const c = this.checker;
    const parent = node.parent;
    let exportSymbol: Symbol | undefined = undefined;
    if (
      node.kind !== SyntaxKind.StringLiteral &&
      parent !== undefined &&
      (parent.kind === SyntaxKind.ExportAssignment || isCommonJSModuleExports(parent))
    )
      exportSymbol = resolveName(c, node, getText(node), aliasMeaning, undefined, false, false);
    else if (parent !== undefined && parent.kind === SyntaxKind.ExportSpecifier)
      exportSymbol = getTargetOfExportSpecifier(c, parent, aliasMeaning, false);
    const visited = new Set<Symbol>();
    while (exportSymbol !== undefined && !visited.has(exportSymbol)) {
      visited.add(exportSymbol);
      let next: Symbol | undefined = undefined;
      for (const declaration of exportSymbol.declarations) {
        markDeclarationVisible(c, declaration);
        if (
          declaration instanceof ImportEqualsDeclaration &&
          declaration.moduleReference.kind !== SyntaxKind.ExternalModuleReference
        ) {
          const first = getFirstIdentifier(declaration.moduleReference);
          next = resolveName(c, declaration, getText(first), aliasMeaning, undefined, false, false);
        }
      }
      exportSymbol = next;
    }
    return true;
  }

  isDeclarationVisible(node: Node): boolean {
    return isDeclarationVisible(this.checker, node);
  }

  isEntityNameVisible(entityName: Node, enclosingDeclaration: Node): SymbolAccessibilityResult {
    return isEntityNameVisible(this.checker, entityName, enclosingDeclaration, true);
  }

  isSymbolAccessible(
    symbol: Symbol,
    enclosingDeclaration: Node,
    meaning: SymbolFlags,
    shouldComputeAliasesToMakeVisible: boolean,
  ): SymbolAccessibilityResult {
    return isSymbolAccessible(this.checker, symbol, enclosingDeclaration, meaning, shouldComputeAliasesToMakeVisible);
  }

  isNameResolvable(location: Node, name: string): boolean {
    const meaning = SymbolFlags.Value | SymbolFlags.Type | SymbolFlags.Namespace;
    return resolveName(this.checker, location, name, meaning, undefined, false, false) !== undefined;
  }

  isImportRequiredByAugmentation(node: ImportDeclaration): boolean {
    if ((node.flags & NodeFlags.Synthesized) !== 0) return false;
    const c = this.checker;
    const file = getSourceFileOfNode(node);
    if (file.symbol === undefined) return false;
    const importTarget = getExternalModuleFileFromDeclaration(c, node);
    if (importTarget === undefined || importTarget === file) return false;
    for (const s of getExportsOfModule(c, file.symbol).values()) {
      const merged = getMergedSymbol(c, s);
      if (merged === s) continue;
      for (const d of merged.declarations) if (getSourceFileOfNode(d) === importTarget) return true;
    }
    return false;
  }

  // Declarations

  getEffectiveDeclarationFlags(node: Node, flags: ModifierFlags): ModifierFlags {
    return getEffectiveDeclarationFlags(node, flags);
  }

  isImplementationOfOverload(node: Node): boolean {
    if ((node.flags & NodeFlags.Synthesized) !== 0 || !nodeIsPresent(getBody(node))) return false;
    // Accessors have up to two signatures but never overloads.
    if (node.kind === SyntaxKind.GetAccessor || node.kind === SyntaxKind.SetAccessor) return false;
    const c = this.checker;
    const signatures = getSignaturesOfSymbol(c, getSymbolOfDeclaration(c, node));
    if (signatures.length > 1) return true;
    if (signatures.length === 1) {
      const declaration = signatures[0].declaration;
      if (declaration !== node && declaration !== undefined && (declaration.flags & NodeFlags.JSDoc) === 0) return true;
    }
    return false;
  }

  isLateBound(node: Node): boolean {
    if ((node.flags & NodeFlags.Synthesized) !== 0) return false;
    const symbol = getSymbolOfDeclaration(this.checker, node);
    return symbol !== undefined && (symbol.checkFlags & CheckFlags.Late) !== 0;
  }

  isDefinitelyReferenceToGlobalSymbolObject(node: Node): boolean {
    if (!(node instanceof PropertyAccessExpression) || node.name.kind !== SyntaxKind.Identifier) return false;
    const c = this.checker;
    const expression = node.expression;
    if (expression.kind === SyntaxKind.Identifier) {
      if (getText(expression) !== 'Symbol') return false;
      // `Symbol` doesn't resolve or is the global `Symbol`.
      return (
        getResolvedSymbol(c, expression) ===
        getGlobalSymbol(c, 'Symbol', SymbolFlags.Value | SymbolFlags.ExportValue, undefined)
      );
    }
    if (!(expression instanceof PropertyAccessExpression)) return false;
    const inner = expression.expression;
    if (
      inner.kind !== SyntaxKind.Identifier ||
      getText(inner) !== 'globalThis' ||
      getText(expression.name) !== 'Symbol'
    )
      return false;
    return getResolvedSymbol(c, inner) === c.globalThisSymbol;
  }

  isLiteralConstDeclaration(node: Node): boolean {
    if ((node.flags & NodeFlags.Synthesized) !== 0) return false;
    const isConstVariable =
      node instanceof VariableDeclaration && (getCombinedNodeFlags(node) & NodeFlags.BlockScoped) === NodeFlags.Const;
    if (!isDeclarationReadonly(node) && !isConstVariable) return false;
    const c = this.checker;
    const symbol = getSymbolOfDeclaration(c, node);
    return symbol !== undefined && isFreshLiteralType(getTypeOfSymbol(c, symbol));
  }

  isOptionalParameter(node: Node): boolean {
    return isOptionalParameter(this.checker, node);
  }

  requiresAddingImplicitUndefined(node: Node, enclosingDeclaration: Node | undefined): boolean {
    return requiresAddingImplicitUndefinedForDeclaration(this.checker, node, undefined, enclosingDeclaration);
  }

  isExpandoFunctionDeclaration(node: Node): boolean {
    if ((node.flags & NodeFlags.Synthesized) !== 0) return false;
    for (const p of this.getPropertiesOfContainerFunction(node))
      if (p.valueDeclaration !== undefined && p.valueDeclaration.kind === SyntaxKind.BinaryExpression) return true;
    return false;
  }

  getExpandoPropertyDeclarations(node: Node): Node[] {
    const result: Node[] = [];
    for (const p of this.getPropertiesOfContainerFunction(node))
      if (p.valueDeclaration !== undefined && p.valueDeclaration.kind === SyntaxKind.BinaryExpression)
        result.push(p.valueDeclaration);
    return result;
  }

  private getPropertiesOfContainerFunction(node: Node): Symbol[] {
    const c = this.checker;
    const symbol = getSymbolOfDeclaration(c, node);
    if (symbol === undefined) return [];
    return getPropertiesOfType(c, getTypeOfSymbol(c, symbol));
  }

  getResolutionModeOverride(node: Node): ModuleKind | undefined {
    return this.syntactic.getResolutionModeOverride(node);
  }

  getSourceFileFromReference(file: SourceFile, reference: FileReference): SourceFile | undefined {
    return this.syntactic.getSourceFileFromReference(file, reference);
  }

  // JavaScript

  getReferencedMemberValueDeclaration(node: Node): Node | undefined {
    return this.syntactic.getReferencedMemberValueDeclaration(node);
  }

  isThisPropertyAssignmentDeclarationRedundant(node: Node): boolean {
    const c = this.checker;
    const s = getSymbolOfDeclaration(c, node);
    if (s === undefined || s.parent === undefined) return false;
    const parentType = getDeclaredTypeOfSymbol(c, s.parent);
    for (const base of getBaseTypes(c, parentType)) {
      const baseProp = getPropertyOfType(c, base, s.name);
      if (baseProp === undefined) continue;
      if ((baseProp.flags & (SymbolFlags.Accessor | SymbolFlags.Method | SymbolFlags.Function)) !== 0) return true;
      if (
        isReadonlySymbol(c, baseProp) === isReadonlySymbol(c, s) &&
        (s.flags & SymbolFlags.Optional) === (baseProp.flags & SymbolFlags.Optional) &&
        isTypeIdenticalTo(c, getTypeOfSymbol(c, s), getTypeOfSymbol(c, baseProp))
      )
        return true;
    }
    return false;
  }

  getElementAccessExpressionName(node: Node): string {
    if (!(node instanceof ElementAccessExpression) || (node.flags & NodeFlags.Synthesized) !== 0) return '';
    const argument = node.argumentExpression;
    if (isStringOrNumericLiteralLike(argument)) return getText(argument);
    if (isEntityNameExpression(argument, false))
      return tryGetNameFromEntityNameExpression(this.checker, argument) ?? '';
    return '';
  }

  // Type nodes

  private builder(
    context: EmitContext,
    enclosingDeclaration: Node | undefined,
    flags: NodeBuilderFlags,
    tracker: SymbolTracker,
  ): NodeBuilder {
    const b = new NodeBuilder(
      this.checker,
      enclosingDeclaration,
      flags,
      declarationEmitInternalFlags,
      tracker,
      context,
    );
    b.pseudo = newPseudoChecker(this.checker);
    return b;
  }

  createTypeOfDeclaration(
    context: EmitContext,
    declaration: Node,
    enclosingDeclaration: Node,
    flags: NodeBuilderFlags,
    tracker: SymbolTracker,
  ): Node | undefined {
    const original = context.parseNode(declaration);
    if (original === undefined) return undefined;
    const b = this.builder(context, enclosingDeclaration, flags | NodeBuilderFlags.MultilineObjectLiterals, tracker);
    const symbol = getSymbolOfDeclaration(this.checker, declaration);
    return b.finish(b.serializeTypeForDeclaration(declaration, undefined, symbol, true));
  }

  createReturnTypeOfSignatureDeclaration(
    context: EmitContext,
    signature: Node,
    enclosingDeclaration: Node,
    flags: NodeBuilderFlags,
    tracker: SymbolTracker,
  ): Node | undefined {
    const original = context.parseNode(signature);
    if (original === undefined) return undefined;
    const b = this.builder(context, enclosingDeclaration, flags, tracker);
    const sig = getSignatureFromDeclaration(this.checker, original);
    const cleanup = b.enterSignatureScope(sig);
    const result = b.serializeReturnTypeForSignatureEx(sig, true);
    cleanup();
    return b.finish(result);
  }

  createTypeParametersOfSignatureDeclaration(
    context: EmitContext,
    signature: Node,
    enclosingDeclaration: Node,
    flags: NodeBuilderFlags,
    tracker: SymbolTracker,
  ): Node[] | undefined {
    const original = context.parseNode(signature);
    if (original === undefined) return undefined;
    const symbol = getSymbolOfDeclaration(this.checker, original);
    if (symbol === undefined) return undefined;
    const b = this.builder(context, enclosingDeclaration, flags, tracker);
    const result = b.finish(b.typeParametersToTypeParameterDeclarations(symbol));
    return result !== undefined && result.length > 0 ? result : undefined;
  }

  createLiteralConstValue(context: EmitContext, nodeIn: Node, tracker: SymbolTracker): Node | undefined {
    const c = this.checker;
    const node = context.parseNode(nodeIn) ?? nodeIn;
    const symbol = getSymbolOfDeclaration(c, node);
    if (symbol === undefined) return undefined;
    const t = getTypeOfSymbol(c, symbol);
    const factory = context.factory;
    if ((t.flags & TypeFlags.EnumLike) !== 0 && t.symbol !== undefined) {
      const b = this.builder(context, node, NodeBuilderFlags.None, tracker);
      return b.finish(symbolToExpression(b, t.symbol, SymbolFlags.Value));
    }
    if (t === c.trueType) return factory.createKeywordExpression(SyntaxKind.TrueKeyword);
    if (t === c.falseType) return factory.createKeywordExpression(SyntaxKind.FalseKeyword);
    if ((t.flags & TypeFlags.Literal) === 0) return undefined;
    return literalValueToExpression(context, t as LiteralType);
  }

  createTypeOfExpression(
    context: EmitContext,
    expression: Node,
    enclosingDeclaration: Node,
    flags: NodeBuilderFlags,
    tracker: SymbolTracker,
  ): Node | undefined {
    const original = context.parseNode(expression);
    if (original === undefined) return undefined;
    const b = this.builder(context, enclosingDeclaration, flags | NodeBuilderFlags.MultilineObjectLiterals, tracker);
    return b.finish(b.typeToTypeNode(getWidenedType(this.checker, getRegularTypeOfExpression(this.checker, original))));
  }

  createLateBoundIndexSignatures(
    context: EmitContext,
    containerIn: Node,
    enclosingDeclaration: Node,
    flags: NodeBuilderFlags,
    tracker: SymbolTracker,
  ): Node[] {
    const c = this.checker;
    const container = context.parseNode(containerIn) ?? containerIn;
    // The declaration's own symbol: members merged in from other files aren't written here.
    const sym = getSymbol(container);
    if (sym === undefined) return [];
    const staticInfos = getIndexInfosOfType(c, getTypeOfSymbol(c, sym));
    const instanceIndexSymbol = getIndexSymbol(c, sym);
    let instanceInfos: IndexInfo[] = [];
    if (instanceIndexSymbol !== undefined) {
      const siblingSymbols = [...getMembersOfSymbol(c, sym).values()];
      instanceInfos = getIndexInfosOfIndexSymbol(c, instanceIndexSymbol, siblingSymbols);
    }
    const factory = context.factory;
    const result: Node[] = [];
    const lists = [staticInfos, instanceInfos];
    for (let i = 0; i < lists.length; i++) {
      const isStatic = i === 0;
      for (const info of lists[i]) {
        if (info.declaration !== undefined) continue;
        // Inherited, but looks late-bound as it has no declarations.
        if (info === c.anyBaseTypeIndexInfo) continue;
        if (info.components.length > 0) {
          const allSerializable = info.components.every((component) => {
            const name = getName(component);
            return (
              name !== undefined &&
              name.kind === SyntaxKind.ComputedPropertyName &&
              isEntityNameExpressionNode(getExpression(name)!) &&
              isEntityNameVisible(c, getExpression(name)!, enclosingDeclaration, false).accessibility ===
                SymbolAccessibility.Accessible
            );
          });
          if (allSerializable) {
            for (const component of info.components) {
              // Late-bound members of the index signature are kept as members.
              if (hasLateBindableName(c, component)) continue;
              const name = getName(component)!;
              const first = getFirstIdentifier(getExpression(name)!);
              const resolved = resolveName(
                c,
                first,
                getText(first),
                SymbolFlags.Value | SymbolFlags.ExportValue,
                undefined,
                true,
                false,
              );
              if (resolved !== undefined) tracker.trackSymbol(resolved, enclosingDeclaration, SymbolFlags.Value);
              const modifiers: Node[] = [];
              if (isStatic) modifiers.push(factory.createToken(SyntaxKind.StaticKeyword));
              if (info.isReadonly) modifiers.push(factory.createToken(SyntaxKind.ReadonlyKeyword));
              const componentSymbol = getSymbolOfDeclaration(c, component);
              const b = this.builder(context, enclosingDeclaration, flags, tracker);
              const typeNode =
                componentSymbol === undefined
                  ? undefined
                  : b.finish(b.typeToTypeNode(getTypeOfSymbol(c, componentSymbol)));
              result.push(
                factory.created(
                  new PropertyDeclaration(
                    modifiers.length > 0 ? factory.createModifierList(modifiers) : undefined,
                    name,
                    getQuestionTokenOf(component),
                    typeNode,
                    undefined,
                  ),
                ),
              );
            }
            continue;
          }
        }
        const b = this.builder(context, enclosingDeclaration, flags, tracker);
        let node = b.finish(b.indexInfoToIndexSignatureDeclaration(info, undefined));
        if (node !== undefined && isStatic) node = addStaticModifier(context, node);
        if (node !== undefined) result.push(node);
      }
    }
    return result;
  }

  tryJSTypeNodeToTypeNode(
    context: EmitContext,
    typeNode: Node,
    enclosingDeclaration: Node,
    flags: NodeBuilderFlags,
    tracker: SymbolTracker,
  ): Node | undefined {
    const original = context.parseNode(typeNode) ?? typeNode;
    const b = this.builder(context, enclosingDeclaration, flags, tracker);
    return b.finish(tryReuseExistingNode(b, original));
  }
}

/** Visits every node, marking the declarations exports name visible. */
class AliasMarker extends NodeVisitor {
  readonly resolver: CheckerDeclarationEmitResolver;

  constructor(resolver: CheckerDeclarationEmitResolver) {
    super();
    this.resolver = resolver;
  }

  visitNode(node: Node): boolean {
    if (node instanceof BinaryExpression) {
      if (isCommonJSModuleExports(node) && node.right.kind === SyntaxKind.Identifier)
        this.resolver.markLinkedAliases(node.right);
    } else if (node instanceof ExportAssignment) {
      if (node.expression.kind === SyntaxKind.Identifier) this.resolver.markLinkedAliases(node.expression);
    } else if (node instanceof ExportSpecifier) this.resolver.markLinkedAliases(node.propertyName ?? node.name);
    return node.forEachChild(this);
  }
}

/** `module.exports = x` or `exports.y = x` at the top of a CommonJS module. */
function isCommonJSModuleExports(node: Node): boolean {
  if (!(node instanceof BinaryExpression)) return false;
  const statement = node.parent;
  if (!(statement instanceof ExpressionStatement)) return false;
  const file = statement.parent;
  if (!(file instanceof SourceFile) || file.commonJSModuleIndicator === undefined) return false;
  const kind = getAssignmentDeclarationKind(node);
  return kind === JSDeclarationKind.ModuleExports || kind === JSDeclarationKind.ExportsProperty;
}

function isDeclarationReadonly(node: Node): boolean {
  return (
    (getCombinedModifierFlags(node) & ModifierFlags.Readonly) !== 0 &&
    !(node.parent !== undefined && isParameterPropertyDeclaration(node, node.parent))
  );
}

function isEntityNameExpressionNode(node: Node): boolean {
  if (node.kind === SyntaxKind.Identifier) return true;
  return (
    node instanceof PropertyAccessExpression &&
    node.name.kind === SyntaxKind.Identifier &&
    isEntityNameExpressionNode(node.expression)
  );
}

function getQuestionTokenOf(node: Node): Token | undefined {
  const token = getQuestionToken(node) ?? getPostfixToken(node);
  return token instanceof Token && token.kind === SyntaxKind.QuestionToken ? token : undefined;
}

/** The initializer for a literal type's value: a string, number or bigint literal. */
function literalValueToExpression(context: EmitContext, t: LiteralType): Node | undefined {
  const factory = context.factory;
  if ((t.flags & TypeFlags.StringLiteral) !== 0) return factory.createStringLiteral(t.stringValue, TokenFlags.None);
  if ((t.flags & TypeFlags.NumberLiteral) !== 0) {
    const value = t.numberValue;
    if (value === Infinity) return factory.createIdentifier('Infinity');
    if (value === -Infinity)
      return factory.created(new PrefixUnaryExpression(SyntaxKind.MinusToken, factory.createIdentifier('Infinity')));
    if (Number.isNaN(value)) return factory.createIdentifier('NaN');
    if (value < 0)
      return factory.created(
        new PrefixUnaryExpression(SyntaxKind.MinusToken, factory.createNumericLiteral(String(-value))),
      );
    return factory.createNumericLiteral(String(value));
  }
  if ((t.flags & TypeFlags.BigIntLiteral) !== 0)
    return factory.created(new BigIntLiteral(t.stringValue + 'n', TokenFlags.None));
  return undefined;
}

/** The file a module declaration or import names. */
function getExternalModuleFileFromDeclaration(c: Checker, declaration: Node): SourceFile | undefined {
  let specifier: Node | undefined = undefined;
  if (declaration.kind === SyntaxKind.ModuleDeclaration) {
    const name = getName(declaration);
    if (name !== undefined && name.kind === SyntaxKind.StringLiteral) specifier = name;
  } else specifier = getExternalModuleName(declaration);
  if (specifier === undefined) return undefined;
  const moduleSymbol = resolveExternalModuleNameWorker(c, specifier, specifier, undefined, false, false);
  if (moduleSymbol === undefined) return undefined;
  const file = getDeclarationOfKind(moduleSymbol, SyntaxKind.SourceFile);
  if (file === undefined || !(file instanceof SourceFile)) return undefined;
  return file as SourceFile;
}

function addStaticModifier(context: EmitContext, node: Node): Node {
  if (!(node instanceof IndexSignatureDeclaration)) return node;
  const factory = context.factory;
  const modifiers: Node[] = [factory.createToken(SyntaxKind.StaticKeyword)];
  if (node.modifiers !== undefined) for (const m of node.modifiers.nodes) modifiers.push(m);
  return factory.created(
    new IndexSignatureDeclaration(factory.createModifierList(modifiers), node.parameters, node.type),
  );
}
