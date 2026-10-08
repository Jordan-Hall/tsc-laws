// The syntax tree: one class per node shape, with tsgo's kinds, fields, flags and child order.
//
// Every node extends `Node`. Child fields are typed by category (`Expression`, `TypeNode`, …),
// which are aliases of `Node`; narrow with the `is*` guards in ast-utilities.ts or `instanceof`.
import { computeLineStarts } from './scanner.js';
import { SyntaxKind } from './syntax-kind.js';
import { type CommentDirective, type CommentRange, type LanguageVariant, TokenFlags } from './types.js';
import { type Diagnostic, DiagnosticFile } from './diagnostics.js';
import type { ResolutionMode } from './module-resolution-types.js';

export const enum NodeFlags {
  None = 0,
  Let = 1 << 0,
  Const = 1 << 1,
  Using = 1 << 2,
  /** Synthesized while parsing, e.g. from JSDoc. */
  Reparsed = 1 << 3,
  Synthesized = 1 << 4,
  OptionalChain = 1 << 5,
  ExportContext = 1 << 6,
  ContainsThis = 1 << 7,
  HasImplicitReturn = 1 << 8,
  HasExplicitReturn = 1 << 9,
  DisallowInContext = 1 << 10,
  YieldContext = 1 << 11,
  DecoratorContext = 1 << 12,
  AwaitContext = 1 << 13,
  DisallowConditionalTypesContext = 1 << 14,
  ThisNodeHasError = 1 << 15,
  JavaScriptFile = 1 << 16,
  ThisNodeOrAnySubNodesHasError = 1 << 17,
  HasAsyncFunctions = 1 << 18,
  PossiblyContainsDynamicImport = 1 << 19,
  PossiblyContainsImportMeta = 1 << 20,
  HasJSDoc = 1 << 21,
  /** Parsed inside a JSDoc comment. */
  JSDoc = 1 << 22,
  Ambient = 1 << 23,
  InWithStatement = 1 << 24,
  JsonFile = 1 << 25,
  PossiblyContainsDeprecatedTag = 1 << 26,
  Unreachable = 1 << 27,
  ReparserTransformedLiteral = 1 << 28,

  BlockScoped = Let | Const | Using,
  Constant = Const | Using,
  AwaitUsing = Const | Using,
  ReachabilityCheckFlags = HasImplicitReturn | HasExplicitReturn,
  ReachabilityAndEmitFlags = ReachabilityCheckFlags | HasAsyncFunctions,
  ContextFlags = DisallowInContext |
    DisallowConditionalTypesContext |
    YieldContext |
    DecoratorContext |
    AwaitContext |
    JavaScriptFile |
    InWithStatement |
    Ambient,
  TypeExcludesFlags = YieldContext | AwaitContext,
  PermanentlySetIncrementalFlags = PossiblyContainsDynamicImport | PossiblyContainsImportMeta,
  IdentifierHasExtendedUnicodeEscape = ContainsThis,
  IdentifierIsInJSDocNamespace = HasAsyncFunctions,
  NestedNamespace = OptionalChain,
}

export const enum ModifierFlags {
  None = 0,
  Public = 1 << 0,
  Private = 1 << 1,
  Protected = 1 << 2,
  Readonly = 1 << 3,
  Override = 1 << 4,
  Export = 1 << 5,
  Abstract = 1 << 6,
  Ambient = 1 << 7,
  Static = 1 << 8,
  Accessor = 1 << 9,
  Async = 1 << 10,
  Default = 1 << 11,
  Const = 1 << 12,
  In = 1 << 13,
  Out = 1 << 14,
  Decorator = 1 << 15,
  Deprecated = 1 << 16,
  JSDocPublic = 1 << 23,
  JSDocPrivate = 1 << 24,
  JSDocProtected = 1 << 25,
  JSDocReadonly = 1 << 26,
  JSDocOverride = 1 << 27,
  HasComputedJSDocModifiers = 1 << 28,
  HasComputedFlags = 1 << 29,

  SyntacticOrJSDocModifiers = Public | Private | Protected | Readonly | Override,
  SyntacticOnlyModifiers = Export |
    Ambient |
    Abstract |
    Static |
    Accessor |
    Async |
    Default |
    Const |
    In |
    Out |
    Decorator,
  SyntacticModifiers = SyntacticOrJSDocModifiers | SyntacticOnlyModifiers,
  JSDocCacheOnlyModifiers = JSDocPublic | JSDocPrivate | JSDocProtected | JSDocReadonly | JSDocOverride,
  JSDocOnlyModifiers = Deprecated,
  NonCacheOnlyModifiers = SyntacticOrJSDocModifiers | SyntacticOnlyModifiers | JSDocOnlyModifiers,
  AccessibilityModifier = Public | Private | Protected,
  ParameterPropertyModifier = AccessibilityModifier | Readonly | Override,
  NonPublicAccessibilityModifier = Private | Protected,
  TypeScriptModifier = Ambient | Public | Private | Protected | Readonly | Abstract | Const | Override | In | Out,
  ExportDefault = Export | Default,
  All = Export |
    Ambient |
    Public |
    Private |
    Protected |
    Static |
    Readonly |
    Abstract |
    Accessor |
    Async |
    Default |
    Const |
    Deprecated |
    Override |
    In |
    Out |
    Decorator,
  Modifier = All & ~Decorator,
  JavaScript = Export | Static | Accessor | Async | Default,
}

export const enum ScriptKind {
  Unknown = 0,
  JS = 1,
  JSX = 2,
  TS = 3,
  TSX = 4,
  External = 5,
  JSON = 6,
  Deferred = 7,
}

export const enum Tristate {
  Unknown = 0,
  False = 1,
  True = 2,
}

/** Visits the children of a node in tsgo's order; any method returning `true` stops the walk. */
export abstract class NodeVisitor {
  abstract visitNode(node: Node): boolean;

  visitList(list: NodeList): boolean {
    const nodes = list.nodes;
    for (let i = 0; i < nodes.length; i++) if (this.visitNode(nodes[i])) return true;
    return false;
  }

  visitModifiers(list: ModifierList): boolean {
    return this.visitList(list);
  }
}

export abstract class Node {
  readonly kind: SyntaxKind;
  flags: NodeFlags;
  /** Start including leading trivia, as a UTF-16 offset. */
  pos: number;
  end: number;
  parent: Node | undefined;
  /** JSDoc comments attached by the parser (eagerly in JS files, on demand in TS files). */
  /** `JSDoc` nodes. */
  jsDoc: Node[] | undefined;

  constructor(kind: SyntaxKind) {
    this.kind = kind;
    this.flags = NodeFlags.None;
    this.pos = -1;
    this.end = -1;
    this.parent = undefined;
    this.jsDoc = undefined;
  }

  /** Calls `visitor` for each child in order; returns `true` if the visitor stopped. */
  abstract forEachChild(visitor: NodeVisitor): boolean;

  /** A copy of this subtree with the same positions and flags; parents are not set. */
  abstract deepClone(): Node;
}

/** A list of child nodes with its own text range. */
export class NodeList {
  pos: number;
  end: number;
  nodes: Node[];
  /** Created where the list's opening token was missing. */
  isMissingList: boolean;

  constructor(pos: number, end: number, nodes: Node[]) {
    this.pos = pos;
    this.end = end;
    this.nodes = nodes;
    this.isMissingList = false;
  }

  hasTrailingComma(): boolean {
    const nodes = this.nodes;
    return nodes.length > 0 && nodes[nodes.length - 1].end < this.end;
  }
}

export class ModifierList extends NodeList {
  modifierFlags: ModifierFlags;

  constructor(pos: number, end: number, nodes: Node[], modifierFlags: ModifierFlags) {
    super(pos, end, nodes);
    this.modifierFlags = modifierFlags;
  }
}

function cloneNodes(nodes: Node[]): Node[] {
  const result: Node[] = [];
  for (let i = 0; i < nodes.length; i++) result.push(nodes[i].deepClone());
  return result;
}

function cloneList(list: NodeList): NodeList {
  const result = new NodeList(list.pos, list.end, cloneNodes(list.nodes));
  result.isMissingList = list.isMissingList;
  return result;
}

function cloneModifiers(list: ModifierList): ModifierList {
  return new ModifierList(list.pos, list.end, cloneNodes(list.nodes), list.modifierFlags);
}

/** A `/// <reference …/>` path, types or lib directive. */
export class FileReference {
  readonly pos: number;
  readonly end: number;
  readonly fileName: string;
  readonly resolutionMode: ResolutionMode;
  readonly preserve: boolean;

  constructor(pos: number, end: number, fileName: string, resolutionMode: ResolutionMode, preserve: boolean) {
    this.pos = pos;
    this.end = end;
    this.fileName = fileName;
    this.resolutionMode = resolutionMode;
    this.preserve = preserve;
  }
}

export class PragmaArgument {
  readonly pos: number;
  readonly end: number;
  readonly name: string;
  readonly value: string;

  constructor(pos: number, end: number, name: string, value: string) {
    this.pos = pos;
    this.end = end;
    this.name = name;
    this.value = value;
  }
}

/** A comment pragma such as `/// <reference path="…"/>`, `// @ts-nocheck` or `/** @jsx h *\/`. */
export class Pragma {
  readonly range: CommentRange;
  readonly name: string;
  readonly args: Map<string, PragmaArgument>;

  constructor(range: CommentRange, name: string, args: Map<string, PragmaArgument>) {
    this.range = range;
    this.name = name;
    this.args = args;
  }
}

export class CheckJsDirective {
  readonly enabled: boolean;
  readonly range: CommentRange;

  constructor(enabled: boolean, range: CommentRange) {
    this.enabled = enabled;
    this.range = range;
  }
}

/** What makes a non-declaration file a module besides imports and exports. */
export class ExternalModuleIndicatorOptions {
  /** JSX tags make the file a module (`jsx: react-jsx` or `react-jsxdev`). */
  readonly jsx: boolean;
  /** Every non-declaration file is a module (`moduleDetection: force`, or an ESM-format file). */
  readonly force: boolean;

  constructor(jsx: boolean, force: boolean) {
    this.jsx = jsx;
    this.force = force;
  }
}

/** How to parse a source file. */
export class ParseOptions {
  /** The canonical path; defaults to the file name. */
  readonly path: string;
  /** Defaults to the kind implied by the file extension. */
  readonly scriptKind: ScriptKind;
  readonly externalModuleIndicatorOptions: ExternalModuleIndicatorOptions;

  constructor(path: string, scriptKind: ScriptKind, externalModuleIndicatorOptions: ExternalModuleIndicatorOptions) {
    this.path = path;
    this.scriptKind = scriptKind;
    this.externalModuleIndicatorOptions = externalModuleIndicatorOptions;
  }
}

// Child categories. They are all `Node`: error recovery and JS reparsing can put
// nodes of unexpected kinds anywhere, as in tsgo.
export type Expression = Node;
export type LeftHandSideExpression = Node;
export type Statement = Node;
export type TypeNode = Node;
export type BindingName = Node;
export type ConciseBody = Node;
export type EntityName = Node;
export type ForInitializer = Node;
export type FunctionBody = Node;
export type ImportAttributeName = Node;
export type JSDocFullName = Node;
export type JsxAttributeName = Node;
export type JsxAttributeValue = Node;
export type JsxTagNameExpression = Node;
export type MemberName = Node;
export type ModuleBody = Node;
export type ModuleExportName = Node;
export type ModuleName = Node;
export type ModuleReference = Node;
export type NamedExportBindings = Node;
export type NamedImportBindings = Node;
export type PropertyName = Node;
export type DeclarationName = Node;
export type TemplateLiteral = Node;
export type TemplateMiddleOrTail = Node;
export type TypePredicateParameterName = Node;

// #region nodes (generated by scripts/generate-ast.mjs)

export class Token extends Node {
  constructor(kind: SyntaxKind) {
    super(kind);
  }

  forEachChild(_v: NodeVisitor): boolean {
    return false;
  }

  deepClone(): Node {
    return this.copy();
  }

  copy(): Token {
    const node = new Token(this.kind);
    node.flags = this.flags;
    node.pos = this.pos;
    node.end = this.end;
    return node;
  }
}

export class Identifier extends Node {
  text: string;

  constructor(text: string) {
    super(SyntaxKind.Identifier);
    this.text = text;
  }

  forEachChild(_v: NodeVisitor): boolean {
    return false;
  }

  deepClone(): Node {
    return this.copy();
  }

  copy(): Identifier {
    const node = new Identifier(this.text);
    node.flags = this.flags;
    node.pos = this.pos;
    node.end = this.end;
    return node;
  }
}

export class PrivateIdentifier extends Node {
  text: string;

  constructor(text: string) {
    super(SyntaxKind.PrivateIdentifier);
    this.text = text;
  }

  forEachChild(_v: NodeVisitor): boolean {
    return false;
  }

  deepClone(): Node {
    return this.copy();
  }

  copy(): PrivateIdentifier {
    const node = new PrivateIdentifier(this.text);
    node.flags = this.flags;
    node.pos = this.pos;
    node.end = this.end;
    return node;
  }
}

export class QualifiedName extends Node {
  left: EntityName;
  right: Identifier;

  constructor(left: EntityName, right: Identifier) {
    super(SyntaxKind.QualifiedName);
    this.left = left;
    this.right = right;
  }

  forEachChild(v: NodeVisitor): boolean {
    if (v.visitNode(this.left)) return true;
    return v.visitNode(this.right);
  }

  deepClone(): Node {
    return this.copy();
  }

  copy(): QualifiedName {
    const node = new QualifiedName(this.left.deepClone(), this.right.copy());
    node.flags = this.flags;
    node.pos = this.pos;
    node.end = this.end;
    return node;
  }
}

export class ComputedPropertyName extends Node {
  expression: Expression;

  constructor(expression: Expression) {
    super(SyntaxKind.ComputedPropertyName);
    this.expression = expression;
  }

  forEachChild(v: NodeVisitor): boolean {
    return v.visitNode(this.expression);
  }

  deepClone(): Node {
    return this.copy();
  }

  copy(): ComputedPropertyName {
    const node = new ComputedPropertyName(this.expression.deepClone());
    node.flags = this.flags;
    node.pos = this.pos;
    node.end = this.end;
    return node;
  }
}

export class Decorator extends Node {
  expression: LeftHandSideExpression;

  constructor(expression: LeftHandSideExpression) {
    super(SyntaxKind.Decorator);
    this.expression = expression;
  }

  forEachChild(v: NodeVisitor): boolean {
    return v.visitNode(this.expression);
  }

  deepClone(): Node {
    return this.copy();
  }

  copy(): Decorator {
    const node = new Decorator(this.expression.deepClone());
    node.flags = this.flags;
    node.pos = this.pos;
    node.end = this.end;
    return node;
  }
}

export class EmptyStatement extends Node {
  constructor() {
    super(SyntaxKind.EmptyStatement);
  }

  forEachChild(_v: NodeVisitor): boolean {
    return false;
  }

  deepClone(): Node {
    return this.copy();
  }

  copy(): EmptyStatement {
    const node = new EmptyStatement();
    node.flags = this.flags;
    node.pos = this.pos;
    node.end = this.end;
    return node;
  }
}

export class IfStatement extends Node {
  expression: Expression;
  thenStatement: Statement;
  elseStatement: Statement | undefined;

  constructor(expression: Expression, thenStatement: Statement, elseStatement: Statement | undefined) {
    super(SyntaxKind.IfStatement);
    this.expression = expression;
    this.thenStatement = thenStatement;
    this.elseStatement = elseStatement;
  }

  forEachChild(v: NodeVisitor): boolean {
    if (v.visitNode(this.expression)) return true;
    if (v.visitNode(this.thenStatement)) return true;
    return this.elseStatement !== undefined && v.visitNode(this.elseStatement);
  }

  deepClone(): Node {
    return this.copy();
  }

  copy(): IfStatement {
    const node = new IfStatement(
      this.expression.deepClone(),
      this.thenStatement.deepClone(),
      this.elseStatement === undefined ? undefined : this.elseStatement.deepClone(),
    );
    node.flags = this.flags;
    node.pos = this.pos;
    node.end = this.end;
    return node;
  }
}

export class DoStatement extends Node {
  statement: Statement;
  expression: Expression;

  constructor(statement: Statement, expression: Expression) {
    super(SyntaxKind.DoStatement);
    this.statement = statement;
    this.expression = expression;
  }

  forEachChild(v: NodeVisitor): boolean {
    if (v.visitNode(this.statement)) return true;
    return v.visitNode(this.expression);
  }

  deepClone(): Node {
    return this.copy();
  }

  copy(): DoStatement {
    const node = new DoStatement(this.statement.deepClone(), this.expression.deepClone());
    node.flags = this.flags;
    node.pos = this.pos;
    node.end = this.end;
    return node;
  }
}

export class WhileStatement extends Node {
  expression: Expression;
  statement: Statement;

  constructor(expression: Expression, statement: Statement) {
    super(SyntaxKind.WhileStatement);
    this.expression = expression;
    this.statement = statement;
  }

  forEachChild(v: NodeVisitor): boolean {
    if (v.visitNode(this.expression)) return true;
    return v.visitNode(this.statement);
  }

  deepClone(): Node {
    return this.copy();
  }

  copy(): WhileStatement {
    const node = new WhileStatement(this.expression.deepClone(), this.statement.deepClone());
    node.flags = this.flags;
    node.pos = this.pos;
    node.end = this.end;
    return node;
  }
}

export class ForStatement extends Node {
  initializer: ForInitializer | undefined;
  condition: Expression | undefined;
  incrementor: Expression | undefined;
  statement: Statement;

  constructor(
    initializer: ForInitializer | undefined,
    condition: Expression | undefined,
    incrementor: Expression | undefined,
    statement: Statement,
  ) {
    super(SyntaxKind.ForStatement);
    this.initializer = initializer;
    this.condition = condition;
    this.incrementor = incrementor;
    this.statement = statement;
  }

  forEachChild(v: NodeVisitor): boolean {
    if (this.initializer !== undefined && v.visitNode(this.initializer)) return true;
    if (this.condition !== undefined && v.visitNode(this.condition)) return true;
    if (this.incrementor !== undefined && v.visitNode(this.incrementor)) return true;
    return v.visitNode(this.statement);
  }

  deepClone(): Node {
    return this.copy();
  }

  copy(): ForStatement {
    const node = new ForStatement(
      this.initializer === undefined ? undefined : this.initializer.deepClone(),
      this.condition === undefined ? undefined : this.condition.deepClone(),
      this.incrementor === undefined ? undefined : this.incrementor.deepClone(),
      this.statement.deepClone(),
    );
    node.flags = this.flags;
    node.pos = this.pos;
    node.end = this.end;
    return node;
  }
}

export class ForInOrOfStatement extends Node {
  awaitModifier: Token | undefined;
  initializer: ForInitializer;
  expression: Expression;
  statement: Statement;

  constructor(
    kind: SyntaxKind,
    awaitModifier: Token | undefined,
    initializer: ForInitializer,
    expression: Expression,
    statement: Statement,
  ) {
    super(kind);
    this.awaitModifier = awaitModifier;
    this.initializer = initializer;
    this.expression = expression;
    this.statement = statement;
  }

  forEachChild(v: NodeVisitor): boolean {
    if (this.awaitModifier !== undefined && v.visitNode(this.awaitModifier)) return true;
    if (v.visitNode(this.initializer)) return true;
    if (v.visitNode(this.expression)) return true;
    return v.visitNode(this.statement);
  }

  deepClone(): Node {
    return this.copy();
  }

  copy(): ForInOrOfStatement {
    const node = new ForInOrOfStatement(
      this.kind,
      this.awaitModifier === undefined ? undefined : this.awaitModifier.copy(),
      this.initializer.deepClone(),
      this.expression.deepClone(),
      this.statement.deepClone(),
    );
    node.flags = this.flags;
    node.pos = this.pos;
    node.end = this.end;
    return node;
  }
}

export class BreakStatement extends Node {
  label: Identifier | undefined;

  constructor(label: Identifier | undefined) {
    super(SyntaxKind.BreakStatement);
    this.label = label;
  }

  forEachChild(v: NodeVisitor): boolean {
    return this.label !== undefined && v.visitNode(this.label);
  }

  deepClone(): Node {
    return this.copy();
  }

  copy(): BreakStatement {
    const node = new BreakStatement(this.label === undefined ? undefined : this.label.copy());
    node.flags = this.flags;
    node.pos = this.pos;
    node.end = this.end;
    return node;
  }
}

export class ContinueStatement extends Node {
  label: Identifier | undefined;

  constructor(label: Identifier | undefined) {
    super(SyntaxKind.ContinueStatement);
    this.label = label;
  }

  forEachChild(v: NodeVisitor): boolean {
    return this.label !== undefined && v.visitNode(this.label);
  }

  deepClone(): Node {
    return this.copy();
  }

  copy(): ContinueStatement {
    const node = new ContinueStatement(this.label === undefined ? undefined : this.label.copy());
    node.flags = this.flags;
    node.pos = this.pos;
    node.end = this.end;
    return node;
  }
}

export class ReturnStatement extends Node {
  expression: Expression | undefined;

  constructor(expression: Expression | undefined) {
    super(SyntaxKind.ReturnStatement);
    this.expression = expression;
  }

  forEachChild(v: NodeVisitor): boolean {
    return this.expression !== undefined && v.visitNode(this.expression);
  }

  deepClone(): Node {
    return this.copy();
  }

  copy(): ReturnStatement {
    const node = new ReturnStatement(this.expression === undefined ? undefined : this.expression.deepClone());
    node.flags = this.flags;
    node.pos = this.pos;
    node.end = this.end;
    return node;
  }
}

export class WithStatement extends Node {
  expression: Expression;
  statement: Statement;

  constructor(expression: Expression, statement: Statement) {
    super(SyntaxKind.WithStatement);
    this.expression = expression;
    this.statement = statement;
  }

  forEachChild(v: NodeVisitor): boolean {
    if (v.visitNode(this.expression)) return true;
    return v.visitNode(this.statement);
  }

  deepClone(): Node {
    return this.copy();
  }

  copy(): WithStatement {
    const node = new WithStatement(this.expression.deepClone(), this.statement.deepClone());
    node.flags = this.flags;
    node.pos = this.pos;
    node.end = this.end;
    return node;
  }
}

export class SwitchStatement extends Node {
  expression: Expression;
  caseBlock: CaseBlock;

  constructor(expression: Expression, caseBlock: CaseBlock) {
    super(SyntaxKind.SwitchStatement);
    this.expression = expression;
    this.caseBlock = caseBlock;
  }

  forEachChild(v: NodeVisitor): boolean {
    if (v.visitNode(this.expression)) return true;
    return v.visitNode(this.caseBlock);
  }

  deepClone(): Node {
    return this.copy();
  }

  copy(): SwitchStatement {
    const node = new SwitchStatement(this.expression.deepClone(), this.caseBlock.copy());
    node.flags = this.flags;
    node.pos = this.pos;
    node.end = this.end;
    return node;
  }
}

export class CaseBlock extends Node {
  clauses: NodeList;

  constructor(clauses: NodeList) {
    super(SyntaxKind.CaseBlock);
    this.clauses = clauses;
  }

  forEachChild(v: NodeVisitor): boolean {
    return v.visitList(this.clauses);
  }

  deepClone(): Node {
    return this.copy();
  }

  copy(): CaseBlock {
    const node = new CaseBlock(cloneList(this.clauses));
    node.flags = this.flags;
    node.pos = this.pos;
    node.end = this.end;
    return node;
  }
}

export class CaseOrDefaultClause extends Node {
  expression: Expression | undefined;
  statements: NodeList;

  constructor(kind: SyntaxKind, expression: Expression | undefined, statements: NodeList) {
    super(kind);
    this.expression = expression;
    this.statements = statements;
  }

  forEachChild(v: NodeVisitor): boolean {
    if (this.expression !== undefined && v.visitNode(this.expression)) return true;
    return v.visitList(this.statements);
  }

  deepClone(): Node {
    return this.copy();
  }

  copy(): CaseOrDefaultClause {
    const node = new CaseOrDefaultClause(
      this.kind,
      this.expression === undefined ? undefined : this.expression.deepClone(),
      cloneList(this.statements),
    );
    node.flags = this.flags;
    node.pos = this.pos;
    node.end = this.end;
    return node;
  }
}

export class ThrowStatement extends Node {
  expression: Expression;

  constructor(expression: Expression) {
    super(SyntaxKind.ThrowStatement);
    this.expression = expression;
  }

  forEachChild(v: NodeVisitor): boolean {
    return v.visitNode(this.expression);
  }

  deepClone(): Node {
    return this.copy();
  }

  copy(): ThrowStatement {
    const node = new ThrowStatement(this.expression.deepClone());
    node.flags = this.flags;
    node.pos = this.pos;
    node.end = this.end;
    return node;
  }
}

export class TryStatement extends Node {
  tryBlock: Block;
  catchClause: CatchClause | undefined;
  finallyBlock: Block | undefined;

  constructor(tryBlock: Block, catchClause: CatchClause | undefined, finallyBlock: Block | undefined) {
    super(SyntaxKind.TryStatement);
    this.tryBlock = tryBlock;
    this.catchClause = catchClause;
    this.finallyBlock = finallyBlock;
  }

  forEachChild(v: NodeVisitor): boolean {
    if (v.visitNode(this.tryBlock)) return true;
    if (this.catchClause !== undefined && v.visitNode(this.catchClause)) return true;
    return this.finallyBlock !== undefined && v.visitNode(this.finallyBlock);
  }

  deepClone(): Node {
    return this.copy();
  }

  copy(): TryStatement {
    const node = new TryStatement(
      this.tryBlock.copy(),
      this.catchClause === undefined ? undefined : this.catchClause.copy(),
      this.finallyBlock === undefined ? undefined : this.finallyBlock.copy(),
    );
    node.flags = this.flags;
    node.pos = this.pos;
    node.end = this.end;
    return node;
  }
}

export class CatchClause extends Node {
  variableDeclaration: VariableDeclaration | undefined;
  block: Block;

  constructor(variableDeclaration: VariableDeclaration | undefined, block: Block) {
    super(SyntaxKind.CatchClause);
    this.variableDeclaration = variableDeclaration;
    this.block = block;
  }

  forEachChild(v: NodeVisitor): boolean {
    if (this.variableDeclaration !== undefined && v.visitNode(this.variableDeclaration)) return true;
    return v.visitNode(this.block);
  }

  deepClone(): Node {
    return this.copy();
  }

  copy(): CatchClause {
    const node = new CatchClause(
      this.variableDeclaration === undefined ? undefined : this.variableDeclaration.copy(),
      this.block.copy(),
    );
    node.flags = this.flags;
    node.pos = this.pos;
    node.end = this.end;
    return node;
  }
}

export class DebuggerStatement extends Node {
  constructor() {
    super(SyntaxKind.DebuggerStatement);
  }

  forEachChild(_v: NodeVisitor): boolean {
    return false;
  }

  deepClone(): Node {
    return this.copy();
  }

  copy(): DebuggerStatement {
    const node = new DebuggerStatement();
    node.flags = this.flags;
    node.pos = this.pos;
    node.end = this.end;
    return node;
  }
}

export class LabeledStatement extends Node {
  label: Identifier;
  statement: Statement;

  constructor(label: Identifier, statement: Statement) {
    super(SyntaxKind.LabeledStatement);
    this.label = label;
    this.statement = statement;
  }

  forEachChild(v: NodeVisitor): boolean {
    if (v.visitNode(this.label)) return true;
    return v.visitNode(this.statement);
  }

  deepClone(): Node {
    return this.copy();
  }

  copy(): LabeledStatement {
    const node = new LabeledStatement(this.label.copy(), this.statement.deepClone());
    node.flags = this.flags;
    node.pos = this.pos;
    node.end = this.end;
    return node;
  }
}

export class ExpressionStatement extends Node {
  expression: Expression;

  constructor(expression: Expression) {
    super(SyntaxKind.ExpressionStatement);
    this.expression = expression;
  }

  forEachChild(v: NodeVisitor): boolean {
    return v.visitNode(this.expression);
  }

  deepClone(): Node {
    return this.copy();
  }

  copy(): ExpressionStatement {
    const node = new ExpressionStatement(this.expression.deepClone());
    node.flags = this.flags;
    node.pos = this.pos;
    node.end = this.end;
    return node;
  }
}

export class Block extends Node {
  statements: NodeList;
  multiLine: boolean;

  constructor(statements: NodeList, multiLine: boolean) {
    super(SyntaxKind.Block);
    this.statements = statements;
    this.multiLine = multiLine;
  }

  forEachChild(v: NodeVisitor): boolean {
    return v.visitList(this.statements);
  }

  deepClone(): Node {
    return this.copy();
  }

  copy(): Block {
    const node = new Block(cloneList(this.statements), this.multiLine);
    node.flags = this.flags;
    node.pos = this.pos;
    node.end = this.end;
    return node;
  }
}

