// Creates synthesized nodes for transforms and the printer. Created nodes are flagged
// `Synthesized` and have no range; updated nodes keep the original's flags, range and emit data.
import {
  ArrowFunction,
  BinaryExpression,
  ElementAccessExpression,
  FunctionExpression,
  ModifierFlags,
  ObjectLiteralExpression,
  ParameterDeclaration,
  PrefixUnaryExpression,
  PropertyAssignment,
  QualifiedName,
  Block,
  CallExpression,
  ConditionalExpression,
  ExpressionStatement,
  Identifier,
  IfStatement,
  KeywordExpression,
  ModifierList,
  type Node,
  NodeFlags,
  NodeList,
  NumericLiteral,
  ParenthesizedExpression,
  PrivateIdentifier,
  PropertyAccessExpression,
  ReturnStatement,
  SourceFile,
  StringLiteral,
  SyntaxList,
  Token,
  TypeOfExpression,
  VariableDeclaration,
  VariableDeclarationList,
  VariableStatement,
  VoidExpression,
} from '../ast.js';
import { modifierToFlag } from '../ast-utilities.js';
import { getNameOfDeclaration, getNonAssignedNameOfDeclaration, hasSyntacticModifier } from '../binder-utilities.js';
import { SyntaxKind } from '../syntax-kind.js';
import { TokenFlags } from '../types.js';
import type { EmitContext } from './emit-context.js';
import { AutoGenerateInfo, newAutoGenerateId } from './emit-context.js';
import { EmitFlags, GeneratedIdentifierFlags } from './emit-flags.js';
import { NodeFactoryBase } from './factory-base.js';
import {
  exportStarHelper,
  importDefaultHelper,
  importStarHelper,
  rewriteRelativeImportExtensionsHelper,
} from './helpers.js';
import { formatGeneratedName, isMemberName } from './utilities.js';

export class NodeFactory extends NodeFactoryBase {
  readonly context: EmitContext;

  constructor(context: EmitContext) {
    super();
    this.context = context;
  }

  protected finishUpdate(updated: Node, original: Node): boolean {
    updated.flags = original.flags;
    updated.pos = original.pos;
    updated.end = original.end;
    this.context.setOriginal(updated, original);
    return true;
  }

  /** Flags a node built with its constructor as synthesized. */
  created<T extends Node>(node: T): T {
    node.flags |= NodeFlags.Synthesized;
    return node;
  }

  /** A shallow copy of `node` with the same range and flags, its original set to `node`. */
  cloneNode<T extends Node>(node: T, copy: T): T {
    this.finishUpdate(copy, node);
    if (node instanceof Identifier || node instanceof PrivateIdentifier) {
      const info = this.context.autoGenerate.get(node);
      if (info !== undefined)
        this.context.autoGenerate.set(
          copy,
          new AutoGenerateInfo(info.flags, info.id, info.prefix, info.suffix, info.node),
        );
    }
    return copy;
  }

  cloneIdentifier(node: Identifier): Identifier {
    return this.cloneNode(node, new Identifier(node.text));
  }

  createNodeList(nodes: Node[]): NodeList {
    return new NodeList(-1, -1, nodes);
  }

  createModifierList(nodes: Node[]): ModifierList {
    let flags = 0;
    for (let i = 0; i < nodes.length; i++) flags |= modifierToFlag(nodes[i].kind);
    return new ModifierList(-1, -1, nodes, flags);
  }

  /** A copy of `list` with other nodes, keeping its range. */
  updateNodeList(list: NodeList, nodes: Node[]): NodeList {
    const updated = new NodeList(list.pos, list.end, nodes);
    return updated;
  }

  createToken(kind: SyntaxKind): Token {
    return this.created(new Token(kind));
  }

  createIdentifier(text: string): Identifier {
    return this.created(new Identifier(text));
  }

  createKeywordExpression(kind: SyntaxKind): KeywordExpression {
    return this.created(new KeywordExpression(kind));
  }

  createStringLiteral(text: string, tokenFlags: TokenFlags): StringLiteral {
    return this.created(new StringLiteral(text, tokenFlags));
  }

  createNumericLiteral(text: string): NumericLiteral {
    return this.created(new NumericLiteral(text, TokenFlags.None));
  }

