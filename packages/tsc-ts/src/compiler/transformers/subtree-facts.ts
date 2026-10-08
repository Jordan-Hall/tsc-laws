// Whether a subtree contains TypeScript-only syntax, computed as tsgo's subtree facts are.
// Transforms skip subtrees without it; that also decides how malformed code is emitted.
import {
  ClassDeclaration,
  ClassExpression,
  ConstructorDeclaration,
  ExportAssignment,
  ExportDeclaration,
  ExportSpecifier,
  FunctionDeclaration,
  GetAccessorDeclaration,
  Identifier,
  ImportClause,
  ImportEqualsDeclaration,
  ImportSpecifier,
  MethodDeclaration,
  ModifierFlags,
  type Node,
  NodeVisitor,
  ParameterDeclaration,
  PropertyDeclaration,
  SetAccessorDeclaration,
  VariableDeclaration,
  VariableStatement,
  ArrowFunction,
  FunctionExpression,
  CallExpression,
  NewExpression,
  TaggedTemplateExpression,
  ExpressionWithTypeArguments,
  JsxOpeningElement,
  JsxSelfClosingElement,
  HeritageClause,
  getModifiers,
} from '../ast.js';
import { isTypeNodeKind } from '../printer/utilities.js';
import { SyntaxKind } from '../syntax-kind.js';

const enum Facts {
  None = 0,
  TypeScript = 1,
  /** The node's own syntax decides; children aren't consulted. */
  Final = 2,
}

/** Memoized `containsTypeScript` answers for one emit. */
export class TypeScriptFacts extends NodeVisitor {
  private readonly cache: Map<Node, boolean>;
  private found: boolean;

  constructor() {
    super();
    this.cache = new Map<Node, boolean>();
    this.found = false;
  }

  containsTypeScript(node: Node): boolean {
    const cached = this.cache.get(node);
    if (cached !== undefined) return cached;
    const own = ownFacts(node);
    let result = (own & Facts.TypeScript) !== 0;
    if (!result && (own & Facts.Final) === 0) {
      const saved = this.found;
      this.found = false;
      node.forEachChild(this);
      result = this.found;
      this.found = saved;
    }
    this.cache.set(node, result);
    return result;
  }

  visitNode(node: Node): boolean {
    if (this.containsTypeScript(node)) this.found = true;
    return this.found;
  }
}

function ambient(node: Node): boolean {
  const modifiers = getModifiers(node);
  return modifiers !== undefined && (modifiers.modifierFlags & ModifierFlags.Ambient) !== 0;
}

