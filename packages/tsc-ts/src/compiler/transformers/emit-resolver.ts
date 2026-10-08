// What emit needs to know about names: which imports are used as values, which exports name
// values, what identifiers refer to and constant values of enum members. The checker provides
// the full answers; `SyntacticEmitResolver` answers from syntax and the binder's symbols.
import {
  ExportAssignment,
  ExportSpecifier,
  Identifier,
  ImportClause,
  ImportEqualsDeclaration,
  ImportSpecifier,
  NamespaceImport,
  type EntityName,
  type Node,
  type Pragma,
  ScriptKind,
  SourceFile,
  getSymbol,
  ModifierFlags,
} from '../ast.js';
import type { CompilerOptions } from '../options.js';
import { parseIsolatedEntityName } from '../parser.js';
import { getJSXImplicitImportBase, getJSXRuntimeImport } from '../program-utilities.js';
import { isParseTreeNode } from '../printer/utilities.js';
import type { Symbol } from '../symbol.js';
import { SyntaxKind } from '../syntax-kind.js';
import { nodeIsMissing } from '../ast-utilities.js';
import { AliasReferences } from './alias-references.js';
import type { Evaluation, ReferenceResolver } from './reference-resolver.js';
import { type TypeReferenceSerializationKind, getTypeReferenceSerializationKind } from './type-serialization.js';
import { hasSyntacticModifier } from './utilities.js';

export abstract class EmitResolver {
  /** Called once per file before the alias queries. */
  abstract markLinkedReferences(file: SourceFile): boolean;
  /** Whether an import (clause, namespace import, specifier or `import =`) is referenced as a value. */
  abstract isReferencedAliasDeclaration(node: Node): boolean;
  /** Whether an export specifier or `export default`/`export =` names a value. */
  abstract isValueAliasDeclaration(node: Node): boolean;
  /** Whether `import x = a.b` at the top level names a value. */
  abstract isTopLevelValueImportEqualsWithEntityName(node: Node): boolean;
  /** How decorator metadata serializes a reference to `typeName`, resolved from `location`. */
  abstract getTypeReferenceSerializationKind(
    typeName: Node,
    location: Node | undefined,
  ): TypeReferenceSerializationKind;
  /** The source file, namespace or enum exporting what `node` refers to; with `prefixLocals`, also exports with a local name. */
  abstract getReferencedExportContainer(node: Identifier, prefixLocals: boolean): Node | undefined;
  /** The import declaring the alias `node` refers to. */
  abstract getReferencedImportDeclaration(node: Identifier): Node | undefined;
  abstract getReferencedValueDeclaration(node: Identifier): Node | undefined;
  abstract getReferencedValueDeclarations(node: Identifier): Node[] | undefined;
  /** The constant value of an enum member. */
  abstract getEnumMemberValue(member: Node): Evaluation;
  /** Records the import a generated name such as the JSX transform's `_jsx` refers to. */
  abstract setReferencedImportDeclaration(name: Identifier, declaration: Node): void;
  /** The JSX factory from an `@jsx` pragma or `jsxFactory`, if either is an entity name. */
  abstract getJsxFactoryEntity(file: SourceFile): EntityName | undefined;
  /** The JSX fragment factory from an `@jsxFrag` pragma or `jsxFragmentFactory`. */
  abstract getJsxFragmentFactoryEntity(file: SourceFile): EntityName | undefined;
  /** The value to inline for a const enum member access such as `E.A`. */
  abstract getConstantValue(node: Node): Evaluation;
}

export class SyntacticEmitResolver extends EmitResolver {
  readonly options: CompilerOptions;
  readonly referenceResolver: ReferenceResolver;
  private file: SourceFile | undefined;
  /** Aliases of the current file used as values. */
  private referenced: Set<Symbol>;
  /** Imports referenced by generated names. */
  private readonly generatedImports: Map<Node, Node>;