  /** A string literal printed from the text of another node, e.g. an identifier. */
  createStringLiteralFromNode(textSource: Node): StringLiteral {
    const node = this.createStringLiteral(textOfLiteralLike(textSource), TokenFlags.None);
    this.context.textSource.set(node, textSource);
    return node;
  }

  createSyntaxList(children: Node[]): SyntaxList {
    return this.created(new SyntaxList(children));
  }

  createParenthesizedExpression(expression: Node): ParenthesizedExpression {
    return this.created(new ParenthesizedExpression(expression));
  }

  createPropertyAccessExpression(expression: Node, name: Node): PropertyAccessExpression {
    return this.created(new PropertyAccessExpression(expression, undefined, name, NodeFlags.None));
  }

  createCallExpression(expression: Node, args: Node[]): CallExpression {
    return this.created(
      new CallExpression(expression, undefined, undefined, this.createNodeList(args), NodeFlags.None),
    );
  }

  createBinaryExpression(left: Node, operator: SyntaxKind, right: Node): BinaryExpression {
    return this.created(new BinaryExpression(undefined, left, undefined, this.createToken(operator), right));
  }

  createAssignment(left: Node, right: Node): BinaryExpression {
    return this.createBinaryExpression(left, SyntaxKind.EqualsToken, right);
  }

  createStrictEquality(left: Node, right: Node): BinaryExpression {
    return this.createBinaryExpression(left, SyntaxKind.EqualsEqualsEqualsToken, right);
  }

  createConditionalExpression(condition: Node, whenTrue: Node, whenFalse: Node): ConditionalExpression {
    return this.created(
      new ConditionalExpression(
        condition,
        this.createToken(SyntaxKind.QuestionToken),
        whenTrue,
        this.createToken(SyntaxKind.ColonToken),
        whenFalse,
      ),
    );
  }

  createVoidZero(): VoidExpression {
    return this.created(new VoidExpression(this.createNumericLiteral('0')));
  }

  /** `typeof value === "tag"` */
  createTypeCheck(value: Node, tag: string): BinaryExpression {
    if (tag === 'undefined') return this.createStrictEquality(value, this.createVoidZero());
    return this.createStrictEquality(
      this.created(new TypeOfExpression(value)),
      this.createStringLiteral(tag, TokenFlags.None),
    );
  }

  createBlock(statements: Node[], multiLine: boolean): Block {
    return this.created(new Block(this.createNodeList(statements), multiLine));
  }

  createExpressionStatement(expression: Node): ExpressionStatement {
    return this.created(new ExpressionStatement(expression));
  }

  createReturnStatement(expression: Node | undefined): ReturnStatement {
    return this.created(new ReturnStatement(expression));
  }

  createIfStatement(expression: Node, thenStatement: Node, elseStatement: Node | undefined): IfStatement {
    return this.created(new IfStatement(expression, thenStatement, elseStatement));
  }

  createVariableDeclaration(
    name: Node,
    exclamationToken: Token | undefined,
    type: Node | undefined,
    initializer: Node | undefined,
  ): VariableDeclaration {
    return this.created(new VariableDeclaration(name, exclamationToken, type, initializer));
  }

  createVariableDeclarationList(declarations: NodeList, flags: NodeFlags): VariableDeclarationList {
    return this.created(new VariableDeclarationList(declarations, flags));
  }

  createVariableStatement(modifiers: ModifierList | undefined, list: VariableDeclarationList): VariableStatement {
    return this.created(new VariableStatement(modifiers, list));
  }

  createElementAccessExpression(expression: Node, argument: Node): ElementAccessExpression {
    return this.created(new ElementAccessExpression(expression, undefined, argument, NodeFlags.None));
  }

  createCommaExpression(left: Node, right: Node): BinaryExpression {
    return this.createBinaryExpression(left, SyntaxKind.CommaToken, right);
  }

  createLogicalOr(left: Node, right: Node): BinaryExpression {
    return this.createBinaryExpression(left, SyntaxKind.BarBarToken, right);
  }

  createPrefixUnaryExpression(operator: SyntaxKind, operand: Node): PrefixUnaryExpression {
    return this.created(new PrefixUnaryExpression(operator, operand));
  }

