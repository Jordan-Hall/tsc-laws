// Node predicates the transforms share.
import {
  AsExpression,
  ExportDeclaration,
  ExportSpecifier,
  Identifier,
  ModifierFlags,
  ModuleBlock,
  ModuleDeclaration,
  NamedExports,
  type Node,
  NodeFlags,
  ParameterDeclaration,
  ParenthesizedExpression,
  SourceFile,
  Block,
  VariableStatement,
  ShorthandPropertyAssignment,
  ForStatement,
  ImportEqualsDeclaration,
  ConditionalExpression,
  TaggedTemplateExpression,
  ImportAttribute,
  getArguments,
  getBody,
  getExpression,
  getInitializer,
  getModifiers,
  getName,
  getStatements,
  getTagName,
} from '../ast.js';
import type { NodeFactory } from '../printer/factory.js';
import { SyntaxKind } from '../syntax-kind.js';

export function modifierFlagsOf(node: Node): ModifierFlags {
  const modifiers = getModifiers(node);
  return modifiers === undefined ? ModifierFlags.None : modifiers.modifierFlags;
}

export function hasSyntacticModifier(node: Node, flags: ModifierFlags): boolean {
  return (modifierFlagsOf(node) & flags) !== 0;
}

export function hasDecorators(node: Node): boolean {
  return hasSyntacticModifier(node, ModifierFlags.Decorator);
}

export function isThisParameter(node: Node): boolean {
  return node instanceof ParameterDeclaration && node.name instanceof Identifier && node.name.text === 'this';
}

export function isParameterPropertyDeclaration(node: Node, parent: Node | undefined): boolean {
  return (
    node instanceof ParameterDeclaration &&
    hasSyntacticModifier(node, ModifierFlags.ParameterPropertyModifier) &&
    parent !== undefined &&
    parent.kind === SyntaxKind.Constructor
  );
}

/** `/** @type {T} *\/ (expr)` in a JavaScript file. */
export function isJSDocTypeAssertion(node: Node): boolean {
  if (!(node instanceof ParenthesizedExpression) || (node.flags & NodeFlags.JavaScriptFile) === 0) return false;
  const expression = node.expression;
  return expression instanceof AsExpression && (expression.type.flags & NodeFlags.Reparsed) !== 0;
}

export function isExternalModule(file: SourceFile): boolean {
  return file.externalModuleIndicator !== undefined;
}

export function getInnermostModuleDeclaration(node: ModuleDeclaration): ModuleDeclaration {
  let body = node.body;
  while (body instanceof ModuleDeclaration) {
    node = body as ModuleDeclaration;
    body = node.body;
  }
  return node;
}

export const enum ModuleInstanceState {
  Unknown,
  NonInstantiated,
  Instantiated,
  ConstEnumOnly,
}

/** Whether a namespace has runtime content, from its syntax alone. */
export function getModuleInstanceState(node: ModuleDeclaration): ModuleInstanceState {
  return new ModuleInstanceStates().ofModule(node, []);
}

export function isInstantiatedModule(node: ModuleDeclaration, preserveConstEnums: boolean): boolean {
  const state = getModuleInstanceState(node);
  return (
    state === ModuleInstanceState.Instantiated || (preserveConstEnums && state === ModuleInstanceState.ConstEnumOnly)
  );
}

class ModuleInstanceStates {
  private readonly visited: Map<Node, ModuleInstanceState>;

  constructor() {
    this.visited = new Map<Node, ModuleInstanceState>();
  }

  ofModule(node: ModuleDeclaration, ancestors: Node[]): ModuleInstanceState {
    const body = node.body;
    if (body === undefined) return ModuleInstanceState.Instantiated;
    const self: Node = node;
    return this.cached(body, ancestors.concat([self]));
  }

  private cached(node: Node, ancestors: Node[]): ModuleInstanceState {
    const cached = this.visited.get(node);
    if (cached !== undefined)
      return cached !== ModuleInstanceState.Unknown ? cached : ModuleInstanceState.NonInstantiated;
    this.visited.set(node, ModuleInstanceState.Unknown);
    const result = this.worker(node, ancestors);
    this.visited.set(node, result);
    return result;
  }