export class VariableStatement extends Node {
  modifiers: ModifierList | undefined;
  declarationList: VariableDeclarationList;

  constructor(modifiers: ModifierList | undefined, declarationList: VariableDeclarationList) {
    super(SyntaxKind.VariableStatement);
    this.modifiers = modifiers;
    this.declarationList = declarationList;
  }

  forEachChild(v: NodeVisitor): boolean {
    if (this.modifiers !== undefined && v.visitModifiers(this.modifiers)) return true;
    return v.visitNode(this.declarationList);
  }

  deepClone(): Node {
    return this.copy();
  }

  copy(): VariableStatement {
    const node = new VariableStatement(
      this.modifiers === undefined ? undefined : cloneModifiers(this.modifiers),
      this.declarationList.copy(),
    );
    node.flags = this.flags;
    node.pos = this.pos;
    node.end = this.end;
    return node;
  }
}

export class VariableDeclaration extends Node {
  name: BindingName;
  exclamationToken: Token | undefined;
  type: TypeNode | undefined;
  initializer: Expression | undefined;

  constructor(
    name: BindingName,
    exclamationToken: Token | undefined,
    type: TypeNode | undefined,
    initializer: Expression | undefined,
  ) {
    super(SyntaxKind.VariableDeclaration);
    this.name = name;
    this.exclamationToken = exclamationToken;
    this.type = type;
    this.initializer = initializer;
  }

  forEachChild(v: NodeVisitor): boolean {
    if (v.visitNode(this.name)) return true;
    if (this.exclamationToken !== undefined && v.visitNode(this.exclamationToken)) return true;
    if (this.type !== undefined && v.visitNode(this.type)) return true;
    return this.initializer !== undefined && v.visitNode(this.initializer);
  }

  deepClone(): Node {
    return this.copy();
  }

  copy(): VariableDeclaration {
    const node = new VariableDeclaration(
      this.name.deepClone(),
      this.exclamationToken === undefined ? undefined : this.exclamationToken.copy(),
      this.type === undefined ? undefined : this.type.deepClone(),
      this.initializer === undefined ? undefined : this.initializer.deepClone(),
    );
    node.flags = this.flags;
    node.pos = this.pos;
    node.end = this.end;
    return node;
  }
}

export class VariableDeclarationList extends Node {
  declarations: NodeList;

  constructor(declarations: NodeList, flags: NodeFlags) {
    super(SyntaxKind.VariableDeclarationList);
    this.declarations = declarations;
    this.flags = flags;
  }

  forEachChild(v: NodeVisitor): boolean {
    return v.visitList(this.declarations);
  }

  deepClone(): Node {
    return this.copy();
  }

  copy(): VariableDeclarationList {
    const node = new VariableDeclarationList(cloneList(this.declarations), this.flags);
    node.flags = this.flags;
    node.pos = this.pos;
    node.end = this.end;
    return node;
  }
}

export class BindingPattern extends Node {
  elements: NodeList;

  constructor(kind: SyntaxKind, elements: NodeList) {
    super(kind);
    this.elements = elements;
  }

  forEachChild(v: NodeVisitor): boolean {
    return v.visitList(this.elements);
  }

  deepClone(): Node {
    return this.copy();
  }

  copy(): BindingPattern {
    const node = new BindingPattern(this.kind, cloneList(this.elements));
    node.flags = this.flags;
    node.pos = this.pos;
    node.end = this.end;
    return node;
  }
}

export class ParameterDeclaration extends Node {
  modifiers: ModifierList | undefined;
  dotDotDotToken: Token | undefined;
  name: BindingName;
  questionToken: Token | undefined;
  type: TypeNode | undefined;
  initializer: Expression | undefined;

  constructor(
    modifiers: ModifierList | undefined,
    dotDotDotToken: Token | undefined,
    name: BindingName,
    questionToken: Token | undefined,
    type: TypeNode | undefined,
    initializer: Expression | undefined,
  ) {
    super(SyntaxKind.Parameter);
    this.modifiers = modifiers;
    this.dotDotDotToken = dotDotDotToken;
    this.name = name;
    this.questionToken = questionToken;
    this.type = type;
    this.initializer = initializer;
  }

  forEachChild(v: NodeVisitor): boolean {
    if (this.modifiers !== undefined && v.visitModifiers(this.modifiers)) return true;
    if (this.dotDotDotToken !== undefined && v.visitNode(this.dotDotDotToken)) return true;
    if (v.visitNode(this.name)) return true;
    if (this.questionToken !== undefined && v.visitNode(this.questionToken)) return true;
    if (this.type !== undefined && v.visitNode(this.type)) return true;
    return this.initializer !== undefined && v.visitNode(this.initializer);
  }

  deepClone(): Node {
    return this.copy();
  }

  copy(): ParameterDeclaration {
    const node = new ParameterDeclaration(
      this.modifiers === undefined ? undefined : cloneModifiers(this.modifiers),
      this.dotDotDotToken === undefined ? undefined : this.dotDotDotToken.copy(),
      this.name.deepClone(),
      this.questionToken === undefined ? undefined : this.questionToken.copy(),
      this.type === undefined ? undefined : this.type.deepClone(),
      this.initializer === undefined ? undefined : this.initializer.deepClone(),
    );
    node.flags = this.flags;
    node.pos = this.pos;
    node.end = this.end;
    return node;
  }
}

export class BindingElement extends Node {
  dotDotDotToken: Token | undefined;
  propertyName: PropertyName | undefined;
  name: BindingName | undefined;
  initializer: Expression | undefined;

  constructor(
    dotDotDotToken: Token | undefined,
    propertyName: PropertyName | undefined,
    name: BindingName | undefined,
    initializer: Expression | undefined,
  ) {
    super(SyntaxKind.BindingElement);
    this.dotDotDotToken = dotDotDotToken;
    this.propertyName = propertyName;
    this.name = name;
    this.initializer = initializer;
  }

  forEachChild(v: NodeVisitor): boolean {
    if (this.dotDotDotToken !== undefined && v.visitNode(this.dotDotDotToken)) return true;
    if (this.propertyName !== undefined && v.visitNode(this.propertyName)) return true;
    if (this.name !== undefined && v.visitNode(this.name)) return true;
    return this.initializer !== undefined && v.visitNode(this.initializer);
  }

  deepClone(): Node {
    return this.copy();
  }

  copy(): BindingElement {
    const node = new BindingElement(
      this.dotDotDotToken === undefined ? undefined : this.dotDotDotToken.copy(),
      this.propertyName === undefined ? undefined : this.propertyName.deepClone(),
      this.name === undefined ? undefined : this.name.deepClone(),
      this.initializer === undefined ? undefined : this.initializer.deepClone(),
    );
    node.flags = this.flags;
    node.pos = this.pos;
    node.end = this.end;
    return node;
  }
}

export class MissingDeclaration extends Node {
  modifiers: ModifierList | undefined;

  constructor(modifiers: ModifierList | undefined) {
    super(SyntaxKind.MissingDeclaration);
    this.modifiers = modifiers;
  }

  forEachChild(v: NodeVisitor): boolean {
    return this.modifiers !== undefined && v.visitModifiers(this.modifiers);
  }

  deepClone(): Node {
    return this.copy();
  }

  copy(): MissingDeclaration {
    const node = new MissingDeclaration(this.modifiers === undefined ? undefined : cloneModifiers(this.modifiers));
    node.flags = this.flags;
    node.pos = this.pos;
    node.end = this.end;
    return node;
  }
}

export class FunctionDeclaration extends Node {
  modifiers: ModifierList | undefined;
  asteriskToken: Token | undefined;
  name: Identifier | undefined;
  typeParameters: NodeList | undefined;
  parameters: NodeList;
  type: TypeNode | undefined;
  fullSignature: TypeNode | undefined;
  body: FunctionBody | undefined;

  constructor(
    modifiers: ModifierList | undefined,
    asteriskToken: Token | undefined,
    name: Identifier | undefined,
    typeParameters: NodeList | undefined,
    parameters: NodeList,
    type: TypeNode | undefined,
    fullSignature: TypeNode | undefined,
    body: FunctionBody | undefined,
  ) {
    super(SyntaxKind.FunctionDeclaration);
    this.modifiers = modifiers;
    this.asteriskToken = asteriskToken;
    this.name = name;
    this.typeParameters = typeParameters;
    this.parameters = parameters;
    this.type = type;
    this.fullSignature = fullSignature;
    this.body = body;
  }

  forEachChild(v: NodeVisitor): boolean {
    if (this.modifiers !== undefined && v.visitModifiers(this.modifiers)) return true;
    if (this.asteriskToken !== undefined && v.visitNode(this.asteriskToken)) return true;
    if (this.name !== undefined && v.visitNode(this.name)) return true;
    if (this.typeParameters !== undefined && v.visitList(this.typeParameters)) return true;
    if (v.visitList(this.parameters)) return true;
    if (this.type !== undefined && v.visitNode(this.type)) return true;
    if (this.fullSignature !== undefined && v.visitNode(this.fullSignature)) return true;
    return this.body !== undefined && v.visitNode(this.body);
  }

  deepClone(): Node {
    return this.copy();
  }

  copy(): FunctionDeclaration {
    const node = new FunctionDeclaration(
      this.modifiers === undefined ? undefined : cloneModifiers(this.modifiers),
      this.asteriskToken === undefined ? undefined : this.asteriskToken.copy(),
      this.name === undefined ? undefined : this.name.copy(),
      this.typeParameters === undefined ? undefined : cloneList(this.typeParameters),
      cloneList(this.parameters),
      this.type === undefined ? undefined : this.type.deepClone(),
      this.fullSignature === undefined ? undefined : this.fullSignature.deepClone(),
      this.body === undefined ? undefined : this.body.deepClone(),
    );
    node.flags = this.flags;
    node.pos = this.pos;
    node.end = this.end;
    return node;
  }
}

export class ClassDeclaration extends Node {
  modifiers: ModifierList | undefined;
  name: Identifier | undefined;
  typeParameters: NodeList | undefined;
  heritageClauses: NodeList | undefined;
  members: NodeList;

  constructor(
    modifiers: ModifierList | undefined,
    name: Identifier | undefined,
    typeParameters: NodeList | undefined,
    heritageClauses: NodeList | undefined,
    members: NodeList,
  ) {
    super(SyntaxKind.ClassDeclaration);
    this.modifiers = modifiers;
    this.name = name;
    this.typeParameters = typeParameters;
    this.heritageClauses = heritageClauses;
    this.members = members;
  }

  forEachChild(v: NodeVisitor): boolean {
    if (this.modifiers !== undefined && v.visitModifiers(this.modifiers)) return true;
    if (this.name !== undefined && v.visitNode(this.name)) return true;
    if (this.typeParameters !== undefined && v.visitList(this.typeParameters)) return true;
    if (this.heritageClauses !== undefined && v.visitList(this.heritageClauses)) return true;
    return v.visitList(this.members);
  }

  deepClone(): Node {
    return this.copy();
  }

  copy(): ClassDeclaration {
    const node = new ClassDeclaration(
      this.modifiers === undefined ? undefined : cloneModifiers(this.modifiers),
      this.name === undefined ? undefined : this.name.copy(),
      this.typeParameters === undefined ? undefined : cloneList(this.typeParameters),
      this.heritageClauses === undefined ? undefined : cloneList(this.heritageClauses),
      cloneList(this.members),
    );
    node.flags = this.flags;
    node.pos = this.pos;
    node.end = this.end;
    return node;
  }
}

export class ClassExpression extends Node {
  modifiers: ModifierList | undefined;
  name: Identifier | undefined;
  typeParameters: NodeList | undefined;
  heritageClauses: NodeList | undefined;
  members: NodeList;

  constructor(
    modifiers: ModifierList | undefined,
    name: Identifier | undefined,
    typeParameters: NodeList | undefined,
    heritageClauses: NodeList | undefined,
    members: NodeList,
  ) {
    super(SyntaxKind.ClassExpression);
    this.modifiers = modifiers;
    this.name = name;
    this.typeParameters = typeParameters;
    this.heritageClauses = heritageClauses;
    this.members = members;
  }

  forEachChild(v: NodeVisitor): boolean {
    if (this.modifiers !== undefined && v.visitModifiers(this.modifiers)) return true;
    if (this.name !== undefined && v.visitNode(this.name)) return true;
    if (this.typeParameters !== undefined && v.visitList(this.typeParameters)) return true;
    if (this.heritageClauses !== undefined && v.visitList(this.heritageClauses)) return true;
    return v.visitList(this.members);
  }

  deepClone(): Node {
    return this.copy();
  }

  copy(): ClassExpression {
    const node = new ClassExpression(
      this.modifiers === undefined ? undefined : cloneModifiers(this.modifiers),
      this.name === undefined ? undefined : this.name.copy(),
      this.typeParameters === undefined ? undefined : cloneList(this.typeParameters),
      this.heritageClauses === undefined ? undefined : cloneList(this.heritageClauses),
      cloneList(this.members),
    );
    node.flags = this.flags;
    node.pos = this.pos;
    node.end = this.end;
    return node;
  }
}

export class HeritageClause extends Node {
  token: SyntaxKind;
  types: NodeList;

  constructor(token: SyntaxKind, types: NodeList) {
    super(SyntaxKind.HeritageClause);
    this.token = token;
    this.types = types;
  }

  forEachChild(v: NodeVisitor): boolean {
    return v.visitList(this.types);
  }

  deepClone(): Node {
    return this.copy();
  }

  copy(): HeritageClause {
    const node = new HeritageClause(this.token, cloneList(this.types));
    node.flags = this.flags;
    node.pos = this.pos;
    node.end = this.end;
    return node;
  }
}

export class InterfaceDeclaration extends Node {
  modifiers: ModifierList | undefined;
  name: Identifier;
  typeParameters: NodeList | undefined;
  heritageClauses: NodeList | undefined;
  members: NodeList;

  constructor(
    modifiers: ModifierList | undefined,
    name: Identifier,
    typeParameters: NodeList | undefined,
    heritageClauses: NodeList | undefined,
    members: NodeList,
  ) {
    super(SyntaxKind.InterfaceDeclaration);
    this.modifiers = modifiers;
    this.name = name;
    this.typeParameters = typeParameters;
    this.heritageClauses = heritageClauses;
    this.members = members;
  }

  forEachChild(v: NodeVisitor): boolean {
    if (this.modifiers !== undefined && v.visitModifiers(this.modifiers)) return true;
    if (v.visitNode(this.name)) return true;
    if (this.typeParameters !== undefined && v.visitList(this.typeParameters)) return true;
    if (this.heritageClauses !== undefined && v.visitList(this.heritageClauses)) return true;
    return v.visitList(this.members);
  }

  deepClone(): Node {
    return this.copy();
  }

  copy(): InterfaceDeclaration {
    const node = new InterfaceDeclaration(
      this.modifiers === undefined ? undefined : cloneModifiers(this.modifiers),
      this.name.copy(),
      this.typeParameters === undefined ? undefined : cloneList(this.typeParameters),
      this.heritageClauses === undefined ? undefined : cloneList(this.heritageClauses),
      cloneList(this.members),
    );
    node.flags = this.flags;
    node.pos = this.pos;
    node.end = this.end;
    return node;
  }
}

export class TypeAliasDeclaration extends Node {
  modifiers: ModifierList | undefined;
  name: Identifier;
  typeParameters: NodeList | undefined;
  type: TypeNode;

  constructor(
    kind: SyntaxKind,
    modifiers: ModifierList | undefined,
    name: Identifier,
    typeParameters: NodeList | undefined,
    type: TypeNode,
  ) {
    super(kind);
    this.modifiers = modifiers;
    this.name = name;
    this.typeParameters = typeParameters;
    this.type = type;
  }

  forEachChild(v: NodeVisitor): boolean {
    if (this.modifiers !== undefined && v.visitModifiers(this.modifiers)) return true;
    if (v.visitNode(this.name)) return true;
    if (this.typeParameters !== undefined && v.visitList(this.typeParameters)) return true;
    return v.visitNode(this.type);
  }

  deepClone(): Node {
    return this.copy();
  }

  copy(): TypeAliasDeclaration {
    const node = new TypeAliasDeclaration(
      this.kind,
      this.modifiers === undefined ? undefined : cloneModifiers(this.modifiers),
      this.name.copy(),
      this.typeParameters === undefined ? undefined : cloneList(this.typeParameters),
      this.type.deepClone(),
    );
    node.flags = this.flags;
    node.pos = this.pos;
    node.end = this.end;
    return node;
  }
}

export class EnumMember extends Node {
  name: PropertyName;
  initializer: Expression | undefined;

  constructor(name: PropertyName, initializer: Expression | undefined) {
    super(SyntaxKind.EnumMember);
    this.name = name;
    this.initializer = initializer;
  }

  forEachChild(v: NodeVisitor): boolean {
    if (v.visitNode(this.name)) return true;
    return this.initializer !== undefined && v.visitNode(this.initializer);
  }

  deepClone(): Node {
    return this.copy();
  }

  copy(): EnumMember {
    const node = new EnumMember(
      this.name.deepClone(),
      this.initializer === undefined ? undefined : this.initializer.deepClone(),
    );
    node.flags = this.flags;
    node.pos = this.pos;
    node.end = this.end;
    return node;
  }
}

export class EnumDeclaration extends Node {
  modifiers: ModifierList | undefined;
  name: Identifier;
  members: NodeList;

  constructor(modifiers: ModifierList | undefined, name: Identifier, members: NodeList) {
    super(SyntaxKind.EnumDeclaration);
    this.modifiers = modifiers;
    this.name = name;
    this.members = members;
  }

  forEachChild(v: NodeVisitor): boolean {
    if (this.modifiers !== undefined && v.visitModifiers(this.modifiers)) return true;
    if (v.visitNode(this.name)) return true;
    return v.visitList(this.members);
  }

  deepClone(): Node {
    return this.copy();
  }

  copy(): EnumDeclaration {
    const node = new EnumDeclaration(
      this.modifiers === undefined ? undefined : cloneModifiers(this.modifiers),
      this.name.copy(),
      cloneList(this.members),
    );
    node.flags = this.flags;
    node.pos = this.pos;
    node.end = this.end;
    return node;
  }
}

export class ModuleBlock extends Node {
  statements: NodeList;

  constructor(statements: NodeList) {
    super(SyntaxKind.ModuleBlock);
    this.statements = statements;
  }

  forEachChild(v: NodeVisitor): boolean {
    return v.visitList(this.statements);
  }

  deepClone(): Node {
    return this.copy();
  }

  copy(): ModuleBlock {
    const node = new ModuleBlock(cloneList(this.statements));
    node.flags = this.flags;
    node.pos = this.pos;
    node.end = this.end;
    return node;
  }
}

export class NotEmittedStatement extends Node {
  constructor() {
    super(SyntaxKind.NotEmittedStatement);
  }

  forEachChild(_v: NodeVisitor): boolean {
    return false;
  }

  deepClone(): Node {
    return this.copy();
  }

  copy(): NotEmittedStatement {
    const node = new NotEmittedStatement();
    node.flags = this.flags;
    node.pos = this.pos;
    node.end = this.end;
    return node;
  }
}

export class NotEmittedTypeElement extends Node {
  constructor() {
    super(SyntaxKind.NotEmittedTypeElement);
  }

  forEachChild(_v: NodeVisitor): boolean {
    return false;
  }

  deepClone(): Node {
    return this.copy();
  }

  copy(): NotEmittedTypeElement {
    const node = new NotEmittedTypeElement();
    node.flags = this.flags;
    node.pos = this.pos;
    node.end = this.end;
    return node;
  }
}

export class ImportDeclaration extends Node {
  modifiers: ModifierList | undefined;
  importClause: ImportClause | undefined;
  moduleSpecifier: Expression;
  attributes: ImportAttributes | undefined;

  constructor(
    kind: SyntaxKind,
    modifiers: ModifierList | undefined,
    importClause: ImportClause | undefined,
    moduleSpecifier: Expression,
    attributes: ImportAttributes | undefined,
  ) {
    super(kind);
    this.modifiers = modifiers;
    this.importClause = importClause;
    this.moduleSpecifier = moduleSpecifier;
    this.attributes = attributes;
  }

  forEachChild(v: NodeVisitor): boolean {
    if (this.modifiers !== undefined && v.visitModifiers(this.modifiers)) return true;
    if (this.importClause !== undefined && v.visitNode(this.importClause)) return true;
    if (v.visitNode(this.moduleSpecifier)) return true;
    return this.attributes !== undefined && v.visitNode(this.attributes);
  }

  deepClone(): Node {
    return this.copy();
  }

  copy(): ImportDeclaration {
    const node = new ImportDeclaration(
      this.kind,
      this.modifiers === undefined ? undefined : cloneModifiers(this.modifiers),
      this.importClause === undefined ? undefined : this.importClause.copy(),
      this.moduleSpecifier.deepClone(),
      this.attributes === undefined ? undefined : this.attributes.copy(),
    );
    node.flags = this.flags;
    node.pos = this.pos;
    node.end = this.end;
    return node;
  }
}

export class ExternalModuleReference extends Node {
  expression: Expression;

  constructor(expression: Expression) {
    super(SyntaxKind.ExternalModuleReference);
    this.expression = expression;
  }

  forEachChild(v: NodeVisitor): boolean {
    return v.visitNode(this.expression);
  }

  deepClone(): Node {
    return this.copy();
  }

  copy(): ExternalModuleReference {
    const node = new ExternalModuleReference(this.expression.deepClone());
    node.flags = this.flags;
    node.pos = this.pos;
    node.end = this.end;
    return node;
  }
}

export class NamespaceImport extends Node {
  name: Identifier;

  constructor(name: Identifier) {
    super(SyntaxKind.NamespaceImport);
    this.name = name;
  }

  forEachChild(v: NodeVisitor): boolean {
    return v.visitNode(this.name);
  }

  deepClone(): Node {
    return this.copy();
  }

  copy(): NamespaceImport {
    const node = new NamespaceImport(this.name.copy());
    node.flags = this.flags;
    node.pos = this.pos;
    node.end = this.end;
    return node;
  }
}

export class NamedImports extends Node {
  elements: NodeList;

  constructor(elements: NodeList) {
    super(SyntaxKind.NamedImports);
    this.elements = elements;
  }

  forEachChild(v: NodeVisitor): boolean {
    return v.visitList(this.elements);
  }

  deepClone(): Node {
    return this.copy();
  }

  copy(): NamedImports {
    const node = new NamedImports(cloneList(this.elements));
    node.flags = this.flags;
    node.pos = this.pos;
    node.end = this.end;
    return node;
  }
}

export class ExportAssignment extends Node {
  modifiers: ModifierList | undefined;
  isExportEquals: boolean;
  type: TypeNode | undefined;
  expression: Expression;

  constructor(
    modifiers: ModifierList | undefined,
    isExportEquals: boolean,
    type: TypeNode | undefined,
    expression: Expression,
  ) {
    super(SyntaxKind.ExportAssignment);
    this.modifiers = modifiers;
    this.isExportEquals = isExportEquals;
    this.type = type;
    this.expression = expression;
  }

  forEachChild(v: NodeVisitor): boolean {
    if (this.modifiers !== undefined && v.visitModifiers(this.modifiers)) return true;
    if (this.type !== undefined && v.visitNode(this.type)) return true;
    return v.visitNode(this.expression);
  }

  deepClone(): Node {
    return this.copy();
  }

  copy(): ExportAssignment {
    const node = new ExportAssignment(
      this.modifiers === undefined ? undefined : cloneModifiers(this.modifiers),
      this.isExportEquals,
      this.type === undefined ? undefined : this.type.deepClone(),
      this.expression.deepClone(),
    );
    node.flags = this.flags;
    node.pos = this.pos;
    node.end = this.end;
    return node;
  }
}

export class NamespaceExportDeclaration extends Node {
  modifiers: ModifierList | undefined;
  name: Identifier;

  constructor(modifiers: ModifierList | undefined, name: Identifier) {
    super(SyntaxKind.NamespaceExportDeclaration);
    this.modifiers = modifiers;
    this.name = name;
  }

  forEachChild(v: NodeVisitor): boolean {
    if (this.modifiers !== undefined && v.visitModifiers(this.modifiers)) return true;
    return v.visitNode(this.name);
  }

  deepClone(): Node {
    return this.copy();
  }

  copy(): NamespaceExportDeclaration {
    const node = new NamespaceExportDeclaration(
      this.modifiers === undefined ? undefined : cloneModifiers(this.modifiers),
      this.name.copy(),
    );
    node.flags = this.flags;
    node.pos = this.pos;
    node.end = this.end;
    return node;
  }
}

export class NamespaceExport extends Node {
  name: ModuleExportName;

  constructor(name: ModuleExportName) {
    super(SyntaxKind.NamespaceExport);
    this.name = name;
  }

  forEachChild(v: NodeVisitor): boolean {
    return v.visitNode(this.name);
  }

  deepClone(): Node {
    return this.copy();
  }

  copy(): NamespaceExport {
    const node = new NamespaceExport(this.name.deepClone());
    node.flags = this.flags;
    node.pos = this.pos;
    node.end = this.end;
    return node;
  }
}

export class NamedExports extends Node {
  elements: NodeList;

  constructor(elements: NodeList) {
    super(SyntaxKind.NamedExports);
    this.elements = elements;
  }

  forEachChild(v: NodeVisitor): boolean {
    return v.visitList(this.elements);
  }

  deepClone(): Node {
    return this.copy();
  }

  copy(): NamedExports {
    const node = new NamedExports(cloneList(this.elements));
    node.flags = this.flags;
    node.pos = this.pos;
    node.end = this.end;
    return node;
  }
}

export class ExportSpecifier extends Node {
  isTypeOnly: boolean;
  propertyName: ModuleExportName | undefined;
  name: ModuleExportName;

  constructor(isTypeOnly: boolean, propertyName: ModuleExportName | undefined, name: ModuleExportName) {
    super(SyntaxKind.ExportSpecifier);
    this.isTypeOnly = isTypeOnly;
    this.propertyName = propertyName;
    this.name = name;
  }

  forEachChild(v: NodeVisitor): boolean {
    if (this.propertyName !== undefined && v.visitNode(this.propertyName)) return true;
    return v.visitNode(this.name);
  }

  deepClone(): Node {
    return this.copy();
  }

  copy(): ExportSpecifier {
    const node = new ExportSpecifier(
      this.isTypeOnly,
      this.propertyName === undefined ? undefined : this.propertyName.deepClone(),
      this.name.deepClone(),
    );
    node.flags = this.flags;
    node.pos = this.pos;
    node.end = this.end;
    return node;
  }
}

export class CallSignatureDeclaration extends Node {
  typeParameters: NodeList | undefined;
  parameters: NodeList;
  type: TypeNode | undefined;

  constructor(typeParameters: NodeList | undefined, parameters: NodeList, type: TypeNode | undefined) {
    super(SyntaxKind.CallSignature);
    this.typeParameters = typeParameters;
    this.parameters = parameters;
    this.type = type;
  }

  forEachChild(v: NodeVisitor): boolean {
    if (this.typeParameters !== undefined && v.visitList(this.typeParameters)) return true;
    if (v.visitList(this.parameters)) return true;
    return this.type !== undefined && v.visitNode(this.type);
  }

  deepClone(): Node {
    return this.copy();
  }

  copy(): CallSignatureDeclaration {
    const node = new CallSignatureDeclaration(
      this.typeParameters === undefined ? undefined : cloneList(this.typeParameters),
      cloneList(this.parameters),
      this.type === undefined ? undefined : this.type.deepClone(),
    );
    node.flags = this.flags;
    node.pos = this.pos;
    node.end = this.end;
    return node;
  }
}

export class ConstructSignatureDeclaration extends Node {
  typeParameters: NodeList | undefined;
  parameters: NodeList;
  type: TypeNode | undefined;

  constructor(typeParameters: NodeList | undefined, parameters: NodeList, type: TypeNode | undefined) {
    super(SyntaxKind.ConstructSignature);
    this.typeParameters = typeParameters;
    this.parameters = parameters;
    this.type = type;
  }

  forEachChild(v: NodeVisitor): boolean {
    if (this.typeParameters !== undefined && v.visitList(this.typeParameters)) return true;
    if (v.visitList(this.parameters)) return true;
    return this.type !== undefined && v.visitNode(this.type);
  }

  deepClone(): Node {
    return this.copy();
  }

  copy(): ConstructSignatureDeclaration {
    const node = new ConstructSignatureDeclaration(
      this.typeParameters === undefined ? undefined : cloneList(this.typeParameters),
      cloneList(this.parameters),
      this.type === undefined ? undefined : this.type.deepClone(),
    );
    node.flags = this.flags;
    node.pos = this.pos;
    node.end = this.end;
    return node;
  }
}

