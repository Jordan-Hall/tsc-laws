// The symbol tracker of declaration emit: collects its diagnostics and the unexported
// declarations that names in the output refer to.
import { BinaryExpression, ExportAssignment, Identifier, type Node, type SourceFile, getExpression } from '../ast.js';
import { getNameOfDeclaration, getSourceFileOfNode } from '../binder-utilities.js';
import { type Diagnostic, type DiagnosticMessage, Diagnostics } from '../diagnostics.js';
import { SyntaxKind } from '../syntax-kind.js';
import {
  DiagnosticContext,
  createDiagnosticForNode,
  createIsolatedDeclarationError,
  getSymbolAccessibilityDiagnostic,
  nameToString,
  noDiagnosticContext,
  textOfNode,
} from './declarations-diagnostics.js';
import {
  type DeclarationEmitResolver,
  SymbolAccessibility,
  type SymbolAccessibilityResult,
  SymbolTracker,
} from './declarations-resolver.js';
import { getDeclarations, type Symbol, SymbolFlags } from '../symbol.js';

export class DeclarationTracker extends SymbolTracker {
  readonly resolver: DeclarationEmitResolver;
  readonly isolatedDeclarations: boolean;
  readonly stripInternal: boolean;
  diagnostics: Diagnostic[];
  /** Unexported statements that names in the output refer to, to emit after the first pass. */
  lateMarkedStatements: Node[];
  /** How inaccessible names in the declaration being written are reported. */
  diagnosticContext: DiagnosticContext;
  /** The name of the declaration being written, where errors are reported. */
  errorNameNode: Node | undefined;
  currentSourceFile: SourceFile | undefined;
  /** A class expression whose own name is allowed in its members' types; see `classSymbolTracked`. */
  watchedClassSymbol: Symbol | undefined;
  classSymbolTracked: boolean;
  private readonly fallbackStack: Node[];

  constructor(resolver: DeclarationEmitResolver, isolatedDeclarations: boolean, stripInternal: boolean) {
    super();
    this.resolver = resolver;
    this.isolatedDeclarations = isolatedDeclarations;
    this.stripInternal = stripInternal;
    this.diagnostics = [];
    this.lateMarkedStatements = [];
    this.diagnosticContext = noDiagnosticContext;
    this.errorNameNode = undefined;
    this.currentSourceFile = undefined;
    this.watchedClassSymbol = undefined;
    this.classSymbolTracked = false;
    this.fallbackStack = [];
  }

  addDiagnostic(diagnostic: Diagnostic): boolean {
    this.diagnostics.push(diagnostic);
    return true;
  }

  pushErrorFallbackNode(node: Node): boolean {
    this.fallbackStack.push(node);
    return true;
  }

  popErrorFallbackNode(): boolean {
    this.fallbackStack.pop();
    return true;
  }

  private errorFallbackNode(): Node | undefined {
    const stack = this.fallbackStack;
    return stack.length > 0 ? stack[stack.length - 1] : undefined;
  }

  private errorLocation(): Node | undefined {
    return this.errorNameNode ?? this.errorFallbackNode();
  }

  private errorDeclarationName(): string {
    if (this.errorNameNode !== undefined) return nameToString(this.errorNameNode);
    const fallback = this.errorFallbackNode();
    if (fallback !== undefined) {
      const name = getNameOfDeclaration(fallback);
      if (name !== undefined) return nameToString(name);
      if (fallback instanceof ExportAssignment) return fallback.isExportEquals ? 'export=' : 'default';
    }
    return '(Missing)';
  }

  private reportAtErrorLocation(message: DiagnosticMessage, args: string[]): boolean {
    const location = this.errorLocation();
    if (location === undefined) return false;
    return this.addDiagnostic(createDiagnosticForNode(location, message, args));
  }

  reportCyclicStructureError(): boolean {
    return this.reportAtErrorLocation(
      Diagnostics.The_inferred_type_of_0_references_a_type_with_a_cyclic_structure_which_cannot_be_trivially_serialized_A_type_annotation_is_necessary,
      [this.errorDeclarationName()],
    );
  }

  reportInaccessibleThisError(): boolean {
    return this.reportAtErrorLocation(
      Diagnostics.The_inferred_type_of_0_references_an_inaccessible_1_type_A_type_annotation_is_necessary,
      [this.errorDeclarationName(), 'this'],
    );
  }

  reportInaccessibleUniqueSymbolError(): boolean {
    return this.reportAtErrorLocation(
      Diagnostics.The_inferred_type_of_0_references_an_inaccessible_1_type_A_type_annotation_is_necessary,
      [this.errorDeclarationName(), 'unique symbol'],
    );
  }

  reportLikelyUnsafeImportRequiredError(specifier: string, symbolName: string): boolean {
    if (symbolName !== '')
      return this.reportAtErrorLocation(
        Diagnostics.The_inferred_type_of_0_cannot_be_named_without_a_reference_to_2_from_1_This_is_likely_not_portable_A_type_annotation_is_necessary,
        [this.errorDeclarationName(), specifier, symbolName],
      );
    return this.reportAtErrorLocation(
      Diagnostics.The_inferred_type_of_0_cannot_be_named_without_a_reference_to_1_This_is_likely_not_portable_A_type_annotation_is_necessary,
      [this.errorDeclarationName(), specifier],
    );
  }

  reportNonSerializableProperty(propertyName: string): boolean {
    return this.reportAtErrorLocation(
      Diagnostics.The_type_of_this_node_cannot_be_serialized_because_its_property_0_cannot_be_serialized,
      [propertyName],
    );
  }