  constructor(options: CompilerOptions, referenceResolver: ReferenceResolver) {
    super();
    this.options = options;
    this.referenceResolver = referenceResolver;
    this.file = undefined;
    this.referenced = new Set<Symbol>();
    this.generatedImports = new Map<Node, Node>();
  }

  markLinkedReferences(file: SourceFile): boolean {
    if (this.file === file) return false;
    this.file = file;
    const marker = new AliasReferences(
      this.options,
      this.referenceResolver,
      jsxNamespace(file, this.options),
      jsxFragmentNamespace(file, this.options),
      this.jsxRuntimeResolves(file),
    );
    marker.markFile(file);
    this.referenced = marker.referenced;
    return true;
  }

  private jsxRuntimeResolves(file: SourceFile): boolean {
    if (file.scriptKind !== ScriptKind.JSX && file.scriptKind !== ScriptKind.TSX) return false;
    const runtime = getJSXRuntimeImport(getJSXImplicitImportBase(this.options, file), this.options);
    return runtime !== '' && this.referenceResolver.resolveImplicitImport(file, runtime) !== undefined;
  }

  isReferencedAliasDeclaration(node: Node): boolean {
    if (node instanceof ImportClause) return node.name !== undefined && this.isReferencedAlias(node);
    if (node instanceof NamespaceImport) return this.isReferencedAlias(node);
    if (node instanceof ImportSpecifier) return !node.isTypeOnly && this.isReferencedAlias(node);
    if (node instanceof ImportEqualsDeclaration) {
      if (node.isTypeOnly) return false;
      if (this.isReferencedAlias(node)) return true;
      // `export import x = a.b` is referenced by its export when it names a value.
      return hasSyntacticModifier(node, ModifierFlags.Export) && this.isAliasOfValue(node, false);
    }
    return true;
  }

  /** Whether the alias declared by `node` is used as a value. */
  private isReferencedAlias(node: Node): boolean {
    const symbol = this.referenceResolver.getSymbolOfDeclaration(node);
    return symbol !== undefined && this.referenced.has(symbol);
  }

  /** Whether the alias declared by `node` resolves to a value; `unresolved` if it doesn't resolve. */
  private isAliasOfValue(node: Node, unresolved: boolean): boolean {
    const symbol = this.referenceResolver.getSymbolOfDeclaration(node);
    if (symbol === undefined) return false;
    if (this.referenceResolver.resolveAlias(symbol) === undefined) return unresolved;
    return this.referenceResolver.isAliasResolvedToValue(symbol, false);
  }

  isValueAliasDeclaration(node: Node): boolean {
    if (node instanceof ExportSpecifier) {
      if (node.isTypeOnly) return false;
      const symbol = getSymbol(node);
      return symbol === undefined || this.referenceResolver.isAliasResolvedToValue(symbol, true);
    }
    if (node instanceof ExportAssignment) {
      if (!(node.expression instanceof Identifier)) return true;
      const symbol = getSymbol(node);
      return symbol === undefined || this.referenceResolver.isAliasResolvedToValue(symbol, true);
    }
    return true;
  }

  isTopLevelValueImportEqualsWithEntityName(node: Node): boolean {
    if (
      !(node instanceof ImportEqualsDeclaration) ||
      node.isTypeOnly ||
      node.moduleReference.kind === SyntaxKind.ExternalModuleReference ||
      nodeIsMissing(node.moduleReference) ||
      !(node.parent instanceof SourceFile)
    )
      return false;
    // An unresolved target might be a value.
    return this.isAliasOfValue(node, true);
  }

  getTypeReferenceSerializationKind(typeName: Node, location: Node | undefined): TypeReferenceSerializationKind {
    return getTypeReferenceSerializationKind(this.referenceResolver, typeName, location);
  }

  getReferencedExportContainer(node: Identifier, prefixLocals: boolean): Node | undefined {
    return this.referenceResolver.getReferencedExportContainer(node, prefixLocals);
  }