export class ConstructorDeclaration extends Node {
  modifiers: ModifierList | undefined;
  typeParameters: NodeList | undefined;
  parameters: NodeList;
  type: TypeNode | undefined;
  fullSignature: TypeNode | undefined;
  body: FunctionBody | undefined;

  constructor(
    modifiers: ModifierList | undefined,
    typeParameters: NodeList | undefined,
    parameters: NodeList,
    type: TypeNode | undefined,
    fullSignature: TypeNode | undefined,
    body: FunctionBody | undefined,
  ) {
    super(SyntaxKind.Constructor);
    this.modifiers = modifiers;
    this.typeParameters = typeParameters;
    this.parameters = parameters;
    this.type = type;
    this.fullSignature = fullSignature;
    this.body = body;
  }

  forEachChild(v: NodeVisitor): boolean {
    if (this.modifiers !== undefined && v.visitModifiers(this.modifiers)) return true;
    if (this.typeParameters !== undefined && v.visitList(this.typeParameters)) return true;
    if (v.visitList(this.parameters)) return true;
    if (this.type !== undefined && v.visitNode(this.type)) return true;
    if (this.fullSignature !== undefined && v.visitNode(this.fullSignature)) return true;
    return this.body !== undefined && v.visitNode(this.body);
  }

  deepClone(): Node {
    return this.copy();
  }

  copy(): ConstructorDeclaration {
    const node = new ConstructorDeclaration(
      this.modifiers === undefined ? undefined : cloneModifiers(this.modifiers),
      this.typeParameters === undefined ? undefined : cloneList(this.typeParameters),
      cloneList(this.parameters),
      this.type === undefined ? undefined : this.type.deepClone(),
      this.fullSignature === undefined ? undefined : this.fullSignature.deepClone(),
      this.body === undefined ? undefined : this.body.deepClone(),
    );
    node.flags = this.flags;
    node.pos = this.pos;
    node.end = this.end;
    return node;
  }
}

export class GetAccessorDeclaration extends Node {
  modifiers: ModifierList | undefined;
  name: PropertyName;
  typeParameters: NodeList | undefined;
  parameters: NodeList;
  type: TypeNode | undefined;
  fullSignature: TypeNode | undefined;
  body: FunctionBody | undefined;

  constructor(
    modifiers: ModifierList | undefined,
    name: PropertyName,
    typeParameters: NodeList | undefined,
    parameters: NodeList,
    type: TypeNode | undefined,
    fullSignature: TypeNode | undefined,
    body: FunctionBody | undefined,
  ) {
    super(SyntaxKind.GetAccessor);
    this.modifiers = modifiers;
    this.name = name;
    this.typeParameters = typeParameters;
    this.parameters = parameters;
    this.type = type;
    this.fullSignature = fullSignature;
    this.body = body;
  }

  forEachChild(v: NodeVisitor): boolean {
    if (this.modifiers !== undefined && v.visitModifiers(this.modifiers)) return true;
    if (v.visitNode(this.name)) return true;
    if (this.typeParameters !== undefined && v.visitList(this.typeParameters)) return true;
    if (v.visitList(this.parameters)) return true;
    if (this.type !== undefined && v.visitNode(this.type)) return true;
    if (this.fullSignature !== undefined && v.visitNode(this.fullSignature)) return true;
    return this.body !== undefined && v.visitNode(this.body);
  }

  deepClone(): Node {
    return this.copy();
  }

  copy(): GetAccessorDeclaration {
    const node = new GetAccessorDeclaration(
      this.modifiers === undefined ? undefined : cloneModifiers(this.modifiers),
      this.name.deepClone(),
      this.typeParameters === undefined ? undefined : cloneList(this.typeParameters),
      cloneList(this.parameters),
      this.type === undefined ? undefined : this.type.deepClone(),
      this.fullSignature === undefined ? undefined : this.fullSignature.deepClone(),
      this.body === undefined ? undefined : this.body.deepClone(),
    );
    node.flags = this.flags;
    node.pos = this.pos;
    node.end = this.end;
    return node;
  }
}

export class SetAccessorDeclaration extends Node {
  modifiers: ModifierList | undefined;
  name: PropertyName;
  typeParameters: NodeList | undefined;
  parameters: NodeList;
  type: TypeNode | undefined;
  fullSignature: TypeNode | undefined;
  body: FunctionBody | undefined;

  constructor(
    modifiers: ModifierList | undefined,
    name: PropertyName,
    typeParameters: NodeList | undefined,
    parameters: NodeList,
    type: TypeNode | undefined,
    fullSignature: TypeNode | undefined,
    body: FunctionBody | undefined,
  ) {
    super(SyntaxKind.SetAccessor);
    this.modifiers = modifiers;
    this.name = name;
    this.typeParameters = typeParameters;
    this.parameters = parameters;
    this.type = type;
    this.fullSignature = fullSignature;
    this.body = body;
  }

  forEachChild(v: NodeVisitor): boolean {
    if (this.modifiers !== undefined && v.visitModifiers(this.modifiers)) return true;
    if (v.visitNode(this.name)) return true;
    if (this.typeParameters !== undefined && v.visitList(this.typeParameters)) return true;
    if (v.visitList(this.parameters)) return true;
    if (this.type !== undefined && v.visitNode(this.type)) return true;
    if (this.fullSignature !== undefined && v.visitNode(this.fullSignature)) return true;
    return this.body !== undefined && v.visitNode(this.body);
  }

  deepClone(): Node {
    return this.copy();
  }

  copy(): SetAccessorDeclaration {
    const node = new SetAccessorDeclaration(
      this.modifiers === undefined ? undefined : cloneModifiers(this.modifiers),
      this.name.deepClone(),
      this.typeParameters === undefined ? undefined : cloneList(this.typeParameters),
      cloneList(this.parameters),
      this.type === undefined ? undefined : this.type.deepClone(),
      this.fullSignature === undefined ? undefined : this.fullSignature.deepClone(),
      this.body === undefined ? undefined : this.body.deepClone(),
    );
    node.flags = this.flags;
    node.pos = this.pos;
    node.end = this.end;
    return node;
  }
}

export class IndexSignatureDeclaration extends Node {
  modifiers: ModifierList | undefined;
  parameters: NodeList;
  type: TypeNode | undefined;

  constructor(modifiers: ModifierList | undefined, parameters: NodeList, type: TypeNode | undefined) {
    super(SyntaxKind.IndexSignature);
    this.modifiers = modifiers;
    this.parameters = parameters;
    this.type = type;
  }

  forEachChild(v: NodeVisitor): boolean {
    if (this.modifiers !== undefined && v.visitModifiers(this.modifiers)) return true;
    if (v.visitList(this.parameters)) return true;
    return this.type !== undefined && v.visitNode(this.type);
  }

  deepClone(): Node {
    return this.copy();
  }

  copy(): IndexSignatureDeclaration {
    const node = new IndexSignatureDeclaration(
      this.modifiers === undefined ? undefined : cloneModifiers(this.modifiers),
      cloneList(this.parameters),
      this.type === undefined ? undefined : this.type.deepClone(),
    );
    node.flags = this.flags;
    node.pos = this.pos;
    node.end = this.end;
    return node;
  }
}

export class MethodSignatureDeclaration extends Node {
  modifiers: ModifierList | undefined;
  name: PropertyName;
  postfixToken: Token | undefined;
  typeParameters: NodeList | undefined;
  parameters: NodeList;
  type: TypeNode | undefined;

  constructor(
    modifiers: ModifierList | undefined,
    name: PropertyName,
    postfixToken: Token | undefined,
    typeParameters: NodeList | undefined,
    parameters: NodeList,
    type: TypeNode | undefined,
  ) {
    super(SyntaxKind.MethodSignature);
    this.modifiers = modifiers;
    this.name = name;
    this.postfixToken = postfixToken;
    this.typeParameters = typeParameters;
    this.parameters = parameters;
    this.type = type;
  }

  forEachChild(v: NodeVisitor): boolean {
    if (this.modifiers !== undefined && v.visitModifiers(this.modifiers)) return true;
    if (v.visitNode(this.name)) return true;
    if (this.postfixToken !== undefined && v.visitNode(this.postfixToken)) return true;
    if (this.typeParameters !== undefined && v.visitList(this.typeParameters)) return true;
    if (v.visitList(this.parameters)) return true;
    return this.type !== undefined && v.visitNode(this.type);
  }

  deepClone(): Node {
    return this.copy();
  }

  copy(): MethodSignatureDeclaration {
    const node = new MethodSignatureDeclaration(
      this.modifiers === undefined ? undefined : cloneModifiers(this.modifiers),
      this.name.deepClone(),
      this.postfixToken === undefined ? undefined : this.postfixToken.copy(),
      this.typeParameters === undefined ? undefined : cloneList(this.typeParameters),
      cloneList(this.parameters),
      this.type === undefined ? undefined : this.type.deepClone(),
    );
    node.flags = this.flags;
    node.pos = this.pos;
    node.end = this.end;
    return node;
  }
}

export class MethodDeclaration extends Node {
  modifiers: ModifierList | undefined;
  asteriskToken: Token | undefined;
  name: PropertyName;
  postfixToken: Token | undefined;
  typeParameters: NodeList | undefined;
  parameters: NodeList;
  type: TypeNode | undefined;
  fullSignature: TypeNode | undefined;
  body: FunctionBody | undefined;

  constructor(
    modifiers: ModifierList | undefined,
    asteriskToken: Token | undefined,
    name: PropertyName,
    postfixToken: Token | undefined,
    typeParameters: NodeList | undefined,
    parameters: NodeList,
    type: TypeNode | undefined,
    fullSignature: TypeNode | undefined,
    body: FunctionBody | undefined,
  ) {
    super(SyntaxKind.MethodDeclaration);
    this.modifiers = modifiers;
    this.asteriskToken = asteriskToken;
    this.name = name;
    this.postfixToken = postfixToken;
    this.typeParameters = typeParameters;
    this.parameters = parameters;
    this.type = type;
    this.fullSignature = fullSignature;
    this.body = body;
  }

  forEachChild(v: NodeVisitor): boolean {
    if (this.modifiers !== undefined && v.visitModifiers(this.modifiers)) return true;
    if (this.asteriskToken !== undefined && v.visitNode(this.asteriskToken)) return true;
    if (v.visitNode(this.name)) return true;
    if (this.postfixToken !== undefined && v.visitNode(this.postfixToken)) return true;
    if (this.typeParameters !== undefined && v.visitList(this.typeParameters)) return true;
    if (v.visitList(this.parameters)) return true;
    if (this.type !== undefined && v.visitNode(this.type)) return true;
    if (this.fullSignature !== undefined && v.visitNode(this.fullSignature)) return true;
    return this.body !== undefined && v.visitNode(this.body);
  }

  deepClone(): Node {
    return this.copy();
  }

  copy(): MethodDeclaration {
    const node = new MethodDeclaration(
      this.modifiers === undefined ? undefined : cloneModifiers(this.modifiers),
      this.asteriskToken === undefined ? undefined : this.asteriskToken.copy(),
      this.name.deepClone(),
      this.postfixToken === undefined ? undefined : this.postfixToken.copy(),
      this.typeParameters === undefined ? undefined : cloneList(this.typeParameters),
      cloneList(this.parameters),
      this.type === undefined ? undefined : this.type.deepClone(),
      this.fullSignature === undefined ? undefined : this.fullSignature.deepClone(),
      this.body === undefined ? undefined : this.body.deepClone(),
    );
    node.flags = this.flags;
    node.pos = this.pos;
    node.end = this.end;
    return node;
  }
}

export class PropertySignatureDeclaration extends Node {
  modifiers: ModifierList | undefined;
  name: PropertyName;
  postfixToken: Token | undefined;
  type: TypeNode | undefined;
  initializer: Expression | undefined;

  constructor(
    modifiers: ModifierList | undefined,
    name: PropertyName,
    postfixToken: Token | undefined,
    type: TypeNode | undefined,
    initializer: Expression | undefined,
  ) {
    super(SyntaxKind.PropertySignature);
    this.modifiers = modifiers;
    this.name = name;
    this.postfixToken = postfixToken;
    this.type = type;
    this.initializer = initializer;
  }

  forEachChild(v: NodeVisitor): boolean {
    if (this.modifiers !== undefined && v.visitModifiers(this.modifiers)) return true;
    if (v.visitNode(this.name)) return true;
    if (this.postfixToken !== undefined && v.visitNode(this.postfixToken)) return true;
    if (this.type !== undefined && v.visitNode(this.type)) return true;
    return this.initializer !== undefined && v.visitNode(this.initializer);
  }

  deepClone(): Node {
    return this.copy();
  }

  copy(): PropertySignatureDeclaration {
    const node = new PropertySignatureDeclaration(
      this.modifiers === undefined ? undefined : cloneModifiers(this.modifiers),
      this.name.deepClone(),
      this.postfixToken === undefined ? undefined : this.postfixToken.copy(),
      this.type === undefined ? undefined : this.type.deepClone(),
      this.initializer === undefined ? undefined : this.initializer.deepClone(),
    );
    node.flags = this.flags;
    node.pos = this.pos;
    node.end = this.end;
    return node;
  }
}

export class PropertyDeclaration extends Node {
  modifiers: ModifierList | undefined;
  name: PropertyName;
  postfixToken: Token | undefined;
  type: TypeNode | undefined;
  initializer: Expression | undefined;

  constructor(
    modifiers: ModifierList | undefined,
    name: PropertyName,
    postfixToken: Token | undefined,
    type: TypeNode | undefined,
    initializer: Expression | undefined,
  ) {
    super(SyntaxKind.PropertyDeclaration);
    this.modifiers = modifiers;
    this.name = name;
    this.postfixToken = postfixToken;
    this.type = type;
    this.initializer = initializer;
  }

  forEachChild(v: NodeVisitor): boolean {
    if (this.modifiers !== undefined && v.visitModifiers(this.modifiers)) return true;
    if (v.visitNode(this.name)) return true;
    if (this.postfixToken !== undefined && v.visitNode(this.postfixToken)) return true;
    if (this.type !== undefined && v.visitNode(this.type)) return true;
    return this.initializer !== undefined && v.visitNode(this.initializer);
  }

  deepClone(): Node {
    return this.copy();
  }

  copy(): PropertyDeclaration {
    const node = new PropertyDeclaration(
      this.modifiers === undefined ? undefined : cloneModifiers(this.modifiers),
      this.name.deepClone(),
      this.postfixToken === undefined ? undefined : this.postfixToken.copy(),
      this.type === undefined ? undefined : this.type.deepClone(),
      this.initializer === undefined ? undefined : this.initializer.deepClone(),
    );
    node.flags = this.flags;
    node.pos = this.pos;
    node.end = this.end;
    return node;
  }
}

export class SemicolonClassElement extends Node {
  constructor() {
    super(SyntaxKind.SemicolonClassElement);
  }

  forEachChild(_v: NodeVisitor): boolean {
    return false;
  }

  deepClone(): Node {
    return this.copy();
  }

  copy(): SemicolonClassElement {
    const node = new SemicolonClassElement();
    node.flags = this.flags;
    node.pos = this.pos;
    node.end = this.end;
    return node;
  }
}

export class ClassStaticBlockDeclaration extends Node {
  modifiers: ModifierList | undefined;
  body: Block;

  constructor(modifiers: ModifierList | undefined, body: Block) {
    super(SyntaxKind.ClassStaticBlockDeclaration);
    this.modifiers = modifiers;
    this.body = body;
  }

  forEachChild(v: NodeVisitor): boolean {
    if (this.modifiers !== undefined && v.visitModifiers(this.modifiers)) return true;
    return v.visitNode(this.body);
  }

  deepClone(): Node {
    return this.copy();
  }

  copy(): ClassStaticBlockDeclaration {
    const node = new ClassStaticBlockDeclaration(
      this.modifiers === undefined ? undefined : cloneModifiers(this.modifiers),
      this.body.copy(),
    );
    node.flags = this.flags;
    node.pos = this.pos;
    node.end = this.end;
    return node;
  }
}

export class OmittedExpression extends Node {
  constructor() {
    super(SyntaxKind.OmittedExpression);
  }

  forEachChild(_v: NodeVisitor): boolean {
    return false;
  }

  deepClone(): Node {
    return this.copy();
  }

  copy(): OmittedExpression {
    const node = new OmittedExpression();
    node.flags = this.flags;
    node.pos = this.pos;
    node.end = this.end;
    return node;
  }
}

export class KeywordExpression extends Node {
  constructor(kind: SyntaxKind) {
    super(kind);
  }

  forEachChild(_v: NodeVisitor): boolean {
    return false;
  }

  deepClone(): Node {
    return this.copy();
  }

  copy(): KeywordExpression {
    const node = new KeywordExpression(this.kind);
    node.flags = this.flags;
    node.pos = this.pos;
    node.end = this.end;
    return node;
  }
}

export class StringLiteral extends Node {
  text: string;
  tokenFlags: TokenFlags;

  constructor(text: string, tokenFlags: TokenFlags) {
    super(SyntaxKind.StringLiteral);
    this.text = text;
    this.tokenFlags = tokenFlags & TokenFlags.StringLiteralFlags;
  }

  forEachChild(_v: NodeVisitor): boolean {
    return false;
  }

  deepClone(): Node {
    return this.copy();
  }

  copy(): StringLiteral {
    const node = new StringLiteral(this.text, this.tokenFlags);
    node.flags = this.flags;
    node.pos = this.pos;
    node.end = this.end;
    return node;
  }
}

export class NumericLiteral extends Node {
  text: string;
  tokenFlags: TokenFlags;

  constructor(text: string, tokenFlags: TokenFlags) {
    super(SyntaxKind.NumericLiteral);
    this.text = text;
    this.tokenFlags = tokenFlags & TokenFlags.NumericLiteralFlags;
  }

  forEachChild(_v: NodeVisitor): boolean {
    return false;
  }

  deepClone(): Node {
    return this.copy();
  }

  copy(): NumericLiteral {
    const node = new NumericLiteral(this.text, this.tokenFlags);
    node.flags = this.flags;
    node.pos = this.pos;
    node.end = this.end;
    return node;
  }
}

export class BigIntLiteral extends Node {
  text: string;
  tokenFlags: TokenFlags;

  constructor(text: string, tokenFlags: TokenFlags) {
    super(SyntaxKind.BigIntLiteral);
    this.text = text;
    this.tokenFlags = tokenFlags & TokenFlags.NumericLiteralFlags;
  }

  forEachChild(_v: NodeVisitor): boolean {
    return false;
  }

  deepClone(): Node {
    return this.copy();
  }

  copy(): BigIntLiteral {
    const node = new BigIntLiteral(this.text, this.tokenFlags);
    node.flags = this.flags;
    node.pos = this.pos;
    node.end = this.end;
    return node;
  }
}

export class RegularExpressionLiteral extends Node {
  text: string;
  tokenFlags: TokenFlags;

  constructor(text: string, tokenFlags: TokenFlags) {
    super(SyntaxKind.RegularExpressionLiteral);
    this.text = text;
    this.tokenFlags = tokenFlags & TokenFlags.RegularExpressionLiteralFlags;
  }

  forEachChild(_v: NodeVisitor): boolean {
    return false;
  }

  deepClone(): Node {
    return this.copy();
  }

  copy(): RegularExpressionLiteral {
    const node = new RegularExpressionLiteral(this.text, this.tokenFlags);
    node.flags = this.flags;
    node.pos = this.pos;
    node.end = this.end;
    return node;
  }
}

export class NoSubstitutionTemplateLiteral extends Node {
  text: string;
  templateFlags: TokenFlags;

  constructor(text: string, templateFlags: TokenFlags) {
    super(SyntaxKind.NoSubstitutionTemplateLiteral);
    this.text = text;
    this.templateFlags = templateFlags & TokenFlags.TemplateLiteralLikeFlags;
  }

  forEachChild(_v: NodeVisitor): boolean {
    return false;
  }

  deepClone(): Node {
    return this.copy();
  }

  copy(): NoSubstitutionTemplateLiteral {
    const node = new NoSubstitutionTemplateLiteral(this.text, this.templateFlags);
    node.flags = this.flags;
    node.pos = this.pos;
    node.end = this.end;
    return node;
  }
}

export class BinaryExpression extends Node {
  modifiers: ModifierList | undefined;
  left: Expression;
  type: TypeNode | undefined;
  operatorToken: Token;
  right: Expression;

  constructor(
    modifiers: ModifierList | undefined,
    left: Expression,
    type: TypeNode | undefined,
    operatorToken: Token,
    right: Expression,
  ) {
    super(SyntaxKind.BinaryExpression);
    this.modifiers = modifiers;
    this.left = left;
    this.type = type;
    this.operatorToken = operatorToken;
    this.right = right;
  }

  forEachChild(v: NodeVisitor): boolean {
    if (this.modifiers !== undefined && v.visitModifiers(this.modifiers)) return true;
    if (v.visitNode(this.left)) return true;
    if (this.type !== undefined && v.visitNode(this.type)) return true;
    if (v.visitNode(this.operatorToken)) return true;
    return v.visitNode(this.right);
  }

  deepClone(): Node {
    return this.copy();
  }

  copy(): BinaryExpression {
    const node = new BinaryExpression(
      this.modifiers === undefined ? undefined : cloneModifiers(this.modifiers),
      this.left.deepClone(),
      this.type === undefined ? undefined : this.type.deepClone(),
      this.operatorToken.copy(),
      this.right.deepClone(),
    );
    node.flags = this.flags;
    node.pos = this.pos;
    node.end = this.end;
    return node;
  }
}

export class PrefixUnaryExpression extends Node {
  operator: SyntaxKind;
  operand: Expression;

  constructor(operator: SyntaxKind, operand: Expression) {
    super(SyntaxKind.PrefixUnaryExpression);
    this.operator = operator;
    this.operand = operand;
  }

  forEachChild(v: NodeVisitor): boolean {
    return v.visitNode(this.operand);
  }

  deepClone(): Node {
    return this.copy();
  }

  copy(): PrefixUnaryExpression {
    const node = new PrefixUnaryExpression(this.operator, this.operand.deepClone());
    node.flags = this.flags;
    node.pos = this.pos;
    node.end = this.end;
    return node;
  }
}

export class PostfixUnaryExpression extends Node {
  operand: Expression;
  operator: SyntaxKind;

  constructor(operand: Expression, operator: SyntaxKind) {
    super(SyntaxKind.PostfixUnaryExpression);
    this.operand = operand;
    this.operator = operator;
  }

  forEachChild(v: NodeVisitor): boolean {
    return v.visitNode(this.operand);
  }

  deepClone(): Node {
    return this.copy();
  }

  copy(): PostfixUnaryExpression {
    const node = new PostfixUnaryExpression(this.operand.deepClone(), this.operator);
    node.flags = this.flags;
    node.pos = this.pos;
    node.end = this.end;
    return node;
  }
}

export class YieldExpression extends Node {
  asteriskToken: Token | undefined;
  expression: Expression | undefined;

  constructor(asteriskToken: Token | undefined, expression: Expression | undefined) {
    super(SyntaxKind.YieldExpression);
    this.asteriskToken = asteriskToken;
    this.expression = expression;
  }

  forEachChild(v: NodeVisitor): boolean {
    if (this.asteriskToken !== undefined && v.visitNode(this.asteriskToken)) return true;
    return this.expression !== undefined && v.visitNode(this.expression);
  }

  deepClone(): Node {
    return this.copy();
  }

  copy(): YieldExpression {
    const node = new YieldExpression(
      this.asteriskToken === undefined ? undefined : this.asteriskToken.copy(),
      this.expression === undefined ? undefined : this.expression.deepClone(),
    );
    node.flags = this.flags;
    node.pos = this.pos;
    node.end = this.end;
    return node;
  }
}

export class ArrowFunction extends Node {
  modifiers: ModifierList | undefined;
  typeParameters: NodeList | undefined;
  parameters: NodeList;
  type: TypeNode | undefined;
  fullSignature: TypeNode | undefined;
  equalsGreaterThanToken: Token;
  body: ConciseBody;

  constructor(
    modifiers: ModifierList | undefined,
    typeParameters: NodeList | undefined,
    parameters: NodeList,
    type: TypeNode | undefined,
    fullSignature: TypeNode | undefined,
    equalsGreaterThanToken: Token,
    body: ConciseBody,
  ) {
    super(SyntaxKind.ArrowFunction);
    this.modifiers = modifiers;
    this.typeParameters = typeParameters;
    this.parameters = parameters;
    this.type = type;
    this.fullSignature = fullSignature;
    this.equalsGreaterThanToken = equalsGreaterThanToken;
    this.body = body;
  }

  forEachChild(v: NodeVisitor): boolean {
    if (this.modifiers !== undefined && v.visitModifiers(this.modifiers)) return true;
    if (this.typeParameters !== undefined && v.visitList(this.typeParameters)) return true;
    if (v.visitList(this.parameters)) return true;
    if (this.type !== undefined && v.visitNode(this.type)) return true;
    if (this.fullSignature !== undefined && v.visitNode(this.fullSignature)) return true;
    if (v.visitNode(this.equalsGreaterThanToken)) return true;
    return v.visitNode(this.body);
  }

  deepClone(): Node {
    return this.copy();
  }

  copy(): ArrowFunction {
    const node = new ArrowFunction(
      this.modifiers === undefined ? undefined : cloneModifiers(this.modifiers),
      this.typeParameters === undefined ? undefined : cloneList(this.typeParameters),
      cloneList(this.parameters),
      this.type === undefined ? undefined : this.type.deepClone(),
      this.fullSignature === undefined ? undefined : this.fullSignature.deepClone(),
      this.equalsGreaterThanToken.copy(),
      this.body.deepClone(),
    );
    node.flags = this.flags;
    node.pos = this.pos;
    node.end = this.end;
    return node;
  }
}

export class FunctionExpression extends Node {
  modifiers: ModifierList | undefined;
  asteriskToken: Token | undefined;
  name: Identifier | undefined;
  typeParameters: NodeList | undefined;
  parameters: NodeList;
  type: TypeNode | undefined;
  fullSignature: TypeNode | undefined;
  body: FunctionBody;

  constructor(
    modifiers: ModifierList | undefined,
    asteriskToken: Token | undefined,
    name: Identifier | undefined,
    typeParameters: NodeList | undefined,
    parameters: NodeList,
    type: TypeNode | undefined,
    fullSignature: TypeNode | undefined,
    body: FunctionBody,
  ) {
    super(SyntaxKind.FunctionExpression);
    this.modifiers = modifiers;
    this.asteriskToken = asteriskToken;
    this.name = name;
    this.typeParameters = typeParameters;
    this.parameters = parameters;
    this.type = type;
    this.fullSignature = fullSignature;
    this.body = body;
  }

  forEachChild(v: NodeVisitor): boolean {
    if (this.modifiers !== undefined && v.visitModifiers(this.modifiers)) return true;
    if (this.asteriskToken !== undefined && v.visitNode(this.asteriskToken)) return true;
    if (this.name !== undefined && v.visitNode(this.name)) return true;
    if (this.typeParameters !== undefined && v.visitList(this.typeParameters)) return true;
    if (v.visitList(this.parameters)) return true;
    if (this.type !== undefined && v.visitNode(this.type)) return true;
    if (this.fullSignature !== undefined && v.visitNode(this.fullSignature)) return true;
    return v.visitNode(this.body);
  }

  deepClone(): Node {
    return this.copy();
  }

  copy(): FunctionExpression {
    const node = new FunctionExpression(
      this.modifiers === undefined ? undefined : cloneModifiers(this.modifiers),
      this.asteriskToken === undefined ? undefined : this.asteriskToken.copy(),
      this.name === undefined ? undefined : this.name.copy(),
      this.typeParameters === undefined ? undefined : cloneList(this.typeParameters),
      cloneList(this.parameters),
      this.type === undefined ? undefined : this.type.deepClone(),
      this.fullSignature === undefined ? undefined : this.fullSignature.deepClone(),
      this.body.deepClone(),
    );
    node.flags = this.flags;
    node.pos = this.pos;
    node.end = this.end;
    return node;
  }
}

export class AsExpression extends Node {
  expression: Expression;
  type: TypeNode;

  constructor(expression: Expression, type: TypeNode) {
    super(SyntaxKind.AsExpression);
    this.expression = expression;
    this.type = type;
  }

  forEachChild(v: NodeVisitor): boolean {
    if (v.visitNode(this.expression)) return true;
    return v.visitNode(this.type);
  }

  deepClone(): Node {
    return this.copy();
  }

  copy(): AsExpression {
    const node = new AsExpression(this.expression.deepClone(), this.type.deepClone());
    node.flags = this.flags;
    node.pos = this.pos;
    node.end = this.end;
    return node;
  }
}

export class SatisfiesExpression extends Node {
  expression: Expression;
  type: TypeNode;

  constructor(expression: Expression, type: TypeNode) {
    super(SyntaxKind.SatisfiesExpression);
    this.expression = expression;
    this.type = type;
  }