  private worker(node: Node, ancestors: Node[]): ModuleInstanceState {
    switch (node.kind) {
      case SyntaxKind.InterfaceDeclaration:
      case SyntaxKind.TypeAliasDeclaration:
      case SyntaxKind.JSTypeAliasDeclaration:
        return ModuleInstanceState.NonInstantiated;
      case SyntaxKind.EnumDeclaration:
        if (hasSyntacticModifier(node, ModifierFlags.Const)) return ModuleInstanceState.ConstEnumOnly;
        break;
      case SyntaxKind.ImportDeclaration:
      case SyntaxKind.JSImportDeclaration:
      case SyntaxKind.ImportEqualsDeclaration:
        if (!hasSyntacticModifier(node, ModifierFlags.Export)) return ModuleInstanceState.NonInstantiated;
        break;
      case SyntaxKind.ExportDeclaration:
        if (
          node instanceof ExportDeclaration &&
          node.moduleSpecifier === undefined &&
          node.exportClause instanceof NamedExports
        ) {
          let state = ModuleInstanceState.NonInstantiated;
          const declaration: Node = node;
          const clause: Node = node.exportClause;
          const inner = ancestors.concat([declaration, clause]);
          const elements = node.exportClause.elements.nodes;
          for (let i = 0; i < elements.length; i++) {
            const specifier = elements[i];
            if (!(specifier instanceof ExportSpecifier)) continue;
            const specifierState = this.ofAliasTarget(specifier as ExportSpecifier, inner);
            if (specifierState > state) state = specifierState;
            if (state === ModuleInstanceState.Instantiated) return state;
          }
          return state;
        }
        break;
      case SyntaxKind.ModuleBlock:
        if (node instanceof ModuleBlock) {
          let state = ModuleInstanceState.NonInstantiated;
          const block: Node = node;
          const inner = ancestors.concat([block]);
          const statements = node.statements.nodes;
          for (let i = 0; i < statements.length; i++) {
            const child = this.cached(statements[i], inner);
            if (child === ModuleInstanceState.ConstEnumOnly) state = child;
            else if (child === ModuleInstanceState.Instantiated) return child;
          }
          return state;
        }
        break;
      case SyntaxKind.ModuleDeclaration:
        if (node instanceof ModuleDeclaration) return this.ofModule(node, ancestors);
        break;
    }
    return ModuleInstanceState.Instantiated;
  }

  private ofAliasTarget(specifier: ExportSpecifier, ancestors: Node[]): ModuleInstanceState {
    const name = specifier.propertyName !== undefined ? specifier.propertyName : specifier.name;
    if (!(name instanceof Identifier)) return ModuleInstanceState.Instantiated;
    for (let a = ancestors.length - 1; a >= 0; a--) {
      const p = ancestors[a];
      const statementList = getStatements(p);
      if (statementList === undefined || !(p instanceof Block || p instanceof ModuleBlock || p instanceof SourceFile))
        continue;
      let found = ModuleInstanceState.Unknown;
      const inner = ancestors.slice(0, a + 1);
      const statements = statementList.nodes;
      for (let i = 0; i < statements.length; i++) {
        const statement = statements[i];
        if (!nodeHasName(statement, name.text)) continue;
        const state = this.cached(statement, inner);
        if (found === ModuleInstanceState.Unknown || state > found) found = state;
        if (found === ModuleInstanceState.Instantiated) return found;
        if (statement.kind === SyntaxKind.ImportEqualsDeclaration) found = ModuleInstanceState.Instantiated;
      }
      if (found !== ModuleInstanceState.Unknown) return found;
    }
    return ModuleInstanceState.Instantiated;
  }
}

function nodeHasName(statement: Node, text: string): boolean {
  const name = getName(statement);
  if (name !== undefined) return name instanceof Identifier && name.text === text;
  if (statement instanceof VariableStatement) {
    const declarations = statement.declarationList.declarations.nodes;
    for (let i = 0; i < declarations.length; i++) if (nodeHasName(declarations[i], text)) return true;
  }
  return false;
}