/** TypeScript syntax of the node itself, beyond what its children contribute. */
function ownFacts(node: Node): Facts {
  const kind = node.kind;
  if (isTypeNodeKind(kind) && kind !== SyntaxKind.ExpressionWithTypeArguments) return Facts.TypeScript;
  switch (kind) {
    case SyntaxKind.PublicKeyword:
    case SyntaxKind.PrivateKeyword:
    case SyntaxKind.ProtectedKeyword:
    case SyntaxKind.ReadonlyKeyword:
    case SyntaxKind.AbstractKeyword:
    case SyntaxKind.DeclareKeyword:
    case SyntaxKind.ConstKeyword:
    case SyntaxKind.InKeyword:
    case SyntaxKind.OutKeyword:
    case SyntaxKind.OverrideKeyword:
    case SyntaxKind.ExportKeyword:
    case SyntaxKind.Decorator:
    case SyntaxKind.EnumMember:
    case SyntaxKind.EnumDeclaration:
    case SyntaxKind.ModuleDeclaration:
    case SyntaxKind.ShorthandPropertyAssignment:
    case SyntaxKind.AsExpression:
    case SyntaxKind.SatisfiesExpression:
    case SyntaxKind.NonNullExpression:
    case SyntaxKind.TypeAssertionExpression:
    case SyntaxKind.InterfaceDeclaration:
    case SyntaxKind.TypeAliasDeclaration:
    case SyntaxKind.JSTypeAliasDeclaration:
    case SyntaxKind.NamespaceExportDeclaration:
    case SyntaxKind.CallSignature:
    case SyntaxKind.ConstructSignature:
    case SyntaxKind.IndexSignature:
    case SyntaxKind.MethodSignature:
    case SyntaxKind.PropertySignature:
    case SyntaxKind.TypeParameter:
      return Facts.TypeScript;
    case SyntaxKind.VariableStatement:
      return node instanceof VariableStatement && ambient(node) ? Facts.TypeScript : Facts.None;
    case SyntaxKind.VariableDeclaration:
      return node instanceof VariableDeclaration && (node.exclamationToken !== undefined || node.type !== undefined)
        ? Facts.TypeScript
        : Facts.None;
    case SyntaxKind.Parameter:
      if (node instanceof ParameterDeclaration)
        return (node.name instanceof Identifier && node.name.text === 'this') ||
          node.questionToken !== undefined ||
          node.type !== undefined
          ? Facts.TypeScript
          : Facts.None;
      break;
    case SyntaxKind.FunctionDeclaration:
      if (node instanceof FunctionDeclaration)
        return node.body === undefined ||
          ambient(node) ||
          node.typeParameters !== undefined ||
          node.type !== undefined ||
          node.fullSignature !== undefined
          ? Facts.TypeScript
          : Facts.None;
      break;
    case SyntaxKind.ClassDeclaration:
      if (node instanceof ClassDeclaration)
        return ambient(node) || node.typeParameters !== undefined ? Facts.TypeScript : Facts.None;
      break;
    case SyntaxKind.ClassExpression:
      if (node instanceof ClassExpression)
        return ambient(node) || node.typeParameters !== undefined ? Facts.TypeScript : Facts.None;
      break;
    case SyntaxKind.HeritageClause:
      if (node instanceof HeritageClause) {
        if (node.token === SyntaxKind.ImplementsKeyword) return Facts.TypeScript;
        return node.token === SyntaxKind.ExtendsKeyword ? Facts.None : Facts.Final;
      }
      break;
    case SyntaxKind.ImportEqualsDeclaration:
      if (node instanceof ImportEqualsDeclaration)
        return node.isTypeOnly || node.moduleReference.kind !== SyntaxKind.ExternalModuleReference
          ? Facts.TypeScript
          : Facts.None;
      break;
    case SyntaxKind.ImportSpecifier:
      return node instanceof ImportSpecifier && node.isTypeOnly ? Facts.TypeScript : Facts.None;
    case SyntaxKind.ImportClause:
      return node instanceof ImportClause && node.phaseModifier === SyntaxKind.TypeKeyword
        ? Facts.TypeScript
        : Facts.None;
    case SyntaxKind.ExportAssignment:
      return node instanceof ExportAssignment && node.isExportEquals ? Facts.TypeScript : Facts.None;
    case SyntaxKind.ExportDeclaration:
      return node instanceof ExportDeclaration && node.isTypeOnly ? Facts.TypeScript : Facts.None;
    case SyntaxKind.ExportSpecifier:
      return node instanceof ExportSpecifier && node.isTypeOnly ? Facts.TypeScript : Facts.None;
    case SyntaxKind.Constructor:
      if (node instanceof ConstructorDeclaration)
        return node.body === undefined ||
          node.typeParameters !== undefined ||
          node.type !== undefined ||
          node.fullSignature !== undefined
          ? Facts.TypeScript
          : Facts.None;
      break;
    case SyntaxKind.GetAccessor:
      if (node instanceof GetAccessorDeclaration)
        return node.body === undefined ||
          node.typeParameters !== undefined ||
          node.type !== undefined ||
          node.fullSignature !== undefined
          ? Facts.TypeScript
          : Facts.None;
      break;
    case SyntaxKind.SetAccessor:
      if (node instanceof SetAccessorDeclaration)
        return node.body === undefined ||
          node.typeParameters !== undefined ||
          node.type !== undefined ||
          node.fullSignature !== undefined
          ? Facts.TypeScript
          : Facts.None;
      break;
    case SyntaxKind.MethodDeclaration:
      if (node instanceof MethodDeclaration)
        return node.body === undefined ||
          node.postfixToken !== undefined ||
          node.typeParameters !== undefined ||
          node.type !== undefined ||
          node.fullSignature !== undefined
          ? Facts.TypeScript
          : Facts.None;
      break;
    case SyntaxKind.PropertyDeclaration:
      return node instanceof PropertyDeclaration && (node.postfixToken !== undefined || node.type !== undefined)
        ? Facts.TypeScript
        : Facts.None;
    case SyntaxKind.ArrowFunction:
      return node instanceof ArrowFunction &&
        (node.typeParameters !== undefined || node.type !== undefined || node.fullSignature !== undefined)
        ? Facts.TypeScript
        : Facts.None;
    case SyntaxKind.FunctionExpression:
      return node instanceof FunctionExpression &&
        (node.typeParameters !== undefined || node.type !== undefined || node.fullSignature !== undefined)
        ? Facts.TypeScript
        : Facts.None;
    case SyntaxKind.CallExpression:
      return node instanceof CallExpression && node.typeArguments !== undefined ? Facts.TypeScript : Facts.None;
    case SyntaxKind.NewExpression:
      return node instanceof NewExpression && node.typeArguments !== undefined ? Facts.TypeScript : Facts.None;
    case SyntaxKind.TaggedTemplateExpression:
      return node instanceof TaggedTemplateExpression && node.typeArguments !== undefined
        ? Facts.TypeScript
        : Facts.None;
    case SyntaxKind.ExpressionWithTypeArguments:
      return node instanceof ExpressionWithTypeArguments && node.typeArguments !== undefined
        ? Facts.TypeScript
        : Facts.None;
    case SyntaxKind.JsxOpeningElement:
      return node instanceof JsxOpeningElement && node.typeArguments !== undefined ? Facts.TypeScript : Facts.None;
    case SyntaxKind.JsxSelfClosingElement:
      return node instanceof JsxSelfClosingElement && node.typeArguments !== undefined ? Facts.TypeScript : Facts.None;
  }
  return Facts.None;
}