  createTrue(): KeywordExpression {
    return this.createKeywordExpression(SyntaxKind.TrueKeyword);
  }

  createObjectLiteral(properties: Node[], multiLine: boolean): ObjectLiteralExpression {
    return this.created(new ObjectLiteralExpression(this.createNodeList(properties), multiLine));
  }

  createPropertyAssignment(name: Node, initializer: Node): PropertyAssignment {
    return this.created(new PropertyAssignment(undefined, name, undefined, undefined, initializer));
  }

  createParameter(name: Node): ParameterDeclaration {
    return this.created(new ParameterDeclaration(undefined, undefined, name, undefined, undefined, undefined));
  }

  createFunctionExpression(parameters: Node[], body: Block): FunctionExpression {
    return this.created(
      new FunctionExpression(
        undefined,
        undefined,
        undefined,
        undefined,
        this.createNodeList(parameters),
        undefined,
        undefined,
        body,
      ),
    );
  }

  createArrowFunction(parameters: Node[], body: Node): ArrowFunction {
    return this.created(
      new ArrowFunction(
        undefined,
        undefined,
        this.createNodeList(parameters),
        undefined,
        undefined,
        this.createToken(SyntaxKind.EqualsGreaterThanToken),
        body,
      ),
    );
  }

  /** The expressions joined with commas, or undefined if there are none. */
  inlineExpressions(expressions: Node[]): Node | undefined {
    if (expressions.length === 0) return undefined;
    if (expressions.length === 1) return expressions[0];
    const flattened: Node[] = [];
    for (let i = 0; i < expressions.length; i++) flattenCommaElement(expressions[i], flattened);
    let expression = flattened[0];
    for (let i = 1; i < flattened.length; i++) expression = this.createCommaExpression(expression, flattened[i]);
    return expression;
  }

  /** `a.b.c` as a property access chain, from the qualified name `a.b.c`. */
  createExpressionFromEntityName(node: Node): Node {
    if (node instanceof QualifiedName) {
      const left = this.createExpressionFromEntityName(node.left);
      const right = this.cloneIdentifier(node.right);
      right.pos = node.right.pos;
      right.end = node.right.end;
      right.parent = node.right.parent;
      const access = this.createPropertyAccessExpression(left, right);
      access.pos = node.pos;
      access.end = node.end;
      return access;
    }
    if (!(node instanceof Identifier)) return node;
    const result = this.cloneIdentifier(node);
    result.parent = node.parent;
    return result;
  }

  // Declaration names

  private getName(node: Node, emitFlags: EmitFlags, options: NameOptions): Identifier {
    const name =
      (options & NameOptions.IgnoreAssignedName) !== 0
        ? getNonAssignedNameOfDeclaration(node)
        : getNameOfDeclaration(node);
    if (!(name instanceof Identifier)) return this.createGeneratedNameForNode(node, 0, '', '');
    const clone = this.cloneIdentifier(name as Identifier);
    if ((options & NameOptions.AllowComments) === 0) emitFlags |= EmitFlags.NoComments;
    if ((options & NameOptions.AllowSourceMaps) === 0) emitFlags |= EmitFlags.NoSourceMap;
    this.context.addEmitFlags(clone, emitFlags);
    return clone;
  }

  /** A name referring to the declaration in its own scope, never prefixed with its export. */
  getLocalName(node: Node, options: NameOptions): Identifier {
    return this.getName(node, EmitFlags.LocalName, options);
  }

  /** A name referring to the declaration that is prefixed with its export when it has one. */
  getExportName(node: Node, options: NameOptions): Identifier {
    return this.getName(node, EmitFlags.ExportName, options);
  }

  getDeclarationName(node: Node, options: NameOptions): Identifier {
    return this.getName(node, EmitFlags.None, options & ~NameOptions.IgnoreAssignedName);
  }