  reportPrivateInBaseOfClassExpression(propertyName: string): boolean {
    const location = this.errorLocation();
    if (location === undefined) return false;
    const diagnostic = createDiagnosticForNode(
      location,
      Diagnostics.Property_0_of_exported_anonymous_class_type_may_not_be_private_or_protected,
      [propertyName],
    );
    if (location.parent !== undefined && location.parent.kind === SyntaxKind.VariableDeclaration)
      diagnostic.addRelatedInfo(
        createDiagnosticForNode(location, Diagnostics.Add_a_type_annotation_to_the_variable_0, [
          this.errorDeclarationName(),
        ]),
      );
    return this.addDiagnostic(diagnostic);
  }

  reportTruncationError(): boolean {
    return this.reportAtErrorLocation(
      Diagnostics.The_inferred_type_of_this_node_exceeds_the_maximum_length_the_compiler_will_serialize_An_explicit_type_annotation_is_needed,
      [],
    );
  }

  reportNonlocalAugmentation(containingFile: SourceFile, parentSymbol: Symbol, augmentingSymbol: Symbol): boolean {
    let primary: Node | undefined = undefined;
    for (const declaration of getDeclarations(parentSymbol))
      if (getSourceFileOfNode(declaration) === containingFile) {
        primary = declaration;
        break;
      }
    if (primary === undefined) return false;
    for (const augmentation of getDeclarations(augmentingSymbol)) {
      if (getSourceFileOfNode(augmentation) === containingFile) continue;
      const diagnostic = createDiagnosticForNode(
        augmentation,
        Diagnostics.Declaration_augments_declaration_in_another_file_This_cannot_be_serialized,
        [],
      );
      diagnostic.addRelatedInfo(
        createDiagnosticForNode(
          primary,
          Diagnostics.This_is_the_declaration_being_augmented_Consider_moving_the_augmenting_declaration_into_the_same_file,
          [],
        ),
      );
      this.addDiagnostic(diagnostic);
    }
    return true;
  }

  reportInferenceFallback(node: Node): boolean {
    if (!this.isolatedDeclarations || getSourceFileOfNode(node) !== this.currentSourceFile) return false;
    if (this.resolver.isExpandoFunctionDeclaration(node)) this.reportExpandoFunctionErrors(node);
    // Expando properties get an error when their function is reported; skip follow-on errors.
    if (this.isChildOfBoundExpando(node)) return false;
    return this.addDiagnostic(
      createIsolatedDeclarationError(
        node,
        node.kind === SyntaxKind.Parameter && this.resolver.requiresAddingImplicitUndefined(node, undefined),
      ),
    );
  }

  /** Under isolatedDeclarations, reports the properties assigned to a function. */
  reportExpandoFunctionErrors(node: Node): boolean {
    if (!this.isolatedDeclarations) return false;
    for (const declaration of this.resolver.getExpandoPropertyDeclarations(node)) {
      const target = declaration instanceof BinaryExpression ? declaration.left : declaration;
      this.addDiagnostic(
        createDiagnosticForNode(
          target,
          Diagnostics.Assigning_properties_to_functions_without_declaring_them_is_not_supported_with_isolatedDeclarations_Add_an_explicit_declaration_for_the_properties_assigned_to_this_function,
          [],
        ),
      );
    }
    return true;
  }

  private isChildOfBoundExpando(node: Node): boolean {
    for (let current: Node | undefined = node; current !== undefined; current = current.parent) {
      if (current.kind === SyntaxKind.SourceFile || current.kind === SyntaxKind.Block) return false;
      if (this.isBoundExpando(current)) return true;
    }
    return false;
  }

  private isBoundExpando(node: Node): boolean {
    if (!(node instanceof BinaryExpression) || node.left.kind !== SyntaxKind.PropertyAccessExpression) return false;
    if (node.operatorToken.kind !== SyntaxKind.EqualsToken) return false;
    let leftmost = node.left;
    while (
      leftmost.kind === SyntaxKind.PropertyAccessExpression ||
      leftmost.kind === SyntaxKind.ElementAccessExpression
    )
      leftmost = getExpression(leftmost)!;
    if (!(leftmost instanceof Identifier)) return false;
    const declaration = this.resolver.getReferencedValueDeclaration(leftmost);
    return declaration !== undefined && this.resolver.isExpandoFunctionDeclaration(declaration);
  }

  trackSymbol(symbol: Symbol, enclosingDeclaration: Node, meaning: SymbolFlags): boolean {
    if ((symbol.flags & SymbolFlags.TypeParameter) !== 0) return false;
    // A class expression's own name is handled by wrapping it in a namespace.
    if (symbol === this.watchedClassSymbol) {
      this.classSymbolTracked = true;
      return false;
    }
    return this.handleSymbolAccessibilityError(
      this.resolver.isSymbolAccessible(symbol, enclosingDeclaration, meaning, true),
    );
  }

  /** Queues aliases an accessible name needs, or reports an inaccessible one; true if reported. */
  handleSymbolAccessibilityError(result: SymbolAccessibilityResult): boolean {
    if (result.accessibility === SymbolAccessibility.Accessible) {
      for (const alias of result.aliasesToMakeVisible)
        if (this.lateMarkedStatements.indexOf(alias) < 0) this.lateMarkedStatements.push(alias);
      return false;
    }
    // The checker reports unresolved names.
    if (result.accessibility === SymbolAccessibility.NotResolved) return false;
    const info = getSymbolAccessibilityDiagnostic(this.diagnosticContext, result);
    if (info === undefined) return false;
    const node = result.errorNode ?? info.errorNode;
    const args =
      info.typeName !== undefined
        ? [textOfNode(info.typeName), result.errorSymbolName, result.errorModuleName]
        : [result.errorSymbolName, result.errorModuleName];
    return this.addDiagnostic(createDiagnosticForNode(node, info.message, args));
  }
}
