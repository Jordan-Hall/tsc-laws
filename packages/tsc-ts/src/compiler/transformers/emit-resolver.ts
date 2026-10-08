// What emit needs to know about names: which imports are used as values and which exports
// name values. The checker provides the full answers; `SyntacticEmitResolver` answers from one
// file's syntax, as when imported modules can't be resolved.
import {
  BindingElement,
  ClassDeclaration,
  LabeledStatement,
  EnumDeclaration,
  ExportDeclaration,
  ExportAssignment,
  ExportSpecifier,
  FunctionDeclaration,
  Identifier,
  ImportClause,
  ImportEqualsDeclaration,
  ImportSpecifier,
  ModuleDeclaration,
  NamespaceImport,
  type Node,
  NodeVisitor,
  PropertyAccessExpression,
  QualifiedName,
  ShorthandPropertyAssignment,
  SourceFile,
  VariableDeclaration,
  getName,
} from '../ast.js';
import { type CompilerOptions, JsxEmit } from '../options.js';
import { SyntaxKind } from '../syntax-kind.js';
import { isTypeNodeKind } from '../printer/utilities.js';
import { isInstantiatedModule } from './utilities.js';

export abstract class EmitResolver {
  /** Called once per file before the alias queries. */
  abstract markLinkedReferences(file: SourceFile): boolean;
  /** Whether an import (clause, namespace import, specifier or `import =`) is referenced as a value. */
  abstract isReferencedAliasDeclaration(node: Node): boolean;
  /** Whether an export specifier or `export default`/`export =` names a value. */
  abstract isValueAliasDeclaration(node: Node): boolean;
  /** Whether `import x = a.b` at the top level names a value. */
  abstract isTopLevelValueImportEqualsWithEntityName(node: Node): boolean;
}

/** Collects identifiers used in value positions, skipping types. */
class ValueReferenceCollector extends NodeVisitor {
  readonly names: Set<string>;
  /** Whether the file has JSX elements, which reference the JSX factory. */
  jsx: boolean;

  constructor() {
    super();
    this.names = new Set<string>();
    this.jsx = false;
  }

  visitNode(node: Node): boolean {
    const kind = node.kind;
    if (isTypeNodeKind(kind) && kind !== SyntaxKind.ExpressionWithTypeArguments) return false;
    switch (kind) {
      case SyntaxKind.Identifier:
        if (node instanceof Identifier) this.names.add(node.text);
        return false;
      case SyntaxKind.JsxElement:
      case SyntaxKind.JsxSelfClosingElement:
      case SyntaxKind.JsxFragment:
        this.jsx = true;
        break;
      case SyntaxKind.InterfaceDeclaration:
      case SyntaxKind.TypeAliasDeclaration:
      case SyntaxKind.JSTypeAliasDeclaration:
      case SyntaxKind.ImportDeclaration:
      case SyntaxKind.JSImportDeclaration:
        return false;
      case SyntaxKind.ImportEqualsDeclaration:
        if (node instanceof ImportEqualsDeclaration && node.moduleReference.kind !== SyntaxKind.ExternalModuleReference)
          this.visitEntityName(node.moduleReference);
        return false;
      case SyntaxKind.PropertyAccessExpression:
        if (node instanceof PropertyAccessExpression) return this.visitNode(node.expression);
        break;
      case SyntaxKind.ShorthandPropertyAssignment:
        if (node instanceof ShorthandPropertyAssignment) {
          if (node.name instanceof Identifier) this.names.add(node.name.text);
          if (node.objectAssignmentInitializer !== undefined) this.visitNode(node.objectAssignmentInitializer);
          return false;
        }
        break;
      case SyntaxKind.ExportSpecifier:
        if (node instanceof ExportSpecifier) {
          const local = node.propertyName !== undefined ? node.propertyName : node.name;
          if (local instanceof Identifier && !node.isTypeOnly) this.names.add(local.text);
          return false;
        }
        break;
      case SyntaxKind.ExportDeclaration:
        // Re-exports from other modules don't reference local names.
        if (node instanceof ExportDeclaration && node.moduleSpecifier !== undefined) return false;
        break;
      case SyntaxKind.PropertyAssignment:
      case SyntaxKind.PropertyDeclaration:
      case SyntaxKind.MethodDeclaration:
      case SyntaxKind.GetAccessor:
      case SyntaxKind.SetAccessor:
      case SyntaxKind.EnumMember:
      // Declared names and labels aren't references.
      case SyntaxKind.Parameter:
      case SyntaxKind.VariableDeclaration:
      case SyntaxKind.FunctionDeclaration:
      case SyntaxKind.FunctionExpression:
      case SyntaxKind.ClassDeclaration:
      case SyntaxKind.ClassExpression:
      case SyntaxKind.EnumDeclaration:
      case SyntaxKind.ModuleDeclaration:
      case SyntaxKind.LabeledStatement:
      case SyntaxKind.JsxAttribute:
      case SyntaxKind.MetaProperty:
        return this.visitChildrenExceptName(node);
      case SyntaxKind.BindingElement:
        if (node instanceof BindingElement) {
          if (node.name !== undefined && node.name.kind !== SyntaxKind.Identifier) this.visitNode(node.name);
          if (node.propertyName !== undefined && node.propertyName.kind === SyntaxKind.ComputedPropertyName)
            this.visitNode(node.propertyName);
          if (node.initializer !== undefined) this.visitNode(node.initializer);
          return false;
        }
        break;
      case SyntaxKind.BreakStatement:
      case SyntaxKind.ContinueStatement:
        return false;
    }
    return node.forEachChild(this);
  }