  /** `ns.name` */
  getNamespaceMemberName(namespace: Identifier, name: Identifier, options: NameOptions): PropertyAccessExpression {
    const member = this.context.hasAutoGenerateInfo(name) ? name : this.cloneIdentifier(name);
    const access = this.createPropertyAccessExpression(namespace, member);
    this.context.assignCommentAndSourceMapRanges(access, member);
    if ((options & NameOptions.AllowComments) === 0) this.context.addEmitFlags(access, EmitFlags.NoComments);
    if ((options & NameOptions.AllowSourceMaps) === 0) this.context.addEmitFlags(access, EmitFlags.NoSourceMap);
    return access;
  }

  /** `ns.name` for an exported declaration in a namespace, else its export name. */
  getExternalModuleOrNamespaceExportName(namespace: Identifier | undefined, node: Node, options: NameOptions): Node {
    if (namespace !== undefined && hasSyntacticModifier(node, ModifierFlags.Export))
      return this.getNamespaceMemberName(namespace, this.getDeclarationName(node, options), options);
    return this.getExportName(node, options);
  }

  /** A copy of a source file with other statements. */
  updateSourceFile(node: SourceFile, statements: NodeList, endOfFileToken: Token): SourceFile {
    if (statements === node.statements && endOfFileToken === node.endOfFileToken) return node;
    const updated = new SourceFile(
      node.fileName,
      node.path,
      node.text,
      node.externalModuleIndicatorOptions,
      statements,
      endOfFileToken,
    );
    updated.diagnostics = node.diagnostics;
    updated.jsDiagnostics = node.jsDiagnostics;
    updated.jsDocDiagnostics = node.jsDocDiagnostics;
    updated.languageVariant = node.languageVariant;
    updated.scriptKind = node.scriptKind;
    updated.isDeclarationFile = node.isDeclarationFile;
    updated.usesUriStyleNodeCoreModules = node.usesUriStyleNodeCoreModules;
    updated.identifierTexts = node.identifierTexts;
    updated.identifierCount = node.identifierCount;
    updated.nodeCount = node.nodeCount;
    updated.textCount = node.textCount;
    updated.imports = node.imports;
    updated.moduleAugmentations = node.moduleAugmentations;
    updated.ambientModuleNames = node.ambientModuleNames;
    updated.commentDirectives = node.commentDirectives;
    updated.pragmas = node.pragmas;
    updated.referencedFiles = node.referencedFiles;
    updated.typeReferenceDirectives = node.typeReferenceDirectives;
    updated.libReferenceDirectives = node.libReferenceDirectives;
    updated.checkJsDirective = node.checkJsDirective;
    updated.commonJSModuleIndicator = node.commonJSModuleIndicator;
    updated.externalModuleIndicator = node.externalModuleIndicator;
    updated.reparsedClones = node.reparsedClones;
    updated.hasLazyJSDoc = node.hasLazyJSDoc;
    this.finishUpdate(updated, node);
    return updated;
  }

  // Generated names

  private createGeneratedIdentifier(
    kind: GeneratedIdentifierFlags,
    text: string,
    node: Node | undefined,
    flags: GeneratedIdentifierFlags,
    prefix: string,
    suffix: string,
  ): Identifier {
    const id = newAutoGenerateId();
    if (text.length === 0) {
      if (node === undefined) text = '(auto@' + id + ')';
      else if (isMemberName(node)) text = textOfLiteralLike(node);
      else text = '(generated@' + id + ')';
      text = formatGeneratedName(false, prefix, text, suffix);
    }
    const name = this.createIdentifier(text);
    this.context.autoGenerate.set(
      name,
      new AutoGenerateInfo(kind | (flags & ~GeneratedIdentifierFlags.KindMask), id, prefix, suffix, node),
    );
    return name;
  }

  /** A temporary variable such as `_a`; add it to an environment with `addVariableDeclaration`. */
  createTempVariable(flags: GeneratedIdentifierFlags): Identifier {
    return this.createGeneratedIdentifier(GeneratedIdentifierFlags.Auto, '', undefined, flags, '', '');
  }

  createLoopVariable(flags: GeneratedIdentifierFlags): Identifier {
    return this.createGeneratedIdentifier(GeneratedIdentifierFlags.Loop, '', undefined, flags, '', '');
  }

  createUniqueName(text: string, flags: GeneratedIdentifierFlags): Identifier {
    return this.createGeneratedIdentifier(GeneratedIdentifierFlags.Unique, text, undefined, flags, '', '');
  }