  forEachChild(v: NodeVisitor): boolean {
    if (v.visitNode(this.expression)) return true;
    return v.visitNode(this.type);
  }

  deepClone(): Node {
    return this.copy();
  }

  copy(): SatisfiesExpression {
    const node = new SatisfiesExpression(this.expression.deepClone(), this.type.deepClone());
    node.flags = this.flags;
    node.pos = this.pos;
    node.end = this.end;
    return node;
  }
}

export class ConditionalExpression extends Node {
  condition: Expression;
  questionToken: Token;
  whenTrue: Expression;
  colonToken: Token;
  whenFalse: Expression;

  constructor(
    condition: Expression,
    questionToken: Token,
    whenTrue: Expression,
    colonToken: Token,
    whenFalse: Expression,
  ) {
    super(SyntaxKind.ConditionalExpression);
    this.condition = condition;
    this.questionToken = questionToken;
    this.whenTrue = whenTrue;
    this.colonToken = colonToken;
    this.whenFalse = whenFalse;
  }

  forEachChild(v: NodeVisitor): boolean {
    if (v.visitNode(this.condition)) return true;
    if (v.visitNode(this.questionToken)) return true;
    if (v.visitNode(this.whenTrue)) return true;
    if (v.visitNode(this.colonToken)) return true;
    return v.visitNode(this.whenFalse);
  }

  deepClone(): Node {
    return this.copy();
  }

  copy(): ConditionalExpression {
    const node = new ConditionalExpression(
      this.condition.deepClone(),
      this.questionToken.copy(),
      this.whenTrue.deepClone(),
      this.colonToken.copy(),
      this.whenFalse.deepClone(),
    );
    node.flags = this.flags;
    node.pos = this.pos;
    node.end = this.end;
    return node;
  }
}

export class PropertyAccessExpression extends Node {
  expression: Expression;
  questionDotToken: Token | undefined;
  name: MemberName;

  constructor(expression: Expression, questionDotToken: Token | undefined, name: MemberName, flags: NodeFlags) {
    super(SyntaxKind.PropertyAccessExpression);
    this.expression = expression;
    this.questionDotToken = questionDotToken;
    this.name = name;
    this.flags |= flags & NodeFlags.OptionalChain;
  }

  forEachChild(v: NodeVisitor): boolean {
    if (v.visitNode(this.expression)) return true;
    if (this.questionDotToken !== undefined && v.visitNode(this.questionDotToken)) return true;
    return v.visitNode(this.name);
  }

  deepClone(): Node {
    return this.copy();
  }

  copy(): PropertyAccessExpression {
    const node = new PropertyAccessExpression(
      this.expression.deepClone(),
      this.questionDotToken === undefined ? undefined : this.questionDotToken.copy(),
      this.name.deepClone(),
      this.flags,
    );
    node.flags = this.flags;
    node.pos = this.pos;
    node.end = this.end;
    return node;
  }
}

export class ElementAccessExpression extends Node {
  expression: Expression;
  questionDotToken: Token | undefined;
  argumentExpression: Expression;

  constructor(
    expression: Expression,
    questionDotToken: Token | undefined,
    argumentExpression: Expression,
    flags: NodeFlags,
  ) {
    super(SyntaxKind.ElementAccessExpression);
    this.expression = expression;
    this.questionDotToken = questionDotToken;
    this.argumentExpression = argumentExpression;
    this.flags |= flags & NodeFlags.OptionalChain;
  }

  forEachChild(v: NodeVisitor): boolean {
    if (v.visitNode(this.expression)) return true;
    if (this.questionDotToken !== undefined && v.visitNode(this.questionDotToken)) return true;
    return v.visitNode(this.argumentExpression);
  }

  deepClone(): Node {
    return this.copy();
  }

  copy(): ElementAccessExpression {
    const node = new ElementAccessExpression(
      this.expression.deepClone(),
      this.questionDotToken === undefined ? undefined : this.questionDotToken.copy(),
      this.argumentExpression.deepClone(),
      this.flags,
    );
    node.flags = this.flags;
    node.pos = this.pos;
    node.end = this.end;
    return node;
  }
}

export class CallExpression extends Node {
  expression: Expression;
  questionDotToken: Token | undefined;
  typeArguments: NodeList | undefined;
  arguments: NodeList;

  constructor(
    expression: Expression,
    questionDotToken: Token | undefined,
    typeArguments: NodeList | undefined,
    args: NodeList,
    flags: NodeFlags,
  ) {
    super(SyntaxKind.CallExpression);
    this.expression = expression;
    this.questionDotToken = questionDotToken;
    this.typeArguments = typeArguments;
    this.arguments = args;
    this.flags |= flags & NodeFlags.OptionalChain;
  }

  forEachChild(v: NodeVisitor): boolean {
    if (v.visitNode(this.expression)) return true;
    if (this.questionDotToken !== undefined && v.visitNode(this.questionDotToken)) return true;
    if (this.typeArguments !== undefined && v.visitList(this.typeArguments)) return true;
    return v.visitList(this.arguments);
  }

  deepClone(): Node {
    return this.copy();
  }

  copy(): CallExpression {
    const node = new CallExpression(
      this.expression.deepClone(),
      this.questionDotToken === undefined ? undefined : this.questionDotToken.copy(),
      this.typeArguments === undefined ? undefined : cloneList(this.typeArguments),
      cloneList(this.arguments),
      this.flags,
    );
    node.flags = this.flags;
    node.pos = this.pos;
    node.end = this.end;
    return node;
  }
}

export class NewExpression extends Node {
  expression: Expression;
  typeArguments: NodeList | undefined;
  arguments: NodeList | undefined;

  constructor(expression: Expression, typeArguments: NodeList | undefined, args: NodeList | undefined) {
    super(SyntaxKind.NewExpression);
    this.expression = expression;
    this.typeArguments = typeArguments;
    this.arguments = args;
  }

  forEachChild(v: NodeVisitor): boolean {
    if (v.visitNode(this.expression)) return true;
    if (this.typeArguments !== undefined && v.visitList(this.typeArguments)) return true;
    return this.arguments !== undefined && v.visitList(this.arguments);
  }

  deepClone(): Node {
    return this.copy();
  }

  copy(): NewExpression {
    const node = new NewExpression(
      this.expression.deepClone(),
      this.typeArguments === undefined ? undefined : cloneList(this.typeArguments),
      this.arguments === undefined ? undefined : cloneList(this.arguments),
    );
    node.flags = this.flags;
    node.pos = this.pos;
    node.end = this.end;
    return node;
  }
}

export class MetaProperty extends Node {
  keywordToken: SyntaxKind;
  name: Identifier;

  constructor(keywordToken: SyntaxKind, name: Identifier) {
    super(SyntaxKind.MetaProperty);
    this.keywordToken = keywordToken;
    this.name = name;
  }

  forEachChild(v: NodeVisitor): boolean {
    return v.visitNode(this.name);
  }

  deepClone(): Node {
    return this.copy();
  }

  copy(): MetaProperty {
    const node = new MetaProperty(this.keywordToken, this.name.copy());
    node.flags = this.flags;
    node.pos = this.pos;
    node.end = this.end;
    return node;
  }
}

export class NonNullExpression extends Node {
  expression: Expression;

  constructor(expression: Expression, flags: NodeFlags) {
    super(SyntaxKind.NonNullExpression);
    this.expression = expression;
    this.flags |= flags & NodeFlags.OptionalChain;
  }

  forEachChild(v: NodeVisitor): boolean {
    return v.visitNode(this.expression);
  }

  deepClone(): Node {
    return this.copy();
  }

  copy(): NonNullExpression {
    const node = new NonNullExpression(this.expression.deepClone(), this.flags);
    node.flags = this.flags;
    node.pos = this.pos;
    node.end = this.end;
    return node;
  }
}

export class SpreadElement extends Node {
  expression: Expression;

  constructor(expression: Expression) {
    super(SyntaxKind.SpreadElement);
    this.expression = expression;
  }

  forEachChild(v: NodeVisitor): boolean {
    return v.visitNode(this.expression);
  }

  deepClone(): Node {
    return this.copy();
  }

  copy(): SpreadElement {
    const node = new SpreadElement(this.expression.deepClone());
    node.flags = this.flags;
    node.pos = this.pos;
    node.end = this.end;
    return node;
  }
}

export class TemplateExpression extends Node {
  head: TemplateHead;
  templateSpans: NodeList;

  constructor(head: TemplateHead, templateSpans: NodeList) {
    super(SyntaxKind.TemplateExpression);
    this.head = head;
    this.templateSpans = templateSpans;
  }

  forEachChild(v: NodeVisitor): boolean {
    if (v.visitNode(this.head)) return true;
    return v.visitList(this.templateSpans);
  }

  deepClone(): Node {
    return this.copy();
  }

  copy(): TemplateExpression {
    const node = new TemplateExpression(this.head.copy(), cloneList(this.templateSpans));
    node.flags = this.flags;
    node.pos = this.pos;
    node.end = this.end;
    return node;
  }
}

export class TemplateSpan extends Node {
  expression: Expression;
  literal: TemplateMiddleOrTail;

  constructor(expression: Expression, literal: TemplateMiddleOrTail) {
    super(SyntaxKind.TemplateSpan);
    this.expression = expression;
    this.literal = literal;
  }

  forEachChild(v: NodeVisitor): boolean {
    if (v.visitNode(this.expression)) return true;
    return v.visitNode(this.literal);
  }

  deepClone(): Node {
    return this.copy();
  }

  copy(): TemplateSpan {
    const node = new TemplateSpan(this.expression.deepClone(), this.literal.deepClone());
    node.flags = this.flags;
    node.pos = this.pos;
    node.end = this.end;
    return node;
  }
}

export class TaggedTemplateExpression extends Node {
  tag: Expression;
  questionDotToken: Token | undefined;
  typeArguments: NodeList | undefined;
  template: TemplateLiteral;

  constructor(
    tag: Expression,
    questionDotToken: Token | undefined,
    typeArguments: NodeList | undefined,
    template: TemplateLiteral,
    flags: NodeFlags,
  ) {
    super(SyntaxKind.TaggedTemplateExpression);
    this.tag = tag;
    this.questionDotToken = questionDotToken;
    this.typeArguments = typeArguments;
    this.template = template;
    this.flags |= flags & NodeFlags.OptionalChain;
  }

  forEachChild(v: NodeVisitor): boolean {
    if (v.visitNode(this.tag)) return true;
    if (this.questionDotToken !== undefined && v.visitNode(this.questionDotToken)) return true;
    if (this.typeArguments !== undefined && v.visitList(this.typeArguments)) return true;
    return v.visitNode(this.template);
  }

  deepClone(): Node {
    return this.copy();
  }

  copy(): TaggedTemplateExpression {
    const node = new TaggedTemplateExpression(
      this.tag.deepClone(),
      this.questionDotToken === undefined ? undefined : this.questionDotToken.copy(),
      this.typeArguments === undefined ? undefined : cloneList(this.typeArguments),
      this.template.deepClone(),
      this.flags,
    );
    node.flags = this.flags;
    node.pos = this.pos;
    node.end = this.end;
    return node;
  }
}

export class ParenthesizedExpression extends Node {
  expression: Expression;

  constructor(expression: Expression) {
    super(SyntaxKind.ParenthesizedExpression);
    this.expression = expression;
  }

  forEachChild(v: NodeVisitor): boolean {
    return v.visitNode(this.expression);
  }

  deepClone(): Node {
    return this.copy();
  }

  copy(): ParenthesizedExpression {
    const node = new ParenthesizedExpression(this.expression.deepClone());
    node.flags = this.flags;
    node.pos = this.pos;
    node.end = this.end;
    return node;
  }
}

export class ArrayLiteralExpression extends Node {
  elements: NodeList;
  multiLine: boolean;

  constructor(elements: NodeList, multiLine: boolean) {
    super(SyntaxKind.ArrayLiteralExpression);
    this.elements = elements;
    this.multiLine = multiLine;
  }

  forEachChild(v: NodeVisitor): boolean {
    return v.visitList(this.elements);
  }

  deepClone(): Node {
    return this.copy();
  }

  copy(): ArrayLiteralExpression {
    const node = new ArrayLiteralExpression(cloneList(this.elements), this.multiLine);
    node.flags = this.flags;
    node.pos = this.pos;
    node.end = this.end;
    return node;
  }
}

export class ObjectLiteralExpression extends Node {
  properties: NodeList;
  multiLine: boolean;

  constructor(properties: NodeList, multiLine: boolean) {
    super(SyntaxKind.ObjectLiteralExpression);
    this.properties = properties;
    this.multiLine = multiLine;
  }

  forEachChild(v: NodeVisitor): boolean {
    return v.visitList(this.properties);
  }

  deepClone(): Node {
    return this.copy();
  }

  copy(): ObjectLiteralExpression {
    const node = new ObjectLiteralExpression(cloneList(this.properties), this.multiLine);
    node.flags = this.flags;
    node.pos = this.pos;
    node.end = this.end;
    return node;
  }
}

export class SpreadAssignment extends Node {
  expression: Expression;

  constructor(expression: Expression) {
    super(SyntaxKind.SpreadAssignment);
    this.expression = expression;
  }

  forEachChild(v: NodeVisitor): boolean {
    return v.visitNode(this.expression);
  }

  deepClone(): Node {
    return this.copy();
  }

  copy(): SpreadAssignment {
    const node = new SpreadAssignment(this.expression.deepClone());
    node.flags = this.flags;
    node.pos = this.pos;
    node.end = this.end;
    return node;
  }
}

export class PropertyAssignment extends Node {
  modifiers: ModifierList | undefined;
  name: PropertyName;
  postfixToken: Token | undefined;
  type: TypeNode | undefined;
  initializer: Expression;

  constructor(
    modifiers: ModifierList | undefined,
    name: PropertyName,
    postfixToken: Token | undefined,
    type: TypeNode | undefined,
    initializer: Expression,
  ) {
    super(SyntaxKind.PropertyAssignment);
    this.modifiers = modifiers;
    this.name = name;
    this.postfixToken = postfixToken;
    this.type = type;
    this.initializer = initializer;
  }

  forEachChild(v: NodeVisitor): boolean {
    if (this.modifiers !== undefined && v.visitModifiers(this.modifiers)) return true;
    if (v.visitNode(this.name)) return true;
    if (this.postfixToken !== undefined && v.visitNode(this.postfixToken)) return true;
    if (this.type !== undefined && v.visitNode(this.type)) return true;
    return v.visitNode(this.initializer);
  }

  deepClone(): Node {
    return this.copy();
  }

  copy(): PropertyAssignment {
    const node = new PropertyAssignment(
      this.modifiers === undefined ? undefined : cloneModifiers(this.modifiers),
      this.name.deepClone(),
      this.postfixToken === undefined ? undefined : this.postfixToken.copy(),
      this.type === undefined ? undefined : this.type.deepClone(),
      this.initializer.deepClone(),
    );
    node.flags = this.flags;
    node.pos = this.pos;
    node.end = this.end;
    return node;
  }
}

export class ShorthandPropertyAssignment extends Node {
  modifiers: ModifierList | undefined;
  name: PropertyName;
  postfixToken: Token | undefined;
  type: TypeNode | undefined;
  equalsToken: Token | undefined;
  objectAssignmentInitializer: Expression | undefined;

  constructor(
    modifiers: ModifierList | undefined,
    name: PropertyName,
    postfixToken: Token | undefined,
    type: TypeNode | undefined,
    equalsToken: Token | undefined,
    objectAssignmentInitializer: Expression | undefined,
  ) {
    super(SyntaxKind.ShorthandPropertyAssignment);
    this.modifiers = modifiers;
    this.name = name;
    this.postfixToken = postfixToken;
    this.type = type;
    this.equalsToken = equalsToken;
    this.objectAssignmentInitializer = objectAssignmentInitializer;
  }

  forEachChild(v: NodeVisitor): boolean {
    if (this.modifiers !== undefined && v.visitModifiers(this.modifiers)) return true;
    if (v.visitNode(this.name)) return true;
    if (this.postfixToken !== undefined && v.visitNode(this.postfixToken)) return true;
    if (this.type !== undefined && v.visitNode(this.type)) return true;
    if (this.equalsToken !== undefined && v.visitNode(this.equalsToken)) return true;
    return this.objectAssignmentInitializer !== undefined && v.visitNode(this.objectAssignmentInitializer);
  }

  deepClone(): Node {
    return this.copy();
  }

  copy(): ShorthandPropertyAssignment {
    const node = new ShorthandPropertyAssignment(
      this.modifiers === undefined ? undefined : cloneModifiers(this.modifiers),
      this.name.deepClone(),
      this.postfixToken === undefined ? undefined : this.postfixToken.copy(),
      this.type === undefined ? undefined : this.type.deepClone(),
      this.equalsToken === undefined ? undefined : this.equalsToken.copy(),
      this.objectAssignmentInitializer === undefined ? undefined : this.objectAssignmentInitializer.deepClone(),
    );
    node.flags = this.flags;
    node.pos = this.pos;
    node.end = this.end;
    return node;
  }
}

export class DeleteExpression extends Node {
  expression: Expression;

  constructor(expression: Expression) {
    super(SyntaxKind.DeleteExpression);
    this.expression = expression;
  }

  forEachChild(v: NodeVisitor): boolean {
    return v.visitNode(this.expression);
  }

  deepClone(): Node {
    return this.copy();
  }

  copy(): DeleteExpression {
    const node = new DeleteExpression(this.expression.deepClone());
    node.flags = this.flags;
    node.pos = this.pos;
    node.end = this.end;
    return node;
  }
}

export class TypeOfExpression extends Node {
  expression: Expression;

  constructor(expression: Expression) {
    super(SyntaxKind.TypeOfExpression);
    this.expression = expression;
  }

  forEachChild(v: NodeVisitor): boolean {
    return v.visitNode(this.expression);
  }

  deepClone(): Node {
    return this.copy();
  }

  copy(): TypeOfExpression {
    const node = new TypeOfExpression(this.expression.deepClone());
    node.flags = this.flags;
    node.pos = this.pos;
    node.end = this.end;
    return node;
  }
}

export class VoidExpression extends Node {
  expression: Expression;

  constructor(expression: Expression) {
    super(SyntaxKind.VoidExpression);
    this.expression = expression;
  }

  forEachChild(v: NodeVisitor): boolean {
    return v.visitNode(this.expression);
  }

  deepClone(): Node {
    return this.copy();
  }

  copy(): VoidExpression {
    const node = new VoidExpression(this.expression.deepClone());
    node.flags = this.flags;
    node.pos = this.pos;
    node.end = this.end;
    return node;
  }
}

export class AwaitExpression extends Node {
  expression: Expression;

  constructor(expression: Expression) {
    super(SyntaxKind.AwaitExpression);
    this.expression = expression;
  }

  forEachChild(v: NodeVisitor): boolean {
    return v.visitNode(this.expression);
  }

  deepClone(): Node {
    return this.copy();
  }

  copy(): AwaitExpression {
    const node = new AwaitExpression(this.expression.deepClone());
    node.flags = this.flags;
    node.pos = this.pos;
    node.end = this.end;
    return node;
  }
}

export class TypeAssertion extends Node {
  type: TypeNode;
  expression: Expression;

  constructor(type: TypeNode, expression: Expression) {
    super(SyntaxKind.TypeAssertionExpression);
    this.type = type;
    this.expression = expression;
  }

  forEachChild(v: NodeVisitor): boolean {
    if (v.visitNode(this.type)) return true;
    return v.visitNode(this.expression);
  }

  deepClone(): Node {
    return this.copy();
  }

  copy(): TypeAssertion {
    const node = new TypeAssertion(this.type.deepClone(), this.expression.deepClone());
    node.flags = this.flags;
    node.pos = this.pos;
    node.end = this.end;
    return node;
  }
}

export class KeywordTypeNode extends Node {
  constructor(kind: SyntaxKind) {
    super(kind);
  }

  forEachChild(_v: NodeVisitor): boolean {
    return false;
  }

  deepClone(): Node {
    return this.copy();
  }

  copy(): KeywordTypeNode {
    const node = new KeywordTypeNode(this.kind);
    node.flags = this.flags;
    node.pos = this.pos;
    node.end = this.end;
    return node;
  }
}

export class UnionTypeNode extends Node {
  types: NodeList;

  constructor(types: NodeList) {
    super(SyntaxKind.UnionType);
    this.types = types;
  }

  forEachChild(v: NodeVisitor): boolean {
    return v.visitList(this.types);
  }

  deepClone(): Node {
    return this.copy();
  }

  copy(): UnionTypeNode {
    const node = new UnionTypeNode(cloneList(this.types));
    node.flags = this.flags;
    node.pos = this.pos;
    node.end = this.end;
    return node;
  }
}

export class IntersectionTypeNode extends Node {
  types: NodeList;

  constructor(types: NodeList) {
    super(SyntaxKind.IntersectionType);
    this.types = types;
  }

  forEachChild(v: NodeVisitor): boolean {
    return v.visitList(this.types);
  }

  deepClone(): Node {
    return this.copy();
  }

  copy(): IntersectionTypeNode {
    const node = new IntersectionTypeNode(cloneList(this.types));
    node.flags = this.flags;
    node.pos = this.pos;
    node.end = this.end;
    return node;
  }
}

export class ConditionalTypeNode extends Node {
  checkType: TypeNode;
  extendsType: TypeNode;
  trueType: TypeNode;
  falseType: TypeNode;

  constructor(checkType: TypeNode, extendsType: TypeNode, trueType: TypeNode, falseType: TypeNode) {
    super(SyntaxKind.ConditionalType);
    this.checkType = checkType;
    this.extendsType = extendsType;
    this.trueType = trueType;
    this.falseType = falseType;
  }

  forEachChild(v: NodeVisitor): boolean {
    if (v.visitNode(this.checkType)) return true;
    if (v.visitNode(this.extendsType)) return true;
    if (v.visitNode(this.trueType)) return true;
    return v.visitNode(this.falseType);
  }

  deepClone(): Node {
    return this.copy();
  }

  copy(): ConditionalTypeNode {
    const node = new ConditionalTypeNode(
      this.checkType.deepClone(),
      this.extendsType.deepClone(),
      this.trueType.deepClone(),
      this.falseType.deepClone(),
    );
    node.flags = this.flags;
    node.pos = this.pos;
    node.end = this.end;
    return node;
  }
}

export class TypeOperatorNode extends Node {
  operator: SyntaxKind;
  type: TypeNode;

  constructor(operator: SyntaxKind, type: TypeNode) {
    super(SyntaxKind.TypeOperator);
    this.operator = operator;
    this.type = type;
  }

  forEachChild(v: NodeVisitor): boolean {
    return v.visitNode(this.type);
  }

  deepClone(): Node {
    return this.copy();
  }

  copy(): TypeOperatorNode {
    const node = new TypeOperatorNode(this.operator, this.type.deepClone());
    node.flags = this.flags;
    node.pos = this.pos;
    node.end = this.end;
    return node;
  }
}

export class InferTypeNode extends Node {
  typeParameter: TypeParameterDeclaration;

  constructor(typeParameter: TypeParameterDeclaration) {
    super(SyntaxKind.InferType);
    this.typeParameter = typeParameter;
  }

  forEachChild(v: NodeVisitor): boolean {
    return v.visitNode(this.typeParameter);
  }

  deepClone(): Node {
    return this.copy();
  }

  copy(): InferTypeNode {
    const node = new InferTypeNode(this.typeParameter.copy());
    node.flags = this.flags;
    node.pos = this.pos;
    node.end = this.end;
    return node;
  }
}

export class ArrayTypeNode extends Node {
  elementType: TypeNode;

  constructor(elementType: TypeNode) {
    super(SyntaxKind.ArrayType);
    this.elementType = elementType;
  }

  forEachChild(v: NodeVisitor): boolean {
    return v.visitNode(this.elementType);
  }

  deepClone(): Node {
    return this.copy();
  }

  copy(): ArrayTypeNode {
    const node = new ArrayTypeNode(this.elementType.deepClone());
    node.flags = this.flags;
    node.pos = this.pos;
    node.end = this.end;
    return node;
  }
}

export class IndexedAccessTypeNode extends Node {
  objectType: TypeNode;
  indexType: TypeNode;

  constructor(objectType: TypeNode, indexType: TypeNode) {
    super(SyntaxKind.IndexedAccessType);
    this.objectType = objectType;
    this.indexType = indexType;
  }

  forEachChild(v: NodeVisitor): boolean {
    if (v.visitNode(this.objectType)) return true;
    return v.visitNode(this.indexType);
  }

  deepClone(): Node {
    return this.copy();
  }

  copy(): IndexedAccessTypeNode {
    const node = new IndexedAccessTypeNode(this.objectType.deepClone(), this.indexType.deepClone());
    node.flags = this.flags;
    node.pos = this.pos;
    node.end = this.end;
    return node;
  }
}

export class TypeReferenceNode extends Node {
  typeName: EntityName;
  typeArguments: NodeList | undefined;

  constructor(typeName: EntityName, typeArguments: NodeList | undefined) {
    super(SyntaxKind.TypeReference);
    this.typeName = typeName;
    this.typeArguments = typeArguments;
  }

  forEachChild(v: NodeVisitor): boolean {
    if (v.visitNode(this.typeName)) return true;
    return this.typeArguments !== undefined && v.visitList(this.typeArguments);
  }

  deepClone(): Node {
    return this.copy();
  }

  copy(): TypeReferenceNode {
    const node = new TypeReferenceNode(
      this.typeName.deepClone(),
      this.typeArguments === undefined ? undefined : cloneList(this.typeArguments),
    );
    node.flags = this.flags;
    node.pos = this.pos;
    node.end = this.end;
    return node;
  }
}

export class ExpressionWithTypeArguments extends Node {
  expression: Expression;
  typeArguments: NodeList | undefined;

  constructor(expression: Expression, typeArguments: NodeList | undefined) {
    super(SyntaxKind.ExpressionWithTypeArguments);
    this.expression = expression;
    this.typeArguments = typeArguments;
  }

  forEachChild(v: NodeVisitor): boolean {
    if (v.visitNode(this.expression)) return true;
    return this.typeArguments !== undefined && v.visitList(this.typeArguments);
  }

  deepClone(): Node {
    return this.copy();
  }

  copy(): ExpressionWithTypeArguments {
    const node = new ExpressionWithTypeArguments(
      this.expression.deepClone(),
      this.typeArguments === undefined ? undefined : cloneList(this.typeArguments),
    );
    node.flags = this.flags;
    node.pos = this.pos;
    node.end = this.end;
    return node;
  }
}

export class LiteralTypeNode extends Node {
  literal: Node;

  constructor(literal: Node) {
    super(SyntaxKind.LiteralType);
    this.literal = literal;
  }

  forEachChild(v: NodeVisitor): boolean {
    return v.visitNode(this.literal);
  }

  deepClone(): Node {
    return this.copy();
  }

  copy(): LiteralTypeNode {
    const node = new LiteralTypeNode(this.literal.deepClone());
    node.flags = this.flags;
    node.pos = this.pos;
    node.end = this.end;
    return node;
  }
}

export class ThisTypeNode extends Node {
  constructor() {
    super(SyntaxKind.ThisType);
  }

  forEachChild(_v: NodeVisitor): boolean {
    return false;
  }

  deepClone(): Node {
    return this.copy();
  }

  copy(): ThisTypeNode {
    const node = new ThisTypeNode();
    node.flags = this.flags;
    node.pos = this.pos;
    node.end = this.end;
    return node;
  }
}

export class TypePredicateNode extends Node {
  assertsModifier: Token | undefined;
  parameterName: TypePredicateParameterName;
  type: TypeNode | undefined;

  constructor(
    assertsModifier: Token | undefined,
    parameterName: TypePredicateParameterName,
    type: TypeNode | undefined,
  ) {
    super(SyntaxKind.TypePredicate);
    this.assertsModifier = assertsModifier;
    this.parameterName = parameterName;
    this.type = type;
  }

  forEachChild(v: NodeVisitor): boolean {
    if (this.assertsModifier !== undefined && v.visitNode(this.assertsModifier)) return true;
    if (v.visitNode(this.parameterName)) return true;
    return this.type !== undefined && v.visitNode(this.type);
  }

  deepClone(): Node {
    return this.copy();
  }

  copy(): TypePredicateNode {
    const node = new TypePredicateNode(
      this.assertsModifier === undefined ? undefined : this.assertsModifier.copy(),
      this.parameterName.deepClone(),
      this.type === undefined ? undefined : this.type.deepClone(),
    );
    node.flags = this.flags;
    node.pos = this.pos;
    node.end = this.end;
    return node;
  }
}

export class ImportAttribute extends Node {
  name: ImportAttributeName | undefined;
  value: Expression;

  constructor(name: ImportAttributeName | undefined, value: Expression) {
    super(SyntaxKind.ImportAttribute);
    this.name = name;
    this.value = value;
  }