  private visitEntityName(node: Node): boolean {
    if (node instanceof Identifier) this.names.add(node.text);
    else if (node instanceof QualifiedName) this.visitEntityName(node.left);
    return false;
  }

  private visitChildrenExceptName(node: Node): boolean {
    const name = node instanceof LabeledStatement ? node.label : getName(node);
    if (
      name !== undefined &&
      (name.kind === SyntaxKind.ComputedPropertyName ||
        name.kind === SyntaxKind.ObjectBindingPattern ||
        name.kind === SyntaxKind.ArrayBindingPattern)
    )
      return node.forEachChild(this);
    const skipper = new ChildSkipper(this, name);
    return node.forEachChild(skipper);
  }
}

class ChildSkipper extends NodeVisitor {
  readonly target: NodeVisitor;
  readonly skip: Node | undefined;

  constructor(target: NodeVisitor, skip: Node | undefined) {
    super();
    this.target = target;
    this.skip = skip;
  }

  visitNode(node: Node): boolean {
    return node === this.skip ? false : this.target.visitNode(node);
  }
}

export class SyntacticEmitResolver extends EmitResolver {
  readonly options: CompilerOptions;
  private file: SourceFile | undefined;
  private references: Set<string>;
  /** Top-level declarations by name: true if any declares a value. */
  private declarations: Map<string, boolean>;

  constructor(options: CompilerOptions) {
    super();
    this.options = options;
    this.file = undefined;
    this.references = new Set<string>();
    this.declarations = new Map<string, boolean>();
  }

  markLinkedReferences(file: SourceFile): boolean {
    if (this.file === file) return false;
    this.file = file;
    const collector = new ValueReferenceCollector();
    file.forEachChild(collector);
    this.references = collector.names;
    if (collector.jsx && this.options.jsx !== JsxEmit.ReactJSX && this.options.jsx !== JsxEmit.ReactJSXDev)
      this.references.add(jsxNamespace(file, this.options));
    const declarations = new Map<string, boolean>();
    const statements = file.statements.nodes;
    for (let i = 0; i < statements.length; i++) recordDeclaration(declarations, statements[i]);
    this.declarations = declarations;
    return true;
  }