  createGeneratedNameForNode(node: Node, flags: GeneratedIdentifierFlags, prefix: string, suffix: string): Identifier {
    if (prefix.length > 0 || suffix.length > 0) flags |= GeneratedIdentifierFlags.Optimistic;
    return this.createGeneratedIdentifier(GeneratedIdentifierFlags.Node, '', node, flags, prefix, suffix);
  }

  /** A private name such as `#x_accessor_storage`, unique within its class and based on `node`. */
  createGeneratedPrivateNameForNode(node: Node, prefix: string, suffix: string): PrivateIdentifier {
    const id = newAutoGenerateId();
    const text = formatGeneratedName(
      true,
      prefix,
      isMemberName(node) ? textOfLiteralLike(node) : '(generated@' + id + ')',
      suffix,
    );
    const name = this.created(new PrivateIdentifier(text));
    const flags = prefix.length > 0 || suffix.length > 0 ? GeneratedIdentifierFlags.Optimistic : 0;
    this.context.autoGenerate.set(
      name,
      new AutoGenerateInfo(GeneratedIdentifierFlags.Node | flags, id, prefix, suffix, node),
    );
    return name;
  }

  /** The name of an unscoped emit helper such as `__decorate`. */
  createUnscopedHelperName(name: string): Identifier {
    const node = this.createIdentifier(name);
    this.context.setEmitFlags(node, EmitFlags.HelperName);
    return node;
  }

  /** `__importDefault(expression)` */
  createImportDefaultHelper(expression: Node): CallExpression {
    this.context.requestEmitHelper(importDefaultHelper);
    return this.createCallExpression(this.createUnscopedHelperName('__importDefault'), [expression]);
  }

  /** `__importStar(expression)` */
  createImportStarHelper(expression: Node): CallExpression {
    this.context.requestEmitHelper(importStarHelper);
    return this.createCallExpression(this.createUnscopedHelperName('__importStar'), [expression]);
  }

  /** `__exportStar(moduleExpression, exportsExpression)` */
  createExportStarHelper(moduleExpression: Node, exportsExpression: Node): CallExpression {
    this.context.requestEmitHelper(exportStarHelper);
    return this.createCallExpression(this.createUnscopedHelperName('__exportStar'), [
      moduleExpression,
      exportsExpression,
    ]);
  }

  /** `__rewriteRelativeImportExtension(argument)`, with `true` to keep `.jsx`. */
  createRewriteRelativeImportExtensionsHelper(argument: Node, preserveJsx: boolean): CallExpression {
    this.context.requestEmitHelper(rewriteRelativeImportExtensionsHelper);
    const args = preserveJsx ? [argument, this.createToken(SyntaxKind.TrueKeyword) as Node] : [argument];
    return this.createCallExpression(this.createUnscopedHelperName('__rewriteRelativeImportExtension'), args);
  }

  isCallToHelper(node: Node, helperName: string): boolean {
    if (!(node instanceof CallExpression)) return false;
    const callee = node.expression;
    return (
      callee instanceof Identifier &&
      (this.context.getEmitFlags(callee) & EmitFlags.HelperName) !== 0 &&
      callee.text === helperName
    );
  }
}

/** Options for declaration names. */
export const enum NameOptions {
  None = 0,
  AllowComments = 1 << 0,
  AllowSourceMaps = 1 << 1,
  /** Use the declaration's own name, not one assigned to it. */
  IgnoreAssignedName = 1 << 2,
}

function flattenCommaElement(node: Node, expressions: Node[]): boolean {
  if (
    node instanceof BinaryExpression &&
    (node.flags & NodeFlags.Synthesized) !== 0 &&
    node.operatorToken.kind === SyntaxKind.CommaToken
  ) {
    flattenCommaElement(node.left, expressions);
    flattenCommaElement(node.right, expressions);
  } else expressions.push(node);
  return true;
}

function textOfLiteralLike(node: Node): string {
  if (node instanceof Identifier) return node.text;
  if (node instanceof PrivateIdentifier) return node.text;
  if (node instanceof StringLiteral) return node.text;
  if (node instanceof NumericLiteral) return node.text;
  return '';
}