  forEachChild(v: NodeVisitor): boolean {
    if (this.name !== undefined && v.visitNode(this.name)) return true;
    return v.visitNode(this.value);
  }

  deepClone(): Node {
    return this.copy();
  }

  copy(): ImportAttribute {
    const node = new ImportAttribute(
      this.name === undefined ? undefined : this.name.deepClone(),
      this.value.deepClone(),
    );
    node.flags = this.flags;
    node.pos = this.pos;
    node.end = this.end;
    return node;
  }
}

export class ImportAttributes extends Node {
  token: SyntaxKind;
  attributes: NodeList;
  multiLine: boolean;

  constructor(token: SyntaxKind, attributes: NodeList, multiLine: boolean) {
    super(SyntaxKind.ImportAttributes);
    this.token = token;
    this.attributes = attributes;
    this.multiLine = multiLine;
  }

  forEachChild(v: NodeVisitor): boolean {
    return v.visitList(this.attributes);
  }

  deepClone(): Node {
    return this.copy();
  }

  copy(): ImportAttributes {
    const node = new ImportAttributes(this.token, cloneList(this.attributes), this.multiLine);
    node.flags = this.flags;
    node.pos = this.pos;
    node.end = this.end;
    return node;
  }
}

export class TypeQueryNode extends Node {
  exprName: EntityName;
  typeArguments: NodeList | undefined;

  constructor(exprName: EntityName, typeArguments: NodeList | undefined) {
    super(SyntaxKind.TypeQuery);
    this.exprName = exprName;
    this.typeArguments = typeArguments;
  }

  forEachChild(v: NodeVisitor): boolean {
    if (v.visitNode(this.exprName)) return true;
    return this.typeArguments !== undefined && v.visitList(this.typeArguments);
  }

  deepClone(): Node {
    return this.copy();
  }

  copy(): TypeQueryNode {
    const node = new TypeQueryNode(
      this.exprName.deepClone(),
      this.typeArguments === undefined ? undefined : cloneList(this.typeArguments),
    );
    node.flags = this.flags;
    node.pos = this.pos;
    node.end = this.end;
    return node;
  }
}

export class MappedTypeNode extends Node {
  readonlyToken: Token | undefined;
  typeParameter: TypeParameterDeclaration;
  nameType: TypeNode | undefined;
  questionToken: Token | undefined;
  type: TypeNode | undefined;
  members: NodeList | undefined;

  constructor(
    readonlyToken: Token | undefined,
    typeParameter: TypeParameterDeclaration,
    nameType: TypeNode | undefined,
    questionToken: Token | undefined,
    type: TypeNode | undefined,
    members: NodeList | undefined,
  ) {
    super(SyntaxKind.MappedType);
    this.readonlyToken = readonlyToken;
    this.typeParameter = typeParameter;
    this.nameType = nameType;
    this.questionToken = questionToken;
    this.type = type;
    this.members = members;
  }

  forEachChild(v: NodeVisitor): boolean {
    if (this.readonlyToken !== undefined && v.visitNode(this.readonlyToken)) return true;
    if (v.visitNode(this.typeParameter)) return true;
    if (this.nameType !== undefined && v.visitNode(this.nameType)) return true;
    if (this.questionToken !== undefined && v.visitNode(this.questionToken)) return true;
    if (this.type !== undefined && v.visitNode(this.type)) return true;
    return this.members !== undefined && v.visitList(this.members);
  }

  deepClone(): Node {
    return this.copy();
  }

  copy(): MappedTypeNode {
    const node = new MappedTypeNode(
      this.readonlyToken === undefined ? undefined : this.readonlyToken.copy(),
      this.typeParameter.copy(),
      this.nameType === undefined ? undefined : this.nameType.deepClone(),
      this.questionToken === undefined ? undefined : this.questionToken.copy(),
      this.type === undefined ? undefined : this.type.deepClone(),
      this.members === undefined ? undefined : cloneList(this.members),
    );
    node.flags = this.flags;
    node.pos = this.pos;
    node.end = this.end;
    return node;
  }
}

export class TypeLiteralNode extends Node {
  members: NodeList;

  constructor(members: NodeList) {
    super(SyntaxKind.TypeLiteral);
    this.members = members;
  }

  forEachChild(v: NodeVisitor): boolean {
    return v.visitList(this.members);
  }

  deepClone(): Node {
    return this.copy();
  }

  copy(): TypeLiteralNode {
    const node = new TypeLiteralNode(cloneList(this.members));
    node.flags = this.flags;
    node.pos = this.pos;
    node.end = this.end;
    return node;
  }
}

export class TupleTypeNode extends Node {
  elements: NodeList;

  constructor(elements: NodeList) {
    super(SyntaxKind.TupleType);
    this.elements = elements;
  }

  forEachChild(v: NodeVisitor): boolean {
    return v.visitList(this.elements);
  }

  deepClone(): Node {
    return this.copy();
  }

  copy(): TupleTypeNode {
    const node = new TupleTypeNode(cloneList(this.elements));
    node.flags = this.flags;
    node.pos = this.pos;
    node.end = this.end;
    return node;
  }
}

export class NamedTupleMember extends Node {
  dotDotDotToken: Token | undefined;
  name: Identifier;
  questionToken: Token | undefined;
  type: TypeNode;

  constructor(dotDotDotToken: Token | undefined, name: Identifier, questionToken: Token | undefined, type: TypeNode) {
    super(SyntaxKind.NamedTupleMember);
    this.dotDotDotToken = dotDotDotToken;
    this.name = name;
    this.questionToken = questionToken;
    this.type = type;
  }

  forEachChild(v: NodeVisitor): boolean {
    if (this.dotDotDotToken !== undefined && v.visitNode(this.dotDotDotToken)) return true;
    if (v.visitNode(this.name)) return true;
    if (this.questionToken !== undefined && v.visitNode(this.questionToken)) return true;
    return v.visitNode(this.type);
  }

  deepClone(): Node {
    return this.copy();
  }

  copy(): NamedTupleMember {
    const node = new NamedTupleMember(
      this.dotDotDotToken === undefined ? undefined : this.dotDotDotToken.copy(),
      this.name.copy(),
      this.questionToken === undefined ? undefined : this.questionToken.copy(),
      this.type.deepClone(),
    );
    node.flags = this.flags;
    node.pos = this.pos;
    node.end = this.end;
    return node;
  }
}

export class OptionalTypeNode extends Node {
  type: TypeNode;

  constructor(type: TypeNode) {
    super(SyntaxKind.OptionalType);
    this.type = type;
  }

  forEachChild(v: NodeVisitor): boolean {
    return v.visitNode(this.type);
  }

  deepClone(): Node {
    return this.copy();
  }

  copy(): OptionalTypeNode {
    const node = new OptionalTypeNode(this.type.deepClone());
    node.flags = this.flags;
    node.pos = this.pos;
    node.end = this.end;
    return node;
  }
}

export class RestTypeNode extends Node {
  type: TypeNode;

  constructor(type: TypeNode) {
    super(SyntaxKind.RestType);
    this.type = type;
  }

  forEachChild(v: NodeVisitor): boolean {
    return v.visitNode(this.type);
  }

  deepClone(): Node {
    return this.copy();
  }

  copy(): RestTypeNode {
    const node = new RestTypeNode(this.type.deepClone());
    node.flags = this.flags;
    node.pos = this.pos;
    node.end = this.end;
    return node;
  }
}

export class ParenthesizedTypeNode extends Node {
  type: TypeNode;

  constructor(type: TypeNode) {
    super(SyntaxKind.ParenthesizedType);
    this.type = type;
  }

  forEachChild(v: NodeVisitor): boolean {
    return v.visitNode(this.type);
  }

  deepClone(): Node {
    return this.copy();
  }

  copy(): ParenthesizedTypeNode {
    const node = new ParenthesizedTypeNode(this.type.deepClone());
    node.flags = this.flags;
    node.pos = this.pos;
    node.end = this.end;
    return node;
  }
}

export class FunctionTypeNode extends Node {
  typeParameters: NodeList | undefined;
  parameters: NodeList;
  type: TypeNode | undefined;

  constructor(typeParameters: NodeList | undefined, parameters: NodeList, type: TypeNode | undefined) {
    super(SyntaxKind.FunctionType);
    this.typeParameters = typeParameters;
    this.parameters = parameters;
    this.type = type;
  }

  forEachChild(v: NodeVisitor): boolean {
    if (this.typeParameters !== undefined && v.visitList(this.typeParameters)) return true;
    if (v.visitList(this.parameters)) return true;
    return this.type !== undefined && v.visitNode(this.type);
  }

  deepClone(): Node {
    return this.copy();
  }

  copy(): FunctionTypeNode {
    const node = new FunctionTypeNode(
      this.typeParameters === undefined ? undefined : cloneList(this.typeParameters),
      cloneList(this.parameters),
      this.type === undefined ? undefined : this.type.deepClone(),
    );
    node.flags = this.flags;
    node.pos = this.pos;
    node.end = this.end;
    return node;
  }
}

export class ConstructorTypeNode extends Node {
  modifiers: ModifierList | undefined;
  typeParameters: NodeList | undefined;
  parameters: NodeList;
  type: TypeNode | undefined;

  constructor(
    modifiers: ModifierList | undefined,
    typeParameters: NodeList | undefined,
    parameters: NodeList,
    type: TypeNode | undefined,
  ) {
    super(SyntaxKind.ConstructorType);
    this.modifiers = modifiers;
    this.typeParameters = typeParameters;
    this.parameters = parameters;
    this.type = type;
  }

  forEachChild(v: NodeVisitor): boolean {
    if (this.modifiers !== undefined && v.visitModifiers(this.modifiers)) return true;
    if (this.typeParameters !== undefined && v.visitList(this.typeParameters)) return true;
    if (v.visitList(this.parameters)) return true;
    return this.type !== undefined && v.visitNode(this.type);
  }

  deepClone(): Node {
    return this.copy();
  }

  copy(): ConstructorTypeNode {
    const node = new ConstructorTypeNode(
      this.modifiers === undefined ? undefined : cloneModifiers(this.modifiers),
      this.typeParameters === undefined ? undefined : cloneList(this.typeParameters),
      cloneList(this.parameters),
      this.type === undefined ? undefined : this.type.deepClone(),
    );
    node.flags = this.flags;
    node.pos = this.pos;
    node.end = this.end;
    return node;
  }
}

export class TemplateHead extends Node {
  text: string;
  rawText: string;
  templateFlags: TokenFlags;

  constructor(text: string, rawText: string, templateFlags: TokenFlags) {
    super(SyntaxKind.TemplateHead);
    this.text = text;
    this.rawText = rawText;
    this.templateFlags = templateFlags & TokenFlags.TemplateLiteralLikeFlags;
  }

  forEachChild(_v: NodeVisitor): boolean {
    return false;
  }

  deepClone(): Node {
    return this.copy();
  }

  copy(): TemplateHead {
    const node = new TemplateHead(this.text, this.rawText, this.templateFlags);
    node.flags = this.flags;
    node.pos = this.pos;
    node.end = this.end;
    return node;
  }
}

export class TemplateMiddle extends Node {
  text: string;
  rawText: string;
  templateFlags: TokenFlags;

  constructor(text: string, rawText: string, templateFlags: TokenFlags) {
    super(SyntaxKind.TemplateMiddle);
    this.text = text;
    this.rawText = rawText;
    this.templateFlags = templateFlags & TokenFlags.TemplateLiteralLikeFlags;
  }

  forEachChild(_v: NodeVisitor): boolean {
    return false;
  }

  deepClone(): Node {
    return this.copy();
  }

  copy(): TemplateMiddle {
    const node = new TemplateMiddle(this.text, this.rawText, this.templateFlags);
    node.flags = this.flags;
    node.pos = this.pos;
    node.end = this.end;
    return node;
  }
}

export class TemplateTail extends Node {
  text: string;
  rawText: string;
  templateFlags: TokenFlags;

  constructor(text: string, rawText: string, templateFlags: TokenFlags) {
    super(SyntaxKind.TemplateTail);
    this.text = text;
    this.rawText = rawText;
    this.templateFlags = templateFlags & TokenFlags.TemplateLiteralLikeFlags;
  }

  forEachChild(_v: NodeVisitor): boolean {
    return false;
  }

  deepClone(): Node {
    return this.copy();
  }

  copy(): TemplateTail {
    const node = new TemplateTail(this.text, this.rawText, this.templateFlags);
    node.flags = this.flags;
    node.pos = this.pos;
    node.end = this.end;
    return node;
  }
}

export class TemplateLiteralTypeNode extends Node {
  head: TemplateHead;
  templateSpans: NodeList;

  constructor(head: TemplateHead, templateSpans: NodeList) {
    super(SyntaxKind.TemplateLiteralType);
    this.head = head;
    this.templateSpans = templateSpans;
  }

  forEachChild(v: NodeVisitor): boolean {
    if (v.visitNode(this.head)) return true;
    return v.visitList(this.templateSpans);
  }

  deepClone(): Node {
    return this.copy();
  }

  copy(): TemplateLiteralTypeNode {
    const node = new TemplateLiteralTypeNode(this.head.copy(), cloneList(this.templateSpans));
    node.flags = this.flags;
    node.pos = this.pos;
    node.end = this.end;
    return node;
  }
}

export class TemplateLiteralTypeSpan extends Node {
  type: TypeNode;
  literal: TemplateMiddleOrTail;

  constructor(type: TypeNode, literal: TemplateMiddleOrTail) {
    super(SyntaxKind.TemplateLiteralTypeSpan);
    this.type = type;
    this.literal = literal;
  }

  forEachChild(v: NodeVisitor): boolean {
    if (v.visitNode(this.type)) return true;
    return v.visitNode(this.literal);
  }

  deepClone(): Node {
    return this.copy();
  }

  copy(): TemplateLiteralTypeSpan {
    const node = new TemplateLiteralTypeSpan(this.type.deepClone(), this.literal.deepClone());
    node.flags = this.flags;
    node.pos = this.pos;
    node.end = this.end;
    return node;
  }
}

export class PartiallyEmittedExpression extends Node {
  expression: Expression;

  constructor(expression: Expression) {
    super(SyntaxKind.PartiallyEmittedExpression);
    this.expression = expression;
  }

  forEachChild(v: NodeVisitor): boolean {
    return v.visitNode(this.expression);
  }

  deepClone(): Node {
    return this.copy();
  }

  copy(): PartiallyEmittedExpression {
    const node = new PartiallyEmittedExpression(this.expression.deepClone());
    node.flags = this.flags;
    node.pos = this.pos;
    node.end = this.end;
    return node;
  }
}

export class JsxElement extends Node {
  openingElement: JsxOpeningElement;
  children: NodeList;
  closingElement: JsxClosingElement;

  constructor(openingElement: JsxOpeningElement, children: NodeList, closingElement: JsxClosingElement) {
    super(SyntaxKind.JsxElement);
    this.openingElement = openingElement;
    this.children = children;
    this.closingElement = closingElement;
  }

  forEachChild(v: NodeVisitor): boolean {
    if (v.visitNode(this.openingElement)) return true;
    if (v.visitList(this.children)) return true;
    return v.visitNode(this.closingElement);
  }

  deepClone(): Node {
    return this.copy();
  }

  copy(): JsxElement {
    const node = new JsxElement(this.openingElement.copy(), cloneList(this.children), this.closingElement.copy());
    node.flags = this.flags;
    node.pos = this.pos;
    node.end = this.end;
    return node;
  }
}

export class JsxAttributes extends Node {
  properties: NodeList;

  constructor(properties: NodeList) {
    super(SyntaxKind.JsxAttributes);
    this.properties = properties;
  }

  forEachChild(v: NodeVisitor): boolean {
    return v.visitList(this.properties);
  }

  deepClone(): Node {
    return this.copy();
  }

  copy(): JsxAttributes {
    const node = new JsxAttributes(cloneList(this.properties));
    node.flags = this.flags;
    node.pos = this.pos;
    node.end = this.end;
    return node;
  }
}

export class JsxNamespacedName extends Node {
  namespace: Identifier;
  name: Identifier;

  constructor(namespace: Identifier, name: Identifier) {
    super(SyntaxKind.JsxNamespacedName);
    this.namespace = namespace;
    this.name = name;
  }

  forEachChild(v: NodeVisitor): boolean {
    if (v.visitNode(this.namespace)) return true;
    return v.visitNode(this.name);
  }

  deepClone(): Node {
    return this.copy();
  }

  copy(): JsxNamespacedName {
    const node = new JsxNamespacedName(this.namespace.copy(), this.name.copy());
    node.flags = this.flags;
    node.pos = this.pos;
    node.end = this.end;
    return node;
  }
}

export class JsxOpeningElement extends Node {
  tagName: JsxTagNameExpression;
  typeArguments: NodeList | undefined;
  attributes: JsxAttributes;

  constructor(tagName: JsxTagNameExpression, typeArguments: NodeList | undefined, attributes: JsxAttributes) {
    super(SyntaxKind.JsxOpeningElement);
    this.tagName = tagName;
    this.typeArguments = typeArguments;
    this.attributes = attributes;
  }

  forEachChild(v: NodeVisitor): boolean {
    if (v.visitNode(this.tagName)) return true;
    if (this.typeArguments !== undefined && v.visitList(this.typeArguments)) return true;
    return v.visitNode(this.attributes);
  }

  deepClone(): Node {
    return this.copy();
  }

  copy(): JsxOpeningElement {
    const node = new JsxOpeningElement(
      this.tagName.deepClone(),
      this.typeArguments === undefined ? undefined : cloneList(this.typeArguments),
      this.attributes.copy(),
    );
    node.flags = this.flags;
    node.pos = this.pos;
    node.end = this.end;
    return node;
  }
}

export class JsxSelfClosingElement extends Node {
  tagName: JsxTagNameExpression;
  typeArguments: NodeList | undefined;
  attributes: JsxAttributes;

  constructor(tagName: JsxTagNameExpression, typeArguments: NodeList | undefined, attributes: JsxAttributes) {
    super(SyntaxKind.JsxSelfClosingElement);
    this.tagName = tagName;
    this.typeArguments = typeArguments;
    this.attributes = attributes;
  }

  forEachChild(v: NodeVisitor): boolean {
    if (v.visitNode(this.tagName)) return true;
    if (this.typeArguments !== undefined && v.visitList(this.typeArguments)) return true;
    return v.visitNode(this.attributes);
  }

  deepClone(): Node {
    return this.copy();
  }

  copy(): JsxSelfClosingElement {
    const node = new JsxSelfClosingElement(
      this.tagName.deepClone(),
      this.typeArguments === undefined ? undefined : cloneList(this.typeArguments),
      this.attributes.copy(),
    );
    node.flags = this.flags;
    node.pos = this.pos;
    node.end = this.end;
    return node;
  }
}

export class JsxFragment extends Node {
  openingFragment: JsxOpeningFragment;
  children: NodeList;
  closingFragment: JsxClosingFragment;

  constructor(openingFragment: JsxOpeningFragment, children: NodeList, closingFragment: JsxClosingFragment) {
    super(SyntaxKind.JsxFragment);
    this.openingFragment = openingFragment;
    this.children = children;
    this.closingFragment = closingFragment;
  }

  forEachChild(v: NodeVisitor): boolean {
    if (v.visitNode(this.openingFragment)) return true;
    if (v.visitList(this.children)) return true;
    return v.visitNode(this.closingFragment);
  }

  deepClone(): Node {
    return this.copy();
  }

  copy(): JsxFragment {
    const node = new JsxFragment(this.openingFragment.copy(), cloneList(this.children), this.closingFragment.copy());
    node.flags = this.flags;
    node.pos = this.pos;
    node.end = this.end;
    return node;
  }
}

export class JsxOpeningFragment extends Node {
  constructor() {
    super(SyntaxKind.JsxOpeningFragment);
  }

  forEachChild(_v: NodeVisitor): boolean {
    return false;
  }

  deepClone(): Node {
    return this.copy();
  }

  copy(): JsxOpeningFragment {
    const node = new JsxOpeningFragment();
    node.flags = this.flags;
    node.pos = this.pos;
    node.end = this.end;
    return node;
  }
}

export class JsxClosingFragment extends Node {
  constructor() {
    super(SyntaxKind.JsxClosingFragment);
  }

  forEachChild(_v: NodeVisitor): boolean {
    return false;
  }

  deepClone(): Node {
    return this.copy();
  }

  copy(): JsxClosingFragment {
    const node = new JsxClosingFragment();
    node.flags = this.flags;
    node.pos = this.pos;
    node.end = this.end;
    return node;
  }
}

export class JsxAttribute extends Node {
  name: JsxAttributeName;
  initializer: JsxAttributeValue | undefined;

  constructor(name: JsxAttributeName, initializer: JsxAttributeValue | undefined) {
    super(SyntaxKind.JsxAttribute);
    this.name = name;
    this.initializer = initializer;
  }

  forEachChild(v: NodeVisitor): boolean {
    if (v.visitNode(this.name)) return true;
    return this.initializer !== undefined && v.visitNode(this.initializer);
  }

  deepClone(): Node {
    return this.copy();
  }

  copy(): JsxAttribute {
    const node = new JsxAttribute(
      this.name.deepClone(),
      this.initializer === undefined ? undefined : this.initializer.deepClone(),
    );
    node.flags = this.flags;
    node.pos = this.pos;
    node.end = this.end;
    return node;
  }
}

export class JsxSpreadAttribute extends Node {
  expression: Expression;

  constructor(expression: Expression) {
    super(SyntaxKind.JsxSpreadAttribute);
    this.expression = expression;
  }

  forEachChild(v: NodeVisitor): boolean {
    return v.visitNode(this.expression);
  }

  deepClone(): Node {
    return this.copy();
  }

  copy(): JsxSpreadAttribute {
    const node = new JsxSpreadAttribute(this.expression.deepClone());
    node.flags = this.flags;
    node.pos = this.pos;
    node.end = this.end;
    return node;
  }
}

export class JsxClosingElement extends Node {
  tagName: JsxTagNameExpression;

  constructor(tagName: JsxTagNameExpression) {
    super(SyntaxKind.JsxClosingElement);
    this.tagName = tagName;
  }

  forEachChild(v: NodeVisitor): boolean {
    return v.visitNode(this.tagName);
  }

  deepClone(): Node {
    return this.copy();
  }

  copy(): JsxClosingElement {
    const node = new JsxClosingElement(this.tagName.deepClone());
    node.flags = this.flags;
    node.pos = this.pos;
    node.end = this.end;
    return node;
  }
}

export class JsxExpression extends Node {
  dotDotDotToken: Token | undefined;
  expression: Expression | undefined;

  constructor(dotDotDotToken: Token | undefined, expression: Expression | undefined) {
    super(SyntaxKind.JsxExpression);
    this.dotDotDotToken = dotDotDotToken;
    this.expression = expression;
  }

  forEachChild(v: NodeVisitor): boolean {
    if (this.dotDotDotToken !== undefined && v.visitNode(this.dotDotDotToken)) return true;
    return this.expression !== undefined && v.visitNode(this.expression);
  }

  deepClone(): Node {
    return this.copy();
  }

  copy(): JsxExpression {
    const node = new JsxExpression(
      this.dotDotDotToken === undefined ? undefined : this.dotDotDotToken.copy(),
      this.expression === undefined ? undefined : this.expression.deepClone(),
    );
    node.flags = this.flags;
    node.pos = this.pos;
    node.end = this.end;
    return node;
  }
}

export class JsxText extends Node {
  text: string;
  containsOnlyTriviaWhiteSpaces: boolean;

  constructor(text: string, containsOnlyTriviaWhiteSpaces: boolean) {
    super(SyntaxKind.JsxText);
    this.text = text;
    this.containsOnlyTriviaWhiteSpaces = containsOnlyTriviaWhiteSpaces;
  }

  forEachChild(_v: NodeVisitor): boolean {
    return false;
  }

  deepClone(): Node {
    return this.copy();
  }

  copy(): JsxText {
    const node = new JsxText(this.text, this.containsOnlyTriviaWhiteSpaces);
    node.flags = this.flags;
    node.pos = this.pos;
    node.end = this.end;
    return node;
  }
}

export class SyntaxList extends Node {
  children: Node[];

  constructor(children: Node[]) {
    super(SyntaxKind.SyntaxList);
    this.children = children;
  }

  forEachChild(v: NodeVisitor): boolean {
    for (const node of this.children) if (v.visitNode(node)) return true;
    return false;
  }

  deepClone(): Node {
    return this.copy();
  }

  copy(): SyntaxList {
    const node = new SyntaxList(cloneNodes(this.children));
    node.flags = this.flags;
    node.pos = this.pos;
    node.end = this.end;
    return node;
  }
}

export class JSDoc extends Node {
  comment: NodeList;
  tags: NodeList | undefined;

  constructor(comment: NodeList, tags: NodeList | undefined) {
    super(SyntaxKind.JSDoc);
    this.comment = comment;
    this.tags = tags;
  }

  forEachChild(v: NodeVisitor): boolean {
    if (v.visitList(this.comment)) return true;
    return this.tags !== undefined && v.visitList(this.tags);
  }

  deepClone(): Node {
    return this.copy();
  }

  copy(): JSDoc {
    const node = new JSDoc(cloneList(this.comment), this.tags === undefined ? undefined : cloneList(this.tags));
    node.flags = this.flags;
    node.pos = this.pos;
    node.end = this.end;
    return node;
  }
}

export class JSDocTypeExpression extends Node {
  type: TypeNode;

  constructor(type: TypeNode) {
    super(SyntaxKind.JSDocTypeExpression);
    this.type = type;
  }

  forEachChild(v: NodeVisitor): boolean {
    return v.visitNode(this.type);
  }

  deepClone(): Node {
    return this.copy();
  }

  copy(): JSDocTypeExpression {
    const node = new JSDocTypeExpression(this.type.deepClone());
    node.flags = this.flags;
    node.pos = this.pos;
    node.end = this.end;
    return node;
  }
}

export class JSDocNonNullableType extends Node {
  type: TypeNode;

  constructor(type: TypeNode) {
    super(SyntaxKind.JSDocNonNullableType);
    this.type = type;
  }

  forEachChild(v: NodeVisitor): boolean {
    return v.visitNode(this.type);
  }

  deepClone(): Node {
    return this.copy();
  }

  copy(): JSDocNonNullableType {
    const node = new JSDocNonNullableType(this.type.deepClone());
    node.flags = this.flags;
    node.pos = this.pos;
    node.end = this.end;
    return node;
  }
}

export class JSDocNullableType extends Node {
  type: TypeNode;

  constructor(type: TypeNode) {
    super(SyntaxKind.JSDocNullableType);
    this.type = type;
  }

  forEachChild(v: NodeVisitor): boolean {
    return v.visitNode(this.type);
  }

  deepClone(): Node {
    return this.copy();
  }

  copy(): JSDocNullableType {
    const node = new JSDocNullableType(this.type.deepClone());
    node.flags = this.flags;
    node.pos = this.pos;
    node.end = this.end;
    return node;
  }
}

export class JSDocAllType extends Node {
  constructor() {
    super(SyntaxKind.JSDocAllType);
  }

  forEachChild(_v: NodeVisitor): boolean {
    return false;
  }

  deepClone(): Node {
    return this.copy();
  }

  copy(): JSDocAllType {
    const node = new JSDocAllType();
    node.flags = this.flags;
    node.pos = this.pos;
    node.end = this.end;
    return node;
  }
}

export class JSDocVariadicType extends Node {
  type: TypeNode;

  constructor(type: TypeNode) {
    super(SyntaxKind.JSDocVariadicType);
    this.type = type;
  }

  forEachChild(v: NodeVisitor): boolean {
    return v.visitNode(this.type);
  }

  deepClone(): Node {
    return this.copy();
  }

  copy(): JSDocVariadicType {
    const node = new JSDocVariadicType(this.type.deepClone());
    node.flags = this.flags;
    node.pos = this.pos;
    node.end = this.end;
    return node;
  }
}

export class JSDocOptionalType extends Node {
  type: TypeNode;

  constructor(type: TypeNode) {
    super(SyntaxKind.JSDocOptionalType);
    this.type = type;
  }

  forEachChild(v: NodeVisitor): boolean {
    return v.visitNode(this.type);
  }

  deepClone(): Node {
    return this.copy();
  }

  copy(): JSDocOptionalType {
    const node = new JSDocOptionalType(this.type.deepClone());
    node.flags = this.flags;
    node.pos = this.pos;
    node.end = this.end;
    return node;
  }
}

export class JSDocTypeTag extends Node {
  tagName: Identifier;
  typeExpression: Node | undefined;
  comment: NodeList | undefined;

  constructor(tagName: Identifier, typeExpression: Node | undefined, comment: NodeList | undefined) {
    super(SyntaxKind.JSDocTypeTag);
    this.tagName = tagName;
    this.typeExpression = typeExpression;
    this.comment = comment;
  }