  isReferencedAliasDeclaration(node: Node): boolean {
    if (node instanceof ImportClause) return node.name !== undefined && this.references.has(node.name.text);
    if (node instanceof NamespaceImport) return this.references.has(node.name.text);
    if (node instanceof ImportSpecifier) return !node.isTypeOnly && this.references.has(node.name.text);
    if (node instanceof ImportEqualsDeclaration) return !node.isTypeOnly && this.references.has(node.name.text);
    return true;
  }

  isValueAliasDeclaration(node: Node): boolean {
    if (node instanceof ExportSpecifier) {
      if (node.isTypeOnly) return false;
      const local = node.propertyName !== undefined ? node.propertyName : node.name;
      if (!(local instanceof Identifier)) return true;
      const declaration = node.parent === undefined ? undefined : node.parent.parent;
      if (declaration instanceof ExportDeclaration && declaration.moduleSpecifier !== undefined) return true;
      const value = this.declarations.get(local.text);
      return value === undefined || value;
    }
    if (node instanceof ExportAssignment) {
      const expression = node.expression;
      if (!(expression instanceof Identifier)) return true;
      const value = this.declarations.get(expression.text);
      return value === undefined || value;
    }
    return true;
  }

  isTopLevelValueImportEqualsWithEntityName(node: Node): boolean {
    return (
      node instanceof ImportEqualsDeclaration &&
      !node.isTypeOnly &&
      node.moduleReference.kind !== SyntaxKind.ExternalModuleReference
    );
  }
}

function recordDeclaration(declarations: Map<string, boolean>, statement: Node): boolean {
  let value: boolean;
  switch (statement.kind) {
    case SyntaxKind.InterfaceDeclaration:
    case SyntaxKind.TypeAliasDeclaration:
    case SyntaxKind.JSTypeAliasDeclaration:
      value = false;
      break;
    case SyntaxKind.ModuleDeclaration:
      value = statement instanceof ModuleDeclaration && isInstantiatedModule(statement, false);
      break;
    case SyntaxKind.VariableStatement: {
      const names: string[] = [];
      collectVariableNames(statement, names);
      for (let i = 0; i < names.length; i++) declarations.set(names[i], true);
      return true;
    }
    case SyntaxKind.ImportDeclaration:
    case SyntaxKind.ImportEqualsDeclaration:
      // An imported name might be a type or a value.
      return false;
    default:
      value =
        statement instanceof FunctionDeclaration ||
        statement instanceof ClassDeclaration ||
        statement instanceof EnumDeclaration;
  }
  const name = getName(statement);
  if (!(name instanceof Identifier)) return false;
  const existing = declarations.get(name.text);
  declarations.set(name.text, existing === true || value);
  return true;
}

function collectVariableNames(node: Node, names: string[]): boolean {
  if (node instanceof VariableDeclaration) {
    if (node.name instanceof Identifier) names.push(node.name.text);
    return false;
  }
  const collector = new VariableNameCollector(names);
  node.forEachChild(collector);
  return true;
}

class VariableNameCollector extends NodeVisitor {
  readonly names: string[];

  constructor(names: string[]) {
    super();
    this.names = names;
  }

  visitNode(node: Node): boolean {
    if (node instanceof VariableDeclaration) {
      if (node.name instanceof Identifier) this.names.push(node.name.text);
      return false;
    }
    return node.forEachChild(this);
  }
}

/** The root name of the JSX factory: from an `@jsx` pragma, `jsxFactory`, `reactNamespace` or `React`. */
function jsxNamespace(file: SourceFile, options: CompilerOptions): string {
  for (let i = 0; i < file.pragmas.length; i++) {
    const pragma = file.pragmas[i];
    if (pragma.name !== 'jsx') continue;
    const factory = pragma.args.get('factory');
    if (factory !== undefined) return rootName(factory.value);
  }
  if (options.jsxFactory !== undefined && options.jsxFactory !== '') return rootName(options.jsxFactory);
  if (options.reactNamespace !== undefined && options.reactNamespace !== '') return options.reactNamespace;
  return 'React';
}

function rootName(entityName: string): string {
  const dot = entityName.indexOf('.');
  return dot < 0 ? entityName : entityName.substring(0, dot);
}