/** Whether `name` is used as a value in `parent`, rather than declared or as a property name. */
export function isIdentifierReference(name: Node, parent: Node | undefined): boolean {
  if (parent === undefined) return false;
  switch (parent.kind) {
    case SyntaxKind.BinaryExpression:
    case SyntaxKind.PrefixUnaryExpression:
    case SyntaxKind.PostfixUnaryExpression:
    case SyntaxKind.YieldExpression:
    case SyntaxKind.AsExpression:
    case SyntaxKind.SatisfiesExpression:
    case SyntaxKind.ElementAccessExpression:
    case SyntaxKind.NonNullExpression:
    case SyntaxKind.SpreadElement:
    case SyntaxKind.SpreadAssignment:
    case SyntaxKind.ParenthesizedExpression:
    case SyntaxKind.ArrayLiteralExpression:
    case SyntaxKind.DeleteExpression:
    case SyntaxKind.TypeOfExpression:
    case SyntaxKind.VoidExpression:
    case SyntaxKind.AwaitExpression:
    case SyntaxKind.TypeAssertionExpression:
    case SyntaxKind.ExpressionWithTypeArguments:
    case SyntaxKind.JsxSelfClosingElement:
    case SyntaxKind.JsxSpreadAttribute:
    case SyntaxKind.JsxExpression:
    case SyntaxKind.PartiallyEmittedExpression:
      return true;
    case SyntaxKind.ComputedPropertyName:
    case SyntaxKind.Decorator:
    case SyntaxKind.IfStatement:
    case SyntaxKind.DoStatement:
    case SyntaxKind.WhileStatement:
    case SyntaxKind.WithStatement:
    case SyntaxKind.ReturnStatement:
    case SyntaxKind.SwitchStatement:
    case SyntaxKind.CaseClause:
    case SyntaxKind.ThrowStatement:
    case SyntaxKind.ExpressionStatement:
    case SyntaxKind.ExportAssignment:
    case SyntaxKind.PropertyAccessExpression:
    case SyntaxKind.TemplateSpan:
      return getExpression(parent) === name;
    case SyntaxKind.VariableDeclaration:
    case SyntaxKind.Parameter:
    case SyntaxKind.BindingElement:
    case SyntaxKind.PropertyDeclaration:
    case SyntaxKind.PropertySignature:
    case SyntaxKind.PropertyAssignment:
    case SyntaxKind.EnumMember:
    case SyntaxKind.JsxAttribute:
      return getInitializer(parent) === name;
    case SyntaxKind.ShorthandPropertyAssignment:
      return parent instanceof ShorthandPropertyAssignment && parent.objectAssignmentInitializer === name;
    case SyntaxKind.ForStatement:
      return (
        parent instanceof ForStatement &&
        (parent.initializer === name || parent.condition === name || parent.incrementor === name)
      );
    case SyntaxKind.ForInStatement:
    case SyntaxKind.ForOfStatement:
      return getInitializer(parent) === name || getExpression(parent) === name;
    case SyntaxKind.ImportEqualsDeclaration:
      return parent instanceof ImportEqualsDeclaration && parent.moduleReference === name;
    case SyntaxKind.ArrowFunction:
      return getBody(parent) === name;
    case SyntaxKind.ConditionalExpression:
      return (
        parent instanceof ConditionalExpression &&
        (parent.condition === name || parent.whenTrue === name || parent.whenFalse === name)
      );
    case SyntaxKind.CallExpression:
    case SyntaxKind.NewExpression: {
      if (getExpression(parent) === name) return true;
      const args = getArguments(parent);
      return args !== undefined && args.nodes.indexOf(name) >= 0;
    }
    case SyntaxKind.TaggedTemplateExpression:
      return parent instanceof TaggedTemplateExpression && parent.tag === name;
    case SyntaxKind.ImportAttribute:
      return parent instanceof ImportAttribute && parent.value === name;
    case SyntaxKind.JsxOpeningElement:
    case SyntaxKind.JsxClosingElement:
      return getTagName(parent) === name;
  }
  return false;
}

/** The node itself for one node, else a syntax list of them; undefined for none. */
export function singleOrMany(nodes: Node[], factory: NodeFactory): Node | undefined {
  if (nodes.length === 0) return undefined;
  if (nodes.length === 1) return nodes[0];
  return factory.createSyntaxList(nodes);
}

/** Whether two optional nodes are the same node. */
export function isSameNode(a: Node | undefined, b: Node | undefined): boolean {
  if (a === undefined) return b === undefined;
  if (b === undefined) return false;
  return a === b;
}