  forEachChild(v: NodeVisitor): boolean {
    if (v.visitNode(this.tagName)) return true;
    if (this.typeExpression !== undefined && v.visitNode(this.typeExpression)) return true;
    return this.comment !== undefined && v.visitList(this.comment);
  }

  deepClone(): Node {
    return this.copy();
  }

  copy(): JSDocTypeTag {
    const node = new JSDocTypeTag(
      this.tagName.copy(),
      this.typeExpression === undefined ? undefined : this.typeExpression.deepClone(),
      this.comment === undefined ? undefined : cloneList(this.comment),
    );
    node.flags = this.flags;
    node.pos = this.pos;
    node.end = this.end;
    return node;
  }
}

export class JSDocUnknownTag extends Node {
  tagName: Identifier;
  comment: NodeList | undefined;

  constructor(tagName: Identifier, comment: NodeList | undefined) {
    super(SyntaxKind.JSDocUnknownTag);
    this.tagName = tagName;
    this.comment = comment;
  }

  forEachChild(v: NodeVisitor): boolean {
    if (v.visitNode(this.tagName)) return true;
    return this.comment !== undefined && v.visitList(this.comment);
  }

  deepClone(): Node {
    return this.copy();
  }

  copy(): JSDocUnknownTag {
    const node = new JSDocUnknownTag(
      this.tagName.copy(),
      this.comment === undefined ? undefined : cloneList(this.comment),
    );
    node.flags = this.flags;
    node.pos = this.pos;
    node.end = this.end;
    return node;
  }
}

export class JSDocTemplateTag extends Node {
  tagName: Identifier;
  constraint: Node | undefined;
  typeParameters: NodeList;
  comment: NodeList | undefined;

  constructor(
    tagName: Identifier,
    constraint: Node | undefined,
    typeParameters: NodeList,
    comment: NodeList | undefined,
  ) {
    super(SyntaxKind.JSDocTemplateTag);
    this.tagName = tagName;
    this.constraint = constraint;
    this.typeParameters = typeParameters;
    this.comment = comment;
  }

  forEachChild(v: NodeVisitor): boolean {
    if (v.visitNode(this.tagName)) return true;
    if (this.constraint !== undefined && v.visitNode(this.constraint)) return true;
    if (v.visitList(this.typeParameters)) return true;
    return this.comment !== undefined && v.visitList(this.comment);
  }

  deepClone(): Node {
    return this.copy();
  }

  copy(): JSDocTemplateTag {
    const node = new JSDocTemplateTag(
      this.tagName.copy(),
      this.constraint === undefined ? undefined : this.constraint.deepClone(),
      cloneList(this.typeParameters),
      this.comment === undefined ? undefined : cloneList(this.comment),
    );
    node.flags = this.flags;
    node.pos = this.pos;
    node.end = this.end;
    return node;
  }
}

export class JSDocReturnTag extends Node {
  tagName: Identifier;
  typeExpression: TypeNode | undefined;
  comment: NodeList | undefined;

  constructor(tagName: Identifier, typeExpression: TypeNode | undefined, comment: NodeList | undefined) {
    super(SyntaxKind.JSDocReturnTag);
    this.tagName = tagName;
    this.typeExpression = typeExpression;
    this.comment = comment;
  }

  forEachChild(v: NodeVisitor): boolean {
    if (v.visitNode(this.tagName)) return true;
    if (this.typeExpression !== undefined && v.visitNode(this.typeExpression)) return true;
    return this.comment !== undefined && v.visitList(this.comment);
  }

  deepClone(): Node {
    return this.copy();
  }

  copy(): JSDocReturnTag {
    const node = new JSDocReturnTag(
      this.tagName.copy(),
      this.typeExpression === undefined ? undefined : this.typeExpression.deepClone(),
      this.comment === undefined ? undefined : cloneList(this.comment),
    );
    node.flags = this.flags;
    node.pos = this.pos;
    node.end = this.end;
    return node;
  }
}

export class JSDocPublicTag extends Node {
  tagName: Identifier;
  comment: NodeList | undefined;

  constructor(tagName: Identifier, comment: NodeList | undefined) {
    super(SyntaxKind.JSDocPublicTag);
    this.tagName = tagName;
    this.comment = comment;
  }

  forEachChild(v: NodeVisitor): boolean {
    if (v.visitNode(this.tagName)) return true;
    return this.comment !== undefined && v.visitList(this.comment);
  }

  deepClone(): Node {
    return this.copy();
  }

  copy(): JSDocPublicTag {
    const node = new JSDocPublicTag(
      this.tagName.copy(),
      this.comment === undefined ? undefined : cloneList(this.comment),
    );
    node.flags = this.flags;
    node.pos = this.pos;
    node.end = this.end;
    return node;
  }
}

export class JSDocPrivateTag extends Node {
  tagName: Identifier;
  comment: NodeList | undefined;

  constructor(tagName: Identifier, comment: NodeList | undefined) {
    super(SyntaxKind.JSDocPrivateTag);
    this.tagName = tagName;
    this.comment = comment;
  }

  forEachChild(v: NodeVisitor): boolean {
    if (v.visitNode(this.tagName)) return true;
    return this.comment !== undefined && v.visitList(this.comment);
  }

  deepClone(): Node {
    return this.copy();
  }

  copy(): JSDocPrivateTag {
    const node = new JSDocPrivateTag(
      this.tagName.copy(),
      this.comment === undefined ? undefined : cloneList(this.comment),
    );
    node.flags = this.flags;
    node.pos = this.pos;
    node.end = this.end;
    return node;
  }
}

export class JSDocProtectedTag extends Node {
  tagName: Identifier;
  comment: NodeList | undefined;

  constructor(tagName: Identifier, comment: NodeList | undefined) {
    super(SyntaxKind.JSDocProtectedTag);
    this.tagName = tagName;
    this.comment = comment;
  }

  forEachChild(v: NodeVisitor): boolean {
    if (v.visitNode(this.tagName)) return true;
    return this.comment !== undefined && v.visitList(this.comment);
  }

  deepClone(): Node {
    return this.copy();
  }

  copy(): JSDocProtectedTag {
    const node = new JSDocProtectedTag(
      this.tagName.copy(),
      this.comment === undefined ? undefined : cloneList(this.comment),
    );
    node.flags = this.flags;
    node.pos = this.pos;
    node.end = this.end;
    return node;
  }
}

export class JSDocReadonlyTag extends Node {
  tagName: Identifier;
  comment: NodeList | undefined;

  constructor(tagName: Identifier, comment: NodeList | undefined) {
    super(SyntaxKind.JSDocReadonlyTag);
    this.tagName = tagName;
    this.comment = comment;
  }

  forEachChild(v: NodeVisitor): boolean {
    if (v.visitNode(this.tagName)) return true;
    return this.comment !== undefined && v.visitList(this.comment);
  }

  deepClone(): Node {
    return this.copy();
  }

  copy(): JSDocReadonlyTag {
    const node = new JSDocReadonlyTag(
      this.tagName.copy(),
      this.comment === undefined ? undefined : cloneList(this.comment),
    );
    node.flags = this.flags;
    node.pos = this.pos;
    node.end = this.end;
    return node;
  }
}

export class JSDocOverrideTag extends Node {
  tagName: Identifier;
  comment: NodeList | undefined;

  constructor(tagName: Identifier, comment: NodeList | undefined) {
    super(SyntaxKind.JSDocOverrideTag);
    this.tagName = tagName;
    this.comment = comment;
  }

  forEachChild(v: NodeVisitor): boolean {
    if (v.visitNode(this.tagName)) return true;
    return this.comment !== undefined && v.visitList(this.comment);
  }

  deepClone(): Node {
    return this.copy();
  }

  copy(): JSDocOverrideTag {
    const node = new JSDocOverrideTag(
      this.tagName.copy(),
      this.comment === undefined ? undefined : cloneList(this.comment),
    );
    node.flags = this.flags;
    node.pos = this.pos;
    node.end = this.end;
    return node;
  }
}

export class JSDocDeprecatedTag extends Node {
  tagName: Identifier;
  comment: NodeList | undefined;

  constructor(tagName: Identifier, comment: NodeList | undefined) {
    super(SyntaxKind.JSDocDeprecatedTag);
    this.tagName = tagName;
    this.comment = comment;
  }

  forEachChild(v: NodeVisitor): boolean {
    if (v.visitNode(this.tagName)) return true;
    return this.comment !== undefined && v.visitList(this.comment);
  }

  deepClone(): Node {
    return this.copy();
  }

  copy(): JSDocDeprecatedTag {
    const node = new JSDocDeprecatedTag(
      this.tagName.copy(),
      this.comment === undefined ? undefined : cloneList(this.comment),
    );
    node.flags = this.flags;
    node.pos = this.pos;
    node.end = this.end;
    return node;
  }
}

export class JSDocSeeTag extends Node {
  tagName: Identifier;
  nameExpression: TypeNode | undefined;
  comment: NodeList | undefined;

  constructor(tagName: Identifier, nameExpression: TypeNode | undefined, comment: NodeList | undefined) {
    super(SyntaxKind.JSDocSeeTag);
    this.tagName = tagName;
    this.nameExpression = nameExpression;
    this.comment = comment;
  }

  forEachChild(v: NodeVisitor): boolean {
    if (v.visitNode(this.tagName)) return true;
    if (this.nameExpression !== undefined && v.visitNode(this.nameExpression)) return true;
    return this.comment !== undefined && v.visitList(this.comment);
  }

  deepClone(): Node {
    return this.copy();
  }

  copy(): JSDocSeeTag {
    const node = new JSDocSeeTag(
      this.tagName.copy(),
      this.nameExpression === undefined ? undefined : this.nameExpression.deepClone(),
      this.comment === undefined ? undefined : cloneList(this.comment),
    );
    node.flags = this.flags;
    node.pos = this.pos;
    node.end = this.end;
    return node;
  }
}

export class JSDocImplementsTag extends Node {
  tagName: Identifier;
  className: ExpressionWithTypeArguments;
  comment: NodeList | undefined;

  constructor(tagName: Identifier, className: ExpressionWithTypeArguments, comment: NodeList | undefined) {
    super(SyntaxKind.JSDocImplementsTag);
    this.tagName = tagName;
    this.className = className;
    this.comment = comment;
  }

  forEachChild(v: NodeVisitor): boolean {
    if (v.visitNode(this.tagName)) return true;
    if (v.visitNode(this.className)) return true;
    return this.comment !== undefined && v.visitList(this.comment);
  }

  deepClone(): Node {
    return this.copy();
  }

  copy(): JSDocImplementsTag {
    const node = new JSDocImplementsTag(
      this.tagName.copy(),
      this.className.copy(),
      this.comment === undefined ? undefined : cloneList(this.comment),
    );
    node.flags = this.flags;
    node.pos = this.pos;
    node.end = this.end;
    return node;
  }
}

export class JSDocAugmentsTag extends Node {
  tagName: Identifier;
  className: ExpressionWithTypeArguments;
  comment: NodeList | undefined;

  constructor(tagName: Identifier, className: ExpressionWithTypeArguments, comment: NodeList | undefined) {
    super(SyntaxKind.JSDocAugmentsTag);
    this.tagName = tagName;
    this.className = className;
    this.comment = comment;
  }

  forEachChild(v: NodeVisitor): boolean {
    if (v.visitNode(this.tagName)) return true;
    if (v.visitNode(this.className)) return true;
    return this.comment !== undefined && v.visitList(this.comment);
  }

  deepClone(): Node {
    return this.copy();
  }

  copy(): JSDocAugmentsTag {
    const node = new JSDocAugmentsTag(
      this.tagName.copy(),
      this.className.copy(),
      this.comment === undefined ? undefined : cloneList(this.comment),
    );
    node.flags = this.flags;
    node.pos = this.pos;
    node.end = this.end;
    return node;
  }
}

export class JSDocSatisfiesTag extends Node {
  tagName: Identifier;
  typeExpression: TypeNode;
  comment: NodeList | undefined;

  constructor(tagName: Identifier, typeExpression: TypeNode, comment: NodeList | undefined) {
    super(SyntaxKind.JSDocSatisfiesTag);
    this.tagName = tagName;
    this.typeExpression = typeExpression;
    this.comment = comment;
  }

  forEachChild(v: NodeVisitor): boolean {
    if (v.visitNode(this.tagName)) return true;
    if (v.visitNode(this.typeExpression)) return true;
    return this.comment !== undefined && v.visitList(this.comment);
  }

  deepClone(): Node {
    return this.copy();
  }

  copy(): JSDocSatisfiesTag {
    const node = new JSDocSatisfiesTag(
      this.tagName.copy(),
      this.typeExpression.deepClone(),
      this.comment === undefined ? undefined : cloneList(this.comment),
    );
    node.flags = this.flags;
    node.pos = this.pos;
    node.end = this.end;
    return node;
  }
}

export class JSDocThrowsTag extends Node {
  tagName: Identifier;
  typeExpression: TypeNode | undefined;
  comment: NodeList | undefined;

  constructor(tagName: Identifier, typeExpression: TypeNode | undefined, comment: NodeList | undefined) {
    super(SyntaxKind.JSDocThrowsTag);
    this.tagName = tagName;
    this.typeExpression = typeExpression;
    this.comment = comment;
  }

  forEachChild(v: NodeVisitor): boolean {
    if (v.visitNode(this.tagName)) return true;
    if (this.typeExpression !== undefined && v.visitNode(this.typeExpression)) return true;
    return this.comment !== undefined && v.visitList(this.comment);
  }

  deepClone(): Node {
    return this.copy();
  }

  copy(): JSDocThrowsTag {
    const node = new JSDocThrowsTag(
      this.tagName.copy(),
      this.typeExpression === undefined ? undefined : this.typeExpression.deepClone(),
      this.comment === undefined ? undefined : cloneList(this.comment),
    );
    node.flags = this.flags;
    node.pos = this.pos;
    node.end = this.end;
    return node;
  }
}

export class JSDocThisTag extends Node {
  tagName: Identifier;
  typeExpression: TypeNode;
  comment: NodeList | undefined;

  constructor(tagName: Identifier, typeExpression: TypeNode, comment: NodeList | undefined) {
    super(SyntaxKind.JSDocThisTag);
    this.tagName = tagName;
    this.typeExpression = typeExpression;
    this.comment = comment;
  }

  forEachChild(v: NodeVisitor): boolean {
    if (v.visitNode(this.tagName)) return true;
    if (v.visitNode(this.typeExpression)) return true;
    return this.comment !== undefined && v.visitList(this.comment);
  }

  deepClone(): Node {
    return this.copy();
  }

  copy(): JSDocThisTag {
    const node = new JSDocThisTag(
      this.tagName.copy(),
      this.typeExpression.deepClone(),
      this.comment === undefined ? undefined : cloneList(this.comment),
    );
    node.flags = this.flags;
    node.pos = this.pos;
    node.end = this.end;
    return node;
  }
}

export class JSDocImportTag extends Node {
  tagName: Identifier;
  importClause: ImportClause | undefined;
  moduleSpecifier: Expression;
  attributes: ImportAttributes | undefined;
  comment: NodeList | undefined;

  constructor(
    tagName: Identifier,
    importClause: ImportClause | undefined,
    moduleSpecifier: Expression,
    attributes: ImportAttributes | undefined,
    comment: NodeList | undefined,
  ) {
    super(SyntaxKind.JSDocImportTag);
    this.tagName = tagName;
    this.importClause = importClause;
    this.moduleSpecifier = moduleSpecifier;
    this.attributes = attributes;
    this.comment = comment;
  }

  forEachChild(v: NodeVisitor): boolean {
    if (v.visitNode(this.tagName)) return true;
    if (this.importClause !== undefined && v.visitNode(this.importClause)) return true;
    if (v.visitNode(this.moduleSpecifier)) return true;
    if (this.attributes !== undefined && v.visitNode(this.attributes)) return true;
    return this.comment !== undefined && v.visitList(this.comment);
  }

  deepClone(): Node {
    return this.copy();
  }

  copy(): JSDocImportTag {
    const node = new JSDocImportTag(
      this.tagName.copy(),
      this.importClause === undefined ? undefined : this.importClause.copy(),
      this.moduleSpecifier.deepClone(),
      this.attributes === undefined ? undefined : this.attributes.copy(),
      this.comment === undefined ? undefined : cloneList(this.comment),
    );
    node.flags = this.flags;
    node.pos = this.pos;
    node.end = this.end;
    return node;
  }
}

export class JSDocCallbackTag extends Node {
  tagName: Identifier;
  typeExpression: TypeNode;
  name: JSDocFullName | undefined;
  comment: NodeList | undefined;

  constructor(
    tagName: Identifier,
    typeExpression: TypeNode,
    name: JSDocFullName | undefined,
    comment: NodeList | undefined,
  ) {
    super(SyntaxKind.JSDocCallbackTag);
    this.tagName = tagName;
    this.typeExpression = typeExpression;
    this.name = name;
    this.comment = comment;
  }

  forEachChild(v: NodeVisitor): boolean {
    if (v.visitNode(this.tagName)) return true;
    if (v.visitNode(this.typeExpression)) return true;
    if (this.name !== undefined && v.visitNode(this.name)) return true;
    return this.comment !== undefined && v.visitList(this.comment);
  }

  deepClone(): Node {
    return this.copy();
  }

  copy(): JSDocCallbackTag {
    const node = new JSDocCallbackTag(
      this.tagName.copy(),
      this.typeExpression.deepClone(),
      this.name === undefined ? undefined : this.name.deepClone(),
      this.comment === undefined ? undefined : cloneList(this.comment),
    );
    node.flags = this.flags;
    node.pos = this.pos;
    node.end = this.end;
    return node;
  }
}

export class JSDocOverloadTag extends Node {
  tagName: Identifier;
  typeExpression: TypeNode;
  comment: NodeList | undefined;

  constructor(tagName: Identifier, typeExpression: TypeNode, comment: NodeList | undefined) {
    super(SyntaxKind.JSDocOverloadTag);
    this.tagName = tagName;
    this.typeExpression = typeExpression;
    this.comment = comment;
  }

  forEachChild(v: NodeVisitor): boolean {
    if (v.visitNode(this.tagName)) return true;
    if (v.visitNode(this.typeExpression)) return true;
    return this.comment !== undefined && v.visitList(this.comment);
  }

  deepClone(): Node {
    return this.copy();
  }

  copy(): JSDocOverloadTag {
    const node = new JSDocOverloadTag(
      this.tagName.copy(),
      this.typeExpression.deepClone(),
      this.comment === undefined ? undefined : cloneList(this.comment),
    );
    node.flags = this.flags;
    node.pos = this.pos;
    node.end = this.end;
    return node;
  }
}

export class JSDocTypedefTag extends Node {
  tagName: Identifier;
  typeExpression: Node | undefined;
  name: JSDocFullName | undefined;
  comment: NodeList | undefined;

  constructor(
    tagName: Identifier,
    typeExpression: Node | undefined,
    name: JSDocFullName | undefined,
    comment: NodeList | undefined,
  ) {
    super(SyntaxKind.JSDocTypedefTag);
    this.tagName = tagName;
    this.typeExpression = typeExpression;
    this.name = name;
    this.comment = comment;
  }

  forEachChild(v: NodeVisitor): boolean {
    if (v.visitNode(this.tagName)) return true;
    if (this.typeExpression !== undefined && v.visitNode(this.typeExpression)) return true;
    if (this.name !== undefined && v.visitNode(this.name)) return true;
    return this.comment !== undefined && v.visitList(this.comment);
  }

  deepClone(): Node {
    return this.copy();
  }

  copy(): JSDocTypedefTag {
    const node = new JSDocTypedefTag(
      this.tagName.copy(),
      this.typeExpression === undefined ? undefined : this.typeExpression.deepClone(),
      this.name === undefined ? undefined : this.name.deepClone(),
      this.comment === undefined ? undefined : cloneList(this.comment),
    );
    node.flags = this.flags;
    node.pos = this.pos;
    node.end = this.end;
    return node;
  }
}

export class JSDocSignature extends Node {
  typeParameters: NodeList | undefined;
  parameters: NodeList;
  type: TypeNode | undefined;

  constructor(typeParameters: NodeList | undefined, parameters: NodeList, type: TypeNode | undefined) {
    super(SyntaxKind.JSDocSignature);
    this.typeParameters = typeParameters;
    this.parameters = parameters;
    this.type = type;
  }

  forEachChild(v: NodeVisitor): boolean {
    if (this.typeParameters !== undefined && v.visitList(this.typeParameters)) return true;
    if (v.visitList(this.parameters)) return true;
    return this.type !== undefined && v.visitNode(this.type);
  }

  deepClone(): Node {
    return this.copy();
  }

  copy(): JSDocSignature {
    const node = new JSDocSignature(
      this.typeParameters === undefined ? undefined : cloneList(this.typeParameters),
      cloneList(this.parameters),
      this.type === undefined ? undefined : this.type.deepClone(),
    );
    node.flags = this.flags;
    node.pos = this.pos;
    node.end = this.end;
    return node;
  }
}

export class JSDocNameReference extends Node {
  name: EntityName | undefined;

  constructor(name: EntityName | undefined) {
    super(SyntaxKind.JSDocNameReference);
    this.name = name;
  }

  forEachChild(v: NodeVisitor): boolean {
    return this.name !== undefined && v.visitNode(this.name);
  }

  deepClone(): Node {
    return this.copy();
  }

  copy(): JSDocNameReference {
    const node = new JSDocNameReference(this.name === undefined ? undefined : this.name.deepClone());
    node.flags = this.flags;
    node.pos = this.pos;
    node.end = this.end;
    return node;
  }
}

export class ModuleDeclaration extends Node {
  modifiers: ModifierList | undefined;
  keyword: SyntaxKind;
  name: ModuleName;
  body: ModuleBody | undefined;

  constructor(
    modifiers: ModifierList | undefined,
    keyword: SyntaxKind,
    name: ModuleName,
    body: ModuleBody | undefined,
  ) {
    super(SyntaxKind.ModuleDeclaration);
    this.modifiers = modifiers;
    this.keyword = keyword;
    this.name = name;
    this.body = body;
  }

  forEachChild(v: NodeVisitor): boolean {
    if (this.modifiers !== undefined && v.visitModifiers(this.modifiers)) return true;
    if (v.visitNode(this.name)) return true;
    return this.body !== undefined && v.visitNode(this.body);
  }

  deepClone(): Node {
    return this.copy();
  }

  copy(): ModuleDeclaration {
    const node = new ModuleDeclaration(
      this.modifiers === undefined ? undefined : cloneModifiers(this.modifiers),
      this.keyword,
      this.name.deepClone(),
      this.body === undefined ? undefined : this.body.deepClone(),
    );
    node.flags = this.flags;
    node.pos = this.pos;
    node.end = this.end;
    return node;
  }
}

export class ImportEqualsDeclaration extends Node {
  modifiers: ModifierList | undefined;
  isTypeOnly: boolean;
  name: Identifier;
  moduleReference: ModuleReference;

  constructor(
    modifiers: ModifierList | undefined,
    isTypeOnly: boolean,
    name: Identifier,
    moduleReference: ModuleReference,
  ) {
    super(SyntaxKind.ImportEqualsDeclaration);
    this.modifiers = modifiers;
    this.isTypeOnly = isTypeOnly;
    this.name = name;
    this.moduleReference = moduleReference;
  }

  forEachChild(v: NodeVisitor): boolean {
    if (this.modifiers !== undefined && v.visitModifiers(this.modifiers)) return true;
    if (v.visitNode(this.name)) return true;
    return v.visitNode(this.moduleReference);
  }

  deepClone(): Node {
    return this.copy();
  }

  copy(): ImportEqualsDeclaration {
    const node = new ImportEqualsDeclaration(
      this.modifiers === undefined ? undefined : cloneModifiers(this.modifiers),
      this.isTypeOnly,
      this.name.copy(),
      this.moduleReference.deepClone(),
    );
    node.flags = this.flags;
    node.pos = this.pos;
    node.end = this.end;
    return node;
  }
}

export class ExportDeclaration extends Node {
  modifiers: ModifierList | undefined;
  isTypeOnly: boolean;
  exportClause: NamedExportBindings | undefined;
  moduleSpecifier: Expression | undefined;
  attributes: ImportAttributes | undefined;

  constructor(
    modifiers: ModifierList | undefined,
    isTypeOnly: boolean,
    exportClause: NamedExportBindings | undefined,
    moduleSpecifier: Expression | undefined,
    attributes: ImportAttributes | undefined,
  ) {
    super(SyntaxKind.ExportDeclaration);
    this.modifiers = modifiers;
    this.isTypeOnly = isTypeOnly;
    this.exportClause = exportClause;
    this.moduleSpecifier = moduleSpecifier;
    this.attributes = attributes;
  }

  forEachChild(v: NodeVisitor): boolean {
    if (this.modifiers !== undefined && v.visitModifiers(this.modifiers)) return true;
    if (this.exportClause !== undefined && v.visitNode(this.exportClause)) return true;
    if (this.moduleSpecifier !== undefined && v.visitNode(this.moduleSpecifier)) return true;
    return this.attributes !== undefined && v.visitNode(this.attributes);
  }

  deepClone(): Node {
    return this.copy();
  }

  copy(): ExportDeclaration {
    const node = new ExportDeclaration(
      this.modifiers === undefined ? undefined : cloneModifiers(this.modifiers),
      this.isTypeOnly,
      this.exportClause === undefined ? undefined : this.exportClause.deepClone(),
      this.moduleSpecifier === undefined ? undefined : this.moduleSpecifier.deepClone(),
      this.attributes === undefined ? undefined : this.attributes.copy(),
    );
    node.flags = this.flags;
    node.pos = this.pos;
    node.end = this.end;
    return node;
  }
}

export class ImportTypeNode extends Node {
  isTypeOf: boolean;
  argument: TypeNode;
  attributes: ImportAttributes | undefined;
  qualifier: EntityName | undefined;
  typeArguments: NodeList | undefined;

  constructor(
    isTypeOf: boolean,
    argument: TypeNode,
    attributes: ImportAttributes | undefined,
    qualifier: EntityName | undefined,
    typeArguments: NodeList | undefined,
  ) {
    super(SyntaxKind.ImportType);
    this.isTypeOf = isTypeOf;
    this.argument = argument;
    this.attributes = attributes;
    this.qualifier = qualifier;
    this.typeArguments = typeArguments;
  }

  forEachChild(v: NodeVisitor): boolean {
    if (v.visitNode(this.argument)) return true;
    if (this.attributes !== undefined && v.visitNode(this.attributes)) return true;
    if (this.qualifier !== undefined && v.visitNode(this.qualifier)) return true;
    return this.typeArguments !== undefined && v.visitList(this.typeArguments);
  }

  deepClone(): Node {
    return this.copy();
  }

  copy(): ImportTypeNode {
    const node = new ImportTypeNode(
      this.isTypeOf,
      this.argument.deepClone(),
      this.attributes === undefined ? undefined : this.attributes.copy(),
      this.qualifier === undefined ? undefined : this.qualifier.deepClone(),
      this.typeArguments === undefined ? undefined : cloneList(this.typeArguments),
    );
    node.flags = this.flags;
    node.pos = this.pos;
    node.end = this.end;
    return node;
  }
}

export class ImportClause extends Node {
  phaseModifier: SyntaxKind | undefined;
  name: Identifier | undefined;
  namedBindings: NamedImportBindings | undefined;

  constructor(
    phaseModifier: SyntaxKind | undefined,
    name: Identifier | undefined,
    namedBindings: NamedImportBindings | undefined,
  ) {
    super(SyntaxKind.ImportClause);
    this.phaseModifier = phaseModifier;
    this.name = name;
    this.namedBindings = namedBindings;
  }

  forEachChild(v: NodeVisitor): boolean {
    if (this.name !== undefined && v.visitNode(this.name)) return true;
    return this.namedBindings !== undefined && v.visitNode(this.namedBindings);
  }

  deepClone(): Node {
    return this.copy();
  }

  copy(): ImportClause {
    const node = new ImportClause(
      this.phaseModifier,
      this.name === undefined ? undefined : this.name.copy(),
      this.namedBindings === undefined ? undefined : this.namedBindings.deepClone(),
    );
    node.flags = this.flags;
    node.pos = this.pos;
    node.end = this.end;
    return node;
  }
}

export class ImportSpecifier extends Node {
  isTypeOnly: boolean;
  propertyName: ModuleExportName | undefined;
  name: Identifier;

  constructor(isTypeOnly: boolean, propertyName: ModuleExportName | undefined, name: Identifier) {
    super(SyntaxKind.ImportSpecifier);
    this.isTypeOnly = isTypeOnly;
    this.propertyName = propertyName;
    this.name = name;
  }

  forEachChild(v: NodeVisitor): boolean {
    if (this.propertyName !== undefined && v.visitNode(this.propertyName)) return true;
    return v.visitNode(this.name);
  }

  deepClone(): Node {
    return this.copy();
  }