  getReferencedImportDeclaration(node: Identifier): Node | undefined {
    if (!isParseTreeNode(node)) return this.generatedImports.get(node as Node);
    return this.referenceResolver.getReferencedImportDeclaration(node);
  }

  getReferencedValueDeclaration(node: Identifier): Node | undefined {
    return this.referenceResolver.getReferencedValueDeclaration(node);
  }

  getReferencedValueDeclarations(node: Identifier): Node[] | undefined {
    return this.referenceResolver.getReferencedValueDeclarations(node);
  }

  getEnumMemberValue(member: Node): Evaluation {
    return this.referenceResolver.getEnumMemberValue(member);
  }

  getConstantValue(node: Node): Evaluation {
    return this.referenceResolver.getConstantValue(node);
  }

  setReferencedImportDeclaration(name: Identifier, declaration: Node): void {
    this.generatedImports.set(name, declaration);
  }

  getJsxFactoryEntity(file: SourceFile): EntityName | undefined {
    const pragma = lastPragma(file, 'jsx');
    if (pragma !== undefined) {
      const entity = parseIsolatedEntityName(pragmaArgument(pragma, 'factory'));
      if (entity !== undefined) return entity;
    }
    const option = this.options.jsxFactory;
    return option !== undefined && option !== '' ? parseIsolatedEntityName(option) : undefined;
  }

  getJsxFragmentFactoryEntity(file: SourceFile): EntityName | undefined {
    const pragma = lastPragma(file, 'jsxfrag');
    if (pragma !== undefined) return parseIsolatedEntityName(pragmaArgument(pragma, 'factory'));
    const option = this.options.jsxFragmentFactory;
    return option !== undefined && option !== '' ? parseIsolatedEntityName(option) : undefined;
  }
}

/** The root name of the JSX factory: from an `@jsx` pragma, `jsxFactory`, `reactNamespace` or `React`. */
function jsxNamespace(file: SourceFile, options: CompilerOptions): string {
  const factory = pragmaFactory(file, 'jsx');
  return factory !== undefined ? rootName(factory) : defaultJsxNamespace(options);
}

/** The root name of the JSX fragment factory: from an `@jsxFrag` pragma or `jsxFragmentFactory`. */
function jsxFragmentNamespace(file: SourceFile, options: CompilerOptions): string {
  const factory = pragmaFactory(file, 'jsxfrag');
  if (factory !== undefined) return isEntityName(factory) ? rootName(factory) : defaultJsxNamespace(options);
  const option = options.jsxFragmentFactory;
  if (option !== undefined && option !== '' && isEntityName(option)) return rootName(option);
  return defaultJsxNamespace(options);
}

function defaultJsxNamespace(options: CompilerOptions): string {
  if (options.jsxFactory !== undefined && options.jsxFactory !== '') return rootName(options.jsxFactory);
  if (options.reactNamespace !== undefined && options.reactNamespace !== '') return options.reactNamespace;
  return 'React';
}

function pragmaFactory(file: SourceFile, name: string): string | undefined {
  for (let i = 0; i < file.pragmas.length; i++) {
    const pragma = file.pragmas[i];
    if (pragma.name !== name) continue;
    const factory = pragma.args.get('factory');
    if (factory !== undefined) return factory.value;
  }
  return undefined;
}

/** The last pragma named `name`, which wins over earlier ones. */
function lastPragma(file: SourceFile, name: string): Pragma | undefined {
  let result: Pragma | undefined = undefined;
  for (let i = 0; i < file.pragmas.length; i++) if (file.pragmas[i].name === name) result = file.pragmas[i];
  return result;
}

function pragmaArgument(pragma: Pragma | undefined, name: string): string {
  if (pragma === undefined) return '';
  const argument = pragma.args.get(name);
  return argument !== undefined ? argument.value : '';
}

function isEntityName(text: string): boolean {
  return /^[A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*)*$/.test(text);
}

function rootName(entityName: string): string {
  const dot = entityName.indexOf('.');
  return dot < 0 ? entityName : entityName.substring(0, dot);
}