  copy(): ImportSpecifier {
    const node = new ImportSpecifier(
      this.isTypeOnly,
      this.propertyName === undefined ? undefined : this.propertyName.deepClone(),
      this.name.copy(),
    );
    node.flags = this.flags;
    node.pos = this.pos;
    node.end = this.end;
    return node;
  }
}

export class JSDocText extends Node {
  text: string;

  constructor(text: string) {
    super(SyntaxKind.JSDocText);
    this.text = text;
  }

  forEachChild(_v: NodeVisitor): boolean {
    return false;
  }

  deepClone(): Node {
    return this.copy();
  }

  copy(): JSDocText {
    const node = new JSDocText(this.text);
    node.flags = this.flags;
    node.pos = this.pos;
    node.end = this.end;
    return node;
  }
}

export class JSDocLink extends Node {
  name: EntityName | undefined;
  text: string;

  constructor(name: EntityName | undefined, text: string) {
    super(SyntaxKind.JSDocLink);
    this.name = name;
    this.text = text;
  }

  forEachChild(v: NodeVisitor): boolean {
    return this.name !== undefined && v.visitNode(this.name);
  }

  deepClone(): Node {
    return this.copy();
  }

  copy(): JSDocLink {
    const node = new JSDocLink(this.name === undefined ? undefined : this.name.deepClone(), this.text);
    node.flags = this.flags;
    node.pos = this.pos;
    node.end = this.end;
    return node;
  }
}

export class JSDocLinkPlain extends Node {
  name: EntityName | undefined;
  text: string;

  constructor(name: EntityName | undefined, text: string) {
    super(SyntaxKind.JSDocLinkPlain);
    this.name = name;
    this.text = text;
  }

  forEachChild(v: NodeVisitor): boolean {
    return this.name !== undefined && v.visitNode(this.name);
  }

  deepClone(): Node {
    return this.copy();
  }

  copy(): JSDocLinkPlain {
    const node = new JSDocLinkPlain(this.name === undefined ? undefined : this.name.deepClone(), this.text);
    node.flags = this.flags;
    node.pos = this.pos;
    node.end = this.end;
    return node;
  }
}

export class JSDocLinkCode extends Node {
  name: EntityName | undefined;
  text: string;

  constructor(name: EntityName | undefined, text: string) {
    super(SyntaxKind.JSDocLinkCode);
    this.name = name;
    this.text = text;
  }

  forEachChild(v: NodeVisitor): boolean {
    return this.name !== undefined && v.visitNode(this.name);
  }

  deepClone(): Node {
    return this.copy();
  }

  copy(): JSDocLinkCode {
    const node = new JSDocLinkCode(this.name === undefined ? undefined : this.name.deepClone(), this.text);
    node.flags = this.flags;
    node.pos = this.pos;
    node.end = this.end;
    return node;
  }
}

export class TypeParameterDeclaration extends Node {
  modifiers: ModifierList | undefined;
  name: Identifier;
  constraint: TypeNode | undefined;
  expression: Expression | undefined;
  defaultType: TypeNode | undefined;

  constructor(
    modifiers: ModifierList | undefined,
    name: Identifier,
    constraint: TypeNode | undefined,
    expression: Expression | undefined,
    defaultType: TypeNode | undefined,
  ) {
    super(SyntaxKind.TypeParameter);
    this.modifiers = modifiers;
    this.name = name;
    this.constraint = constraint;
    this.expression = expression;
    this.defaultType = defaultType;
  }

  forEachChild(v: NodeVisitor): boolean {
    if (this.modifiers !== undefined && v.visitModifiers(this.modifiers)) return true;
    if (v.visitNode(this.name)) return true;
    if (this.constraint !== undefined && v.visitNode(this.constraint)) return true;
    if (this.expression !== undefined && v.visitNode(this.expression)) return true;
    return this.defaultType !== undefined && v.visitNode(this.defaultType);
  }

  deepClone(): Node {
    return this.copy();
  }

  copy(): TypeParameterDeclaration {
    const node = new TypeParameterDeclaration(
      this.modifiers === undefined ? undefined : cloneModifiers(this.modifiers),
      this.name.copy(),
      this.constraint === undefined ? undefined : this.constraint.deepClone(),
      this.expression === undefined ? undefined : this.expression.deepClone(),
      this.defaultType === undefined ? undefined : this.defaultType.deepClone(),
    );
    node.flags = this.flags;
    node.pos = this.pos;
    node.end = this.end;
    return node;
  }
}

export class SyntheticReferenceExpression extends Node {
  expression: Expression;
  thisArg: Expression;

  constructor(expression: Expression, thisArg: Expression) {
    super(SyntaxKind.SyntheticReferenceExpression);
    this.expression = expression;
    this.thisArg = thisArg;
  }

  forEachChild(v: NodeVisitor): boolean {
    if (v.visitNode(this.expression)) return true;
    return v.visitNode(this.thisArg);
  }

  deepClone(): Node {
    return this.copy();
  }

  copy(): SyntheticReferenceExpression {
    const node = new SyntheticReferenceExpression(this.expression.deepClone(), this.thisArg.deepClone());
    node.flags = this.flags;
    node.pos = this.pos;
    node.end = this.end;
    return node;
  }
}

export class JSDocTypeLiteral extends Node {
  jsdocPropertyTags: Node[] | undefined;
  isArrayType: boolean;

  constructor(jsdocPropertyTags: Node[] | undefined, isArrayType: boolean) {
    super(SyntaxKind.JSDocTypeLiteral);
    this.jsdocPropertyTags = jsdocPropertyTags;
    this.isArrayType = isArrayType;
  }

  forEachChild(v: NodeVisitor): boolean {
    if (this.jsdocPropertyTags !== undefined)
      for (const node of this.jsdocPropertyTags) if (v.visitNode(node)) return true;
    return false;
  }

  deepClone(): Node {
    return this.copy();
  }

  copy(): JSDocTypeLiteral {
    const node = new JSDocTypeLiteral(
      this.jsdocPropertyTags === undefined ? undefined : cloneNodes(this.jsdocPropertyTags),
      this.isArrayType,
    );
    node.flags = this.flags;
    node.pos = this.pos;
    node.end = this.end;
    return node;
  }
}

// #endregion nodes

/** `@param` or `@property`. Children are visited name-first when the name precedes the type. */
export class JSDocParameterOrPropertyTag extends Node {
  tagName: Identifier;
  name: EntityName;
  isBracketed: boolean;
  typeExpression: TypeNode | undefined;
  isNameFirst: boolean;
  comment: NodeList | undefined;

  constructor(
    kind: SyntaxKind,
    tagName: Identifier,
    name: EntityName,
    isBracketed: boolean,
    typeExpression: TypeNode | undefined,
    isNameFirst: boolean,
    comment: NodeList | undefined,
  ) {
    super(kind);
    this.tagName = tagName;
    this.name = name;
    this.isBracketed = isBracketed;
    this.typeExpression = typeExpression;
    this.isNameFirst = isNameFirst;
    this.comment = comment;
  }

  forEachChild(v: NodeVisitor): boolean {
    if (v.visitNode(this.tagName)) return true;
    if (this.isNameFirst) {
      if (v.visitNode(this.name)) return true;
      if (this.typeExpression !== undefined && v.visitNode(this.typeExpression)) return true;
    } else {
      if (this.typeExpression !== undefined && v.visitNode(this.typeExpression)) return true;
      if (v.visitNode(this.name)) return true;
    }
    return this.comment !== undefined && v.visitList(this.comment);
  }

  deepClone(): Node {
    return this.copy();
  }

  copy(): JSDocParameterOrPropertyTag {
    const node = new JSDocParameterOrPropertyTag(
      this.kind,
      this.tagName.copy(),
      this.name.deepClone(),
      this.isBracketed,
      this.typeExpression === undefined ? undefined : this.typeExpression.deepClone(),
      this.isNameFirst,
      this.comment === undefined ? undefined : cloneList(this.comment),
    );
    node.flags = this.flags;
    node.pos = this.pos;
    node.end = this.end;
    return node;
  }
}

export class SourceFile extends Node {
  readonly fileName: string;
  readonly path: string;
  readonly text: string;
  readonly externalModuleIndicatorOptions: ExternalModuleIndicatorOptions;
  statements: NodeList;
  endOfFileToken: Token;

  // Set by the parser.
  diagnostics: Diagnostic[];
  /** Diagnostics for TypeScript-only syntax in JavaScript files. */
  jsDiagnostics: Diagnostic[];
  jsDocDiagnostics: Diagnostic[];
  languageVariant: LanguageVariant;
  scriptKind: ScriptKind;
  isDeclarationFile: boolean;
  containsNonASCII: boolean;
  /** Whether imports of Node built-ins use the `node:` prefix. */
  usesUriStyleNodeCoreModules: Tristate;
  /** Identifier and interned literal texts in parse order, with repeats; see `identifiers()`. */
  identifierTexts: string[];
  private identifierSet: Set<string> | undefined;
  identifierCount: number;
  nodeCount: number;
  textCount: number;
  /** Module specifiers of imports, exports, `require` calls and `import()` types, in source order. */
  imports: Node[];
  /** Names of `declare module "x"` augmentations and `declare global` blocks in modules. */
  moduleAugmentations: Node[];
  ambientModuleNames: string[];
  commentDirectives: readonly CommentDirective[];
  pragmas: Pragma[];
  referencedFiles: FileReference[];
  typeReferenceDirectives: FileReference[];
  libReferenceDirectives: FileReference[];
  checkJsDirective: CheckJsDirective | undefined;
  /** The first CommonJS `module.exports`/`exports.x` use in a JavaScript file. */
  commonJSModuleIndicator: Node | undefined;
  /** What makes this file a module: an import or export statement, `import.meta`, a JSX tag, or the file itself when forced. */
  externalModuleIndicator: Node | undefined;
  /** Nodes cloned by JSDoc reparsing, sorted by position. */
  reparsedClones: Node[];
  /** Whether JSDoc of TypeScript files is parsed on first use. */
  hasLazyJSDoc: boolean;
  private diagnosticFileCache: DiagnosticFile | undefined;
  private lineStartsCache: number[] | undefined;

  constructor(
    fileName: string,
    path: string,
    text: string,
    externalModuleIndicatorOptions: ExternalModuleIndicatorOptions,
    statements: NodeList,
    endOfFileToken: Token,
  ) {
    super(SyntaxKind.SourceFile);
    this.fileName = fileName;
    this.path = path;
    this.text = text;
    this.externalModuleIndicatorOptions = externalModuleIndicatorOptions;
    this.statements = statements;
    this.endOfFileToken = endOfFileToken;
    this.diagnostics = [];
    this.jsDiagnostics = [];
    this.jsDocDiagnostics = [];
    this.languageVariant = 0;
    this.scriptKind = ScriptKind.Unknown;
    this.isDeclarationFile = false;
    this.containsNonASCII = containsNonASCII(text);
    this.usesUriStyleNodeCoreModules = Tristate.Unknown;
    this.identifierTexts = [];
    this.identifierSet = undefined;
    this.identifierCount = 0;
    this.nodeCount = 0;
    this.textCount = 0;
    this.imports = [];
    this.moduleAugmentations = [];
    this.ambientModuleNames = [];
    this.commentDirectives = [];
    this.pragmas = [];
    this.referencedFiles = [];
    this.typeReferenceDirectives = [];
    this.libReferenceDirectives = [];
    this.checkJsDirective = undefined;
    this.commonJSModuleIndicator = undefined;
    this.externalModuleIndicator = undefined;
    this.reparsedClones = [];
    this.hasLazyJSDoc = false;
    this.diagnosticFileCache = undefined;
    this.lineStartsCache = undefined;
  }

  forEachChild(v: NodeVisitor): boolean {
    return v.visitList(this.statements) || v.visitNode(this.endOfFileToken);
  }

  deepClone(): Node {
    throw new Error('Source files are not cloned');
  }

  /** UTF-16 offsets of each line start. */
  lineStarts(): number[] {
    let starts = this.lineStartsCache;
    if (starts === undefined) {
      starts = computeLineStarts(this.text);
      this.lineStartsCache = starts;
    }
    return starts;
  }

  /** The file as diagnostics see it. */
  diagnosticFile(): DiagnosticFile {
    let file = this.diagnosticFileCache;
    if (file === undefined) {
      file = new DiagnosticFile(this.fileName, this.text);
      this.diagnosticFileCache = file;
    }
    return file;
  }

  /** The names used in the file, for generating unique names. */
  identifiers(): Set<string> {
    let set = this.identifierSet;
    if (set === undefined) {
      set = new Set<string>(this.identifierTexts);
      this.identifierSet = set;
    }
    return set;
  }

  isJS(): boolean {
    return this.scriptKind === ScriptKind.JS || this.scriptKind === ScriptKind.JSX;
  }
}

function containsNonASCII(text: string): boolean {
  for (let i = 0; i < text.length; i++) if (text.charCodeAt(i) >= 0x80) return true;
  return false;
}

// Accessors for fields shared by several node classes.

// #region accessors (generated by scripts/generate-ast.mjs)

export function getName(node: Node): Node | undefined {
  switch (node.kind) {
    case SyntaxKind.VariableDeclaration:
      if (node instanceof VariableDeclaration) return node.name;
      break;
    case SyntaxKind.Parameter:
      if (node instanceof ParameterDeclaration) return node.name;
      break;
    case SyntaxKind.BindingElement:
      if (node instanceof BindingElement) return node.name;
      break;
    case SyntaxKind.FunctionDeclaration:
      if (node instanceof FunctionDeclaration) return node.name;
      break;
    case SyntaxKind.ClassDeclaration:
      if (node instanceof ClassDeclaration) return node.name;
      break;
    case SyntaxKind.ClassExpression:
      if (node instanceof ClassExpression) return node.name;
      break;
    case SyntaxKind.InterfaceDeclaration:
      if (node instanceof InterfaceDeclaration) return node.name;
      break;
    case SyntaxKind.TypeAliasDeclaration:
    case SyntaxKind.JSTypeAliasDeclaration:
      if (node instanceof TypeAliasDeclaration) return node.name;
      break;
    case SyntaxKind.EnumMember:
      if (node instanceof EnumMember) return node.name;
      break;
    case SyntaxKind.EnumDeclaration:
      if (node instanceof EnumDeclaration) return node.name;
      break;
    case SyntaxKind.NamespaceImport:
      if (node instanceof NamespaceImport) return node.name;
      break;
    case SyntaxKind.NamespaceExportDeclaration:
      if (node instanceof NamespaceExportDeclaration) return node.name;
      break;
    case SyntaxKind.NamespaceExport:
      if (node instanceof NamespaceExport) return node.name;
      break;
    case SyntaxKind.ExportSpecifier:
      if (node instanceof ExportSpecifier) return node.name;
      break;
    case SyntaxKind.GetAccessor:
      if (node instanceof GetAccessorDeclaration) return node.name;
      break;
    case SyntaxKind.SetAccessor:
      if (node instanceof SetAccessorDeclaration) return node.name;
      break;
    case SyntaxKind.MethodSignature:
      if (node instanceof MethodSignatureDeclaration) return node.name;
      break;
    case SyntaxKind.MethodDeclaration:
      if (node instanceof MethodDeclaration) return node.name;
      break;
    case SyntaxKind.PropertySignature:
      if (node instanceof PropertySignatureDeclaration) return node.name;
      break;
    case SyntaxKind.PropertyDeclaration:
      if (node instanceof PropertyDeclaration) return node.name;
      break;
    case SyntaxKind.FunctionExpression:
      if (node instanceof FunctionExpression) return node.name;
      break;
    case SyntaxKind.PropertyAccessExpression:
      if (node instanceof PropertyAccessExpression) return node.name;
      break;
    case SyntaxKind.MetaProperty:
      if (node instanceof MetaProperty) return node.name;
      break;
    case SyntaxKind.PropertyAssignment:
      if (node instanceof PropertyAssignment) return node.name;
      break;
    case SyntaxKind.ShorthandPropertyAssignment:
      if (node instanceof ShorthandPropertyAssignment) return node.name;
      break;
    case SyntaxKind.ImportAttribute:
      if (node instanceof ImportAttribute) return node.name;
      break;
    case SyntaxKind.NamedTupleMember:
      if (node instanceof NamedTupleMember) return node.name;
      break;
    case SyntaxKind.JsxNamespacedName:
      if (node instanceof JsxNamespacedName) return node.name;
      break;
    case SyntaxKind.JsxAttribute:
      if (node instanceof JsxAttribute) return node.name;
      break;
    case SyntaxKind.JSDocCallbackTag:
      if (node instanceof JSDocCallbackTag) return node.name;
      break;
    case SyntaxKind.JSDocTypedefTag:
      if (node instanceof JSDocTypedefTag) return node.name;
      break;
    case SyntaxKind.JSDocNameReference:
      if (node instanceof JSDocNameReference) return node.name;
      break;
    case SyntaxKind.ModuleDeclaration:
      if (node instanceof ModuleDeclaration) return node.name;
      break;
    case SyntaxKind.ImportEqualsDeclaration:
      if (node instanceof ImportEqualsDeclaration) return node.name;
      break;
    case SyntaxKind.ImportClause:
      if (node instanceof ImportClause) return node.name;
      break;
    case SyntaxKind.ImportSpecifier:
      if (node instanceof ImportSpecifier) return node.name;
      break;
    case SyntaxKind.JSDocLink:
      if (node instanceof JSDocLink) return node.name;
      break;
    case SyntaxKind.JSDocLinkPlain:
      if (node instanceof JSDocLinkPlain) return node.name;
      break;
    case SyntaxKind.JSDocLinkCode:
      if (node instanceof JSDocLinkCode) return node.name;
      break;
    case SyntaxKind.TypeParameter:
      if (node instanceof TypeParameterDeclaration) return node.name;
      break;
    case SyntaxKind.JSDocParameterTag:
    case SyntaxKind.JSDocPropertyTag:
      if (node instanceof JSDocParameterOrPropertyTag) return node.name;
      break;
  }
  return undefined;
}

export function getModifiers(node: Node): ModifierList | undefined {
  switch (node.kind) {
    case SyntaxKind.VariableStatement:
      if (node instanceof VariableStatement) return node.modifiers;
      break;
    case SyntaxKind.Parameter:
      if (node instanceof ParameterDeclaration) return node.modifiers;
      break;
    case SyntaxKind.MissingDeclaration:
      if (node instanceof MissingDeclaration) return node.modifiers;
      break;
    case SyntaxKind.FunctionDeclaration:
      if (node instanceof FunctionDeclaration) return node.modifiers;
      break;
    case SyntaxKind.ClassDeclaration:
      if (node instanceof ClassDeclaration) return node.modifiers;
      break;
    case SyntaxKind.ClassExpression:
      if (node instanceof ClassExpression) return node.modifiers;
      break;
    case SyntaxKind.InterfaceDeclaration:
      if (node instanceof InterfaceDeclaration) return node.modifiers;
      break;
    case SyntaxKind.TypeAliasDeclaration:
    case SyntaxKind.JSTypeAliasDeclaration:
      if (node instanceof TypeAliasDeclaration) return node.modifiers;
      break;
    case SyntaxKind.EnumDeclaration:
      if (node instanceof EnumDeclaration) return node.modifiers;
      break;
    case SyntaxKind.ImportDeclaration:
    case SyntaxKind.JSImportDeclaration:
      if (node instanceof ImportDeclaration) return node.modifiers;
      break;
    case SyntaxKind.ExportAssignment:
      if (node instanceof ExportAssignment) return node.modifiers;
      break;
    case SyntaxKind.NamespaceExportDeclaration:
      if (node instanceof NamespaceExportDeclaration) return node.modifiers;
      break;
    case SyntaxKind.Constructor:
      if (node instanceof ConstructorDeclaration) return node.modifiers;
      break;
    case SyntaxKind.GetAccessor:
      if (node instanceof GetAccessorDeclaration) return node.modifiers;
      break;
    case SyntaxKind.SetAccessor:
      if (node instanceof SetAccessorDeclaration) return node.modifiers;
      break;
    case SyntaxKind.IndexSignature:
      if (node instanceof IndexSignatureDeclaration) return node.modifiers;
      break;
    case SyntaxKind.MethodSignature:
      if (node instanceof MethodSignatureDeclaration) return node.modifiers;
      break;
    case SyntaxKind.MethodDeclaration:
      if (node instanceof MethodDeclaration) return node.modifiers;
      break;
    case SyntaxKind.PropertySignature:
      if (node instanceof PropertySignatureDeclaration) return node.modifiers;
      break;
    case SyntaxKind.PropertyDeclaration:
      if (node instanceof PropertyDeclaration) return node.modifiers;
      break;
    case SyntaxKind.ClassStaticBlockDeclaration:
      if (node instanceof ClassStaticBlockDeclaration) return node.modifiers;
      break;
    case SyntaxKind.BinaryExpression:
      if (node instanceof BinaryExpression) return node.modifiers;
      break;
    case SyntaxKind.ArrowFunction:
      if (node instanceof ArrowFunction) return node.modifiers;
      break;
    case SyntaxKind.FunctionExpression:
      if (node instanceof FunctionExpression) return node.modifiers;
      break;
    case SyntaxKind.PropertyAssignment:
      if (node instanceof PropertyAssignment) return node.modifiers;
      break;
    case SyntaxKind.ShorthandPropertyAssignment:
      if (node instanceof ShorthandPropertyAssignment) return node.modifiers;
      break;
    case SyntaxKind.ConstructorType:
      if (node instanceof ConstructorTypeNode) return node.modifiers;
      break;
    case SyntaxKind.ModuleDeclaration:
      if (node instanceof ModuleDeclaration) return node.modifiers;
      break;
    case SyntaxKind.ImportEqualsDeclaration:
      if (node instanceof ImportEqualsDeclaration) return node.modifiers;
      break;
    case SyntaxKind.ExportDeclaration:
      if (node instanceof ExportDeclaration) return node.modifiers;
      break;
    case SyntaxKind.TypeParameter:
      if (node instanceof TypeParameterDeclaration) return node.modifiers;
      break;
  }
  return undefined;
}

export function getTypeParameters(node: Node): NodeList | undefined {
  switch (node.kind) {
    case SyntaxKind.FunctionDeclaration:
      if (node instanceof FunctionDeclaration) return node.typeParameters;
      break;
    case SyntaxKind.ClassDeclaration:
      if (node instanceof ClassDeclaration) return node.typeParameters;
      break;
    case SyntaxKind.ClassExpression:
      if (node instanceof ClassExpression) return node.typeParameters;
      break;
    case SyntaxKind.InterfaceDeclaration:
      if (node instanceof InterfaceDeclaration) return node.typeParameters;
      break;
    case SyntaxKind.TypeAliasDeclaration:
    case SyntaxKind.JSTypeAliasDeclaration:
      if (node instanceof TypeAliasDeclaration) return node.typeParameters;
      break;
    case SyntaxKind.CallSignature:
      if (node instanceof CallSignatureDeclaration) return node.typeParameters;
      break;
    case SyntaxKind.ConstructSignature:
      if (node instanceof ConstructSignatureDeclaration) return node.typeParameters;
      break;
    case SyntaxKind.Constructor:
      if (node instanceof ConstructorDeclaration) return node.typeParameters;
      break;
    case SyntaxKind.GetAccessor:
      if (node instanceof GetAccessorDeclaration) return node.typeParameters;
      break;
    case SyntaxKind.SetAccessor:
      if (node instanceof SetAccessorDeclaration) return node.typeParameters;
      break;
    case SyntaxKind.MethodSignature:
      if (node instanceof MethodSignatureDeclaration) return node.typeParameters;
      break;
    case SyntaxKind.MethodDeclaration:
      if (node instanceof MethodDeclaration) return node.typeParameters;
      break;
    case SyntaxKind.ArrowFunction:
      if (node instanceof ArrowFunction) return node.typeParameters;
      break;
    case SyntaxKind.FunctionExpression:
      if (node instanceof FunctionExpression) return node.typeParameters;
      break;
    case SyntaxKind.FunctionType:
      if (node instanceof FunctionTypeNode) return node.typeParameters;
      break;
    case SyntaxKind.ConstructorType:
      if (node instanceof ConstructorTypeNode) return node.typeParameters;
      break;
    case SyntaxKind.JSDocTemplateTag:
      if (node instanceof JSDocTemplateTag) return node.typeParameters;
      break;
    case SyntaxKind.JSDocSignature:
      if (node instanceof JSDocSignature) return node.typeParameters;
      break;
  }
  return undefined;
}

export function getParameters(node: Node): NodeList | undefined {
  switch (node.kind) {
    case SyntaxKind.FunctionDeclaration:
      if (node instanceof FunctionDeclaration) return node.parameters;
      break;
    case SyntaxKind.CallSignature:
      if (node instanceof CallSignatureDeclaration) return node.parameters;
      break;
    case SyntaxKind.ConstructSignature:
      if (node instanceof ConstructSignatureDeclaration) return node.parameters;
      break;
    case SyntaxKind.Constructor:
      if (node instanceof ConstructorDeclaration) return node.parameters;
      break;
    case SyntaxKind.GetAccessor:
      if (node instanceof GetAccessorDeclaration) return node.parameters;
      break;
    case SyntaxKind.SetAccessor:
      if (node instanceof SetAccessorDeclaration) return node.parameters;
      break;
    case SyntaxKind.IndexSignature:
      if (node instanceof IndexSignatureDeclaration) return node.parameters;
      break;
    case SyntaxKind.MethodSignature:
      if (node instanceof MethodSignatureDeclaration) return node.parameters;
      break;
    case SyntaxKind.MethodDeclaration:
      if (node instanceof MethodDeclaration) return node.parameters;
      break;
    case SyntaxKind.ArrowFunction:
      if (node instanceof ArrowFunction) return node.parameters;
      break;
    case SyntaxKind.FunctionExpression:
      if (node instanceof FunctionExpression) return node.parameters;
      break;
    case SyntaxKind.FunctionType:
      if (node instanceof FunctionTypeNode) return node.parameters;
      break;
    case SyntaxKind.ConstructorType:
      if (node instanceof ConstructorTypeNode) return node.parameters;
      break;
    case SyntaxKind.JSDocSignature:
      if (node instanceof JSDocSignature) return node.parameters;
      break;
  }
  return undefined;
}

export function getType(node: Node): Node | undefined {
  switch (node.kind) {
    case SyntaxKind.VariableDeclaration:
      if (node instanceof VariableDeclaration) return node.type;
      break;
    case SyntaxKind.Parameter:
      if (node instanceof ParameterDeclaration) return node.type;
      break;
    case SyntaxKind.FunctionDeclaration:
      if (node instanceof FunctionDeclaration) return node.type;
      break;
    case SyntaxKind.TypeAliasDeclaration:
    case SyntaxKind.JSTypeAliasDeclaration:
      if (node instanceof TypeAliasDeclaration) return node.type;
      break;
    case SyntaxKind.ExportAssignment:
      if (node instanceof ExportAssignment) return node.type;
      break;
    case SyntaxKind.CallSignature:
      if (node instanceof CallSignatureDeclaration) return node.type;
      break;
    case SyntaxKind.ConstructSignature:
      if (node instanceof ConstructSignatureDeclaration) return node.type;
      break;
    case SyntaxKind.Constructor:
      if (node instanceof ConstructorDeclaration) return node.type;
      break;
    case SyntaxKind.GetAccessor:
      if (node instanceof GetAccessorDeclaration) return node.type;
      break;
    case SyntaxKind.SetAccessor:
      if (node instanceof SetAccessorDeclaration) return node.type;
      break;
    case SyntaxKind.IndexSignature:
      if (node instanceof IndexSignatureDeclaration) return node.type;
      break;
    case SyntaxKind.MethodSignature:
      if (node instanceof MethodSignatureDeclaration) return node.type;
      break;
    case SyntaxKind.MethodDeclaration:
      if (node instanceof MethodDeclaration) return node.type;
      break;
    case SyntaxKind.PropertySignature:
      if (node instanceof PropertySignatureDeclaration) return node.type;
      break;
    case SyntaxKind.PropertyDeclaration:
      if (node instanceof PropertyDeclaration) return node.type;
      break;
    case SyntaxKind.BinaryExpression:
      if (node instanceof BinaryExpression) return node.type;
      break;
    case SyntaxKind.ArrowFunction:
      if (node instanceof ArrowFunction) return node.type;
      break;
    case SyntaxKind.FunctionExpression:
      if (node instanceof FunctionExpression) return node.type;
      break;
    case SyntaxKind.AsExpression:
      if (node instanceof AsExpression) return node.type;
      break;
    case SyntaxKind.SatisfiesExpression:
      if (node instanceof SatisfiesExpression) return node.type;
      break;
    case SyntaxKind.PropertyAssignment:
      if (node instanceof PropertyAssignment) return node.type;
      break;
    case SyntaxKind.ShorthandPropertyAssignment:
      if (node instanceof ShorthandPropertyAssignment) return node.type;
      break;
    case SyntaxKind.TypeAssertionExpression:
      if (node instanceof TypeAssertion) return node.type;
      break;
    case SyntaxKind.TypeOperator:
      if (node instanceof TypeOperatorNode) return node.type;
      break;
    case SyntaxKind.TypePredicate:
      if (node instanceof TypePredicateNode) return node.type;
      break;
    case SyntaxKind.MappedType:
      if (node instanceof MappedTypeNode) return node.type;
      break;
    case SyntaxKind.NamedTupleMember:
      if (node instanceof NamedTupleMember) return node.type;
      break;
    case SyntaxKind.OptionalType:
      if (node instanceof OptionalTypeNode) return node.type;
      break;
    case SyntaxKind.RestType:
      if (node instanceof RestTypeNode) return node.type;
      break;
    case SyntaxKind.ParenthesizedType:
      if (node instanceof ParenthesizedTypeNode) return node.type;
      break;
    case SyntaxKind.FunctionType:
      if (node instanceof FunctionTypeNode) return node.type;
      break;
    case SyntaxKind.ConstructorType:
      if (node instanceof ConstructorTypeNode) return node.type;
      break;
    case SyntaxKind.TemplateLiteralTypeSpan:
      if (node instanceof TemplateLiteralTypeSpan) return node.type;
      break;
    case SyntaxKind.JSDocTypeExpression:
      if (node instanceof JSDocTypeExpression) return node.type;
      break;
    case SyntaxKind.JSDocNonNullableType:
      if (node instanceof JSDocNonNullableType) return node.type;
      break;
    case SyntaxKind.JSDocNullableType:
      if (node instanceof JSDocNullableType) return node.type;
      break;
    case SyntaxKind.JSDocVariadicType:
      if (node instanceof JSDocVariadicType) return node.type;
      break;
    case SyntaxKind.JSDocOptionalType:
      if (node instanceof JSDocOptionalType) return node.type;
      break;
    case SyntaxKind.JSDocSignature:
      if (node instanceof JSDocSignature) return node.type;
      break;
  }
  return undefined;
}

export function getBody(node: Node): Node | undefined {
  switch (node.kind) {
    case SyntaxKind.FunctionDeclaration:
      if (node instanceof FunctionDeclaration) return node.body;
      break;
    case SyntaxKind.Constructor:
      if (node instanceof ConstructorDeclaration) return node.body;
      break;
    case SyntaxKind.GetAccessor:
      if (node instanceof GetAccessorDeclaration) return node.body;
      break;
    case SyntaxKind.SetAccessor:
      if (node instanceof SetAccessorDeclaration) return node.body;
      break;
    case SyntaxKind.MethodDeclaration:
      if (node instanceof MethodDeclaration) return node.body;
      break;
    case SyntaxKind.ClassStaticBlockDeclaration:
      if (node instanceof ClassStaticBlockDeclaration) return node.body;
      break;
    case SyntaxKind.ArrowFunction:
      if (node instanceof ArrowFunction) return node.body;
      break;
    case SyntaxKind.FunctionExpression:
      if (node instanceof FunctionExpression) return node.body;
      break;
    case SyntaxKind.ModuleDeclaration:
      if (node instanceof ModuleDeclaration) return node.body;
      break;
  }
  return undefined;
}

export function getExpression(node: Node): Node | undefined {
  switch (node.kind) {
    case SyntaxKind.ComputedPropertyName:
      if (node instanceof ComputedPropertyName) return node.expression;
      break;
    case SyntaxKind.Decorator:
      if (node instanceof Decorator) return node.expression;
      break;
    case SyntaxKind.IfStatement:
      if (node instanceof IfStatement) return node.expression;
      break;
    case SyntaxKind.DoStatement:
      if (node instanceof DoStatement) return node.expression;
      break;
    case SyntaxKind.WhileStatement:
      if (node instanceof WhileStatement) return node.expression;
      break;
    case SyntaxKind.ForInStatement:
    case SyntaxKind.ForOfStatement:
      if (node instanceof ForInOrOfStatement) return node.expression;
      break;
    case SyntaxKind.ReturnStatement:
      if (node instanceof ReturnStatement) return node.expression;
      break;
    case SyntaxKind.WithStatement:
      if (node instanceof WithStatement) return node.expression;
      break;
    case SyntaxKind.SwitchStatement:
      if (node instanceof SwitchStatement) return node.expression;
      break;
    case SyntaxKind.CaseClause:
    case SyntaxKind.DefaultClause:
      if (node instanceof CaseOrDefaultClause) return node.expression;
      break;
    case SyntaxKind.ThrowStatement:
      if (node instanceof ThrowStatement) return node.expression;
      break;
    case SyntaxKind.ExpressionStatement:
      if (node instanceof ExpressionStatement) return node.expression;
      break;
    case SyntaxKind.ExternalModuleReference:
      if (node instanceof ExternalModuleReference) return node.expression;
      break;
    case SyntaxKind.ExportAssignment:
      if (node instanceof ExportAssignment) return node.expression;
      break;
    case SyntaxKind.YieldExpression:
      if (node instanceof YieldExpression) return node.expression;
      break;
    case SyntaxKind.AsExpression:
      if (node instanceof AsExpression) return node.expression;
      break;
    case SyntaxKind.SatisfiesExpression:
      if (node instanceof SatisfiesExpression) return node.expression;
      break;
    case SyntaxKind.PropertyAccessExpression:
      if (node instanceof PropertyAccessExpression) return node.expression;
      break;
    case SyntaxKind.ElementAccessExpression:
      if (node instanceof ElementAccessExpression) return node.expression;
      break;
    case SyntaxKind.CallExpression:
      if (node instanceof CallExpression) return node.expression;
      break;
    case SyntaxKind.NewExpression:
      if (node instanceof NewExpression) return node.expression;
      break;
    case SyntaxKind.NonNullExpression:
      if (node instanceof NonNullExpression) return node.expression;
      break;
    case SyntaxKind.SpreadElement:
      if (node instanceof SpreadElement) return node.expression;
      break;
    case SyntaxKind.TemplateSpan:
      if (node instanceof TemplateSpan) return node.expression;
      break;
    case SyntaxKind.ParenthesizedExpression:
      if (node instanceof ParenthesizedExpression) return node.expression;
      break;
    case SyntaxKind.SpreadAssignment:
      if (node instanceof SpreadAssignment) return node.expression;
      break;
    case SyntaxKind.DeleteExpression:
      if (node instanceof DeleteExpression) return node.expression;
      break;
    case SyntaxKind.TypeOfExpression:
      if (node instanceof TypeOfExpression) return node.expression;
      break;
    case SyntaxKind.VoidExpression:
      if (node instanceof VoidExpression) return node.expression;
      break;
    case SyntaxKind.AwaitExpression:
      if (node instanceof AwaitExpression) return node.expression;
      break;
    case SyntaxKind.TypeAssertionExpression:
      if (node instanceof TypeAssertion) return node.expression;
      break;
    case SyntaxKind.ExpressionWithTypeArguments:
      if (node instanceof ExpressionWithTypeArguments) return node.expression;
      break;
    case SyntaxKind.JsxSpreadAttribute:
      if (node instanceof JsxSpreadAttribute) return node.expression;
      break;
    case SyntaxKind.JsxExpression:
      if (node instanceof JsxExpression) return node.expression;
      break;
    case SyntaxKind.TypeParameter:
      if (node instanceof TypeParameterDeclaration) return node.expression;
      break;
  }
  return undefined;
}

export function getInitializer(node: Node): Node | undefined {
  switch (node.kind) {
    case SyntaxKind.ForStatement:
      if (node instanceof ForStatement) return node.initializer;
      break;
    case SyntaxKind.ForInStatement:
    case SyntaxKind.ForOfStatement:
      if (node instanceof ForInOrOfStatement) return node.initializer;
      break;
    case SyntaxKind.VariableDeclaration:
      if (node instanceof VariableDeclaration) return node.initializer;
      break;
    case SyntaxKind.Parameter:
      if (node instanceof ParameterDeclaration) return node.initializer;
      break;
    case SyntaxKind.BindingElement:
      if (node instanceof BindingElement) return node.initializer;
      break;
    case SyntaxKind.EnumMember:
      if (node instanceof EnumMember) return node.initializer;
      break;
    case SyntaxKind.PropertySignature:
      if (node instanceof PropertySignatureDeclaration) return node.initializer;
      break;
    case SyntaxKind.PropertyDeclaration:
      if (node instanceof PropertyDeclaration) return node.initializer;
      break;
    case SyntaxKind.PropertyAssignment:
      if (node instanceof PropertyAssignment) return node.initializer;
      break;
    case SyntaxKind.JsxAttribute:
      if (node instanceof JsxAttribute) return node.initializer;
      break;
  }
  return undefined;
}

export function getPostfixToken(node: Node): Node | undefined {
  switch (node.kind) {
    case SyntaxKind.MethodSignature:
      if (node instanceof MethodSignatureDeclaration) return node.postfixToken;
      break;
    case SyntaxKind.MethodDeclaration:
      if (node instanceof MethodDeclaration) return node.postfixToken;
      break;
    case SyntaxKind.PropertySignature:
      if (node instanceof PropertySignatureDeclaration) return node.postfixToken;
      break;
    case SyntaxKind.PropertyDeclaration:
      if (node instanceof PropertyDeclaration) return node.postfixToken;
      break;
    case SyntaxKind.PropertyAssignment:
      if (node instanceof PropertyAssignment) return node.postfixToken;
      break;
    case SyntaxKind.ShorthandPropertyAssignment:
      if (node instanceof ShorthandPropertyAssignment) return node.postfixToken;
      break;
  }
  return undefined;
}

export function getTypeArguments(node: Node): NodeList | undefined {
  switch (node.kind) {
    case SyntaxKind.CallExpression:
      if (node instanceof CallExpression) return node.typeArguments;
      break;
    case SyntaxKind.NewExpression:
      if (node instanceof NewExpression) return node.typeArguments;
      break;
    case SyntaxKind.TaggedTemplateExpression:
      if (node instanceof TaggedTemplateExpression) return node.typeArguments;
      break;
    case SyntaxKind.TypeReference:
      if (node instanceof TypeReferenceNode) return node.typeArguments;
      break;
    case SyntaxKind.ExpressionWithTypeArguments:
      if (node instanceof ExpressionWithTypeArguments) return node.typeArguments;
      break;
    case SyntaxKind.TypeQuery:
      if (node instanceof TypeQueryNode) return node.typeArguments;
      break;
    case SyntaxKind.JsxOpeningElement:
      if (node instanceof JsxOpeningElement) return node.typeArguments;
      break;
    case SyntaxKind.JsxSelfClosingElement:
      if (node instanceof JsxSelfClosingElement) return node.typeArguments;
      break;
    case SyntaxKind.ImportType:
      if (node instanceof ImportTypeNode) return node.typeArguments;
      break;
  }
  return undefined;
}

export function getArguments(node: Node): NodeList | undefined {
  switch (node.kind) {
    case SyntaxKind.CallExpression:
      if (node instanceof CallExpression) return node.arguments;
      break;
    case SyntaxKind.NewExpression:
      if (node instanceof NewExpression) return node.arguments;
      break;
  }
  return undefined;
}

export function getMembers(node: Node): NodeList | undefined {
  switch (node.kind) {
    case SyntaxKind.ClassDeclaration:
      if (node instanceof ClassDeclaration) return node.members;
      break;
    case SyntaxKind.ClassExpression:
      if (node instanceof ClassExpression) return node.members;
      break;
    case SyntaxKind.InterfaceDeclaration:
      if (node instanceof InterfaceDeclaration) return node.members;
      break;
    case SyntaxKind.EnumDeclaration:
      if (node instanceof EnumDeclaration) return node.members;
      break;
    case SyntaxKind.MappedType:
      if (node instanceof MappedTypeNode) return node.members;
      break;
    case SyntaxKind.TypeLiteral:
      if (node instanceof TypeLiteralNode) return node.members;
      break;
  }
  return undefined;
}

export function getStatements(node: Node): NodeList | undefined {
  switch (node.kind) {
    case SyntaxKind.CaseClause:
    case SyntaxKind.DefaultClause:
      if (node instanceof CaseOrDefaultClause) return node.statements;
      break;
    case SyntaxKind.Block:
      if (node instanceof Block) return node.statements;
      break;
    case SyntaxKind.ModuleBlock:
      if (node instanceof ModuleBlock) return node.statements;
      break;
    case SyntaxKind.SourceFile:
      if (node instanceof SourceFile) return node.statements;
      break;
  }
  return undefined;
}

export function getElements(node: Node): NodeList | undefined {
  switch (node.kind) {
    case SyntaxKind.ObjectBindingPattern:
    case SyntaxKind.ArrayBindingPattern:
      if (node instanceof BindingPattern) return node.elements;
      break;
    case SyntaxKind.NamedImports:
      if (node instanceof NamedImports) return node.elements;
      break;
    case SyntaxKind.NamedExports:
      if (node instanceof NamedExports) return node.elements;
      break;
    case SyntaxKind.ArrayLiteralExpression:
      if (node instanceof ArrayLiteralExpression) return node.elements;
      break;
    case SyntaxKind.TupleType:
      if (node instanceof TupleTypeNode) return node.elements;
      break;
  }
  return undefined;
}

export function getProperties(node: Node): NodeList | undefined {
  switch (node.kind) {
    case SyntaxKind.ObjectLiteralExpression:
      if (node instanceof ObjectLiteralExpression) return node.properties;
      break;
    case SyntaxKind.JsxAttributes:
      if (node instanceof JsxAttributes) return node.properties;
      break;
  }
  return undefined;
}

export function getTypeExpression(node: Node): Node | undefined {
  switch (node.kind) {
    case SyntaxKind.JSDocTypeTag:
      if (node instanceof JSDocTypeTag) return node.typeExpression;
      break;
    case SyntaxKind.JSDocReturnTag:
      if (node instanceof JSDocReturnTag) return node.typeExpression;
      break;
    case SyntaxKind.JSDocSatisfiesTag:
      if (node instanceof JSDocSatisfiesTag) return node.typeExpression;
      break;
    case SyntaxKind.JSDocThrowsTag:
      if (node instanceof JSDocThrowsTag) return node.typeExpression;
      break;
    case SyntaxKind.JSDocThisTag:
      if (node instanceof JSDocThisTag) return node.typeExpression;
      break;
    case SyntaxKind.JSDocCallbackTag:
      if (node instanceof JSDocCallbackTag) return node.typeExpression;
      break;
    case SyntaxKind.JSDocOverloadTag:
      if (node instanceof JSDocOverloadTag) return node.typeExpression;
      break;
    case SyntaxKind.JSDocTypedefTag:
      if (node instanceof JSDocTypedefTag) return node.typeExpression;
      break;
    case SyntaxKind.JSDocParameterTag:
    case SyntaxKind.JSDocPropertyTag:
      if (node instanceof JSDocParameterOrPropertyTag) return node.typeExpression;
      break;
  }
  return undefined;
}

export function getTagName(node: Node): Node | undefined {
  switch (node.kind) {
    case SyntaxKind.JsxOpeningElement:
      if (node instanceof JsxOpeningElement) return node.tagName;
      break;
    case SyntaxKind.JsxSelfClosingElement:
      if (node instanceof JsxSelfClosingElement) return node.tagName;
      break;
    case SyntaxKind.JsxClosingElement:
      if (node instanceof JsxClosingElement) return node.tagName;
      break;
    case SyntaxKind.JSDocTypeTag:
      if (node instanceof JSDocTypeTag) return node.tagName;
      break;
    case SyntaxKind.JSDocUnknownTag:
      if (node instanceof JSDocUnknownTag) return node.tagName;
      break;
    case SyntaxKind.JSDocTemplateTag:
      if (node instanceof JSDocTemplateTag) return node.tagName;
      break;
    case SyntaxKind.JSDocReturnTag:
      if (node instanceof JSDocReturnTag) return node.tagName;
      break;
    case SyntaxKind.JSDocPublicTag:
      if (node instanceof JSDocPublicTag) return node.tagName;
      break;
    case SyntaxKind.JSDocPrivateTag:
      if (node instanceof JSDocPrivateTag) return node.tagName;
      break;
    case SyntaxKind.JSDocProtectedTag:
      if (node instanceof JSDocProtectedTag) return node.tagName;
      break;
    case SyntaxKind.JSDocReadonlyTag:
      if (node instanceof JSDocReadonlyTag) return node.tagName;
      break;
    case SyntaxKind.JSDocOverrideTag:
      if (node instanceof JSDocOverrideTag) return node.tagName;
      break;
    case SyntaxKind.JSDocDeprecatedTag:
      if (node instanceof JSDocDeprecatedTag) return node.tagName;
      break;
    case SyntaxKind.JSDocSeeTag:
      if (node instanceof JSDocSeeTag) return node.tagName;
      break;
    case SyntaxKind.JSDocImplementsTag:
      if (node instanceof JSDocImplementsTag) return node.tagName;
      break;
    case SyntaxKind.JSDocAugmentsTag:
      if (node instanceof JSDocAugmentsTag) return node.tagName;
      break;
    case SyntaxKind.JSDocSatisfiesTag:
      if (node instanceof JSDocSatisfiesTag) return node.tagName;
      break;
    case SyntaxKind.JSDocThrowsTag:
      if (node instanceof JSDocThrowsTag) return node.tagName;
      break;
    case SyntaxKind.JSDocThisTag:
      if (node instanceof JSDocThisTag) return node.tagName;
      break;
    case SyntaxKind.JSDocImportTag:
      if (node instanceof JSDocImportTag) return node.tagName;
      break;
    case SyntaxKind.JSDocCallbackTag:
      if (node instanceof JSDocCallbackTag) return node.tagName;
      break;
    case SyntaxKind.JSDocOverloadTag:
      if (node instanceof JSDocOverloadTag) return node.tagName;
      break;
    case SyntaxKind.JSDocTypedefTag:
      if (node instanceof JSDocTypedefTag) return node.tagName;
      break;
    case SyntaxKind.JSDocParameterTag:
    case SyntaxKind.JSDocPropertyTag:
      if (node instanceof JSDocParameterOrPropertyTag) return node.tagName;
      break;
  }
  return undefined;
}

export function getComment(node: Node): NodeList | undefined {
  switch (node.kind) {
    case SyntaxKind.JSDoc:
      if (node instanceof JSDoc) return node.comment;
      break;
    case SyntaxKind.JSDocTypeTag:
      if (node instanceof JSDocTypeTag) return node.comment;
      break;
    case SyntaxKind.JSDocUnknownTag:
      if (node instanceof JSDocUnknownTag) return node.comment;
      break;
    case SyntaxKind.JSDocTemplateTag:
      if (node instanceof JSDocTemplateTag) return node.comment;
      break;
    case SyntaxKind.JSDocReturnTag:
      if (node instanceof JSDocReturnTag) return node.comment;
      break;
    case SyntaxKind.JSDocPublicTag:
      if (node instanceof JSDocPublicTag) return node.comment;
      break;
    case SyntaxKind.JSDocPrivateTag:
      if (node instanceof JSDocPrivateTag) return node.comment;
      break;
    case SyntaxKind.JSDocProtectedTag:
      if (node instanceof JSDocProtectedTag) return node.comment;
      break;
    case SyntaxKind.JSDocReadonlyTag:
      if (node instanceof JSDocReadonlyTag) return node.comment;
      break;
    case SyntaxKind.JSDocOverrideTag:
      if (node instanceof JSDocOverrideTag) return node.comment;
      break;
    case SyntaxKind.JSDocDeprecatedTag:
      if (node instanceof JSDocDeprecatedTag) return node.comment;
      break;
    case SyntaxKind.JSDocSeeTag:
      if (node instanceof JSDocSeeTag) return node.comment;
      break;
    case SyntaxKind.JSDocImplementsTag:
      if (node instanceof JSDocImplementsTag) return node.comment;
      break;
    case SyntaxKind.JSDocAugmentsTag:
      if (node instanceof JSDocAugmentsTag) return node.comment;
      break;
    case SyntaxKind.JSDocSatisfiesTag:
      if (node instanceof JSDocSatisfiesTag) return node.comment;
      break;
    case SyntaxKind.JSDocThrowsTag:
      if (node instanceof JSDocThrowsTag) return node.comment;
      break;
    case SyntaxKind.JSDocThisTag:
      if (node instanceof JSDocThisTag) return node.comment;
      break;
    case SyntaxKind.JSDocImportTag:
      if (node instanceof JSDocImportTag) return node.comment;
      break;
    case SyntaxKind.JSDocCallbackTag:
      if (node instanceof JSDocCallbackTag) return node.comment;
      break;
    case SyntaxKind.JSDocOverloadTag:
      if (node instanceof JSDocOverloadTag) return node.comment;
      break;
    case SyntaxKind.JSDocTypedefTag:
      if (node instanceof JSDocTypedefTag) return node.comment;
      break;
    case SyntaxKind.JSDocParameterTag:
    case SyntaxKind.JSDocPropertyTag:
      if (node instanceof JSDocParameterOrPropertyTag) return node.comment;
      break;
  }
  return undefined;
}

export function getIsTypeOnly(node: Node): boolean {
  switch (node.kind) {
    case SyntaxKind.ExportSpecifier:
      if (node instanceof ExportSpecifier) return node.isTypeOnly;
      break;
    case SyntaxKind.ImportEqualsDeclaration:
      if (node instanceof ImportEqualsDeclaration) return node.isTypeOnly;
      break;
    case SyntaxKind.ExportDeclaration:
      if (node instanceof ExportDeclaration) return node.isTypeOnly;
      break;
    case SyntaxKind.ImportSpecifier:
      if (node instanceof ImportSpecifier) return node.isTypeOnly;
      break;
  }
  return false;
}

export function getImportClause(node: Node): Node | undefined {
  switch (node.kind) {
    case SyntaxKind.ImportDeclaration:
    case SyntaxKind.JSImportDeclaration:
      if (node instanceof ImportDeclaration) return node.importClause;
      break;
    case SyntaxKind.JSDocImportTag:
      if (node instanceof JSDocImportTag) return node.importClause;
      break;
  }
  return undefined;
}

export function getModuleSpecifier(node: Node): Node | undefined {
  switch (node.kind) {
    case SyntaxKind.ImportDeclaration:
    case SyntaxKind.JSImportDeclaration:
      if (node instanceof ImportDeclaration) return node.moduleSpecifier;
      break;
    case SyntaxKind.JSDocImportTag:
      if (node instanceof JSDocImportTag) return node.moduleSpecifier;
      break;
    case SyntaxKind.ExportDeclaration:
      if (node instanceof ExportDeclaration) return node.moduleSpecifier;
      break;
  }
  return undefined;
}

export function getDotDotDotToken(node: Node): Node | undefined {
  switch (node.kind) {
    case SyntaxKind.Parameter:
      if (node instanceof ParameterDeclaration) return node.dotDotDotToken;
      break;
    case SyntaxKind.BindingElement:
      if (node instanceof BindingElement) return node.dotDotDotToken;
      break;
    case SyntaxKind.NamedTupleMember:
      if (node instanceof NamedTupleMember) return node.dotDotDotToken;
      break;
    case SyntaxKind.JsxExpression:
      if (node instanceof JsxExpression) return node.dotDotDotToken;
      break;
  }
  return undefined;
}

export function getAsteriskToken(node: Node): Node | undefined {
  switch (node.kind) {
    case SyntaxKind.FunctionDeclaration:
      if (node instanceof FunctionDeclaration) return node.asteriskToken;
      break;
    case SyntaxKind.MethodDeclaration:
      if (node instanceof MethodDeclaration) return node.asteriskToken;
      break;
    case SyntaxKind.YieldExpression:
      if (node instanceof YieldExpression) return node.asteriskToken;
      break;
    case SyntaxKind.FunctionExpression:
      if (node instanceof FunctionExpression) return node.asteriskToken;
      break;
  }
  return undefined;
}

export function getQuestionToken(node: Node): Node | undefined {
  switch (node.kind) {
    case SyntaxKind.Parameter:
      if (node instanceof ParameterDeclaration) return node.questionToken;
      break;
    case SyntaxKind.ConditionalExpression:
      if (node instanceof ConditionalExpression) return node.questionToken;
      break;
    case SyntaxKind.MappedType:
      if (node instanceof MappedTypeNode) return node.questionToken;
      break;
    case SyntaxKind.NamedTupleMember:
      if (node instanceof NamedTupleMember) return node.questionToken;
      break;
  }
  return undefined;
}

export function getText(node: Node): string {
  switch (node.kind) {
    case SyntaxKind.Identifier:
      if (node instanceof Identifier) return node.text;
      break;
    case SyntaxKind.PrivateIdentifier:
      if (node instanceof PrivateIdentifier) return node.text;
      break;
    case SyntaxKind.StringLiteral:
      if (node instanceof StringLiteral) return node.text;
      break;
    case SyntaxKind.NumericLiteral:
      if (node instanceof NumericLiteral) return node.text;
      break;
    case SyntaxKind.BigIntLiteral:
      if (node instanceof BigIntLiteral) return node.text;
      break;
    case SyntaxKind.RegularExpressionLiteral:
      if (node instanceof RegularExpressionLiteral) return node.text;
      break;
    case SyntaxKind.NoSubstitutionTemplateLiteral:
      if (node instanceof NoSubstitutionTemplateLiteral) return node.text;
      break;
    case SyntaxKind.TemplateHead:
      if (node instanceof TemplateHead) return node.text;
      break;
    case SyntaxKind.TemplateMiddle:
      if (node instanceof TemplateMiddle) return node.text;
      break;
    case SyntaxKind.TemplateTail:
      if (node instanceof TemplateTail) return node.text;
      break;
    case SyntaxKind.JsxText:
      if (node instanceof JsxText) return node.text;
      break;
    case SyntaxKind.JSDocText:
      if (node instanceof JSDocText) return node.text;
      break;
    case SyntaxKind.JSDocLink:
      if (node instanceof JSDocLink) return node.text;
      break;
    case SyntaxKind.JSDocLinkPlain:
      if (node instanceof JSDocLinkPlain) return node.text;
      break;
    case SyntaxKind.JSDocLinkCode:
      if (node instanceof JSDocLinkCode) return node.text;
      break;
  }
  return '';
}

export function getHeritageClauses(node: Node): NodeList | undefined {
  switch (node.kind) {
    case SyntaxKind.ClassDeclaration:
      if (node instanceof ClassDeclaration) return node.heritageClauses;
      break;
    case SyntaxKind.ClassExpression:
      if (node instanceof ClassExpression) return node.heritageClauses;
      break;
    case SyntaxKind.InterfaceDeclaration:
      if (node instanceof InterfaceDeclaration) return node.heritageClauses;
      break;
  }
  return undefined;
}

export function getLabel(node: Node): Node | undefined {
  switch (node.kind) {
    case SyntaxKind.BreakStatement:
      if (node instanceof BreakStatement) return node.label;
      break;
    case SyntaxKind.ContinueStatement:
      if (node instanceof ContinueStatement) return node.label;
      break;
    case SyntaxKind.LabeledStatement:
      if (node instanceof LabeledStatement) return node.label;
      break;
  }
  return undefined;
}

export function getStatement(node: Node): Node | undefined {
  switch (node.kind) {
    case SyntaxKind.DoStatement:
      if (node instanceof DoStatement) return node.statement;
      break;
    case SyntaxKind.WhileStatement:
      if (node instanceof WhileStatement) return node.statement;
      break;
    case SyntaxKind.ForStatement:
      if (node instanceof ForStatement) return node.statement;
      break;
    case SyntaxKind.ForInStatement:
    case SyntaxKind.ForOfStatement:
      if (node instanceof ForInOrOfStatement) return node.statement;
      break;
    case SyntaxKind.WithStatement:
      if (node instanceof WithStatement) return node.statement;
      break;
    case SyntaxKind.LabeledStatement:
      if (node instanceof LabeledStatement) return node.statement;
      break;
  }
  return undefined;
}

export function getLiteral(node: Node): Node | undefined {
  switch (node.kind) {
    case SyntaxKind.TemplateSpan:
      if (node instanceof TemplateSpan) return node.literal;
      break;
    case SyntaxKind.LiteralType:
      if (node instanceof LiteralTypeNode) return node.literal;
      break;
    case SyntaxKind.TemplateLiteralTypeSpan:
      if (node instanceof TemplateLiteralTypeSpan) return node.literal;
      break;
  }
  return undefined;
}

export function getPropertyName(node: Node): Node | undefined {
  switch (node.kind) {
    case SyntaxKind.BindingElement:
      if (node instanceof BindingElement) return node.propertyName;
      break;
    case SyntaxKind.ExportSpecifier:
      if (node instanceof ExportSpecifier) return node.propertyName;
      break;
    case SyntaxKind.ImportSpecifier:
      if (node instanceof ImportSpecifier) return node.propertyName;
      break;
  }
  return undefined;
}

// #endregion accessors
